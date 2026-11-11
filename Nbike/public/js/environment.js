/* =============================================================================
 * Nbike · js/environment.js
 * 环法风格山间赛道环境：天空 / 日照 / 路面 / 护栏 / 植被 / 人群 / 拱门 / 里程牌
 *
 * ── 关键约束（改动前务必先读）────────────────────────────────────────────
 *   · 路面严格沿 shared/track.js 的中心线走：posAt(s, lateral) 同时给出
 *     平面位置与路面高程，因此路带与物理赛道【逐点重合】，不会错位。
 *   · 地形在 |dist| ≤ CORRIDOR(8.4m) 内严格等于路面高程（见 terrain.js），
 *     而路带最宽到 ±5.7m ⇒ 与地形共面。故路带整体抬升 ROAD_LIFT 并加
 *     polygonOffset，否则必 z-fighting。
 *   · 所有撒点（树/石/草/人）都用 Terrain.heightAt() 求地面高度，
 *     并用 DISTFIELD 做净空判断，保证不穿路、不悬空。
 * ========================================================================== */
import * as THREE from '../lib/three.module.js';
import * as Terrain from './terrain.js';

const C = window.NB.C;
const Track = window.NB.Track;

const ROAD_LIFT = 0.045;          // 路面相对地形抬升（防 z-fighting，兼作面层厚度）
const HALF = C.WORLD.LANE_HALF;   // 4.2 m 半路宽
const SHOULDER = C.WORLD.SHOULDER; // 1.5 m 路肩

/* ---------------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 世界点地面高度（含路面抬升，撒点时用这个才不会悬空） */
function groundY(x, z) { return Terrain.heightAt(x, z); }

/** ★ 撒点筛选用的廉价高度：径向口径，不做牛顿迭代。
 *  heightAt 要 2.6µs（含 5 次牛顿迭代），这个只要 0.33µs —— 相差 8 倍。
 *  撒点是概率性的，筛选阶段用近似完全够；只有【最终落点】才调 groundY 求精确值，
 *  否则 11k 棵树的 8 次试探会把加载时间拖到秒级。 */
function approxY(x, z) {
  const r = Terrain.polarOf(x, z);
  return Terrain.heightAtTheta(r.theta, r.dist);
}

/** 地面法向的近似坡度（0 = 平地，1 = 45°），用廉价高度算，供撒点筛选 */
function slopeAt(x, z, r = 4) {
  const hx = approxY(x + r, z) - approxY(x - r, z);
  const hz = approxY(x, z + r) - approxY(x, z - r);
  return Math.hypot(hx, hz) / (2 * r);
}

/* ---------------------------------------------------------------------------
 * 1. 天空穹顶（渐变 + 太阳辉光）
 * ------------------------------------------------------------------------ */
export function buildSky() {
  const geo = new THREE.SphereGeometry(9000, 40, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x1d5fa8) },
      midColor: { value: new THREE.Color(0x69a4dc) },
      botColor: { value: new THREE.Color(0xd6e2ea) },
      sunDir: { value: new THREE.Vector3(0.55, 0.62, -0.56).normalize() },
      sunColor: { value: new THREE.Color(0xfff3d6) },
      hazeColor: { value: new THREE.Color(0xc8d3dc) }
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor, midColor, botColor, sunColor, hazeColor;
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);
        // 天顶 → 地平渐变
        vec3 col = mix(midColor, topColor, pow(clamp(h, 0.0, 1.0), 0.62));
        col = mix(botColor, col, smoothstep(-0.10, 0.28, h));
        // 地平线霾带
        col = mix(col, hazeColor, (1.0 - smoothstep(-0.02, 0.10, abs(h - 0.02))) * 0.42);
        // 太阳
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * pow(s, 320.0) * 1.5;
        col += sunColor * pow(s, 8.0) * 0.16;
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/* ---------------------------------------------------------------------------
 * 2. 远山剪影环（地平线层次，让远处不空）
 * ------------------------------------------------------------------------ */
export function buildFarRidge(seed = 7) {
  const rnd = mulberry32(seed);
  const SEG = 260;
  const R0 = 6200;
  const pos = [], col = [], idx = [];
  const colTop = new THREE.Color(0x7c93ad);
  const colBot = new THREE.Color(0xa9bccb);
  const c = new THREE.Color();

  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    // 多频叠加造出连绵雪线山峰
    let peak = 900
      + 520 * Math.sin(a * 3.1 + seed)
      + 380 * Math.sin(a * 7.3 + seed * 2.1)
      + 220 * Math.sin(a * 13.7 + seed * 0.7)
      + 140 * Math.sin(a * 23.1 + seed * 3.3);
    peak = Math.max(320, peak);
    const rr = R0 + 420 * Math.sin(a * 5.0 + seed);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    pos.push(x, -600, z); c.copy(colBot); col.push(c.r, c.g, c.b);
    pos.push(x, peak, z);
    // 峰顶泛白（远景雪）
    c.copy(colTop).lerp(new THREE.Color(0xe6eef6), clamp((peak - 1300) / 900, 0, 0.85));
    col.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2, b = a + 1, d = a + 2, e = a + 3;
    idx.push(a, d, b, b, d, e);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: true });
  const m = new THREE.Mesh(geo, mat);
  m.name = 'farRidge';
  m.frustumCulled = false;
  return m;
}

/* ---------------------------------------------------------------------------
 * 3. 路面（沿中心线放样）+ 边线 + 起终点
 * ------------------------------------------------------------------------ */
/* 横向断面：位置 / 颜色 / 是否沥青（决定粗糙度感） */
const CROSS = (() => {
  const asphA = 0x3b3f45, asphB = 0x474c52, wear = 0x50555c;
  const line = 0xdedbd2, grav = 0x8e8779, gravD = 0x7c7568;
  return [
    { lat: -(HALF + SHOULDER), hex: gravD },
    { lat: -(HALF + 0.13), hex: grav },
    { lat: -(HALF + 0.12), hex: line },   // 内侧白边线
    { lat: -(HALF - 0.01), hex: line },
    { lat: -HALF, hex: asphA },
    { lat: -(HALF * 0.52), hex: asphB },
    { lat: 0, hex: wear },                // 车辙磨亮带
    { lat: HALF * 0.52, hex: asphB },
    { lat: HALF, hex: asphA },
    { lat: HALF - 0.01, hex: line },
    { lat: HALF + 0.12, hex: line },      // 外侧白边线
    { lat: HALF + 0.13, hex: grav },
    { lat: HALF + SHOULDER, hex: gravD }
  ];
})();

export function buildRoad() {
  const every = 2;                       // 采样抽稀
  const step = Track.STEP * every;
  const n = Math.floor(Track.COUNT / every);
  const rows = CROSS.length;
  const vCount = (n + 1) * rows;
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = [];
  const c = new THREE.Color();
  const rnd = mulberry32(99);
  // 每列共享一个噪声扰动，避免条纹割裂
  const jitter = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) jitter[i] = (rnd() - 0.5) * 0.055;

  let vi = 0;
  for (let i = 0; i <= n; i++) {
    const s = (i * step) % Track.PERIM;
    for (let r = 0; r < rows; r++) {
      const p = Track.posAt(s, CROSS[r].lat);
      pos[vi * 3] = p.x;
      pos[vi * 3 + 1] = p.y + ROAD_LIFT;
      pos[vi * 3 + 2] = p.z;
      c.setHex(CROSS[r].hex);
      const j = 1 + jitter[i] + (rnd() - 0.5) * 0.03;
      col[vi * 3] = clamp(c.r * j, 0, 1);
      col[vi * 3 + 1] = clamp(c.g * j, 0, 1);
      col[vi * 3 + 2] = clamp(c.b * j, 0, 1);
      vi++;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r, b = a + 1;
      const d = (i + 1) * rows + r, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0.02,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const m = new THREE.Mesh(geo, mat);
  m.name = 'road';
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

/* ---------------------------------------------------------------------------
 * 4. 起终点线 / 拱门 / 里程牌
 * ------------------------------------------------------------------------ */
function checkerTexture(cols = 12, rows = 3) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  const cw = cv.width / cols, ch = cv.height / rows;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      g.fillStyle = ((x + y) & 1) ? '#f4f4ef' : '#1d1f22';
      g.fillRect(x * cw, y * ch, cw, ch);
    }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** 横幅贴图（环法式黄底 / 赞助色） */
function bannerTexture(text, bg = '#ffd200', fg = '#101418') {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = 'rgba(0,0,0,0.14)';
  g.fillRect(0, cv.height - 12, cv.width, 12);
  g.fillStyle = fg;
  g.font = 'bold 76px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, cv.width / 2, cv.height / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

function placeAtTrack(obj, s, lateral, yOff = 0) {
  const p = Track.posAt(s, lateral);
  obj.position.set(p.x, p.y + yOff, p.z);
  obj.rotation.y = Math.atan2(p.tx, p.tz);
  return p;
}

/** 起终点：地面格纹 + 两侧塔架 + 顶棚横幅 */
export function buildStartFinish(s = 0, label = 'START / FINISH') {
  const g = new THREE.Group();
  g.name = 'startFinish';

  /* 地面格纹 */
  {
    const tex = checkerTexture();
    const geo = new THREE.PlaneGeometry(HALF * 2 + 0.4, 1.6);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    const p = Track.posAt(s, 0);
    m.position.set(p.x, p.y + ROAD_LIFT + 0.012, p.z);
    m.rotation.z = -Math.atan2(p.tx, p.tz);
    // 注意：PlaneGeometry 已绕 X 转 -90°，其局部 +Y 对应世界 -Z，故用 rotation.z 对齐
    g.add(m);
  }

  /* 两侧塔架 */
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2e34, metalness: 0.55, roughness: 0.4 });
  const POLE_X = HALF + 1.35, POLE_H = 5.4;
  for (const sx of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, POLE_H, 10), poleMat);
    placeAtTrack(pole, s, sx * POLE_X, POLE_H / 2);
    pole.castShadow = true;
    g.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 0.22, 12), poleMat);
    placeAtTrack(base, s, sx * POLE_X, 0.11);
    g.add(base);
  }
  /* 顶棚横梁 + 横幅 */
  {
    const p = Track.posAt(s, 0);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(POLE_X * 2 + 0.4, 0.52, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x23272c, metalness: 0.5, roughness: 0.45 }));
    beam.position.set(p.x, p.y + ROAD_LIFT + POLE_H - 0.26, p.z);
    beam.rotation.y = Math.atan2(p.tx, p.tz);
    beam.castShadow = true;
    g.add(beam);

    const bTex = bannerTexture(label);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(POLE_X * 2 + 0.2, 1.15),
      new THREE.MeshStandardMaterial({ map: bTex, side: THREE.DoubleSide, roughness: 0.72 }));
    banner.position.set(p.x, p.y + ROAD_LIFT + POLE_H - 1.28, p.z);
    banner.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI / 2;
    g.add(banner);

    // 另一面（背向朝向来车）
    const banner2 = banner.clone();
    banner2.rotation.y += Math.PI;
    g.add(banner2);
  }
  return g;
}

/** 里程牌：每 1 km 一个白柱绿牌 */
export function buildKmMarkers(seed = 21) {
  const g = new THREE.Group();
  g.name = 'kmMarkers';
  const km = Math.floor(Track.PERIM / 1000);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e2, roughness: 0.8 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x1c7a3a, roughness: 0.75 });
  const geoPost = new THREE.BoxGeometry(0.13, 1.0, 0.07);
  const geoCap = new THREE.BoxGeometry(0.30, 0.11, 0.08);
  const rnd = mulberry32(seed);
  for (let k = 1; k <= km; k++) {
    const s = (k * 1000) % Track.PERIM;
    const side = (rnd() < 0.5 ? -1 : 1) * (HALF + 1.0);
    const post = new THREE.Mesh(geoPost, postMat);
    placeAtTrack(post, s, side, 0.5);
    post.castShadow = true;
    g.add(post);
    const cap = new THREE.Mesh(geoCap, capMat);
    placeAtTrack(cap, s, side, 1.03);
    g.add(cap);
  }
  return g;
}

/* ---------------------------------------------------------------------------
 * 5. 护栏（在路肩外有落差处自动生成）
 * ------------------------------------------------------------------------ */
export function buildGuardrails(seed = 5) {
  const g = new THREE.Group();
  g.name = 'guardrails';
  const SEG = 6;                                   // 沿赛道每 6 m 判一次
  const n = Math.floor(Track.PERIM / SEG);
  const postGeo = new THREE.BoxGeometry(0.09, 0.78, 0.09);
  const railGeo = new THREE.BoxGeometry(0.07, 0.30, SEG * 1.02);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.72, roughness: 0.42 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xb6bcc2, metalness: 0.78, roughness: 0.34 });

  const posts = [], rails = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const s = i * SEG;
    for (const side of [-1, 1]) {
      const lat = side * (HALF + 0.78);
      const p = Track.posAt(s, lat);
      // 向外 14 m 处的地面落差
      const q = Track.posAt(s, side * 16);
      const drop = p.y - groundY(q.x, q.z);
      if (drop < 2.2) continue;                     // 没有悬崖就不装护栏
      const key = Math.round(p.x / 3) + '|' + Math.round(p.z / 3) + '|' + side;
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push({ x: p.x, y: p.y + 0.39 + ROAD_LIFT, z: p.z, ry: Math.atan2(p.tx, p.tz) });
      rails.push({ x: p.x, y: p.y + 0.62 + ROAD_LIFT, z: p.z, ry: Math.atan2(p.tx, p.tz) });
    }
  }
  const iPost = new THREE.InstancedMesh(postGeo, postMat, posts.length);
  const iRail = new THREE.InstancedMesh(railGeo, railMat, rails.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  posts.forEach((o, i) => {
    e.set(0, o.ry, 0); q.setFromEuler(e);
    m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(1, 1, 1));
    iPost.setMatrixAt(i, m);
  });
  rails.forEach((o, i) => {
    e.set(0, o.ry, 0); q.setFromEuler(e);
    m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(1, 1, 1));
    iRail.setMatrixAt(i, m);
  });
  iPost.instanceMatrix.needsUpdate = true;
  iRail.instanceMatrix.needsUpdate = true;
  iPost.castShadow = iRail.castShadow = true;
  iPost.frustumCulled = iRail.frustumCulled = false;
  g.add(iPost, iRail);
  g.userData.count = posts.length;
  return g;
}

/* ---------------------------------------------------------------------------
 * 6. 植被 / 岩石 / 草丛（全部 InstancedMesh，一次绘制）
 * ------------------------------------------------------------------------ */
export function buildVegetation(opts = {}) {
  const g = new THREE.Group();
  g.name = 'vegetation';
  const rnd = mulberry32(opts.seed || 1234);
  const B = Track.BOUNDS;
  const TREE_N = opts.trees || 4200;
  const ROCK_N = opts.rocks || 1300;
  const GRASS_N = opts.grass || 5200;

  const treeLine = Terrain.ELEV.hi + 210;          // 林线
  const snowNear = Terrain.ELEV.hi + 300;

  /* ---- 针叶树：锥形树冠 + 树干 ---- */
  const treePos = [];
  let guard = 0;
  while (treePos.length < TREE_N && guard++ < TREE_N * 40) {
    const x = B.minX + rnd() * (B.maxX - B.minX);
    const z = B.minZ + rnd() * (B.maxZ - B.minZ);
    const d = Terrain.DISTFIELD.distToTrack(x, z);
    if (d < 15) continue;                          // 太靠路
    const y = approxY(x, z);                       // 廉价筛选
    if (y > treeLine || y < Terrain.ELEV.lo - 60) continue;
    /* 坡度过陡（岩壁）不长树。阈值放到 1.15（≈49°）：
     * 内侧山体均值 tan≈1.1，收太紧会整片裸岩，反而失真。 */
    if (slopeAt(x, z, 5) > 1.15) continue;
    // 海拔越高越稀疏
    const dens = 1 - clamp((y - (Terrain.ELEV.lo + 40)) / (treeLine - Terrain.ELEV.lo), 0, 1) * 0.72;
    if (rnd() > dens) continue;
    /* 落定：这里才求精确高度（每棵树一次），保证不悬空/不陷地 */
    treePos.push({ x, y: groundY(x, z), z, sc: 0.62 + rnd() * 0.85, ry: rnd() * Math.PI * 2 });
  }
  {
    const foliage = new THREE.ConeGeometry(1.75, 8.4, 7, 3);
    foliage.translate(0, 8.4 / 2 + 1.35, 0);
    const trunk = new THREE.CylinderGeometry(0.16, 0.24, 1.7, 5);
    trunk.translate(0, 0.85, 0);
    const fMat = new THREE.MeshStandardMaterial({ color: 0x2f5233, roughness: 0.92, flatShading: true });
    const tMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2b, roughness: 0.95 });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const t1 = new THREE.InstancedMesh(foliage, fMat, treePos.length);
    const t2 = new THREE.InstancedMesh(trunk, tMat, treePos.length);
    t1.name = 'treeFoliage'; t2.name = 'treeTrunk';
    treePos.forEach((o, i) => {
      e.set(0, o.ry, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(o.sc, o.sc * (0.85 + o.sc * 0.3), o.sc));
      t1.setMatrixAt(i, m); t2.setMatrixAt(i, m);
    });
    t1.instanceMatrix.needsUpdate = true; t2.instanceMatrix.needsUpdate = true;
    t1.castShadow = true; t1.frustumCulled = false;
    t2.castShadow = true; t2.frustumCulled = false;
    g.add(t1, t2);
    g.userData.trees = treePos.length;
  }

  /* ---- 岩石 ---- */
  {
    const rp = [];
    let gd = 0;
    while (rp.length < ROCK_N && gd++ < ROCK_N * 40) {
      const x = B.minX + rnd() * (B.maxX - B.minX);
      const z = B.minZ + rnd() * (B.maxZ - B.minZ);
      const d = Terrain.DISTFIELD.distToTrack(x, z);
      if (d < 11) continue;
      const y = approxY(x, z);                     // 廉价筛选
      const sl = slopeAt(x, z, 5);
      const high = clamp((y - (Terrain.ELEV.lo + 180)) / (snowNear - Terrain.ELEV.lo), 0, 1);
      if (rnd() > 0.28 + high * 0.6 + sl * 0.35) continue;
      rp.push({ x, y: groundY(x, z), z, sc: 0.6 + rnd() * 2.6, ry: rnd() * 6.28, rx: rnd() * 0.6 });
    }
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6c685f, roughness: 0.96, flatShading: true });
    const im = new THREE.InstancedMesh(geo, mat, rp.length);
    im.name = 'rocks';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    rp.forEach((o, i) => {
      e.set(o.rx, o.ry, o.rx * 0.5); q.setFromEuler(e);
      m.compose(new THREE.Vector3(o.x, o.y + o.sc * 0.25, o.z), q,
        new THREE.Vector3(o.sc, o.sc * 0.72, o.sc * 1.15));
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.frustumCulled = false;
    g.add(im);
    g.userData.rocks = rp.length;
  }

  /* ---- 路旁草丛（交叉面片，只在近路带） ---- */
  {
    const gp = [];
    let gd = 0;
    while (gp.length < GRASS_N && gd++ < GRASS_N * 30) {
      const s = rnd() * Track.PERIM;
      const side = rnd() < 0.5 ? -1 : 1;
      const lat = side * (6.2 + rnd() * 26);
      const p = Track.posAt(s, lat);
      const y = groundY(p.x, p.z);
      /* 草丛紧贴路旁（lat 6.2~32m），此处径向口径与精确值差异极小，
       * 但为了"看得见的近景不穿帮"，这里保留精确高度。 */
      if (Math.abs(y - p.y) > 26) continue;
      if (slopeAt(p.x, p.z, 3) > 0.8) continue;
      gp.push({ x: p.x, y, z: p.z, sc: 0.5 + rnd() * 0.9, ry: rnd() * 6.28 });
    }
    const blade = new THREE.BufferGeometry();
    const w = 0.34, h = 0.72;
    blade.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w, 0, 0, w, 0, 0, w, h, 0, -w, 0, 0, w, h, 0, -w, h, 0
    ]), 3));
    blade.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1
    ]), 3));
    const mat = new THREE.MeshStandardMaterial({
      color: 0x63813f, roughness: 0.95, side: THREE.DoubleSide
    });
    const im = new THREE.InstancedMesh(blade, mat, gp.length);
    im.name = 'grass';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    gp.forEach((o, i) => {
      e.set(0, o.ry, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(o.sc, o.sc, o.sc));
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    g.add(im);
    g.userData.grass = gp.length;
  }

  return g;
}

/* ---------------------------------------------------------------------------
 * 7. 观众（爬坡段路边人墙 + 隔离栏）
 * ------------------------------------------------------------------------ */
export function buildCrowd(seed = 88) {
  const g = new THREE.Group();
  g.name = 'crowd';
  const rnd = mulberry32(seed);
  const people = [];
  const fences = [];

  /* 爬坡段与终点前 800 m 最热闹 */
  const hotspots = [];
  for (const c of Track.CLIMBS) {
    const len = c.s1 > c.s0 ? c.s1 - c.s0 : (Track.PERIM - c.s0 + c.s1);
    const k = Math.max(2, Math.round(len / 420));
    for (let i = 0; i < k; i++) hotspots.push(Track.normS(c.s0 + len * (i / k) + rnd() * 120));
  }
  for (let i = 0; i < 5; i++) hotspots.push(Track.normS(Track.PERIM - 700 + i * 150));

  const COLORS = C.RIDER_COLORS;
  for (const hs of hotspots) {
    const cnt = 46 + Math.floor(rnd() * 46);
    const side = rnd() < 0.5 ? -1 : 1;
    const both = rnd() < 0.35;
    for (let i = 0; i < cnt; i++) {
      const s = Track.normS(hs + (rnd() - 0.5) * 190);
      const sd = both ? (rnd() < 0.5 ? -1 : 1) : side;
      const lat = sd * (HALF + 1.25 + rnd() * 4.2);
      const p = Track.posAt(s, lat);
      const gy = groundY(p.x, p.z);
      people.push({
        x: p.x, y: Math.max(gy, p.y - 1.2), z: p.z,
        ry: Math.atan2(p.tx, p.tz) + (sd > 0 ? -Math.PI / 2 : Math.PI / 2),
        sc: 0.9 + rnd() * 0.28,
        col: COLORS[Math.floor(rnd() * COLORS.length)],
        armed: rnd() < 0.28
      });
      // 隔离栏
      if (i % 3 === 0) {
        fences.push({ x: p.x, y: p.y + ROAD_LIFT, z: p.z, ry: Math.atan2(p.tx, p.tz), side: sd });
      }
    }
  }

  /* 人：身体（胶囊）+ 头（球），用实例化颜色区分 */
  {
    const bodyGeo = new THREE.CapsuleGeometry(0.20, 0.62, 3, 8);
    bodyGeo.translate(0, 0.72, 0);
    const headGeo = new THREE.SphereGeometry(0.15, 8, 6);
    headGeo.translate(0, 1.34, 0);
    const bMat = new THREE.MeshStandardMaterial({ roughness: 0.86 });
    const hMat = new THREE.MeshStandardMaterial({ color: 0xd8b18c, roughness: 0.82 });
    const body = new THREE.InstancedMesh(bodyGeo, bMat, people.length);
    const head = new THREE.InstancedMesh(headGeo, hMat, people.length);
    body.name = 'crowdBody'; head.name = 'crowdHead';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const cc = new THREE.Color();
    people.forEach((o, i) => {
      e.set(0, o.ry, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(o.sc, o.sc, o.sc));
      body.setMatrixAt(i, m); head.setMatrixAt(i, m);
      cc.setHex(parseInt(o.col.replace('#', '0x'), 16));
      body.setColorAt(i, cc);
      // 举起的手臂
      if (o.armed) {
        const up = new THREE.Vector3(0, 1, 0);
        void up;
      }
    });
    body.instanceMatrix.needsUpdate = true; head.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    body.castShadow = head.castShadow = true;
    body.frustumCulled = head.frustumCulled = false;
    g.add(body, head);
    g.userData.people = people.length;
  }

  /* 隔离栏 */
  if (fences.length) {
    const fGeo = new THREE.BoxGeometry(0.06, 1.02, 2.9);
    const fMat = new THREE.MeshStandardMaterial({ color: 0xd8d9db, metalness: 0.35, roughness: 0.6 });
    const im = new THREE.InstancedMesh(fGeo, fMat, fences.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    fences.forEach((o, i) => {
      e.set(0, o.ry, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(o.x, o.y + 0.51, o.z), q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.frustumCulled = false;
    g.add(im);
    g.userData.fences = fences.length;
  }
  return g;
}

/* ---------------------------------------------------------------------------
 * 8. 光照
 * ------------------------------------------------------------------------ */
export function buildLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbcd7f0, 0x5d6350, 0.62);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.05);
  const dir = new THREE.Vector3(0.55, 0.62, -0.56).normalize();
  sun.position.copy(dir).multiplyScalar(320);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 95;                                    // 阴影相机覆盖半径（跟随车手）
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 40; sun.shadow.camera.far = 720;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.32;
  scene.add(sun);
  scene.add(sun.target);

  const amb = new THREE.AmbientLight(0x9fb4c8, 0.22);
  scene.add(amb);
  return { hemi, sun, dir, ambient: amb };
}

/* ---------------------------------------------------------------------------
 * 9. 总装
 * ------------------------------------------------------------------------ */
export function buildEnvironment(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'envMain';

  const sky = buildSky();
  scene.add(sky);

  const ridge = buildFarRidge(11);
  group.add(ridge);

  const lights = buildLights(scene);

  const road = buildRoad();
  group.add(road);

  const rails = buildGuardrails();
  group.add(rails);

  const vegetation = buildVegetation({ seed: 2468 });
  group.add(vegetation);

  const crowd = buildCrowd();
  group.add(crowd);

  const sf = buildStartFinish(0, 'START  FINISH');
  group.add(sf);

  const km = buildKmMarkers();
  group.add(km);

  scene.add(group);

  /* 阴影相机跟随（保证近处阴影分辨率） */
  const tmp = new THREE.Vector3();
  function updateShadow(targetVec) {
    lights.sun.target.position.copy(targetVec);
    lights.sun.position.copy(targetVec).addScaledVector(lights.dir, 320);
    lights.sun.target.updateMatrixWorld();
    lights.sun.updateMatrixWorld();
    tmp.copy(targetVec);
  }
  function updateSky(camPos) {
    sky.position.copy(camPos);
    ridge.position.set(camPos.x, 0, camPos.z);
  }

  const stats = {
    buildMs: performance.now() - t0,
    roadTris: road.geometry.index.count / 3,
    rails: rails.userData.count,
    trees: vegetation.userData.trees,
    rocks: vegetation.userData.rocks,
    grass: vegetation.userData.grass,
    people: crowd.userData.people
  };

  return { group, sky, road, rails, vegetation, crowd, startFinish: sf, km, lights, updateShadow, updateSky, stats };
}
