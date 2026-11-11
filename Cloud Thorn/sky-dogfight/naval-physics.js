// =============================================================================
// === 战舰物理与战斗（双端共享 UMD）=============================================
// =============================================================================
// 服务端 require() 后驱动权威模拟；客户端经 /naval-physics.js 加载后用于本地预测。
// ⚠️ 改这里必须重启服务端，否则客户端预测与服务端不一致 → 舰船抖动/炮击错位。
//
// 设计要点（模仿《战舰世界》的核心手感，但简化到浏览器可承受）：
//   1) 船有巨大惯性：油门档位给目标航速，实际速度按加速度渐进；转向有舵角延迟。
//   2) 船体随浪起伏（横摇/纵摇/升沉），转向时向内侧横倾 —— 这是"船感"的主要来源。
//   3) 主炮塔有独立伺服（方位+俯仰），转动有角速度上限，不能瞬移瞄准。
//   4) 炮弹走真实弹道（初速+重力+空气阻力），飞行时间可达数秒 → 必须打提前量。
//   5) 命中按装甲分区（舷侧装甲带 / 甲板 / 上层建筑 / 水下）算穿透与伤害。
//   6) 损管：进水（降低储备浮力、减速）、起火（持续掉血）、模块损毁（炮塔/舵/引擎）。
// =============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavalPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  // ---------------------------------------------------------------------------
  // === 舰种配置 ==============================================================
  // ---------------------------------------------------------------------------
  // 数值取向：战舰世界风格——战列舰慢但硬且痛、巡洋舰均衡、驱逐舰快脆但有鱼雷。
  const SHIP_TYPES = {
    // ---- 战列舰：重甲巨炮，转向极慢，齐射一轮能重创巡洋舰 ----
    bb: {
      id: 'bb', type: 'bb', name: '战列舰', short: 'BB',
      len: 245, beam: 33, draft: 9.5,       // 长/宽/吃水（米）
      freeboard: 12,                        // 干舷高度（甲板到水线）
      hp: 4200,                             // 总血量
      mass: 52000,                          // 排水量（吨）
      maxSpeed: 15.5,                       // 最大航速 m/s（约 30 节）
      accel: 0.55,                          // 加速度 m/s²（巨大惯性）
      brakeAccel: 0.85,
      reverseSpeed: 5.5,                    // 倒车速度
      rudderRate: 0.115,                    // 最大转向角速度 rad/s（约 6.6°/s，极慢）
      rudderLag: 3.4,                       // 舵响应延迟（秒，越大越迟钝）
      turnBleed: 0.72,                      // 转向时速度衰减系数
      rollAmp: 0.030,                       // 转向横倾幅度 rad
      rollLag: 4.0,                         // 横倾恢复延迟
      pitchAmp: 0.011,                      // 纵摇幅度
      // 装甲：分区厚度（mm），决定穿深需求
      armor: { belt: 380, deck: 150, superstructure: 40, underwater: 220, bow: 130, stern: 90 },
      // 主炮：三联装 × 3 座（前二后一）
      mainGuns: {
        count: 3, barrels: 3, caliber: 406, // 口径 mm
        // 炮塔位置（along 为沿轴比例，正=舰艏；dy = 背负式炮塔抬高米数）
        // 布局仿衣阿华级：前二（背负）后一
        turretSpots: [
          { along: 0.62, lateral: 0, elev: 1, dy: 0 },
          { along: 0.44, lateral: 0, elev: 1, dy: 2.8 },
          { along: -0.52, lateral: 0, elev: -1, dy: 0 }
        ],
        reload: 26,                         // 装填时间（秒，齐射节奏）
        turretTurn: 0.30,                   // 炮塔方位转速 rad/s（约 17°/s）
        elevRate: 0.22,                     // 俯仰转速
        elevMin: -0.05, elevMax: 0.72,      // 俯仰范围 rad（-3°~41°）
        shellSpeed: 820,                    // 初速 m/s
        shellMass: 1050,                    // 弹重 kg
        dragCoef: 0.0000227,                // 弹道系数 k（a = k*v²，406mm/1050kg 实测值）
        spread: 0.0035,                     // 散布 rad
        damage: 1380,                       // 单发基础伤害
        penAt1km: 720,                      // 1km 处穿深 mm
        penFalloff: 0.00028,                // 每米衰减
        muzzleFlash: 1.0
      },
      // 副炮：用于近距自卫（对海/对空）
      secondary: {
        count: 8, barrels: 2, caliber: 127,
        reload: 5.5, turretTurn: 0.9, elevMin: -0.1, elevMax: 1.2,
        shellSpeed: 790, damage: 60, range: 5200, spread: 0.008,
        pen: 210
      },
      // 防空：大量小口径速射炮（数值刻意压低：防空是威胁而不是铁幕，
      // 飞机必须能冒着损伤突防投弹——实测 5dps/s 的版本 21 秒击落一架轰炸机）
      aa: {
        count: 16, dps: 5, range: 3000,     // 每秒对空伤害 / 射程
        turretTurn: 2.2, burst: 0.12
      },
      torpedo: null,                         // 战列舰无鱼雷
      // 损管
      repair: { floodRate: 0.55, fireRate: 0.35, dcCooldown: 90, dcHeal: 0.16 },
      // 视觉
      color: { hull: 0x5a6068, deck: 0x3d4247, turret: 0x4e545b, boot: 0x22262a },
      // 选船界面的定位描述
      role: '重甲巨炮 · 齐射决胜',
      tier: 10
    },

    // ---- 巡洋舰：均衡型，速射炮 + 强力防空 + 鱼雷 ----
    ca: {
      id: 'ca', type: 'ca', name: '巡洋舰', short: 'CA',
      len: 185, beam: 20, draft: 6.5,
      freeboard: 10,
      hp: 2600,
      mass: 13500,
      maxSpeed: 19.5,                       // 约 38 节
      accel: 1.05,
      brakeAccel: 1.4,
      reverseSpeed: 7,
      rudderRate: 0.20,
      rudderLag: 2.8,
      turnBleed: 0.82,
      rollAmp: 0.055,
      rollLag: 2.6,
      pitchAmp: 0.016,
      armor: { belt: 152, deck: 65, superstructure: 25, underwater: 90, bow: 60, stern: 45 },
      mainGuns: {
        count: 4, barrels: 3, caliber: 203,
        turretSpots: [
          { along: 0.60, lateral: 0, elev: 1, dy: 0 },
          { along: 0.40, lateral: 0, elev: 1, dy: 2.4 },
          { along: -0.44, lateral: 0, elev: -1, dy: 0 },
          { along: -0.62, lateral: 0, elev: -1, dy: 2.2 }
        ],
        reload: 9.5,
        turretTurn: 0.42,
        elevRate: 0.30,
        elevMin: -0.06, elevMax: 0.68,
        shellSpeed: 900,
        shellMass: 152,
        dragCoef: 0.0000391,
        spread: 0.0032,
        damage: 420,
        penAt1km: 340,
        penFalloff: 0.00042,
        muzzleFlash: 0.6
      },
      secondary: {
        count: 6, barrels: 2, caliber: 100,
        reload: 3.6, turretTurn: 1.1, elevMin: -0.1, elevMax: 1.25,
        shellSpeed: 880, damage: 32, range: 4600, spread: 0.009,
        pen: 130
      },
      aa: {
        count: 22, dps: 8, range: 3200,
        turretTurn: 2.8, burst: 0.09
      },
      torpedo: {
        tubes: 2, perTube: 4,                    // 2 座四联装
        tubeSpots: [{ along: 0.05, lateral: 1 }, { along: 0.05, lateral: -1 }],
        speed: 62, range: 11000, damage: 2400,
        reload: 96, spread: 0.05, turnRate: 0.10
      },
      repair: { floodRate: 0.75, fireRate: 0.5, dcCooldown: 70, dcHeal: 0.20 },
      color: { hull: 0x616870, deck: 0x41464b, turret: 0x555b62, boot: 0x23272b },
      role: '速射压制 · 防空屏障',
      tier: 8
    },

    // ---- 驱逐舰：小而快，鱼雷是主武器，主炮只能骚扰 ----
    dd: {
      id: 'dd', type: 'dd', name: '驱逐舰', short: 'DD',
      len: 118, beam: 12, draft: 4.2,
      freeboard: 8,
      hp: 1650,
      mass: 2400,
      maxSpeed: 24.5,                       // 约 48 节
      accel: 1.9,
      brakeAccel: 2.6,
      reverseSpeed: 9,
      rudderRate: 0.34,
      rudderLag: 1.5,
      turnBleed: 0.88,
      rollAmp: 0.085,
      rollLag: 1.9,
      pitchAmp: 0.026,
      armor: { belt: 19, deck: 12, superstructure: 8, underwater: 14, bow: 10, stern: 8 },
      mainGuns: {
        count: 3, barrels: 2, caliber: 127,
        turretSpots: [
          { along: 0.52, lateral: 0, elev: 1, dy: 0 },
          { along: 0.26, lateral: 0, elev: 1, dy: 2.0 },
          { along: -0.36, lateral: 0, elev: -1, dy: 0 }
        ],
        reload: 3.4,
        turretTurn: 0.95,
        elevRate: 0.55,
        elevMin: -0.12, elevMax: 0.95,
        shellSpeed: 792,
        shellMass: 24,
        dragCoef: 0.0000970,
        spread: 0.0060,
        damage: 105,
        penAt1km: 130,
        penFalloff: 0.00090,
        muzzleFlash: 0.32
      },
      secondary: null,
      aa: {
        count: 12, dps: 5, range: 2600,
        turretTurn: 3.4, burst: 0.07
      },
      torpedo: {
        tubes: 2, perTube: 5,                    // 2 座五联装（驱逐舰的灵魂）
        tubeSpots: [{ along: 0.02, lateral: 1 }, { along: 0.02, lateral: -1 }],
        speed: 70, range: 13500, damage: 3200,
        reload: 78, spread: 0.035, turnRate: 0.13
      },
      repair: { floodRate: 0.95, fireRate: 0.7, dcCooldown: 55, dcHeal: 0.25 },
      color: { hull: 0x676e76, deck: 0x474c51, turret: 0x5b6169, boot: 0x25292d },
      role: '高速突袭 · 鱼雷猎杀',
      tier: 6
    }
  };

  const SHIP_TYPE_LIST = ['bb', 'ca', 'dd'];

  // ---------------------------------------------------------------------------
  // === 海况（波浪）============================================================
  // ---------------------------------------------------------------------------
  // 与客户端海面着色器共用同一组参数，保证船体起伏和视觉海浪同步。
  const SEA = {
    amp: 1.35,          // 基础浪高（米）
    amp2: 0.55,         // 次级浪
    len: 190,           // 主浪波长
    len2: 74,
    speed: 7.2,         // 浪传播速度
    wind: 0.6           // 风向（弧度）
  };

  // 波浪高度场：返回该点水面高度（米）。客户端海面 mesh 用同一公式。
  function waveHeight(x, z, t) {
    const k1 = TAU / SEA.len, k2 = TAU / SEA.len2;
    const dx = Math.cos(SEA.wind), dz = Math.sin(SEA.wind);
    const p1 = (x * dx + z * dz) * k1 - t * SEA.speed * k1;
    const p2 = (x * -dz + z * dx) * k2 - t * SEA.speed * 1.4 * k2;
    return Math.sin(p1) * SEA.amp + Math.sin(p2 + 1.7) * SEA.amp2;
  }
  // 波浪法向（用于船体姿态：船随波面倾斜）
  function waveNormal(x, z, t, out) {
    const e = 6;
    const h0 = waveHeight(x, z, t);
    const hx = waveHeight(x + e, z, t);
    const hz = waveHeight(x, z + e, t);
    const nx = -(hx - h0) / e, nz = -(hz - h0) / e;
    const len = Math.hypot(nx, 1, nz);
    const o = out || {};
    o.x = nx / len; o.y = 1 / len; o.z = nz / len;
    return o;
  }

  // ---------------------------------------------------------------------------
  // === 舰船创建 ===============================================================
  // ---------------------------------------------------------------------------
  let _shipId = 1;

  function createShip(typeId, team, name, opts) {
    const T = SHIP_TYPES[typeId] || SHIP_TYPES.ca;
    const o = opts || {};
    const s = {
      id: o.id || (_shipId++),
      kind: 'ship',
      type: T.id,
      typeName: T.name,
      team,
      name: name || (T.name + '-' + (o.num || 1)),

      // ---- 运动 ----
      pos: { x: o.x || 0, y: 0, z: o.z || 0 },
      heading: o.heading || 0,           // 舰艏朝向（rad，世界系，atan2 约定：0 = -z）
      speed: 0,                          // 当前对地速度 m/s
      throttle: 1,                       // 0..3 档（0=停, 1=1/3, 2=2/3, 3=全速）
      rudder: 0,                         // -1..1 当前舵角（有延迟）
      rudderCmd: 0,                      // 指令舵角
      rudderActual: 0,
      turnRate: 0,                       // 当前转向角速度

      // ---- 姿态（视觉）----
      roll: 0, pitch: 0, heave: 0,       // 横摇/纵摇/升沉
      rollVel: 0,

      // ---- 生存 ----
      hp: T.hp, maxHp: T.hp,
      alive: true,
      sinking: 0,                        // 沉没进度 0..1
      wreck: false,
      deathDone: false,
      // 损管状态
      flood: 0,                          // 进水量 0..1（影响速度与浮力）
      fire: 0,                           // 火势 0..1（持续掉血）
      dcReady: 1,                        // 损管可用度 0..1
      dcTimer: 0,
      // 模块损毁
      mods: {
        engine: 1,                       // 引擎健康 0..1
        rudder: 1,
        mainGun: [1, 1, 1, 1],           // 每座炮塔健康
        aa: 1,
        torpedo: 1
      },

      // ---- 武器 ----
      mainTurrets: [],                   // 每座炮塔的方位/俯仰/装填
      secondaries: [],                   // 副炮组
      torpTubes: [],                     // 鱼雷管
      aaHeat: 0,

      // ---- 目标/交战 ----
      targetId: 0,
      lastHitBy: 0,
      lastHitAt: -999,
      damageLog: {},                     // 攻击者 id -> 最后命中时间

      // ---- 统计 ----
      kills: 0,

      // 缓存配置
      T
    };

    // 主炮塔初始化
    const mg = T.mainGuns;
    for (let i = 0; i < mg.count; i++) {
      const spot = mg.turretSpots[i] || { along: 0, lateral: 0, elev: 1 };
      s.mainTurrets.push({
        idx: i,
        along: spot.along * T.len * 0.5,     // 世界偏移（米）
        lateral: spot.lateral * T.beam * 0.5,
        faceDir: spot.elev >= 0 ? 0 : Math.PI, // 基准朝向（0=舰艏方向）
        yaw: spot.elev >= 0 ? 0 : Math.PI,   // 当前方位（相对舰体）
        yawCmd: spot.elev >= 0 ? 0 : Math.PI,
        pitch: 0.05,
        pitchCmd: 0.05,
        reload: 0,                            // 剩余装填时间
        ammo: mg.barrels,
        recoil: 0,                            // 后坐位移 0..1
        flash: 0,                             // 炮口焰 0..1
        hp: 1
      });
    }
    // 副炮组
    if (T.secondary) {
      for (let i = 0; i < T.secondary.count; i++) {
        s.secondaries.push({
          idx: i,
          along: (i / Math.max(1, T.secondary.count - 1) - 0.5) * T.len * 0.62,
          lateral: (i % 2 === 0 ? 1 : -1) * T.beam * 0.42,
          yaw: 0, pitch: 0.3, reload: 0, hp: 1
        });
      }
    }
    // 鱼雷管
    if (T.torpedo) {
      for (let i = 0; i < T.torpedo.tubes; i++) {
        const spot = T.torpedo.tubeSpots[i] || { along: 0, lateral: 1 };
        s.torpTubes.push({
          idx: i,
          along: spot.along * T.len * 0.5,
          lateral: spot.lateral * T.beam * 0.5,
          yaw: Math.PI / 2 * spot.lateral,     // 侧向
          reload: 0,
          ammo: T.torpedo.perTube,
          hp: 1
        });
      }
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // === 舰船 → 世界坐标换算 ====================================================
  // ---------------------------------------------------------------------------
  // 舰体坐标系：+along 为舰艏方向，+lat 为右舷。
  // heading 用 atan2 约定：heading=0 时舰艏朝 -z（与飞机 yaw 一致）。
  function shipForward(heading, out) {
    const o = out || {};
    o.x = -Math.sin(heading);
    o.z = -Math.cos(heading);
    return o;
  }
  function shipRight(heading, out) {
    const o = out || {};
    o.x = Math.cos(heading);
    o.z = -Math.sin(heading);
    return o;
  }
  // 舰体局部 (along, lat) → 世界 (x, z)
  // ⚠️ 这里不能用 shipForward/shipRight 的共享缓存 _f/_r：
  //    调用方经常同时持有 fwd 与另一个方向，共用缓存会被后一次调用覆盖，
  //    算出来的坐标直接是 NaN（纵摇/横摇全废）。各自用独立临时量。
  const _twF = { x: 0, z: 0 }, _twR = { x: 0, z: 0 };
  function shipToWorld(s, along, lat, out) {
    const f = shipForward(s.heading, _twF), r = shipRight(s.heading, _twR);
    const o = out || {};
    o.x = s.pos.x + f.x * along + r.x * lat;
    o.z = s.pos.z + f.z * along + r.z * lat;
    return o;
  }
  // 世界 (x, z) → 舰体局部 (along, lat)
  const _wsF = { x: 0, z: 0 }, _wsR = { x: 0, z: 0 };
  function worldToShip(s, x, z, out) {
    const f = shipForward(s.heading, _wsF), r = shipRight(s.heading, _wsR);
    const dx = x - s.pos.x, dz = z - s.pos.z;
    const o = out || {};
    o.along = dx * f.x + dz * f.z;
    o.lat = dx * r.x + dz * r.z;
    return o;
  }
  const _f = { x: 0, z: 0 }, _r = { x: 0, z: 0 };
  const _w1 = { x: 0, z: 0 }, _w2 = { x: 0, z: 0 }, _l1 = { along: 0, lat: 0 };

  // 是否命中舰体（椭圆近似 + 上层建筑）
  function pointOnShip(s, x, z, margin) {
    const m = margin === undefined ? 1 : margin;
    worldToShip(s, x, z, _l1);
    const a = s.T.len * 0.5 * m, b = s.T.beam * 0.5 * m;
    return (_l1.along * _l1.along) / (a * a) + (_l1.lat * _l1.lat) / (b * b) <= 1;
  }

  // ---------------------------------------------------------------------------
  // === 航速档位 ===============================================================
  // ---------------------------------------------------------------------------
  function throttleToSpeed(T, throttle) {
    // 档位：0 停 / 1 1/3 / 2 2/3 / 3 全速 / -1 倒车
    const steps = [0, 0.33, 0.66, 1.0];
    if (throttle < 0) return -T.reverseSpeed;
    return T.maxSpeed * (steps[clamp(Math.round(throttle), 0, 3)] || 0);
  }

  // ---------------------------------------------------------------------------
  // === 舰船步进（权威模拟）====================================================
  // ---------------------------------------------------------------------------
  // input: { throttle, rudder, fireMain, fireTorp, targetX, targetZ, dc }
  //   炮塔瞄准用「目标世界坐标」而不是角度：舰体在转，客户端只报准星位置，
  //   服务端自己算方位差 —— 这样客户端预测与服务端一致，且不受舰体转向影响。
  function stepShip(s, input, dt, events, world) {
    if (!s || !s.alive) {
      if (s && s.wreck) stepWreck(s, dt);
      return;
    }
    const T = s.T;
    const inp = input || {};
    const evts = events || [];
    const t = (world && world.time) || 0;

    // ---- 0. 数值健康检查（自愈）----
    // 任何一路输入/事件把 NaN 带进运动状态后，整艘船会永久失去控制。
    // 这里做一次兜底修正：非有限值一律回落到静止状态，宁可"停船"也不"废船"。
    if (!Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.z)) {
      s.pos.x = Number.isFinite(s.pos.x) ? s.pos.x : 0;
      s.pos.z = Number.isFinite(s.pos.z) ? s.pos.z : 0;
    }
    if (!Number.isFinite(s.pos.y)) s.pos.y = 0;
    if (!Number.isFinite(s.heading)) s.heading = 0;
    if (!Number.isFinite(s.speed)) s.speed = 0;
    if (!Number.isFinite(s.roll)) s.roll = 0;
    if (!Number.isFinite(s.pitch)) s.pitch = 0;
    if (!Number.isFinite(s.heave)) s.heave = 0;

    // ---- 1. 损管：进水 / 起火 ----
    // 进水：降低最大航速与储备浮力（超过 1 会加速沉没）
    if (s.flood > 0) {
      s.flood = Math.max(0, s.flood - T.repair.floodRate * dt * 0.06);
    }
    if (s.fire > 0) {
      s.fire = Math.max(0, s.fire - T.repair.fireRate * dt * 0.05);
      // 火势持续掉血（每秒按最大血量的百分比）
      s.hp -= s.maxHp * 0.004 * s.fire * dt;
      if (s.hp <= 0) { sinkShip(s, evts, 'fire'); return; }
    }
    // 损管冷却
    if (s.dcTimer > 0) s.dcTimer = Math.max(0, s.dcTimer - dt);
    s.dcReady = s.dcTimer > 0 ? (1 - s.dcTimer / T.repair.dcCooldown) : 1;

    // ---- 2. 推进：油门 → 目标航速（巨大惯性）----
    const wantThr = clamp(inp.throttle === undefined ? s.throttle : inp.throttle, -1, 3);
    s.throttle = wantThr;
    // 进水会拖慢船（进水越多越慢，最多损失 55% 速度）
    const floodSlow = 1 - clamp(s.flood, 0, 1) * 0.55;
    const engineOk = clamp(s.mods.engine, 0.15, 1);
    const targetSpeed = throttleToSpeed(T, wantThr) * floodSlow * engineOk;
    // 转向时掉速
    const turnBleed = 1 - Math.abs(s.turnRate / T.rudderRate) * (1 - T.turnBleed);
    const tgt = targetSpeed * turnBleed;
    const acc = (tgt > s.speed ? T.accel : T.brakeAccel);
    if (Math.abs(tgt - s.speed) < 0.02) s.speed = tgt;
    else s.speed += Math.sign(tgt - s.speed) * Math.min(Math.abs(tgt - s.speed), acc * dt);

    // ---- 3. 舵：指令 → 实际（延迟），转向速率 ----
    s.rudderCmd = clamp(inp.rudder === undefined ? 0 : inp.rudder, -1, 1);
    // 舵机：恒定角速度（真实液压舵机就是定速的）。
    // 原来用一阶惯性逼近，从右满舵回左满舵要 4~5 秒（指数尾巴特别长），
    // 手感上等于「按 A 没反应，船还在继续右转」——这是玩家最先抱怨的点。
    // rudderLag 的含义改成「从一舷满舵打到另一舷所需的秒数」。
    const rate = 2.0 / Math.max(0.3, T.rudderLag);
    s.rudder += clamp(s.rudderCmd - s.rudder, -rate * dt, rate * dt);
    s.rudderActual = s.rudder * clamp(s.mods.rudder, 0.2, 1);
    // 低速时舵效下降（真实：船停住就转不动）
    const steerAuth = clamp(Math.abs(s.speed) / (T.maxSpeed * 0.35), 0, 1);
    // 符号约定：rudder > 0 = 右舵（starboard），turnRate > 0 = 向左（heading 增大）。
    // heading 的定义是 shipForward(h) = (-sin h, -cos h)，h 增大时艏向由 -z 转向 -x，
    // 从上方看是逆时针 —— 也就是左转。所以右舵必须给负的 turnRate。
    s.turnRate = -s.rudderActual * T.rudderRate * steerAuth * (s.speed >= 0 ? 1 : -1);
    s.heading += s.turnRate * dt;

    // ---- 4. 位置积分 ----
    const fwd = shipForward(s.heading, _f);
    // ---- 4b. 岸线探测：船不能上岸（按吃水判定，不是按"有没有陆地"）----
    // 沿舰艏方向取 4 个采样点（舰艏、舰艏前 1/4、1/2、全航程），
    // 只要有一点水深不足吃水就判定"要搁浅"，立即制动，倒车仍可用来自救。
    const terrainFn = world && world.terrain;
    // 0.62 倍吃水：真实搁浅判定应该更严，但游戏里浅海区域很多，
    // 太严会让大量出生点/航道不可用。0.62 保证船底不会露出水面。
    const minDepth = Math.max(2.5, (T.draft || 6) * 0.62);
    // 只在前进/静止时做"提前刹车"探测。倒车时必须放行 ——
    // 否则搁浅后船艏前方永远是岸，玩家按 S 也退不出来，等于卡死。
    if (terrainFn && s.speed > -0.5) {
      const look = 0.55 * T.len + 50 + Math.abs(s.speed) * 5.5;
      for (let k = 1; k <= 4; k++) {
        const d = look * (k / 4);
        const gh = terrainFn(s.pos.x + fwd.x * d, s.pos.z + fwd.z * d);
        if (-gh < minDepth) {
          s.speed = Math.max(0, s.speed - T.brakeAccel * 4 * dt);
          s.turnRate *= 0.3;
          s.aground = true;
          break;
        }
      }
    }

    const px0 = s.pos.x, pz0 = s.pos.z;
    s.pos.x += fwd.x * s.speed * dt;
    s.pos.z += fwd.z * s.speed * dt;

    // 硬约束：船体三点（艏/中/艉）不许进浅水。
    // 之前的逻辑只降速，不拦位置，惯性会把整条船推上沙滩（舰体插进树林里）。
    if (terrainFn) {
      const badAt = (x, z) => {
        for (let i = -1; i <= 1; i++) {
          const al = i * T.len * 0.45;
          if (-terrainFn(x + fwd.x * al, z + fwd.z * al) < minDepth) return true;
        }
        return false;
      };
      const badNew = badAt(s.pos.x, s.pos.z);
      const badOld = badAt(px0, pz0);
      if (badNew && !badOld) {
        // 这一帧刚要越过岸线：停在原地
        s.pos.x = px0; s.pos.z = pz0;
        if (s.speed > 0) s.speed = 0;
        s.aground = true;
      } else if (badNew) {
        // 已经骑在岸上：允许移动（倒车/转向可以脱困），但保持搁浅状态
        s.aground = true;
      }
    }

    // ---- 5. 姿态：随浪起伏 + 转向横倾（纯视觉，但影响瞄准手感）----
    // 升沉/纵摇：按船体前后两点的浪高差算
    const halfL = T.len * 0.5;
    const bowW = shipToWorld(s, halfL, 0, _w1);
    const stnW = shipToWorld(s, -halfL, 0, _w2);
    const hBow = waveHeight(bowW.x, bowW.z, t);
    const hStn = waveHeight(stnW.x, stnW.z, t);
    const hMid = waveHeight(s.pos.x, s.pos.z, t);
    s.heave = hMid * 0.85;
    // 纵摇：船艏比船艉高多少 → 抬头/低头
    const pitchTgt = Math.atan2(hBow - hStn, T.len) * 0.9 + T.pitchAmp * Math.sin(t * 0.7 + s.id);
    s.pitch += (pitchTgt - s.pitch) * clamp(dt * 2.4, 0, 1);
    // 横摇：转向时向内侧倾 + 浪的随机摇摆
    // roll 正 = 左舷下沉（绕局部 +z 逆时针）。
    // 右舵 → 船右转 → 离心力向左 → 左舷下沉 → roll 为正。所以这里与 rudder 同号。
    const rollTurn = s.rudderActual * T.rollAmp * steerAuth;
    const rollWave = Math.sin(t * 0.9 + s.id * 1.7) * T.rollAmp * 0.55;
    const rollTgt = rollTurn + rollWave;
    s.roll += (rollTgt - s.roll) * clamp(dt * (1 / T.rollLag) * 2.5, 0, 1);
    s.pos.y = s.heave;

    // ---- 6. 炮塔伺服 ----
    stepTurrets(s, inp, dt, evts, t);

    // ---- 7. 防空：已移除（用户明确要求舰船不打飞机；对空火力只保留岸基 AAA 与流弹近炸）----
    // if (world && world.aircraft) stepAA(s, dt, evts, world);

    // ---- 8. 边界：出界强制返航（海域边缘）----
    if (world && world.bounds) {
      const b = world.bounds;
      if (Math.abs(s.pos.x) > b || Math.abs(s.pos.z) > b) {
        // 掉头（简单粗暴：把舰艏掰向中心）
        const want = Math.atan2(-s.pos.x, -s.pos.z);
        s.heading += clamp(((want - s.heading + Math.PI) % TAU + TAU) % TAU - Math.PI, -0.5 * dt, 0.5 * dt);
      }
    }

    // ---- 9. 沉没判定：进水过多 + 血量见底 ----
    if (s.hp <= 0) sinkShip(s, evts, 'hp');
  }

  // 炮塔：转向伺服 + 装填 + 齐射
  function stepTurrets(s, inp, dt, evts, t) {
    const T = s.T;
    const mg = T.mainGuns;
    const alive = s.mods.mainGun;
    let wantFire = !!inp.fireMain;

    // 目标点（世界坐标）→ 转成舰体局部方向
    let tgtAlong = 0, tgtLat = 0, hasTgt = false;
    if (inp.targetX !== undefined && inp.targetZ !== undefined) {
      worldToShip(s, inp.targetX, inp.targetZ, _l1);
      tgtAlong = _l1.along; tgtLat = _l1.lat;
      hasTgt = (tgtAlong * tgtAlong + tgtLat * tgtLat) > 4;
    }

    for (const tur of s.mainTurrets) {
      if (alive[tur.idx] <= 0.05) continue;    // 炮塔被摧毁
      // ---- 方位伺服 ----
      if (hasTgt) {
        // 目标方位角（相对舰体 +z 轴，0 = 舰艏）
        const wantYaw = Math.atan2(tgtLat, tgtAlong);
        // 归一化到 [-π, π] 再考虑炮塔朝向限制
        let d = wantYaw - tur.yaw;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        // 后炮塔不能转到舰艏正前方（会打到舰桥）——限制在 ±150°
        const lim = tur.faceDir === 0 ? 2.62 : 2.62;
        const rel = ((tur.yaw - tur.faceDir + Math.PI) % TAU + TAU) % TAU - Math.PI;
        if (Math.abs(rel + d) > lim) {
          d = clamp(rel + d, -lim, lim) - rel;
        }
        const maxStep = mg.turretTurn * dt * clamp(alive[tur.idx], 0.3, 1);
        tur.yaw += clamp(d, -maxStep, maxStep);
        tur.yawCmd = wantYaw;
      }
      // ---- 俯仰伺服 ----
      // 俯仰按「炮塔当前朝向」到目标点的水平距离算 —— 不能按舰体到目标的距离算：
      // 炮塔转向后炮口到目标的距离会变，用舰体距离会导致远距离系统性偏近。
      const muzzleAlong = tur.along + Math.cos(tur.yaw) * mg.caliber / 2000;
      const muzzleLat = tur.lateral + Math.sin(tur.yaw) * mg.caliber / 2000;
      const dist = hasTgt
        ? Math.hypot(tgtAlong - muzzleAlong, tgtLat - muzzleLat)
        : 8000;
      const wantPitch = ballisticElevation(mg, dist);
      const maxP = mg.elevRate * dt;
      tur.pitch += clamp(wantPitch - tur.pitch, -maxP, maxP);
      tur.pitch = clamp(tur.pitch, mg.elevMin, mg.elevMax);

      // ---- 装填 ----
      if (tur.reload > 0) tur.reload = Math.max(0, tur.reload - dt);
      tur.recoil = Math.max(0, tur.recoil - dt * 1.6);
      tur.flash = Math.max(0, tur.flash - dt * 5.0);

      // ---- 齐射：所有炮塔同时（真实齐射会让散布更大，这里按炮塔独立）----
      if (wantFire && tur.reload <= 0 && hasTgt) {
        // 瞄准误差：方位和俯仰都必须转到位才开火。
        // ⚠️ 只查方位不查俯仰是致命 bug：开火瞬间炮塔俯仰还是初始值（3°），
        //    打 10km 需要 4.9°，炮弹直接落水偏近 3km（实测 8 次齐射 0 命中）。
        const yawErr = Math.abs(angleDiff(tur.yaw, tur.yawCmd));
        const pitchErr = Math.abs(tur.pitch - wantPitch);
        if (yawErr < 0.05 && pitchErr < 0.012) {
          fireMainGun(s, tur, tgtAlong, tgtLat, evts);
          tur.reload = mg.reload * (1 + (1 - clamp(alive[tur.idx], 0, 1)) * 0.5);
          tur.recoil = 1;
          tur.flash = 1;
        }
      }
    }
  }

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  // 弹道仰角：给定水平距离，求需要的炮口仰角
  // 真炮的弹道表是打出来的，这里用数值反解（二分 + 快速弹道积分），
  // 比解析式准得多 —— 有阻力时解析解误差能到几千米。
  const _elevCache = new Map();
  function ballisticElevation(mg, dist) {
    const key = mg.caliber + ':' + Math.round(dist / 50);
    const hit = _elevCache.get(key);
    if (hit !== undefined) return hit;
    const v0 = mg.shellSpeed, k = mg.dragCoef || 2.27e-5;
    // 快速弹道：给定仰角，返回水平射程（不含高度差，海战同高度足够）
    const rangeOf = (elev) => {
      let x = 0, y = 0;
      let vx = Math.cos(elev) * v0, vy = Math.sin(elev) * v0;
      const h = 1 / 60;
      for (let i = 0; i < 60 * 45; i++) {
        const sp = Math.hypot(vx, vy);
        const dv = k * sp * sp * h;
        const f = Math.max(0, 1 - dv / Math.max(1, sp));
        vx *= f; vy *= f;
        vy -= 9.81 * h;
        x += vx * h; y += vy * h;
        if (y <= 0 && i > 4) break;
      }
      return x;
    };
    // 二分找仰角
    let lo = 0, hi = mg.elevMax;
    let best = 0;
    for (let it = 0; it < 22; it++) {
      const mid = (lo + hi) * 0.5;
      const r = rangeOf(mid);
      if (r < dist) lo = mid; else { hi = mid; best = mid; }
    }
    const out = clamp(best, mg.elevMin, mg.elevMax);
    _elevCache.set(key, out);
    return out;
  }

  // 主炮开火：生成炮弹（服务端权威弹道，客户端只做表现）
  // evts 可以是普通数组，也可以带 .shells / .torps 挂载列表（服务端主循环用后者）。
  let _shellSeq = 0;
  function fireMainGun(s, tur, tgtAlong, tgtLat, evts) {
    const mg = s.T.mainGuns;
    // 炮口世界位置：炮塔在舰体上的位置 + 沿炮管方向前伸
    const tp = shipToWorld(s, tur.along, tur.lateral, _w1);
    const barrelLen = s.T.len * 0.035;
    // 炮管水平方向 = 舰体方位 + 炮塔 yaw
    const f = shipForward(s.heading, _f);
    const r = shipRight(s.heading, _r);
    const cy = Math.cos(tur.yaw), sy = Math.sin(tur.yaw);
    // 舰体局部 (along=cos, lat=sin) → 世界
    const dirX = f.x * cy + r.x * sy;
    const dirZ = f.z * cy + r.z * sy;
    const mx = tp.x + dirX * barrelLen;
    const mz = tp.z + dirZ * barrelLen;
    const my = s.pos.y + s.T.freeboard + 3.2 + Math.sin(tur.pitch) * barrelLen;

    // 散布
    const sp = mg.spread;
    const yawErr = (Math.random() - 0.5) * sp * 2;
    const pitErr = (Math.random() - 0.5) * sp * 2;
    const cp = Math.cos(tur.pitch + pitErr), sip = Math.sin(tur.pitch + pitErr);
    const yawTot = Math.atan2(dirZ, dirX) + yawErr;

    const shell = {
      kind: 'shell',
      id: ++_shellSeq,               // 稳定 id：快照里带出去，客户端按 id 配对估速
      from: s.id,
      team: s.team,
      big: s.T.mainGuns.caliber >= 300,
      pos: { x: mx, y: my, z: mz },
      vel: {
        x: Math.cos(yawTot) * mg.shellSpeed * cp,
        y: sip * mg.shellSpeed,
        z: Math.sin(yawTot) * mg.shellSpeed * cp
      },
      mass: mg.shellMass,
      drag: mg.dragCoef,
      damage: mg.damage,
      pen: mg.penAt1km,
      penFalloff: mg.penFalloff,
      life: 40,
      travel: 0,
      caliber: mg.caliber
    };
    pushEvt(evts, { k: 'shipfire', id: s.id, tur: tur.idx, p: [mx, my, mz], big: shell.big ? 1 : 0 });
    // 炮弹交给 world 管理（服务端主循环推进）
    if (evts && evts.shells) evts.shells.push(shell);
    return shell;
  }
  // 事件收集统一入口：evts 是数组就用 push；是对象就找 .evts 数组，都没有就丢弃
  function pushEvt(evts, e) {
    if (!evts) return;
    if (Array.isArray(evts)) { evts.push(e); return; }
    if (Array.isArray(evts.evts)) evts.evts.push(e);
  }

  // ---------------------------------------------------------------------------
  // === 炮弹弹道（服务端推进，命中判定）=========================================
  // ---------------------------------------------------------------------------
  // 阻力用真实的平方阻力定律：a = -k * v²，k = 0.5*ρ*Cd*A/m。
  // 406mm/1050kg 弹的 k ≈ 2.27e-5（实测：10s 飞 7.5km、末速 692m/s），
  // 与二战舰炮的实际弹道量级一致。dragCoef 直接存这个 k。
  function stepShell(sh, dt, ships, aircraft, evts) {
    if (sh.life <= 0) return false;
    sh.life -= dt;
    const v = sh.vel;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > 1) {
      // 平方阻力：dv = -k*v²*dt（方向沿速度反向）
      const dv = sh.drag * sp * sp * dt;
      const k = Math.max(0, 1 - dv / sp);
      v.x *= k; v.y *= k; v.z *= k;
    }
    v.y -= 9.81 * dt;
    const px = sh.pos.x, py = sh.pos.y, pz = sh.pos.z;
    sh.pos.x += v.x * dt;
    sh.pos.y += v.y * dt;
    sh.pos.z += v.z * dt;
    sh.travel += Math.hypot(sh.pos.x - px, sh.pos.y - py, sh.pos.z - pz);

    // ---- 命中舰船：线段与舰体椭圆柱求交（简化：取中点判断 + 高度区间）----
    if (ships) {
      for (const s of ships) {
        if (!s.alive || s.team === sh.team) continue;
        const top = s.pos.y + s.T.freeboard + 16;     // 上层建筑顶
        const bot = s.pos.y - s.T.draft;
        if (py < bot - 2 || py > top + 2) continue;
        // 采样 4 个点判断是否在舰体平面内
        for (let k = 0; k <= 3; k++) {
          const f = k / 3;
          const sx = px + (sh.pos.x - px) * f;
          const sz = pz + (sh.pos.z - pz) * f;
          const sy = py + (sh.pos.y - py) * f;
          if (sy < bot || sy > top) continue;
          if (!pointOnShip(s, sx, sz, 1.0)) continue;
          // 命中！
          const hit = resolveHit(s, sh, sx, sy, sz);
          pushEvt(evts, {
            k: 'shiphit', tgt: s.id, by: sh.from, p: [sx, sy, sz],
            dmg: Math.round(hit.dmg), pen: hit.pen ? 1 : 0,
            zone: hit.zone, big: sh.big ? 1 : 0
          });
          return false;   // 炮弹消失
        }
      }
    }
    // ---- 命中飞机（大口径炮弹近炸也能打下飞机）----
    if (aircraft) {
      for (const a of aircraft) {
        if (!a.alive || a.team === sh.team) continue;
        const d = Math.hypot(a.pos.x - sh.pos.x, a.pos.y - sh.pos.y, a.pos.z - sh.pos.z);
        if (d < 18 + (sh.big ? 14 : 0)) {
          pushEvt(evts, { k: 'shellair', id: a.id, by: sh.from, p: [sh.pos.x, sh.pos.y, sh.pos.z], dmg: sh.damage * 0.55 });
          return false;
        }
      }
    }
    // ---- 落水 ----
    const wh = waveHeight(sh.pos.x, sh.pos.z, 0);
    if (sh.pos.y <= wh) {
      pushEvt(evts, { k: 'shellsplash', by: sh.from, p: [sh.pos.x, wh, sh.pos.z], big: sh.big ? 1 : 0, sp: sh.big ? 1 : 0 });
      return false;
    }
    return sh.life > 0;
  }

  // 命中结算：按命中位置判定装甲分区与穿深
  function resolveHit(s, sh, x, y, z) {
    const T = s.T;
    worldToShip(s, x, z, _l1);
    const alongFrac = Math.abs(_l1.along) / (T.len * 0.5);
    const latFrac = Math.abs(_l1.lat) / (T.beam * 0.5);
    const relH = y - s.pos.y;                    // 相对水线高度
    const topH = T.freeboard + 14;

    // 判定命中区域
    let zone, armor;
    if (relH < 0) { zone = 'underwater'; armor = T.armor.underwater; }
    else if (relH > T.freeboard + 4 && latFrac < 0.55 && alongFrac < 0.45) {
      zone = 'superstructure'; armor = T.armor.superstructure;
    } else if (relH > T.freeboard - 1 && relH < T.freeboard + 3) {
      zone = 'deck'; armor = T.armor.deck;
    } else if (alongFrac > 0.86) { zone = 'bow'; armor = T.armor.bow; }
    else if (alongFrac > 0.86) { zone = 'stern'; armor = T.armor.stern; }
    else { zone = 'belt'; armor = T.armor.belt; }

    // 穿深：随飞行距离衰减；入射角影响（这里简化为垂直入射）
    const pen = Math.max(10, sh.pen - sh.travel * sh.penFalloff);
    // 有效穿深：命中角度（用炮弹速度方向与舰体表面的夹角近似）
    const angleFactor = 1.0;
    const effectivePen = pen * angleFactor;

    let dmg;
    let penetrated = effectivePen >= armor;
    if (penetrated) {
      // 击穿：伤害按「剩余穿深相对口径」的比例，命中核心区加成
      const overmatch = clamp(effectivePen / Math.max(1, armor), 1, 3);
      let base = sh.damage * (0.85 + 0.25 * Math.random());
      // 弹药库/动力舱（舰体中段水线附近）= 核心区，伤害翻倍
      const isCitadel = zone === 'belt' && alongFrac < 0.35 && relH > -1 && relH < T.freeboard;
      if (isCitadel) base *= 2.15;
      else if (zone === 'underwater') base *= 1.35;      // 水下命中引发进水
      else if (zone === 'superstructure') base *= 0.42;  // 上层建筑伤害低（过穿）
      else if (zone === 'deck') base *= 0.75;
      dmg = base * clamp(overmatch * 0.7 + 0.3, 0.6, 1.8);
    } else {
      // 未击穿：碎弹（少量伤害 + 上层建筑可起火）
      dmg = sh.damage * 0.09 * (zone === 'superstructure' ? 1.8 : 0.6);
    }

    // ---- 应用伤害与状态 ----
    s.hp -= dmg;
    s.lastHitBy = sh.from;
    if (sh.from) s.damageLog[sh.from] = 1;

    // 起火：击穿上层建筑/甲板有概率
    if (penetrated && (zone === 'superstructure' || zone === 'deck')) {
      if (Math.random() < (sh.big ? 0.35 : 0.18)) s.fire = clamp(s.fire + 0.35, 0, 1);
    }
    // 进水：水下命中 / 水线附近击穿
    if (penetrated && (zone === 'underwater' || (zone === 'belt' && relH < 1.5))) {
      s.flood = clamp(s.flood + (sh.big ? 0.22 : 0.10), 0, 1);
    }
    // 模块损毁：命中炮塔/舵/引擎区域
    if (penetrated) {
      const dmgRatio = dmg / s.maxHp;
      // 炮塔被直击（上层建筑前部）
      if (zone === 'superstructure' && alongFrac < 0.5 && Math.random() < 0.30 * (sh.big ? 2 : 1)) {
        const ti = Math.floor(Math.random() * s.mods.mainGun.length);
        s.mods.mainGun[ti] = Math.max(0, s.mods.mainGun[ti] - 0.5 - dmgRatio * 2);
        if (s.mainTurrets[ti]) s.mainTurrets[ti].hp = s.mods.mainGun[ti];
      }
      // 舵机（舰艉）
      if (zone === 'stern' && Math.random() < 0.25) s.mods.rudder = Math.max(0.15, s.mods.rudder - 0.4);
      // 引擎（舰体中后部水线）
      if (zone === 'belt' && alongFrac > 0.25 && alongFrac < 0.6 && Math.random() < 0.20) {
        s.mods.engine = Math.max(0.2, s.mods.engine - 0.3);
      }
    }

    if (s.hp <= 0) { s.hp = 0; }
    return { dmg: Math.round(dmg), pen: penetrated, zone };
  }

  // ---------------------------------------------------------------------------
  // === 防空（已停用：舰船不打飞机）============================================
  // 保留函数体供参考；stepShip 中不再调用。
  // ---------------------------------------------------------------------------
  function stepAA(s, dt, evts, world) {
    if (!s.alive || s.mods.aa <= 0.05) return;
    const T = s.T;
    const range = T.aa.range;
    const r2 = range * range;
    // 找最近/最有威胁的敌机
    let best = null, bestD = 1e18;
    for (const a of world.aircraft) {
      if (!a.alive || a.team === s.team) continue;
      const d2 = (a.pos.x - s.pos.x) ** 2 + (a.pos.z - s.pos.z) ** 2;
      if (d2 > r2) continue;
      const dy = a.pos.y - s.pos.y;
      if (dy < -20 || dy > 3200) continue;      // 太低/太高打不到
      if (d2 < bestD) { bestD = d2; best = a; }
    }
    if (!best) { s.aaHeat = Math.max(0, s.aaHeat - dt * 3); return; }
    // 开火节奏：连发，按 burst 间隔结算伤害
    s.aaHeat += dt;
    const dps = T.aa.dps * clamp(s.mods.aa, 0, 1) * (1 - clamp(s.fire * 0.5, 0, 0.5));
    const interval = T.aa.burst;
    if (s.aaHeat >= interval) {
      s.aaHeat -= interval;
      // 距离越远命中率越低；高空目标火力密度自然衰减（防空炮有效射高有限，
      // 2500m 以上基本打不着——给轰炸机留一条高空突防航线）
      const d = Math.sqrt(bestD);
      const alt = best.pos.y - s.pos.y;
      const altFactor = alt < 2500 ? 1 : clamp(1 - (alt - 2500) / 1500, 0.05, 1);
      const hitChance = clamp(1 - d / range, 0.15, 0.95) * altFactor;
      // 曳光每轮都发：玩家必须看得到"是谁在打我"，否则挨打都找不到源头
      pushEvt(evts, { k: 'aatrace', id: s.id, p: [s.pos.x, s.pos.y + s.T.freeboard + 6, s.pos.z], q: [best.pos.x, best.pos.y, best.pos.z] });
      if (Math.random() < hitChance * 0.85) {
        const dmg = dps * interval * (0.6 + Math.random() * 0.8);
        pushEvt(evts, { k: 'aahit', id: best.id, by: s.id, dmg, p: [best.pos.x, best.pos.y, best.pos.z] });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // === 鱼雷 ===================================================================
  // ---------------------------------------------------------------------------
  function fireTorpedo(s, tube, dirWorld, evts) {
    const T = s.T.torpedo;
    if (!T || tube.ammo <= 0 || tube.reload > 0) return null;
    tube.ammo--;
    tube.reload = T.reload;
    const tp = shipToWorld(s, tube.along, tube.lateral, _w1);
    const torp = {
      kind: 'torp',
      from: s.id,
      team: s.team,
      pos: { x: tp.x, y: 0.8, z: tp.z },
      dir: { x: Math.cos(dirWorld), z: Math.sin(dirWorld) },
      speed: 0,
      maxSpeed: T.speed,
      life: T.range / T.speed,
      travel: 0,
      damage: T.damage,
      armed: 0
    };
    pushEvt(evts, { k: 'torpshot', id: s.id, tube: tube.idx, p: [tp.x, 1, tp.z], d: [dirWorld] });
    if (evts.torps) evts.torps.push(torp);
    return torp;
  }

  function stepTorpedo(tp, dt, ships, evts) {
    if (tp.life <= 0) return false;
    tp.life -= dt;
    tp.armed += dt;
    // ---- 空投段：从飞机上落下，未入水前只受重力 ----
    const wh = waveHeight(tp.pos.x, tp.pos.z, 0);
    if (tp.pos.y > wh + 0.4) {
      tp.vy = (tp.vy || 0) - 9.81 * dt;
      tp.pos.y += tp.vy * dt;
      tp.pos.x += tp.dir.x * tp.speed * dt;
      tp.pos.z += tp.dir.z * tp.speed * dt;
      return tp.life > 0;
    }
    tp.pos.y = 0.8;   // 入水后贴水面
    if (!tp.splashed) {
      tp.splashed = true;
      pushEvt(evts, { k: 'torpsplash', p: [tp.pos.x, 1, tp.pos.z] });
    }
    // 加速到巡航速度
    tp.speed = Math.min(tp.maxSpeed, tp.speed + 22 * dt);
    tp.pos.x += tp.dir.x * tp.speed * dt;
    tp.pos.z += tp.dir.z * tp.speed * dt;
    tp.travel += tp.speed * dt;

    for (const s of ships) {
      if (!s.alive || s.team === tp.team) continue;
      if (tp.armed < 1.2) continue;
      // 鱼雷命中判定：水面附近的舰体
      if (pointOnShip(s, tp.pos.x, tp.pos.z, 1.05)) {
        const dmg = tp.damage * (0.85 + Math.random() * 0.3);
        s.hp -= dmg;
        s.flood = clamp(s.flood + 0.42, 0, 1);
        s.lastHitBy = tp.from;
        if (tp.from) s.damageLog[tp.from] = 1;
        pushEvt(evts, { k: 'torphit', tgt: s.id, by: tp.from, p: [tp.pos.x, 1, tp.pos.z], dmg: Math.round(dmg) });
        if (s.hp <= 0) s.hp = 0;
        return false;
      }
    }
    // 射程耗尽 → 自沉
    if (tp.travel > (ships && ships[0] ? 0 : 0) + 1e9) return false;
    return tp.life > 0;
  }

  // ---- 航空炸弹：自由落体 + 命中舰体/水面 ----
  function stepBomb(b, dt, ships, evts) {
    if (b.life <= 0) return false;
    b.life -= dt;
    const py0 = b.pos.y;
    b.vel.y -= 9.81 * dt;
    b.vel.x *= (1 - 0.02 * dt); b.vel.z *= (1 - 0.02 * dt);
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // 命中舰体：对本帧位移做线段采样（高速下坠时不会跳过甲板高度带）
    for (const s of ships) {
      if (!s.alive || s.team === b.team) continue;
      const top = s.pos.y + s.T.freeboard + 14;
      const bot = s.pos.y - 2;
      // 快速剔除：整段位移都不在高度带内就跳过
      if (Math.max(py0, b.pos.y) < bot || Math.min(py0, b.pos.y) > top) continue;
      const N = 6;
      for (let k = 0; k <= N; k++) {
        const f = k / N;
        const sx = b.pos.x - b.vel.x * dt * (1 - f);
        const sy = py0 + (b.pos.y - py0) * f;
        const sz = b.pos.z - b.vel.z * dt * (1 - f);
        if (sy < bot || sy > top) continue;
        if (!pointOnShip(s, sx, sz, 1.0)) continue;
        const dmg = b.damage * (0.8 + Math.random() * 0.4);
        s.hp -= dmg;
        s.fire = clamp(s.fire + 0.4, 0, 1);      // 航弹易起火
        s.lastHitBy = b.from;
        if (b.from) s.damageLog[b.from] = 1;
        pushEvt(evts, { k: 'shiphit', tgt: s.id, by: b.from, p: [sx, sy, sz], dmg: Math.round(dmg), pen: 1, zone: 'deck', big: 1, bomb: 1 });
        if (s.hp <= 0) s.hp = 0;
        return false;
      }
    }
    // 水面/地面
    const wh = waveHeight(b.pos.x, b.pos.z, 0);
    const gh = (typeof terrainH === 'function') ? terrainH(b.pos.x, b.pos.z) : -1;
    if (b.pos.y <= Math.max(wh, gh)) {
      pushEvt(evts, { k: 'shellsplash', by: b.from, p: [b.pos.x, wh, b.pos.z], big: 1, sp: 1 });
      return false;
    }
    return b.life > 0;
  }
  let terrainH = null;

  // ---------------------------------------------------------------------------
  // === 沉没 ===================================================================
  // ---------------------------------------------------------------------------
  function sinkShip(s, evts, reason) {
    if (!s.alive || s.deathDone) return;
    s.deathDone = true;
    s.alive = false;
    s.wreck = true;
    s.sinking = 0;
    s.hp = 0;
    s.crashReason = reason || 'hp';
    pushEvt(evts, { k: 'shipsink', id: s.id, by: s.lastHitBy || 0, reason: s.crashReason });
  }

  // 残骸：倾覆 + 下沉
  function stepWreck(s, dt) {
    if (s.sinking < 1) {
      s.sinking = Math.min(1, s.sinking + dt * 0.16);       // 约 6 秒沉完
      // 下沉时逐渐加大横倾（真实军舰沉没会先侧倾）
      s.roll = lerp(s.roll, 0.9, dt * 0.5);
      s.pitch = lerp(s.pitch, -0.35, dt * 0.4);
      s.pos.y = -s.sinking * (s.T.draft + 26);
      s.speed *= (1 - dt * 1.4);
      s.pos.x += shipForward(s.heading, _f).x * s.speed * dt;
      s.pos.z += shipForward(s.heading, _f).z * s.speed * dt;
    }
  }

  // ---------------------------------------------------------------------------
  // === 索敌辅助 ===============================================================
  // ---------------------------------------------------------------------------
  // 找最近的敌舰（用于 AI 与 HUD 目标推荐）
  function nearestEnemy(s, ships, maxDist) {
    let best = null, bestD = maxDist === undefined ? 1e18 : maxDist * maxDist;
    for (const o of ships) {
      if (!o.alive || o.team === s.team) continue;
      const d2 = (o.pos.x - s.pos.x) ** 2 + (o.pos.z - s.pos.z) ** 2;
      if (d2 < bestD) { bestD = d2; best = o; }
    }
    return best ? { ship: best, dist: Math.sqrt(bestD) } : null;
  }

  // 预测提前量：目标按当前航速直线运动，炮弹飞行时间用真实弹道反解
  // ⚠️ 关键：飞行时间必须用「弹道积分」而不是 d/v0。
  //    406mm 打 15km 要飞 22 秒（不是 15000/820=18s），差 4 秒 = 目标跑出 60 米。
  //    用 d/v0 迭代会让远距离永远打不中（实测战列舰 8 次齐射 0 命中）。
  function leadTarget(s, tgt, mg) {
    if (!tgt) return null;
    const d0 = Math.hypot(tgt.pos.x - s.pos.x, tgt.pos.z - s.pos.z);
    const tf = shipForward(tgt.heading, _ltF);
    // 迭代 3 次收敛：距离 → 仰角 → 飞行时间 → 新位置
    let t = flightTimeOf(mg, d0);
    let px = tgt.pos.x, pz = tgt.pos.z;
    for (let i = 0; i < 3; i++) {
      px = tgt.pos.x + tf.x * tgt.speed * t;
      pz = tgt.pos.z + tf.z * tgt.speed * t;
      const d = Math.hypot(px - s.pos.x, pz - s.pos.z);
      t = flightTimeOf(mg, d);
    }
    return {
      x: px, z: pz,
      time: t,
      dist: Math.hypot(px - s.pos.x, pz - s.pos.z),
      // 目标当前真实位置（HUD 画血条用）
      tx: tgt.pos.x, tz: tgt.pos.z
    };
  }
  const _ltF = { x: 0, z: 0 };

  // 给定水平距离，返回真实弹道飞行时间（与 ballisticElevation 同一套积分）
  const _ftCache = new Map();
  function flightTimeOf(mg, dist) {
    const key = mg.caliber + ':' + Math.round(dist / 100);
    const hit = _ftCache.get(key);
    if (hit !== undefined) return hit;
    const elev = ballisticElevation(mg, dist);
    const v0 = mg.shellSpeed, k = mg.dragCoef || 2.27e-5;
    let x = 0, y = 0;
    let vx = Math.cos(elev) * v0, vy = Math.sin(elev) * v0;
    const h = 1 / 60;
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const sp = Math.hypot(vx, vy);
      const dv = k * sp * sp * h;
      const f = Math.max(0, 1 - dv / Math.max(1, sp));
      vx *= f; vy *= f;
      vy -= 9.81 * h;
      x += vx * h; y += vy * h;
      t += h;
      if (y <= 0 && i > 4) break;
      if (x >= dist) break;
    }
    _ftCache.set(key, t);
    return t;
  }

  // ---------------------------------------------------------------------------
  // === 导出 ===================================================================
  // ---------------------------------------------------------------------------
  return {
    SHIP_TYPES, SHIP_TYPE_LIST, SEA,
    createShip, stepShip, stepWreck, stepShell, stepTorpedo, stepBomb,
    setTerrainH: (fn) => { terrainH = fn; },
    fireMainGun, fireTorpedo, resolveHit, sinkShip,
    shipForward, shipRight, shipToWorld, worldToShip, pointOnShip,
    waveHeight, waveNormal, throttleToSpeed,
    ballisticElevation, leadTarget, nearestEnemy,
    clamp, lerp
  };
});
