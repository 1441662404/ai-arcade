/**
 * 山路傳說 — 聯機伺服器
 * 零依賴：靜態檔案 + 自製 WebSocket（RFC6455）
 * 啟動：node server.js  （預設 http://localhost:8787）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

/* ------------------------------------------------------------------ */
/*  靜態檔案                                                          */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
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
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.glb' ? 'public, max-age=86400' : 'no-cache',
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ------------------------------------------------------------------ */
/*  最小 WebSocket 實作                                                */
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
        if (!fin) { /* 本遊戲訊息皆為單幀，忽略續傳 */ }
      }
    }
  }
  _frame(opcode, payload) {
    if (!this.alive || this.socket.destroyed) return;
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
    id: crypto.randomBytes(4).toString('hex'),
    ws,
    name: '車手',
    carId: 'fr86',
    room: null,
    ready: false,
    last: null,
    finished: false,
  };
  ws.onmessage = (raw) => handle(client, raw);
  ws.onclose = () => leaveRoom(client, true);
  ws.send({ t: 'welcome', id: client.id, serverTime: Date.now() });
});

/* ------------------------------------------------------------------ */
/*  房間                                                               */
/* ------------------------------------------------------------------ */
const rooms = new Map(); // id -> {id,name,host,players:Set,state,createdAt,max}

function roomSnapshot(room) {
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    state: room.state,
    max: room.max,
    players: [...room.players].map((p) => ({
      id: p.id,
      name: p.name,
      carId: p.carId,
      ready: p.ready,
      finished: p.finished,
    })),
  };
}

function roomsList() {
  return [...rooms.values()]
    .filter((r) => r.players.size > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      count: r.players.size,
      max: r.max,
      state: r.state,
    }));
}

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const p of room.players) if (p !== except) p.ws._frame(0x1, Buffer.from(s, 'utf8'));
}

function leaveRoom(client, silent) {
  const room = client.room;
  if (!room) return;
  room.players.delete(client);
  client.room = null;
  client.ready = false;
  if (room.players.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.host === client.id) room.host = [...room.players][0].id;
    broadcast(room, { t: 'room', room: roomSnapshot(room) });
    broadcast(room, { t: 'leave', id: client.id });
  }
  if (!silent) client.ws.send({ t: 'left' });
}

function handle(client, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;

  switch (m.t) {
    case 'ping':
      client.ws.send({ t: 'pong', ts: m.ts });
      return;

    case 'hello': {
      client.name = String(m.name || '車手').slice(0, 12);
      client.carId = String(m.carId || 'fr86').slice(0, 16);
      // 只在第一次握手時回 welcome，避免客戶端把 hello 綁在 welcome 上造成互相觸發的死循環
      if (!client.helloed) {
        client.helloed = true;
        client.ws.send({ t: 'welcome', id: client.id, serverTime: Date.now() });
      }
      client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'list':
      client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;

    case 'create': {
      leaveRoom(client, true);
      const id = crypto.randomBytes(3).toString('hex').toUpperCase();
      const room = {
        id,
        name: String(m.name || '霧見山夜戰').slice(0, 20),
        host: client.id,
        players: new Set(),
        state: 'lobby',
        max: Math.min(8, Math.max(2, Number(m.max) || 8)),
        createdAt: Date.now(),
      };
      rooms.set(id, room);
      room.players.add(client);
      client.room = room;
      client.ready = false;
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      broadcast(room, { t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'join': {
      const room = rooms.get(String(m.id || '').toUpperCase());
      if (!room) { client.ws.send({ t: 'error', msg: '房間不存在' }); return; }
      if (room.players.size >= room.max) { client.ws.send({ t: 'error', msg: '房間已滿' }); return; }
      leaveRoom(client, true);
      room.players.add(client);
      client.room = room;
      client.ready = false;
      client.finished = false;
      broadcast(room, { t: 'room', room: roomSnapshot(room) });
      broadcast(room, { t: 'rooms', rooms: roomsList() });
      return;
    }

    case 'leave':
      leaveRoom(client, false);
      client.ws.send({ t: 'rooms', rooms: roomsList() });
      return;

    case 'car':
      if (client.room) {
        client.carId = String(m.carId || client.carId).slice(0, 16);
        broadcast(client.room, { t: 'room', room: roomSnapshot(client.room) });
      }
      return;

    case 'ready':
      client.ready = !!m.v;
      if (client.room) broadcast(client.room, { t: 'room', room: roomSnapshot(client.room) });
      return;

    case 'start': {
      const room = client.room;
      if (!room || room.host !== client.id) return;
      room.state = 'race';
      for (const p of room.players) { p.finished = false; p.ready = false; }
      broadcast(room, {
        t: 'start',
        seed: Math.floor(Math.random() * 1e9),
        startAt: Date.now() + 4200,
        serverTime: Date.now(),
      });
      return;
    }

    case 'state': {
      const room = client.room;
      if (!room) return;
      client.last = {
        p: [round(m.p?.[0]), round(m.p?.[1]), round(m.p?.[2])],
        q: round(m.q),
        v: round(m.v, 1),
        s: round(m.s, 2),
        g: m.g | 0,
        r: Math.round(m.r || 0),
        d: Math.round(m.d || 0),
        w: m.w | 0,
      };
      return;
    }

    case 'finish': {
      const room = client.room;
      if (!room) return;
      client.finished = true;
      broadcast(room, { t: 'finish', id: client.id, name: client.name, time: m.time, best: m.best });
      return;
    }

    case 'chat': {
      const room = client.room;
      if (!room) return;
      broadcast(room, { t: 'chat', id: client.id, name: client.name, msg: String(m.msg).slice(0, 60) });
      return;
    }

    case 'lobby':
      if (client.room) roomStateToLobby(client.room);
      return;
  }
}

function roomStateToLobby(room) {
  room.state = 'lobby';
  for (const p of room.players) { p.ready = false; p.finished = false; p.last = null; }
  broadcast(room, { t: 'room', room: roomSnapshot(room) });
  broadcast(room, { t: 'rooms', rooms: roomsList() });
}

function round(v, k = 2) {
  const p = Math.pow(10, k);
  return Math.round((Number(v) || 0) * p) / p;
}

/* 20Hz 狀態聚合廣播 */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'race') continue;
    const players = [];
    for (const p of room.players) if (p.last) players.push({ id: p.id, ...p.last });
    if (!players.length) continue;
    broadcast(room, { t: 'snap', players, now: Date.now() });
  }
}, 50);

setInterval(() => {
  for (const room of rooms.values()) {
    const s = JSON.stringify(roomsList());
    void s;
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────┐');
  console.log('  │  山路傳說 — 霧見山下坡            │');
  console.log(`  │  本機： http://localhost:${PORT}              │`);
  console.log('  │  區域網： http://<你的內網IP>:' + PORT + '        │');
  console.log('  └───────────────────────────────────────────┘');
  console.log('');
});
