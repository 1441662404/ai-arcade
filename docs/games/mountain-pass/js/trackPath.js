/**
 * 霧見山下坡 — 賽道中心線（純數學，瀏覽器與 Node 共用）
 *
 * 座標：X 向東、Z 向南、Y 向上。
 * 以手工路點 + 向心 Catmull-Rom 建立中心線，彎道半徑、坡度與超高皆可驗證。
 */

export const ROAD = {
  laneWidth: 3.55,
  halfWidth: 3.55,
  shoulder: 1.05,
  get edge() { return this.halfWidth + this.shoulder; },
  get fullWidth() { return this.edge * 2; },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export { clamp };

/* ------------------------------------------------------------------ */
/*  路點表：霧見山下坡（山頂 → 五連髮夾彎 → 長直線 → 防雪棚 → 終點）    */
/* ------------------------------------------------------------------ */
export const WAYPOINTS = [
  // ① 山頂起步直線
  [0, 0], [2, 70], [10, 150], [30, 235],
  // ② 東南向高速 S 彎
  [70, 320], [140, 392], [230, 445], [330, 480], [430, 508],
  // ③ 貼山壁的左彎（霧見山第一個高速彎）
  [530, 545], [615, 600], [680, 678], [715, 775], [720, 880],
  // ④ 進髮夾彎前的右彎
  [700, 962], [655, 1015], [592, 1042], [520, 1048],
  // ⑤ 五連髮夾彎（東西向階梯）
  [470, 1050],
  [430, 1053], [408, 1066], [410, 1080], [438, 1088],   // 髮夾 1（西端）
  [500, 1090], [575, 1090],
  [625, 1092], [648, 1105], [646, 1119], [618, 1127],   // 髮夾 2（東端）
  [560, 1129], [490, 1129],
  [448, 1131], [426, 1144], [428, 1158], [456, 1166],   // 髮夾 3（西端）
  [520, 1168], [590, 1168],
  [640, 1170], [663, 1183], [661, 1197], [633, 1205],   // 髮夾 4（東端）
  [575, 1207], [505, 1207],
  [463, 1209], [441, 1222], [443, 1236], [471, 1244],   // 髮夾 5（西端）
  [530, 1246], [600, 1246],
  // ⑥ 出彎後轉向南，中速段
  [660, 1252], [712, 1285], [745, 1345], [752, 1425],
  // ⑦ 長直線（FR-86 拼極速）
  [748, 1520], [742, 1620], [738, 1720], [736, 1810],
  // ⑧ 高速左彎進入防雪棚
  [728, 1890], [700, 1965], [650, 2025], [585, 2065],
  // ⑨ 防雪棚直線
  [500, 2085], [400, 2092], [300, 2094],
  // ⑩ 出棚後的連續彎
  [210, 2090], [130, 2070], [70, 2030], [30, 1970],
  // ⑪ 終段下坡衝刺
  [10, 1890], [4, 1800], [8, 1705], [30, 1620],
  [75, 1550], [140, 1500], [220, 1472], [300, 1465],
];

/* 坡度關鍵點（弧長比例 → 坡度，負值為下坡） */
const GRADE_KEYS = [
  [0.00, -0.030],
  [0.07, -0.052],
  [0.15, -0.070],
  [0.22, -0.095],
  [0.30, -0.108],
  [0.38, -0.100],
  [0.46, -0.070],
  [0.54, -0.052],
  [0.63, -0.088],
  [0.72, -0.045],
  [0.80, -0.078],
  [0.90, -0.052],
  [1.00, -0.030],
];

function gradeAt(t) {
  for (let i = 0; i < GRADE_KEYS.length - 1; i++) {
    const [t0, g0] = GRADE_KEYS[i];
    const [t1, g1] = GRADE_KEYS[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / Math.max(1e-6, t1 - t0);
      const s = k * k * (3 - 2 * k);
      return g0 + (g1 - g0) * s;
    }
  }
  return GRADE_KEYS[GRADE_KEYS.length - 1][1];
}

/* ------------------------------------------------------------------ */
/*  向心 Catmull-Rom                                                  */
/* ------------------------------------------------------------------ */
function catmullRom(pts, samplesPerSeg = 60) {
  const out = [];
  const P = (i) => pts[clamp(i, 0, pts.length - 1)];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d1 = Math.max(1e-4, Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
    const d2 = Math.max(1e-4, Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
    const d3 = Math.max(1e-4, Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])));
    const t0 = 0, t1 = t0 + d1, t2 = t1 + d2, t3 = t2 + d3;
    const n = i === pts.length - 2 ? samplesPerSeg : samplesPerSeg;
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const A1 = lerpP(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
      const A2 = lerpP(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      const A3 = lerpP(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
      const B1 = lerpP(A1, A2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
      const B2 = lerpP(A2, A3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
      const C = lerpP(B1, B2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      out.push(C);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}
const lerpP = (a, b, wa, wb) => [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];

/* ------------------------------------------------------------------ */
/*  建構中心線                                                        */
/* ------------------------------------------------------------------ */
export function buildCenterline(step = 2.0) {
  const dense = catmullRom(WAYPOINTS, 90);

  // 等距重取樣
  const pts = [{ x: dense[0][0], z: dense[0][1], s: 0 }];
  let acc = 0;
  let prev = dense[0];
  for (let i = 1; i < dense.length; i++) {
    const p = dense[i];
    const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (d < 1e-9) { prev = p; continue; }
    acc += d;
    while (acc >= step) {
      acc -= step;
      const t = 1 - acc / d;
      pts.push({ x: prev[0] + (p[0] - prev[0]) * t, z: prev[1] + (p[1] - prev[1]) * t, s: 0 });
    }
    prev = p;
  }
  const total = (pts.length - 1) * step;
  for (let i = 0; i < pts.length; i++) pts[i].s = i * step;

  // 高程
  let y = 322;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) y += gradeAt((i * step) / total) * step;
    pts[i].y = y;
  }
  const ys = smoothArray(pts.map((p) => p.y), 10);
  for (let i = 0; i < pts.length; i++) pts[i].y = ys[i];

  // 切線
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    pts[i].tx = tx; pts[i].tz = tz;
    pts[i].nx = tz; pts[i].nz = -tx; // 右向量
  }

  // 曲率（三點外接圓）
  const W = Math.round(9 / step);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - W)], b = pts[i], c = pts[Math.min(n - 1, i + W)];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area2 = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
    const denom = ab * bc * ca;
    let k = denom > 1e-6 ? (2 * area2) / denom : 0;
    k = clamp(k, -0.5, 0.5);
    pts[i].curv = k;
  }
  const ks = smoothArray(pts.map((p) => p.curv), 6);
  for (let i = 0; i < n; i++) {
    pts[i].curv = ks[i];
    pts[i].bank = clamp(-ks[i] * 34, -0.08, 0.08);
  }
  const bs = smoothArray(pts.map((p) => p.bank), 8);
  for (let i = 0; i < n; i++) pts[i].bank = bs[i];

  // 防雪棚 / 隧道段（依弧長比例）
  const galleries = [
    { tag: 'gallery', from: 0, to: 0 },
  ];
  const gSpecs = [
    { tag: 'gallery', t0: 0.735, t1: 0.795 },
  ];
  galleries.length = 0;
  for (const g of gSpecs) {
    galleries.push({
      tag: g.tag,
      from: Math.round((g.t0 * total) / step),
      to: Math.round((g.t1 * total) / step),
    });
  }

  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }

  return { samples: pts, step, length: total, count: n, galleries, bounds: { minX, maxX, minZ, maxZ, minY, maxY } };
}

function smoothArray(arr, rad) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, w = 0;
    for (let k = -rad; k <= rad; k++) {
      const j = clamp(i + k, 0, arr.length - 1);
      const ww = 1 - Math.abs(k) / (rad + 1);
      sum += arr[j] * ww; w += ww;
    }
    out[i] = sum / w;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  查詢工具                                                          */
/* ------------------------------------------------------------------ */
export function makeLookup(track) {
  const cell = 40;
  const grid = new Map();
  const key = (cx, cz) => cx + ',' + cz;
  track.samples.forEach((p, i) => {
    const k = key(Math.floor(p.x / cell), Math.floor(p.z / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  function nearest(x, z, hint = -1, window = 90) {
    if (hint >= 0) {
      let best = hint, bd = Infinity;
      const from = Math.max(0, hint - window), to = Math.min(track.count - 1, hint + window);
      for (let i = from; i <= to; i++) {
        const p = track.samples[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (bd < 6400) return { i: best, d: Math.sqrt(bd) };
    }
    let best = -1, bd = Infinity;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) {
      const arr = grid.get(key(cx + ox, cz + oz));
      if (!arr) continue;
      for (const i of arr) {
        const p = track.samples[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return { i: best, d: Math.sqrt(bd) };
  }

  function samplesWithin(x, z, radius) {
    const out = [];
    const r = Math.ceil(radius / cell);
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let ox = -r; ox <= r; ox++) for (let oz = -r; oz <= r; oz++) {
      const arr = grid.get(key(cx + ox, cz + oz));
      if (!arr) continue;
      for (const i of arr) {
        const p = track.samples[i];
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= radius) out.push({ i, d });
      }
    }
    return out;
  }

  return { nearest, samplesWithin };
}
