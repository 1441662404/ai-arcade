// =============================================================================
// === 通用曲面工具：翼型放样 / 超椭圆机身放样 / 双点圆管 ======================
// 战斗机与轰炸机共用同一套"曲面语言"：
//   机翼/尾翼 = NACA 对称翼型沿展向放样（有厚度、有圆前缘、有翼尖收口）
//   机身     = 超椭圆剖面沿轴向放样（上半圆、下半平，机腹才能是弹舱）
//   拉杆/钢索 = 两点之间的圆管
// 原来轰炸机用 Box 拼，近看就是一堆方盒子，这是"丑"的根因。
// =============================================================================
function airfoilSurface(stations, opt) {
  const o = opt || {};
  const n = o.samples || 10;
  const S = o.span || [1, 0, 0];
  const T = o.thick || [0, 1, 0];
  const mir = o.mirror ? -1 : 1;
  const naca = (xa) => 0.2969 * Math.sqrt(xa) - 0.126 * xa - 0.3516 * xa * xa
    + 0.2843 * xa * xa * xa - 0.1015 * xa * xa * xa * xa;
  // 归一化环：上表面 TE→LE，再下表面 LE→TE（闭合）
  const ring = [];
  for (let i = n; i >= 0; i--) { const xa = i / n; ring.push([xa, 1]); }
  for (let i = 1; i < n; i++) { const xa = i / n; ring.push([xa, -1]); }
  const L = ring.length;
  const pos = [], uv = [], idx = [];
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    for (let j = 0; j < L; j++) {
      const xa = ring[j][0], sign = ring[j][1];
      const th = sign * 5 * st.t * naca(xa) * st.c;
      const px = mir * (S[0] * st.p) + T[0] * th;
      const py = S[1] * st.p + (st.off || 0) + T[1] * th;
      const pz = S[2] * st.p + st.le + xa * st.c;
      pos.push(px, py, pz);
      uv.push(xa * st.c * 0.34, st.p * 0.34);
    }
  }
  for (let s = 0; s < stations.length - 1; s++) {
    for (let j = 0; j < L; j++) {
      const j2 = (j + 1) % L;
      const a = s * L + j, b = s * L + j2, c = (s + 1) * L + j2, d = (s + 1) * L + j;
      if (mir > 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  // 翼尖封口：最后一个剖面的重心做扇形，避免露出空心
  if (o.cap !== false) {
    const last = stations[stations.length - 1];
    const base = pos.length / 3;
    pos.push(mir * S[0] * last.p, S[1] * last.p + (last.off || 0), S[2] * last.p + last.le + last.c * 0.45);
    uv.push(0.5, last.p * 0.34);
    const off = (stations.length - 1) * L;
    for (let j = 0; j < L; j++) {
      const j2 = (j + 1) % L;
      if (mir > 0) idx.push(base, off + j, off + j2);
      else idx.push(base, off + j2, off + j);
    }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.setIndex(idx);
  gg.computeVertexNormals();
  return gg;
}

// 超椭圆剖面放样：stations = [{ z, w, h, y, nTop, nBot }]
//   w/h  = 半宽 / 半高
//   nTop = 上半部方形度（2 = 椭圆，3 = 方肩），nBot 同理控制机腹平坦度
// 上下两端自动封口（风扇三角），所以机身不会露出空腔。
function loftHull(stations, seg) {
  const S = seg || 24, N = stations.length;
  const pos = [], uv = [], idx = [];
  const ringPt = (st, a) => {
    const cx = Math.cos(a), sy = Math.sin(a);
    const n = sy >= 0 ? (st.nTop || 2.1) : (st.nBot || 2.8);
    const k = 2 / n;
    return [
      Math.sign(cx) * Math.pow(Math.abs(cx), k) * st.w,
      Math.sign(sy) * Math.pow(Math.abs(sy), k) * st.h + (st.y || 0),
      st.z
    ];
  };
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < S; i++) {
      const p = ringPt(stations[s], (i / S) * Math.PI * 2);
      pos.push(p[0], p[1], p[2]);
      uv.push(i / S, stations[s].z * 0.09);
    }
  }
  for (let s = 0; s < N - 1; s++) {
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const a = s * S + i, b = s * S + j, c = (s + 1) * S + j, d = (s + 1) * S + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  // 首端封口（朝 -Z）：反向绕序，否则法线朝里
  for (const [si, flip] of [[0, true], [N - 1, false]]) {
    const st = stations[si];
    const base = pos.length / 3;
    pos.push(0, st.y || 0, st.z);
    uv.push(0.5, 0.5);
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const a = si * S + i, b = si * S + j;
      if (flip) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.setIndex(idx);
  gg.computeVertexNormals();
  return gg;
}

// 两点之间的圆管（起落架支柱 / 座舱框 / 天线 / 张线）
const _UP_Y = new THREE.Vector3(0, 1, 0);
function tubeBetween(a, b, r0, r1, mat, seg) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-4) return null;
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg || 7, 1, false);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_UP_Y, dir.normalize());
  return m;
}

// 弹舱内壁：只看内侧（DoubleSide），从下往上看是"洞"而不是一块实心
let _bayMat = null;
function bombBayMat() {
  if (!_bayMat) {
    _bayMat = new THREE.MeshStandardMaterial({
      color: 0x0b0e11, roughness: 0.95, metalness: 0.28,
      side: THREE.DoubleSide, envMapIntensity: 0.25
    });
  }
  return _bayMat;
}

// 螺旋桨高速旋转的模糊盘：径向渐变，中段几乎透明、桨尖一圈发白
let _propDiscTex = null;
function propDiscTexture() {
  if (_propDiscTex) return _propDiscTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 3, 64, 64, 64);
  gr.addColorStop(0.00, 'rgba(220,232,244,0)');
  gr.addColorStop(0.45, 'rgba(220,232,244,0.05)');
  gr.addColorStop(0.80, 'rgba(232,242,252,0.16)');
  gr.addColorStop(0.96, 'rgba(245,250,255,0.42)');
  gr.addColorStop(1.00, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.beginPath(); x.arc(64, 64, 64, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _propDiscTex = t;
  return t;
}

// === 轰炸机：双发中单翼 · 玻璃机鼻 · 内埋弹舱 · 双垂尾 ======================
// 参照 B-25 级中型轰炸机：玻璃机鼻（投弹手舱）+ 双 R-2600 星型发动机 + 前三点
// 起落架 + 双垂尾 + 背/腹/腰炮塔。定位：反舰平台，慢、重、皮厚、自卫火力密。
// 全部用翼型/超椭圆放样建面；动态件（螺旋桨/弹舱门/起落架/舵面）单独打 dyn。
function buildBomberMesh(team) {
  const g = new THREE.Group();
  const M = planeMats(team);
  const shell = new THREE.Group();
  g.add(shell);
  const bayMat = bombBayMat();

  const addMesh = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    if (x !== undefined) m.position.set(x, y, z);
    shell.add(m);
    return m;
  };
  const boxM = (w, h, d, mat, x, y, z) => addMesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const bar = (ax, ay, az, bx, by, bz, r, mat, seg) =>
    tubeBetween(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), r, r, mat, seg);

  // ---------------------------------------------------------------- 机身 ----
  const HULL = [
    [-6.98, 1.19, 1.14, 0.00, 2.10, 2.70],
    [-6.30, 1.24, 1.22, 0.00, 2.10, 2.80],
    [-5.10, 1.27, 1.30, 0.00, 2.10, 2.85],
    [-3.30, 1.29, 1.36, 0.00, 2.10, 2.90],
    [-1.10, 1.30, 1.38, 0.01, 2.20, 2.90],
    [1.50, 1.27, 1.34, 0.03, 2.20, 2.85],
    [3.40, 1.18, 1.25, 0.06, 2.20, 2.75],
    [5.20, 1.02, 1.10, 0.09, 2.20, 2.65],
    [6.60, 0.80, 0.88, 0.12, 2.30, 2.55],
    [7.70, 0.54, 0.60, 0.15, 2.30, 2.45],
    [8.40, 0.30, 0.34, 0.17, 2.40, 2.40],
    [8.78, 0.12, 0.14, 0.18, 2.40, 2.40]
  ].map((p) => ({ z: p[0], w: p[1], h: p[2], y: p[3], nTop: p[4], nBot: p[5] }));
  addMesh(geoOnce('bmHull', () => loftHull(HULL, 28)), M.body);

  // 贴合超椭圆剖面的"箍"：用同一条放样曲线生成一圈薄环，
  // 用 Torus 套椭圆会埋在机身里（超椭圆在 45° 处比椭圆更鼓），所以必须按剖面重建
  const hullBand = (st, thick, mat, grow) => {
    const k = 1 + (grow || 0.006);
    const mesh = addMesh(loftHull([
      { z: st.z - thick * 0.5, w: st.w * k, h: st.h * k, y: st.y, nTop: st.nTop, nBot: st.nBot },
      { z: st.z + thick * 0.5, w: st.w * k, h: st.h * k, y: st.y, nTop: st.nTop, nBot: st.nBot }
    ], 30), mat);
    return mesh;
  };
  // 机身分模线（两圈暗色细箍）+ 后机身队色带
  for (const zz of [-1.10, 3.40]) {
    hullBand(HULL.find((s) => Math.abs(s.z - zz) < 0.4) || HULL[4], 0.05, M.dark, 0.004);
  }
  hullBand(HULL[7], 0.46, M.acc, 0.010);

  // ------------------------------------------------------------ 玻璃机鼻 ----
  const NOSE = [
    [-9.34, 0.24, 0.20, -0.05, 2.0, 2.4],
    [-9.06, 0.56, 0.48, -0.04, 2.0, 2.4],
    [-8.70, 0.80, 0.70, -0.03, 2.0, 2.5],
    [-8.25, 0.96, 0.86, -0.02, 2.0, 2.5],
    [-7.75, 1.06, 0.98, 0.00, 2.0, 2.6],
    [-7.30, 1.13, 1.07, 0.00, 2.05, 2.65],
    [-6.98, 1.19, 1.14, 0.00, 2.10, 2.70]
  ].map((p) => ({ z: p[0], w: p[1], h: p[2], y: p[3], nTop: p[4], nBot: p[5] }));
  addMesh(geoOnce('bmNose', () => loftHull(NOSE, 24)), M.glass);

  // 机鼻玻璃框：横向环肋（贴合每一站剖面）+ 纵向框条（沿曲面走折线）
  const noseBand = (st, thick, rr) => addMesh(loftHull([
    { z: st.z - thick * 0.5, w: st.w + rr, h: st.h + rr, y: st.y, nTop: st.nTop, nBot: st.nBot },
    { z: st.z + thick * 0.5, w: st.w + rr, h: st.h + rr, y: st.y, nTop: st.nTop, nBot: st.nBot }
  ], 26), M.dark);
  for (const k of [1, 2, 3, 4, 5]) noseBand(NOSE[k], 0.045, k === 5 ? 0.030 : 0.020);
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2 + Math.PI / 8;
    for (let k = 0; k < NOSE.length - 1; k++) {
      const p0 = NOSE[k], p1 = NOSE[k + 1];
      const n0 = Math.sin(ang) >= 0 ? p0.nTop : p0.nBot;
      const n1 = Math.sin(ang) >= 0 ? p1.nTop : p1.nBot;
      const kx = 2 / n0, kx1 = 2 / n1;
      const c = Math.cos(ang), s = Math.sin(ang);
      const x0 = Math.sign(c) * Math.pow(Math.abs(c), kx) * p0.w;
      const y0 = Math.sign(s) * Math.pow(Math.abs(s), kx) * p0.h + p0.y;
      const x1 = Math.sign(c) * Math.pow(Math.abs(c), kx1) * p1.w;
      const y1 = Math.sign(s) * Math.pow(Math.abs(s), kx1) * p1.h + p1.y;
      shell.add(bar(x0, y0, p0.z, x1, y1, p1.z, 0.019, M.dark, 5));
    }
  }
  // 投弹手舱内的深色隔板：从外面看进去不是一个透空的壳
  boxM(1.30, 0.10, 1.90, M.dark, 0, -0.62, -8.20);
  boxM(0.34, 0.42, 0.40, M.dark, 0, -0.34, -8.05);   // 投弹瞄准具基座

  // -------------------------------------------------------------- 驾驶舱 ----
  // 上凸的阶梯座舱：玻璃罩 + 三根环框 + 风挡 A 柱
  const CANOPY = [
    { z: -6.66, w: 0.50, h: 0.30, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -6.32, w: 0.62, h: 0.42, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -5.72, w: 0.69, h: 0.49, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -5.14, w: 0.65, h: 0.45, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -4.94, w: 0.52, h: 0.34, y: 1.02, nTop: 2.4, nBot: 2.4 }
  ];
  addMesh(geoOnce('bmCanopy', () => loftHull(CANOPY, 20)), M.glass);
  for (const k of [1, 2, 3]) {
    const st = CANOPY[k];
    addMesh(loftHull([
      { z: st.z - 0.022, w: st.w + 0.018, h: st.h + 0.018, y: st.y, nTop: 2.4, nBot: 2.4 },
      { z: st.z + 0.022, w: st.w + 0.018, h: st.h + 0.018, y: st.y, nTop: 2.4, nBot: 2.4 }
    ], 20), M.dark);
  }
  for (const s of [-1, 1]) {
    shell.add(bar(s * 0.34, 1.06, -6.60, s * 0.50, 1.50, -5.70, 0.020, M.dark, 5));
  }
  // 侧窗（机身两侧各三扇）
  for (const s of [-1, 1]) {
    for (const zz of [-4.55, -3.55, -2.55]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.30), M.glass);
      w.position.set(s * 1.283, 0.34, zz);
      w.rotation.y = s * Math.PI / 2;
      shell.add(w);
    }
  }

  // ---------------------------------------------------------------- 主翼 ----
  const WING = [
    { p: 1.10, le: -1.42, c: 4.45, off: 0.34, t: 0.072 },
    { p: 2.30, le: -1.16, c: 4.12, off: 0.45, t: 0.068 },
    { p: 3.70, le: -0.74, c: 3.66, off: 0.58, t: 0.064 },
    { p: 5.40, le: -0.20, c: 3.12, off: 0.73, t: 0.059 },
    { p: 7.20, le: 0.38, c: 2.54, off: 0.89, t: 0.055 },
    { p: 8.90, le: 0.94, c: 1.96, off: 1.04, t: 0.051 },
    { p: 10.10, le: 1.30, c: 1.50, off: 1.15, t: 0.048 },
    { p: 10.62, le: 1.46, c: 1.24, off: 1.20, t: 0.046 }
  ];
  for (const s of [-1, 1]) {
    addMesh(airfoilSurface(WING, { mirror: s < 0 }), M.panel);
    // 翼根整流（把机身与机翼之间的夹角填成曲面，不然是硬折角）
    addMesh(airfoilSurface([
      { p: 1.05, le: -1.30, c: 3.30, off: 0.30, t: 0.11 },
      { p: 1.70, le: -1.28, c: 3.55, off: 0.36, t: 0.09 },
      { p: 2.25, le: -1.20, c: 3.80, off: 0.42, t: 0.08 }
    ], { mirror: s < 0 }), M.body);
    // 前缘缝翼分缝线（一条贴前缘的暗线，读出机翼是分段的）
    addMesh(airfoilSurface([
      { p: 1.60, le: -1.30, c: 0.34, off: 0.38, t: 0.055 },
      { p: 5.40, le: -0.22, c: 0.30, off: 0.72, t: 0.052 },
      { p: 8.90, le: 0.90, c: 0.26, off: 1.03, t: 0.050 },
      { p: 10.55, le: 1.42, c: 0.22, off: 1.19, t: 0.048 }
    ], { mirror: s < 0 }), M.dark);
    // 翼尖队色条
    addMesh(airfoilSurface([
      { p: 9.90, le: 1.24, c: 1.52, off: 1.13, t: 0.049 },
      { p: 10.58, le: 1.43, c: 1.20, off: 1.19, t: 0.047 }
    ], { mirror: s < 0 }), M.acc);
  }

  // ------------------------------------------------- 副翼（可动，跟滚转）----
  const ailerons = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 6.40, 0.80, 2.42);
    const geo = airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.60, off: 0.00, t: 0.060 },
      { p: 2.50, le: 0.05, c: 0.50, off: 0.19, t: 0.056 },
      { p: 4.10, le: 0.02, c: 0.34, off: 0.34, t: 0.052 }
    ], { mirror: s < 0 });
    const m = new THREE.Mesh(geo, M.panel);
    grp.add(m);
    grp.userData.sign = s;
    shell.add(grp);
    ailerons.push(grp);
  }

  // -------------------------------------------------------------- 发动机 ----
  const PROP_X = 3.68, PROP_Y = 0.28;
  const NAC = [
    [-2.42, 0.80, 0.80, 0.00],
    [-2.22, 0.94, 0.94, 0.00],
    [-1.70, 0.98, 0.98, 0.00],
    [-0.60, 0.96, 0.96, 0.00],
    [0.55, 0.88, 0.88, 0.00],
    [1.45, 0.74, 0.74, 0.00],
    [2.10, 0.54, 0.54, 0.00],
    [2.48, 0.30, 0.30, 0.00]
  ].map((p) => ({ z: p[0], w: p[1], h: p[1], y: 0, nTop: 2.0, nBot: 2.0 }));
  const nacGeo = geoOnce('bmNac', () => loftHull(NAC, 22));
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(nacGeo, M.body);
    nac.position.set(s * PROP_X, PROP_Y, 0);
    shell.add(nac);
    // 整流罩唇口（进气口翻边）
    const lip = new THREE.Mesh(geoOnce('bmCowlLip', () => new THREE.TorusGeometry(0.93, 0.075, 6, 26)), M.metal);
    lip.position.set(s * PROP_X, PROP_Y, -2.30);
    shell.add(lip);
    // 进气口内的黑暗 + 星型发动机气缸（从正面能看见 9 个缸头）
    const dark = new THREE.Mesh(geoOnce('bmCowlDark', () => new THREE.CircleGeometry(0.86, 22)), M.dark);
    dark.position.set(s * PROP_X, PROP_Y, -2.19);
    dark.rotation.y = Math.PI;
    shell.add(dark);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const cyl = boxM(0.20, 0.20, 0.40, M.hot,
        s * PROP_X + Math.cos(a) * 0.62, PROP_Y + Math.sin(a) * 0.62, -2.12);
      cyl.rotation.z = a;
    }
    // 整流罩散热 flap 环
    const flapRing = new THREE.Mesh(geoOnce('bmCowlFlap', () => new THREE.TorusGeometry(0.905, 0.028, 4, 26)), M.dark);
    flapRing.position.set(s * PROP_X, PROP_Y, -0.62);
    shell.add(flapRing);
    // 排气管（每侧 3 根，从罩壳侧下方伸出来）
    for (let i = 0; i < 3; i++) {
      const zz = -1.30 + i * 0.52;
      const ex = boxM(0.16, 0.13, 0.26, M.hot, s * (PROP_X + 0.86), PROP_Y - 0.52, zz);
      ex.rotation.x = 0.24;
    }
  }

  // ------------------------------------------------------------ 螺旋桨 ----
  const propDiscMat = new THREE.MeshBasicMaterial({
    map: propDiscTexture(), transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const bladeGeo = geoOnce('bmBlade', () => airfoilSurface([
    { p: 0.20, le: -0.15, c: 0.24, off: 0, t: 0.17 },
    { p: 0.62, le: -0.14, c: 0.30, off: 0, t: 0.12 },
    { p: 1.24, le: -0.13, c: 0.27, off: 0, t: 0.10 },
    { p: 1.86, le: -0.11, c: 0.19, off: 0, t: 0.09 },
    { p: 1.96, le: -0.09, c: 0.13, off: 0, t: 0.08 }
  ], { span: [0, 1, 0], thick: [1, 0, 0], samples: 8 }));
  const props = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * PROP_X, PROP_Y, -2.62);
    // 桨毂整流罩
    const spinner = new THREE.Mesh(geoOnce('bmSpinner', () => {
      const geo = new THREE.ConeGeometry(0.30, 0.66, 16);
      geo.rotateX(-Math.PI / 2);
      return geo;
    }), M.metal);
    spinner.position.z = -0.26;
    grp.add(spinner);
    const spTip = new THREE.Mesh(geoOnce('bmSpinnerTip', () => new THREE.SphereGeometry(0.075, 8, 6)), M.acc);
    spTip.position.z = -0.60;
    grp.add(spTip);
    // 3 片桨叶：绕 Y 拧一个桨距角，再绕 Z 均分 120°
    for (let i = 0; i < 3; i++) {
      const bl = new THREE.Mesh(bladeGeo, M.dark);
      bl.rotation.order = 'YZX';
      bl.rotation.y = 0.42;
      bl.rotation.z = (i / 3) * Math.PI * 2;
      grp.add(bl);
    }
    // 模糊盘
    const disc = new THREE.Mesh(geoOnce('bmDisc', () => new THREE.CircleGeometry(1.98, 40)), propDiscMat);
    disc.position.z = -0.04;
    grp.add(disc);
    shell.add(grp);
    props.push({ grp, disc });
  }

  // ---------------------------------------------------------------- 尾翼 ----
  const TAIL_Y = 0.12;
  for (const s of [-1, 1]) {
    addMesh(airfoilSurface([
      { p: 0.34, le: 6.32, c: 2.34, off: 0.10, t: 0.062 },
      { p: 1.60, le: 6.66, c: 1.98, off: 0.15, t: 0.058 },
      { p: 2.90, le: 7.02, c: 1.56, off: 0.20, t: 0.054 },
      { p: 4.10, le: 7.32, c: 1.16, off: 0.23, t: 0.050 },
      { p: 4.62, le: 7.46, c: 0.92, off: 0.24, t: 0.048 }
    ], { mirror: s < 0 }), M.panel);
  }
  // 平尾升降舵（可动）
  const elevators = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 0.52, TAIL_Y + 0.10, 8.16);
    grp.add(new THREE.Mesh(airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.52, off: 0.00, t: 0.060 },
      { p: 1.70, le: 0.10, c: 0.44, off: 0.05, t: 0.056 },
      { p: 3.60, le: 0.18, c: 0.34, off: 0.12, t: 0.050 }
    ], { mirror: s < 0 }), M.panel));
    shell.add(grp);
    elevators.push(grp);
  }
  // 双垂尾（外倾 6°）+ 方向舵（可动）
  const CANT = 0.10;
  const rudders = [];
  for (const s of [-1, 1]) {
    const finSpan = [Math.sin(CANT) * s, Math.cos(CANT), 0];
    const finThick = [Math.cos(CANT), -Math.sin(CANT) * s, 0];
    addMesh(airfoilSurface([
      { p: 0.00, le: 6.55, c: 2.16, off: 0, t: 0.075 },
      { p: 0.72, le: 6.88, c: 1.94, off: 0, t: 0.068 },
      { p: 1.46, le: 7.24, c: 1.62, off: 0, t: 0.060 },
      { p: 2.06, le: 7.56, c: 1.22, off: 0, t: 0.054 },
      { p: 2.42, le: 7.76, c: 0.86, off: 0, t: 0.050 }
    ], { span: finSpan, thick: finThick, samples: 10 }), M.panel).position.set(s * 3.86, TAIL_Y + 0.24, 0);
    // 垂尾顶队色
    const tip = boxM(0.085, 0.14, 0.78, M.acc, s * (3.86 + Math.sin(CANT) * 2.40), TAIL_Y + 0.24 + Math.cos(CANT) * 2.40, 8.10);
    tip.rotation.z = -s * CANT;
    // 方向舵
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 3.86, TAIL_Y + 0.24, 8.22);
    grp.add(new THREE.Mesh(airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.50, off: 0, t: 0.070 },
      { p: 0.90, le: 0.06, c: 0.42, off: 0, t: 0.064 },
      { p: 1.86, le: 0.10, c: 0.32, off: 0, t: 0.056 },
      { p: 2.30, le: 0.06, c: 0.22, off: 0, t: 0.050 }
    ], { span: finSpan, thick: finThick, samples: 8 }), M.panel));
    shell.add(grp);
    rudders.push(grp);
  }

  // ------------------------------------------------------- 炮塔 / 机枪 ----
  const muzzles = [];
  const mkGun = (x0, y0, z0, x1, y1, z1, r) => {
    const barrel = bar(x0, y0, z0, x1, y1, z1, r || 0.055, M.dark, 6);
    if (barrel) shell.add(barrel);
    muzzles.push(new THREE.Vector3(x1, y1, z1));
    return barrel;
  };
  // 机鼻 2×12.7mm 前射机枪
  for (const s of [-1, 1]) {
    boxM(0.26, 0.24, 0.34, M.dark, s * 0.30, -0.30, -8.62);
    mkGun(s * 0.30, -0.32, -8.66, s * 0.30, -0.34, -9.30, 0.048);
  }
  // 背部炮塔：半圆罩 + 双联装
  const topT = new THREE.Mesh(new THREE.SphereGeometry(0.54, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), M.panel);
  topT.position.set(0, 1.30, -3.30);
  shell.add(topT);
  for (const s of [-1, 1]) mkGun(s * 0.13, 1.52, -3.55, s * 0.13, 1.60, -4.40, 0.045);
  // 腹部球型炮塔
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 10, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55), M.panel);
  ball.position.set(0, -1.30, 1.95);
  shell.add(ball);
  for (const s of [-1, 1]) mkGun(s * 0.11, -1.42, 2.25, s * 0.11, -1.52, 2.95, 0.042);
  // 腰部机枪（两侧舷窗，向后）
  for (const s of [-1, 1]) {
    mkGun(s * 1.24, 0.10, 3.20, s * 1.30, 0.06, 3.95, 0.042);
  }

  // ---------------------------------------------------- 弹舱门 / 挂弹 ----
  // 舱内结构：五个面围出空腔（底面不封）
  // 如果用一个实心 Box，打开舱门只会看到一块黑砖，看不见里面的炸弹
  boxM(1.94, 0.06, 3.86, bayMat, 0, -0.60, 1.75);            // 顶
  for (const s of [-1, 1]) {
    boxM(0.06, 0.72, 3.86, bayMat, s * 0.94, -0.96, 1.75);   // 侧壁
  }
  boxM(1.94, 0.72, 0.06, bayMat, 0, -0.96, -0.18);           // 前壁
  boxM(1.94, 0.72, 0.06, bayMat, 0, -0.96, 3.68);            // 后壁
  const bayDoors = [];
  for (const s of [-1, 1]) {
    const d = new THREE.Group();
    d.userData.dyn = true;
    d.position.set(s * 0.98, -1.28, 1.75);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.07, 3.80), M.panel);
    panel.position.x = -s * 0.48;
    d.add(panel);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 3.84, 8), M.dark);
    hinge.rotation.x = Math.PI / 2;
    d.add(hinge);
    d.userData.sign = s;
    shell.add(d);
    bayDoors.push(d);
  }
  // 舱内 2 枚 500 磅航弹（投完就消失）
  const bombs = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Group();
    b.userData.dyn = true;
    b.position.set((i ? 1 : -1) * 0.46, -0.92, 1.05 + i * 1.42);
    const body = new THREE.Mesh(geoOnce('bmBombBody', () => {
      const geo = new THREE.CapsuleGeometry(0.27, 1.30, 4, 8);
      geo.rotateX(Math.PI / 2);
      return geo;
    }), M.dark);
    b.add(body);
    const fin = new THREE.Mesh(geoOnce('bmBombFin', () => new THREE.BoxGeometry(0.06, 0.42, 0.34)), M.metal);
    fin.position.z = 0.72;
    b.add(fin);
    shell.add(b);
    bombs.push(b);
  }
  // 机腹挂架 + 鱼雷（外部挂载，投完消失）
  const torpGrp = new THREE.Group();
  torpGrp.userData.dyn = true;
  torpGrp.position.set(0, -1.62, 1.30);
  const tpBody = new THREE.Mesh(geoOnce('bmTorpBody', () => {
    const geo = new THREE.CylinderGeometry(0.40, 0.40, 4.30, 14);
    geo.rotateX(Math.PI / 2);
    return geo;
  }), new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.52, metalness: 0.55, envMapIntensity: 0.8 }));
  torpGrp.add(tpBody);
  const tpNose = new THREE.Mesh(geoOnce('bmTorpNose', () => {
    const geo = new THREE.SphereGeometry(0.40, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }), M.metal);
  tpNose.position.z = -2.15;
  torpGrp.add(tpNose);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(geoOnce('bmTorpFin', () => new THREE.BoxGeometry(0.05, 0.52, 0.44)), M.metal);
    fin.position.set(Math.cos(i * Math.PI / 2) * 0.24, Math.sin(i * Math.PI / 2) * 0.24, 2.02);
    fin.rotation.z = i * Math.PI / 2;
    torpGrp.add(fin);
  }
  shell.add(torpGrp);
  // 挂架
  boxM(0.10, 0.30, 0.30, M.dark, -0.34, -1.34, 0.30);
  boxM(0.10, 0.30, 0.30, M.dark, 0.34, -1.34, 0.30);

  // ------------------------------------------------------------ 起落架 ----
  // 轮底必须落在 y = -2.70（物理 CONFIG.aircraft.gearHeight），否则落地会陷进地面
  const gear = new THREE.Group();
  gear.userData.dyn = true;
  shell.add(gear);
  const wheel = (r, w, x, y, z) => {
    const t = new THREE.Mesh(geoOnce('bmTire' + r, () => {
      const geo = new THREE.CylinderGeometry(r, r, w, 16);
      geo.rotateZ(Math.PI / 2);
      return geo;
    }), M.tire);
    t.position.set(x, y, z);
    gear.add(t);
    const hub = new THREE.Mesh(geoOnce('bmHub' + r, () => {
      const geo = new THREE.CylinderGeometry(r * 0.52, r * 0.52, w * 1.06, 12);
      geo.rotateZ(Math.PI / 2);
      return geo;
    }), M.metal);
    hub.position.set(x, y, z);
    gear.add(hub);
    return t;
  };
  // 前起落架
  const nWheelY = -2.70 + 0.40;
  gear.add(bar(0, -0.72, -6.05, 0, nWheelY, -6.05, 0.075, M.metal, 8));
  gear.add(bar(0, -0.72, -5.72, 0, -1.72, -6.02, 0.045, M.metal, 6));
  wheel(0.40, 0.24, 0, nWheelY, -6.05);
  for (const s of [-1, 1]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.72), M.panel);
    d.position.set(s * 0.19, -1.05, -6.10);
    d.rotation.z = s * 1.15;
    gear.add(d);
  }
  // 主起落架：收在发动机短舱里
  const mWheelY = -2.70 + 0.56;
  for (const s of [-1, 1]) {
    gear.add(bar(s * PROP_X, -0.62, 0.55, s * PROP_X, mWheelY, 0.55, 0.095, M.metal, 8));
    gear.add(bar(s * (PROP_X - 0.28), -0.66, 0.82, s * PROP_X, -1.62, 0.62, 0.048, M.metal, 6));
    wheel(0.56, 0.34, s * PROP_X, mWheelY, 0.55);
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.92, 1.10), M.panel);
    d.position.set(s * (PROP_X + 0.30), -1.28, 0.60);
    d.rotation.z = s * 0.92;
    gear.add(d);
  }

  // ------------------------------------------------------ 灯 / 天线 ----
  const nav = [
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.085, 8, 6)), glowMat(0xff2a18, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.085, 8, 6)), glowMat(0x22ff5a, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.065, 8, 6)), glowMat(0xffffff, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.065, 8, 6)), glowMat(0xff4030, 0.95))
  ];
  nav[0].position.set(-10.58, 1.20, 2.10);
  nav[1].position.set(10.58, 1.20, 2.10);
  nav[2].position.set(0, 0.55, 8.72);
  nav[3].position.set(0, -1.36, 3.60);
  for (const n of nav) shell.add(n);
  // 背鳍天线柱 + 到双垂尾的张线
  shell.add(bar(0, 1.14, -1.90, 0, 1.72, -1.55, 0.026, M.dark, 5));
  for (const s of [-1, 1]) {
    shell.add(bar(0, 1.70, -1.58, s * (3.86 + Math.sin(CANT) * 2.3), TAIL_Y + 0.24 + Math.cos(CANT) * 2.3, 7.95, 0.011, M.dark, 4));
  }
  // 空速管
  shell.add(bar(0, -0.10, -9.34, 0, -0.10, -9.95, 0.021, M.metal, 5));

  // -------------------------------------------------------------- 尾焰 ----
  // 活塞机没有加力：只在大油门时给排气口一圈短促的橙黄火舌 + 喷口辉光
  const nozMat = new THREE.MeshBasicMaterial({
    color: 0xffa860, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const mkFlameSet = (x, y, z) => {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(x, y, z);
    grp.visible = false;
    const mkLayer = (r, len, col, op) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, len, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.geometry.rotateX(Math.PI / 2);
      m.geometry.translate(0, 0, len / 2);
      grp.add(m);
      return m;
    };
    const layers = [
      mkLayer(0.16, 0.62, 0xff5a14, 0.16),
      mkLayer(0.10, 0.40, 0xffa63c, 0.26),
      mkLayer(0.05, 0.24, 0xfff1c8, 0.60)
    ];
    shell.add(grp);
    return { grp, layers, dia: [], noz: [x, y, z + 0.5] };
  };
  const flameSets = [
    mkFlameSet(-PROP_X, PROP_Y - 0.52, -0.30),
    mkFlameSet(PROP_X, PROP_Y - 0.52, -0.30)
  ];
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(geoOnce('bmNozRing', () => new THREE.TorusGeometry(0.16, 0.05, 5, 12)), nozMat);
    ring.position.set(s * PROP_X, PROP_Y - 0.52, -0.28);
    shell.add(ring);
  }

  // ---------------------------------------------------- 机炮火光（前射）----
  const gunFlash = [];
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.36, 5), glowMat(0xffe6b8, 0.85));
    f.geometry.rotateX(-Math.PI / 2);
    f.geometry.translate(0, 0, -0.18);
    f.position.set(s * 0.30, -0.34, -9.34);
    f.visible = false;
    g.add(f);
    gunFlash.push(f);
  }

  // -------------------------------------------- 静态网格合批（60→6 draw call）----
  mergeStatic(shell, [M.body, M.panel, M.dark, M.metal, M.hot, M.acc, bayMat]);

  g.traverse((o) => {
    if (o.isMesh && o.userData.dyn !== undefined) { /* 动态件照常投影 */ }
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  g.userData = {
    shell, nav, gear,
    props, bayDoors, bayT: 0, bayOpen: 0, lastTw: -1, lastBw: -1,
    bombs, torpMesh: torpGrp,
    ailerons, elevators, rudders,
    flameSets,
    flame: flameSets[0].grp, flameLayers: flameSets[0].layers, flameDia: [],
    nozGlow: { material: nozMat },
    muzzle: muzzles,
    gunFlash, gunFlashT: 0,
    cockpit: null
  };
  return g;
}
