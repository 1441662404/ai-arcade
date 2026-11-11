/* =============================================================================
 * Nbike · js/audio.js
 * 程序化音效（Web Audio 合成，零素材文件）
 *
 * 内容：
 *   · 链条声   —— 随速度/踏频变化的连续摩擦声（带通噪声 + 齿节脉冲）
 *   · 换挡声   —— 每次换挡"咔哒"一声（短促噪声爆发 + 金属泛音）
 *   · 风噪     —— 速度越快越响（补足"速度感"的听觉层）
 *   · 得分音   —— 踩对/踩错的短提示音
 *
 * ★ 关键约定（改动前必看）
 *   1. AudioContext 必须在【用户手势】里创建/恢复，否则浏览器禁止播放。
 *      这里用 `unlock()`，在第一次 keydown/pointerdown 时调用。
 *   2. 所有持续音（链条/风噪）用一个常驻的 GainNode 控制音量，
 *      **不要每帧新建节点** —— 会疯狂吃 CPU 并造成 GC 卡顿。
 *   3. 音量为 0 时要把节点挂起（或把 gain 设 0），避免空跑。
 * ========================================================================== */

const A = {
  ctx: null,
  ready: false,
  master: null,
  // 常驻节点
  chainGain: null, chainFilter: null, chainSrc: null,
  windGain: null, windFilter: null, windSrc: null,
  // 状态
  enabled: true,
  vol: 0.5,
  lastShiftAt: 0,
  chainRattleAt: 0
};

/** 在用户手势中调用一次，创建/恢复 AudioContext */
export function unlock() {
  if (A.ctx) {
    if (A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    A.ctx = new AC();
  } catch (e) {
    return;
  }
  const ctx = A.ctx;

  A.master = ctx.createGain();
  A.master.gain.value = A.vol;
  A.master.connect(ctx.destination);

  /* ---------- 噪声源（共用一份 2s 循环白噪声） ---------- */
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noiseBuf = buf;

  function makeNoise() {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    return s;
  }

  /* ---------- 链条 / 传动声 ----------
   * 真实链条声 ≈ 高频"沙沙"的齿节摩擦 + 低频传动箱共鸣。
   * 用 bandpass 扫频模拟踏频变化，volume 随速度上升。 */
  const chainSrc = makeNoise();
  const chainBP = ctx.createBiquadFilter();
  chainBP.type = 'bandpass';
  chainBP.frequency.value = 1800;
  chainBP.Q.value = 1.6;
  const chainHP = ctx.createBiquadFilter();
  chainHP.type = 'highpass';
  chainHP.frequency.value = 700;
  const chainG = ctx.createGain();
  chainG.gain.value = 0;
  chainSrc.connect(chainBP);
  chainBP.connect(chainHP);
  chainHP.connect(chainG);
  chainG.connect(A.master);
  chainSrc.start();
  A.chainSrc = chainSrc; A.chainFilter = chainBP; A.chainGain = chainG;

  /* ---------- 风噪 ----------
   * 低速几乎听不到，速度上来后变成"呼呼"的低通噪声。 */
  const windSrc = makeNoise();
  const windLP = ctx.createBiquadFilter();
  windLP.type = 'lowpass';
  windLP.frequency.value = 600;
  windLP.Q.value = 0.7;
  const windG = ctx.createGain();
  windG.gain.value = 0;
  windSrc.connect(windLP);
  windLP.connect(windG);
  windG.connect(A.master);
  windSrc.start();
  A.windSrc = windSrc; A.windFilter = windLP; A.windGain = windG;

  A.ready = true;
}

/** 换挡"咔哒"：短噪声爆发 + 两个金属泛音，模拟链条跳到相邻齿片 */
export function shiftSound(up) {
  if (!A.ready || !A.enabled) return;
  const ctx = A.ctx, t = ctx.currentTime;
  /* 防连发（服务端换挡冷却 0.15s，这里略宽一点） */
  if (t - A.lastShiftAt < 0.09) return;
  A.lastShiftAt = t;

  const dur = 0.09;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const k = 1 - i / d.length;
    d[i] = (Math.random() * 2 - 1) * Math.pow(k, 2.6);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  /* 升挡（更重）音调偏低，降挡（更轻）偏高 */
  bp.frequency.value = up ? 1500 : 2300;
  bp.Q.value = 2.2;
  const g = ctx.createGain();
  g.gain.value = 0.9;
  src.connect(bp); bp.connect(g); g.connect(A.master);
  src.start(t);

  /* 金属泛音：给"咔"加一点硬质感 */
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(up ? 420 : 620, t);
  o.frequency.exponentialRampToValueAtTime(up ? 210 : 310, t + 0.07);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.22, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  o.connect(og); og.connect(A.master);
  o.start(t); o.stop(t + 0.1);
}

/** 踩踏判定提示音（对/错两种，短促不吵） */
export function hitSound(ok) {
  if (!A.ready || !A.enabled) return;
  const ctx = A.ctx, t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(ok ? 880 : 220, t);
  if (ok) o.frequency.exponentialRampToValueAtTime(1320, t + 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(ok ? 0.10 : 0.14, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + (ok ? 0.09 : 0.13));
  o.connect(g); g.connect(A.master);
  o.start(t); o.stop(t + 0.15);
}

/**
 * 每帧更新持续音（链条 / 风噪）
 * @param {number} speed  车速 m/s
 * @param {number} cadence 踏频 rpm
 * @param {boolean} pedaling 是否在发力
 */
export function update(speed, cadence, pedaling) {
  if (!A.ready) return;
  const ctx = A.ctx, t = ctx.currentTime;
  const kmh = speed * 3.6;

  /* 链条：车速 + 踏频共同决定
   *   不发力时链条基本无声（自由轮"哒哒"不算，这里简化为静音）
   *   发力 + 高速 → 明显的沙沙声 */
  const spdN = Math.min(1, kmh / 55);          // 0~1
  const cadN = Math.min(1, Math.max(0, cadence) / 120);
  let chainVol = 0;
  if (pedaling) chainVol = 0.020 + 0.085 * spdN * (0.45 + 0.55 * cadN);
  else chainVol = 0.004 * spdN;                // 滑行时极轻的传动声

  /* 齿节频率随踏频升高：真实链条"尖细"感 */
  const bpHz = 1200 + cadN * 1900;
  A.chainGain.gain.setTargetAtTime(chainVol, t, 0.08);
  A.chainFilter.frequency.setTargetAtTime(bpHz, t, 0.1);

  /* 风噪：速度的三次方更接近真实风阻听感 */
  const windVol = 0.075 * Math.pow(spdN, 2.6);
  A.windGain.gain.setTargetAtTime(windVol, t, 0.12);
  A.windFilter.frequency.setTargetAtTime(420 + spdN * 900, t, 0.12);
}

/** 总音量（0~1） */
export function setVolume(v) {
  A.vol = Math.max(0, Math.min(1, v));
  if (A.master) A.master.gain.setTargetAtTime(A.vol, A.ctx.currentTime, 0.05);
}

/** 静音开关 */
export function setEnabled(on) {
  A.enabled = !!on;
  if (A.ready) {
    A.master.gain.setTargetAtTime(A.enabled ? A.vol : 0, A.ctx.currentTime, 0.05);
  }
}

export function isEnabled() { return A.enabled; }
