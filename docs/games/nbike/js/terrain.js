/* =============================================================================
 * Nbike · js/terrain.js
 * 阿尔卑斯风格山间地形（与赛道中心线严格贴合、全域无自交）
 *
 * ── 坐标系 ────────────────────────────────────────────────────────────────
 * 赛道是闭环，平面形状在极坐标下是"径向星形曲线" ρ = ρ_road(θ)，于是地形建在
 * (θ, ρ) 里而不是 (s, lateral)：
 *   · 星形 ⇒ 任意 (θ, ρ) 唯一映射到一个世界点，网格【永不】自交
 *   · 近路环采样密（4 m），远山环采样疏（数百米）
 *   · 顶点由 (θ, 目标法向距离 d) 反推：ρ = ρ_road(θ) + d/cosα
 *     于是运行时 polarOf() 能把 θ、d 【精确】还原 → 网格生成与运行时判断
 *     用完全相同的口径，不会漂移
 *
 * ── 关键几何事实（决定了本文件的参数，别凭直觉改）────────────────────────
 *   · 赛道最小自距离 ≈ 116 m（发夹弯两臂之间）⇒ 中轴距轨道只有 ~58 m。
 *     内侧延展必须逐列钳制在 reach 内，否则发夹内侧两臂的地形互相穿透。
 *   · |ρ'(θ)/ρ| 最大 ≈ 1.18 ⇒ 切向偏角 α 可达 50°。
 *     ★ 法向距离 d = Δρ·cosα，其中 cosα = 1/√(1+(ρ'/ρ)²)。
 *       这里必须除以 ρ —— 漏掉这一步会把 d 放大几百倍（ρ'~700 vs ρ'/(ρ)~0.6）。
 *   · reach 必须在【曲线自身】上做"排除相邻段"的最近距离搜索。
 *     直接在距离场/控制点集合上取最近邻会把弯道自身的邻近点当最近邻，
 *     严重虚报可用空间（实测把 116 m 虚报成 180 m）。
 *
 * ── 网格拓扑（两块，接缝顶点严格重合）────────────────────────────────────
 *   A. 延展带 ribbon：d ∈ [−inNorm(θ), +2000 m]
 *   B. 中心山体盘 disk：从质心扇出到 ρ_edge(θ) = ρ_road(θ) − inNorm(θ)/cosα
 *      最外圈与 A 的最内圈同列集、同 ρ、同高度函数 ⇒ 视觉无缝
 *
 * ── ★ XZ 用径向参数化、Y 一律调 heightAt ──────────────────────────────────
 *   顶点平面位置必须由 (θ, d) 反推，星形域才不自交；但【高度】绝不能再用
 *   径向口径 profileY(θ列, d) —— 那与运行时查询 heightAt（最近点投影）是
 *   两套口径。实测深 190 m 处两者差 46 m（发夹弯的最近路段是赛道的另一臂，
 *   路面高程差 268 m，噪声坐标 noiseCoord(θ) 也不同），会让远处的树石
 *   整片浮空/陷地。统一调 heightAt 后，网格与查询【恒等一致】。
 * ========================================================================== */
import * as THREE from '../lib/three.module.js';

const C = window.NB.C;
const Track = window.NB.Track;

/* ---------------------------------------------------------------------------
 * 0. 参数
 * ------------------------------------------------------------------------ */
export const TERRAIN = {
  CORRIDOR: 8.4,       // 路基平台半宽（路面 4.2 + 路肩 + 余量）
  SLOPE_SHELF: 0.80,   // 路基边缘初始横坡 tan ≈ 38.6°（外侧；阿尔卑斯路堤典型值）
  /* 内侧初始横坡：原来是 1.08（tan≈47°），等于在路肩紧挨着立一堵 47° 的墙，
   * 一直爬升 800+ m —— 弯道内侧会把路面整个挡掉（玩家反馈"斜坡盖住了马路"）。
   * ★ 现在改为「先缓后陡」：路肩外 BENCH_W 米内是 ~22° 的缓坡（不挡视线），
   *   过了过渡带才升到原来 47° 的山体坡度。既有山的感觉，又不糊住路。 */
  IN_SHELF: 0.30,      // 近路缓坡 tan≈16.7°（原 0.40 仍偏陡，近处会挡住侧向视野）
  IN_SHELF_FAR: 1.15,  // 远处山体 tan≈49°（保留陡峭感）
  BENCH_W: 34,         // 缓坡过渡带宽度（m）：这段是视线保护带

  /* --- 外侧：陡降为谷 → 缓坡谷底 → 抬升为远山（三阶段） --- */
  OUT_DROP: 300,       // 谷底下切深度（相对路面）
  FAR_RISE: 900,       // 远山抬升
  FAR_IN: 700,         // 远山起坡距离（必须 > 谷底成型距离，否则 400m 处到不了谷底）
  FAR_FULL: 2200,      // 远山抬升到位距离（≈ OUT_EDGE，使最外环正好是远山）
  OUT_EDGE: 2000,      // 延展带外侧边界（法向距离）

  /* --- 内侧山体 --- */
  CREST_ABS: 1350,     // 内侧山脊的绝对高程（与路面高程解耦，才能形成真正的山峰）
  NOTCH: 340,          // 山隘处山脊下切量 → 垭口鞍部
  ROUGH_IN: 215,       // 内侧岩石起伏幅度
  ROUGH_OUT: 175,      // 外侧岩石起伏幅度
  FINE_AMP: 24,        // 中高频细节幅度
  /* 噪声起坡区间（m）。★ 拉长会让横坡更缓：单米最大横坡 ≈ ROUGH/区间长。
   * 原来内侧 24→150 只有 126m，215m 幅度全打开 ⇒ 2.7m/m（70°），
   * 网格会出现明显折角。拉到 30→260 后约 1.4m/m（54°），是真实山脊的陡度。 */
  IN_RAMP: [30, 260],
  OUT_RAMP: [140, 700],

  /* --- 着色 --- */
  SNOW_ABOVE: 190,     // 高于路面最高点多少米见雪
  ROCK_ABOVE: 26,      // 高于路面最高点多少米转裸岩

  /* --- 内侧延展控制（逐列用距离场扫描决定，见 buildColumns） --- */
  IN_CAP: 300,         // 法向上限
  IN_MIN: 16,          // 法向下限
  REACH_BIAS: 12,      // 扫描判据：distToTrack 比径向距离 d 小这么多 → 已贴上别的路段
  CLEAR_MIN: 7,        // 扫描的绝对净空底线（离任意路面至少 7 m）
  CLEAR: 18,           // 自检口径：盘缘到任意路面点的净空（m）

  /* --- heightAt 的两套参数化混合区间（见 heightAt 注释） --- */
  BLEND_FULL: 130,     // |最近点法向距离| ≤ 此值 → 纯最近点口径
  BLEND_NONE: 280      // ≥ 此值 → 纯径向口径（与网格逐顶点一致）
};

/* ---------------------------------------------------------------------------
 * 1. 值噪声
 * ------------------------------------------------------------------------ */
function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const u = fade(x - ix), v = fade(y - iy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}
export function fbm(x, y, oct = 3, lac = 2.1, gain = 0.5) {
  let s = 0, amp = 1, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * amp; tot += amp; amp *= gain; f *= lac; }
  return s / tot;
}
export function ridged(x, y, oct = 4, lac = 2.07, gain = 0.52) {
  let s = 0, amp = 1, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) {
    const r = 1 - Math.abs(2 * vnoise(x * f, y * f) - 1);
    s += r * r * amp; tot += amp; amp *= gain; f *= lac;
  }
  return s / tot;
}
export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const T = TERRAIN;

/* ---------------------------------------------------------------------------
 * 2. 赛道极坐标查表 + reach 表
 * ------------------------------------------------------------------------ */
const CNT = Track.COUNT;

const PROF = (function build() {
  const S = Track.getSamples();
  const CX = S.CX, CZ = S.CZ;

  let cx = 0, cz = 0;
  for (let i = 0; i < CNT; i++) { cx += CX[i]; cz += CZ[i]; }
  cx /= CNT; cz /= CNT;

  const n = Math.max(1600, Math.round(Track.PERIM / 1.2));
  const ds = Track.PERIM / n;

  const th = new Float64Array(n + 1);
  const rr = new Float64Array(n + 1);
  const yy = new Float64Array(n + 1);
  const ss = new Float64Array(n + 1);

  /* ★ 解缠：把相邻角差归一化到 (−π, π] 再累加。
   *   不能逐点比较 prev —— posAt 线性插值的 ~1e-4 rad 抖动会被当成绕圈累加
   *   （实测累计 2740 圈），使 ρ(θ) 查表彻底失效。 */
  let acc = 0, prevRaw = 0, firstRaw = 0;
  for (let i = 0; i <= n; i++) {
    const s = i === n ? 0 : i * ds;
    const p = Track.posAt(s, 0);
    const raw = Math.atan2(p.z - cz, p.x - cx);
    if (i === 0) { firstRaw = raw; acc = raw; }
    else {
      let d = raw - prevRaw;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d <= -Math.PI) d += Math.PI * 2;
      acc += d;
    }
    prevRaw = raw;
    th[i] = acc; ss[i] = s;
    rr[i] = Math.hypot(p.x - cx, p.z - cz);
    yy[i] = p.y;
  }
  const turns = Math.round((acc - firstRaw) / (Math.PI * 2));
  th[n] = th[0] + Math.PI * 2;
  rr[n] = rr[0]; yy[n] = yy[0]; ss[n] = Track.PERIM;

  const TH0 = th[0];
  const wrap = (a) => {
    let d = a - TH0;
    d -= Math.floor(d / (Math.PI * 2)) * Math.PI * 2;
    return TH0 + d;
  };
  const idxOf = (a) => {
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (th[m] <= a) lo = m; else hi = m; }
    return lo;
  };
  function at(arr, a) {
    const w = wrap(a), i = idxOf(w);
    const t = (w - th[i]) / (th[i + 1] - th[i] || 1);
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }

  let minR = Infinity, maxR = -Infinity;
  for (let i = 0; i <= n; i++) { if (rr[i] < minR) minR = rr[i]; if (rr[i] > maxR) maxR = rr[i]; }

  /* ---- 内侧最大安全延展由距离场逐列扫描求出（见 buildColumns），
   *     这里不再需要"曲线自身上的排除相邻段最近距离" ---- */

  return {
    cx, cz, TH0, turns, n, ds,
    rhoAt: (a) => at(rr, a),
    yAt: (a) => at(yy, a),
    sAt: (a) => at(ss, a),
    drhoAt(a) { const e = 0.0020; return (at(rr, a + e) - at(rr, a - e)) / (2 * e); },
    wrap, minR, maxR
  };
})();

/**
 * 世界坐标 → (θ, ρ, 法向距离 d)
 * ★ cosα 必须用 1/√(1+(ρ'/ρ)²)。漏掉分母的 ρ 会让 d 放大几百倍。
 * ★ 这个函数给出的是"径向"口径，用于极坐标网格的参数化；求地面高度请用
 *   groundAt()（它先把点投影到中心线，避免"径向角度 ≠ 最近点参数"带来的高程误差）。
 */
export function polarOf(x, z) {
  const dx = x - PROF.cx, dz = z - PROF.cz;
  const rho = Math.hypot(dx, dz) || 1e-3;
  const theta = PROF.wrap(Math.atan2(dz, dx));
  const rhoRoad = PROF.rhoAt(theta);
  const dp = PROF.drhoAt(theta);
  const tan = dp / Math.max(1, rhoRoad);
  const cosA = 1 / Math.sqrt(1 + tan * tan);
  return { theta, rho, rhoRoad, cosA, delta: rho - rhoRoad, dist: (rho - rhoRoad) * cosA };
}

/** 中心线上的点与其关于 θ 的切向量 */
function curveAt(theta) {
  const rho = PROF.rhoAt(theta);
  const dp = PROF.drhoAt(theta);
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    x: PROF.cx + c * rho, z: PROF.cz + s * rho, rho,
    tx: -s * rho + c * dp, tz: c * rho + s * dp
  };
}

/**
 * 把世界点投影到赛道中心线，返回 { s, dist, theta }
 * ★ 必须用牛顿迭代求【最近点参数】，不能直接用 atan2 的径向角度：
 *   发夹弯处径向角度对应的弧长与最近点可差 10 m 以上，
 *   而路面纵向坡度 6% ⇒ 0.6 m 的高程误差 ⇒ 车模明显悬空/入地。
 *   dist 为带符号法向距离（外侧为正），与 Track.posAt 的 lateral 同口径。
 */
export function projectToTrack(x, z) {
  let th = PROF.wrap(Math.atan2(z - PROF.cz, x - PROF.cx));
  for (let it = 0; it < 5; it++) {
    const c = curveAt(th);
    const ex = x - c.x, ez = z - c.z;
    const den = c.tx * c.tx + c.tz * c.tz;
    if (den < 1e-9) break;
    const dth = (ex * c.tx + ez * c.tz) / den;
    if (Math.abs(dth) < 1e-10) break;
    const nt = PROF.wrap(th + dth);
    if (nt === th) break;
    th = nt;
  }
  const c = curveAt(th);
  const len = Math.hypot(c.tx, c.tz) || 1;
  const nx = c.tz / len, nz = -c.tx / len;         // 指向外侧的单位法向
  const dist = (x - c.x) * nx + (z - c.z) * nz;
  return { s: PROF.sAt(th), dist, theta: th, rho: c.rho };
}

/* ---------------------------------------------------------------------------
 * 2b. 到赛道的距离场（chamfer 距离变换，4 m 栅格 + 两遍扫描）
 *     用途：① 逐列求内侧最大安全延展 ② 植被/护栏落点净空判断
 * ------------------------------------------------------------------------ */
const DF = (function build() {
  const cell = 4;
  const B = Track.BOUNDS;
  const pad = 150;
  const x0 = B.minX - pad, z0 = B.minZ - pad;
  const W = Math.ceil((B.maxX - B.minX + 2 * pad) / cell) + 2;
  const H = Math.ceil((B.maxZ - B.minZ + 2 * pad) / cell) + 2;
  const d = new Float32Array(W * H).fill(1e9);
  const inf = 1e9;

  const ns = Math.max(2400, Math.round(Track.PERIM / cell));
  for (let i = 0; i < ns; i++) {
    const p = Track.posAt(i * Track.PERIM / ns, 0);
    const gx = Math.round((p.x - x0) / cell), gz = Math.round((p.z - z0) / cell);
    if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue;
    d[gx * H + gz] = 0;
  }

  const D1 = 1, D2 = 1.41421356;
  for (let gx = 0; gx < W; gx++) {
    for (let gz = 0; gz < H; gz++) {
      const i = gx * H + gz;
      let v = d[i];
      if (gx > 0) {
        v = Math.min(v, d[(gx - 1) * H + gz] + D1);
        if (gz > 0) v = Math.min(v, d[(gx - 1) * H + gz - 1] + D2);
        if (gz < H - 1) v = Math.min(v, d[(gx - 1) * H + gz + 1] + D2);
      }
      if (gz > 0) v = Math.min(v, d[gx * H + gz - 1] + D1);
      d[i] = v;
    }
  }
  for (let gx = W - 1; gx >= 0; gx--) {
    for (let gz = H - 1; gz >= 0; gz--) {
      const i = gx * H + gz;
      let v = d[i];
      if (gx < W - 1) {
        v = Math.min(v, d[(gx + 1) * H + gz] + D1);
        if (gz < H - 1) v = Math.min(v, d[(gx + 1) * H + gz + 1] + D2);
        if (gz > 0) v = Math.min(v, d[(gx + 1) * H + gz - 1] + D2);
      }
      if (gz < H - 1) v = Math.min(v, d[gx * H + gz + 1] + D1);
      d[i] = v;
    }
  }

  function distToTrack(x, z) {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    let gx = Math.floor(fx), gz = Math.floor(fz);
    gx = clamp(gx, 0, W - 2); gz = clamp(gz, 0, H - 2);
    const tx = clamp(fx - gx, 0, 1), tz = clamp(fz - gz, 0, 1);
    const a = d[gx * H + gz], b = d[(gx + 1) * H + gz];
    const c = d[gx * H + gz + 1], e = d[(gx + 1) * H + gz + 1];
    const ab = a + (b - a) * tx, cd = c + (e - c) * tx;
    const v = ab + (cd - ab) * tz;
    return (v >= inf * 0.5 ? 3000 : v) * cell;
  }
  return { distToTrack, cell, W, H };
})();

/* ---------------------------------------------------------------------------
 * 3. 高程范围 / 高处掩码
 * ------------------------------------------------------------------------ */
export const ELEV = (function () {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < CNT; i++) {
    const y = Track.elevationAt(i * Track.STEP);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return { lo, hi, span: Math.max(1, hi - lo) };
})();
function heightMask(roadY) { return clamp((roadY - ELEV.lo) / ELEV.span, 0, 1); }

let SEED = 20241019;
export function setTerrainSeed(s) { SEED = s | 0; }

/* ---------------------------------------------------------------------------
 * 4. 横断面偏移 offset（C¹，初始斜率恰为 ±SLOPE_SHELF）
 * ------------------------------------------------------------------------ */
/** 指数型边坡：R(0)=0，R'(0)=slope，R(∞)→rise
 *  ★ slope 必须独立传入：内侧山体要"立"起来（tan≈1.08 / 47°），
 *    外侧路堤要缓（tan≈0.80 / 39°）。共用 SLOPE_SHELF 会让内侧只剩缓丘。 */
function shelfExp(o, rise, slope) {
  if (rise <= 0.01) return 0;
  const lam = rise / (slope || T.SLOPE_SHELF);
  return rise * (1 - Math.exp(-o / lam));
}
function noiseCoord(theta) {
  const k = 0.0016;
  return {
    x: (Math.cos(theta) * 800 + SEED * 0.37) * k,
    z: (Math.sin(theta) * 800 + SEED * 0.71) * k
  };
}

function fieldOffset(theta, dist, roadY, o) {
  const n = noiseCoord(theta);

  if (dist < 0) {
    /* 内侧：山体主脊，山隘处下切成鞍部 */
    const crest = T.CREST_ABS - T.NOTCH * heightMask(roadY);
    const rise = Math.max(30, crest - roadY);
    /* ★ 坡度沿横向渐变：路肩附近缓（不挡视线），过 BENCH_W 之后恢复陡峭。
     *   直接改 shelfExp 的 slope 参数做不到"平滑过渡"（会导致高度场折角），
     *   所以这里用两段指数叠加：近段用缓坡铺到 BENCH_W，远段从该处继续按陡坡爬。 */
    const benchH = T.IN_SHELF * T.BENCH_W;          // 过渡带末端的高度
    let h;
    if (o <= T.BENCH_W) {
      /* 近段：缓坡（略带指数收敛，避免出现直角） */
      h = benchH * (1 - Math.exp(-o / T.BENCH_W));
    } else {
      /* 远段：从 benchH 起，按 IN_SHELF_FAR 继续上升到 rise */
      const oo = o - T.BENCH_W;
      const remain = Math.max(0, rise - benchH);
      h = benchH + shelfExp(oo, remain, T.IN_SHELF_FAR);
    }
    const ramp = smoothstep(T.IN_RAMP[0], T.IN_RAMP[1], o);   // 靠近路面就起脊，才有真实的 spur / 沟谷
    h += (ridged(n.x * 2.10, n.z * 2.10, 4, 2.07, 0.52) - 0.30) * T.ROUGH_IN * ramp;
    h += (fbm(n.x * 0.42, n.z * 0.42, 3, 2.11, 0.5) - 0.5) * 220 * ramp;
    return h;
  }
  /* 外侧：下坠为谷 → 谷底缓坡 → 抬升为远山 */
  let h = -shelfExp(o, T.OUT_DROP);
  h += T.FAR_RISE * smoothstep(T.FAR_IN, T.FAR_FULL, o);
  const ramp = smoothstep(T.OUT_RAMP[0], T.OUT_RAMP[1], o);
  h += (ridged(n.x * 1.78, n.z * 1.78, 4, 2.09, 0.5) - 0.28) * T.ROUGH_OUT * ramp;
  h += (fbm(n.x * 0.36, n.z * 0.36, 3, 2.13, 0.5) - 0.5) * 275 * ramp;
  h += (fbm(n.x * 7.0, n.z * 7.0, 3, 2.3, 0.55) - 0.5) * T.FINE_AMP * smoothstep(18, 240, Math.abs(dist));
  return h;
}

/* ---------------------------------------------------------------------------
 * 5. 统一剖面
 * ------------------------------------------------------------------------ */
export function profileY(theta, dist, roadY) {
  const d = Math.abs(dist);
  if (d <= T.CORRIDOR) return roadY;
  return roadY + fieldOffset(theta, dist, roadY, d - T.CORRIDOR);
}
/** 任意世界点的地面高度（运行时权威查询）
 *
 * ★ 这里必须处理"两套参数化"的不一致，否则远处植被会浮空/陷地：
 *   · 网格顶点用【径向】参数化（θ 列 × 法向距离 d）→ 保证星形域不自交
 *   · 点查询用【最近点】投影（projectToTrack）→ 精确，发夹弯处才不差 0.6 m
 *   近路时两者等价；到 500 m 外，径向点最近的路段往往已不是同一段（实测
 *   赛道最小自距离仅 116 m），两者会差出上百米。
 *   ⇒ |最近点法向距离| ≤ BLEND_FULL 用最近点口径（精确）
 *     ≥ BLEND_NONE 用径向口径（与网格逐顶点一致）
 *     中间按 smoothstep 混合（两个口径都是 x,z 的连续函数 → 混合后仍连续）
 */
export function heightAt(x, z) {
  const r = polarOf(x, z);
  /* ★ 混合判据必须用【径向距离】Δρ，不能用最近点投影的法向距离：
   *   412 m 外的点，其"最近中心线点"会跳到赛道另一段上（赛道最小自距离仅
   *   116 m），法向距离骤降到几十米 ⇒ 误判成"在路附近"而走了错误分支。
   *   Δρ 在全局单值，且在近路处 Δρ ≈ |法向距离|，正好衔接。 */
  const rhoDelta = Math.abs(r.delta);
  if (rhoDelta >= T.BLEND_NONE) return profileY(r.theta, r.dist, PROF.yAt(r.theta));

  const p = projectToTrack(x, z);
  const hP = profileY(p.theta, p.dist, PROF.yAt(p.theta));
  if (rhoDelta <= T.BLEND_FULL) return hP;

  const hR = profileY(r.theta, r.dist, PROF.yAt(r.theta));
  const w = smoothstep(T.BLEND_NONE, T.BLEND_FULL, rhoDelta);  // Δρ↓ → w↑ → 偏最近点
  return hR + (hP - hR) * w;
}
export { DF as DISTFIELD };

export function heightAtTheta(theta, dist) {
  return profileY(theta, dist, PROF.yAt(theta));
}

/* ---------------------------------------------------------------------------
 * 6. 网格
 * ------------------------------------------------------------------------ */
/** 内侧环：占 inNorm(θ) 的比例（1.0 = 最内圈，与中心盘外圈重合） */
const IN_F = [0.055, 0.115, 0.185, 0.265, 0.355, 0.455, 0.56, 0.665, 0.77, 0.865, 0.94, 1.0];
/** 外侧环：法向距离（m），最外环 = OUT_EDGE */
const OUT_N = [4, 9, 15, 23, 33, 46, 63, 85, 113, 148, 192, 248, 320, 412, 528,
  672, 850, 1070, 1340, 1670, 2000];
/** 中心盘环：占 ρ_edge(θ) 的比例（1.0 = 与延展带最内圈重合） */
const DISK_F = [0.07, 0.15, 0.245, 0.35, 0.46, 0.57, 0.68, 0.78, 0.87, 0.945, 1.0];

export const IN_F_LEN = IN_F.length;
export const DISK_F_LEN = DISK_F.length;
export const OUT_N_LEN = OUT_N.length;

export const PALETTE = {
  gravel: 0x9b9384,
  grassLo: 0x4b6937,
  grassHi: 0x829151,
  meadow: 0x94a158,
  rockDark: 0x4c4944,
  rock: 0x6f6c64,
  scree: 0x8e8779,
  snow: 0xf3f7fc
};

function mixHex(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = 1 - t;
  return (Math.round(((a >> 16 & 255) * A + (b >> 16 & 255) * t)) << 16) |
    (Math.round(((a >> 8 & 255) * A + (b >> 8 & 255) * t)) << 8) |
    Math.round(((a & 255) * A + (b & 255) * t));
}

const SNOW_Y = ELEV.hi + TERRAIN.SNOW_ABOVE;
const ROCK_Y = ELEV.hi + TERRAIN.ROCK_ABOVE;

function vertexColor(x, y, z, dist, out) {
  const shade = fbm(x * 0.0040, z * 0.0040, 3, 2.4, 0.5);
  const patch = fbm(x * 0.0135 + 90, z * 0.0135 - 40, 2, 2.5, 0.5);
  const ad = Math.abs(dist);

  let base, over, mix;
  if (ad < 16) {
    base = PALETTE.gravel; over = PALETTE.grassLo; mix = smoothstep(6, 16, ad) * 0.92;
  } else if (y > SNOW_Y) {
    base = PALETTE.snow; over = PALETTE.scree; mix = smoothstep(0, 60, y - SNOW_Y) * 0.70;
  } else {
    const grass = mixHex(PALETTE.grassLo, PALETTE.grassHi, patch * 0.8 + shade * 0.2);
    base = mixHex(grass, PALETTE.meadow, smoothstep(0.42, 0.88, patch) * 0.55);
    over = mixHex(PALETTE.rockDark, PALETTE.rock, 0.22 + 0.66 * shade);
    mix = smoothstep(ROCK_Y - 170, ROCK_Y + 30, y + (patch - 0.5) * 80);
  }
  const lift = 1 + (shade - 0.5) * 0.17;
  out[0] = clamp(((base >> 16 & 255) * (1 - mix) + (over >> 16 & 255) * mix) / 255 * lift, 0, 1);
  out[1] = clamp(((base >> 8 & 255) * (1 - mix) + (over >> 8 & 255) * mix) / 255 * lift, 0, 1);
  out[2] = clamp(((base & 255) * (1 - mix) + (over & 255) * mix) / 255 * lift, 0, 1);
}

/** 逐列预计算（列集在所有网格间共用 → 接缝严格重合）
 *  ★ inNorm 用【距离场逐列扫描】求：沿该列径向从路面向内走，找到"再往里就会
 *    贴到任何一段路面（含自身弯道的相邻段与其它臂）"的那个距离。
 *    这比"在控制点上做排除相邻段的最近距离"更严格——后者只保证控制点本身安全，
 *    径向中间的网格顶点仍可能戳到路面上（发夹弯尤为明显）。 */
export function buildColumns(cols) {
  const th = new Float64Array(cols), rhoRoad = new Float64Array(cols),
    roadY = new Float64Array(cols), cosA = new Float64Array(cols),
    inNorm = new Float64Array(cols), rhoIn = new Float64Array(cols);
  const STEP = 2;
  for (let c = 0; c < cols; c++) {
    const a = PROF.TH0 + (c / cols) * Math.PI * 2;
    th[c] = a;
    rhoRoad[c] = PROF.rhoAt(a);
    roadY[c] = PROF.yAt(a);
    const dp = PROF.drhoAt(a);
    const tanR = dp / Math.max(1, rhoRoad[c]);
    cosA[c] = 1 / Math.sqrt(1 + tanR * tanR);

    const ca = Math.cos(a), sa = Math.sin(a);
    /* 从路基边缘开始向内走，直到"最近点跑到别的路段上"为止。
     * ★ 判据不能用绝对净空（distToTrack < CLEAR）：紧贴路基的径向点到
     *   【本列自己这一段】路面的距离本来就 ≈ d，起点 d=10.4 < CLEAR=18
     *   会立刻 break，内侧延展退化成硬下限，中心山体变成立在赛道中央的陡锥。
     *   正确判据是"最近点是否还是自己这一段"：只要 distToTrack 明显小于
     *   径向距离 d，就说明已经贴到发夹弯对面/其它臂上了。 */
    let safeNorm = T.IN_MIN;
    for (let d = T.CORRIDOR + 2; d <= T.IN_CAP; d += STEP) {
      const rho = rhoRoad[c] - d / cosA[c];
      if (rho < 40) break;
      const x = PROF.cx + ca * rho, z = PROF.cz + sa * rho;
      const dtw = DF.distToTrack(x, z);
      if (dtw < d - T.REACH_BIAS) break;   // 最近点已不属于本列对应的路段
      if (dtw < T.CLEAR_MIN) break;        // 绝对净空底线
      safeNorm = d;
    }
    inNorm[c] = clamp(safeNorm, T.IN_MIN, T.IN_CAP);
    rhoIn[c] = rhoRoad[c] - inNorm[c] / cosA[c];
  }
  return { th, rhoRoad, roadY, cosA, inNorm, rhoIn, cols };
}

export function buildTerrain(opts = {}) {
  const cols = opts.cols || 480;
  const CL = buildColumns(cols);
  const { th, rhoRoad, roadY, cosA, inNorm, rhoIn } = CL;

  const group = new THREE.Group();
  group.name = 'terrain';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
  const rgb = [0, 0, 0];

  /* ============================================================
   * A. 延展带
   * ============================================================ */
  const ringCount = 1 + IN_F.length + OUT_N.length;
  const vCount = cols * ringCount;
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = [];
  let vi = 0;

  function ringDist(k, c) {
    if (k === 0) return 0;
    if (k <= IN_F.length) return -inNorm[c] * IN_F[k - 1];
    return OUT_N[k - IN_F.length - 1];
  }

  for (let k = 0; k < ringCount; k++) {
    for (let c = 0; c < cols; c++) {
      const d = ringDist(k, c);
      const rho = rhoRoad[c] + d / cosA[c];
      const x = PROF.cx + Math.cos(th[c]) * rho;
      const z = PROF.cz + Math.sin(th[c]) * rho;
      /* ★ 高度统一走 heightAt，与运行时查询恒等一致（见文件头注释）。
       *   XZ 仍是径向反推（星形域不自交），只有 Y 改口径。
       *   k=0 是路面环，用 roadY 直给，保证严格贴路（避免牛顿迭代的浮点抖动）。 */
      const y = k === 0 ? roadY[c] : heightAt(x, z);
      pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
      vertexColor(x, y, z, d, rgb);
      col[vi * 3] = rgb[0]; col[vi * 3 + 1] = rgb[1]; col[vi * 3 + 2] = rgb[2];
      vi++;
    }
  }
  for (let k = 0; k < ringCount - 1; k++) {
    for (let c = 0; c < cols; c++) {
      const c2 = (c + 1) % cols;
      const a = k * cols + c, b = k * cols + c2;
      const d2 = (k + 1) * cols + c, e = (k + 1) * cols + c2;
      idx.push(a, d2, b, b, d2, e);
    }
  }
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.name = 'terrainRibbon';
    group.add(m);
  }

  /* ============================================================
   * B. 中心山体盘（最外圈 = 延展带最内圈，逐顶点重合）
   * ============================================================ */
  const dCount = DISK_F.length;
  const dvCount = cols * dCount + 1;
  const dpos = new Float32Array(dvCount * 3);
  const dcol = new Float32Array(dvCount * 3);
  const didx = [];
  let dvi = 0;

  for (let k = 0; k < dCount; k++) {
    const isEdge = (k === dCount - 1);
    for (let c = 0; c < cols; c++) {
      const rho = isEdge ? rhoIn[c] : rhoIn[c] * DISK_F[k];
      const d = isEdge ? -inNorm[c] : (rho - rhoRoad[c]) * cosA[c];
      const x = PROF.cx + Math.cos(th[c]) * rho;
      const z = PROF.cz + Math.sin(th[c]) * rho;
      /* 高度同样统一走 heightAt：盘缘与延展带最内圈 XZ 完全相同
       * （rhoIn[c] = rhoRoad[c] − inNorm[c]/cosA，且延展带最内圈 d = −inNorm[c]），
       * 因此逐顶点恒等重合，接缝不会裂。 */
      const y = heightAt(x, z);
      dpos[dvi * 3] = x; dpos[dvi * 3 + 1] = y; dpos[dvi * 3 + 2] = z;
      vertexColor(x, y, z, d, rgb);
      dcol[dvi * 3] = rgb[0]; dcol[dvi * 3 + 1] = rgb[1]; dcol[dvi * 3 + 2] = rgb[2];
      dvi++;
    }
  }
  /* 圆心：直接查 heightAt，保证与相邻环连续（山顶因此是"算出来的"而非设定值） */
  let peakY = -Infinity;
  {
    const y = heightAt(PROF.cx, PROF.cz);
    peakY = y;
    dpos[dvi * 3] = PROF.cx; dpos[dvi * 3 + 1] = y; dpos[dvi * 3 + 2] = PROF.cz;
    vertexColor(PROF.cx, y, PROF.cz, -999, rgb);
    dcol[dvi * 3] = rgb[0]; dcol[dvi * 3 + 1] = rgb[1]; dcol[dvi * 3 + 2] = rgb[2];
  }
  const centerIdx = dvi;

  for (let c = 0; c < cols; c++) didx.push(centerIdx, c, (c + 1) % cols);
  for (let k = 0; k < dCount - 1; k++) {
    for (let c = 0; c < cols; c++) {
      const c2 = (c + 1) % cols;
      const a = k * cols + c, b = k * cols + c2;
      const d2 = (k + 1) * cols + c, e = (k + 1) * cols + c2;
      didx.push(a, b, d2, b, e, d2);
    }
  }
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
    geo.setIndex(didx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.name = 'terrainMassif';
    group.add(m);
  }

  return {
    group, cols, mat, peakY,
    ribbonTris: idx.length / 3, diskTris: didx.length / 3, columns: CL
  };
}

export const PROFILE = PROF;
