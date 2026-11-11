/**
 * 特效 + 程序化音效（Web Audio 合成，不依赖任何素材文件）
 */
import * as THREE from 'three';

// ============================ 音效 ============================
let AC = null, master = null, muted = false;
export function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  master = AC.createGain();
  master.gain.value = 0.5;
  master.connect(AC.destination);
}
export function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.5; return muted; }

function noiseBuffer(dur) {
  const n = Math.floor(AC.sampleRate * dur);
  const buf = AC.createBuffer(1, n, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function env(node, t0, a, d, peak = 1) {
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  node.connect(g);
  return g;
}

export const SFX = {
  shot(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.13);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.8;
    src.connect(bp);
    const g = env(bp, t, 0.002, 0.11, 0.5 * v); g.connect(master);
    src.start(t); src.stop(t + 0.14);
    // 低频"咚"
    const o = AC.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.09);
    const g2 = env(o, t, 0.002, 0.09, 0.28 * v); g2.connect(master);
    o.start(t); o.stop(t + 0.12);
  },
  hit(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(320, t + 0.07);
    const g = env(o, t, 0.001, 0.07, 0.25 * v); g.connect(master);
    o.start(t); o.stop(t + 0.09);
  },
  splat(v = 1) { // 被糊到
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.25);
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.24);
    src.connect(lp);
    const g = env(lp, t, 0.005, 0.24, 0.4 * v); g.connect(master);
    src.start(t); src.stop(t + 0.26);
  },
  throwG(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.2);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(600, t);
    bp.frequency.linearRampToValueAtTime(1400, t + 0.18);
    src.connect(bp);
    const g = env(bp, t, 0.01, 0.18, 0.22 * v); g.connect(master);
    src.start(t); src.stop(t + 0.2);
  },
  boom(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.7);
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
    src.connect(lp);
    const g = env(lp, t, 0.005, 0.65, 0.85 * v); g.connect(master);
    src.start(t); src.stop(t + 0.72);
    const o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.5);
    const g2 = env(o, t, 0.005, 0.5, 0.55 * v); g2.connect(master);
    o.start(t); o.stop(t + 0.55);
  },
  roll(v = 1) {
    if (!AC || muted) return null;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(1.6); src.loop = true;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    src.connect(lp);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5 * v, t + 0.05);
    g.gain.setValueAtTime(0.5 * v, t + 1.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    lp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 1.65);
    return src;
  },
  down(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.5);
    const g = env(o, t, 0.01, 0.5, 0.3 * v); g.connect(master);
    o.start(t); o.stop(t + 0.55);
  },
  kill(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    [660, 880, 1180].forEach((f, i) => {
      const o = AC.createOscillator(); o.type = 'square'; o.frequency.value = f;
      const g = env(o, t + i * 0.07, 0.005, 0.12, 0.16 * v); g.connect(master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.14);
    });
  },
  /**
   * CF 风格击杀反馈音：清脆「叮—咚」+ 一声闷响
   * @param {number} streak 连杀数（1=单杀, 2=双杀 ...），越高音高越亮
   */
  killFeed(streak = 1, v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const up = Math.min(streak - 1, 4);          // 连杀升调
    // 1) 高频金属脆响（像是爆头确认的一声「叮」）
    const bell = AC.createOscillator(); bell.type = 'triangle';
    bell.frequency.setValueAtTime(1560 + up * 130, t);
    const bg = env(bell, t, 0.001, 0.42, 0.30 * v);
    bg.connect(master);
    bell.start(t); bell.stop(t + 0.45);
    // 2) 叠一个五度泛音，让"叮"更亮
    const bell2 = AC.createOscillator(); bell2.type = 'sine';
    bell2.frequency.setValueAtTime((1560 + up * 130) * 1.5, t);
    const bg2 = env(bell2, t, 0.001, 0.3, 0.16 * v);
    bg2.connect(master);
    bell2.start(t); bell2.stop(t + 0.32);
    // 3) 短促低频冲击「咚」（命中躯干的实感）
    const thud = AC.createOscillator(); thud.type = 'sine';
    thud.frequency.setValueAtTime(230, t); thud.frequency.exponentialRampToValueAtTime(78, t + 0.16);
    const tg = env(thud, t, 0.002, 0.17, 0.34 * v);
    tg.connect(master);
    thud.start(t); thud.stop(t + 0.2);
    // 4) 一声撕布一样的噪声，模拟"糊死"的质感
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.22);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600, t); bp.Q.value = 1.1;
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.2);
    src.connect(bp);
    const ng = env(bp, t, 0.003, 0.2, 0.2 * v);
    ng.connect(master);
    src.start(t); src.stop(t + 0.24);
    // 5) 连杀：再叠一个上行短音阶（双杀/三杀…）
    if (streak >= 2) {
      const base = 620 + up * 90;
      for (let i = 0; i < Math.min(streak, 5); i++) {
        const o = AC.createOscillator(); o.type = 'square';
        o.frequency.value = base * Math.pow(1.26, i);
        const g = env(o, t + 0.06 + i * 0.055, 0.004, 0.1, 0.13 * v);
        g.connect(master);
        o.start(t + 0.06 + i * 0.055); o.stop(t + 0.06 + i * 0.055 + 0.12);
      }
    }
  },
  /** 命中确认（hitmarker）——比之前更脆更短 */
  hitmark(v = 0.8) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(1180, t); o.frequency.exponentialRampToValueAtTime(760, t + 0.045);
    const g = env(o, t, 0.0008, 0.045, 0.2 * v); g.connect(master);
    o.start(t); o.stop(t + 0.06);
  },
  /** 屎榴弹落地「啪叽」一声（屎块飞溅的湿黏感） */
  splatWet(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.3);
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1100, t); lp.frequency.exponentialRampToValueAtTime(150, t + 0.28);
    src.connect(lp);
    const g = env(lp, t, 0.004, 0.28, 0.5 * v); g.connect(master);
    src.start(t); src.stop(t + 0.32);
    // 黏稠的"拉丝"下滑音
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.26);
    const g2 = env(o, t, 0.006, 0.26, 0.2 * v); g2.connect(master);
    o.start(t); o.stop(t + 0.3);
  },
  /** 滚粪球滚过地面的持续黏腻噪声 */
  ballRoll(v = 1) {
    if (!AC || muted) return null;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(1.8); src.loop = true;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.4;
    src.connect(lp);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * v, t + 0.04);
    g.gain.setValueAtTime(0.34 * v, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.75);
    lp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 1.8);
    return src;
  },
  die(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    [520, 400, 260].forEach((f, i) => {
      const o = AC.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = env(o, t + i * 0.1, 0.005, 0.22, 0.2 * v); g.connect(master);
      o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.25);
    });
  },
  jet(v = 1) {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.55);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t); bp.Q.value = 0.9;
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.5);
    src.connect(bp);
    const g = env(bp, t, 0.01, 0.5, 0.42 * v); g.connect(master);
    src.start(t); src.stop(t + 0.56);
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.4);
    const g2 = env(o, t, 0.01, 0.4, 0.22 * v); g2.connect(master);
    o.start(t); o.stop(t + 0.42);
  },
  dry() {
    if (!AC || muted) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'square'; o.frequency.value = 150;
    const g = env(o, t, 0.001, 0.045, 0.14); g.connect(master);
    o.start(t); o.stop(t + 0.05);
    const src = AC.createBufferSource(); src.buffer = noiseBuffer(0.05);
    const hp = AC.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
    src.connect(hp);
    const g2 = env(hp, t, 0.001, 0.035, 0.12); g2.connect(master);
    src.start(t); src.stop(t + 0.06);
  },
};

// ============================ 粒子与特效 ============================
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class FX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.parts = [];
    this.pool = [];
    this.shake = 0;
    this.shakeT = 0;
    this.coverBoxes = [];      // 场景所有碰撞盒（贴污渍时找该贴哪面）

    // 粒子几何（共享）
    this.pGeo = new THREE.IcosahedronGeometry(0.09, 0);
    this.tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this.sphereGeo = new THREE.SphereGeometry(1, 16, 12);
    this.ringGeo = new THREE.RingGeometry(0.72, 1, 48);   // 冲击波环（内径/外径）
    this.poolGroup = new THREE.Group();
    scene.add(this.poolGroup);

    // 粪弹 / 污渍
    this.shotPool = [];
    this.decals = [];
    this.decalMax = 90;        // 污渍上限（降低以减轻 draw call 压力）
    this.decalMatPool = [];    // 污渍材质复用池（避免频繁 new/dispose 材质导致 GC 卡顿）
    this.decalGeo = new THREE.PlaneGeometry(1, 1);
    this.decalTex = makePoopDecalTexture();
    this.glowTex = makeGlowTexture();
  }

  // ---------------- 粪弹（带可见拖尾） ----------------
  _buildShot() {
    const g = new THREE.Group();
    const pellet = new THREE.Mesh(this.pGeo, new THREE.MeshBasicMaterial({ color: 0x3f240e }));
    pellet.scale.set(0.8, 0.8, 1.35);
    g.add(pellet);

    const trailMats = [];
    for (let i = 1; i <= 5; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i < 3 ? 0x8b5a2b : 0x5a3517,
        transparent: true, opacity: 0.6 / i, depthWrite: false,
      });
      const blob = new THREE.Mesh(this.pGeo, mat);
      blob.position.z = -(0.11 + i * 0.11);          // 拖尾在身后（+Z 朝飞行方向）
      blob.scale.setScalar(0.86 / i + 0.1);
      g.add(blob);
      trailMats.push(mat);
    }
    const glowMat = new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffbf72, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(0.36);
    g.add(glow);
    g.visible = false;
    this.scene.add(g);
    return { g, trailMats, glowMat };
  }

  _getShot() {
    return this.shotPool.pop() || this._buildShot();
  }

  /**
   * 大便子弹：一颗旋转粪粒 + 身后一串渐隐拖尾，飞到落点后炸开并留下污渍
   * @param {{nx?:number,ny?:number,nz?:number,hit?:number}} info 命中面法线
   */
  poopShot(from, to, info = {}) {
    const dist = from.distanceTo(to);
    const dur = clamp(dist / 88, 0.055, 0.26);
    const s = this._getShot();
    s.g.visible = true;
    s.g.position.copy(from);
    s.g.lookAt(to);
    s.g.rotateZ(Math.random() * Math.PI * 2);
    s.g.scale.setScalar(1 + Math.random() * 0.25);
    s.glowMat.opacity = 0.55 + Math.random() * 0.3;
    this.parts.push({
      m: s.g, obj: s, shot: true, life: dur, age: 0,
      fly: {
        a: from.clone(), b: to.clone(), dist,
        n: { x: info.nx || 0, y: info.ny == null ? 1 : info.ny, z: info.nz || 0 },
        hit: !!info.hit,
      },
    });
  }

  /** 命中场景：粪点四溅 + 一片污渍 */
  poopImpact(pos, n, hitPlayer) {
    const N = new THREE.Vector3(n.x, n.y, n.z);
    if (N.lengthSq() < 1e-4) N.set(0, 1, 0); else N.normalize();

    // 贴脸打墙时按镜头距离收一收，别糊满整个屏幕
    const camD = this.camera ? this.camera.position.distanceTo(pos) : 9;
    const k = clamp(camD / 8, 0.22, 1);

    // 贴上去的「吧唧」一下：暗色圆斑迅速摊开
    const mat = new THREE.MeshBasicMaterial({
      map: this.decalTex, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const m = new THREE.Mesh(this.decalGeo, mat);
    m.position.copy(pos).addScaledVector(N, 0.02);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), N);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(0.32 * k);
    m.renderOrder = 2;
    this.scene.add(m);
    this.parts.push({ m, splat: true, life: 0.28, age: 0, s0: 0.32 * k, s1: 1.15 * k });

    // 飞点子：三档深浅、大小混着喷出去
    const ps = 0.5 + 0.5 * k;
    this.spray(pos, N, 0x5a3517, 9, 6.0, 0.9 * ps, 0.6);
    this.spray(pos, N, 0x33200e, 6, 3.6, 1.15 * ps, 0.75);
    this.spray(pos, N, 0x9a6634, 5, 7.4, 0.6 * ps, 0.42);

    if (!hitPlayer) {
      this.poopDecal(pos, N, (0.62 + Math.random() * 0.5) * (0.55 + 0.45 * k), 15);
      // 零星甩到旁边的小点
      if (Math.random() < 0.55) {
        const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
        if (Math.abs(N.y) > 0.9) t1.set(1, 0, 0); else t1.set(0, 1, 0);
        t1.cross(N).normalize();
        t2.crossVectors(N, t1).normalize();
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2, r = (0.3 + Math.random() * 0.7) * (0.4 + 0.6 * k);
          const p = pos.clone()
            .addScaledVector(t1, Math.cos(a) * r)
            .addScaledVector(t2, Math.sin(a) * r);
          this.poopDecal(p, N, (0.13 + Math.random() * 0.17) * (0.6 + 0.4 * k), 13);
        }
      }
    }
  }

  /** 污渍贴片：贴在场景表面，慢慢风干消失 */
  poopDecal(pos, normal, scale = 1, life = 12) {
    // 复用材质（污渍贴图一致，仅 opacity 不同，材质池避免频繁 new/dispose 造成 GC 卡顿）
    let mat = this.decalMatPool.pop();
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        map: this.decalTex, transparent: true, opacity: 0.95,
        depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
    }
    mat.opacity = 0.95;
    const m = new THREE.Mesh(this.decalGeo, mat);
    const N = normal.clone().normalize();
    m.position.copy(pos).addScaledVector(N, 0.015);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), N);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(scale * (0.7 + Math.random() * 0.7));
    m.renderOrder = 2;
    this.scene.add(m);
    this.decals.push({ mesh: m, age: 0, life });

    while (this.decals.length > this.decalMax) {
      const old = this.decals.shift();
      this.scene.remove(old.mesh);
      this.decalMatPool.push(old.mesh.material);   // 材质回收复用，不 dispose
    }
  }

  /** 定向喷溅（沿法线的半球） */
  spray(pos, normal, color, count, speed = 5, size = 0.6, life = 0.55) {
    for (let i = 0; i < count; i++) {
      const m = this._get(color);
      m.position.copy(pos).addScaledVector(normal, 0.05);
      m.scale.setScalar(size * (0.55 + Math.random() * 0.9));
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1
      ).normalize();
      if (dir.dot(normal) < 0) dir.addScaledVector(normal, -1.6 * dir.dot(normal)).normalize();
      dir.addScaledVector(normal, 0.5).normalize();
      this.parts.push({
        m, v: dir.multiplyScalar(speed * (0.4 + Math.random() * 0.9)),
        life: life * (0.6 + Math.random() * 0.7), age: 0, g: 18,
      });
    }
  }

  /** 喷气尾焰（从屁股往下喷的屎气） */
  jetExhaust(pos) {
    for (let i = 0; i < 3; i++) {
      const warm = Math.random() < 0.45;
      const m = this._get(warm ? 0xffa94d : 0x8a5a2b);
      m.position.set(
        pos.x + (Math.random() - 0.5) * 0.28,
        pos.y - Math.random() * 0.1,
        pos.z + (Math.random() - 0.5) * 0.28
      );
      m.scale.setScalar(0.2 + Math.random() * 0.18);
      this.parts.push({
        m,
        v: new THREE.Vector3((Math.random() - 0.5) * 1.4, -3.4 - Math.random() * 2.2, (Math.random() - 0.5) * 1.4),
        life: 0.28 + Math.random() * 0.2, age: 0, g: 2,
      });
    }
    if (Math.random() < 0.35) {
      const m = this._get(0xffd08a);
      m.position.copy(pos);
      m.scale.setScalar(0.4);
      this.parts.push({ m, v: new THREE.Vector3(0, -2.4, 0), life: 0.16, age: 0, g: 0 });
    }
  }

  /** 角色日常滴下来的一小坨 */
  poopDrip(pos) {
    const m = this._get(0x5a3418);
    m.position.copy(pos);
    m.scale.setScalar(0.12 + Math.random() * 0.07);
    this.parts.push({
      m, v: new THREE.Vector3((Math.random() - 0.5) * 0.35, -0.6, (Math.random() - 0.5) * 0.35),
      life: 2.4, age: 0, g: 9,
    });
  }

  _get(color) {
    let m = this.pool.pop();
    if (!m) {
      m = new THREE.Mesh(this.pGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      this.poolGroup.add(m);
    }
    m.material.color.setHex(color);
    m.material.opacity = 1;
    m.visible = true;
    return m;
  }

  burst(pos, color, count, speed = 6, size = 1, life = 0.55, gravity = true) {
    for (let i = 0; i < count; i++) {
      const m = this._get(color);
      m.position.copy(pos);
      m.scale.setScalar(size * (0.6 + Math.random() * 0.9));
      const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 0.2, Math.random() * 2 - 1).normalize();
      this.parts.push({
        m, v: dir.multiplyScalar(speed * (0.4 + Math.random() * 0.9)),
        life: life * (0.6 + Math.random() * 0.7), age: 0, g: gravity ? 16 : 0,
      });
    }
  }

  /** 弹道拖尾 */
  tracer(from, to, color = 0xffe9a8) {
    const a = from.clone(), b = to.clone();
    const len = a.distanceTo(b);
    if (len < 0.01) return;
    const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(0.035, 0.035, len);
    m.lookAt(b);
    this.scene.add(m);
    this.parts.push({ m, tracer: true, life: 0.07, age: 0 });
  }

  /** 弹着火花 */
  impact(pos, normalish) {
    this.burst(pos, 0xffe08a, 6, 5, 0.7, 0.3);
    this.burst(pos, 0x8b5a2b, 3, 3, 0.5, 0.5);
  }

  /** 中弹：棕色飞溅（糊脸） */
  splat(pos) {
    this.burst(pos, 0x7a4a22, 10, 5, 0.28, 0.5);
    this.burst(pos, 0x5a3418, 6, 3.5, 0.34, 0.6);
  }

  /**
   * 屎榴弹炸开 —— 不是黄橙火球，而是一大坨屎「砰」地炸开，屎块到处飞溅
   * 组成：核心屎团炸开 + 三档屎块抛射 + 地面放射状污渍 + 挂在空中的溅点
   */
  shiBoom(pos, radius = 5.5) {
    const R = radius;

    // 1) 核心：一大坨深棕色屎团迅速摊开（不用亮色火球，保持"屎"的质感）
    const core = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({
      color: 0x6b4423, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    core.position.copy(pos);
    core.scale.setScalar(0.5);
    this.scene.add(core);
    this.parts.push({ m: core, boom: true, life: 0.42, age: 0, r: R * 0.55 });

    // 内层更亮的稀屎（让炸开的中心有点"亮"，但不刺眼）
    const inner = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({
      color: 0xa9743c, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    inner.position.copy(pos);
    inner.scale.setScalar(0.3);
    this.scene.add(inner);
    this.parts.push({ m: inner, boom: true, life: 0.26, age: 0, r: R * 0.32 });

    // 冲击波环（地面扩散的一圈，增强"炸裂"的爆发感）
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
      color: 0x8b5a2b, transparent: true, opacity: 0.85, depthWrite: false,
      side: THREE.DoubleSide,
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.03, pos.z);
    ring.scale.setScalar(0.4);
    this.scene.add(ring);
    this.parts.push({ m: ring, boom: true, life: 0.4, age: 0, r: R * 1.15 });

    // 2) 屎块四处飞溅：四档颜色/大小，喷得又高又远（加大数量与速度，更夸张）
    const ps = R / 5.5;
    this.burst(pos, 0x8b5a2b, 60, 20 * ps, 1.5, 1.25);
    this.burst(pos, 0x6b4423, 52, 17 * ps, 1.8, 1.42);
    this.burst(pos, 0x4a2f1b, 40, 14 * ps, 2.2, 1.58);
    this.burst(pos, 0xa9743c, 34, 23 * ps, 1.2, 1.08);
    this.burst(pos, 0xc79a5e, 20, 28 * ps, 0.9, 0.9);   // 零星稀屎点子飞更远

    // 3) 地面/四周的放射状污渍：屎炸开后溅得到处都是
    const up = new THREE.Vector3(0, 1, 0);
    // 地面中心一大摊（更大）
    this.poopDecal(new THREE.Vector3(pos.x, 0.015, pos.z), up, R * 0.75, 30000);
    // 一圈随机方向的溅射污渍（含墙面/箱子，用八向近似贴上去）
    const N = 30;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.random() * 0.5;
      const d = R * (0.25 + Math.random() * 1.1);
      const px = pos.x + Math.cos(a) * d;
      const pz = pos.z + Math.sin(a) * d;
      const py = pos.y + (Math.random() - 0.35) * 1.6;
      // 判断贴在哪：贴近地面就贴地，否则贴到附近的箱子/墙上
      let nrm = up, ty = 0.015;
      if (py > 0.6) {
        let best = null, bestD = 1e9;
        for (const b of this.coverBoxes) {
          const dx = Math.abs(px - b.cx) - b.hx, dy = Math.abs(py - b.cy) - b.hy, dz = Math.abs(pz - b.cz) - b.hz;
          const mx = Math.max(dx, dy, dz);
          if (mx < 0.55 && mx < bestD) {
            bestD = mx;
            // 取最"外出"的那一轴作为法线
            if (dx >= dy && dx >= dz) best = { nx: Math.sign(px - b.cx), ny: 0, nz: 0 };
            else if (dy >= dz) best = { nx: 0, ny: Math.sign(py - b.cy), nz: 0 };
            else best = { nx: 0, ny: 0, nz: Math.sign(pz - b.cz) };
          }
        }
        if (best) nrm = new THREE.Vector3(best.nx, best.ny, best.nz);
        else { ty = 0.015; nrm = up; }
      }
      const p = new THREE.Vector3(px, nrm === up ? ty : py, pz);
      this.poopDecal(p, nrm, R * (0.10 + Math.random() * 0.3), 26000);
    }

    // 4) 空中悬浮的细密屎点子（让"炸得四处飞溅"看得更满）
    for (let i = 0; i < 40; i++) {
      const m = this._get(Math.random() < 0.5 ? 0x7a4a22 : 0x9a6634);
      m.position.copy(pos).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.4, (Math.random() - 0.4) * 1.4, (Math.random() - 0.5) * 1.4));
      m.scale.setScalar((0.16 + Math.random() * 0.34) * ps);
      const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 1.7, Math.random() * 2 - 1).normalize();
      this.parts.push({
        m, v: dir.multiplyScalar((12 + Math.random() * 22) * ps),
        life: (1.0 + Math.random() * 1.0), age: 0, g: 16,
      });
    }

    // 5) 暖光（稍强一点，增强炸裂的视觉冲击，但保留屎色）
    const l = new THREE.PointLight(0xc79a5e, 4.5, R * 3.4, 2);
    l.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
    this.scene.add(l);
    this.parts.push({ m: l, light: true, life: 0.3, age: 0, p0: 4.5 });

    // 6) 更剧烈的屏震 + 一声巨响（音效由 main.js 的 boom 事件触发，这里只做震动）
    this.addShake(0.95);
  }

  /** 滚粪球滚过地面：连续撒屎点子 + 铺污渍（轨迹非常夸张） */
  ballTrail(pos, dir, spin) {
    const sp = 0.5 + Math.random() * 0.5;
    // 球体两侧甩出的碎屑（模拟滚动时把屎甩到两边）
    for (let i = 0; i < 3; i++) {
      const m = this._get(Math.random() < 0.5 ? 0x6b4423 : 0x8b5a2b);
      const side = Math.random() < 0.5 ? 1 : -1;
      const px = -dir.z * side, pz = dir.x * side;   // 垂直于前进方向
      m.position.set(
        pos.x - dir.x * (0.3 + Math.random() * 0.6) + px * (0.35 + Math.random() * 0.5),
        0.12 + Math.random() * 0.5,
        pos.z - dir.z * (0.3 + Math.random() * 0.6) + pz * (0.35 + Math.random() * 0.5),
      );
      m.scale.setScalar(0.13 + Math.random() * 0.22);
      this.parts.push({
        m,
        v: new THREE.Vector3(px * 3.2 + (Math.random() - 0.5) * 1.4, 2.6 + Math.random() * 3.4, pz * 3.2 + (Math.random() - 0.5) * 1.4),
        life: 0.55 + Math.random() * 0.5, age: 0, g: 17,
      });
    }
    // 向后抛出的粗颗粒（滚动扬起）
    if (Math.random() < 0.75) {
      const m = this._get(0x5a3418);
      m.position.set(pos.x, 0.14 + Math.random() * 0.3, pos.z);
      m.scale.setScalar(0.2 + Math.random() * 0.26);
      this.parts.push({
        m,
        v: new THREE.Vector3(-dir.x * (2.4 + Math.random() * 3.4), 2.2 + Math.random() * 2.6, -dir.z * (2.4 + Math.random() * 3.4)),
        life: 0.6 + Math.random() * 0.5, age: 0, g: 18,
      });
    }
    // 地面污渍：沿路径连续铺，稍微左右偏移，看起来就是一条屎痕
    const off = 0.35;
    this.poopDecal(
      new THREE.Vector3(pos.x + (Math.random() - 0.5) * off, 0.012, pos.z + (Math.random() - 0.5) * off),
      new THREE.Vector3(0, 1, 0), 0.85 + Math.random() * 0.75, 15000);
    // 轨迹两侧抛出的小污点
    if (Math.random() < 0.6) {
      const side = Math.random() < 0.5 ? 1 : -1;
      this.poopDecal(
        new THREE.Vector3(pos.x - dir.z * side * (0.7 + Math.random() * 1.1), 0.012,
          pos.z + dir.x * side * (0.7 + Math.random() * 1.1)),
        new THREE.Vector3(0, 1, 0), 0.3 + Math.random() * 0.35, 13000);
    }
  }

  /** 爆炸 */
  explosion(pos, radius = 5) {
    this.shiBoom(pos, radius);
  }

  /** 枪口焰：一小团暖光 + 几粒火星（不要挡住视线） */
  muzzle(pos, dir, size = 0.32) {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffb469, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size * (1 + Math.random() * 0.35));
    this.scene.add(s);
    this.parts.push({ m: s, flash: true, life: 0.06, age: 0, grow: 3.2 });

    for (let i = 0; i < 3; i++) {
      const m = this._get(0x6b4423);
      m.position.copy(pos);
      m.scale.setScalar((0.1 + Math.random() * 0.1) * (size / 0.32));
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5)
        .normalize().multiplyScalar(2.6 + Math.random() * 1.8);
      if (dir) d.addScaledVector(dir, 2.5);
      this.parts.push({ m, v: d, life: 0.1 + Math.random() * 0.08, age: 0, g: 4 });
    }
  }

  addShake(v) { this.shake = Math.min(1.2, this.shake + v); }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      const k = p.age / p.life;

      // 粪弹飞行：到点炸开 + 留污渍
      if (p.shot) {
        if (k >= 1) {
          this.poopImpact(p.fly.b, p.fly.n, p.fly.hit);
          p.m.visible = false;
          this.shotPool.push(p.obj);
          this.parts.splice(i, 1);
          continue;
        }
        const kk = Math.min(1, k);
        p.m.position.lerpVectors(p.fly.a, p.fly.b, kk);
        p.m.position.y += Math.sin(kk * Math.PI) * Math.min(0.4, p.fly.dist * 0.005);
        continue;
      }

      if (k >= 1) {
        if (p.tracer || p.boom || p.flash || p.light || p.splat) {
          this.scene.remove(p.m);
          if (p.m.material && p.m.material.dispose && !p.light) p.m.material.dispose();
        } else {
          p.m.visible = false;
          this.pool.push(p.m);
        }
        this.parts.splice(i, 1);
        continue;
      }
      if (p.light) { p.m.intensity = p.p0 * (1 - k); continue; }
      if (p.boom) {
        p.m.scale.setScalar(0.4 + k * p.r);
        p.m.material.opacity = 0.85 * (1 - k);
        continue;
      }
      if (p.splat) {
        const e = 1 - (1 - k) * (1 - k);
        p.m.scale.setScalar(p.s0 + (p.s1 - p.s0) * e);
        p.m.material.opacity = 0.9 * (1 - k * k);
        continue;
      }
      if (p.flash) {
        p.m.material.opacity = 0.95 * (1 - k);
        p.m.scale.multiplyScalar(1 + dt * (p.grow || 6));
        continue;
      }
      if (p.tracer) { p.m.material.opacity = 0.85 * (1 - k); continue; }
      // 普通粒子
      p.v.y -= p.g * dt;
      p.m.position.addScaledVector(p.v, dt);
      if (p.m.position.y < 0.035) { p.m.position.y = 0.035; p.v.y *= -0.32; p.v.x *= 0.55; p.v.z *= 0.55; }
      p.m.scale.multiplyScalar(1 - dt * 0.9);
      p.m.material.opacity = Math.max(0, 1 - k);
      p.m.material.transparent = true;
    }

    // 污渍风干
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;
      const k = d.age / d.life;
      if (k >= 1) {
        this.scene.remove(d.mesh);
        d.mesh.material.dispose();
        this.decals.splice(i, 1);
        continue;
      }
      if (k > 0.7) d.mesh.material.opacity = 0.95 * (1 - (k - 0.7) / 0.3);
    }

    this.shake = Math.max(0, this.shake - dt * 2.2);
  }
}

/** 生成「糊脸」污渍纹理（返回 dataURL，作为 CSS 背景） */
export function makeSplatTexture(size = 512) {  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const blob = (cx, cy, r, alpha) => {
    g.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.62 + Math.random() * 0.75);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = `rgba(${90 + Math.random() * 40 | 0},${50 + Math.random() * 30 | 0},${20 + Math.random() * 20 | 0},${alpha})`;
    g.fill();
  };
  // 大块污渍
  for (let i = 0; i < 9; i++) {
    blob(Math.random() * size, Math.random() * size, 40 + Math.random() * 90, 0.5 + Math.random() * 0.35);
  }
  // 飞溅小点
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 2 + Math.random() * 12;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = `rgba(${70 + Math.random() * 50 | 0},${38 + Math.random() * 30 | 0},${16 + Math.random() * 18 | 0},${0.35 + Math.random() * 0.4})`;
    g.fill();
  }
  // 流挂
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size, y = Math.random() * size * 0.7, h = 30 + Math.random() * 120;
    const grd = g.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, 'rgba(110,62,28,.45)');
    grd.addColorStop(1, 'rgba(110,62,28,0)');
    g.fillStyle = grd;
    g.fillRect(x, y, 6 + Math.random() * 10, h);
  }
  return c.toDataURL();
}

/** 生成单片的「溅一坨」污渍（透明底，用于屏幕上随机溅一片） */
export function makeSplatBlob(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;

  // 不规则但圆润的一坨（角度细分足够多，不会像多边形）
  const blob = (x, y, r, alpha, tone = 0) => {
    g.beginPath();
    const n = 40;
    const seed = Math.random() * 10;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.84 + 0.14 * Math.sin(a * 3 + seed) + Math.random() * 0.06);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = `rgba(${86 + tone},${54 + tone * 0.7 | 0},${22 + tone * 0.4 | 0},${alpha})`;
    g.fill();
  };

  // 主体 + 几团融合的副瓣
  g.filter = 'blur(3px)';
  blob(cx, cy, size * 0.235, 0.96, 6);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.random();
    const d = size * (0.05 + Math.random() * 0.06);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.13 + Math.random() * 0.06), 0.94, 0);
  }
  // 四溅的小点
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.19 + Math.random() * 0.22);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.012 + Math.random() * 0.035), 0.9, 10);
  }
  g.filter = 'none';

  // 流挂
  for (let i = 0; i < 3; i++) {
    const x = cx + (Math.random() - 0.5) * size * 0.3;
    const h = size * (0.14 + Math.random() * 0.18);
    const grd = g.createLinearGradient(x, cy, x, cy + h);
    grd.addColorStop(0, 'rgba(92,56,22,.85)');
    grd.addColorStop(1, 'rgba(92,56,22,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, cy + h * 0.35, size * 0.018, h * 0.45, 0, 0, Math.PI * 2);
    g.fill();
  }
  return c.toDataURL();
}

/** 场景污渍贴图：一摊溅开的粪渍（带透明底） */
export function makePoopDecalTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const blob = (x, y, r, alpha, tone = 0) => {
    g.beginPath();
    const n = 26, seed = Math.random() * 9;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.82 + 0.16 * Math.sin(a * 3 + seed) + Math.random() * 0.08);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = `rgba(${52 + tone},${31 + tone * 0.6 | 0},${11 + tone * 0.4 | 0},${alpha})`;
    g.fill();
  };

  g.filter = 'blur(1.1px)';
  blob(cx, cy, size * 0.30, 1, 6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.random();
    const d = size * (0.05 + Math.random() * 0.08);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.14 + Math.random() * 0.05), 0.95, 0);
  }
  g.filter = 'none';
  // 四溅的小点
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.21 + Math.random() * 0.25);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.01 + Math.random() * 0.028), 0.9, 12);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 圆形柔光贴图（枪口/弹丸光晕） */
export function makeGlowTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.28, 'rgba(255,225,170,.75)');
  grd.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
