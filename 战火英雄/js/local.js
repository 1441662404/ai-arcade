/**
 * LocalNet —— 浏览器内的「假服务端」
 *
 * 目的：让战火英雄在纯静态环境下单机可玩。
 *
 * 原理：客户端与服务端本来就共用 shared/sim.js（World）与 shared/ai.js（botThink），
 * 服务端做的事只有三件 —— 建 world、塞 bot、每帧 step。
 * 这里把这三件事搬到浏览器主线程，接口与 js/net.js 的 Net 保持一致，
 * 因此 main.js 的消息流程一行都不用改。
 *
 * 与联机模式的唯一差别：不发快照。本地 step 直接就是权威状态。
 */
import { World } from '../shared/sim.js';
import { initBot, botThink, botName, resetBotNames } from '../shared/ai.js';
import { DT, MAX_PLAYERS, CLASS_LIST } from '../shared/constants.js';

export class LocalNet {
  constructor(opts = {}) {
    this.connected = true;
    this.id = opts.playerId || ('local_' + Math.random().toString(36).slice(2, 8));
    this.latency = 0;
    this.handlers = new Map();
    this.room = null;
    this.world = null;
    this.running = false;
    this._acc = 0;
    this._last = 0;
    this._raf = null;
    this._opts = opts;
  }

  /* ---------- 与 Net 一致的对外接口 ---------- */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const arr = this.handlers.get(type);
    if (arr) for (const fn of arr) fn(data);
  }

  connect() {
    /* 立刻视为已连接，并回一条 welcome（客户端靠它拿 id） */
    setTimeout(() => this.emit('welcome', { id: this.id, st: Date.now() }), 20);
    return Promise.resolve();
  }

  close() { this._stop(); this.connected = false; }

  send(msg) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case 'create': this._create(msg); break;
      case 'start': this._start(); break;
      case 'in': this._input(msg); break;
      case 'leave': this._leave(); break;
      case 'restart': this._restart(); break;
      case 'chat': /* 单机无聊天 */ break;
      default: break;
    }
  }

  /* ---------- 客户端建好 world 后接管 ---------- */
  adoptWorld(world) {
    if (!world) return;
    this.world = world;

    /* 脚本自己必须在场 */
    if (!world.players.has(this.id)) {
      world.addPlayer({
        id: this.id,
        name: this._opts.name || '士兵',
        cls: this._opts.cls || 'assault',
        team: 'blue',
        isBot: false,
      });
    }
    this._fillBots();

    /* 首次接管即开跑；重开局时 world 对象不变，继续沿用现有循环 */
    if (!this.running) this._start();
  }

  /* ---------- 房间 ---------- */
  _create(msg) {
    const mode = msg.mode || 'tdm';
    const mapId = msg.map || 'labs';
    this.room = {
      id: 'LOCAL',
      name: msg.name || '本地战局',
      mode,
      map: mapId,
      level: msg.level || null,
      max: Math.min(MAX_PLAYERS, Number(msg.max) || 12),
      diff: Math.max(1, Math.min(5, Number(msg.difficulty) || 3)),
      fillBots: msg.fillBots !== false,
      botTarget: Math.min(MAX_PLAYERS - 1, Number(msg.botCount) || 6),
      host: this.id,
      players: [{ id: this.id, name: this._opts.name || '士兵', team: 'blue', ready: true }],
    };
    /* 客户端 UI 依赖 room 消息切到大厅 */
    setTimeout(() => this.emit('room', { room: this.room }), 30);
  }

  _start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._acc = 0;
    this.emit('start', { roomId: this.room ? this.room.id : 'LOCAL' });
    this._loop();
  }

  _leave() {
    this._stop();
    this.emit('left', {});
  }

  _restart() {
    if (this.world && typeof this.world.restart === 'function') this.world.restart();
  }

  _stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  /* ---------- 输入 ---------- */
  _input(msg) {
    const w = this.world;
    if (!w) return;
    const me = w.players.get(this.id);
    if (!me) return;
    me.keys = msg.k || 0;
    if (typeof msg.a === 'number') me.aim = msg.a;
  }

  /* ---------- 补 bot ---------- */
  _fillBots() {
    const w = this.world;
    const r = this.room;
    if (!w || !r || !r.fillBots) return;

    if (r.mode === 'campaign') {
      /* 战役：只补给蓝队队友，红方由波次系统吐 */
      const allies = w.list.filter((p) => p.isBot && p.team === 'blue');
      const want = Math.max(0, Math.min(4, r.botTarget));
      for (let i = allies.length; i < want; i++) {
        const cls = CLASS_LIST[Math.floor(Math.random() * CLASS_LIST.length)];
        const p = w.addPlayer({ id: 'a_' + Math.random().toString(36).slice(2, 8), name: botName(), cls, team: 'blue', isBot: true });
        initBot(p, r.diff);
      }
      return;
    }

    const cap = r.max;
    const want = Math.min(r.botTarget, Math.max(0, cap - 1));
    let have = w.list.filter((p) => p.isBot).length;
    while (have > want) {
      const victim = w.list.filter((p) => p.isBot).pop();
      if (!victim) break;
      w.removePlayer(victim.id);
      have--;
    }
    while (have < want) {
      const team = have % 2 === 0 ? 'red' : 'blue';
      const cls = CLASS_LIST[Math.floor(Math.random() * CLASS_LIST.length)];
      const p = w.addPlayer({ id: 'b_' + Math.random().toString(36).slice(2, 8), name: botName(), cls, team, isBot: true });
      initBot(p, r.diff);
      have++;
    }
  }

  /* ---------- 主循环（60Hz 固定步长） ---------- */
  _loop() {
    if (!this.running) return;
    const now = performance.now();
    let elapsed = (now - this._last) / 1000;
    this._last = now;
    if (elapsed > 0.25) elapsed = 0.25;
    this._acc += elapsed;

    let steps = 0;
    while (this._acc >= DT && steps < 5) {
      this._step();
      this._acc -= DT;
      steps++;
    }
    if (steps >= 5) this._acc = 0;

    this._raf = requestAnimationFrame(() => this._loop());
  }

  _step() {
    const w = this.world;
    if (!w) return;
    w.botThink = botThink;
    if (typeof w.clearEvents === 'function') w.clearEvents();
    w.step();
    if (typeof w.needsRestart === 'function' && w.needsRestart()) w.restart();
  }
}
