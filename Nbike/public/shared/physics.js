/* =============================================================================
 * Nbike · shared/physics.js
 * 单车运动 + 踩踏节奏（核心玩法）的统一物理步进
 *
 * ★ 关键约定：本文件被【服务端权威循环】与【客户端预测】同时调用，
 *   两侧必须用完全相同的输入序列与固定步长 FIXED_DT。
 *   服务端 30Hz tick 与客户端均用 accumulator 拆成 FIXED_DT 子步，
 *   于是「客户端预测 = 服务端结果」，不会来回拉扯。
 *
 * ── 转速模型（两来源取大者，既真实又不死锁）─────────────────────────
 *   A. 踩踏驱动：玩家踩得越实、齿比越轻，曲柄转得越快
 *        cadTarget = CAD_BASE × (CAD_REF_RATIO / 齿比)^0.42 × 踩踏信号
 *      → 起步时速度 0 也能把曲柄踩起来（真实起步）
 *   B. 固定传动比联动：cadLink = v / 齿比传动距离 × 60
 *      → 高速时齿比决定踏频上限，这正是"换挡"的意义
 *   最终 cad = max(A, B)。速度为零时靠 A 起步，速度上来后由 B 主导。
 *
 * ── 功率模型（P_BASE 标定见 constants.js）──────────────────────────
 *   功率 = P_BASE × 即时驱动力矩 × 踏频效率 × 传动效率 × combo
 *   即时驱动力矩 = Σ(该脚力矩臂 × 该脚力度)，单脚 90° 满力 = 1.0
 *   ★ 一只脚下踩做功时另一只必然在上升行程产生负力矩，
 *     所以"错误时机按 A/D"会真实地把功率拖下来，不是脚本判定。
 *   实测梯度：全力错相位 ≈ 满功率 25~35%，节奏精准 ≈ 100%（另加 combo）
 *
 * 双模导出：CommonJS + 浏览器 classic script
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./track.js'));
  } else {
    root.NB = root.NB || {};
    root.NB.Physics = factory(root.NB.C, root.NB.Track);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, Track) {
  'use strict';

  var FIXED_DT = 1 / 60;    // 物理固定步长（两端一致）
  var MAX_SUBSTEPS = 8;

  function newRiderState(s, lateral, gear) {
    return {
      s: s || 0,
      lateral: lateral || 0,
      speed: 0,
      crank: C.PEDAL.START_CRANK,   // 起步相位 90°（3 点钟方向，有力矩臂）
      leftForce: 0,          // 左脚施力 0..1
      rightForce: 0,
      combo: 0,              // 连击加成
      power: 0,              // 机械功率 W
      cadence: 0,            // 踏频 rpm
      gear: typeof gear === 'number' ? gear : C.BIKE.GEAR_DEFAULT,
      gearCd: 0,
      shiftFlash: 0,         // 换挡动力中断计时
      latVel: 0,             // 横向速度 m/s
      lean: 0,               // 车身倾角 rad
      stamina: 100,
      effort: 0,
      driveGain: 0,          // 当前有效力矩（可正可负）
      reverse: false,        // 是否处于"红区反向拖拽"
      cdaFactor: 1,
      draft: 0,              // 跟风强度 0..1
      onRoad: true,
      braking: false,
      accelerating: false,
      hitCount: 0,           // 精彩发力次数
      missCount: 0,          // 明显失误次数
      /* 节奏精度统计（每个发力周期结算一次） */
      goodHits: 0,
      badHits: 0,
      pressCycles: 0,
      qualitySum: 0,
      _cycL: null, _cycR: null,
      maxSpeed: 0,
      avgPower: 0,           // 全程平均功率（服务端累积）
      dist: 0,               // 总骑行距离
      /* --- 输入"上一个状态"，用于边沿检测（按下瞬间触发判定） --- */
      prevA: 0, prevD: 0,
      lastHitSide: -1
    };
  }

  /* ---------------------------------------------------------------------------
   * 步进入口：把 dt 拆成固定步长
   * input: { a, d, steer, brake, throttle, gearDelta }
   * ctx:   { slope, curv, onRoad, cdaFactor, headwind }
   * ------------------------------------------------------------------------ */
  function step(st, input, ctx, dt) {
    var remain = Math.min(dt, C.NET.MAX_DT);
    var steps = 0;
    while (remain > 1e-6 && steps < MAX_SUBSTEPS) {
      var h = Math.min(FIXED_DT, remain);
      substep(st, input, ctx, h);
      remain -= h;
      steps++;
    }
    return st;
  }

  function substep(st, input, ctx, h) {
    var B = C.BIKE, P = C.PEDAL, S = C.STEER;

    /* ============ 1. 换挡（Q/E 折成 gearDelta） ============ */
    if (input.gearDelta) {
      var ng = C.clamp(st.gear + input.gearDelta, B.GEAR_MIN, B.GEAR_MAX);
      if (ng !== st.gear) {
        st.gear = ng;
        st.gearCd = B.GEAR_CD;
        st.shiftFlash = 0.30;      // 动力中断
      }
    }
    if (st.gearCd > 0) st.gearCd = Math.max(0, st.gearCd - h);
    if (st.shiftFlash > 0) st.shiftFlash = Math.max(0, st.shiftFlash - h / 0.30);

    /* ============ 2. 左右脚施力收敛（"按住加力"而非瞬时点按） ============ */
    var wantL = input.a ? 1 : 0;
    var wantR = input.d ? 1 : 0;
    // 边沿检测：新按下时记录一次"发力事件"，用于完美/失误统计
    if (wantL && !st.prevA) recordPress(st, 0);
    if (wantR && !st.prevD) recordPress(st, 1);
    st.prevA = wantL; st.prevD = wantR;

    var rateL = wantL > st.leftForce ? P.ATTACK : P.RELEASE;
    var rateR = wantR > st.rightForce ? P.ATTACK : P.RELEASE;
    st.leftForce += (wantL - st.leftForce) * Math.min(1, rateL * h);
    st.rightForce += (wantR - st.rightForce) * Math.min(1, rateR * h);
    if (st.leftForce < 1e-4) st.leftForce = 0;
    if (st.rightForce < 1e-4) st.rightForce = 0;

    /* ============ 3. 曲柄角推进（两来源取大者） ============ */
    var ratio = C.gearRatio(st.gear);

    // A. 踩踏驱动转速
    var pedalSignal = (st.leftForce + st.rightForce) * P.PEDAL_SIGNAL_K;
    var cadDrive = C.cadenceTarget(st.gear) * C.clamp(pedalSignal, 0, 1.05);

    // B. 固定传动比联动（速度决定）
    var cadLink = C.cadenceFromSpeed(st.speed, st.gear);

    var cadTarget = Math.max(cadDrive, cadLink);
    // 一阶趋近：曲柄有转动惯量，不会瞬间变转速
    var cadAlpha = C.clamp(h / P.CAD_TAU, 0, 1);
    st.cadence += (cadTarget - st.cadence) * cadAlpha;
    if (st.cadence < 0) st.cadence = 0;

    st.crank = (st.crank + C.crankAdvanceRate(st.cadence) * h) % 360;

    /* ============ 4. 有效力矩（核心玩法） ============
     * 按住发力键 → 获得"标线当前所在颜色区"对应的力，逐帧连续结算：
     *   绿区(gain≥0.75) → 单侧最佳力矩，接近满值
     *   黄区(0.45~0.75)/橙区(0.15~0.45) → 按 gain 线性打折
     *   红区(gain<0.15，含负) → gain 为负 → 产生【反向】力矩，实际拖慢车
     * ★ 必须允许负值：原来写成 Math.max(0, torqueSignal) 会把红区反向力截断成 0，
     *   变成"红区按住只是没力"，与"踩错相位适得其反"的设计意图不符。 */
    var gainL = C.footGain(st.crank, 0);
    var gainR = C.footGain(st.crank, 1);
    var torqueSignal = gainL * st.leftForce + gainR * st.rightForce;
    var driveGain = torqueSignal;                    // 可正可负
    var posGain = Math.max(0, torqueSignal);         // 正向部分（功率/滑行判定用）
    st.driveGain = driveGain;
    st.reverse = driveGain < -1e-4;

    /* ============ 5. 连击（节奏精准的奖励） ============ */
    // 只在"某只脚正发力"时结算，避免空转白送加成
    var activeGain = -Infinity;
    if (st.leftForce > 0.4) activeGain = Math.max(activeGain, gainL);
    if (st.rightForce > 0.4) activeGain = Math.max(activeGain, gainR);
    if (activeGain > -Infinity) {
      if (activeGain >= P.COMBO_GOOD_GAIN) {
        st.combo = Math.min(P.COMBO_MAX, st.combo + P.COMBO_STEP * h * 10);
      } else if (activeGain <= P.COMBO_BAD_GAIN) {
        st.combo = Math.max(0, st.combo - P.COMBO_DECAY * h * 3);
      }
    } else {
      st.combo = Math.max(0, st.combo - P.COMBO_DECAY * h * 0.5);
    }

    /* --- 发力周期结算：每只脚"发力→松力"为一个周期，结束时按峰值力矩评分 ---
     * 用周期峰值而非按下瞬间的力矩，更符合"在绿区保持发力"的实际手法。 */
    settleFootCycle(st, 0, st.leftForce, gainL);
    settleFootCycle(st, 1, st.rightForce, gainR);

    /* ============ 6. 踏频效率 & 传动效率（踩空惩罚） ============ */
    var cadEff = C.cadenceEfficiency(st.cadence);

    /* 传动效率：曲柄转速对应的"车速"明显高于实际车速 → 后轮跟不上的踩空。
     * ★ 只在 st.speed > 4 m/s 时启用：低速起步本来是"高扭矩低转速"，
     *   若在此处惩罚会导致静止/爬坡起步直接死锁。 */
    var driveEff = 1;
    if (st.speed > 4) {
      var vAtCad = C.speedFromCadence(st.cadence, st.gear);
      var slipRatio = vAtCad / st.speed;
      driveEff = 1 / (1 + Math.pow(Math.max(0, slipRatio - 1.12) * 1.4, 1.4));
    }

    /* ============ 7. 功率 ============ */
    var comboMul = 1 + st.combo;
    /* 只有正向力矩产生功率；红区反向力矩不产功率（在受力合成里变成负驱动） */
    var rawPower = B.P_BASE * posGain * cadEff * driveEff * comboMul;
    if (st.shiftFlash > 0) rawPower *= 0.70;     // 换挡瞬间动力中断

    var alpha = C.clamp(h / Math.max(0.05, B.TORQUE_SMOOTH), 0, 1);
    st.power += (rawPower - st.power) * alpha;
    if (st.power < 0.5) st.power = 0;
    st.effort += (C.clamp(posGain * cadEff, 0, 1) - st.effort) * alpha;

    /* ============ 8. 体力（长时间高功率会掉功，制造配速策略） ============ */
    var drain = st.power > 300 ? (st.power - 300) / 1500 : 0;
    var recover = st.power < 140 ? 0.030 : 0;
    st.stamina = C.clamp(st.stamina - drain * h + recover * h, 0, 100);
    var staminaMul = 0.78 + 0.22 * (st.stamina / 100);

    /* ============ 9. 受力合成 ============ */
    var m = B.MASS;
    var slope = ctx.slope || 0;
    var onRoad = ctx.onRoad !== false;
    var mechPower = st.power * staminaMul;

    var driveAccel;
    if (st.speed > 1.2) driveAccel = mechPower / (m * st.speed);
    else driveAccel = C.clamp(mechPower / (m * 1.2), 0, B.A_LAUNCH_MAX);

    /* ★ 红区反向力矩 → 负驱动。单独结算，避免被上面的低速钳制吃掉。
     *   量级很小（REVERSE_K=1.35）：这是"使不上劲、被轻轻拖一下"，
     *   绝不是刹车。踩错要付出代价，但车仍靠惯性继续走。 */
    if (st.reverse) {
      var revA = B.REVERSE_K * driveGain * (1 - C.smoothstep(0, 8, st.speed) * 0.35);
      driveAccel += revA;
    }

    var dragA = C.dragAccel(st.speed, ctx.cdaFactor || 1, ctx.headwind || 0, m);
    var rollA = C.rollingAccel(st.speed, m, onRoad ? 1 : C.WORLD.OFFROAD_DRAG);
    var gravA = C.gravityAccel(slope);

    st.braking = !!input.brake;
    var brakeA = st.braking && st.speed > 0.05
      ? B.BRAKE_DECEL * (1 + C.clamp(st.speed / 22, 0, 0.28)) : 0;

    /* ★ 不踩 = 纯滑行：只受风阻 + 滚阻 + 坡度（真实的惯性衰减）。
     *   原来还额外叠了 COAST_DECEL=0.30，等于凭空多一份阻力，
     *   让"松脚滑行"掉速比真车快、红区更容易把车钉住 —— 已去掉。
     *   自由轮的真实行为就是：不踩也照样溜，只是不再加速。 */
    var a = driveAccel - dragA - rollA + gravA - brakeA;
    var prevSpeed = st.speed;
    st.speed = C.clamp(st.speed + a * h, 0, B.V_MAX);

    if (!onRoad) st.speed = Math.max(0, st.speed - 1.1 * h * C.clamp(st.speed / 8, 0, 1.6));

    st.accelerating = st.speed > prevSpeed + 1e-4;
    if (st.speed > st.maxSpeed) st.maxSpeed = st.speed;

    /* ============ 10. 沿赛道推进 ============ */
    var dS = st.speed * h;
    st.s = Track.normS(st.s + dS);
    st.dist += dS;

    /* ============ 11. 转向 / 过弯（速度越快越难） ============ */
    var spd = st.speed;
    var spdFactor = C.smoothstep(S.MIN_SPEED, S.FULL_SPEED, spd);
    var highDamp = 1 - S.HIGH_DAMP * C.smoothstep(S.HIGH_SPEED * 0.55, S.HIGH_SPEED * 1.5, spd);
    var steerRate = S.BASE_RATE * spdFactor * highDamp;
    if (st.braking) steerRate *= 0.72;

    var latTarget = input.steer ? input.steer * steerRate : 0;
    st.latVel += (latTarget - st.latVel) * C.clamp(h / S.LAT_SMOOTH, 0, 1);

    // 离心外推：过弯被推到外线
    var curv = ctx.curv || 0;
    var centri = spd > 2 ? -curv * spd * spd * S.CENTRI / (S.BASE_RATE * 2.2) : 0;
    st.lateral += (st.latVel + centri) * h;

    // 抓地力上限 → 推头：损失速度并继续外抛
    var latSpeed = Math.abs(st.latVel + centri);
    if (latSpeed > S.SLIP_REF) {
      var excess = latSpeed - S.SLIP_REF;
      st.lateral += Math.sign(st.latVel + centri) * excess * h * 1.6;
      st.speed = Math.max(0, st.speed * (1 - S.SLIP_LOSS * C.clamp(excess / S.SLIP_REF, 0, 1) * h * 3));
    }

    // 路面边界：压到护栏
    var half = C.WORLD.LANE_HALF;
    st.onRoad = Math.abs(st.lateral) <= C.WORLD.LANE_HALF;
    var wallHit = false;
    if (st.lateral > half) { st.lateral = half; st.latVel = -Math.abs(st.latVel) * 0.25; wallHit = true; }
    else if (st.lateral < -half) { st.lateral = -half; st.latVel = Math.abs(st.latVel) * 0.25; wallHit = true; }
    if (wallHit) {
      st.speed *= C.WORLD.WALL_DAMP;
      st.combo = Math.max(0, st.combo - 0.06);
    }

    /* ============ 12. 车身倾角（视觉） ============ */
    var leanTarget = C.clamp(-curv * spd * spd / B.G, -S.LEAN_MAX, S.LEAN_MAX)
      + C.clamp(-st.latVel * 0.16, -0.28, 0.28);
    st.lean += (leanTarget - st.lean) * C.clamp(h / S.LEAN_SPEED, 0, 1);

    /* ============ 13. 统计 ============ */
    st.avgPower += (st.power - st.avgPower) * C.clamp(h / 3.0, 0, 1);

    return st;
  }

  /** 记录一次"发力事件"：用于统计完美率 */
  function recordPress(st, side) {
    var g = C.footGain(st.crank, side);
    if (g >= C.PEDAL.COMBO_GOOD_GAIN) st.hitCount++;
    else if (g <= 0) st.missCount++;
    st.lastHitSide = side;
  }

  /* 单脚一个完整发力周期的评分结算（用周期内峰值力矩） */
  function settleFootCycle(st, side, force, gain) {
    var key = side === 0 ? '_cycL' : '_cycR';
    var cur = st[key];
    if (!cur) cur = st[key] = { active: false, peak: -Infinity };

    if (force > 0.55) {
      // 发力中：追踪峰值力矩
      if (!cur.active) { cur.active = true; cur.peak = gain; }
      else if (gain > cur.peak) cur.peak = gain;
    } else if (cur.active && force < 0.55) {
      // 松力：结算本次发力周期
      if (cur.active) {
        if (cur.peak >= C.PEDAL.COMBO_GOOD_GAIN * 0.88) st.goodHits++;
        else if (cur.peak <= 0.10) st.badHits++;
        st.pressCycles++;
        var q = C.hitQuality(Math.max(0, cur.peak));
        st.qualitySum += q;
      }
      cur.active = false;
      cur.peak = -Infinity;
    }
  }

  /* ---------------------------------------------------------------------------
   * 渲染辅助
   * ------------------------------------------------------------------------ */
  function worldPos(st) { return Track.posAt(st.s, st.lateral); }

  function headingY(st) {
    var p = Track.posAt(st.s, st.lateral);
    return Math.atan2(p.tx, p.tz);
  }

  /** 单只脚的完整 UI 状态 */
  function footUI(st, side) {
    var g = C.footGain(st.crank, side);
    var force = side === 0 ? st.leftForce : st.rightForce;
    return {
      side: side === 0 ? 'left' : 'right',
      gain: g,
      band: C.gainBand(g),
      force: force,
      deg: C.norm360(st.crank + (side === 1 ? C.PEDAL.RIGHT_OFFSET : 0)),
      active: force > 0.4,
      good: force > 0.4 && g >= C.PEDAL.COMBO_GOOD_GAIN,
      bad: force > 0.4 && g <= C.PEDAL.COMBO_BAD_GAIN,
      toPeak: C.degreesToPeak(st.crank, side)
    };
  }

  /** 教练提示（新手引导） */
  function advise(st) {
    var l = footUI(st, 0), r = footUI(st, 1), out = [];
    if (l.band === 'green' && l.force < 0.4) out.push({ side: 'left', action: 'press', msg: '左脚 · 现在踩 A' });
    if (r.band === 'green' && r.force < 0.4) out.push({ side: 'right', action: 'press', msg: '右脚 · 现在踩 D' });
    if (l.bad) out.push({ side: 'left', action: 'release', msg: '左脚上升行程 · 松 A' });
    if (r.bad) out.push({ side: 'right', action: 'release', msg: '右脚上升行程 · 松 D' });
    return out;
  }

  /** 换挡建议：当前速度下推荐挡位与偏差方向
   *  阈值对齐真实最佳踏频 90~100rpm（见 constants 里 PEDAL 的文献依据）：
   *  踏频 <80 就是"硬踩大盘"，功率会明显打折 → 提示降挡（变轻）
   *  踏频 >105 就是"踩空" → 提示升挡（变重） */
  function gearAdvice(st) {
    var rec = C.recommendGear(st.speed);
    var cad = st.cadence;
    var hint = null;
    if (st.gear < rec - 0.5) hint = { dir: 1, msg: '降挡' };        // 需要更轻
    else if (st.gear > rec + 0.5) hint = { dir: -1, msg: '升挡' };  // 需要更重
    else if (cad > 1 && cad < 80) hint = { dir: 1, msg: '踏频过低' };
    else if (cad > 105) hint = { dir: -1, msg: '踏频过高' };
    return { recommended: rec, hint: hint };
  }

  return {
    FIXED_DT: FIXED_DT,
    newRiderState: newRiderState,
    step: step, substep: substep, recordPress: recordPress,
    worldPos: worldPos, headingY: headingY,
    footUI: footUI, advise: advise, gearAdvice: gearAdvice
  };
});
