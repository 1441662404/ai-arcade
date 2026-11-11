/**
 * 音訊：程序化歐陸節拍 BGM（Eurobeat）+ 引擎、輪胎、風噪
 * 全部即時合成，不依賴外部音檔
 */

const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const freq = (name, oct) => 440 * Math.pow(2, (NOTE[name] + (oct - 4) * 12 - 9) / 12);

/* 四首曲目：不同調性、速度與和弦進行 */
const TRACKS = [
  {
    name: 'RUNNING IN THE 90S',
    bpm: 160,
    root: 57, // A3
    prog: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],
    lead: [0, 7, 12, 7, 3, 7, 10, 7],
    drive: 1.0,
  },
  {
    name: 'NIGHT OF FIRE',
    bpm: 156,
    root: 55,
    prog: [[0, 4, 7], [5, 9, 12], [-3, 1, 4], [2, 5, 9]],
    lead: [0, 12, 7, 12, 4, 12, 7, 12],
    drive: 1.1,
  },
  {
    name: 'SPACE BOY',
    bpm: 164,
    root: 58,
    prog: [[0, 3, 7], [5, 8, 12], [-2, 2, 5], [-5, -1, 2]],
    lead: [0, 3, 7, 10, 12, 10, 7, 3],
    drive: 0.95,
  },
  {
    name: 'DEJA VU',
    bpm: 158,
    root: 56,
    prog: [[0, 4, 7], [-3, 1, 4], [-5, -1, 2], [2, 6, 9]],
    lead: [0, 7, 4, 7, 12, 7, 4, 0],
    drive: 1.05,
  },
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.trackIndex = 0;
    this.musicOn = true;
    this.sfxOn = true;
    this.volume = 0.75;
    this.step = 0;
    this.nextNoteTime = 0;
    this.playing = false;
    this.tempoScale = 1;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(c.destination);

    this.musicBus = c.createGain();
    this.musicBus.gain.value = 0.34;
    this.musicBus.connect(this.master);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);

    // 音樂殘響
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.9, 2.4);
    this.reverbGain = c.createGain();
    this.reverbGain.gain.value = 0.22;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.musicBus);

    // 延遲（給主旋律）
    this.delay = c.createDelay(0.6);
    this.delay.delayTime.value = 0.28;
    this.delayFb = c.createGain();
    this.delayFb.gain.value = 0.28;
    this.delay.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    const dOut = c.createGain();
    dOut.gain.value = 0.35;
    this.delay.connect(dOut);
    dOut.connect(this.musicBus);

    this.noiseBuf = this.makeNoise(2.0);
    this.initEngine();
    this.started = true;
  }

  makeImpulse(seconds, decay) {
    const c = this.ctx;
    const rate = c.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  makeNoise(seconds) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ---------------- 引擎聲 ---------------- */
  initEngine() {
    const c = this.ctx;
    this.engineGain = c.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = c.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3.2;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.sfxBus);

    this.osc1 = c.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = c.createOscillator();
    this.osc2.type = 'square';
    this.osc3 = c.createOscillator();
    this.osc3.type = 'sawtooth';
    this.osc1.frequency.value = 60;
    this.osc2.frequency.value = 30;
    this.osc3.frequency.value = 121;

    const g1 = c.createGain(); g1.gain.value = 0.5;
    const g2 = c.createGain(); g2.gain.value = 0.32;
    const g3 = c.createGain(); g3.gain.value = 0.22;
    this.osc1.connect(g1); g1.connect(this.engineGain);
    this.osc2.connect(g2); g2.connect(this.engineGain);
    this.osc3.connect(g3); g3.connect(this.engineGain);
    this.osc1.start(); this.osc2.start(); this.osc3.start();

    // 排氣共鳴
    const ex = c.createBufferSource();
    ex.buffer = this.noiseBuf;
    ex.loop = true;
    const exF = c.createBiquadFilter();
    exF.type = 'bandpass';
    exF.frequency.value = 320;
    exF.Q.value = 1.4;
    this.exhaustGain = c.createGain();
    this.exhaustGain.gain.value = 0;
    ex.connect(exF); exF.connect(this.exhaustGain); this.exhaustGain.connect(this.sfxBus);
    ex.start();

    // 輪胎尖叫
    const tn = c.createBufferSource();
    tn.buffer = this.noiseBuf;
    tn.loop = true;
    this.tireFilter = c.createBiquadFilter();
    this.tireFilter.type = 'bandpass';
    this.tireFilter.frequency.value = 1800;
    this.tireFilter.Q.value = 4.5;
    this.tireGain = c.createGain();
    this.tireGain.gain.value = 0;
    tn.connect(this.tireFilter);
    this.tireFilter.connect(this.tireGain);
    this.tireGain.connect(this.sfxBus);
    tn.start();

    // 風噪
    const wn = c.createBufferSource();
    wn.buffer = this.noiseBuf;
    wn.loop = true;
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    wn.connect(this.windFilter); this.windFilter.connect(this.windGain);
    this.windGain.connect(this.sfxBus);
    wn.start();
  }

  setEngine(rpm, throttle, load = 1, turbo = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = Math.max(18, (rpm / 60) * 2);
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.osc3.frequency.setTargetAtTime(f * 2.01, t, 0.03);
    const cutoff = 320 + rpm * 0.28 + throttle * 900;
    this.engineFilter.frequency.setTargetAtTime(Math.min(6500, cutoff), t, 0.05);
    const g = (0.10 + throttle * 0.16 + (rpm / 9000) * 0.10) * (0.55 + 0.45 * load);
    this.engineGain.gain.setTargetAtTime(g * 0.5, t, 0.06);
    this.exhaustGain.gain.setTargetAtTime((0.02 + throttle * 0.05) * (0.4 + rpm / 9000), t, 0.08);
    if (turbo) {
      this.exhaustGain.gain.setTargetAtTime(0.05 + throttle * 0.06, t, 0.1);
    }
  }

  setTire(slip, speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = Math.min(0.5, Math.max(0, slip * 0.9)) * Math.min(1, speed / 12);
    this.tireGain.gain.setTargetAtTime(g * 0.22, t, 0.05);
    this.tireFilter.frequency.setTargetAtTime(1500 + slip * 2200, t, 0.08);
  }

  setWind(speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = Math.min(0.3, Math.pow(speed / 60, 2) * 0.22);
    this.windGain.gain.setTargetAtTime(g, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(500 + speed * 14, t, 0.2);
  }

  impact(strength = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.35 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f); f.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.4);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const og = c.createGain();
    og.gain.setValueAtTime(0.3 * strength, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.32);
  }

  beep(f = 660, dur = 0.14, vol = 0.25, type = 'square') {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /* ---------------- BGM ---------------- */
  startMusic(index = null) {
    if (!this.ctx) return;
    if (index !== null) this.trackIndex = index % TRACKS.length;
    this.playing = true;
    this.step = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.08;
    if (!this._timer) this._timer = setInterval(() => this.scheduler(), 25);
  }

  stopMusic() {
    this.playing = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  nextTrack() {
    this.trackIndex = (this.trackIndex + 1) % TRACKS.length;
    this.step = 0;
    return TRACKS[this.trackIndex].name;
  }

  scheduler() {
    if (!this.playing || !this.ctx) return;
    const tr = TRACKS[this.trackIndex];
    const spb = 60 / (tr.bpm * this.tempoScale) / 4; // 16 分音符
    while (this.nextNoteTime < this.ctx.currentTime + 0.18) {
      this.scheduleStep(this.step, this.nextNoteTime, tr);
      this.nextNoteTime += spb;
      this.step = (this.step + 1) % 128; // 8 小節
    }
  }

  scheduleStep(step, time, tr) {
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = tr.prog[bar];
    const root = tr.root + chord[0];

    // 大鼓
    if (s16 % 4 === 0) this.kick(time, 1.0);
    if (s16 === 14 && Math.random() < 0.4) this.kick(time, 0.5);
    // 小鼓
    if (s16 === 4 || s16 === 12) this.snare(time, 0.9);
    // 開合鈸
    if (s16 % 2 === 0) this.hat(time, s16 % 4 === 0 ? 0.32 : 0.18, s16 % 4 === 0);
    if (s16 % 4 === 2) this.hat(time, 0.1, false);
    // 低音（16 分驅動）
    const bassPat = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 7, 0, 12, 0];
    this.bass(time, root + bassPat[s16] - 12, 0.5 + (s16 % 4 === 0 ? 0.3 : 0));
    // 和弦短音（反拍）
    if (s16 % 4 === 2) this.stab(time, chord.map((c) => root - chord[0] + c + 12), 0.5);
    // 主旋律
    if (s16 % 2 === 0) {
      const n = tr.lead[(step >> 1) % tr.lead.length];
      this.lead(time, tr.root + n + 12, 0.42);
    }
    // 鋪底
    if (s16 === 0) this.pad(time, chord.map((c) => tr.root + c), 1.8);
    // 過門
    if (step % 64 === 60) { this.snare(time, 0.6); this.snare(time + 0.07, 0.5); }
  }

  kick(time, v) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, time);
    o.frequency.exponentialRampToValueAtTime(44, time + 0.11);
    const g = c.createGain();
    g.gain.setValueAtTime(0.9 * v, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.26);
    o.connect(g); g.connect(this.musicBus);
    o.start(time); o.stop(time + 0.3);
  }

  snare(time, v) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.6;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1400;
    const g = c.createGain();
    g.gain.setValueAtTime(0.34 * v, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.17);
    src.connect(f); f.connect(g); g.connect(this.musicBus);
    src.start(time); src.stop(time + 0.2);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, time);
    o.frequency.exponentialRampToValueAtTime(140, time + 0.1);
    const og = c.createGain();
    og.gain.setValueAtTime(0.16 * v, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    o.connect(og); og.connect(this.musicBus);
    o.start(time); o.stop(time + 0.14);
  }

  hat(time, v, open) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 2.4;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7200;
    const g = c.createGain();
    const dur = open ? 0.11 : 0.045;
    g.gain.setValueAtTime(0.12 * v * 3, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    src.connect(f); f.connect(g); g.connect(this.musicBus);
    src.start(time); src.stop(time + dur + 0.02);
  }

  bass(time, note, v) {
    const c = this.ctx;
    const f = freq('C', 0) * Math.pow(2, note / 12) * 2;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const o2 = c.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f * 0.5;
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(260, time);
    flt.frequency.linearRampToValueAtTime(1100 * v + 200, time + 0.02);
    flt.frequency.exponentialRampToValueAtTime(240, time + 0.13);
    flt.Q.value = 6;
    const g = c.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.3 * v, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    o.connect(flt); o2.connect(flt);
    flt.connect(g); g.connect(this.musicBus);
    o.start(time); o2.start(time);
    o.stop(time + 0.18); o2.stop(time + 0.18);
  }

  stab(time, notes, v) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.1 * v, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
    const flt = c.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 1600;
    flt.Q.value = 1.1;
    g.connect(flt);
    flt.connect(this.musicBus);
    flt.connect(this.reverb);
    for (const n of notes) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq('C', 0) * Math.pow(2, (n + 24) / 12) * 2;
      o.detune.value = (Math.random() - 0.5) * 14;
      o.connect(g);
      o.start(time); o.stop(time + 0.16);
    }
  }

  lead(time, note, v) {
    const c = this.ctx;
    const f = freq('C', 0) * Math.pow(2, note / 12) * 2;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const o2 = c.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f * 1.005;
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(5200, time);
    flt.frequency.exponentialRampToValueAtTime(1800, time + 0.16);
    flt.Q.value = 2.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.075 * v, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    const g2 = c.createGain();
    g2.gain.value = 0.5;
    o.connect(flt); o2.connect(g2); g2.connect(flt);
    flt.connect(g); g.connect(this.musicBus);
    g.connect(this.delay);
    g.connect(this.reverb);
    o.start(time); o2.start(time);
    o.stop(time + 0.22); o2.stop(time + 0.22);
  }

  pad(time, notes, dur) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.045, time + 0.25);
    g.gain.linearRampToValueAtTime(0.0, time + dur);
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 2400;
    g.connect(flt);
    flt.connect(this.musicBus);
    flt.connect(this.reverb);
    for (const n of notes) {
      for (const det of [-7, 7]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq('C', 0) * Math.pow(2, (n + 12) / 12) * 2;
        o.detune.value = det;
        o.connect(g);
        o.start(time); o.stop(time + dur + 0.1);
      }
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  toggleMusic(on) {
    this.musicOn = on;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(on ? 0.34 : 0, this.ctx.currentTime, 0.1);
  }

  get trackName() { return TRACKS[this.trackIndex].name; }
  get trackList() { return TRACKS.map((t) => t.name); }
}
