/**
 * 联机客户端：WebSocket + 快照插值
 * 与服务端约定：只上报 {k: 按键位掩码, a: 瞄准角}，其余一切由服务端裁决。
 */
export class Net {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.latency = 0;
    this.handlers = new Map();
    this.buffers = new Map();     // id -> [{t, x, y, ...}]
    this.lastSnap = null;
    this.self = null;
    this.room = null;
    this.url = null;
    this.reconnectTries = 0;
    this._pingTimer = null;
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
    this.url = url || this.defaultUrl();
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) { reject(e); return; }

      const timeout = setTimeout(() => {
        if (!done) { done = true; reject(new Error('连接超时')); }
      }, 8000);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectTries = 0;
        clearTimeout(timeout);
        if (!done) { done = true; resolve(); }
        this.startPing();
      };
      this.ws.onerror = (e) => {
        if (!done) { done = true; clearTimeout(timeout); reject(e); }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.stopPing();
        this.emit('close');
      };
      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.handle(m);
      };
    });
  }

  defaultUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // 门户会把 WebSocket 自动改写前缀，这里直接用当前 host
    return `${proto}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`;
  }

  handle(m) {
    switch (m.t) {
      case 'welcome':
        this.id = m.id;
        this.emit('welcome', m);
        break;
      case 'pong':
        this.latency = Math.max(0, Date.now() - m.ts);
        break;
      case 'snap':
        this.ingest(m);
        this.lastSnap = m;
        this.self = m.self || this.self;
        this.emit('snap', m);
        break;
      case 'rooms':
      case 'room':
        this.room = m.room || this.room;
        this.emit(m.t, m);
        break;
      default:
        this.emit(m.t, m);
    }
  }

  ingest(m) {
    const now = performance.now();
    const live = new Set();
    for (const p of m.ps) {
      if (p.i === this.id) continue;
      live.add(p.i);
      let buf = this.buffers.get(p.i);
      if (!buf) { buf = []; this.buffers.set(p.i, buf); }
      buf.push({
        t: now,
        x: p.x, y: p.y, a: p.ai, f: p.f, c: p.c,
        h: p.h, al: p.a, r: p.r, sk: p.sk, sg: p.sg, ch: p.ch,
        w: p.w, k: p.k, n: p.n, b: p.b, t2: p.t,
      });
      if (buf.length > 30) buf.shift();
    }
    for (const id of this.buffers.keys()) {
      if (!live.has(id)) this.buffers.delete(id);
    }
  }

  /** 取某玩家在 now 的插值状态（延迟 100ms 播放，抵消网络抖动） */
  sample(id, delay = 100) {
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
          a: lerpAngle(a.a, b.a, k),
          f: b.f, c: b.c, h: b.h, al: b.al,
          r: b.r, sk: b.sk, sg: b.sg, ch: b.ch,
          w: b.w, k: b.k, n: b.n, b: b.b, t2: b.t2,
        };
      }
    }
    return buf[buf.length - 1];
  }

  startPing() {
    this.stopPing();
    this._pingTimer = setInterval(() => {
      if (this.connected) this.send({ t: 'ping', ts: Date.now() });
    }, 2000);
  }
  stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  close() {
    this.stopPing();
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    this.connected = false;
  }
}

export function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
