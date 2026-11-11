/**
 * 客户端本地预测
 * ------------------------------------------------------------------
 * 为什么需要它：服务端 20Hz 下发快照，如果直接照搬，玩家操作会有一帧一帧的拖拽感。
 *
 * 做法：
 *   1. 本地用同一份 sim 的移动函数按 60Hz 推演「我」的位置（纯预测）
 *   2. 收到服务端快照时，若预测与服务端偏差超过阈值，就把位置拉回服务端值
 *      （小偏差不拉，避免网络抖动导致画面抽搐）
 *   3. 其他人的位置一律用插值，不做预测
 */

import { PHYS, KEY } from '../shared/constants.js';
import { stepPlayerMovement } from '../shared/sim.js';

const MAX_CORRECTION = 90;      // 单帧最大校正距离（超过就瞬移，说明被打断/复活）
const SOFT_THRESHOLD = 14;      // 小于这个偏差不校正（容忍抖动）
const SOFT_RATE = 0.22;         // 软校正的每帧吸收比例

export class Predictor {
  constructor() {
    this.enabled = true;
    this.err = 0;
    this.lastServer = null;
  }

  /**
   * 用本地输入推演一帧。
   * @param p 本地玩家状态（从快照同步来的基准）
   * @param keys 按键掩码
   * @param aim 瞄准角
   * @param world 本地世界（提供 solids/plats）
   * @param dt 帧时间
   */
  step(p, keys, aim, world, dt) {
    if (!p || !p.alive) return;
    const steps = Math.min(3, Math.max(1, Math.round(dt / (1 / 60))));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      stepPlayerMovement(p, keys, sub, world.solids, world.plats, p.speedMul || 1);
    }
    p.aim = aim;
  }

  /** 收到服务端快照后校正 */
  reconcile(p, serverState) {
    if (!p || !serverState) return;
    this.lastServer = serverState;
    const dx = serverState.x - p.x;
    const dy = serverState.y - p.y;
    const d = Math.hypot(dx, dy);
    this.err = d;

    if (d > MAX_CORRECTION) {
      // 大偏差：直接接受（复活、传送、被击退）
      p.x = serverState.x;
      p.y = serverState.y;
      p.vx = 0;
      p.vy = 0;
      p.bh = serverState.bh || p.bh;
      p.onGround = false;
      return;
    }
    if (d > SOFT_THRESHOLD) {
      // 小偏差：平滑吸收，避免画面抽搐
      p.x += dx * SOFT_RATE;
      p.y += dy * SOFT_RATE;
    }
  }
}

/** 输入采集 */
export class Input {
  constructor(canvas) {
    this.keys = 0;
    this.aim = 0;
    this.mouse = { x: 0, y: 0, down: false };
    this.seq = 0;
    this.canvas = canvas;
    this.onKeyExtra = null;

    window.addEventListener('keydown', (e) => this.onDown(e));
    window.addEventListener('keyup', (e) => this.onUp(e));
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => { this.keys = 0; this.mouse.down = false; });
  }

  onDown(e) {
    // 防止空格滚动页面
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': this.keys |= KEY.LEFT; break;
      case 'KeyD': case 'ArrowRight': this.keys |= KEY.RIGHT; break;
      case 'KeyW': case 'ArrowUp': case 'Space': this.keys |= KEY.UP; break;
      case 'KeyS': case 'ArrowDown': this.keys |= KEY.DOWN; break;
      case 'KeyR': this.keys |= KEY.RELOAD; break;
      case 'KeyQ': case 'ShiftLeft': this.keys |= KEY.SWITCH; break;
      case 'KeyE': case 'ControlLeft': this.keys |= KEY.SKILL; break;
      default: break;
    }
    if (this.onKeyExtra) this.onKeyExtra(e);
  }

  onUp(e) {
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': this.keys &= ~KEY.LEFT; break;
      case 'KeyD': case 'ArrowRight': this.keys &= ~KEY.RIGHT; break;
      case 'KeyW': case 'ArrowUp': case 'Space': this.keys &= ~KEY.UP; break;
      case 'KeyS': case 'ArrowDown': this.keys &= ~KEY.DOWN; break;
      case 'KeyR': this.keys &= ~KEY.RELOAD; break;
      case 'KeyQ': case 'ShiftLeft': this.keys &= ~KEY.SWITCH; break;
      case 'KeyE': case 'ControlLeft': this.keys &= ~KEY.SKILL; break;
      default: break;
    }
  }

  onMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
  }

  onMouseDown(e) {
    if (e.button === 0) { this.mouse.down = true; this.keys |= KEY.SHOOT; }
  }

  onMouseUp(e) {
    if (e.button === 0) { this.mouse.down = false; this.keys &= ~KEY.SHOOT; }
  }

  /** 屏幕坐标 → 世界瞄准角 */
  computeAim(player, renderer) {
    if (!player) return 0;
    const scale = renderer.cam.w / (renderer.viewW || renderer.cam.w);
    const wx = renderer.cam.x + this.mouse.x / scale;
    const wy = renderer.cam.y + this.mouse.y / scale;
    const px = player.x + PHYS.W / 2;
    const py = player.y + player.bh * 0.32;
    return Math.atan2(wy - py, wx - px);
  }

  snapshot() {
    return { k: this.keys, a: this.aim, s: ++this.seq };
  }
}
