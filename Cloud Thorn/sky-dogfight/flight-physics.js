/* =============================================================================
 * flight-physics.js
 * 服务端（Node / CommonJS）与浏览器（window.FlightPhysics）共享模块
 * 内容：
 *   1) CONFIG 集中参数（手感 / 规则 / 网络 / 武器 / 计分）
 *   2) 向量与四元数数学
 *   3) 程序化地形（value noise + fbm，双端完全一致）
 *   4) 两座机场与跑道出生点
 *   5) 飞行状态创建 + 固定步长积分（升力 / 失速 / 阻力 / 重力 / 滑跑 / 起降判定）
 * 修改 CONFIG 即可调整手感，服务端与客户端无需分别改动。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightPhysics = factory();
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  // ===========================================================================
  // === CONFIG === 所有可调参数集中在这里 =====================================
  // ===========================================================================
  const CONFIG = {
    // ---- 世界 ----
    world: {
      size: 32000,          // 地图边长（米）：32km x 32km
      half: 16000,          // 半边长（出生/边界用）
      gravity: 9.81,        // 重力加速度 m/s^2
      rho0: 1.225,          // 海平面空气密度 kg/m^3
      scaleHeight: 9000,    // 密度衰减标高（米）
      ceil: 14000,          // 飞行天花板（米）
      softMargin: 700,      // 距离边界多远开始被“推回”
      hardMargin: 1400,     // 超出 half + hardMargin 判定迷航
      lostTime: 22,         // 越界持续多少秒判定迷航坠毁
      turnAssist: 0.6,      // 越界时把航向柔和拉回地图中心的角速度（rad/s）
      seaLevel: 0
    },

    // ---- 地形 ----
    terrain: {
      seed: 20240517,
      scale: 1 / 2700,      // 主地形噪声频率
      contrast: 2.8,        // fbm 集中在 0.5 附近，这里拉伸对比度来获得真正的山脉
      seaRatio: 0.46,       // 大陆阈值：噪声低于此为海洋
      seaDepth: 240,        // 海床最大深度
      hill: 180,            // 基础丘陵高度
      mountain: 850         // 山脉附加高度
    },

    // ---- 飞机气动与操控（街机手感，但保留失速/升力/重力）----
    aircraft: {
      mass: 11500,          // 质量 kg
      // 机翼面积 38 → 42、升力线斜率 5.0 → 6.2：原来翼载 302kg/m² 太重，
      // 140m/s 满杆只能拉出 4.5G，玩家的感受就是“拉不起来”。
      // 现在同样的速度能拉到 7.5G，接近战雷战斗机的瞬时盘旋能力。
      wingArea: 42,         // 机翼面积 m^2（翼载 274 kg/m²）
      maxThrust: 108000,    // 海平面最大推力 N（推重比约 0.96）
      thrustAltFalloff: 0.55,   // 高度导致的推力衰减
      thrustSpdFalloff: 0.28,   // 速度导致的推力衰减
      refSpeed: 450,        // 推力衰减参考速度
      throttleRate: 0.55,   // W/S 每秒改变的油门量

      clAlpha: 6.2,         // 升力线斜率 /rad
      clMax: 1.78,          // 最大升力系数
      aoaCrit: 0.285,       // 临界迎角 rad（约 16.3°，超过即失速；cl = 6.2*0.285 ≈ 1.77）
      cd0: 0.024,           // 零升阻力
      inducedK: 0.09,       // 诱导阻力因子
      gearCd: 0.05,         // 起落架放下附加阻力
      brakeCd: 0.06,        // 轮刹/刹车附加阻力
      airbrakeCd: 0.135,    // 减速板附加阻力（约 5.6 倍零升阻力，放板后掉速很明显）
      maxG: 11.5,           // 结构/飞行员 G 上限（限制最大升力；战雷战斗机破坏载荷约 12G）

      pitchRate: 1.45,      // 最大俯仰角速度 rad/s（83°/s）
      yawRate: 0.55,        // 鼠标直接偏航角速度 rad/s（街机味）
      rollRate: 3.20,       // 最大滚转角速度 rad/s
      rudderRate: 0.42,     // 方向舵角速度 rad/s
      controlRefSpeed: 120, // 低于此速度舵效线性下降

      // ---- 俯仰控制律：指令迎角（等效电传飞控）----
      // 杆量不再直接等于俯仰角速度，而是映射成「目标迎角」，机头以 pitchRate 为上限追随。
      // 这样满杆的落点是确定的（不会过临界失速），松杆自动回配平迎角，手感可预测。
      aoaLimit: 0.272,      // 满杆指令迎角 rad（15.6°，cl ≈ 1.69，接近峰值不失速）
      aoaLimitSpeed: 72,    // 低于此速度限制逐渐放开，保留真实的低速失速
      pitchServo: 7.0,      // 迎角伺服增益（1/s）：误差小时按比例收敛，避免抖动
      // 操纵面渐进（秒）：键盘是 ±1 开关量，直接给满舵会“一碰就满滚/满俯仰”，
      // 手感发僵。用舵面偏度从 0 渐进到 1 模拟作动筒惯性；回中比偏转略慢，像真机。
      ctlRollUp: 0.085,     // 滚转满舵耗时（秒）
      ctlRollDn: 0.14,      // 滚转回中耗时
      ctlPitchUp: 0.06,     // 俯仰满舵耗时（鼠标本身就是模拟量，只做轻平滑）
      ctlPitchDn: 0.10,
      ctlYawUp: 0.07,       // 偏航/方向舵满舵耗时
      ctlYawDn: 0.11,
      lateralDamp: 2.0,     // 侧滑阻尼（协调转弯手感，越大越“贴地”）
      trimAoA: 0.018,       // 配平迎角（rad，约 1°）——松杆时大致平飞

      gearHeight: 2.70,     // 起落架放下时机身中心离地高度（与模型轮底位置一致）
      gearUpHeight: 1.05,   // 收起时（ belly ）
      rollFriction: 0.035,  // 地面滚动摩擦系数
      brakeDecel: 14,       // 刹车减速度 m/s^2
      steerRate: 0.75,      // 前轮转向速率 rad/s
      rotateRate: 0.60,     // 抬轮速率 rad/s
      maxRotate: 0.24,      // 地面最大抬头角 rad（约 13.7°）
      takeoffSpeed: 60,     // 起飞最小速度 m/s

      maxGearSpeed: 125,    // 起落架安全速度（超过着陆判硬摔）
      maxSink: 10,          // 最大下沉率 m/s（本机滑翔比约 10，正常进近约 4~6）
      maxBank: 0.22,        // 着陆最大坡度 rad（约 12.6°）
      minPitch: -0.14,      // 着陆最小俯仰（不能低头砸）
      maxPitch: 0.50,       // 着陆最大俯仰
      hitRadius: 13         // 命中判定半径（米）
    },

    // ---- 武器 ----
    weapons: {
      gun: {
        rate: 12,           // 射发/秒
        damage: 7.5,        // 每发伤害
        range: 1800,        // 有效射程（米）
        speed: 900,         // 弹速（米/秒），用于提前量判定与 HUD 引导
        spread: 0.012,      // 散布（弧度）
        heatPerShot: 0.062, // 每发热量
        coolRate: 0.30,     // 每秒散热
        overheatLock: 0.45, // 过热后降到该热量才能再开火
        ammoMax: 420
      },
      missile: {
        count: 4,           // 挂载数
        cooldown: 2.2,      // 发射冷却（秒）
        lockTime: 1.15,     // 满锁定所需时间（秒）
        lockCone: 0.32,     // 锁定视锥半角 rad（约 18°）
        lockRange: 5200,    // 最大锁定距离（米）
        lockMinRange: 120,  // 最小锁定距离
        startSpeed: 260,    // 离轨初速（在载机速度上叠加）
        accel: 340,         // 加速度 m/s^2
        maxSpeed: 800,      // 最高速度 m/s
        turnRate: 2.2,      // 最大转向角速度 rad/s
        life: 9.0,          // 自毁时间（秒）
        fuse: 32,           // 近炸引信半径（米）
        blast: 42,          // 爆炸伤害半径（米）
        damage: 108,        // 中心伤害（命中即重创，擦边仍可能活）
        armTime: 0.35,      // 保险解除时间（秒）
        holdFireTime: 1.2,  // 无锁定长按蓄力时间（秒）：按住满 1.2s 发射哑弹直飞

        // ---- 近地屏蔽（地杂波 + 地形遮挡）----
        // 低空目标会“沉”进地面回波里，雷达导引头看不远；山脊/山谷则直接挡住视线。
        // 这套参数让贴地突防真正有用：距离越远越依赖净空，钻山谷能断锁。
        maskAlt: 95,          // 目标离地净空低于此值 → 开始被地杂波压制（锁定距离缩短）
        maskFloorAlt: 20,     // 低于此净空 → 完全锁不上（贴地/掠海）
        maskRangeScale: 0.24, // 被完全压制时，有效锁定距离只剩这个比例
        losStep: 190,         // 视线遮挡采样间距（米）
        losMargin: 9,         // 视线离地余量（米），低于它就算被地形挡住
        losDecay: 3.4,        // 被遮挡时锁定进度衰减倍率（相对正常脱锁）
        seekerFloor: 13,      // 导弹自身离地净空低于此值 → 导引头被地面回波压制（掠海才有用）
        seekerHold: 0.35      // 压制持续多久彻底丢失制导（秒）
      },
      flare: {
        count: 14,          // 干扰弹数量
        cooldown: 1.5,      // 投放冷却
        life: 3.4,          // 燃烧时间
        spoofCone: 0.70,    // 诱骗视锥（rad）
        spoofRange: 700,    // 诱骗距离（米）
        backSpeed: 45       // 相对载机向后初速
      }
    },

    // ---- 计分 ----
    scoring: {
      kill: 100,
      assist: 40,
      death: -30,
      crash: -40,
      takeoff: 5,
      landing: 30,
      resupply: 10,
      teamKill: -60,
      siteKill: 30,    // 摧毁敌方防空阵地
      // ---- 海战 ----
      shipKill: 300,   // 击沉一艘战舰（按舰种加权，驱逐150/巡洋300/战列600）
      shipLoss: -150,  // 己方战舰被击沉
      torpHit: 60      // 鱼雷命中
    },

    // ---- 比赛 ----
    match: {
      targetScore: 1600,    // 团队目标分
      durationSec: 900,     // 单局时长（秒）
      resetDelaySec: 12,    // 结束后多久重开
      respawnSec: 6,        // 阵亡后重新出击等待
      wreckSec: 5           // 残骸保留时间
    },

    // ---- 网络 ----
    net: {
      simHz: 60,            // 服务端权威模拟频率（客户端也按 1/simHz 固定步长积分）
      snapshotHz: 20,       // 状态广播频率
      maxPlayers: 16,
      interpDelay: 0.10,    // 客户端插值延迟（秒）
      // 敌情发现距离：本队任一飞行员在此距离内即视为“被发现”，
      // 结果通过数据链共享给全队（友军识别）
      spotRange: 10000
    },

    // ---- 补给/维修 ----
    base: {
      radius: 520,          // 本队机场半径（HUD 参考）
      stopSpeed: 8,         // 停稳速度阈值（m/s）
      runwayMargin: 240,    // 判定“在机场上”的横向余量（米）
      endMargin: 260        // 跑道两端的纵向余量（米）
    },

    // ---- 机器人（没有真人时也能直接开打；联机时作为气氛补充）----
    bots: {
      countPerTeam: 2,      // 每队机器人数量（0 = 关闭）
      skill: 0.72,          // 0~1，越高瞄准越准、反应越快
      fireRange: 1350,      // 机炮开火距离
      missileRange: 4200,   // 导弹发射距离
      evadeRange: 2600      // 被锁定后开始规避的距离
    }
  };

  // ===========================================================================
  // === 数学工具 ===
  // ===========================================================================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const V = {
    make: (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    mul: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    cross: (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    }),
    len: (a) => Math.hypot(a.x, a.y, a.z),
    dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    norm: (a) => {
      const l = Math.hypot(a.x, a.y, a.z) || 1;
      return { x: a.x / l, y: a.y / l, z: a.z / l };
    },
    copy: (a) => ({ x: a.x, y: a.y, z: a.z }),
    lerp: (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t
    })
  };

  const Q = {
    identity: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    copy: (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w }),
    mul: (a, b) => ({
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    }),
    norm: (q) => {
      const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
      return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
    },
    fromAxisAngle: (axis, ang) => {
      const a = V.norm(axis);
      const s = Math.sin(ang * 0.5);
      return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(ang * 0.5) };
    },
    rotate: (q, v) => {
      // v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
      const tx = 2 * (q.y * v.z - q.z * v.y);
      const ty = 2 * (q.z * v.x - q.x * v.z);
      const tz = 2 * (q.x * v.y - q.y * v.x);
      return {
        x: v.x + q.w * tx + (q.y * tz - q.z * ty),
        y: v.y + q.w * ty + (q.z * tx - q.x * tz),
        z: v.z + q.w * tz + (q.x * ty - q.y * tx)
      };
    },
    slerp: (a, b, t) => {
      let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
      let bx = b.x, by = b.y, bz = b.z, bw = b.w;
      if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      if (d > 0.9995) {
        return Q.norm({ x: lerp(a.x, bx, t), y: lerp(a.y, by, t), z: lerp(a.z, bz, t), w: lerp(a.w, bw, t) });
      }
      const th = Math.acos(d);
      const s = Math.sin(th);
      const wa = Math.sin((1 - t) * th) / s;
      const wb = Math.sin(t * th) / s;
      return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
    },
    // 绕任意轴旋转一个向量（罗德里格斯公式）
    rotAxis: (v, axis, ang) => {
      const k = V.norm(axis);
      const c = Math.cos(ang), s = Math.sin(ang);
      const cr = V.cross(k, v);
      const d = V.dot(k, v) * (1 - c);
      return {
        x: v.x * c + cr.x * s + k.x * d,
        y: v.y * c + cr.y * s + k.y * d,
        z: v.z * c + cr.z * s + k.z * d
      };
    }
  };

  // 机体基准轴（与 Three.js 一致：机头 -Z，右翼 +X，上方 +Y）
  const AXIS_FWD = { x: 0, y: 0, z: -1 };
  const AXIS_RIGHT = { x: 1, y: 0, z: 0 };
  const AXIS_UP = { x: 0, y: 1, z: 0 };

  // 由 偏航/俯仰/滚转 构造四元数（先 yaw(Y) 再 pitch(X) 再 roll(-Z)）
  function quatFromYPR(yaw, pitch, roll) {
    const qy = Q.fromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
    const qp = Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, pitch);
    const qr = Q.fromAxisAngle({ x: 0, y: 0, z: -1 }, roll);
    return Q.mul(qy, Q.mul(qp, qr));
  }

  // 从四元数反解 偏航/俯仰/滚转
  function yprFromQuat(q) {
    const f = Q.rotate(q, AXIS_FWD);
    const up = Q.rotate(q, AXIS_UP);
    const right = Q.rotate(q, AXIS_RIGHT);
    const pitch = Math.asin(clamp(f.y, -1, 1));
    const yaw = Math.atan2(-f.x, -f.z);
    const roll = Math.atan2(-right.y, up.y);
    return { yaw, pitch, roll };
  }

  // ===========================================================================
  // === 程序化地形（双端完全一致）============================================
  // ===========================================================================
  function hash2(ix, iz) {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(CONFIG.terrain.seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  function noise2(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function fbm(x, z, oct) {
    let amp = 0.5, frq = 1, sum = 0, nrm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise2(x * frq, z * frq);
      nrm += amp;
      amp *= 0.5;
      frq *= 2.03;
    }
    return sum / nrm;
  }

  // 机场平台：沿跑道方向长、侧向窄的椭圆，向外平滑过渡回自然地形
  const AIRPORTS = [
    { id: 0, team: 0, name: '苍岭空军基地', x: -12000, z: -2000, hx: 1, hz: 0, elev: 28, len: 2600, wid: 60 },
    { id: 1, team: 1, name: '赤沙空军基地', x: 12000, z: 2000, hx: -1, hz: 0, elev: 28, len: 2600, wid: 60 }
  ];
  for (const ap of AIRPORTS) {
    ap.rx = -ap.hz;   // 跑道右向量
    ap.rz = ap.hx;
    ap.flatAlong = ap.len * 0.62; // 平台沿跑道半径
    ap.flatLat = 430;             // 平台侧向半径
  }

  // ---- 航空母舰 ×2：两队各一艘，放在「机场 → 战场中点」的连线上（一半距离处） ----
  // 两基地 z 向中点 = (0,0)。机场到中点实测 12165m，一半 = 6083m。
  // ⚠️ 地形约束：连线方向 6083m 处（-6000,-1000）是海拔 588m 的山地，放不下舰体；
  //    6083m 半径圆上能满足「甲板全海 + 进场下滑道不被山挡 + 弹射走廊畅通」的弧段
  //    经实测扫描全都不覆盖机场连线方向。取实测最近可行解：距中点 7050m（偏差约 1km），
  //    两舰严格中心对称，各贴近自己一侧机场（蓝舰离蓝机场 6.8km / 离红机场 18.7km）。
  //    蓝队舰 (-5596,-4288) / 红队舰 (5596,4288)。
  // 甲板朝向：舰艏朝战场中心侧偏转（弹射离舰即朝战区），舰艉朝外侧（进场从外向内切）。
  const CARRIER_DEF = {
    y: 22,                 // 飞行甲板面高度（相对海平面 y=0）
    len: 330,              // 甲板全长（米，真实尼米兹级约 333m）
    wid: 78,               // 甲板宽（含斜角甲板）
    angle: 9 * Math.PI / 180,   // 斜角甲板角度（降落跑道相对舰体中轴偏转）
    deckLen: 220,          // 降落跑道可用长度
    wireZ: [-40, -10, 20], // 三根阻拦索的位置（沿甲板轴，舰艏为负）
    catZ: 120,             // 弹射起飞位（舰艉附近）
    radius: 700,           // 补给判定半径
    elev: 22,
    catapultLen: 95,       // 弹射行程
    catapultSpeed: 78,     // 弹射末速（m/s，约 280km/h）
    taxiSpeed: 30          // 甲板牵引速度（m/s，约 108km/h；定速滑行，见 groundStep）
  };

  // 每队一艘。x/z 为舰体中点世界坐标；hx/hz 为甲板轴线（舰艏朝 -along 方向）
  function makeCarrier(team, x, z, phiDeg) {
    const rad = phiDeg * Math.PI / 180;
    const hx = Math.round(Math.cos(rad) * 1e4) / 1e4;
    const hz = Math.round(Math.sin(rad) * 1e4) / 1e4;
    const c = Object.assign({}, CARRIER_DEF, { team, x, z, hx, hz, phi: phiDeg });
    c.rx = -hz; c.rz = hx;      // 甲板右向量
    return c;
  }
  const CARRIERS = [
    makeCarrier(0, -5596, -4288, 340),   // 蓝队舰（苍岭侧）
    makeCarrier(1, 5596, 4288, 160)      // 红队舰（赤沙侧），与蓝舰中心对称
  ];
  // 兼容旧引用：CARRIER = 蓝队舰（HUD/模型等只关心"一艘"的形状参数时用）
  const CARRIER = CARRIERS[0];

  // 世界坐标 ↔ 指定航母的甲板坐标（沿轴向 = along，侧向 = lat，舰艏为 -along）
  function carrierLocal(x, z, cv) {
    const c = cv || CARRIER;
    const dx = x - c.x, dz = z - c.z;
    return { along: dx * c.hx + dz * c.hz, lat: dx * c.rx + dz * c.rz };
  }
  function onCarrierDeck(x, z, margin, cv) {
    const m = margin === undefined ? 1 : margin;
    const c = cv || CARRIER;
    const l = carrierLocal(x, z, c);
    return Math.abs(l.along) < c.len * 0.5 * m && Math.abs(l.lat) < c.wid * 0.5 * m;
  }
  // 找某点落在哪艘航母的甲板上（都不在返回 null）
  function carrierAt(x, z, margin) {
    for (const c of CARRIERS) if (onCarrierDeck(x, z, margin, c)) return c;
    return null;
  }

  function terrainRaw(x, z) {
    const T = CONFIG.terrain;
    const n = fbm(x * T.scale, z * T.scale, 5);
    // fbm 结果集中在 0.5 附近，先做对比度拉伸，否则地形会一片平坦
    const n2 = clamp((n - 0.5) * T.contrast + 0.5, 0, 1);
    const land = n2 - T.seaRatio;
    if (land <= 0) return land * T.seaDepth;      // 负值 = 海床
    const m = Math.pow(Math.min(1, land / (1 - T.seaRatio)), 1.5);
    const ridge = fbm(x * T.scale * 3.1 + 37.7, z * T.scale * 3.1 - 11.3, 4);
    return m * (T.hill + ridge * T.mountain);
  }

  function terrainHeight(x, z) {
    let h = terrainRaw(x, z);
    for (let i = 0; i < AIRPORTS.length; i++) {
      const ap = AIRPORTS[i];
      const dx = x - ap.x, dz = z - ap.z;
      const along = dx * ap.hx + dz * ap.hz;
      const lat = dx * ap.rx + dz * ap.rz;
      const d = Math.sqrt((along / ap.flatAlong) ** 2 + (lat / ap.flatLat) ** 2);
      if (d < 1.55) {
        const w = 1 - smoothstep(0.85, 1.5, d);   // 1 = 完全压平
        h = lerp(h, ap.elev, w);
      }
    }
    return h;
  }

  const isWater = (x, z) => terrainHeight(x, z) < 0;
  const rhoAt = (y) => CONFIG.world.rho0 * Math.exp(-Math.max(0, y) / CONFIG.world.scaleHeight);

  // 把世界坐标换算到机场局部坐标：along = 沿跑道（+ 为跑道远端），lat = 横向
  function airportLocal(ap, x, z) {
    const dx = x - ap.x, dz = z - ap.z;
    return { along: dx * ap.hx + dz * ap.hz, lat: dx * ap.rx + dz * ap.rz };
  }

  // 是否停在机场范围内（跑道 + 停机坪余量），用于返场计分与补给
  function onAirport(ap, x, z, margin) {
    const m = margin === undefined ? 1 : margin;
    const l = airportLocal(ap, x, z);
    return Math.abs(l.along) < ap.len * 0.5 + CONFIG.base.endMargin * m
      && Math.abs(l.lat) < ap.wid * 0.5 + CONFIG.base.runwayMargin * m;
  }

  // 跑道方位（沿起飞方向：从近端指向远端）
  const runwayHeading = (ap) => Math.atan2(-ap.hx, -ap.hz);

  // 检查点是否在跑道矩形内（着陆判定用，比圆形更贴近跑道）
  function onRunway(ap, x, z) {
    const l = airportLocal(ap, x, z);
    return Math.abs(l.along) < ap.len * 0.5 + 60 && Math.abs(l.lat) < ap.wid * 0.5 + 45;
  }

  // ===========================================================================
  // === 飞行状态 ==============================================================
  // ===========================================================================
  function normalizeInput(i) {
    const s = i || {};
    return {
      pitch: clamp(+s.pitch || 0, -1, 1),        // +1 = 抬头
      yaw: clamp(+s.yaw || 0, -1, 1),            // +1 = 机头向右
      roll: clamp(+s.roll || 0, -1, 1),          // +1 = 右滚
      rudder: clamp(+s.rudder || 0, -1, 1),      // +1 = 方向舵向右（E）
      throttleAxis: clamp(+s.throttleAxis || 0, -1, 1), // W/S 增量
      throttleSet: (typeof s.throttleSet === 'number' && s.throttleSet >= 0) ? clamp(+s.throttleSet, 0, 1) : -1,
      brake: s.brake ? 1 : 0,
      ab: s.ab ? 1 : 0,              // 减速板（空中）
      gear: s.gear === undefined ? true : !!s.gear,
      fire: !!s.fire,
      missile: !!s.missile,
      flare: !!s.flare
    };
  }
  const EMPTY_INPUT = normalizeInput({});

  // 出生点：跑道末端（远离战场一侧），4 列 × 4 排，最多 16 架同时待命
  function spawnTransform(ap, slot) {
    const i = ((slot % 16) + 16) % 16;
    const col = i % 4;                       // 0..3
    const row = Math.floor(i / 4);           // 0..3
    const back = -row * 78;
    const lat = [-24, -8, 8, 24][col];
    const along = -(ap.len * 0.5) + 170 + back;
    const yaw = Math.atan2(-ap.hx, -ap.hz);
    return {
      pos: {
        x: ap.x + ap.hx * along + ap.rx * lat,
        y: ap.elev + CONFIG.aircraft.gearHeight,
        z: ap.z + ap.hz * along + ap.rz * lat
      },
      quat: quatFromYPR(yaw, 0, 0),
      yaw
    };
  }

  // ---- 机种参数：战斗机（默认） / 轰炸机（重、慢、反舰）----
  // 轰炸机定位：对战舰是致命威胁（鱼雷+航弹），对空自卫能力弱 → 被战斗机克制。
  // 与战舰形成克制环：战舰怕轰炸机、轰炸机怕战斗机、战斗机怕战舰防空。
  const AC_TYPES = {
    fighter: {
      name: '战斗机',
      // 完全沿用原参数（原 CONFIG.aircraft 就是为战斗机调的）
      scale: 1
    },
    bomber: {
      name: '轰炸机',
      scale: 1,
      // 覆盖项：更重、推重比低、机动差、机体大
      over: {
        mass: 2.35,            // 质量倍率（双发重型）
        thrust: 2.30,          // 推力倍率（双发大推力，推重比接近战斗机但极速/机动差）
        pitchRate: 0.62,       // 俯仰速率倍率（笨重）
        rollRate: 0.55,
        yawRate: 0.8,
        maxG: 6.5,             // 结构限制低
        wingArea: 1.85,        // 更大机翼（升力够才能飞）
        hitRadius: 19,         // 更大的命中判定
        aoaLimit: 0.20,        // 限制迎角（不能拉狠）
        maxSpeedFactor: 0.78   // 高速阻力大（极速下降）
      },
      // 载弹
      loadout: { torp: 1, bomb: 2 }
    }
  };

  function createAircraft(id, name, team, opts) {
    const o = opts || {};
    const ap = AIRPORTS[team] || AIRPORTS[0];
    const st = spawnTransform(ap, o.slot || 0);
    const atype = o.atype === 'bomber' ? 'bomber' : 'fighter';
    const a = {
      // 标识
      id, name, team,
      atype,
      // 运动
      pos: V.copy(st.pos),
      vel: { x: 0, y: 0, z: 0 },
      quat: Q.copy(st.quat),
      throttle: 0,
      gear: true,
      ab: false,              // 减速板
      onGround: true,
      airborne: false,
      gYaw: st.yaw,
      gPitch: 0,
      speed: 0,
      gLoad: 1,
      aoa: 0,
      stalled: false,
      // 生存
      alive: true,
      wreck: false,
      deathDone: false,       // 服务端：死亡结算是否已执行（防止重复计分）
      health: 100,
      crashReason: '',
      removeAt: 0,
      spawnId: o.spawnId || 1,
      out: 0,
      serviced: true,     // 出生即满补
      lastDamageAt: -999,
      damageLog: {},      // attackerId -> 时间
      // 武器
      ammo: CONFIG.weapons.gun.ammoMax,
      missiles: CONFIG.weapons.missile.count,
      flares: CONFIG.weapons.flare.count,
      heat: 0,
      overheated: false,
      firing: false,
      fireAccum: 0,
      missileCd: 0,
      flareCd: 0,
      lockProgress: 0,
      lockTargetId: 0,
      lockedBy: 0,
      // 操纵面偏度（0..1 渐进量）：见 airStep 的“操纵面渐进”
      ctl: { p: 0, r: 0, y: 0, d: 0 },
      // 起降状态
      tdT: 0,             // 接地冷却（秒）
      susp: 0,            // 起落架压缩量（米）
      // 航母甲板牵引：着舰停稳后请求弹射时，先把飞机滑回弹射位再弹射。
      // 甲板不是机场，停稳点（斜角甲板中段）离弹射位（舰艉侧）有一百多米，
      // 不牵引的话玩家得倒车+调头才能弹射，在有阻拦索的甲板上根本做不到。
      // 用定速滑行（不用计时器），进度只看位置，回滚重放天然连续。
      taxiActive: false,  // 牵引中
      catQueued: false    // 牵引结束后自动接弹射
    };
    // ---- 机种应用：轰炸机按倍率覆盖气动/结构参数 ----
    const AT = AC_TYPES[atype];
    if (AT && AT.over) {
      const C = CONFIG.aircraft;
      a.acParams = {
        mass: C.mass * AT.over.mass,
        maxThrust: C.maxThrust * AT.over.thrust,
        pitchRate: C.pitchRate * AT.over.pitchRate,
        rollRate: C.rollRate * AT.over.rollRate,
        yawRate: C.yawRate * AT.over.yawRate,
        maxG: AT.over.maxG,
        wingArea: C.wingArea * AT.over.wingArea,
        hitRadius: AT.over.hitRadius,
        aoaLimit: AT.over.aoaLimit
      };
      a.maxSpeedCap = C.maxSpeed * AT.over.maxSpeedFactor;
    } else {
      a.acParams = null;       // 战斗机走默认
      a.maxSpeedCap = 0;
    }
    // 轰炸机载弹（鱼雷/航弹各按载弹量）
    a.torps = (AT && AT.loadout) ? AT.loadout.torp : 0;
    a.bombs = (AT && AT.loadout) ? AT.loadout.bomb : 0;
    return a;
  }

  // ---------------------------------------------------------------------------
  // === 轰炸机反舰武器 =========================================================
  // ---------------------------------------------------------------------------
  // 航空鱼雷：从飞机上投放，入水后直航（低速掠海，命中舰体吃水线）
  //   投放条件：高度 < 60m、速度 < 90m/s（真实鱼雷机必须低空低速投雷）
  function dropTorpedo(a, input, events, world) {
    if (!a.torps || a.torps <= 0) return null;
    if (a.pos.y > 65) return null;                    // 太高不能投
    if (a.speed > 95) return null;                    // 太快不能投
    const gh = terrainHeight(a.pos.x, a.pos.z);
    if (gh >= -3) return null;                        // 只能在水上投
    a.torps--;
    const fwd = Q.rotate(a.quat, AXIS_FWD);
    const torp = {
      kind: 'airtorp',
      from: a.id,
      team: a.team,
      // 从机腹投放点开始，先自由下落入水，再转为掠海直航
      pos: { x: a.pos.x, y: Math.max(2, a.pos.y - 3.5), z: a.pos.z },
      vy: a.vel.y - 1.2,
      dir: { x: fwd.x, z: fwd.z },
      speed: Math.max(30, a.speed * 0.65),
      maxSpeed: 58,
      life: 45,
      armed: 0,
      damage: 2600
    };
    events.push({ k: 'torpshot', id: a.id, air: 1, p: [a.pos.x, a.pos.y, a.pos.z] });
    return torp;
  }

  // 航空炸弹：自由落体（带载机初速），砸舰体/地面
  function dropBomb(a, input, events) {
    if (!a.bombs || a.bombs <= 0) return null;
    a.bombs--;
    const fwd = Q.rotate(a.quat, AXIS_FWD);
    const bomb = {
      kind: 'bomb',
      from: a.id,
      team: a.team,
      pos: { x: a.pos.x, y: a.pos.y - 4, z: a.pos.z },
      vel: { x: fwd.x * a.speed, y: a.vel.y, z: fwd.z * a.speed },
      life: 20,
      damage: 1450
    };
    events.push({ k: 'bombdrop', id: a.id, p: [a.pos.x, a.pos.y, a.pos.z] });
    return bomb;
  }

  // 复用对象重新出生（保留 id / 队伍 / 名字）
  function resetAircraft(a, slot, spawnId) {
    const ap = AIRPORTS[a.team] || AIRPORTS[0];
    const st = spawnTransform(ap, slot || 0);
    a.pos = V.copy(st.pos);
    a.vel = { x: 0, y: 0, z: 0 };
    a.quat = Q.copy(st.quat);
    a.throttle = 0; a.gear = true; a.ab = false;
    a.onGround = true; a.airborne = false;
    a.gYaw = st.yaw; a.gPitch = 0;
    a.speed = 0; a.gLoad = 1; a.aoa = 0; a.stalled = false;
    a.alive = true; a.wreck = false; a.deathDone = false; a.health = 100; a.crashReason = '';
    a.removeAt = 0; a.spawnId = spawnId; a.out = 0; a.serviced = true;
    a.lastDamageAt = -999; a.damageLog = {};
    a.ammo = CONFIG.weapons.gun.ammoMax;
    a.missiles = CONFIG.weapons.missile.count;
    a.flares = CONFIG.weapons.flare.count;
    a.heat = 0; a.overheated = false; a.firing = false; a.fireAccum = 0;
    a.missileCd = 0; a.flareCd = 0;
    a.lockProgress = 0; a.lockTargetId = 0; a.lockedBy = 0;
    a.ctl = { p: 0, r: 0, y: 0, d: 0 };
    a.tdT = 0;          // 接地冷却（防止刚落地又判定“起飞”来回跳）
    a.susp = 0;         // 起落架压缩量（视觉缓冲，米）
    a.gVy = 0;          // 地面垂直速度（缓冲用）
    // 航母甲板状态全部清空（重生在陆地机场，不该带着上局的甲板状态）
    a.onDeck = false; a.wireCaught = false; a.wirePrevAlong = undefined;
    a.cvTeam = -1;                  // 不在任何航母上
    a.deckStopped = false; a.catActive = false; a.catT = 0;
    a.taxiActive = false; a.catQueued = false;
    // 轰炸机挂载复位
    if (a.atype === 'bomber' && AC_TYPES.bomber && AC_TYPES.bomber.loadout) {
      a.torps = AC_TYPES.bomber.loadout.torp;
      a.bombs = AC_TYPES.bomber.loadout.bomb;
    }
    return a;
  }

  function cloneState(a) {
    return {
      id: a.id, name: a.name, team: a.team,
      pos: V.copy(a.pos), vel: V.copy(a.vel), quat: Q.copy(a.quat),
      throttle: a.throttle, gear: a.gear, ab: a.ab, onGround: a.onGround, airborne: a.airborne,
      gYaw: a.gYaw, gPitch: a.gPitch, speed: a.speed, gLoad: a.gLoad, aoa: a.aoa,
      stalled: a.stalled, alive: a.alive, wreck: a.wreck, health: a.health,
      spawnId: a.spawnId, serviced: a.serviced, lockProgress: a.lockProgress
    };
  }

  // ===========================================================================
  // === 气动核心 ==============================================================
  // ===========================================================================
  function clOf(aoa) {
    const C = CONFIG.aircraft;
    const s = aoa < 0 ? -1 : 1;
    const m = Math.abs(aoa);
    if (m <= C.aoaCrit) return C.clAlpha * aoa;          // 线性段
    const over = clamp((m - C.aoaCrit) / (1.2 - C.aoaCrit), 0, 1);
    return s * C.clMax * (1 - 0.78 * over);              // 失速后升力骤降
  }

  function crashAircraft(a, events, reason) {
    if (!a.alive) return;
    a.alive = false;
    a.health = 0;
    a.crashReason = reason || 'terrain';
    a.wreck = true;
    events.push({ k: 'crash', id: a.id, r: a.crashReason });
  }

  function spinWreck(a, dt) {
    // 残骸翻滚（纯视觉）
    a.quat = Q.norm(Q.mul(Q.fromAxisAngle(AXIS_FWD, dt * 1.4), a.quat));
    a.quat = Q.norm(Q.mul(Q.fromAxisAngle(AXIS_RIGHT, dt * 0.7), a.quat));
  }

  // ---- 空中飞行 ----
  function airStep(a, inp, dt, events) {
    const C = a.acParams ? Object.assign({}, CONFIG.aircraft, a.acParams) : CONFIG.aircraft;
    const W = CONFIG.world;
    const rho = rhoAt(a.pos.y);

    const fwd = Q.rotate(a.quat, AXIS_FWD);
    const right = Q.rotate(a.quat, AXIS_RIGHT);
    const up = Q.rotate(a.quat, AXIS_UP);

    let v = a.vel;
    const speed0 = V.len(v);
    const vdir = speed0 > 0.05 ? V.mul(v, 1 / speed0) : V.copy(fwd);

    // 迎角（机体上方向在速度方向的投影）
    const dotUp = V.dot(vdir, up);
    const dotFwd = V.dot(vdir, fwd);
    let aoa = Math.asin(clamp(-dotUp, -1, 1));
    if (dotFwd < 0) aoa = Math.PI - aoa;
    aoa = clamp(aoa, -1.2, 1.2);

    const cl = clOf(aoa);
    const over = clamp((Math.abs(aoa) - C.aoaCrit) / (1.2 - C.aoaCrit), 0, 1);
    const cd = C.cd0 + C.inducedK * cl * cl
      + (a.gear ? C.gearCd : 0)
      + (inp.brake ? C.brakeCd : 0)
      + (inp.ab ? C.airbrakeCd : 0)
      + (Math.abs(aoa) > C.aoaCrit ? 0.85 * over * over : 0);

    const q = 0.5 * rho * speed0 * speed0;

    // 升力方向：垂直于速度、位于机体上方（滚转即产生转弯）
    let liftDir = V.sub(up, V.mul(vdir, V.dot(up, vdir)));
    if (V.len(liftDir) < 1e-5) liftDir = { x: 0, y: 1, z: 0 };
    else liftDir = V.norm(liftDir);

    const maxLift = C.maxG * C.mass * W.gravity;     // G 上限
    const liftRaw = q * C.wingArea * cl;             // 未限制前的升力
    const liftMag = clamp(liftRaw, -maxLift, maxLift);
    // 只有“升力真的掉了”才算失速；高速拉杆被 G 上限夹住时不报假失速
    const stalled = Math.abs(aoa) > C.aoaCrit && Math.abs(liftRaw) < maxLift;
    const lift = V.mul(liftDir, liftMag);
    const drag = V.mul(vdir, -q * C.wingArea * cd);

    const altF = clamp(1 - C.thrustAltFalloff * Math.max(0, a.pos.y) / 12000, 0.35, 1);
    const spdF = clamp(1 - C.thrustSpdFalloff * clamp(speed0 / C.refSpeed, 0, 1.6), 0.3, 1);
    const thrust = V.mul(fwd, C.maxThrust * a.throttle * altF * spdF);
    const grav = { x: 0, y: -C.mass * W.gravity, z: 0 };

    let acc = V.mul(V.add(V.add(lift, drag), V.add(thrust, grav)), 1 / C.mass);

    // 侧滑阻尼：让转弯更“协调”，避免像气垫船一样横移
    const vlat = V.dot(v, right);
    acc = V.sub(acc, V.mul(right, vlat * C.lateralDamp * clamp(speed0 / 80, 0, 1.2)));

    const p0 = V.copy(a.pos);
    v = V.add(v, V.mul(acc, dt));
    a.vel = v;
    a.pos = V.add(a.pos, V.mul(v, dt));

    // G 值 = 除重力外所有外力产生的过载（含升力/阻力/推力），与真实 G 表一致
    const accAero = V.mul(V.add(V.add(lift, drag), thrust), 1 / C.mass);

    // 姿态控制（舵效随速度下降）
    const eff = clamp(speed0 / C.controlRefSpeed, 0.15, 1);
    // ---- 操纵面渐进 ----
    // 键盘/摇筒输入是开关量或跳变量，先平滑成“舵面偏度”再换算角速度，
    // 否则 A/D 一按就是满滚 183°/s，松手又瞬间冻结 —— 这就是“左右滚转僵硬”的根因。
    // 状态挂在飞机上（a.ctl），服务端与客户端预测共用同一套演化，快照同步保证回放一致。
    if (!a.ctl) a.ctl = { p: 0, r: 0, y: 0, d: 0 };
    const ctl = a.ctl;
    const ctlEase = (cur, tgt, up, dn) => {
      const rate = dt / (tgt > cur ? up : dn);
      const d = tgt - cur;
      return d > rate ? cur + rate : (d < -rate ? cur - rate : tgt);
    };
    ctl.p = ctlEase(ctl.p, inp.pitch, C.ctlPitchUp, C.ctlPitchDn);
    ctl.r = ctlEase(ctl.r, inp.roll, C.ctlRollUp, C.ctlRollDn);
    ctl.y = ctlEase(ctl.y, inp.yaw, C.ctlYawUp, C.ctlYawDn);
    ctl.d = ctlEase(ctl.d, inp.rudder, C.ctlYawUp, C.ctlYawDn);

    // ---- 俯仰：指令迎角 + 角速度限制（等效电传飞控）----
    // 旧做法是「杆量 × 俯仰角速度」直接转机头，再由风标稳定性把机头拉回气流方向。
    // 两者的平衡迎角会随速度漂移：满杆时平衡迎角已经超过临界迎角，升力反而崩掉，
    // 表现就是「拉满了却转不动、拉不起来」。现在杆量直接映射「目标迎角」：
    //   松杆 → 配平迎角（平飞）    满杆 → 限制迎角（cl 接近峰值，不失速）
    const clNeed = (C.mass * W.gravity) / Math.max(1, q * C.wingArea);
    const aoaTrim = clamp(clNeed / C.clAlpha, 0.004, C.aoaLimit * 0.80);
    // 由 G 上限反推可用迎角：q 越大，同样过载所需迎角越小。
    // 不这么做的话会出现「过载被夹住、阻力照付」，掉速比真飞机快得多。
    // 上限放到 aoaCrit 以上：低速时这条不该成为天花板，否则「低速放开限制」形同虚设、永远拉不失速。
    const aoaG = clamp((C.maxG * C.mass * W.gravity) / Math.max(1, q * C.wingArea * C.clAlpha),
      0.02, C.aoaCrit * 1.35);
    // 低速时逐渐放开限制，保留真实的低速失速（否则慢速猛拉永远失不了速）
    const limW = clamp((speed0 - C.aoaLimitSpeed * 0.55) / (C.aoaLimitSpeed * 0.45), 0, 1);
    const aoaUp = Math.min(aoaG, lerp(0.52, C.aoaLimit, limW));
    const aoaCmd = ctl.p >= 0
      ? aoaTrim + (aoaUp - aoaTrim) * ctl.p
      : aoaTrim + (aoaUp * 0.80) * ctl.p;

    const yr = (ctl.y * C.yawRate + ctl.d * C.rudderRate) * eff;
    const rr = ctl.r * C.rollRate * clamp(eff, 0.4, 1);
    a.quat = Q.norm(Q.mul(Q.fromAxisAngle(up, -yr * dt), a.quat));
    a.quat = Q.norm(Q.mul(Q.fromAxisAngle(fwd, rr * dt), a.quat));

    // ---- 迎角伺服 ----
    // 只修迎角、不碰偏航：绕「气流 × 机背」横轴，把当前迎角收敛到目标迎角 aoaCmd。
    // 大误差时按 pitchRate 限速（指向干脆），小误差时按比例收敛（不抖、不振荡）。
    //
    // ⚠️ 之前用 angleBetween(fwd, target) 求全姿态夹角再绕 cross(fwd,target) 转——
    // 机头因偏航偏离气流方向时，这个夹角把「侧滑」也当成了误差，伺服会以
    // pitchRate(1.45rad/s) 把偏航一起「修正」回去，比 yawRate(0.55rad/s) 快 2.6 倍。
    // 实测（shots/axis-bench.js）：200m/s 满杆右偏 3 秒只转 4.1°（理论 94°），
    // 鼠标左右的机头偏转被整个吃掉，表现为「左右移不了」。已改回纯迎角伺服。
    if (speed0 > 8) {
      const aoaErr = aoaCmd - aoa;                 // >0 = 迎角不足，机头需上抬
      if (Math.abs(aoaErr) > 1e-4) {
        let axisT = V.cross(vdir, up);
        if (V.len(axisT) < 1e-5) axisT = V.copy(right);
        axisT = V.norm(axisT);
        // 绕 cross(vdir,up) 正转 = 机头上抬 = 迎角增大（与 aoaErr 同号，直接同向转）
        const step = Math.min(Math.abs(aoaErr),
          Math.max(C.pitchRate * eff, Math.abs(aoaErr) * C.pitchServo) * dt);
        a.quat = Q.norm(Q.mul(Q.fromAxisAngle(axisT, (aoaErr > 0 ? 1 : -1) * step), a.quat));
      }
    }

    a.speed = V.len(v);
    a.gLoad = V.len(accAero) / W.gravity;
    a.aoa = aoa;
    a.stalled = stalled;
    a.airborne = true;
    a.onGround = false;

    // ---- 与地面/海面的接触判定 ----
    const gh = terrainHeight(a.pos.x, a.pos.z);
    const water = gh < 0;
    // 航母甲板：海面上的一块"人工地面"。甲板面高 cv.y，
    // 在甲板范围内把接地面抬到甲板高度（否则海上会被判成坠水）。
    // 有两艘舰，必须定位到具体是哪一艘（甲板坐标系不同）。
    const cv = carrierAt(a.pos.x, a.pos.z, 1.0);
    const onDeck = !!cv;
    const deckY = (cv ? cv.y : 0) + (a.gear ? C.gearHeight : C.gearUpHeight);
    const contactY = onDeck ? deckY : (water ? 1.05 : gh + (a.gear ? C.gearHeight : C.gearUpHeight));

    // 高速穿地保护：检查这段位移的中点
    const seg = V.dist(p0, a.pos);
    if (seg > 25 && !water) {
      const mx = (p0.x + a.pos.x) * 0.5, my = (p0.y + a.pos.y) * 0.5, mz = (p0.z + a.pos.z) * 0.5;
      const mgh = terrainHeight(mx, mz);
      if (mgh >= 0 && my <= mgh + 2.0) {
        a.pos = { x: mx, y: mgh + 1.5, z: mz };
        crashAircraft(a, events, 'terrain');
        return;
      }
    }

    // 接地判定：必须“在下降”，且低于接地面。
    // 只加 <=contactY 会在刚离地那一帧又把飞机按回地面，来回一次就是“起飞/落地跳动”。
    if (a.pos.y <= contactY && a.vel.y <= 0.15) {
      // 撞山（机身在坡面里）而不是“落地”，按坠毁处理
      if (!water && !onDeck && a.pos.y < gh + 0.85) {
        a.pos.y = gh + 1.2;
        crashAircraft(a, events, 'terrain');
        return;
      }
      a.pos.y = contactY;
      if (water && !onDeck) { crashAircraft(a, events, 'water'); return; }

      const ypr = yprFromQuat(a.quat);
      const sink = Math.max(0, -a.vel.y);
      const hs = Math.hypot(a.vel.x, a.vel.z);
      const okGear = a.gear;
      const okAtt = Math.abs(ypr.roll) < C.maxBank && ypr.pitch > C.minPitch && ypr.pitch < C.maxPitch;
      const okSink = sink < C.maxSink;
      // 甲板跑道短：速度上限比陆地机场更严（真实着舰余量很小）
      const okSpeed = onDeck
        ? hs < C.maxGearSpeed * 0.92
        : hs < C.maxGearSpeed * 1.3;

      // 判定顺序：起落架 → 超速 → 姿态 → 下沉率（先报更“明确”的原因）
      if (!okGear) { crashAircraft(a, events, 'nogear'); return; }
      // 敌舰甲板不可降落：触舰即毁（不给你在敌人船上白嫖跑道的机会）
      if (onDeck && cv && cv.team !== a.team) {
        crashAircraft(a, events, 'enemydeck');
        return;
      }
      if (!okSpeed) { crashAircraft(a, events, onDeck ? 'deckfast' : 'overspeed'); return; }
      if (!okAtt) { crashAircraft(a, events, 'attitude'); return; }
      if (!okSink) { crashAircraft(a, events, 'hard'); return; }

      // 安全着陆 → 转入地面滑跑
      a.onGround = true;
      a.airborne = false;
      a.onDeck = onDeck;
      a.cvTeam = cv ? cv.team : -1;      // 记住停在哪艘舰上（牵引/弹射要用它的甲板系）
      a.gYaw = ypr.yaw;
      a.gPitch = clamp(ypr.pitch, 0, C.maxRotate);
      a.quat = quatFromYPR(a.gYaw, a.gPitch, 0);
      // 悬挂吸收：按下沉率压缩，再弹回（原来 vel.y 直接清零，看着像硬贴地）
      a.susp = clamp(sink * 0.055, 0, 0.28);
      a.vel.y = 0;
      a.gLoad = 1;
      a.tdT = 0.45;
      events.push({ k: 'touchdown', id: a.id, x: a.pos.x, y: a.pos.y, z: a.pos.z, sp: hs, sk: sink, cv: onDeck ? 1 : 0 });
      return;
    }

    // 判断是否已离地（防止贴地误判）
    if (a.pos.y > contactY + 4) { a.onGround = false; a.onDeck = false; }
  }

  // ---- 地面滑跑 / 起飞 ----
  function groundStep(a, inp, dt, events) {
    const C = a.acParams ? Object.assign({}, CONFIG.aircraft, a.acParams) : CONFIG.aircraft;
    const W = CONFIG.world;

    // ---- 航母甲板：弹射起飞 / 阻拦索 ----
    // 队各一艘舰，先定位飞机在当前点落在哪艘舰上（甲板坐标系按舰取）
    const deckCv = carrierAt(a.pos.x, a.pos.z, 1.0);
    const deckHere = !!deckCv;
    if (deckHere) {
      const cv = deckCv;
      const l = carrierLocal(a.pos.x, a.pos.z, cv);
      a.cvTeam = cv.team;             // 记录当前所在舰（快照/牵引/弹射都用它）

      // ---- 甲板牵引：着舰停稳后请求弹射，先把飞机滑回弹射位 ----
      // 真实航母上由拖车把飞机拖到弹射位，机头始终朝舰艏、飞机被"倒着拖"。
      //
      // ⚠️ 用「定速滑行」而不是「定时插值」：客户端每收到一次快照都会用权威状态重建本地
      // 状态并回滚重放，任何基于计时器的动画（taxiT）都会被重置归零，表现为飞机在
      // 起点和权威位置之间来回跳。改成定速后，进度完全由当前位置决定，重放天然连续。
      if (a.taxiActive) {
        const toAlong = cv.catZ, toLat = -13;      // 弹射位（弹射轨道左舷）
        const dAlong = toAlong - l.along, dLat = toLat - l.lat;
        const dist = Math.hypot(dAlong, dLat);
        const step = cv.taxiSpeed * dt;
        // 机头始终对准舰艏（-along 方向），与后续弹射方向一致
        const want = Math.atan2(cv.hx, cv.hz);
        const place = (along, lat) => {
          a.pos.x = cv.x + cv.hx * along + cv.rx * lat;
          a.pos.z = cv.z + cv.hz * along + cv.rz * lat;
          a.pos.y = cv.y + (a.gear ? C.gearHeight : C.gearUpHeight);
          a.gYaw = want; a.gPitch = 0;
          a.quat = quatFromYPR(a.gYaw, a.gPitch, 0);
          a.vel = { x: 0, y: 0, z: 0 };
          a.speed = 0;
          a.onGround = true; a.airborne = false;
          a.wireCaught = false; a.deckStopped = false;
          a.wirePrevAlong = along;
        };
        if (dist <= step) {
          place(toAlong, toLat);                        // 到位
          a.taxiActive = false;
          // 到位即接弹射（不需要玩家再按一次）
          if (a.catQueued) {
            a.catQueued = false;
            a.catActive = true;
            a.catT = 0;
            a.throttle = 1;
            events.push({ k: 'cat', id: a.id });
          }
        } else {
          const k = step / dist;
          place(l.along + dAlong * k, l.lat + dLat * k);
        }
        return;
      }

      // 弹射起飞：在弹射位且请求弹射 → 强力加速到离舰速度
      // （a.catActive 由 server 在玩家按弹射键时置位）
      if (a.catActive) {
        a.catT += dt;
        const v = Math.min(cv.catapultSpeed, a.catT * (cv.catapultSpeed / 2.6));
        // 沿舰艏方向（甲板轴向，-along）加速
        const dirX = -cv.hx, dirZ = -cv.hz;
        a.vel = { x: dirX * v, y: 0, z: dirZ * v };
        a.gYaw = Math.atan2(-dirX, -dirZ);
        a.pos.x += a.vel.x * dt;
        a.pos.z += a.vel.z * dt;
        a.speed = v;
        a.gPitch = Math.min(C.maxRotate, a.gPitch + dt * 0.30);   // 弹射末端自动抬头
        a.quat = quatFromYPR(a.gYaw, a.gPitch, 0);
        a.pos.y = cv.y + C.gearHeight + Math.sin(Math.max(0, a.gPitch)) * 1.35;
        a.onGround = true; a.airborne = false;
        if (v >= cv.catapultSpeed - 0.5 || a.catT > 3.2) {
          a.catActive = false;
          a.catT = 0;
          a.onGround = false; a.airborne = true;
          a.vel.y = 2.4;                                  // 离舰瞬间的轻微上抛
          events.push({ k: 'launch', id: a.id, cv: 1, ct: cv.team });
        }
        return;
      }

      // 阻拦索：接地滑跑中，越过任一根索的横向平面 → 钩住，急速减速并停住
      // deckStopped 后不再重复探测（否则停稳瞬间还会再"钩"一次）
      if (!a.wireCaught && !a.deckStopped && a.speed > 12) {
        const along = l.along;
        for (let i = 0; i < cv.wireZ.length; i++) {
          const wz = cv.wireZ[i];
          if (a.wirePrevAlong !== undefined && a.wirePrevAlong > wz && along <= wz) {
            // 调试开关：服务端用 SKY_WIRE_DEBUG=1 打开；浏览器端没有 process，必须做存在性判断
            if (typeof process !== 'undefined' && process.env && process.env.SKY_WIRE_DEBUG === '1') {
              console.log('[wire] 跨过索' + (i + 1) + ' along=' + along.toFixed(1) +
                ' prev=' + a.wirePrevAlong.toFixed(1) + ' lat=' + l.lat.toFixed(1) +
                ' spd=' + a.speed.toFixed(1) + ' 宽限=' + (cv.wid * 0.30).toFixed(1));
            }
            // 只有落在斜角甲板跑道宽度内才算钩上（否则是逃逸复飞区）
            if (Math.abs(l.lat) < cv.wid * 0.30) {
              a.wireCaught = true;
              a.wireIdx = i;
              a.wireDecel = 0;
              events.push({ k: 'wire', id: a.id, i, sp: Math.round(a.speed), ct: cv.team });
            }
            break;
          }
        }
      }
      if (a.wireCaught) {
        // 阻拦索：3 根索的制动力逐根递增（第 1 根最软），末速归零
        const decel = 62 + a.wireIdx * 12;
        const sp = Math.hypot(a.vel.x, a.vel.z);
        const ns = Math.max(0, sp - decel * dt);
        if (sp > 0.01) {
          const k = ns / sp;
          a.vel.x *= k; a.vel.z *= k;
        } else {
          a.vel.x = 0; a.vel.z = 0;
        }
        a.speed = ns;
        a.pos.x += a.vel.x * dt;
        a.pos.z += a.vel.z * dt;
        a.pos.y = cv.y + C.gearHeight - (a.susp || 0);
        a.susp = Math.max(0, (a.susp || 0) * Math.exp(-dt * 7) - dt * 0.02);
        a.onGround = true; a.airborne = false; a.gLoad = 1;
        a.aoa = a.gPitch; a.stalled = false;
        a.wirePrevAlong = carrierLocal(a.pos.x, a.pos.z, cv).along;
        if (ns < 0.5) {
          // 完全停住 → 视为着舰成功，进入甲板停机状态
          a.vel.x = 0; a.vel.z = 0;
          a.wireCaught = false;
          a.deckStopped = true;
          // 保留索号（wireIdx 不清），HUD/播报要显示"钩住第 N 根"
          a.lastWireIdx = a.wireIdx;
        }
        return;
      }
      a.wirePrevAlong = l.along;
    } else {
      a.wirePrevAlong = undefined;
      a.wireCaught = false;
    }

    // 姿态：只允许抬头（抬轮），不允许坡度
    const sp0 = Math.hypot(a.vel.x, a.vel.z);
    a.gPitch = clamp(a.gPitch + inp.pitch * C.rotateRate * dt * clamp(sp0 / 60, 0.25, 1), -0.03, C.maxRotate);
    const steerAuth = clamp(sp0 / 30, 0, 1);
    a.gYaw -= (inp.rudder * 0.9 + inp.yaw * 0.22) * C.steerRate * steerAuth * dt;

    a.quat = quatFromYPR(a.gYaw, a.gPitch, 0);
    const fwd = Q.rotate(a.quat, AXIS_FWD);
    const fwdH = V.norm({ x: fwd.x, y: 0, z: fwd.z });

    const rho = rhoAt(a.pos.y);
    let speed = sp0;
    const q = 0.5 * rho * speed * speed;
    const cl = clOf(clamp(a.gPitch, -0.2, 0.4));
    const lift = q * C.wingArea * cl;
    const drag = q * C.wingArea * (C.cd0 + C.gearCd + (inp.brake ? C.brakeCd : 0));
    const normal = Math.max(0, C.mass * W.gravity - lift);
    const friction = normal * C.rollFriction;
    const thrust = C.maxThrust * a.throttle * clamp(1 - C.thrustAltFalloff * Math.max(0, a.pos.y) / 12000, 0.35, 1)
      * clamp(1 - 0.25 * clamp(speed / C.refSpeed, 0, 1.4), 0.4, 1);

    let accel = (thrust - drag - friction) / C.mass;
    if (inp.brake) accel -= C.brakeDecel;
    speed = Math.max(0, speed + accel * dt);

    a.vel = { x: fwdH.x * speed, y: 0, z: fwdH.z * speed };
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;
    const gh = terrainHeight(a.pos.x, a.pos.z);
    const deckNow = carrierAt(a.pos.x, a.pos.z, 1.0);
    if (gh < 0 && !deckNow) { crashAircraft(a, events, 'water'); return; }
    // 悬挂回弹：压缩量指数回收，接地瞬间有一小下“沉—弹”
    if (a.susp > 0) a.susp = Math.max(0, a.susp * Math.exp(-dt * 7) - dt * 0.02);
    // 抬轮时绕主轮支点转动，机身重心会微微抬高；不加这一项尾撑会插进跑道
    const groundY = deckNow ? deckNow.y : gh;
    a.pos.y = groundY + C.gearHeight + Math.sin(Math.max(0, a.gPitch)) * 1.35 - (a.susp || 0);
    a.onDeck = !!deckNow;
    a.cvTeam = deckNow ? deckNow.team : -1;
    a.speed = speed;
    a.gLoad = 1;
    a.aoa = a.gPitch;
    a.stalled = false;
    a.onGround = true;
    a.airborne = false;
    a.tdT = Math.max(0, (a.tdT || 0) - dt);

    // 抬轮起飞判定：升力 + 推力垂直分量 超过重力
    // 注意：离地必须“自然接续”——不额外抬高度、不硬塞上升速度，
    // 否则每次起飞都像被弹射器弹了一下（原来的 +2m / +3m/s 就是“起飞很假”的来源）。
    const need = C.mass * W.gravity;
    const vertF = lift * Math.cos(a.gPitch) + thrust * Math.sin(a.gPitch);
    if (!(a.tdT > 0) && speed > C.takeoffSpeed && a.gPitch > 0.03 && vertF > need) {
      a.onGround = false;
      a.airborne = true;
      a.vel = { x: fwdH.x * speed, y: 0.55, z: fwdH.z * speed };
      a.pos.y = gh + C.gearHeight + Math.sin(Math.max(0, a.gPitch)) * 1.35 + 0.02;
      a.susp = 0;
      events.push({ k: 'takeoff', id: a.id });
    }
  }

  // ---- 边界 ----
  function applyBounds(a, dt) {
    const W = CONFIG.world;
    const lim = W.half - W.softMargin;
    const ox = Math.abs(a.pos.x) - lim;
    const oz = Math.abs(a.pos.z) - lim;
    const out = Math.max(ox, oz);
    if (out > 0) {
      a.out = (a.out || 0) + dt;
      // 柔和引导：只把“水平航向”慢慢转向地图中心，不做减速。
      // （直接反向加速会把玩家推到失速速度以下，反而造成坠机）
      const hs = Math.hypot(a.vel.x, a.vel.z);
      if (hs > 25) {
        const il = Math.hypot(a.pos.x, a.pos.z) || 1;
        const cur = Math.atan2(a.vel.z, a.vel.x);
        const want = Math.atan2(-a.pos.z / il, -a.pos.x / il);
        let d = want - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const maxStep = clamp(out / 400, 0, 1) * W.turnAssist * dt;
        const na = cur + clamp(d, -maxStep, maxStep);
        a.vel.x = Math.cos(na) * hs;
        a.vel.z = Math.sin(na) * hs;
      }
    } else {
      a.out = 0;
    }
    return (Math.abs(a.pos.x) > W.half + W.hardMargin || Math.abs(a.pos.z) > W.half + W.hardMargin || a.out > W.lostTime);
  }

  // ===========================================================================
  // === 主步进 ================================================================
  // ===========================================================================
  function stepAircraft(a, input, dt, events) {
    if (!a) return;
    const evts = events || [];
    if (!(dt > 0)) return;
    const C = a.acParams ? Object.assign({}, CONFIG.aircraft, a.acParams) : CONFIG.aircraft;
    const inp = normalizeInput(input);

    a.missileCd = Math.max(0, (a.missileCd || 0) - dt);
    a.flareCd = Math.max(0, (a.flareCd || 0) - dt);

    // 残骸：自由落体 + 地面截断
    if (a.wreck) {
      a.throttle = 0;
      a.vel.y -= CONFIG.world.gravity * dt;
      a.vel = V.mul(a.vel, Math.max(0, 1 - 0.4 * dt));
      a.pos = V.add(a.pos, V.mul(a.vel, dt));
      const gh = terrainHeight(a.pos.x, a.pos.z);
      const floor = (gh < 0 ? 0 : gh) + 2;
      if (a.pos.y < floor) {
        a.pos.y = floor;
        a.vel = { x: 0, y: 0, z: 0 };
      }
      a.speed = V.len(a.vel);
      spinWreck(a, dt);
      return;
    }

    const dead = !a.alive;
    const use = dead ? EMPTY_INPUT : inp;
    if (dead) {
      a.throttle = Math.max(0, a.throttle - dt);
    } else {
      // 地面滑跑时不允许收轮（避免“趴在地上飞”的诡异状态），离地后才响应 G
      a.gear = a.onGround ? true : inp.gear;
      a.ab = a.onGround ? false : !!inp.ab;      // 地面上减速板无意义，自动收起
      if (inp.throttleSet >= 0) a.throttle = inp.throttleSet;
      else a.throttle = clamp(a.throttle + inp.throttleAxis * C.throttleRate * dt, 0, 1);
    }

    if (a.onGround) groundStep(a, use, dt, evts);
    else airStep(a, use, dt, evts);

    if (applyBounds(a, dt)) crashAircraft(a, evts, 'lost');

    if (a.pos.y > CONFIG.world.ceil) {
      a.pos.y = CONFIG.world.ceil;
      if (a.vel.y > 0) a.vel.y = 0;
    }
  }

  // 两向量夹角（rad）
  function angleBetween(a, b) {
    const d = V.dot(V.norm(a), V.norm(b));
    return Math.acos(clamp(d, -1, 1));
  }

  // 机场归属
  function teamAirport(team) { return AIRPORTS[team] || AIRPORTS[0]; }

  return {
    CONFIG, AIRPORTS, V, Q, CARRIER, CARRIERS,
    clamp, lerp, smoothstep, angleBetween,
    terrainHeight, terrainRaw, isWater, rhoAt,
    airportLocal, onAirport, onRunway, runwayHeading,
    carrierLocal, onCarrierDeck, carrierAt,
    AC_TYPES, dropTorpedo, dropBomb,
    quatFromYPR, yprFromQuat,
    spawnTransform, teamAirport,
    createAircraft, resetAircraft, cloneState,
    normalizeInput, EMPTY_INPUT,
    stepAircraft, clOf
  };
});
