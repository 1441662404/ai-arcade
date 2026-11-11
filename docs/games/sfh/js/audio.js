/**
 * 音效 —— 全部用 WebAudio 实时合成，零音频文件。
 * 这样打包体积为零，也不会因为缺少 mp3 而静音。
 */

let ctx = null;
let master = null;
let enabled = true;
let volume = 0.7;

export function initAudio() {
  if (ctx) return ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch (e) { ctx = null; }
  return ctx;
}

export function resumeAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}
export function setEnabled(v) { enabled = !!v; }
export function audioReady() { return !!ctx; }

/* ---------------- 基础构件 ---------------- */

function noiseBuffer(dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 短促噪声音（枪声主体） */
function burst({ dur = 0.08, freq = 900, q = 1, gain = 0.5, type = 'bandpass', decay = 0.9 } = {}) {
  if (!ctx || !enabled) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur);
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur * decay);
  src.connect(filt).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur);
}

/** 低频「咚」 */
function thump({ freq = 120, dur = 0.16, gain = 0.6, to = 40 } = {}) {
  if (!ctx || !enabled) return;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  osc.connect(g).connect(master);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}

/** 音高扫频 */
function sweep({ from = 400, to = 1200, dur = 0.1, type = 'square', gain = 0.3 } = {}) {
  if (!ctx || !enabled) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), ctx.currentTime + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  osc.connect(g).connect(master);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}

/* ---------------- 具体音效 ---------------- */

const SFX = {
  pistol: () => { burst({ dur: 0.06, freq: 1400, q: 1.4, gain: 0.34 }); thump({ freq: 180, dur: 0.09, gain: 0.24 }); },
  magnum: () => { burst({ dur: 0.11, freq: 800, q: 1.2, gain: 0.55 }); thump({ freq: 90, dur: 0.2, gain: 0.5 }); },
  smg: () => { burst({ dur: 0.045, freq: 1700, q: 1.6, gain: 0.26 }); },
  rifle: () => { burst({ dur: 0.075, freq: 1100, q: 1.3, gain: 0.42 }); thump({ freq: 150, dur: 0.1, gain: 0.3 }); },
  mg: () => { burst({ dur: 0.07, freq: 950, q: 1.1, gain: 0.45 }); thump({ freq: 130, dur: 0.12, gain: 0.36 }); },
  minigun: () => { burst({ dur: 0.05, freq: 1250, q: 1.5, gain: 0.3 }); },
  shotgun: () => {
    burst({ dur: 0.18, freq: 600, q: 0.8, gain: 0.7, type: 'lowpass' });
    thump({ freq: 110, dur: 0.28, gain: 0.6 });
  },
  sniper: () => {
    burst({ dur: 0.2, freq: 500, q: 0.7, gain: 0.7, type: 'lowpass' });
    thump({ freq: 70, dur: 0.34, gain: 0.55 });
    sweep({ from: 2200, to: 200, dur: 0.16, type: 'sawtooth', gain: 0.12 });
  },
  rocket: () => {
    burst({ dur: 0.3, freq: 400, q: 0.6, gain: 0.5, type: 'lowpass' });
    sweep({ from: 900, to: 120, dur: 0.28, type: 'sawtooth', gain: 0.22 });
  },
  railgun: () => {
    sweep({ from: 3200, to: 400, dur: 0.28, type: 'sawtooth', gain: 0.4 });
    sweep({ from: 1200, to: 80, dur: 0.3, type: 'square', gain: 0.2 });
    thump({ freq: 60, dur: 0.4, gain: 0.4 });
  },
  slash: () => { sweep({ from: 1800, to: 300, dur: 0.12, type: 'sawtooth', gain: 0.26 }); },
  shield: () => { thump({ freq: 260, dur: 0.1, gain: 0.3, to: 120 }); },
  dash: () => {
    sweep({ from: 1400, to: 300, dur: 0.16, type: 'triangle', gain: 0.3 });
    burst({ dur: 0.14, freq: 900, q: 0.9, gain: 0.22, type: 'lowpass' });
  },
  smoke: () => {
    burst({ dur: 0.42, freq: 320, q: 0.5, gain: 0.34, type: 'lowpass' });
    thump({ freq: 90, dur: 0.3, gain: 0.2, to: 50 });
  },

  reload: () => {
    // 两声「咔哒」
    setTimeout(() => sweep({ from: 900, to: 600, dur: 0.035, type: 'square', gain: 0.14 }), 0);
    setTimeout(() => sweep({ from: 700, to: 480, dur: 0.045, type: 'square', gain: 0.16 }), 180);
  },
  hit: () => { sweep({ from: 500, to: 900, dur: 0.05, type: 'square', gain: 0.18 }); },
  headshot: () => {
    sweep({ from: 1100, to: 2000, dur: 0.07, type: 'square', gain: 0.3 });
    thump({ freq: 300, dur: 0.08, gain: 0.24 });
  },
  kill: () => {
    sweep({ from: 600, to: 1200, dur: 0.12, type: 'square', gain: 0.34 });
    setTimeout(() => sweep({ from: 900, to: 1500, dur: 0.1, type: 'square', gain: 0.24 }), 90);
  },
  death: () => {
    sweep({ from: 600, to: 60, dur: 0.5, type: 'sawtooth', gain: 0.4 });
    thump({ freq: 90, dur: 0.5, gain: 0.4 });
  },
  explode: () => {
    burst({ dur: 0.5, freq: 300, q: 0.5, gain: 0.8, type: 'lowpass' });
    thump({ freq: 60, dur: 0.6, gain: 0.7 });
  },
  pickup: () => {
    sweep({ from: 700, to: 1300, dur: 0.12, type: 'sine', gain: 0.26 });
    setTimeout(() => sweep({ from: 1000, to: 1700, dur: 0.1, type: 'sine', gain: 0.22 }), 90);
  },
  skill: () => {
    sweep({ from: 300, to: 1600, dur: 0.3, type: 'sawtooth', gain: 0.34 });
    sweep({ from: 200, to: 800, dur: 0.4, type: 'sine', gain: 0.24 });
  },
  spawn: () => { sweep({ from: 400, to: 900, dur: 0.2, type: 'sine', gain: 0.22 }); },
  uiClick: () => { sweep({ from: 800, to: 1200, dur: 0.04, type: 'square', gain: 0.16 }); },
  uiHover: () => { sweep({ from: 600, to: 800, dur: 0.03, type: 'sine', gain: 0.1 }); },
  victory: () => {
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => sweep({ from: f, to: f * 1.02, dur: 0.28, type: 'square', gain: 0.28 }), i * 150);
    });
  },
  defeat: () => {
    [392, 330, 262, 196].forEach((f, i) => {
      setTimeout(() => sweep({ from: f, to: f * 0.98, dur: 0.32, type: 'sawtooth', gain: 0.26 }), i * 180);
    });
  },
  countdown: () => { sweep({ from: 900, to: 900, dur: 0.1, type: 'square', gain: 0.24 }); },
};

export function play(name) {
  if (!ctx || !enabled) return;
  const fn = SFX[name];
  if (fn) { try { fn(); } catch (e) { /* ignore */ } }
}

/** 按距离衰减地播放世界音效 */
export function playAt(name, dist, maxDist = 1400) {
  if (!ctx || !enabled) return;
  if (dist > maxDist) return;
  const k = 1 - dist / maxDist;
  const before = volume;
  master.gain.value = volume * (0.15 + 0.85 * k * k);
  play(name);
  // 立刻恢复（play 内部是同步创建节点，gain 已采样）
  master.gain.value = before;
}
