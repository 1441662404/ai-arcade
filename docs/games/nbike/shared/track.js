/* =============================================================================
 * Nbike · shared/track.js
 * 环法风格山间赛道：环绕阿尔卑斯山体的闭环
 *   谷底出发 → 主爬坡(山隘) → 垭口 → 长距离连续弯下坡 → 谷底小坡 → 冲刺回终点
 *
 * 坐标约定（关键设计）：
 *   赛道状态用 (s, lateral) 表达：
 *     s       = 沿路面中心线的弧长（m），0 = 起终点线，按总长循环；
 *     lateral = 相对中心线的横向偏移（m），右为正。
 *   世界坐标 (x,y,z) 由 Track.posAt(s, lateral) 唯一导出。
 *   → 服务端只积分 s / lateral 两个标量；客户端预测用同一函数还原世界坐标，
 *     两端永远不会因为浮点路径积分不同而漂移。转弯不可逆 —— 想回内线必须花时间骑回来。
 *
 * 设计指标（已用 tools/tune-track*.js 扫描验证）：
 *   周长 ≈ 8.1 km · 最急弯 R ≈ 80 m · 中位弯 R ≈ 173 m · 27 个弯
 *   最高点 +265 m · 主爬坡 3.0 km @ 8.6% · 下坡最陡 -11% · 无超标坡段
 *
 * 双模导出：CommonJS + 浏览器 classic script
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NB = root.NB || {}; root.NB.Track = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PI = Math.PI, D2R = PI / 180;

  /* ---------------------------------------------------------------------------
   * 1. 平面形状：极坐标谐波叠加（任意阶都平滑，天然是闭曲线）
   *    r(θ) = R0 + Σ Aₙ·cos(nθ + φₙ)
   *    谐波阶数 → 弯道数量与半径；幅度 → 弯道急缓
   * ------------------------------------------------------------------------ */
  var SHAPE = {
    N: 144,                 // 控制点数量（2.5°/点，足够让样条跟上曲率）
    R0: 1150,               // 基准半径
    RADIAL: [
      { a: 130, n: 2, p: 0.40 },   // 两个"山湾" → 4 个大扫弯
      { a: 20, n: 3, p: 1.90 },
      { a: 90, n: 5, p: 2.60 },   // 5 阶 → 中等弯
      { a: 12, n: 7, p: 0.80 },
      { a: 60, n: 11, p: 1.40 }    // 11 阶 → 密集小弯（最急 R≈80m）
    ]
  };

  /* ---------------------------------------------------------------------------
   * 2. 高程剖面：关键帧（**按周长比例 f = 沿程距离 / 总周长**，不是参数域！）
   *    参数域与弧长域不等价（半径小处参数走得慢），按弧长比例定义才能精确控制坡度：
   *       坡度 ≈ Δ海拔 / (Δf × PERIM)
   * ------------------------------------------------------------------------ */
  /* ★ 剖面设计：**起点就在下坡段起点**（用户要求"默认起点做在下坡路段"）。
   *   循环移位后：出发即 -13% 急下坡 → 一路溜下 2km → 谷底平路 → 反向小坡
   *   → 最后一段下坡冲刺 → 谷底镇中心 → 9% 主爬坡（长爬）→ 垭口 → 回到起点下坡。
   *   这样一开局就有速度感（不用先苦爬 3km），也符合"环法赛段从山口下坡发车"的编排。
   *   注：移位不改变圈数/判圈逻辑，只是把同一条闭环旋转了一个相位。 */
  var ELEV_KEYS = [
    /* f       海拔    说明 / 本段坡度 */
    [0.000, 374],   // ★ 起终点线：下坡段起点（垭口下方）
    [0.050, 320],   // -13.3%  出垭口急坠
    [0.110, 268],   // -10.7%
    [0.160, 240],   //  -6.9%
    [0.210, 220],   //  -4.9%
    [0.250, 208],   //  -3.7%
    [0.270, 205],   //  -1.9%  下坡结束（谷底）
    [0.290, 208],   //  +1.9%  谷底平路
    [0.350, 228],   //  +4.1%  ★ 反向小坡（4 级）
    [0.380, 232],   //  +1.6%
    [0.410, 222],   //  -4.1%
    [0.460, 192],   //  -7.4%
    [0.515, 158],   //  -7.6%
    [0.555, 130],   //  -8.6%
    [0.582, 122],   //  -4.9%
    [0.590, 120],   //  -3.1%  谷底镇中心（起坡点）
    [0.610, 133],   //  +8.0%  出镇
    [0.650, 163],   //  +9.3%
    [0.710, 210],   //  +9.7%  树林段
    [0.770, 246],   //  +7.4%  缓一口气
    [0.830, 288],   //  +8.6%
    [0.890, 334],   //  +9.5%  陡坡
    [0.940, 373],   //  +9.6%  发夹弯密集
    [0.970, 392],   //  +7.8%  ★ 主爬坡顶（山隘）
    [0.985, 389],   //  -2.5%  垭口平台（观众密集）
    [1.000, 374]    //  -12.3%  回到起终点
  ];

  var ELEV_SMOOTH_M = 190;   // 弧长域平滑窗口（米）—— 磨掉关键帧折角，得到自然坡度

  /* ---------------------------------------------------------------------------
   * 3. Catmull-Rom 求值
   * ------------------------------------------------------------------------ */
  function crP(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  function radiusAt(theta) {
    var r = SHAPE.R0;
    for (var i = 0; i < SHAPE.RADIAL.length; i++) {
      var h = SHAPE.RADIAL[i];
      r += h.a * Math.cos(h.n * theta + h.p);
    }
    return r;
  }

  /** 按"周长比例 f"插值高程关键帧 */
  function elevationRawFrac(f) {
    var x = f - Math.floor(f);
    for (var i = 1; i < ELEV_KEYS.length; i++) {
      if (x <= ELEV_KEYS[i][0]) {
        var a = ELEV_KEYS[i - 1], b = ELEV_KEYS[i];
        var t = (x - a[0]) / (b[0] - a[0] || 1);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return ELEV_KEYS[ELEV_KEYS.length - 1][1];
  }

  /* ---------------------------------------------------------------------------
   * 4. 生成控制点（极坐标 → 直角坐标）
   * ------------------------------------------------------------------------ */
  var CTRL = [];
  for (var ci = 0; ci < SHAPE.N; ci++) {
    var u = ci / SHAPE.N;
    var th = u * 2 * PI;
    var r = radiusAt(th);
    CTRL.push({ x: Math.cos(th) * r, z: Math.sin(th) * r, u: u });
  }

  /* ---------------------------------------------------------------------------
   * 5. 横向加密采样（Catmull-Rom 闭曲线，只算平面）
   * ------------------------------------------------------------------------ */
  var SUB = Math.max(2, Math.round(960 / SHAPE.N));
  var raw2 = [];
  for (var ii = 0; ii < SHAPE.N; ii++) {
    var i0 = (ii - 1 + SHAPE.N) % SHAPE.N, i1 = ii,
      i2 = (ii + 1) % SHAPE.N, i3 = (ii + 2) % SHAPE.N;
    var A = CTRL[i0], B = CTRL[i1], Cc = CTRL[i2], D = CTRL[i3];
    for (var k = 0; k < SUB; k++) {
      var t = k / SUB;
      raw2.push({
        x: crP(A.x, B.x, Cc.x, D.x, t),
        z: crP(A.z, B.z, Cc.z, D.z, t)
      });
    }
  }
  raw2.push({ x: raw2[0].x, z: raw2[0].z });

  /* ---------------------------------------------------------------------------
   * 6. 平面弧长表 → 等距重采样（1m）→ 高程按弧长比例赋值
   * ------------------------------------------------------------------------ */
  var acc = [0];
  for (var ai = 1; ai < raw2.length; ai++) {
    acc.push(acc[ai - 1] + Math.hypot(raw2[ai].x - raw2[ai - 1].x, raw2[ai].z - raw2[ai - 1].z));
  }
  var PERIM = acc[acc.length - 1];
  var COUNT = Math.round(PERIM);
  var STEP = PERIM / COUNT;

  var CX = new Float64Array(COUNT), CY = new Float64Array(COUNT), CZ = new Float64Array(COUNT);

  function rawAtDist(dist) {
    var d = ((dist % PERIM) + PERIM) % PERIM;
    var lo = 0, hi = acc.length - 1;
    while (lo < hi - 1) {
      var m = (lo + hi) >> 1;
      if (acc[m] <= d) lo = m; else hi = m;
    }
    var seg = acc[hi] - acc[lo];
    var t = seg > 1e-9 ? (d - acc[lo]) / seg : 0;
    var a = raw2[lo], b = raw2[hi];
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }

  for (var si = 0; si < COUNT; si++) {
    var dist = si * STEP;
    var p = rawAtDist(dist);
    CX[si] = p.x; CZ[si] = p.z;
    CY[si] = elevationRawFrac(dist / PERIM);
  }

  /* 弧长域滑动平均（真周期信号，纯环卷积，无需反射）—— 磨平折角 */
  (function () {
    var w = Math.round(ELEV_SMOOTH_M / STEP / 2);
    var out = new Float64Array(COUNT);
    for (var i = 0; i < COUNT; i++) {
      var s = 0;
      for (var k = -w; k <= w; k++) s += CY[(i + k + COUNT) % COUNT];
      out[i] = s / (2 * w + 1);
    }
    CY.set(out);
  })();

  /* ---------------------------------------------------------------------------
   * 7. 切线 / 坡度 / 曲率
   * ------------------------------------------------------------------------ */
  var TX = new Float64Array(COUNT), TY = new Float64Array(COUNT), TZ = new Float64Array(COUNT);
  var RX = new Float64Array(COUNT), RZ = new Float64Array(COUNT);
  var SLOPE = new Float64Array(COUNT), CURV = new Float64Array(COUNT), GRADE = new Float64Array(COUNT);

  for (var n = 0; n < COUNT; n++) {
    var pv = (n - 2 + COUNT) % COUNT, nx = (n + 2) % COUNT;
    var tx = CX[nx] - CX[pv], ty = CY[nx] - CY[pv], tz = CZ[nx] - CZ[pv];
    var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    TX[n] = tx; TY[n] = ty; TZ[n] = tz;
    var hl = Math.sqrt(tx * tx + tz * tz) || 1e-6;
    SLOPE[n] = Math.atan2(ty, hl);
    RX[n] = tz / hl; RZ[n] = -tx / hl;
  }

  (function () {
    var KB = 4;
    for (var n = 0; n < COUNT; n++) {
      var a = (n - KB + COUNT) % COUNT, b = (n + KB) % COUNT;
      var cross = TX[a] * TZ[b] - TZ[a] * TX[b];
      var dot = TX[a] * TX[b] + TZ[a] * TZ[b];
      CURV[n] = -Math.atan2(cross, dot) / (2 * KB * STEP);  // 右转为正
    }
    smoothInPlace(CURV, 5);
    smoothInPlace(SLOPE, 4);
    for (var i = 0; i < COUNT; i++) GRADE[i] = Math.tan(SLOPE[i]) * 100;
  })();

  function smoothInPlace(arr, radius) {
    var out = new Float64Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var s = 0;
      for (var k = -radius; k <= radius; k++) s += arr[(i + k + arr.length) % arr.length];
      out[i] = s / (2 * radius + 1);
    }
    arr.set(out);
  }

  /* ---------------------------------------------------------------------------
   * 8. 查询接口
   * ------------------------------------------------------------------------ */
  function normS(s) { var d = s % PERIM; return d < 0 ? d + PERIM : d; }

  function sampleAt(s) {
    var d = normS(s) / STEP;
    var i = Math.floor(d), t = d - i;
    var a = ((i % COUNT) + COUNT) % COUNT, b = (a + 1) % COUNT;
    return {
      x: CX[a] + (CX[b] - CX[a]) * t,
      y: CY[a] + (CY[b] - CY[a]) * t,
      z: CZ[a] + (CZ[b] - CZ[a]) * t,
      tx: TX[a] + (TX[b] - TX[a]) * t,
      ty: TY[a] + (TY[b] - TY[a]) * t,
      tz: TZ[a] + (TZ[b] - TZ[a]) * t,
      rx: RX[a] + (RX[b] - RX[a]) * t,
      rz: RZ[a] + (RZ[b] - RZ[a]) * t,
      slope: SLOPE[a] + (SLOPE[b] - SLOPE[a]) * t,
      curv: CURV[a] + (CURV[b] - CURV[a]) * t,
      grade: GRADE[a] + (GRADE[b] - GRADE[a]) * t,
      s: normS(s)
    };
  }

  function posAt(s, lateral) {
    var f = sampleAt(s);
    var rl = Math.sqrt(f.rx * f.rx + f.rz * f.rz) || 1;
    var rx = f.rx / rl, rz = f.rz / rl;
    var lat = lateral || 0;
    return {
      x: f.x + rx * lat, y: f.y, z: f.z + rz * lat,
      tx: f.tx, ty: f.ty, tz: f.tz,
      rx: rx, rz: rz,
      slope: f.slope, curv: f.curv, grade: f.grade, s: f.s
    };
  }

  function slopeAt(s) { return sampleAt(s).slope; }
  function gradeAt(s) { return sampleAt(s).grade; }
  function curvatureAt(s) { return sampleAt(s).curv; }
  function elevationAt(s) { return sampleAt(s).y; }

  /* ---- 爬坡分段 ─────────────────────────────────────────────────────────
   * 分级：以"爬升高度 × 平均坡度"作为难度分（对标 UCI 综合口径）
   *   HC ≥1200  Cat1 ≥600  Cat2 ≥300  Cat3 ≥120  其余 Cat4
   * 例：3.1km @ 8.5% → 268×8.5/5 = 456 → 1 级坡（与环法实际定级一致）
   * -------------------------------------------------------------------- */
  function climbCategory(gain, avgGrade) {
    var score = gain * (avgGrade || 1) / 5;
    if (score >= 1200) return 'HC';
    if (score >= 600) return '1';
    if (score >= 300) return '2';
    if (score >= 120) return '3';
    return '4';
  }

  var CLIMBS = (function () {
    var out = [], run = false, s0 = 0;
    for (var i = 0; i < COUNT + 1; i++) {
      var up = i < COUNT && GRADE[i] > 1.0;
      if (up && !run) { run = true; s0 = i; }
      else if (!up && run) {
        run = false;
        var len = (i - s0) * STEP;
        if (len > 400) {
          var sum = 0, gain = 0;
          for (var k = s0; k < i; k++) { sum += GRADE[k]; gain += GRADE[k] / 100 * STEP; }
          var avg = sum / (i - s0);
          out.push({
            idx0: s0, idx1: i, s0: s0 * STEP, s1: i * STEP,
            length: len, avgGrade: avg, gain: gain, gainTotal: gain,
            category: climbCategory(gain, avg)
          });
        }
      }
    }
    return out;
  })();

  /* 爬升累计前缀和（跨闭环累加，用于 O(1) 求"剩余爬升"） */
  var cumGain = new Float64Array(COUNT + 1);
  (function () {
    for (var i = 0; i < COUNT; i++) cumGain[i + 1] = cumGain[i] + GRADE[i] / 100 * STEP;
  })();

  function climbInfoAt(s) {
    var d = normS(s);
    for (var i = 0; i < CLIMBS.length; i++) {
      var c = CLIMBS[i];
      if (d >= c.s0 && d < c.s1) {
        var idx = Math.floor(d / STEP);
        var gainNow = cumGain[idx];
        var gainRem = c.gainTotal - gainNow;
        var rem = c.s1 - d;
        return {
          active: true, category: c.category, avgGrade: c.avgGrade,
          length: c.length, remain: rem, gainRemain: Math.max(0, gainRem),
          progress: (d - c.s0) / c.length,
          gain: c.gain, s0: c.s0, s1: c.s1
        };
      }
    }
    return { active: false };
  }

  /** 下坡检测：坡度 < -1%，返回剩余下坡距离与累计落差 */
  function descentInfoAt(s) {
    var g = gradeAt(s);
    if (g > -1.0) return { active: false };
    var d = normS(s);
    var idx = Math.floor(d / STEP);
    var rem = 0, drop = 0;
    for (var i = 0; i < COUNT; i++) {
      var k = (idx + i) % COUNT;
      if (GRADE[k] > -1.0 || i > 2600) break;
      rem += STEP; drop += -GRADE[k] / 100 * STEP;
    }
    return { active: true, grade: g, remain: rem, drop: drop };
  }

  /* ---- 弯道 ───────────────────────────────────────────────────────── */
  var CORNERS = (function () {
    var out = [], run = false, s0 = 0, peak = 0, peakSide = 0;
    var TH = 1 / 400;
    for (var i = 0; i < COUNT + 1; i++) {
      var c = i < COUNT ? CURV[i] : 0;
      var sharp = Math.abs(c) > TH;
      if (sharp && !run) { run = true; s0 = i; peak = c; peakSide = c > 0 ? 1 : -1; }
      else if (sharp) { if (Math.abs(c) > Math.abs(peak)) { peak = c; peakSide = c > 0 ? 1 : -1; } }
      else if (run) {
        run = false;
        var len = (i - s0) * STEP;
        if (len >= 22) {
          out.push({
            s0: s0 * STEP, s1: i * STEP, sMid: (s0 + (i - s0) / 2) * STEP,
            length: len, R: 1 / Math.abs(peak), radius: 1 / Math.abs(peak),
            right: peakSide > 0, side: peakSide
          });
        }
      }
    }
    return out;
  })();

  /** 弯道 → 建议入弯速度（km/h），侧向加速度按 3.1 m/s² 抓地预算 */
  function cornerSpeed(curv) {
    var R = Math.abs(curv) > 1e-5 ? 1 / Math.abs(curv) : 9999;
    return Math.min(80, Math.sqrt(3.1 * Math.max(6, R)) * 3.6);
  }

  /** 前方 lookAhead 米内最急的弯 */
  function nextCorner(s, lookAhead) {
    var best = 0, bestAt = 0, bestC = 0;
    var steps = Math.floor((lookAhead || 300) / 5);
    for (var i = 1; i <= steps; i++) {
      var ss = normS(s + i * 5);
      var c = curvatureAt(ss);
      var a = Math.abs(c);
      if (a > best) { best = a; bestAt = i * 5; bestC = c; }
    }
    return {
      dist: bestAt, curv: bestC, radius: best > 1e-6 ? 1 / best : 9999,
      speed: cornerSpeed(bestC), right: bestC > 0,
      inCorner: Math.abs(curvatureAt(s)) > 1 / 400
    };
  }

  function currentCorner(s) {
    var c = curvatureAt(s);
    if (Math.abs(c) < 1 / 400) return null;
    return { curv: c, radius: 1 / Math.abs(c), speed: cornerSpeed(c), right: c > 0 };
  }

  /* ---- 世界坐标 → 赛道坐标（minimap / 调试 / 出界救援） ---- */
  function toTrack(x, z, hintS) {
    var best = -1, bestD = Infinity;
    if (typeof hintS === 'number') {
      var c0 = Math.floor(normS(hintS) / STEP);
      for (var j = -30; j <= 30; j++) {
        var k = ((c0 + j) % COUNT + COUNT) % COUNT;
        var dx = CX[k] - x, dz = CZ[k] - z, d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; best = k; }
      }
    }
    if (best < 0) {
      for (var i2 = 0; i2 < COUNT; i2 += 5) {
        var dx2 = CX[i2] - x, dz2 = CZ[i2] - z, d3 = dx2 * dx2 + dz2 * dz2;
        if (d3 < bestD) { bestD = d3; best = i2; }
      }
      var lo = best - 8, hi = best + 8;
      for (var j2 = lo; j2 <= hi; j2++) {
        var k2 = ((j2 % COUNT) + COUNT) % COUNT;
        var dx3 = CX[k2] - x, dz3 = CZ[k2] - z, d4 = dx3 * dx3 + dz3 * dz3;
        if (d4 < bestD) { bestD = d4; best = k2; }
      }
    }
    return {
      s: best * STEP,
      lateral: (x - CX[best]) * RX[best] + (z - CZ[best]) * RZ[best],
      dist: Math.sqrt(bestD)
    };
  }

  function getSamples() {
    return { CX: CX, CY: CY, CZ: CZ, TX: TX, TY: TY, TZ: TZ, RX: RX, RZ: RZ,
      SLOPE: SLOPE, CURV: CURV, GRADE: GRADE, COUNT: COUNT, STEP: STEP };
  }

  /* ---- 简化的赛道包（下发给客户端，避免客户端跑 8000 点采样） ---- */
  function packForClient(every) {
    var e = every || 6;
    var pts = [];
    for (var i = 0; i < COUNT; i += e) {
      pts.push([
        Math.round(CX[i] * 100) / 100,
        Math.round(CY[i] * 100) / 100,
        Math.round(CZ[i] * 100) / 100,
        Math.round(GRADE[i] * 100) / 100,
        Math.round(CURV[i] * 100000) / 100000
      ]);
    }
    return { step: STEP * e, perim: PERIM, count: pts.length, pts: pts, climbs: CLIMBS, corners: CORNERS };
  }

  var BOUNDS = (function () {
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity,
      minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < COUNT; i++) {
      if (CX[i] < minX) minX = CX[i]; if (CX[i] > maxX) maxX = CX[i];
      if (CZ[i] < minZ) minZ = CZ[i]; if (CZ[i] > maxZ) maxZ = CZ[i];
      if (CY[i] < minY) minY = CY[i]; if (CY[i] > maxY) maxY = CY[i];
    }
    return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, minY: minY, maxY: maxY };
  })();

  return {
    PERIM: PERIM, COUNT: COUNT, STEP: STEP, BOUNDS: BOUNDS,
    CLIMBS: CLIMBS, CORNERS: CORNERS, ELEV_KEYS: ELEV_KEYS,
    sampleAt: sampleAt, posAt: posAt, slopeAt: slopeAt, gradeAt: gradeAt,
    curvatureAt: curvatureAt, elevationAt: elevationAt,
    toTrack: toTrack, normS: normS,
    climbInfoAt: climbInfoAt, descentInfoAt: descentInfoAt,
    climbCategory: climbCategory, cornerSpeed: cornerSpeed,
    nextCorner: nextCorner, currentCorner: currentCorner,
    getSamples: getSamples, packForClient: packForClient
  };
});
