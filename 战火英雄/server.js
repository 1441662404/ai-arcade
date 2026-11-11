/**
 * 战火英雄 · 联机伺服器
 * ------------------------------------------------------------------
 * 零依赖：静态文件 + 自制 WebSocket（RFC6455）+ 服务端权威 60Hz 模拟。
 * 启动：node server.js  （PORT 由网关注入）
 *
 * 权威模型：
 *   客户端只上报「按键位掩码 + 瞄准角」，服务端推演一切（位置、命中、胜负）。
 *   客户端本地用同一份 sim.js 做预测，收到快照后回滚校正 → 手感跟本地游戏一致。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DT, SNAP_INTERVAL, MAX_PLAYERS, CLASS_LIST, MODE_LIST, CLASSES } from './shared/constants.js';
import { CAMPAIGN_LIST, getLevel } from './shared/campaign.js';
import { World, buildLoadout, currentWeapon } from './shared/sim.js';
import { botThink, initBot, botName, resetBotNames } from './shared/ai.js';
import { MAP_LIST } from './shared/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

/* ------------------------------------------------------------------ */
/*  静态服务                                                            */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safe);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Sock {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    socket.setNoDelay(true);
  }
  _close() {
    if (!this.alive) return;
    this.alive = false;
    this.onclose && this.onclose();
  }
  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const hi = b.readUInt32BE(off);
        const lo = b.readUInt32BE(off + 4);
        len = hi * 4294967296 + lo;
        off += 8;
      }
      const maskKey = masked ? b.slice(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = Buffer.from(b.slice(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      this.buf = b.slice(off + len);
      if (opcode === 0x8) { this.socket.end(); this._close(); return; }
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.onmessage) {
          try { this.onmessage(payload.toString('utf8')); } catch (e) { /* ignore */ }
        }
        if (!fin) { /* 单帧消息，忽略续传 */ }
      }
    }
  }
  _frame(opcode, payload) {
    if (!this.alive || this.socket.destroyed || !this.socket.writable) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { /* ignore */ }
  }
  send(obj) { this._frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  close() { try { this.socket.end(); } catch (e) { /* ignore */ } this._close(); }
}

/* ------------------------------------------------------------------ */
/*  房间管理                                                            */
/* ------------------------------------------------------------------ */
const rooms = new Map();

const TEAM_OF = { blue: 'blue', red: 'red' };

function newRoom({ name, mode, mapId, max, killLimit, difficulty, fillBots, botCount, levelId }) {
  const id = crypto.randomBytes(3).toString('hex').toUpperCase();
  const isCamp = mode === 'campaign';
  const world = new World({
    mode: isCamp ? 'campaign' : (MODE_LIST.includes(mode) ? mode : 'tdm'),
    mapId: MAP_LIST.includes(mapId) ? mapId : 'labs',
    scoreLimit: killLimit || null,
    levelId: isCamp ? (levelId || CAMPAIGN_LIST[0]) : null,
  });
  const room = {
    id,
    name: String(name || '战火前线').slice(0, 20),
    world,
    mode: world.mode,
    mapId: world.mapId,
    levelId: world.levelId,
    max: Math.min(MAX_PLAYERS, Math.max(2, Number(max) || 10)),
    difficulty: Math.max(1, Math.min(5, Number(difficulty) || 3)),
    fillBots: fillBots !== false,
    botTarget: Math.max(0, Math.min(MAX_PLAYERS, Number(botCount) || 0)),
    clients: new Set(),
    createdAt: Date.now(),
    state: 'playing',
  };
  rooms.set(id, room);
  return room;
}

function roomBrief(r) {
  return {
    id: r.id, name: r.name, mode: r.mode, map: r.mapId,
    levelId: r.levelId || null,
    count: r.clients.size, bots: countBots(r), max: r.max,
    state: r.state,
    score: { ...r.world.scores },
  };
}

function roomsList() {
  return [...rooms.values()].map(roomBrief);
}

function countBots(room) {
  let n = 0;
  for (const p of room.world.players.values()) if (p.isBot) n++;
  return n;
}

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  const buf = Buffer.from(s, 'utf8');
  for (const c of room.clients) {
    if (c !== except) c.ws._frame(0x1, buf);
  }
}

function leaveRoom(client, silent) {
  const room = client.room;
  if (!room) return;
  room.world.removePlayer(client.id);
  room.clients.delete(client);
  client.room = null;

  if (room.clients.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.hostId === client.id) {
      room.hostId = [...room.clients][0].id;
    }
    broadcast(room, { t: 'left', id: client.id });
    broadcast(room, { t: 'room', room: roomSnapshot(room) });
  }
  if (!silent && client.ws.alive) client.ws.send({ t: 'left' });
}

function roomSnapshot(room) {
  const camp = room.world.camp ? {
    levelId: room.world.levelId,
    name: room.world.level.name,
    objective: room.world.level.objective,
    brief: room.world.level.brief,
    target: room.world.level.target,
    waves: room.world.level.waves.length,
    maxDeaths: room.world.level.maxDeaths,
    reward: room.world.level.reward,
  } : null;
  return {
    id: room.id, name: room.name, mode: room.mode, map: room.mapId,
    levelId: room.levelId || null,
    camp,
    host: room.hostId, max: room.max, difficulty: room.difficulty,
    fillBots: room.fillBots, botTarget: room.botTarget,
    state: room.state,
    players: room.world.list.map(p => ({
      id: p.id, name: p.name, cls: p.cls, team: p.team,
      isBot: !!p.isBot, kills: p.kills, deaths: p.deaths, score: p.score,
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  补充 BOT / 平衡队伍                                                 */
/* ------------------------------------------------------------------ */

/** 给房间补到指定人数（人类 + BOT），并保持两队在 TDM/DOM 下人数均衡 */
function topUpBots(room) {
  const w = room.world;
  const humans = w.list.filter(p => !p.isBot);

  // 战役模式：只给蓝队补 AI 队友（红方敌人由波次系统生成）
  if (room.mode === 'campaign') {
    const desiredAllies = room.fillBots ? Math.max(0, Math.min(4, Number(room.botTarget) || 4)) : 0;
    const allies = w.list.filter(p => p.isBot && p.team === 'blue');
    let need = desiredAllies - allies.length;
    while (need > 0) {
      const id = 'a_' + crypto.randomBytes(3).toString('hex');
      const cls = ['assault', 'medic', 'sniper', 'tank', 'ninja', 'assassin'][
        Math.floor(Math.random() * 6)
      ];
      const p = w.addPlayer({ id, name: botName(), cls, team: 'blue', isBot: true });
      initBot(p, Math.max(2, room.difficulty));
      need--;
    }
    // 多余的队友移除
    while (need < 0) {
      const extra = w.list.filter(p => p.isBot && p.team === 'blue').pop();
      if (extra) w.removePlayer(extra.id);
      need++;
    }
    return;
  }

  const humanCount = humans.length;

  let desiredBots = room.fillBots ? Math.max(0, room.botTarget) : 0;
  const totalCap = room.max;
  if (humanCount + desiredBots > totalCap) desiredBots = Math.max(0, totalCap - humanCount);

  const bots = w.list.filter(p => p.isBot);
  let diff = desiredBots - bots.length;

  // 移除多余的
  while (diff < 0) {
    const victim = bots.pop();
    if (victim) w.removePlayer(victim.id);
    diff++;
  }

  // 补齐
  while (diff > 0) {
    const team = pickTeam(w, room.mode);
    const cls = CLASS_LIST[Math.floor(Math.random() * CLASS_LIST.length)];
    const id = 'b_' + crypto.randomBytes(3).toString('hex');
    const p = w.addPlayer({
      id, name: botName(), cls, team, isBot: true,
    });
    initBot(p, room.difficulty);
    diff--;
  }

  // 重新均衡人类队伍（战役模式豁免：真人固定在蓝队）
  if (room.mode !== 'ffa' && room.mode !== 'campaign') {
    const counts = { blue: 0, red: 0 };
    for (const p of w.list) counts[p.team]++;
    // 只调整人类
    for (const p of humans) {
      const other = p.team === 'blue' ? 'red' : 'blue';
      if (counts[p.team] - counts[other] >= 2) {
        counts[p.team]--; counts[other]++;
        p.team = other;
        w.respawn(p, true);
      }
    }
  }
}

function pickTeam(w, mode) {
  // 战役：真人固定加入蓝队（玩家方），敌人全部由波次系统生成
  if (mode === 'campaign') return 'blue';
  if (mode === 'ffa') return Math.random() < 0.5 ? 'blue' : 'red';
  let blue = 0, red = 0;
  for (const p of w.list) (p.team === 'blue' ? blue++ : red++);
  return blue <= red ? 'blue' : 'red';
}

/* ------------------------------------------------------------------ */
/*  消息处理                                                            */
/* ------------------------------------------------------------------ */
function handle(client, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;

  switch (m.t) {
    case 'ping':
      client.ws.send({ t: 'pong', ts: m.ts, st: Date.now() });
      return;

    case 'hello': {
      client.name = String(m.name || '士兵').slice(0, 12);
      client.cls = CLASS_LIST.includes(m.cls) ? m.cls : 'assault';
      client.prefs = m.prefs || null;
      if (!client.helloed) {
        client.helloed = true;
        client.ws.send({ t: 'welcome', id: client.id, st: Date.now() });
      }
      client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'list':
      client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;

    case 'create': {
      leaveRoom(client, true);
      const room = newRoom({
        name: m.name, mode: m.mode, mapId: m.map,
        max: m.max, killLimit: m.killLimit,
        difficulty: m.difficulty,
        fillBots: m.fillBots, botCount: m.botCount,
        levelId: m.level,
      });
      const team = pickTeam(room.world, room.mode);
      joinWorld(room, client, team);
      room.hostId = client.id;
      topUpBots(room);
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      broadcast(room, { t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'join': {
      const room = rooms.get(String(m.id || '').toUpperCase());
      if (!room) { client.ws.send({ t: 'error', msg: '房间不存在' }); return; }
      if (room.clients.size >= room.max) { client.ws.send({ t: 'error', msg: '房间已满' }); return; }
      leaveRoom(client, true);
      const team = pickTeam(room.world, room.mode);
      joinWorld(room, client, team);
      if (!room.hostId) room.hostId = client.id;
      topUpBots(room);
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      broadcast(room, { t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'leave':
      leaveRoom(client, false);
      if (client.ws.alive) client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;

    case 'loadout': {
      const room = client.room;
      if (!room) return;
      const p = room.world.players.get(client.id);
      if (!p) return;
      if (CLASS_LIST.includes(m.cls) && m.cls !== p.cls) {
        p.cls = m.cls;
        p.maxHp = CLASSES[m.cls].hp;
        room.world.respawn(p, false);
      }
      p.wp = buildLoadout(p.cls, m.weapons);
      room.world.events.push({ t: 'loadout', id: p.id, cls: p.cls });
      return;
    }

    case 'ready': {
      client.ready = !!m.v;
      const room = client.room;
      if (room) broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }

    case 'in': {
      // 高频输入包：只有按键 + 瞄准角 + 序列号
      const room = client.room;
      if (!room) return;
      const p = room.world.players.get(client.id);
      if (!p) return;
      p.keys = m.k | 0;
      p.aimAngle = Number(m.a) || 0;
      p.seq = m.s | 0;
      client.lastInputAt = Date.now();
      return;
    }

    case 'chat': {
      const room = client.room;
      if (!room) return;
      broadcast(room, {
        t: 'chat', id: client.id, name: client.name,
        msg: String(m.msg || '').slice(0, 60),
      });
      return;
    }

    case 'setDiff': {
      const room = client.room;
      if (!room || room.hostId !== client.id) return;
      room.difficulty = Math.max(1, Math.min(5, Number(m.v) || 3));
      for (const p of room.world.players.values()) if (p.isBot) setDiff(p, room.difficulty);
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }

    case 'setBots': {
      const room = client.room;
      if (!room || room.hostId !== client.id) return;
      room.fillBots = !!m.fill;
      room.botTarget = Math.max(0, Math.min(room.max, Number(m.n) || 0));
      topUpBots(room);
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }

    case 'restart': {
      const room = client.room;
      if (!room || room.hostId !== client.id) return;
      // 战役：允许房主切换关卡（或重开当前关）
      if (room.mode === 'campaign') {
        const lv = CAMPAIGN_LIST.includes(m.level) ? m.level : room.levelId;
        if (lv && lv !== room.levelId) {
          rebuildWorld(room, { levelId: lv });
        }
      }
      room.world.restart();
      room.state = 'playing';
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      // 关键：必须显式广播 restart，客户端靠它切换到战斗画面
      broadcast(room, {
        t: 'restart', map: room.mapId, mode: room.mode, levelId: room.levelId || null,
      });
      return;
    }

    case 'switchMap': {
      const room = client.room;
      if (!room || room.hostId !== client.id) return;
      // 战役模式：地图由关卡决定，不接受任意切图；改为切换关卡
      if (room.mode === 'campaign') {
        const lv = CAMPAIGN_LIST.includes(m.level) ? m.level : room.levelId;
        if (lv) {
          rebuildWorld(room, { levelId: lv });
          broadcast(room, { t: 'room', room: roomSnapshot(room) });
          broadcast(room, { t: 'restart', map: room.mapId, mode: room.mode, levelId: room.levelId });
        }
        return;
      }
      const mapId = MAP_LIST.includes(m.map) ? m.map : 'labs';
      rebuildWorld(room, { mapId });
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }

    case 'setLevel': {
      const room = client.room;
      if (!room || room.hostId !== client.id || room.mode !== 'campaign') return;
      const lv = CAMPAIGN_LIST.includes(m.level) ? m.level : room.levelId;
      if (!lv) return;
      rebuildWorld(room, { levelId: lv });
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }

    case 'setMode': {
      const room = client.room;
      if (!room || room.hostId !== client.id) return;
      const valid = [...MODE_LIST, 'campaign'];
      if (!valid.includes(m.mode)) return;
      if (m.mode === room.mode) return;

      room.mode = m.mode;
      // 战役：固定从所选关卡的地图开始；其他模式沿用当前地图
      const levelId = m.mode === 'campaign'
        ? (CAMPAIGN_LIST.includes(m.level) ? m.level : (room.levelId || CAMPAIGN_LIST[0]))
        : null;
      const mapId = m.mode === 'campaign' ? null : room.mapId;

      const old = room.world;
      const world = new World({
        mode: m.mode,
        mapId: mapId || undefined,
        scoreLimit: null,
        levelId,
      });
      room.world = world;
      room.mapId = world.mapId;
      room.levelId = world.levelId;
      world.botThink = botThink;

      // 迁移真人玩家：战役一律归蓝队，其他模式保持原队伍
      for (const p of old.players.values()) {
        if (p.isBot) continue;
        const np = world.addPlayer({
          id: p.id, name: p.name, cls: p.cls,
          team: m.mode === 'campaign' ? 'blue' : p.team,
          isBot: false,
        });
        np.kills = p.kills; np.deaths = p.deaths; np.score = p.score;
      }
      // 补 AI：战役给蓝队补队友，其他模式均衡补位
      topUpBots(room);
      if (m.mode === 'campaign') room.botTarget = 4;

      room.state = 'lobby';
      // 只同步房间信息，不广播 restart —— 切模式仍在房间页，等房主点「开始战斗」
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      return;
    }
  }
}

function setDiff(p, d) { initBot(p, d); p.ai.diff = d; }

/**
 * 重建房间世界并迁移玩家（换图 / 换关卡共用）。
 * 玩家保留 id、兵种、队伍与战绩；BOT 重新初始化 AI。
 */
function rebuildWorld(room, { mapId = null, levelId = null } = {}) {
  const old = room.world;
  const world = new World({
    mode: room.mode,
    mapId: mapId || room.mapId,
    scoreLimit: old.scoreLimit,
    levelId: levelId || room.levelId,
  });
  room.world = world;
  room.mapId = world.mapId;
  room.levelId = world.levelId;
  world.botThink = botThink;

  for (const p of old.players.values()) {
    // 战役：只迁移真人；敌人由波次系统重新生成
    if (room.mode === 'campaign' && p.isBot && p.team === 'red') continue;
    const np = world.addPlayer({
      id: p.id, name: p.name, cls: p.cls,
      team: room.mode === 'campaign' ? 'blue' : p.team,
      isBot: p.isBot,
    });
    np.kills = p.kills; np.deaths = p.deaths; np.score = p.score;
    if (p.isBot) initBot(np, room.difficulty);
  }
  return world;
}

/**
 * 战役：从世界队列中取出待生成数量，真正添加敌人。
 * 敌人默认红队，兵种与难度随关卡递增。
 *
 * 关键：敌人必须生成在「玩家附近的可站地面」，
 * 否则地图太大（3400px），玩家永远走不到，关卡就没有节奏。
 */
function spawnCampaignEnemies(room) {
  const w = room.world;
  const L = getLevel(w.levelId);
  let guard = 0;
  // 场上红方上限：留足余量，保证「击杀目标」能达成（否则卡在 7/10）
  const maxRed = 12;

  // 找一个玩家（优先真人）作为「战斗中心」
  let anchor = null;
  for (const p of w.players.values()) {
    if (p.team === 'blue' && p.alive && !p.isBot) { anchor = p; break; }
  }
  if (!anchor) {
    for (const p of w.players.values()) {
      if (p.team === 'blue' && p.alive) { anchor = p; break; }
    }
  }
  if (!anchor) return;   // 没有玩家就不生成

  const spawnSpot = (side) => {
    // 在玩家左右两侧 380~680px 处找一个能站的地面点
    const ax = anchor.x + anchor.w / 2;
    const minD = 380, maxD = 680;
    const mapW = w.map.width;
    // 从玩家脚底稍微偏上的位置开始向下找（避免把脚下地面判成"在上方"）
    const footY = anchor.y + anchor.bh - 30;
    for (let tries = 0; tries < 30; tries++) {
      const dist = minD + Math.random() * (maxD - minD);
      const x = ax + side * dist;
      if (x < 60 || x > mapW - 60) continue;
      const ground = findGroundBelow(w, x, footY);
      if (ground) return { x, y: ground };
    }
    // 兜底：玩家同一水平面上偏移放置（不再用地图出生点，避免跑到地图另一头）
    const dist = 420 + Math.random() * 160;
    return { x: Math.max(80, Math.min(mapW - 80, ax + side * dist)), y: footY + anchor.bh + 46 };
  };

  while (w.pendingSpawns.length && guard++ < 20) {
    const n = w.pendingSpawns.shift();
    for (let i = 0; i < n; i++) {
      let reds = 0;
      for (const p of w.players.values()) if (p.team === 'red' && p.alive) reds++;
      if (reds >= maxRed) break;

      const id = 'e_' + crypto.randomBytes(3).toString('hex');
      const cls = pickEnemyClass(L);
      const p = w.addPlayer({ id, name: botName(), cls, team: 'red', isBot: true });

      // 左右交替生成，形成两面包夹的压迫感
      const spot = spawnSpot(i % 2 === 0 ? 1 : -1);
      p.x = spot.x - p.w / 2;
      p.y = spot.y - p.bh;

      const diff = Math.max(1, Math.min(5, L.difficulty));
      initBot(p, diff);
      if (diff >= 5 && Math.random() < 0.25) {
        p.name = '★ ' + p.name;
        p.maxHp = Math.round(p.maxHp * 1.25);
        p.hp = p.maxHp;
      }
    }
  }
}

/** 从 (x, fromY) 往下找最近的可站立表面，返回站立 y（脚底高度） */
function findGroundBelow(w, x, fromY) {
  let best = null;
  for (const s of w.solids) {
    if (x < s.x + 8 || x > s.x + s.w - 8) continue;
    if (s.y < fromY) continue;            // 只看下方
    if (s.y > fromY + 900) continue;      // 太深就不找
    if (!best || s.y < best) best = s.y;
  }
  for (const s of w.plats) {
    if (x < s.x + 8 || x > s.x + s.w - 8) continue;
    if (s.y < fromY || s.y > fromY + 900) continue;
    if (!best || s.y < best) best = s.y;
  }
  return best;
}

/** 战役敌人的兵种抽取：随关卡推进出现更强兵种 */
function pickEnemyClass(L) {
  const d = L.difficulty;
  const pool = ['assault', 'assault', 'medic'];
  if (d >= 2) pool.push('tank');
  if (d >= 3) pool.push('sniper', 'ninja');
  if (d >= 4) pool.push('assassin', 'tank');
  if (d >= 5) pool.push('assassin', 'ninja', 'sniper');
  return pool[Math.floor(Math.random() * pool.length)];
}


function joinWorld(room, client, team) {
  const w = room.world;
  const p = w.addPlayer({
    id: client.id,
    name: client.name,
    cls: client.cls,
    team,
    isBot: false,
  });
  if (client.prefs) p.wp = buildLoadout(p.cls, client.prefs);
  client.room = room;
  client.ready = false;
  room.clients.add(client);
  w.events.push({ t: 'join', id: p.id, name: p.name });
  return p;
}

/* ------------------------------------------------------------------ */
/*  连接                                                                */
/* ------------------------------------------------------------------ */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new Sock(socket);
  const client = {
    id: 'h_' + crypto.randomBytes(4).toString('hex'),
    ws,
    name: '士兵',
    cls: 'assault',
    prefs: null,
    room: null,
    ready: false,
    helloed: false,
    lastInputAt: 0,
  };
  ws.onmessage = (raw) => handle(client, raw);
  ws.onclose = () => leaveRoom(client, true);
  ws.send({ t: 'welcome', id: client.id, st: Date.now() });
});

/* ------------------------------------------------------------------ */
/*  权威主循环（60Hz）+ 快照（20Hz）                                    */
/* ------------------------------------------------------------------ */
const SNAP_EVERY = Math.max(1, Math.round(1 / (SNAP_INTERVAL * (1 / DT))));
let tickCount = 0;
let lastTime = process.hrtime.bigint();
let acc = 0;

function loop() {
  const now = process.hrtime.bigint();
  let elapsed = Number(now - lastTime) / 1e9;
  lastTime = now;
  if (elapsed > 0.25) elapsed = 0.25;   // 卡顿保护
  acc += elapsed;

  let steps = 0;
  while (acc >= DT && steps < 5) {
    tickCount++;
    for (const room of rooms.values()) {
      const w = room.world;
      w.botThink = botThink;
      w.clearEvents();
      w.step();
      // 战役：消费敌人生成队列（World 只负责排队，生成权在服务端）
      if (w.pendingSpawns && w.pendingSpawns.length) spawnCampaignEnemies(room);
      if (w.needsRestart()) {
        w.restart();
      }
    }
    acc -= DT;
    steps++;
  }
  if (steps >= 5) acc = 0;

  // 快照下发
  if (tickCount % SNAP_EVERY === 0) {
    for (const room of rooms.values()) {
      const w = room.world;
      const snap = w.snapshot();
      const base = JSON.stringify(snap);
      for (const c of room.clients) {
        // 每个客户端单独拼一份（带 self 详情）
        const self = w.selfState(c.id);
        const payload = base.slice(0, -1) + (self ? ',"self":' + JSON.stringify(self) : '') + '}';
        c.ws._frame(0x1, Buffer.from(payload, 'utf8'));
      }
    }
  }

  // BOT 看门狗：人类加入后重新平衡人数
  if (tickCount % 60 === 0) {
    for (const room of rooms.values()) {
      if (room.mode === 'campaign') {
        // 战役：只关心蓝队队友是否足够（红方敌人由波次生成）
        if (room.fillBots) topUpBots(room);
      } else if (countBots(room) === 0 && room.fillBots && room.botTarget > 0) {
        topUpBots(room);
      }
    }
  }
}

setInterval(loop, 1000 / 120);   // 主循环调度 120Hz，内部按 60Hz 固定步长推进

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  战火英雄 · 联机横版射击                     │');
  console.log(`  │  本机： http://localhost:${PORT}                │`);
  console.log('  │  权威 60Hz · 最多 12 人 · 支持 5 人组队       │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
});

process.on('SIGTERM', () => process.exit(0));
