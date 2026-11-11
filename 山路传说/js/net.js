/**
 * 聯機客戶端：WebSocket + 狀態插值
 */
export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.handlers = new Map();
    this.buffers = new Map(); // id -> [{t, x,y,z,q,v,s,g,r,d}]
    this.latency = 0;
    this.serverOffset = 0;
    this.reconnectTimer = null;
    this.url = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const arr = this.handlers.get(type);
    if (arr) for (const fn of arr) fn(data);
  }

  connect(url) {
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      const timeout = setTimeout(() => {
        if (!done) { done = true; reject(new Error('連線逾時')); }
      }, 6000);

      this.ws.onopen = () => {
        this.connected = true;
        clearTimeout(timeout);
        if (!done) { done = true; resolve(); }
        this.pingLoop();
      };
      this.ws.onerror = (e) => {
        if (!done) { done = true; clearTimeout(timeout); reject(e); }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.emit('close');
      };
      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.handle(m);
      };
    });
  }

  handle(m) {
    switch (m.t) {
      case 'welcome':
        this.id = m.id;
        this.serverOffset = m.serverTime - Date.now();
        this.emit('welcome', m);
        break;
      case 'pong':
        this.latency = Date.now() - m.ts;
        break;
      case 'snap':
        this.ingest(m);
        this.emit('snap', m);
        break;
      default:
        this.emit(m.t, m);
    }
  }

  ingest(m) {
    const now = performance.now();
    for (const p of m.players) {
      if (p.id === this.id) continue;
      let buf = this.buffers.get(p.id);
      if (!buf) { buf = []; this.buffers.set(p.id, buf); }
      buf.push({
        t: now,
        x: p.p[0], y: p.p[1], z: p.p[2],
        q: p.q, v: p.v, s: p.s, g: p.g, r: p.r, d: p.d,
      });
      if (buf.length > 24) buf.shift();
    }
    // 清理已離線
    for (const id of this.buffers.keys()) {
      if (!m.players.some((p) => p.id === id)) this.buffers.delete(id);
    }
  }

  /** 取得某玩家在 now 的插值狀態（延遲 100ms 播放） */
  sample(id, delay = 110) {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;
    const t = performance.now() - delay;
    if (buf.length === 1) return buf[0];
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].t <= t && buf[i].t >= t) {
        const a = buf[i - 1], b = buf[i];
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
          q: lerpAngle(a.q, b.q, k),
          v: a.v + (b.v - a.v) * k,
          s: a.s + (b.s - a.s) * k,
          g: b.g,
          r: a.r + (b.r - a.r) * k,
          d: b.d,
        };
      }
    }
    return buf[buf.length - 1];
  }

  pingLoop() {
    clearInterval(this._ping);
    this._ping = setInterval(() => {
      if (this.connected) this.send({ t: 'ping', ts: Date.now() });
    }, 2500);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    clearInterval(this._ping);
    if (this.ws) this.ws.close();
  }
}

function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
