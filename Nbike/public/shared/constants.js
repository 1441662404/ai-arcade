/* =============================================================================
 * Nbike · shared/constants.js
 * 权威服务器与客户端预测必须逐项一致的常量表（服务端 require，浏览器挂全局）
 * 双模导出：CommonJS + 浏览器 classic script
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NB = root.NB || {}; root.NB.C = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 网络 / 循环（照搬接口文档 §1 的 Socket.IO 配置） ---------- */
  var NET = {
    TICK_HZ: 30,
    TICK_DT: 1 / 30,
    MAX_DT: 0.1,
    INPUT_HZ: 20,
    INPUT_DT: 1 / 20,
    MAX_PLAYERS: 30,
    PING_INTERVAL: 8000,
    PING_TIMEOUT: 25000,
    CONNECT_TIMEOUT: 45000,
    MAX_HTTP_BUFFER: 1e6
  };

  /* ---------- 世界 / 赛道 ---------- */
  var WORLD = {
    LANE_HALF: 4.2,        // 半路宽（m）—— 路面总宽 8.4m
    SHOULDER: 1.5,         // 路肩宽度
    OFFROAD_DRAG: 2.8,     // 出界滚阻倍率
    OFFROAD_GRIP: 0.5,
    WALL_DAMP: 0.62        // 撞护栏后的速度保留比例
  };

  /* ---------- 单车 / 车手 ---------- */
  var BIKE = {
    MASS_RIDER: 68,
    MASS_BIKE: 7.6,
    MASS: 75.6,
    WHEEL_CIRC: 2.199,     // 700x25c
    CRANK_LEN: 0.1725,     // 曲柄 172.5mm
    CHAINRING: 50,         // 单盘 50T
    CASSETTE: [11, 12, 13, 14, 15, 17, 19, 21, 24, 28, 32], // 11 速飞轮：0=最重
    GEAR_MIN: 0,
    GEAR_MAX: 10,
    /* ★ 默认挡位 = 2（13T）。
     *   起点已改成**下坡发车**，一出发就冲到 60~70km/h。
     *   19T 在 67km/h 时踏频 193rpm（踩不动），15T 也要 152rpm（仍超转）。
     *   13T 在 67km/h 约 138rpm、在 60km/h 约 124rpm —— 下坡段能正常发力。
     *   （平路/爬坡玩家按提示按 Q 降挡即可，HUD 会一直给建议。） */
    GEAR_DEFAULT: 2,       // 13T
    GEAR_CD: 0.15,         // 换挡冷却 s
    CDA: 0.300,
    CDS: 0.008,
    CRR: 0.0048,
    RHO: 1.18,
    G: 9.81,
    P_BASE: 520,           // ★ 完美踩踏的基准功率（标定参照见 PEDAL 注释）
    /* ★ 红区反向力矩系数：gain<0 时按住发力键会真的拖慢车（"踩错适得其反"）。
     *   ★ 量级必须小：这是"感觉使不上劲/被拖一下"，不是刹车。
     *     gain=−0.85 满反时约 −1.15 m/s²（≈0.12g）——
     *     远小于 BRAKE_DECEL(7.6)，也小于爬 8% 坡的重力分量(≈0.78)，
     *     因此不会把车钉死，仍然保留"不踩也有惯性滑行"的手感。
     *   ⚠️ 曾用 5.4 → 产生 −3~4 m/s²，几秒内直接停车，被玩家当成"按错就停"。 */
    REVERSE_K: 1.35,
    BRAKE_DECEL: 7.6,      // 刹车减速度 m/s²（50km/h 全力刹车约 12.7m，含空气阻力）
    COAST_DECEL: 0.30,
    A_LAUNCH_MAX: 4.5,     // 低速起步加速度上限 m/s²
    V_MAX: 30,             // 108 km/h 硬上限
    TORQUE_SMOOTH: 0.30    // 动力平滑时间常数（模拟飞轮惯性）
  };

  /* ---------- 转向 / 弯道手感 ---------- */
  var STEER = {
    BASE_RATE: 5.4,        // m/s 基础横向机动速度
    HIGH_DAMP: 0.62,       // 高速衰减比例
    MIN_SPEED: 1.0,
    FULL_SPEED: 4.5,
    HIGH_SPEED: 15.0,
    CENTRI: 0.42,          // 离心外推系数
    LAT_SMOOTH: 0.13,      // 横向速度平滑时间常数
    SLIP_REF: 3.1,         // 横向速度超过此值开始推头损失
    SLIP_LOSS: 0.30,       // 推头最大速度损失
    LEAN_MAX: 0.60,        // 车身最大倾角 rad
    LEAN_SPEED: 0.55       // 倾角随速度收敛的时间常数
  };

  /* ---------- 踩踏节奏系统（核心玩法） ----------
   * 曲柄角 θ：0° = 左脚上死点，顺时针推进。
   * 有效力矩系数 = sin θ，θ=90° 时力臂最大（3 点钟方向）；右脚相位 +180°。
   * 于是：一只脚下踩做功时，另一只必然在上升行程对抗 —— 这正是"错误加力适得其反"的物理来源。
   *
   * ★ 功率标定（关键，别乱改）：
   *     功率 = P_BASE × 即时驱动力矩 × 踏频效率 × 传动效率 × combo
   *   即时驱动力矩 = Σ(该脚 gain × 该脚力度)，单脚在 90° 满力 = 1.0
   *   玩家"在黄区提前发、绿区保持、黄区结束就松"时平均力矩 ≈ 0.77
   *   → 平均功率 ≈ 380 × 0.77 ≈ 293W，对应平路约 40km/h（符合真实）
   *   完赛均速 33~35km/h，职业级选手在真实环法山地赛段约 35~38km/h，标定合理。
   */
  var PEDAL = {
    RIGHT_OFFSET: 180,
    ATTACK: 12.0,          // 施力上升速率（力度 0→0.63 约 0.083s）
    RELEASE: 15.0,         // 松力衰减速率（必须快，否则力拖进上升行程被罚）
    /* ⚠️ 以下四个参数已废弃：发力曲线改为 STROKE_TABLE 查表（见下方 footGain）。
     *   保留只是为了兼容旧配置读取，新逻辑不再使用。 */
    POS_FLOOR: 0.16,       // [废弃] 旧力矩地板
    POS_EXP: 0.90,         // [废弃] 旧曲线指数
    NEG_SCALE: 0.85,       // [废弃] 旧对抗强度
    NEG_EXP: 1.10,         // [废弃] 旧对抗指数
    START_CRANK: 90,       // 起步相位：3 点钟方向（有力矩臂，真实起步姿势）
    /* 推荐手法：黄区（gain≥0.45）提前发力 → 绿区保持 → 黄区结束（gain<0.45）松力。
       BOT_* 为参考手法阈值，也用于新手教练提示。 */
    TECH_PRESS: 0.45,
    TECH_RELEASE: 0.45,
    COMBO_STEP: 0.05,      // 单次完美发力命中的 combo 增量
    COMBO_MAX: 0.34,
    COMBO_DECAY: 2.4,
    COMBO_GOOD_GAIN: 0.72, // gain 高于此值算"完美发力"
    COMBO_BAD_GAIN: -0.25, // gain 低于此值清空 combo

    /* --- 踏频模型：两个来源取较大者，保证"起步不死锁 + 固定传动比" --- */
    CAD_BASE: 92,          // 基准挡位(19T)满力时的目标踏频 rpm
    CAD_REF_RATIO: 2.632,  // 基准齿比 = 50/19；轻齿比踏频更高、重齿比更低
    CAD_RATIO_EXP: 0.42,
    CAD_TAU: 0.40,         // 踏频趋近时间常数 s
    PEDAL_SIGNAL_K: 0.72,  // 双脚力度 → 踩踏信号（单脚满力 = 0.72）

    /* --- 传动效率（踩空惩罚）：曲柄转速对应的车速远高于实际车速 → 打滑踩空 --- */
    SLIP_K: 0.62,
    SLIP_EXP: 1.8,
    SLIP_REF_SPEED: 0.9,   // 速度下限，避免静止除零

    /* --- 踏频效率：太低踩不动 / 太高踩空 ---
     * ★ 峰值必须落在 90~100rpm（这是有实测依据的）：
     *   · Redfield & Hull (1986)：以腿部各关节扭矩之和为目标函数，
     *     最小耗能的踏频落在 90~100rpm
     *   · Hull (1988)：综合关节扭矩 + 肌肉张力，最优 90~100rpm
     *   · Hagberg (1981)：从无阻力到有阻力，最优踏频逐渐升到 ~100rpm
     *   · 职业车手实际巡航踏频 90~110rpm（Craig Griffin：能稳住 120rpm 就不会被甩掉）
     *   因此：90~100rpm 效率最高（=1.0），偏离两侧都衰减，
     *   且**低踏频的代价必须明显** —— 现实中"大盘带小飞"硬踩（~60rpm）功率会大打折扣。 */
    CAD_LO: 35,            // 低于此踏频几乎发不出功率
    /* ★ CAD_LO_FULL 必须给够余量：起步阶段速度低、踏频天然只有 40~60rpm，
     *   若此处要求太高（曾设 85）会形成死循环——
     *   踩不动 → 速度上不去 → 踏频更低 → 效率趋近 0，车彻底起不来。
     *   72 是实测的平衡点：起步能顺畅拉起来，同时"硬踩重齿比"依然吃亏。 */
    CAD_LO_FULL: 72,       // 爬到 72rpm 接近满效率
    CAD_PEAK_LO: 90,       // 最佳区间下沿
    CAD_PEAK_HI: 100,      // 最佳区间上沿
    CAD_HI: 112,           // 超过此值开始衰减
    CAD_HI_END: 145,
    CAD_HI_PENALTY: 0.55   // 极高踏频最多掉 55%
  };

  /** 该挡位下"满力所能达到的目标踏频"（齿比越轻踏频越高） */
  function cadenceTarget(gearIndex) {
    var ratio = gearRatio(gearIndex);
    return PEDAL.CAD_BASE * Math.pow(PEDAL.CAD_REF_RATIO / ratio, PEDAL.CAD_RATIO_EXP);
  }

  /**
   * 建议挡位：让"当前速度"对应的踏频落在最佳区间（90~100rpm，见 PEDAL 注释）。
   * ★ 必须处理速度趋近 0 的极限：所有挡位踏频都是 0，要选最轻的挡位。
   *   否则会误判成"最重挡"（0 也落在区间内），导致起步踩不动。
   * ★ 这也正是现实中的起步方式：大盘(50T) 带最大飞轮(32T)，
   *   齿比 1.56，起步轻、踏频容易上到 90；反之用小飞起步会"蹬不动"。
   */
  function recommendGear(speed) {
    if (speed < 1.6) return BIKE.GEAR_MAX;    // 起步/爬极陡坡 → 最轻（≈ 大盘带大飞）
    var best = BIKE.GEAR_DEFAULT, bestCost = Infinity;
    for (var g = BIKE.GEAR_MIN; g <= BIKE.GEAR_MAX; g++) {
      var cad = cadenceFromSpeed(speed, g);
      var cost;
      /* 低于 90 的惩罚加重（1.35 倍）：现实中硬踩重齿比，功率掉得比"踏频略高"更狠 */
      if (cad < PEDAL.CAD_PEAK_LO) cost = (PEDAL.CAD_PEAK_LO - cad) * 1.35;
      else if (cad > PEDAL.CAD_PEAK_HI) cost = (cad - PEDAL.CAD_PEAK_HI) * 1.6;
      else cost = 0;
      if (cost < bestCost) { bestCost = cost; best = g; }
    }
    return best;
  }

  /* 档位分档颜色（用于 HUD 提示"该升挡/该降挡"） */
  var BANDS = ['red', 'orange', 'yellow', 'green'];

  var COLORS = {
    red: '#ff3b30', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158',
    idle: '#39404d', blue: '#0a84ff'
  };

  /* ---------- 跟风 / 空气动力学 ----------
   * ★ 按实测风洞数据标定（Blocken et al. 2013/2018，TU/e + Canyon 车队）：
   *   与前车距离 → 风阻降低
   *     0.1 m → 38~40%
   *     0.5 m → 27~35%
   *     1.0 m → 18~25%
   *     3.0 m →  8~12%
   *     >10 m →  <2%
   *   拟合为指数衰减：k(gap) = MAX_SAVE * exp(-(gap - GAP0) / LAMBDA)
   *   MAX_SAVE=0.42（贴到 0.1m 的极限）、LAMBDA=1.35 m 时可复现上表。
   *   ⚠️ 原实现是"线性衰减到 48m"，与真实差得远 —— 真实 3m 外几乎没用，
   *      这才是"必须紧跟才能吃到尾流"的物理原因。 */
  var DRAFT = {
    GAP0: 0.10,            // 最近有效距离（m）——再近就撞上了
    /* λ 由实测表反拟合：λ=2.0 时
     *   0.1m→42% / 0.5m→34% / 1.0m→27% / 3.0m→10% / 10m→0.3%
     * 与 Blocken 风洞表（38~40 / 27~35 / 18~25 / 8~12 / <2）整体吻合。
     * λ=1.35 会让 3m 处只剩 4.9%，偏离实测下沿。 */
    LAMBDA: 2.00,          // 指数衰减长度（m）
    MAX_DIST: 12,          // 超过此距离完全无效果（真实 >10m 就 <2%）
    MAX_SAVE: 0.42,        // 极限风阻降低比例（贴前车）
    LAT_MAX: 1.10,         // 横向有效半宽（m）——真实尾流只比车身宽一点
    MIN_CDA: 0.58,         // CdA 最低降到 58%（= 风阻降 42%）
    CONE_COS: -0.82        // 与前车行进方向点积阈值（约 ±35° 锥角）
  };

  /* ---------- 比赛规则 ---------- */
  var RACE = {
    DEFAULT_LAPS: 1,
    LAP_OPTIONS: [1, 2, 3],
    COUNTDOWN: 5,
    GRID_SPACING: 2.4,     // 起点线后方依次排开
    FINISH_LINGER: 12,
    RESET_DELAY: 16,
    DNF_TIMEOUT: 300
  };

  var RIDER_COLORS = ['#ff4d4f', '#ffa940', '#ffd666', '#95de64', '#5cdbd3',
    '#69c0ff', '#b37feb', '#ff85c0', '#f759ab', '#d4b106', '#7cb305', '#08979c',
    '#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#13c2c2', '#2f54eb'];

  /* ============================================================
   * 纯函数：两端共用的推导（改动必须同步影响服务端与客户端预测）
   * ========================================================== */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = (x - a) / (b - a);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }
  function norm360(deg) { var d = deg % 360; return d < 0 ? d + 360 : d; }
  function toRad(d) { return d * Math.PI / 180; }

  function gearCog(i) {
    return BIKE.CASSETTE[clamp(i | 0, BIKE.GEAR_MIN, BIKE.GEAR_MAX)];
  }
  function gearRatio(i) { return BIKE.CHAINRING / gearCog(i); }
  /** 单次曲柄转动推动的距离（m）—— 用于换算踏频与速度 */
  function gearDevelop(i) { return gearRatio(i) * BIKE.WHEEL_CIRC; }

  /** 由速度反推踏频 rpm（固定传动比：曲柄与后轮刚性联动） */
  function cadenceFromSpeed(speed, gearIndex) {
    var dev = gearDevelop(gearIndex);
    return dev <= 0 ? 0 : (Math.max(0, speed) / dev) * 60;
  }
  /** 由踏频反推速度 m/s */
  function speedFromCadence(cad, gearIndex) {
    return (Math.max(0, cad) / 60) * gearDevelop(gearIndex);
  }

  /* ============================================================
   * 核心玩法：踩踏节奏（力矩物理）
   * ========================================================== */

  /* 单只脚在给定曲柄角下的有效力矩系数（真实踩踏发力曲线）
   *
   * ★ 曲线依据（自行车生物力学对曲柄切向力的实测结果）：
   *   · Coyle et al. (1991) / Patterson et al. (1983) / Wilkinson et al. (2020)：
   *     下踩行程（0~180°）的切向力远大于上提行程，峰值出现在 90° 前后
   *   · Childers et al. (2009) 的四阶段划分（业内通用）：
   *       推压 Push    45°~135°  ← 贡献约 70% 功率，峰值 90°
   *       拉回 Pull   135°~225°  ← 贡献约 10~20%
   *       提拉 Lift   225°~315°  ← 几乎不产功率（好骑手只做"卸重"）
   *       准备 Thrust 315°~45°   ← 膝盖前顶，为推压做准备
   *   · 上下死点 0°(TDC) / 180°(BDC) 附近切向力最小 —— 天然死点
   *
   * 因此真实的"有效发力区间"是 **约 335° → 200°**（跨越上死点）：
   *   比"0°~180°"更早开始、更晚结束，这正是"提前发力、踩到底"的动作要领。
   *
   * 原实现用纯 sin 曲线：0° 才开始、180° 就归零，区间太窄、起步太晚，
   * 与真实踩踏不符 —— 这也是"发力区间不够科学"的根源。
   * 现在改为按实测形状查表 + 余弦平滑插值。
   *
   * 表：索引 i 对应曲柄角 i×10°，共 36 个采样点（0°~350°），值 = 有效力矩系数
   *   正值 = 驱动前进；负值 = 对抗另一条腿（提拉阶段压着不松）
   *
   * ★ 两个约束必须同时满足：
   *   ① 死点（0° / 180°）附近切向力接近 0 —— 这是真实的（TDC/BDC 处力臂为 0，
   *      腿部接近竖直，踩下去也转不动曲柄）。之前这里给了 0.26 的正值，
   *      导致"双脚全按"在死点处仍有 0.52 的净推力。
   *   ② 曲线要接近【反对称】：g(θ) + g(θ+180°) ≈ 0。
   *      因为右脚相位恒为左脚+180°，只有反对称才能让"两脚都按住"净力矩≈0，
   *      "踩错要罚"才成立（曾实测乱按 230W ≈ 正确节奏 215W，玩法失效）。
   *   于是：推压段（约 20°~160°）给正，提拉段（约 200°~340°）给同样深度的负。 */
  var STROKE_TABLE = [
    0.10, 0.30, 0.52, 0.70, 0.83, 0.92,   //   0°~ 50°  死点起步 → 推压期上升
    0.97, 0.99, 1.00, 1.00, 0.99, 0.96,   //  60°~110°  峰值平台（力臂最大）
    0.90, 0.81, 0.70, 0.55, 0.38, 0.20,   // 120°~170°  推压期末端，快速衰减
    0.02, -0.20, -0.42, -0.62, -0.78, -0.90, // 180°~230° 下死点→拉回期
    -0.97, -1.00, -0.99, -0.94, -0.86, -0.74, // 240°~290° 提拉期（负值最深区）
    -0.60, -0.44, -0.28, -0.12, 0.02, 0.06 // 300°~350° 提拉末→准备期回归
  ];

  function footGain(crankDeg, side) {
    var d = norm360(crankDeg + (side === 1 ? PEDAL.RIGHT_OFFSET : 0));
    var x = d / 10;
    var i0 = Math.floor(x) % STROKE_TABLE.length;
    var i1 = (i0 + 1) % STROKE_TABLE.length;
    var f = x - Math.floor(x);
    /* 余弦插值：比线性更顺滑，采样点两侧导数连续，不会出现折角顿挫 */
    var t = (1 - Math.cos(f * Math.PI)) / 2;
    return STROKE_TABLE[i0] * (1 - t) + STROKE_TABLE[i1] * t;
  }

  /* 提示分档：绿 → 黄 → 橙 → 红
   * 阈值按"含地板值"的新曲线重新标定：
   *   gain ≥0.75 → 绿（优质发力区）  0.45~0.75 → 黄（接近）  0.15~0.45 → 橙（勉强）  <0.15 → 红（错误） */
  function gainBand(g) {
    if (g >= 0.75) return 'green';
    if (g >= 0.45) return 'yellow';
    if (g >= 0.15) return 'orange';
    return 'red';
  }

  /** 距离最佳发力点（力矩峰值 90°）还有多少度，用于提前提示 */
  function degreesToPeak(crankDeg, side) {
    var d = norm360(crankDeg + (side === 1 ? PEDAL.RIGHT_OFFSET : 0));
    var delta = ((90 - d + 540) % 360) - 180;
    return delta;   // 负 = 还差多少度到峰值；正 = 已过峰值多少度
  }

  /** 单次发力的即时得分（0..1），用于判定"完美/良好/失误" */
  function hitQuality(g) {
    if (g >= 0.88) return 1.0;
    if (g >= 0.75) return 0.85;
    if (g >= 0.45) return 0.55;
    if (g >= 0.15) return 0.25;
    return 0;
  }

  /** 踏频效率：太低踩不动、太高踩空 */
  /* 踏频效率：峰值平台 90~100rpm（见 PEDAL 注释里的文献依据）
   *   低踏频侧：35 → 85rpm 平滑爬升（现实中硬踩大盘，功率大打折扣）
   *   平台区：  85~115rpm 保持满效率（职业车手巡航落在 90~110）
   *   高踏频侧：超过 115rpm 开始衰减，到 150rpm 掉 55%（踩空）*/
  function cadenceEfficiency(cad) {
    var lo = smoothstep(PEDAL.CAD_LO, PEDAL.CAD_LO_FULL, cad);
    var hi = 1 - PEDAL.CAD_HI_PENALTY * smoothstep(PEDAL.CAD_HI, PEDAL.CAD_HI_END, cad);
    return lo * hi;
  }

  /** 曲柄角速度 deg/s */
  function crankAdvanceRate(cadence) { return cadence * 6; }

  /* ---- 阻力 ---- */
  function dragAccel(speed, cdaFactor, headwind, mass) {
    var rel = speed + (headwind || 0);
    var F = 0.5 * BIKE.RHO * BIKE.CDA * cdaFactor * rel * Math.abs(rel);
    return F / mass;
  }
  function rollingAccel(speed, mass, crrMul) {
    if (speed <= 0.001) return 0;
    return BIKE.CRR * (crrMul || 1) * BIKE.G;
  }
  function gravityAccel(slopeRad) { return -BIKE.G * Math.sin(slopeRad); }

  function powerZone(w) {
    if (w < 110) return { key: 'z1', label: '恢复', color: '#8e9aaf' };
    if (w < 175) return { key: 'z2', label: '耐力', color: '#30d158' };
    if (w < 240) return { key: 'z3', label: '节奏', color: '#ffd60a' };
    if (w < 310) return { key: 'z4', label: '阈值', color: '#ff9f0a' };
    if (w < 400) return { key: 'z5', label: '最大摄氧', color: '#ff6b22' };
    return { key: 'z6', label: '无氧冲刺', color: '#ff3b30' };
  }

  /** 从平均踏频估算心率（仅供 HUD，服务端也用它，保证两端一致） */
  function estHeartRate(power, effort) {
    var hr = 62 + 108 * smoothstep(60, 420, power) + 14 * smoothstep(0.2, 0.9, effort || 0);
    return Math.round(clamp(hr, 60, 196));
  }

  return {
    NET: NET, WORLD: WORLD, BIKE: BIKE, STEER: STEER, PEDAL: PEDAL, BANDS: BANDS,
    DRAFT: DRAFT, RACE: RACE, COLORS: COLORS, RIDER_COLORS: RIDER_COLORS,
    gearCog: gearCog, gearRatio: gearRatio, gearDevelop: gearDevelop,
    cadenceFromSpeed: cadenceFromSpeed, speedFromCadence: speedFromCadence,
    cadenceTarget: cadenceTarget, recommendGear: recommendGear,
    footGain: footGain, gainBand: gainBand, hitQuality: hitQuality,
    degreesToPeak: degreesToPeak, cadenceEfficiency: cadenceEfficiency,
    crankAdvanceRate: crankAdvanceRate,
    dragAccel: dragAccel, rollingAccel: rollingAccel, gravityAccel: gravityAccel,
    powerZone: powerZone, estHeartRate: estHeartRate,
    clamp: clamp, lerp: lerp, smoothstep: smoothstep, norm360: norm360, toRad: toRad
  };
});
