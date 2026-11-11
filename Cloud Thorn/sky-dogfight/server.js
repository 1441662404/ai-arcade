/* =============================================================================
 * server.js —— 权威服务端
 *   Node.js + Express + Socket.IO
 *   · 30Hz 权威模拟（飞行物理 / 武器 / 锁定 / 制导 / 计分）
 *   · 20Hz 状态广播 + 事件队列
 *   · 客户端只上传「控制意图」，所有判定在服务端完成
 *   · 最多 16 人、自动平衡阵营、断线处理、RTT 测量
 * 启动：npm install && npm start   （默认 http://localhost:3000）
 * ========================================================================== */
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const FP = require('./flight-physics.js');
const NP = require('./naval-physics.js');
NP.setTerrainH(FP.terrainHeight);
const { updateBot } = require('./bots.js');

const CONFIG = FP.CONFIG;
const V = FP.V;
const Q = FP.Q;
const AIRPORTS = FP.AIRPORTS;
const clamp = FP.clamp;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;
const SIM_DT = 1 / CONFIG.net.simHz;
const SNAP_DT = 1 / CONFIG.net.snapshotHz;

// =============================================================================
// === Express：静态资源 ========================================================
// =============================================================================
const app = express();
// 共享物理模块（UMD → window.FlightPhysics）。
// 必须注册在 express.static **之前**：public/ 里如果残留一份旧的 flight-physics.js，
// 静态中间件会先命中它，客户端就会拿旧物理（步长/参数）去预测新服务端，
// 表现为“机身一顿一顿”——这个坑踩过一次，这里用顺序 + no-store 彻底堵死。
app.get('/flight-physics.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'flight-physics.js'));
});
// 战舰物理（同样的 no-store 策略，理由见上）
app.get('/naval-physics.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'naval-physics.js'));
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/health', (req, res) => {
  res.json({ ok: true, players: world.players.size, tick: world.tick, score: world.teamScore });
});

const httpServer = http.createServer(app);
/* ★ WebSocket 长连接友好：Node 默认 keepAliveTimeout=5 秒，被网关/云负载均衡
   转发时空闲超时会把连接掐断（表现为"开局几秒后掉线"）。放宽到 15 分钟。 */
httpServer.keepAliveTimeout = 15 * 60 * 1000;
httpServer.headersTimeout = 15 * 60 * 1000 + 5000;
httpServer.requestTimeout = 0;
httpServer.on('connection', (s) => { s.setTimeout(0); s.setNoDelay(true); });
const io = new Server(httpServer, {
  // 公网弱网经验值：默认 pingInterval 1000 / pingTimeout 4000 会陷入
  // "400 Session ID unknown" 重连死循环，这里照搬线上验证过的参数
  pingInterval: 8000,
  pingTimeout: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
  serveClient: true,
  path: '/socket.io'
});

// =============================================================================
// === 世界状态 ================================================================
// =============================================================================
const world = {
  time: 0,                 // 模拟时间（秒）
  tick: 0,
  players: new Map(),      // id -> player
  aircraft: [],            // 活跃的飞机（含残骸）
  missiles: [],
  flares: [],
  aaas: [],                // 防空阵地（AAA）
  flak: [],                // 已发射未引爆的 flak 弹（定时空爆）
  // ---- 海战 ----
  ships: [],               // 所有战舰（含残骸）
  shells: [],              // 飞行中的舰炮炮弹
  torps: [],               // 飞行中的鱼雷
  bombs: [],               // 飞行中的航空炸弹
  events: [],              // 待广播的事件队列
  teamScore: [0, 0],
  nextPlayerId: 1,
  nextEntityId: 1000,
  spawnSlot: [0, 0],
  matchOver: false,
  resetAt: 0,
  matchStart: 0,
  bounds: 15000            // 海域边界（超出强制返航）
};

const TEAM_NAME = ['蓝队', '红队'];

// =============================================================================
// === 工具 ====================================================================
// =============================================================================
function rid() { return world.nextEntityId++; }

function pushEvent(e) {
  world.events.push(e);
  if (world.events.length > 200) world.events.shift();
}

function activePlayers() {
  const out = [];
  for (const p of world.players.values()) if (p.connected) out.push(p);
  return out;
}

function activeHumans() {
  const out = [];
  for (const p of world.players.values()) if (p.connected && !p.bot) out.push(p);
  return out;
}

function countTeam(team, humansOnly) {
  let n = 0;
  for (const p of world.players.values()) {
    if (!p.connected || p.team !== team) continue;
    if (humansOnly && p.bot) continue;
    n++;
  }
  return n;
}

// 自动平衡：按真人数分边（机器人不参与分边，避免真人被塞进人少的一边当靶子）
function pickTeam() {
  const a = countTeam(0, true), b = countTeam(1, true);
  if (a === b) return Math.random() < 0.5 ? 0 : 1;
  return a < b ? 0 : 1;
}

const NAME_HEAD = ['雷霆', '猎鹰', '夜枭', '风暴', '烈焰', '苍狼', '流星', '海燕', '铁翼', '孤星', '长风', '雪隼'];
const NAME_TAIL = ['01', '07', '13', '21', '33', '42', '58', '66', '77', '88', '91', '05'];
function makeName() {
  const used = new Set();
  for (const p of world.players.values()) used.add(p.name);
  for (let i = 0; i < 60; i++) {
    const n = NAME_HEAD[(Math.random() * NAME_HEAD.length) | 0] + '-' + NAME_TAIL[(Math.random() * NAME_TAIL.length) | 0];
    if (!used.has(n)) return n;
  }
  return '飞行员-' + (world.nextPlayerId + 1);
}

function sanitizeName(raw) {
  let s = String(raw || '').replace(/[<>{}[\]\\\/\"]/g, '').trim();
  if (s.length > 14) s = s.slice(0, 14);
  if (!s) return '';
  return s;
}

function findAircraft(id) {
  for (const a of world.aircraft) if (a.id === id) return a;
  return null;
}

function timeLeft() {
  return Math.max(0, CONFIG.match.durationSec - (world.time - world.matchStart));
}

function roster() {
  const out = [];
  for (const p of world.players.values()) {
    out.push({
      i: p.id, n: p.name, t: p.team,
      k: p.kills, d: p.deaths, a: p.assists, s: p.score,
      l: p.landings, ai: p.bot ? 1 : 0,
      air: !!(p.aircraft && p.aircraft.alive)
    });
  }
  return out.sort((a, b) => b.s - a.s);
}

// =============================================================================
// === 出生 / 阵亡 / 重开 ======================================================
// =============================================================================
// 玩家兵种：'plane'（战斗机/轰炸机）或 'ship:bb|ca|dd'
function spawnPlayer(p) {
  // ---- 选了战舰：接管本队编队里同舰种的 AI 舰 ----
  if (p.vehicle && p.vehicle.startsWith('ship:')) {
    const wantType = p.vehicle.slice(5);
    // 优先找没被占的同型舰；找不到就找任意空闲舰（避免玩家卡死）
    let ship = world.ships.find((s) => s.alive && s.team === p.team && s.type === wantType && !s.ownerId);
    if (!ship) ship = world.ships.find((s) => s.alive && s.team === p.team && !s.ownerId);
    if (ship) {
      ship.ownerId = p.id;
      ship.ai = false;                    // 玩家接管
      // 交船兜底：AI 在玩家上舰前的那十几秒里可能已经把船开上浅滩
      // （AI 只管巡逻和开火，避岸探测是 1.4km 前瞻，仍会顶到近岸）。
      // 玩家接手一艘速度恒为 0、转向无效、只弹"搁浅警告"的船，会直接判定"游戏坏了"。
      // 所以交船时如果已经搁浅，就挪回巡逻锚点重新开始。
      if (ship.aground) {
        ship.pos.x = ship.patrol ? ship.patrol.x : ship.pos.x;
        ship.pos.z = ship.patrol ? ship.patrol.z : ship.pos.z;
        ship.speed = 0;
        ship.rudder = 0;
        ship.aground = false;
        if (process.env.SKY_DEV === '1') console.log('[ship] ' + ship.name + ' 交船时搁浅，已归位到锚点');
      }
      p.ship = ship;
      p.aircraft = null;
      p.spawnCount = (p.spawnCount || 0) + 1;
      pushEvent({ k: 'msg', t: p.name + ' 登舰 ' + ship.name });
      return;
    }
    // 没有可用舰 → 回退到飞机
    pushEvent({ k: 'msg', t: '舰队已满 — 转为出击' });
  }
  // ---- 飞机（战斗机 / 轰炸机）----
  const slot = world.spawnSlot[p.team]++;
  const a = FP.createAircraft(p.id, p.name, p.team, {
    slot, spawnId: (p.spawnCount = (p.spawnCount || 0) + 1),
    atype: p.vehicle === 'plane:bomber' ? 'bomber' : 'fighter'
  });
  // 机器人不返场补给，给双倍弹药让它能持续陪练
  if (p.bot) {
    a.ammo = Math.round(CONFIG.weapons.gun.ammoMax * 2.4);
    a.missiles = 6;
    a.flares = 20;
  }
  p.aircraft = a;
  p.ship = null;
  world.aircraft.push(a);
}

function pushBoom(pos, scale, kind) {
  pushEvent({ k: 'boom', p: [r2(pos.x), r2(pos.y), r2(pos.z)], s: scale, w: kind || '' });
}

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// 死亡结算：killerId 为空表示非战斗损失（坠毁）
// 注意：物理层坠毁时会先把 alive 置 false，所以这里用 deathDone 去重而不是 alive
function killAircraft(a, killerId, weapon) {
  if (!a || a.deathDone) return;
  a.deathDone = true;
  a.alive = false;
  a.health = 0;
  a.wreck = true;
  a.removeAt = world.time + CONFIG.match.wreckSec;
  a.lockProgress = 0;
  a.lockTargetId = 0;
  a.lockCandId = 0;
  a.lockReason = 0;

  const victim = world.players.get(a.id);
  if (victim) {
    victim.respawnAt = world.time + CONFIG.match.respawnSec;
    victim.deaths++;
    victim.score += CONFIG.scoring.death;
    victim.streak = 0;                       // 阵亡清零连杀
  }

  pushBoom(a.pos, 1.8, weapon || 'crash');

  const killer = killerId ? world.players.get(killerId) : null;
  if (killer && killer.id !== a.id) {
    const teamKill = killer.team === a.team;
    if (teamKill) {
      killer.score += CONFIG.scoring.teamKill;
    } else {
      killer.kills++;
      killer.score += CONFIG.scoring.kill;
      world.teamScore[killer.team] += CONFIG.scoring.kill;
      killer.streak = (killer.streak || 0) + 1;   // 连杀计数（阵亡/坠机清零）
    }
    // 助攻：最近 12 秒内造成过伤害的其他人
    const now = world.time;
    for (const key of Object.keys(a.damageLog || {})) {
      const id = +key;
      if (id === killerId || id === a.id) continue;
      if (now - a.damageLog[id] > 12) continue;
      const ap = world.players.get(id);
      if (!ap || ap.team === a.team) continue;
      ap.assists++;
      ap.score += CONFIG.scoring.assist;
      world.teamScore[ap.team] += CONFIG.scoring.assist;
    }
    pushEvent({ k: 'kill', a: killer.id, v: a.id, w: weapon || 'gun', tk: teamKill ? 1 : 0,
      st: teamKill ? 0 : (killer.streak || 0) });
  } else {
    if (victim) {
      victim.crashes++;
      victim.score += CONFIG.scoring.crash;
    }
    pushEvent({ k: 'crash', id: a.id, r: a.crashReason || 'terrain' });
  }
  a.damageLog = {};
  if (victim) victim.aircraft = a;
}

function damageAircraft(target, amount, attackerId, weapon) {
  if (!target || !target.alive) return;
  target.health -= amount;
  target.lastDamageAt = world.time;
  if (attackerId && attackerId !== target.id) {
    target.damageLog = target.damageLog || {};
    target.damageLog[attackerId] = world.time;
  }
  pushEvent({ k: 'hit', v: target.id, a: attackerId || 0, d: Math.round(amount), w: weapon || '' });
  if (target.health <= 0) killAircraft(target, attackerId, weapon);
}

function resetMatch() {
  world.teamScore = [0, 0];
  world.matchOver = false;
  world.matchStart = world.time;
  world.missiles.length = 0;
  world.flares.length = 0;
  initAaas();                               // 新一局防空阵地复位
  initFleets();                             // 新一局舰队复位
  for (const p of world.players.values()) {
    p.kills = 0; p.deaths = 0; p.crashes = 0; p.landings = 0; p.takeoffs = 0; p.score = 0; p.assists = 0; p.streak = 0;
    if (p.connected) {
      if (p.aircraft) {
        const idx = world.aircraft.indexOf(p.aircraft);
        if (idx >= 0) world.aircraft.splice(idx, 1);
      }
      p.aircraft = null;
      p.respawnAt = world.time;
    }
  }
  pushEvent({ k: 'msg', t: '新一局开始 — 目标分 ' + CONFIG.match.targetScore });
}

// =============================================================================
// === 武器：机炮 ==============================================================
// =============================================================================
function updateGun(a, inp, dt) {
  const G = CONFIG.weapons.gun;

  if (a.overheated && a.heat <= G.overheatLock) a.overheated = false;
  a.heat = Math.max(0, a.heat - G.coolRate * dt);

  // firing 是“扳机是否按住”的可视状态，快照 20Hz 也能画出连续曳光
  const want = inp.fire && a.ammo > 0 && !a.overheated;
  a.firing = want;
  if (want) a.fireAccum += G.rate * dt;
  else a.fireAccum = Math.max(0, a.fireAccum - G.rate * dt * 0.6);

  let guard = 0;
  while (a.fireAccum >= 1 && a.ammo > 0 && !a.overheated && guard++ < 8) {
    a.fireAccum -= 1;
    a.ammo--;
    a.heat += G.heatPerShot;
    if (a.heat >= 1) { a.heat = 1; a.overheated = true; }
    shootBullet(a);
  }
}

function shootBullet(a) {
  const G = CONFIG.weapons.gun;
  const fwd = Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
  const right = Q.rotate(a.quat, { x: 1, y: 0, z: 0 });
  const up = Q.rotate(a.quat, { x: 0, y: 1, z: 0 });

  const sx = (Math.random() - 0.5) * G.spread * 2;
  const sy = (Math.random() - 0.5) * G.spread * 2;
  const dir = V.norm({
    x: fwd.x + right.x * sx + up.x * sy,
    y: fwd.y + right.y * sx + up.y * sy,
    z: fwd.z + right.z * sx + up.z * sy
  });
  const origin = V.add(a.pos, V.mul(fwd, 9));
  const rad = CONFIG.aircraft.hitRadius;

  // 真正的“炮弹飞行时间”求解：|目标位置 + 目标速度*t - 弹道起点 - 弹速*t| = 命中半径
  // 这样高机动目标需要提前量，而不是打当前坐标就能中
  let best = null, bestD = Infinity;
  for (const tgt of world.aircraft) {
    if (!tgt.alive || tgt.id === a.id) continue;
    const rel = V.sub(tgt.pos, origin);
    const w = V.sub(tgt.vel, V.mul(dir, G.speed));
    const A = V.dot(w, w);
    const B = 2 * V.dot(rel, w);
    const C = V.dot(rel, rel) - rad * rad;
    let hitT = -1;
    if (C <= 0) hitT = 0;                       // 枪口已经贴脸
    else if (A > 1e-6) {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const t1 = (-B - Math.sqrt(disc)) / (2 * A);
        if (t1 >= 0) hitT = t1;
      }
    }
    if (hitT < 0) continue;
    const d = G.speed * hitT;
    if (d <= 0 || d > G.range) continue;
    if (d < bestD) { bestD = d; best = tgt; }
  }

  // 防空阵地也是弹道目标：射线-点最近距离判中（站点中心 y+7）
  let siteT = Infinity, siteHit = null;
  for (const s of world.aaas) {
    if (!s.alive || s.team === a.team) continue;
    const rel = V.sub({ x: s.x, y: s.y + 7, z: s.z }, origin);
    const t = V.dot(rel, dir);
    if (t <= 0 || t > G.range) continue;
    const perp2 = V.len(rel) * V.len(rel) - t * t;
    if (perp2 < AAA_CFG.hitR * AAA_CFG.hitR && t < siteT) { siteT = t; siteHit = s; }
  }

  // 命中地面也要截断弹道（做视觉弹着点用，事件按概率节流发送）
  let terrainT = Infinity;
  const step = 100;
  for (let d = step; d <= G.range; d += step) {
    const px = origin.x + dir.x * d, py = origin.y + dir.y * d, pz = origin.z + dir.z * d;
    const gh = FP.terrainHeight(px, pz);
    if (py <= Math.max(gh, 0)) { terrainT = d; break; }
  }
  if (best && bestD < terrainT && bestD < siteT) {
    damageAircraft(best, G.damage, a.id, 'gun');
  } else if (siteHit && siteT < terrainT) {
    damageSite(siteHit, G.damage * 0.8, a.id);
    if (Math.random() < 0.5) {
      const hx = origin.x + dir.x * siteT, hy = origin.y + dir.y * siteT, hz = origin.z + dir.z * siteT;
      pushEvent({ k: 'impact', p: [r2(hx), r2(hy), r2(hz)] });
    }
  } else if (terrainT !== Infinity && Math.random() < 0.22) {
    const px = origin.x + dir.x * terrainT;
    const py = Math.max(FP.terrainHeight(origin.x + dir.x * terrainT, origin.z + dir.z * terrainT), 0);
    const pz = origin.z + dir.z * terrainT;
    pushEvent({ k: 'impact', p: [r2(px), r2(py + 0.5), r2(pz)] });
  }
}

// =============================================================================
// === 敌情发现（友军识别 / 数据链共享）=========================================
// =============================================================================
// 一架敌机对某队“可见”的条件：该队任一存活飞行员与它的距离 < spotRange。
// 注意这是**双向共享**的：只要有一个友军看到，全队（含 HUD/雷达/锁定）都拿得到，
// 这正是“友军识别的敌机也要下发”的意思。
const SPOT_R2 = (CONFIG.net.spotRange || 10000) ** 2;
function teamSees(a, team) {
  if (a.team === team) return true;
  for (const b of world.aircraft) {
    if (b.team !== team || !b.alive || b.wreck) continue;
    const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
    if (dx * dx + dy * dy + dz * dz < SPOT_R2) return true;
  }
  return false;
}
function spotMask(a) {
  let m = 0;
  if (teamSees(a, 0)) m |= 1;
  if (teamSees(a, 1)) m |= 2;
  return m;
}

// =============================================================================
// === 近地屏蔽：地杂波 + 地形视线遮挡 ==========================================
// =============================================================================
// 两条互补的规则，让“贴地突防”真的有用：
//   1) 地杂波：目标离地净空越低，雷达能“看穿”的距离越短（掠海/钻山谷锁不上）
//   2) 地形遮挡：射手与目标之间隔着山脊/山体，视线被挡住 → 直接断锁
// 机炮本来就有地形截断（见 shootBullet），导弹以前只有“擦地即炸”，
// 所以低空目标几乎无法用山体躲开导弹 —— 这里补上。
const TERR_TOP = (CONFIG.terrain.hill + CONFIG.terrain.mountain) * 1.02 + 60;

// 离地净空（海面按 0 计）
function groundClearance(pos) {
  return pos.y - Math.max(FP.terrainHeight(pos.x, pos.z), 0);
}

// 地杂波压制系数：1 = 完全可探测，0 = 彻底沉进地面回波
function clutterFactor(pos) {
  const M = CONFIG.weapons.missile;
  const agl = groundClearance(pos);
  if (agl >= M.maskAlt) return 1;
  if (agl <= M.maskFloorAlt) return 0;
  return (agl - M.maskFloorAlt) / (M.maskAlt - M.maskFloorAlt);
}

// 该目标在当前净空下的有效锁定距离
function lockRangeFor(pos) {
  const M = CONFIG.weapons.missile;
  return M.lockRange * (M.maskRangeScale + (1 - M.maskRangeScale) * clutterFactor(pos));
}

// 视线遮挡：沿 from→to 采样地形高度，任一点高于视线即被山体挡住。
// 两端都远高于全图最高峰时直接跳过，避免每帧白算。
function losBlocked(from, to) {
  const M = CONFIG.weapons.missile;
  if (Math.min(from.y, to.y) > TERR_TOP) return false;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  const n = Math.max(2, Math.min(16, Math.round(horiz / M.losStep)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const gh = FP.terrainHeight(from.x + dx * t, from.z + dz * t);
    if (gh > 0 && from.y + dy * t < gh + M.losMargin) return true;
  }
  return false;
}

// =============================================================================
// === 锁定 ====================================================================
// =============================================================================
function updateLocks(dt) {
  const M = CONFIG.weapons.missile;
  // 第一遍：清空“被锁定”标记（必须先整体清空，否则会依赖遍历顺序）
  for (const a of world.aircraft) a.lockedBy = 0;
  // 第二遍：搜索视锥内最近的目标并累积锁定进度
  for (const a of world.aircraft) {
    if (!a.alive) {
      a.lockProgress = 0; a.lockTargetId = 0; a.lockCandId = 0; a.lockReason = 0;
      continue;
    }
    let best = null, bestAng = Infinity;       // 真正可锁的目标
    let cand = null, candAng = Infinity;       // 视锥内最优目标（不管能不能锁，给 HUD 指路）
    let reason = 0;                            // 1 = 地形遮挡  2 = 目标贴地杂波
    const fwd0 = Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
    for (const t of world.aircraft) {
      if (!t.alive || t.team === a.team) continue;
      const d = V.sub(t.pos, a.pos);
      const range = V.len(d);
      if (range > M.lockRange || range < M.lockMinRange) continue;
      // 只能锁定“本队已经发现”的目标（敌情靠友军数据链共享）
      if (!teamSees(t, a.team)) continue;
      const ang = FP.angleBetween(fwd0, d);
      if (ang > M.lockCone) continue;
      if (ang < candAng) { candAng = ang; cand = t; }

      // ---- 近地屏蔽 1：地杂波把有效锁定距离压短 ----
      const clear = clutterFactor(t.pos);
      if (clear < 0.02) { if (!reason) reason = 2; continue; }
      if (range > M.lockRange * (M.maskRangeScale + (1 - M.maskRangeScale) * clear)) {
        if (!reason) reason = 2;
        continue;
      }
      // ---- 近地屏蔽 2：山体挡住视线 → 直接断锁（优先级高于杂波）----
      if (losBlocked(a.pos, t.pos)) { reason = 1; continue; }

      if (ang < bestAng) { bestAng = ang; best = t; }
    }
    a.lockReason = best ? 0 : reason;
    a.lockCandId = best ? best.id : (cand ? cand.id : 0);
    if (best) {
      a.lockTargetId = best.id;
      a.lockProgress = Math.min(1, a.lockProgress + dt / M.lockTime);
      if (a.lockProgress >= 1 && best.lockedBy === 0) best.lockedBy = a.id;
    } else {
      a.lockTargetId = 0;
      // 被地形挡住/杂波压制时掉锁更快：钻进山谷能迅速甩掉锁定
      a.lockProgress = Math.max(0, a.lockProgress - dt * (reason ? M.losDecay : 1.4));
    }
  }
}

// =============================================================================
// === 武器：导弹 ==============================================================
// =============================================================================
function tryLaunchMissile(p, a) {
  const M = CONFIG.weapons.missile;
  if (a.missiles <= 0 || a.missileCd > 0) return false;
  const tgt = a.lockTargetId ? findAircraft(a.lockTargetId) : null;
  // 视锥 + 距离验证：必须完成锁定
  if (!tgt || !tgt.alive || a.lockProgress < 1) {
    // ---- 未锁定：长按蓄力发射（哑弹直飞）----
    // p.holdMissile 由主循环按 input.missile 持续按住累计；松手清零。
    // 蓄满 M.holdFireTime 才发：防止误点一下就浪费一枚。
    if (!p.holdMissile || p.holdMissile < (M.holdFireTime || 1.2)) return false;
    a.missiles--;
    a.missileCd = M.cooldown;
    p.holdMissile = 0;
    const fwd = Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
    const speed = V.len(a.vel) + M.startSpeed;
    const id = rid();
    world.missiles.push({
      id,
      owner: a.id,
      team: a.team,
      targetId: 0,            // 无目标 = 直飞
      spoofId: 0,
      pos: V.add(a.pos, V.mul(fwd, 10)),
      dir: V.copy(fwd),
      vel: V.mul(fwd, speed),
      speed,
      age: 0,
      life: M.life,
      prevRange: 1e9,
      blindT: 0,
      dumb: true,             // 无制导直飞
      losSeen: 0,
      losT: 0
    });
    pushEvent({ k: 'ml', id: a.id, m: id, dumb: 1 });
    return true;
  }

  const fwd = Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
  const d = V.sub(tgt.pos, a.pos);
  const range = V.len(d);
  const ang = FP.angleBetween(fwd, d);
  if (ang > M.lockCone || range > M.lockRange * 1.05 || range < M.lockMinRange * 0.5) return false;

  // 近地屏蔽复核：从“锁定完成”到“按下发射”之间，目标可能已经钻进山谷或贴到海面。
  // 这时不给发射，并回一个 mf 事件让客户端说明原因（1 = 地形遮挡，2 = 目标贴地）。
  if (losBlocked(a.pos, tgt.pos)) {
    pushEvent({ k: 'mf', id: a.id, r: 1 });
    return false;
  }
  if (range > lockRangeFor(tgt.pos) * 1.05) {
    pushEvent({ k: 'mf', id: a.id, r: 2 });
    return false;
  }

  a.missiles--;
  a.missileCd = M.cooldown;
  const speed = V.len(a.vel) + M.startSpeed;
  const id = rid();
  world.missiles.push({
    id,
    owner: a.id,
    team: a.team,
    targetId: tgt.id,
    spoofId: 0,
    pos: V.add(a.pos, V.mul(fwd, 10)),
    dir: V.copy(fwd),
    vel: V.mul(fwd, speed),
    speed,
    age: 0,
    life: M.life,
    prevRange: range,
    // 近地屏蔽状态：blindT = 导引头被压制累计时间；dumb = 彻底丢失制导（转无制导直飞）
    blindT: 0,
    dumb: false,
    losSeen: 0,      // 1 = 目标被地形挡住（10Hz 刷新，省采样）
    losT: 0
  });
  pushEvent({ k: 'ml', id: a.id, m: id });
  return true;
}

function tryDropFlare(p, a) {
  const F = CONFIG.weapons.flare;
  if (a.flares <= 0 || a.flareCd > 0) return false;
  a.flares--;
  a.flareCd = F.cooldown;
  const fwd = Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
  const id = rid();
  world.flares.push({
    id,
    owner: a.id,
    team: a.team,
    pos: V.add(a.pos, V.mul(fwd, -8)),
    vel: V.add(a.vel, V.mul(fwd, -F.backSpeed)),
    life: F.life
  });
  pushEvent({ k: 'fl', id: a.id, f: id });
  return true;
}

function updateMissiles(dt) {
  const M = CONFIG.weapons.missile;
  const F = CONFIG.weapons.flare;

  for (let i = world.missiles.length - 1; i >= 0; i--) {
    const m = world.missiles[i];
    m.life -= dt;
    m.age += dt;

    // ---- 干扰弹诱骗 ----
    if (!m.spoofId) {
      let tgtPos = null;
      const t = findAircraft(m.targetId);
      if (t && t.alive) tgtPos = t.pos;
      let bestFlare = null, bestAng = Infinity;
      for (const f of world.flares) {
        if (f.team === m.team) continue;
        const d = V.sub(f.pos, m.pos);
        const dist = V.len(d);
        if (dist > F.spoofRange) continue;
        const ang = FP.angleBetween(m.dir, d);
        if (ang > F.spoofCone) continue;
        if (ang < bestAng) { bestAng = ang; bestFlare = f; }
      }
      if (bestFlare) {
        // 干扰弹比目标更“接近瞄准线”就上当
        let tgtAng = Math.PI;
        if (tgtPos) tgtAng = FP.angleBetween(m.dir, V.sub(tgtPos, m.pos));
        if (bestAng < tgtAng + 0.12) m.spoofId = bestFlare.id;
      }
    }

    // ---- 目标 ----
    let tgt = null;
    if (m.dumb) {
      // 导引头已经被地面回波彻底压死：断开目标，剩下的路程当无制导火箭弹直飞
      m.targetId = 0; m.spoofId = 0;
    } else if (m.spoofId) {
      tgt = world.flares.find((f) => f.id === m.spoofId) || null;
      if (!tgt) { m.spoofId = 0; m.targetId = 0; }   // 诱饵烧完 → 变哑弹
    } else {
      const t = findAircraft(m.targetId);
      if (t && t.alive) tgt = t; else m.targetId = 0;
    }
    const tgtPos = tgt ? tgt.pos : null;
    const tgtVel = tgt ? tgt.vel : null;

    // ---- 近地屏蔽：导引头致盲判定 ----
    // 两种情况算“看不见目标”：导弹自己贴地（地面回波灌满导引头），
    // 或目标被山体挡住（导弹跟丢了）。短暂致盲只丢瞬时跟踪，
    // 连续超过 seekerHold 就彻底丢锁 —— 钻山谷/掠海能真的甩掉导弹。
    if (!m.dumb) {
      let blind = false;
      const mgh = Math.max(FP.terrainHeight(m.pos.x, m.pos.z), 0);
      if (m.pos.y - mgh < M.seekerFloor) blind = true;
      if (!blind && tgtPos) {
        m.losT -= dt;
        if (m.losT <= 0) { m.losT = 0.10; m.losSeen = losBlocked(m.pos, tgtPos) ? 1 : 0; }
        if (m.losSeen) blind = true;
      } else {
        m.losSeen = 0;
      }
      if (blind) {
        m.blindT += dt;
        if (m.blindT >= M.seekerHold) {
          m.dumb = true;
          pushEvent({ k: 'mb', id: m.id, o: m.owner, p: [r2(m.pos.x), r2(m.pos.y), r2(m.pos.z)] });
        }
      } else {
        m.blindT = Math.max(0, m.blindT - dt * 2.5);
      }
    }

    // ---- 制导：比例导引近似（提前量 + 转向速率限制）----
    let aim;
    if (tgtPos) {
      const toT = V.sub(tgtPos, m.pos);
      const range = V.len(toT);
      const closing = Math.max(120, m.speed);
      const lead = tgtVel ? V.add(tgtPos, V.mul(tgtVel, Math.min(2.5, range / closing))) : tgtPos;
      aim = lead;
    } else {
      aim = V.add(m.pos, V.mul(m.dir, 1200));
    }
    const desired = V.norm(V.sub(aim, m.pos));
    const ang = FP.angleBetween(m.dir, desired);
    const maxTurn = M.turnRate * dt;
    if (ang > 1e-5) {
      if (ang <= maxTurn) m.dir = desired;
      else {
        let axis = V.cross(m.dir, desired);
        if (V.len(axis) < 1e-6) axis = { x: 0, y: 1, z: 0 };
        m.dir = V.norm(Q.rotAxis(m.dir, axis, maxTurn));
      }
    }

    // ---- 运动 ----
    m.speed = Math.min(M.maxSpeed, m.speed + M.accel * dt);
    m.vel = V.mul(m.dir, m.speed);
    m.pos = V.add(m.pos, V.mul(m.vel, dt));

    // ---- 引信 ----
    let boom = false;
    if (tgtPos) {
      const range = V.len(V.sub(tgtPos, m.pos));
      if (m.age > M.armTime) {
        if (range <= M.fuse) boom = true;
        else if (m.prevRange < M.fuse * 1.6 && range > m.prevRange) boom = true; // 擦身而过
      }
      m.prevRange = range;
    }
    const gh = FP.terrainHeight(m.pos.x, m.pos.z);
    if (m.pos.y <= Math.max(gh, 0) + 1) boom = true;
    if (m.life <= 0) boom = true;
    if (Math.abs(m.pos.x) > CONFIG.world.half + 2000 || Math.abs(m.pos.z) > CONFIG.world.half + 2000) boom = true;

    if (boom) {
      explodeMissile(m);
      world.missiles.splice(i, 1);
    }
  }
}

function explodeMissile(m) {
  const M = CONFIG.weapons.missile;
  pushBoom(m.pos, 1.2, 'missile');
  for (const a of world.aircraft) {
    if (!a.alive) continue;
    const d = V.dist(a.pos, m.pos);
    if (d > M.blast) continue;
    const dmg = M.damage * (1 - d / M.blast) * (1 - d / M.blast);
    if (dmg > 1) damageAircraft(a, dmg, m.owner, 'missile');
  }
  // 近炸也会打掉附近的干扰弹
  for (let i = world.flares.length - 1; i >= 0; i--) {
    if (V.dist(world.flares[i].pos, m.pos) < M.blast * 0.6) world.flares.splice(i, 1);
  }
}

function updateFlares(dt) {
  const F = CONFIG.weapons.flare;
  for (let i = world.flares.length - 1; i >= 0; i--) {
    const f = world.flares[i];
    f.life -= dt;
    f.vel.y -= CONFIG.world.gravity * 0.55 * dt;
    f.vel = V.mul(f.vel, Math.max(0, 1 - F.life * 0.0 - 0.9 * dt));
    f.pos = V.add(f.pos, V.mul(f.vel, dt));
    const gh = FP.terrainHeight(f.pos.x, f.pos.z);
    if (f.life <= 0 || f.pos.y <= Math.max(gh, 0) + 1) world.flares.splice(i, 1);
  }
}

// =============================================================================
// === 防空阵地（AAA）==========================================================
// =============================================================================
// 每队两门防空炮守卫机场进近航线：向低空穿越的敌机打预测 flak（定时空爆、范围杀伤）。
// 阵地可被机炮摧毁（个人/团队加分），摧毁后延时重生。逼出对地攻击玩法，
// 同时压制贴地无脑扫地的打法。
const AAA_CFG = {
  range: 3000,        // 开火包线（米）
  minAgl: 80,         // 低于此离地高度不开火（起飞/降落阶段友好）
  burstGap: 1.15,     // 每轮点射间隔（秒）
  shellSpeed: 850,    // 弹丸平均速度（预测用）
  damage: 15,         // 爆心伤害（线性衰减到杀伤半径边缘）
  blastR: 42,         // 杀伤半径（米）
  siteKill: 30,       // 摧毁阵地的个人/团队分
  respawnSec: 75,     // 阵地重生时间
  hitR: 14            // 机炮弹道判中半径
};

function initAaas() {
  world.aaas.length = 0;
  world.flak.length = 0;
  // 部署在两队机场进近方向（本队机场 x=-12000/+12000），对称布局
  const defs = [
    { tm: 0, x: -9700, z: -3000 }, { tm: 0, x: -9300, z: -1300 },
    { tm: 1, x: 9700, z: 3000 },  { tm: 1, x: 9300, z: 1300 }
  ];
  defs.forEach((d, i) => {
    world.aaas.push({      id: 9000 + i, team: d.tm, x: d.x, z: d.z,
      y: Math.max(FP.terrainHeight(d.x, d.z), 0),
      hp: 100, alive: true, respawnAt: 0,
      nextScan: 0, nextShot: 0, targetId: 0
    });
  });
}

function damageSite(s, amount, attackerId) {
  if (!s.alive) return;
  s.hp -= amount;
  if (s.hp > 0) return;
  s.alive = false;
  s.hp = 0;
  s.targetId = 0;
  s.respawnAt = world.time + AAA_CFG.respawnSec;
  pushBoom({ x: s.x, y: s.y + 6, z: s.z }, 2.6, 'site');
  pushEvent({ k: 'sd', i: s.id, a: attackerId || 0 });
  const ap = attackerId ? world.players.get(attackerId) : null;
  if (ap && ap.team !== s.team) {
    ap.score += AAA_CFG.siteKill;
    world.teamScore[ap.team] += AAA_CFG.siteKill;
  }
}

function updateAaa(dt) {
  // ---- 空爆引信：到时起爆，范围杀伤敌机 ----
  for (let i = world.flak.length - 1; i >= 0; i--) {
    const f = world.flak[i];
    if (world.time < f.t) continue;
    world.flak.splice(i, 1);
    pushBoom(f.p, 0.55, 'flak');
    for (const tgt of world.aircraft) {
      if (!tgt.alive || tgt.wreck || tgt.team === f.tm) continue;
      const d = V.dist(tgt.pos, f.p);
      if (d < AAA_CFG.blastR) {
        damageAircraft(tgt, AAA_CFG.damage * (1 - d / AAA_CFG.blastR) + 4, 0, 'flak');
      }
    }
  }
  // ---- 火控：扫描 → 预测射击 ----
  for (const s of world.aaas) {
    if (!s.alive) {
      if (world.time >= s.respawnAt) { s.alive = true; s.hp = 100; }
      continue;
    }
    if (world.time < s.nextScan) continue;
    s.nextScan = world.time + 0.5;          // 火控 2Hz，省算力
    const muzzle = { x: s.x, y: s.y + 7, z: s.z };
    let best = null, bestD = AAA_CFG.range;
    for (const tgt of world.aircraft) {
      if (!tgt.alive || tgt.wreck || tgt.team === s.team) continue;
      if (tgt.onGround) continue;           // 滑行/停放不打，起降友好
      if (groundClearance(tgt.pos) < AAA_CFG.minAgl) continue;
      const d = V.dist(tgt.pos, muzzle);
      if (d > bestD) continue;
      if (losBlocked(muzzle, tgt.pos)) continue;   // 山体背后不打
      bestD = d; best = tgt;
    }
    s.targetId = best ? best.id : 0;
    if (!best || world.time < s.nextShot) continue;
    s.nextShot = world.time + AAA_CFG.burstGap;
    // 预射击点 = 目标未来位置 + 随机散布（散布随距离/速度增大，机动甩不掉但更难被命中）
    const tof = bestD / AAA_CFG.shellSpeed;
    const jitter = 12 + bestD * 0.012 + best.speed * 0.02;
    const p = {
      x: best.pos.x + best.vel.x * tof + (Math.random() - 0.5) * jitter,
      y: best.pos.y + best.vel.y * tof + (Math.random() - 0.5) * jitter,
      z: best.pos.z + best.vel.z * tof + (Math.random() - 0.5) * jitter
    };
    const gy = Math.max(FP.terrainHeight(p.x, p.z), 0);
    if (p.y < gy + 5) p.y = gy + 5;         // 不打进地里
    world.flak.push({ t: world.time + tof, tm: s.team, p: { x: r2(p.x), y: r2(p.y), z: r2(p.z) } });
  }
}

// =============================================================================
// === 机场补给 / 维修 =========================================================
// =============================================================================
function updateBaseService(a) {
  if (!a.alive || !a.onGround) return;
  if (a.speed > CONFIG.base.stopSpeed) return;
  // 补给点：本队机场 + 本队航母甲板（着舰停稳）。
  // 航母着舰要勾阻拦索、滑行停稳，难度远高于机场直降，
  // 给满补给是应得的返场奖励，不算刷分漏洞。
  const ap = FP.teamAirport(a.team);
  const onHome = FP.onAirport(ap, a.pos.x, a.pos.z, 1.15);
  // 在哪艘本队航母上（甲板判定按飞机位置）
  let cvHere = null;
  if (!onHome) {
    const cv = FP.carrierAt(a.pos.x, a.pos.z, 1.0);
    if (cv && cv.team === a.team && a.deckStopped) cvHere = cv;
  }
  if (!onHome && !cvHere) return;
  if (a.serviced) return;

  a.serviced = true;
  a.health = 100;
  a.ammo = CONFIG.weapons.gun.ammoMax;
  a.missiles = CONFIG.weapons.missile.count;
  a.flares = CONFIG.weapons.flare.count;
  // 轰炸机挂载补齐
  if (a.atype === 'bomber' && FP.AC_TYPES.bomber && FP.AC_TYPES.bomber.loadout) {
    a.torps = FP.AC_TYPES.bomber.loadout.torp;
    a.bombs = FP.AC_TYPES.bomber.loadout.bomb;
  }
  a.heat = 0;
  a.overheated = false;
  const p = world.players.get(a.id);
  if (p) p.score += CONFIG.scoring.resupply;
  pushEvent({ k: 'supply', id: a.id, cv: cvHere ? 1 : 0, ct: -1, own: 1 });
  if (process.env.SKY_DEV === '1') {
    console.log('[supply] #' + a.id + (cvHere ? ' 母舰甲板' : ' 机场') + ' 满弹满油');
  }
}

// 弹射起飞请求：玩家在甲板上按 J。三种情况：
//   1) 已在弹射位、机头对正 → 直接弹射
//   2) 在甲板上但不在弹射位（典型：刚着舰停稳在斜角甲板中段）→ 先牵引到弹射位再自动弹射
//   3) 不在甲板上 → 忽略
// 航母有两艘（每队一艘），所有甲板坐标必须按"飞机当前所在的那艘舰"来算。
function tryCatapult(p, a) {
  const dbg = process.env.SKY_DEV === '1';
  const no = (why) => { if (dbg) console.log('[cat] 拒绝: ' + why); return false; };
  if (!a || !a.alive) return no('无机/已死');
  if (!a.onGround) return no('不在甲板上(onGround=false)');
  if (a.catActive) return no('弹射已在进行');
  if (a.taxiActive) return no('牵引已在进行');
  const cv = FP.carrierAt(a.pos.x, a.pos.z, 1.0);
  if (!cv) return no('不在甲板范围内');
  const l = FP.carrierLocal(a.pos.x, a.pos.z, cv);
  const atSlot = l.along >= cv.catZ - 40;
  if (!atSlot) {
    // 不在弹射位 → 牵引过去，到位后由物理层自动接弹射。
    // 不记牵引起点：物理层是定速滑行，从当前位置出发即可（回滚重放也连续）。
    a.taxiActive = true;
    a.catQueued = true;
    a.catActive = false;
    a.throttle = 0;
    a.speed = 0;
    a.deckStopped = false;
    a.wireCaught = false;
    pushEvent({ k: 'taxi', id: a.id, ct: cv.team });
    if (dbg) console.log('[cat] 牵引到弹射位(team' + cv.team + ') along=' + l.along.toFixed(0) + ' → ' + cv.catZ);
    return true;
  }
  const ypr = FP.yprFromQuat(a.quat);
  const want = Math.atan2(cv.hx, cv.hz);
  let d = ypr.yaw - want;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) > 0.6) return no('机头未对正 d=' + d.toFixed(2));
  a.catActive = true;
  a.catT = 0;
  a.gYaw = want;
  a.gPitch = 0;
  a.throttle = 1;
  pushEvent({ k: 'cat', id: a.id, ct: cv.team });
  if (dbg) console.log('[cat] 弹射启动 id=' + a.id + ' team' + cv.team);
  return true;
}

// =============================================================================
// === 海战：舰队编队 / 初始化 / AI =============================================
// =============================================================================
// 编队锚点：各队在自己航母附近的海域（实测全海，且离本队机场最近）。
// 三艘舰沿纵列排开，逐舰就近吸附到可用海域（地形碎，硬摆会有一半泡在岸上）。
const FLEET_ANCHOR = [[-4196, -5288], [4196, 5288]];
const FLEET_FORM = [
  { type: 'bb', dx: 0, dz: -900 },     // 战列舰在最前（旗舰位）
  { type: 'ca', dx: 0, dz: 0 },        // 巡洋舰居中
  { type: 'dd', dx: 0, dz: 900 }       // 驱逐舰殿后
];
const FLEET_NAMES = [
  ['苍岭号', '青锋号', '疾风号'],
  ['赤沙号', '炎刃号', '烈火号']
];

// 海域可用性检测（服务端初始化用，只跑一次，不在乎性能）
// 半径 r 内是否"可航行"：不只是没有陆地，还要有足够水深。
// 之前只判 terrainHeight >= 0，结果把船摆在水深 6m 的浅滩上，
// 战列舰吃水 12m，一出生就搁浅（玩家看到的是一艘动不了的船）。
function seaClear(x, z, r, minDepth) {
  const md = minDepth === undefined ? 0 : minDepth;
  for (let dx = -r; dx <= r; dx += 50) {
    for (let dz = -r; dz <= r; dz += 50) {
      if (-FP.terrainHeight(x + dx, z + dz) < md) return false;
    }
  }
  return true;
}
// 目标点 → 就近吸附到可用海域（螺旋搜索）
function snapToSea(x, z, r, minDepth) {
  if (seaClear(x, z, r, minDepth)) return { x, z, moved: 0 };
  for (let rad = 100; rad <= 3000; rad += 100) {
    for (let a = 0; a < 360; a += 15) {
      const ar = a * Math.PI / 180;
      const px = x + Math.cos(ar) * rad, pz = z + Math.sin(ar) * rad;
      if (seaClear(px, pz, r, minDepth)) return { x: px, z: pz, moved: rad };
    }
  }
  return null;
}

// 生成双方舰队
function initFleets() {
  world.ships.length = 0;
  world.shells.length = 0;
  world.torps.length = 0;
  for (let team = 0; team < 2; team++) {
    const [ax, az] = FLEET_ANCHOR[team];
    // 舰队朝战场中心（舰艏指向中点）
    const heading = Math.atan2(-ax, -az);
    for (let i = 0; i < FLEET_FORM.length; i++) {
      const f = FLEET_FORM[i];
      // 按舰种吃水留余量（物理层判定也是 0.62*draft，两边必须一致，
      // 否则会出现"系统认为能停、物理层认为搁浅"的矛盾）
      const needDepth = Math.max(3, (NP.SHIP_TYPES[f.type].draft || 6) * 0.62);
      const spot = snapToSea(ax + f.dx, az + f.dz, 340, needDepth);
      if (!spot) { console.warn('[fleet] team' + team + ' 舰' + i + ' 找不到海域，跳过'); continue; }
      const s = NP.createShip(f.type, team, FLEET_NAMES[team][i], {
        id: rid(),
        x: spot.x, z: spot.z,
        heading: heading + (Math.random() - 0.5) * 0.2,
        num: i + 1
      });
      s.ai = true;                       // 无真人时由 AI 驾驶
      s.patrol = { x: spot.x, z: spot.z };
      world.ships.push(s);
      console.log('[fleet] team' + team + ' ' + s.name + '(' + s.T.short + ') @(' +
        Math.round(spot.x) + ',' + Math.round(spot.z) + ') 吸附' + spot.moved + 'm');
    }
  }
}

// 战舰 AI：选目标 + 保持距离 + 齐射 + 适时放鱼雷 + 避岸
function updateShipAI(s, dt) {
  if (!s.ai || !s.alive) return;
  const T = s.T;
  // ---- 避岸：三条探测线（正前/左前/右前），前方是岸就转向开阔侧 ----
  let avoid = 0;
  {
    const probeD = 1400 + Math.abs(s.speed) * 20;
    const fx = -Math.sin(s.heading), fz = -Math.cos(s.heading);
    const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
    const deep = (x, z) => FP.terrainHeight(x, z) < -Math.max(4, (T.draft || 6) * 0.62);
    const aheadLand = !deep(s.pos.x + fx * probeD, s.pos.z + fz * probeD);
    const leftLand = !deep(s.pos.x + (fx - rx * 0.7) * probeD * 0.8, s.pos.z + (fz - rz * 0.7) * probeD * 0.8);
    const rightLand = !deep(s.pos.x + (fx + rx * 0.7) * probeD * 0.8, s.pos.z + (fz + rz * 0.7) * probeD * 0.8);
    if (aheadLand) avoid = leftLand ? (rightLand ? 1 : -1) : -1;   // 前方有岸 → 偏向开阔侧
  }

  // ---- 选目标：最近的敌舰（30km 内），没有就朝中点巡弋 ----
  const near = NP.nearestEnemy(s, world.ships, 30000);
  let tgt = near ? near.ship : null;
  s.targetId = tgt ? tgt.id : 0;

  // ---- 航向：驻守锚点附近机动（母港都在全海区，远航会被地形切碎）----
  // 主炮射程 16km，两港相距约 13km —— 不出港也能隔海对射，所以不需要跨海追击。
  // 超出驻泊半径 3.5km 就掉头回锚点；避岸探测仍然保留（兜底）。
  let wantHeading;
  const homeD = Math.hypot(s.pos.x - s.patrol.x, s.pos.z - s.patrol.z);
  if (homeD > 3500) {
    wantHeading = Math.atan2(s.patrol.z - s.pos.z, s.patrol.x - s.pos.x);
  } else if (tgt) {
    const dx = tgt.pos.x - s.pos.x, dz = tgt.pos.z - s.pos.z;
    const bearing = Math.atan2(-dx, -dz);
    // 侧舷对敌（齐射所有炮塔），缓慢横移
    wantHeading = bearing + Math.PI / 2 * (s.id % 2 ? 1 : -1) + Math.sin(world.time * 0.05 + s.id) * 0.3;
  } else {
    wantHeading = Math.atan2(-s.pos.x, -s.pos.z);
  }
  if (avoid) wantHeading = s.heading + avoid * 1.2;   // 避岸优先级最高

  // 转向：航向误差 → 舵角
  let dh = wantHeading - s.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  const rudder = clamp(-dh * 1.8, -1, 1);   // 注意符号：heading 增加 = 左转

  // ---- 油门：目标距离决定；避岸时减速 ----
  let throttle = 2;
  if (tgt) {
    const dist = Math.hypot(tgt.pos.x - s.pos.x, tgt.pos.z - s.pos.z);
    throttle = dist > 14000 ? 3 : (dist > 8000 ? 2 : 1);
  }
  if (avoid) throttle = 1;

  // ---- 开火：主炮瞄准提前点 ----
  let fireMain = 0, targetX, targetZ;
  if (tgt) {
    const lead = NP.leadTarget(s, tgt, T.mainGuns);
    if (lead) { targetX = lead.x; targetZ = lead.z; fireMain = 1; }
  }

  // ---- 鱼雷：驱逐/巡洋舰，距离 3~9km 且舷侧对敌时放 ----
  let fireTorp = 0, torpDir = 0;
  if (T.torpedo && tgt) {
    const dx = tgt.pos.x - s.pos.x, dz = tgt.pos.z - s.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3000 && dist < T.torpedo.range * 0.75) {
      // 提前量：鱼雷慢，用目标航速外推
      const tf = NP.shipForward(tgt.heading);
      const tt = dist / T.torpedo.speed;
      const px = tgt.pos.x + tf.x * tgt.speed * tt;
      const pz = tgt.pos.z + tf.z * tgt.speed * tt;
      torpDir = Math.atan2(pz - s.pos.z, px - s.pos.x);
      fireTorp = 1;
    }
  }

  // ---- 损管：进水量大或火势大就开（有 2.5s 反应延迟，不能瞬间"秒修"）----
  let dc = 0;
  const needDc = (s.flood > 0.35 || s.fire > 0.3);
  if (needDc) {
    if (!s.aiDcAt) s.aiDcAt = world.time + 2.5;
    if (world.time >= s.aiDcAt && s.dcReady >= 1) dc = 1;
  } else {
    s.aiDcAt = 0;
  }

  return { throttle, rudder, fireMain, targetX, targetZ, fireTorp, torpDir, dc };
}

// 应用损管
function applyDamageControl(s) {
  if (!s.alive || s.dcReady < 1) return false;
  s.flood = Math.max(0, s.flood - 0.5);
  s.fire = Math.max(0, s.fire - 0.6);
  s.hp = Math.min(s.maxHp, s.hp + s.maxHp * s.T.repair.dcHeal);
  s.dcTimer = s.T.repair.dcCooldown;
  s.mods.engine = Math.min(1, s.mods.engine + 0.35);
  s.mods.rudder = Math.min(1, s.mods.rudder + 0.35);
  for (let i = 0; i < s.mods.mainGun.length; i++) {
    s.mods.mainGun[i] = Math.min(1, s.mods.mainGun[i] + 0.3);
  }
  return true;
}

// =============================================================================
// === 海战主步进 ==============================================================
// =============================================================================
// 每个 sim tick 调一次。事件收集用「带挂载列表」的对象，
// 这样 physics 里的 pushEvt 会写进 evts.evts，炮弹/鱼雷直接被主循环接管。
function stepNaval(dt) {
  const nav = { evts: [], shells: world.shells, torps: world.torps };
  const bounds = world.bounds;

  // ---- 0. 被击沉的战舰：45 秒后在编队锚点重生（满状态，交还 AI）----
  for (const s of world.ships) {
    if (s.alive || !s.respawnAt || world.time < s.respawnAt) continue;
    const [ax, az] = FLEET_ANCHOR[s.team];
    const spot = snapToSea(ax, az, 340);
    const resetOne = (o) => {
      o.hp = o.maxHp; o.alive = true; o.wreck = false; o.deathDone = false;
      o.sinking = 0; o.flood = 0; o.fire = 0; o.dcTimer = 0; o.dcReady = 1;
      o.mods.engine = 1; o.mods.rudder = 1;
      for (let i = 0; i < o.mods.mainGun.length; i++) o.mods.mainGun[i] = 1;
      for (const t of o.mainTurrets) { t.reload = 0; t.hp = 1; t.flash = 0; t.recoil = 0; }
      for (const t of o.torpTubes) { t.ammo = (o.T.torpedo ? o.T.torpedo.perTube : 0); t.reload = 0; }
      o.speed = 0; o.throttle = 1; o.roll = 0; o.pitch = 0;
    };
    if (spot) { s.pos.x = spot.x; s.pos.z = spot.z; }
    s.heading = Math.atan2(-s.pos.x, -s.pos.z);
    s.pos.y = 0;
    resetOne(s);
    s.respawnAt = 0;
    pushEvent({ k: 'msg', t: s.name + ' 重新下水' });
  }

  // ---- 1. 战舰 AI + 物理 ----
  for (const s of world.ships) {
    const input = updateShipAI(s, dt) || {};
    // 玩家操控的战舰（预留：p.ship 存在时用玩家输入）
    const p = s.ownerId ? world.players.get(s.ownerId) : null;
    const ctl = (p && p.connected && p.shipInput) ? p.shipInput : null;
    const final = ctl ? Object.assign({}, input, ctl) : input;
    if (final.dc) applyDamageControl(s);
    NP.stepShip(s, {
      throttle: final.throttle,
      rudder: final.rudder,
      fireMain: final.fireMain,
      targetX: final.targetX,
      targetZ: final.targetZ
    }, dt, nav, { time: world.time, aircraft: world.aircraft, bounds, terrain: FP.terrainHeight });

    // 鱼雷发射（AI 或玩家）
    // 玩家侧用锁存（p.shipTorpQueued）：高频包里的一次性意图不会被后续包冲掉。
    const queued = !!(p && p.shipTorpQueued);
    const wantTorp = final.fireTorp || queued;
    const wantDir = queued ? p.shipTorpDir : final.torpDir;
    if (queued) p.shipTorpQueued = false;
    if (wantTorp && s.T.torpedo) {
      for (const tube of s.torpTubes) {
        if (tube.ammo > 0 && tube.reload <= 0) {
          const dir = wantDir !== undefined ? wantDir : 0;
          NP.fireTorpedo(s, tube, dir, nav);
          break;                                  // 一次只放一管（齐射由冷却控制）
        }
      }
    } else if (wantTorp && s.ownerId && !s.T.torpedo) {
      // 无鱼雷管的舰（战列舰）按了 F：给个明确回应，别让玩家以为键坏了
      const pp = world.players.get(s.ownerId);
      if (pp) pushEvent({ k: 'msg', t: '本舰没有鱼雷管' });
    }
  }

  // ---- 2. 炮弹推进（命中舰船/飞机）----
  for (let i = world.shells.length - 1; i >= 0; i--) {
    const alive = NP.stepShell(world.shells[i], dt, world.ships, world.aircraft,
      { evts: nav.evts, ships: world.ships });
    if (!alive) world.shells.splice(i, 1);
  }

  // ---- 3. 鱼雷推进 ----
  for (let i = world.torps.length - 1; i >= 0; i--) {
    const alive = NP.stepTorpedo(world.torps[i], dt, world.ships, nav);
    if (!alive) world.torps.splice(i, 1);
  }
  // ---- 3.5 航空炸弹 ----
  for (let i = world.bombs.length - 1; i >= 0; i--) {
    const alive = NP.stepBomb(world.bombs[i], dt, world.ships, nav);
    if (!alive) world.bombs.splice(i, 1);
  }

  // ---- 4. 事件分发：伤害 / 沉没 / 计分 ----
  for (const e of nav.evts) {
    switch (e.k) {
      case 'shiphit':
      case 'torphit': {
        const tgt = world.ships.find((s) => s.id === e.tgt);
        if (!tgt) break;
        const p = e.by ? world.players.get(e.by) : null;
        if (p) p.damageDealt = (p.damageDealt || 0) + e.dmg;
        pushEvent(e);
        break;
      }
      case 'shipsink': {
        const tgt = world.ships.find((s) => s.id === e.id);
        // 击沉计分：给最后的命中者（真实海战也是"最后打沉的人"拿战果）
        const killerId = e.by || (tgt && tgt.lastHitBy) || 0;
        const kp = killerId ? world.players.get(killerId) : null;
        // 按舰种加权：驱逐 150 / 巡洋 300 / 战列 600（打大船才值钱）
        const weight = tgt ? ({ dd: 0.5, ca: 1.0, bb: 2.0 }[tgt.type] || 1) : 1;
        const gain = Math.round((CONFIG.scoring.shipKill || 300) * weight);
        if (kp) {
          kp.kills = (kp.kills || 0) + 1;
          kp.score += gain;
          kp.shipKills = (kp.shipKills || 0) + 1;
        }
        if (tgt) {
          // 释放被击沉舰上的玩家（他要去重生别的东西）
          if (tgt.ownerId) {
            const tp = world.players.get(tgt.ownerId);
            if (tp) { tp.ship = null; tp.respawnAt = world.time + 2; }
            tgt.ownerId = 0;
          }
          // 安排重生：45 秒后在编队锚点归位
          tgt.respawnAt = world.time + 45;
          pushEvent({
            k: 'shipsink', id: e.id, by: killerId, gain,
            name: tgt ? tgt.name : '', tm: tgt ? tgt.team : 0,
            type: tgt ? tgt.type : '', reason: e.reason
          });
        }
        break;
      }
      case 'shipfire':
      case 'shellsplash':
      case 'aahit': {
        // 舰防空命中：真正结算伤害（否则防空只是特效，轰炸机可以无风险贴脸）
        const ac = world.aircraft.find((a) => a.id === e.id);
        const gunner = e.by ? world.ships.find((s) => s.id === e.by) : null;
        if (ac && ac.alive) {
          damageAircraft(ac, e.dmg || 0, (gunner && gunner.ownerId) || 0, 'aa');
        }
        pushEvent(e);
        break;
      }
      case 'shellair': {
        // 大口径炮弹近炸命中飞机
        const ac = world.aircraft.find((a) => a.id === e.id);
        if (ac && ac.alive) damageAircraft(ac, e.dmg || 0, e.by || 0, 'shell');
        pushEvent(e);
        break;
      }
      case 'aatrace':
        pushEvent(e);
        break;
      default:
        pushEvent(e);
    }
  }
}

// =============================================================================
// === 模拟主循环 ==============================================================
// =============================================================================
function simulate(dt) {
  world.time += dt;
  world.tick++;

  // ---- 0. 机器人决策（只写入 input，不直接改状态）----
  for (const p of world.players.values()) {
    if (!p.bot || !p.connected) continue;
    p.input = updateBot(p, world, dt);
  }

  // ---- 1. 清理过期的残骸 ----
  for (let i = world.aircraft.length - 1; i >= 0; i--) {
    const a = world.aircraft[i];
    if (a.removeAt && world.time >= a.removeAt) {
      world.aircraft.splice(i, 1);
      const p = world.players.get(a.id);
      if (p && p.aircraft === a) p.aircraft = null;
    }
  }

  // ---- 2. 飞行积分 + 物理事件（起飞 / 触地 / 坠毁）----
  const evts = [];
  for (const a of world.aircraft) {
    const p = world.players.get(a.id);
    const input = (p && p.connected) ? p.input : FP.EMPTY_INPUT;
    FP.stepAircraft(a, input, dt, evts);
  }
  for (const e of evts) {
    if (e.k === 'takeoff') {
      const p = world.players.get(e.id);
      if (p) { p.takeoffs++; p.score += CONFIG.scoring.takeoff; }
      const a = findAircraft(e.id);
      if (a) a.serviced = false;
      pushEvent(e);
    } else if (e.k === 'touchdown') {
      const p = world.players.get(e.id);
      const ap = p ? FP.teamAirport(p.team) : null;
      const ownBase = !!(p && (FP.onAirport(ap, e.x, e.z, 1) || FP.onRunway(ap, e.x, e.z)));
      const cvHere = FP.carrierAt(e.x, e.z, 1);
      const onCarrier = !!e.cv || !!cvHere;
      // 只有本队航母才算"返场补给"；敌舰甲板在物理层已判坠毁，这里做二次保险
      const ownCarrier = !!cvHere && !!p && cvHere.team === p.team;
      if (p) {
        p.landings++;
        if (ownBase) p.score += CONFIG.scoring.landing;      // 回本队机场
        else if (ownCarrier) p.score += CONFIG.scoring.landing;  // 着本队舰
        // 敌舰：不给分（正常情况下物理层已判坠毁，走不到这里）
      }
      pushEvent({
        k: 'land', id: e.id, base: ownBase ? 1 : 0,
        cv: ownCarrier ? 1 : 0,
        ct: cvHere ? cvHere.team : (e.ct === undefined ? -1 : e.ct),
        own: ownCarrier ? 1 : 0, sp: Math.round(e.sp || 0)
      });
    } else if (e.k === 'wire' || e.k === 'cat' || e.k === 'launch' || e.k === 'taxi') {
      pushEvent(e);                              // 阻拦索/弹射/牵引：直接转发给客户端做表现
    } else if (e.k === 'crash') {
      const a = findAircraft(e.id);
      if (a) {
        // 最近 12 秒内被人打过 → 算对方击落，否则算自己坠毁
        let killer = 0, bestT = -1;
        const log = a.damageLog || {};
        for (const key of Object.keys(log)) {
          if (world.time - log[key] <= 12 && log[key] > bestT) { bestT = log[key]; killer = +key; }
        }
        killAircraft(a, killer, killer ? 'gun' : '');
      }
    }
  }

  // ---- 2.5 空中相撞（球体近似，双方都吃伤害；高速对撞基本同归于尽）----
  for (let i = 0; i < world.aircraft.length; i++) {
    const a = world.aircraft[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < world.aircraft.length; j++) {
      const b = world.aircraft[j];
      if (!b.alive) continue;
      const d = V.dist(a.pos, b.pos);
      if (d > CONFIG.aircraft.hitRadius * 1.5) continue;
      if (world.time - (a.lastRamAt || -99) < 1.5) continue;
      const rel = V.len(V.sub(a.vel, b.vel));
      if (rel < 26) continue;
      a.lastRamAt = b.lastRamAt = world.time;
      const mid = V.mul(V.add(a.pos, b.pos), 0.5);
      pushBoom(mid, 1.4, 'ram');
      const dmg = clamp(rel * 0.85, 28, 130);
      damageAircraft(a, dmg, b.id, 'ram');
      damageAircraft(b, dmg, a.id, 'ram');
    }
  }

  // ---- 3. 武器 / 锁定 ----
  updateLocks(dt);
  for (const p of activePlayers()) {
    const a = p.aircraft;
    if (!a || !a.alive || a.wreck) continue;
    updateGun(a, p.input, dt);
    // 导弹：按住时长累计（未锁定长按蓄力发射用）；松手清零。
    // 锁定完成时仍走"按下即发"（边沿），未锁定按住满 holdFireTime 才发哑弹。
    if (p.input.missile) {
      if (!p.prevMissile) {
        // 按下沿：已锁定就直接发，未锁定则开始蓄力
        if (a.lockProgress >= 1 && a.lockTargetId) tryLaunchMissile(p, a);
        p.holdMissile = 0.0001;
      } else {
        p.holdMissile = (p.holdMissile || 0) + dt;
        if (!(a.lockProgress >= 1 && a.lockTargetId) && p.holdMissile > 0.05) {
          // 蓄力中（发射判定在 tryLaunchMissile 内部按阈值判断）
          tryLaunchMissile(p, a);
        }
      }
    } else {
      p.holdMissile = 0;
    }
    if (p.input.flare && !p.prevFlare) tryDropFlare(p, a);
    p.prevMissile = !!p.input.missile;
    p.prevFlare = !!p.input.flare;
  }
  updateMissiles(dt);
  updateFlares(dt);
  updateAaa(dt);

  // ---- 4. 机场补给 ----
  for (const a of world.aircraft) updateBaseService(a);

  // ---- 5. 重新出击 ----
  for (const p of activePlayers()) {
    // 舰上玩家：重生由战舰自己管（沉没 45 秒后在锚点重新下水），
    // 这里必须跳过，否则每帧都会重新 spawnPlayer → 反复登舰占满全队舰船。
    if (p.ship) continue;
    if (p.aircraft && p.aircraft.alive) continue;
    if (p.aircraft && p.aircraft.removeAt > world.time) continue;   // 残骸还在场上
    if (world.time >= p.respawnAt) {
      if (p.aircraft) {
        const idx = world.aircraft.indexOf(p.aircraft);
        if (idx >= 0) world.aircraft.splice(idx, 1);
      }
      spawnPlayer(p);
    }
  }

  // ---- 5.5 海战：战舰 AI + 物理 + 炮弹/鱼雷推进 ----
  stepNaval(dt);

  // ---- 6. 比赛结束 / 重开 ----
  // 没有真人时冻结计时（否则空服务器会自己跑完一局又一局）
  if (activeHumans().length === 0) {
    world.matchStart = world.time;
    if (world.matchOver) { world.matchOver = false; world.teamScore = [0, 0]; }
  }
  if (!world.matchOver) {
    if (world.teamScore[0] >= CONFIG.match.targetScore || world.teamScore[1] >= CONFIG.match.targetScore || timeLeft() <= 0) {
      world.matchOver = true;
      world.resetAt = world.time + CONFIG.match.resetDelaySec;
      const win = world.teamScore[0] === world.teamScore[1] ? -1 : (world.teamScore[0] > world.teamScore[1] ? 0 : 1);
      pushEvent({ k: 'end', s: [world.teamScore[0], world.teamScore[1]], w: win, r: roster() });
    }
  } else if (world.time >= world.resetAt) {
    resetMatch();
  }
}

// =============================================================================
// === 快照广播 ================================================================
// =============================================================================
function buildSnapshot() {
  const snap = {
    t: r4(world.time),
    k: world.tick,
    sc: [world.teamScore[0], world.teamScore[1]],
    tl: Math.round(timeLeft()),
    mo: world.matchOver ? 1 : 0,
    a: [],
    m: [],
    f: [],
    s3: world.aaas.map((s) => ({ i: s.id, tm: s.team, p: [r2(s.x), r2(s.y), r2(s.z)], hp: Math.round(s.hp), al: s.alive ? 1 : 0, ta: s.targetId })),
    // 航母状态：每艘舰上停放的飞机数 + 正在弹射/牵引的飞机（客户端画蒸汽/阻拦索/牵引烟）
    // 两艘舰，n 按队分开给，cat/wire/taxi 带上队号让客户端知道画在哪艘舰上
    cv: {
      n: [0, 0],
      cat: [], taxi: [], wire: [],
      parked: []
    },
    e: world.events,
    // 战舰状态：位置/朝向/姿态/血量 + 炮塔朝向（客户端只做表现，不预测舰船）
    sp: world.ships.map((s) => ({
      i: s.id, tm: s.team, t: s.type, n: s.name,
      p: [r2(s.pos.x), r2(s.pos.y), r2(s.pos.z)],
      h: r4(s.heading),
      rp: r4(s.roll), pi: r4(s.pitch),
      v: r2(s.speed),
      hp: Math.round(s.hp), mx: s.maxHp, al: s.alive ? 1 : 0,
      wn: r4(s.wreck ? s.sinking : 0),
      rs: s.alive ? 0 : Math.max(0, Math.ceil((s.respawnAt || 0) - world.time)),
      fl: r4(s.flood), fi: r4(s.fire),
      ag: s.aground ? 1 : 0,
      // 损管就绪度 0..1 / 鱼雷：最好那一管的装填进度 + 总余雷
      dc: r2(s.dcReady === undefined ? 1 : s.dcReady),
      tr: s.T.torpedo ? r2(s.torpTubes.reduce((mx, t) => Math.max(mx, t.reload <= 0 ? 1 : 1 - t.reload / s.T.torpedo.reload), 0)) : 0,
      ty: s.torpTubes.reduce((n, t) => n + t.ammo, 0),
      // 主炮塔方位（客户端画炮塔转向动画）
      gy: s.mainTurrets.map((t) => r4(t.yaw)),
      gp: s.mainTurrets.map((t) => r4(t.pitch)),
      gr: s.mainTurrets.map((t) => r2(t.recoil)),
      gf: s.mainTurrets.map((t) => r2(t.flash)),
      gh: s.mods.mainGun.map((h) => r2(h)),
      // 每座主炮塔的装填进度 0..1（1=就绪）。HUD 的齐射准备度靠它，
      // 客户端自己计时不准：装填会被炮塔损毁、损管拉长。
      rl: s.mainTurrets.map((t) => {
        const full = Math.max(0.1, s.T.mainGuns.reload * (1 + (1 - clamp(s.mods.mainGun[t.idx] === undefined ? 1 : s.mods.mainGun[t.idx], 0, 1)) * 0.5));
        return r2(t.reload > 0 ? clamp(1 - t.reload / full, 0, 1) : 1);
      }),
      // 目标（画瞄准线用）
      ta: s.targetId || 0,
      // 玩家在舰上时标记（画玩家指示）
      ow: s.ownerId || 0
    })),
    // 飞行中的舰炮弹（客户端画曳光/水柱；量级 20~40 发，每发 4 个数）
    sh: world.shells.map((s) => ({ i: s.id, f: s.from, p: [r2(s.pos.x), r2(s.pos.y), r2(s.pos.z)], b: s.big ? 1 : 0, tm: s.team })),
    // 鱼雷（客户端画航迹泡）
    tp: world.torps.map((s) => ({ p: [r2(s.pos.x), r2(s.pos.y || 0.8), r2(s.pos.z)], d: r4(Math.atan2(s.dir.z, s.dir.x)), tm: s.team, air: s.pos.y > 2 ? 1 : 0, by: s.from || 0 })),
    // 航空炸弹
    bm: world.bombs.map((s) => ({ p: [r2(s.pos.x), r2(s.pos.y), r2(s.pos.z)] })),
    r: roster()
  };
  for (const a of world.aircraft) {
    const p = world.players.get(a.id);
    // 航母动态收集：两艘舰各算一份，客户端按队号画到对应的舰上
    if (a.alive && a.onGround && a.cvTeam >= 0) {
      snap.cv.n[a.cvTeam]++;
      snap.cv.parked.push(a.id);
    }
    if (a.catActive) snap.cv.cat.push({ i: a.id, ct: a.cvTeam });
    if (a.taxiActive) snap.cv.taxi.push({ i: a.id, ct: a.cvTeam });
    if (a.wireCaught) snap.cv.wire.push({ i: a.id, ct: a.cvTeam, k: a.wireIdx });
    snap.a.push({
      i: a.id,
      n: a.name,
      tm: a.team,
      at: a.atype === 'bomber' ? 'b' : 'f',
      tw: a.torps || 0,
      bw: a.bombs || 0,
      sid: a.spawnId,
      p: [r2(a.pos.x), r2(a.pos.y), r2(a.pos.z)],
      v: [r2(a.vel.x), r2(a.vel.y), r2(a.vel.z)],
      q: [r4(a.quat.x), r4(a.quat.y), r4(a.quat.z), r4(a.quat.w)],
      s: Math.round(a.speed),
      g: Math.round(a.gLoad * 10) / 10,
      // 迎角（弧度，2 位小数≈0.6°）。不发这个的话 HUD 的 α 只能靠客户端预测补，
      // 每收到一次快照就被清零 → 读数在 0 和真值之间闪。
      ao: r2(a.aoa),
      thr: Math.round(a.throttle * 100) / 100,
      gr: a.gear ? 1 : 0,
      og: a.onGround ? 1 : 0,
      hp: Math.round(a.health),
      al: a.alive ? 1 : 0,
      wk: a.wreck ? 1 : 0,
      st: a.stalled ? 1 : 0,
      am: a.ammo,
      ms: a.missiles,
      fl: a.flares,
      ht: Math.round(a.heat * 100) / 100,
      oh: a.overheated ? 1 : 0,
      fi: a.firing ? 1 : 0,
      lk: Math.round(a.lockProgress * 100) / 100,
      lt: a.lockTargetId || 0,
      lb: a.lockedBy || 0,
      // 近地屏蔽：mc = 视锥内最优目标（即使锁不上也要告诉客户端，好画提示框）
      //          mr = 锁不上的原因（0 无 / 1 地形遮挡 / 2 目标贴地杂波）
      mc: a.lockCandId || 0,
      mr: a.lockReason || 0,
      // 发现位掩码：bit0=蓝队看得见  bit1=红队看得见（队友看到即共享）
      sp: spotMask(a),
      // 操纵面偏度：客户端回放预测需要从快照时刻的舵面状态继续，否则回滚会出现姿态跳变
      c: [r2(a.ctl ? a.ctl.r : 0), r2(a.ctl ? a.ctl.p : 0), r2(a.ctl ? a.ctl.y : 0), r2(a.ctl ? a.ctl.d : 0)],
      // 航母甲板状态：客户端预测必需。服务端钩住阻拦索后会急速减速，
      // 若不下发这些位，客户端本地仍按"满推力滑跑"预测，两边状态脱节。
      // 位0 = 在甲板上，位1 = 已钩住索，位2 = 已停稳，位3 = 弹射中，位4 = 甲板牵引中
      // dk = 钩住的索序号(1~3)
      dkf: (a.onDeck ? 1 : 0) | (a.wireCaught ? 2 : 0) | (a.deckStopped ? 4 : 0)
        | (a.catActive ? 8 : 0) | (a.taxiActive ? 16 : 0),
      dk: a.wireCaught ? (a.wireIdx + 1) : 0,
      rsp: (!a.alive && p) ? Math.max(0, Math.round((p.respawnAt - world.time) * 10) / 10) : 0
    });
  }
  for (const m of world.missiles) {
    snap.m.push({
      i: m.id, o: m.owner, tm: m.team,
      p: [r2(m.pos.x), r2(m.pos.y), r2(m.pos.z)],
      d: [r4(m.dir.x), r4(m.dir.y), r4(m.dir.z)],
      s: Math.round(m.speed),
      sp: m.spoofId ? 1 : 0,
      b: m.dumb ? 1 : 0          // 1 = 导引头已被近地屏蔽压死（哑弹直飞）
    });
  }
  for (const f of world.flares) {
    snap.f.push({ i: f.id, tm: f.team, p: [r2(f.pos.x), r2(f.pos.y), r2(f.pos.z)] });
  }
  world.events = [];
  return snap;
}

function broadcast() {
  io.emit('snap', buildSnapshot());
}

// =============================================================================
// === Socket.IO 连接 ==========================================================
// =============================================================================
io.on('connection', (socket) => {
  if (activeHumans().length >= CONFIG.net.maxPlayers) {
    socket.emit('full', { max: CONFIG.net.maxPlayers });
    socket.disconnect(true);
    return;
  }

  const p = {
    id: world.nextPlayerId++,
    socket,
    name: '飞行员',
    team: pickTeam(),
    connected: true,
    bot: false,
    vehicle: 'plane',          // 兵种：plane / plane:bomber / ship:bb / ship:ca / ship:dd
    input: FP.normalizeInput({}),
    shipInput: null,           // 战舰操控意图
    prevMissile: false,
    prevFlare: false,
    aircraft: null,
    ship: null,
    respawnAt: 0,
    spawnCount: 0,
    ping: 0,
    kills: 0, deaths: 0, crashes: 0, landings: 0, takeoffs: 0, score: 0, assists: 0,
    joinedAt: world.time
  };
  p.name = makeName();
  world.players.set(p.id, p);

  socket.emit('welcome', {
    id: p.id,
    name: p.name,
    team: p.team,
    teamName: TEAM_NAME[p.team],
    maxPlayers: CONFIG.net.maxPlayers,
    airports: AIRPORTS,
    time: world.time,
    score: world.teamScore,
    timeLeft: timeLeft(),
    bots: activePlayers().length - activeHumans().length
  });
  pushEvent({ k: 'join', id: p.id, n: p.name, tm: p.team });
  spawnPlayer(p);
  console.log('[join] #' + p.id + ' ' + p.name + ' → ' + TEAM_NAME[p.team] + '（真人 ' + activeHumans().length + ' / 场上 ' + activePlayers().length + '）');

  // 客户端控制意图（30~60Hz）
  socket.on('input', (data) => {
    if (!data || typeof data !== 'object') return;
    // 战舰玩家：意图包分开存（舰船物理由 stepNaval 消费，不走飞机 normalizeInput）
    if (p.ship) {
      // 战舰输入包：字段必须做有限性校验。
      // 客户端在"服务端已把舰分配给我、但客户端还不知道 myShipId"的几十毫秒里，
      // 仍会发飞机格式的包（没有 thr 字段）。如果不校验，undefined → NaN 会污染
      // 舰船物理状态（速度/航向变 NaN 后整艘船就废了，且不可恢复）。
      const num = (v, def, lo, hi) => {
        const n = +v;
        return Number.isFinite(n) ? clamp(n, lo, hi) : def;
      };
      const hasShipFields = (data.thr !== undefined || data.rud !== undefined ||
        data.fireMain !== undefined || data.tX !== undefined || data.dc !== undefined);
      if (!hasShipFields) return;      // 不是战舰包，丢弃（别把飞机包当舰令）
      p.shipInput = {
        throttle: num(data.thr, 2, -1, 3),
        rudder: num(data.rud, 0, -1, 1),
        fireMain: !!data.fireMain,
        targetX: num(data.tX, p.ship.pos.x, -40000, 40000),
        targetZ: num(data.tZ, p.ship.pos.z, -40000, 40000),
        fireTorp: !!data.torp,
        torpDir: num(data.torpDir, 0, -Math.PI * 2, Math.PI * 2),
        dc: !!data.dc
      };
      // 鱼雷是「一次性意图」：客户端高频发包时（每帧一包）真正的 torp=true 那一包
      // 很容易在下一次模拟 tick 之前就被后续的 false 覆盖掉，必须在服务端做锁存。
      if (data.torp) {
        p.shipTorpQueued = true;
        p.shipTorpDir = num(data.torpDir, 0, -Math.PI * 2, Math.PI * 2);
      }
      // 弹射/降落等飞机逻辑对战舰玩家无意义，直接返回
      p.input = FP.EMPTY_INPUT;
      if (process.env.SKY_DEV === '1' && p.shipInput.fireTorp) {
        console.log('[ship-torp] #' + p.id + ' 收到发射意图 dir=' + p.shipInput.torpDir.toFixed(2) +
          ' tubes=' + p.ship.torpTubes.map((t) => t.ammo + '/' + t.reload.toFixed(0)).join(','));
      }
      if (process.env.SKY_DEV === '1' && (!p._dbgShipIn || world.time - p._dbgShipIn > 2)) {
        p._dbgShipIn = world.time;
        console.log('[ship-in] #' + p.id + ' thr=' + p.shipInput.throttle + ' rud=' + p.shipInput.rudder.toFixed(2) +
          ' fire=' + p.shipInput.fireMain + ' torp=' + p.shipInput.fireTorp + ' dir=' + p.shipInput.torpDir.toFixed(2) +
          ' tubes=' + p.ship.torpTubes.map((t) => t.ammo + '/' + t.reload.toFixed(0)).join(','));
      }
      return;
    }
    p.input = FP.normalizeInput(data);
    // 弹射请求（一次性动作，走 input 包一起上行，避免多开一路事件）
    if (data.cat && p.aircraft) tryCatapult(p, p.aircraft);
    // ---- 轰炸机反舰武器投放（一次性意图）----
    if (p.aircraft && p.aircraft.alive && p.aircraft.atype === 'bomber') {
      if (data.torp && p.aircraft.torps > 0) {
        const tp = FP.dropTorpedo(p.aircraft, p.input, [], world);
        if (tp) {
          world.torps.push(tp);
          pushEvent({ k: 'torpdrop', id: p.aircraft.id, p: [r2(tp.pos.x), 1, r2(tp.pos.z)] });
        }
      }
      if (data.bomb && p.aircraft.bombs > 0) {
        const b = FP.dropBomb(p.aircraft, p.input, []);
        if (b) {
          world.bombs.push(b);
          pushEvent({ k: 'bombdrop', id: p.aircraft.id, p: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)] });
        }
      }
    }
  });

  // 换乘：飞机 ↔ 战舰，或换舰种（重生时生效）
  socket.on('vehicle', (v) => {
    const ok = ['plane', 'plane:bomber', 'ship:bb', 'ship:ca', 'ship:dd'];
    console.log('[vehicle] #' + p.id + ' 收到: ' + JSON.stringify(v));
    if (!v || ok.indexOf(v) < 0) return;
    p.vehicle = v;
    // 释放当前战舰（交还 AI）
    if (p.ship) { p.ship.ownerId = 0; p.ship.ai = true; p.ship = null; }
    // 立即重生为所选兵种
    if (p.aircraft) {
      const idx = world.aircraft.indexOf(p.aircraft);
      if (idx >= 0) world.aircraft.splice(idx, 1);
      p.aircraft = null;
    }
    p.respawnAt = world.time;
    p.spawnCount = (p.spawnCount || 0);
  });

  // 改名
  socket.on('rename', (raw) => {
    const n = sanitizeName(raw);
    if (!n) return;
    p.name = n;
    if (p.aircraft) p.aircraft.name = n;
    socket.emit('renamed', n);
    pushEvent({ k: 'msg', t: p.name + ' 加入战场' });
  });

  // ---- 开发调试通道（仅 SKY_DEV=1 时挂载，生产默认关闭）----
  // 用途：自动化测试把飞机直接放到指定位置/姿态，省去长距离转场飞行。
  if (process.env.SKY_DEV === '1') {
    socket.on('dev', (d) => {
      const a = p.aircraft;
      if (!a || !a.alive || !d || typeof d !== 'object') return;
      if (d.k === 'place') {
        a.pos = { x: +d.x || 0, y: +d.y || 200, z: +d.z || 0 };
        const yaw = +d.yaw || 0, pit = +d.pitch || 0, rol = +d.roll || 0;
        a.quat = FP.quatFromYPR(yaw, pit, rol);
        const spd = +d.speed || 0;
        if (d.dir) {
          a.vel = { x: d.dir[0] * spd, y: d.dir[1] * spd, z: d.dir[2] * spd };
        } else {
          const f = FP.Q.rotate(a.quat, { x: 0, y: 0, z: -1 });
          a.vel = { x: f.x * spd, y: f.y * spd, z: f.z * spd };
        }
        // onGround 决定走 groundStep 还是 airStep：
        // 显式给 onGround 就照办；否则按高度判断（甲板上/地面附近算在地面）
        const onDeck = FP.carrierAt(a.pos.x, a.pos.z, 1.2);
        if (d.onGround !== undefined) a.onGround = !!d.onGround;
        else a.onGround = !!onDeck || a.pos.y <= (FP.CARRIER.y + 3);
        a.airborne = !a.onGround;
        a.wreck = false; a.alive = true; a.deathDone = false; a.out = 0;
        a.gYaw = yaw; a.gPitch = pit; a.gRoll = rol;
        a.speed = spd;
        if (+d.throttle >= 0) a.throttle = +d.throttle;
        if (d.gear !== undefined) a.gear = !!d.gear;
        a.catActive = false;         // 传送后清掉未完成的弹射
        a.serviced = false;
        a.deckStopped = false;
        a.wireCaught = false;
        a.wirePrevAlong = undefined;
        if (d.throttle !== undefined && +d.throttle >= 0) a.throttle = +d.throttle;
      }
    });
  }

  // RTT 测量
  socket.on('ping', (payload, ack) => {
    if (typeof ack === 'function') ack(payload);
    else socket.emit('pong', payload);
  });

  socket.on('disconnect', (reason) => {
    p.connected = false;
    // 释放名下战舰（交还 AI，否则舰队会被离线玩家锁死）
    if (p.ship) { p.ship.ownerId = 0; p.ship.ai = true; p.ship = null; }
    if (p.aircraft) {
      const idx = world.aircraft.indexOf(p.aircraft);
      if (idx >= 0) world.aircraft.splice(idx, 1);
      if (p.aircraft.alive) {
        p.aircraft.alive = false;
        p.aircraft.wreck = true;
        pushBoom(p.aircraft.pos, 1.2, 'crash');
      }
      p.aircraft = null;
    }
    world.players.delete(p.id);
    pushEvent({ k: 'leave', id: p.id, n: p.name });
    console.log('[leave] #' + p.id + ' ' + p.name + ' (' + reason + ')');
  });

  socket.on('error', () => { /* 忽略传输层错误，disconnect 会统一处理 */ });
});

// =============================================================================
// === 机器人初始化 ============================================================
// =============================================================================
const BOT_NAMES = ['AI-猎隼', 'AI-夜枭', 'AI-赤狐', 'AI-苍狼', 'AI-流星', 'AI-海东青'];

function spawnBots() {
  const per = Math.max(0, Math.min(4, CONFIG.bots.countPerTeam | 0));
  if (!per) return;
  for (let team = 0; team < 2; team++) {
    for (let i = 0; i < per; i++) {
      const p = {
        id: world.nextPlayerId++,
        socket: null,
        name: BOT_NAMES[(team * per + i) % BOT_NAMES.length],
        team,
        connected: true,
        bot: true,
        botSkillBias: (Math.random() - 0.5) * 0.12,
        input: FP.normalizeInput({}),
        prevMissile: false,
        prevFlare: false,
        aircraft: null,
        respawnAt: 0,
        spawnCount: 0,
        ping: 0,
        kills: 0, deaths: 0, crashes: 0, landings: 0, takeoffs: 0, score: 0, assists: 0,
        joinedAt: world.time
      };
      world.players.set(p.id, p);
      spawnPlayer(p);
    }
  }
  console.log('[bots] 已加入 ' + (per * 2) + ' 架机器人（每队 ' + per + '）');
}

// =============================================================================
// === 定时循环：固定步长累加器 =================================================
// =============================================================================
let lastMs = Date.now();
let acc = 0;
let snapAcc = 0;

world.matchStart = 0;
initAaas();
initFleets();
spawnBots();

setInterval(() => {
  const now = Date.now();
  let frame = (now - lastMs) / 1000;
  lastMs = now;
  if (frame > 0.25) frame = 0.25;   // 卡顿保护：最多补 0.25 秒
  acc += frame;
  let steps = 0;
  while (acc >= SIM_DT && steps < 8) {
    simulate(SIM_DT);
    acc -= SIM_DT;
    steps++;
    snapAcc += SIM_DT;
    if (snapAcc >= SNAP_DT) {
      snapAcc -= SNAP_DT;
      broadcast();
    }
  }
}, 1000 / CONFIG.net.simHz);

httpServer.listen(PORT, () => {
  console.log('==================================================');
  console.log(' Sky Dogfight 服务器已启动: http://localhost:' + PORT);
  console.log(' 模拟 ' + CONFIG.net.simHz + 'Hz / 广播 ' + CONFIG.net.snapshotHz + 'Hz / 上限 ' + CONFIG.net.maxPlayers + ' 人');
  console.log(' 地图 ' + (CONFIG.world.size / 1000) + 'km x ' + (CONFIG.world.size / 1000) + 'km');
  console.log('==================================================');
});

module.exports = {
  app, httpServer, io, world, CONFIG, FP,
  simulate, killAircraft, damageAircraft, spawnBots, spawnPlayer,
  activePlayers, activeHumans, roster,
  // 供 shots/ 下的自动化测试直接调用（近地屏蔽的可测性）
  updateLocks, losBlocked, clutterFactor, lockRangeFor, groundClearance, updateMissiles
};
