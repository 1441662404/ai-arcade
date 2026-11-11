/**
 * 車輛物理：模仿《極品飛車：地下狂飆 / 最高通緝》時代的手感
 *
 * 設計原則（NFS 風）：
 *  1. 轉向零延遲 —— 打方向當幀就有橫向力，不靠人為限制轉角把車閹軟
 *  2. 後輪抓地是一個「可開可關的模式」（rearGrip 狀態量），不是被動等打滑
 *  3. 車頭有對齊速度方向的輔助力矩 —— 所以反打一定救得回來
 *  4. 前輪永遠全抓地 —— 車頭指哪打哪，可控性的基礎
 *  5. 固定步長 1/120 由外層累加器保證
 */
import { ROAD, clamp } from './trackPath.js';

export const CAR_SPECS = {
  fr86: {
    id: 'fr86', name: 'FR-86', team: '夜風', model: 'assets/cars/fr86.glb',
    mass: 940, drive: 'FR', wheelbase: 2.40, track: 1.35, cg: 0.52,
    peakTorque: 152, redline: 8200, idle: 900, gears: [3.20, 2.05, 1.44, 1.08, 0.86], final: 4.30,
    grip: 0.98, steerLock: 0.62, power: 130, color: 0xe8e8e6, accent: 0x1a1a1a,
    weight: 0.34, bodyLength: 4.20, wheelRadius: 0.30, brake: 9800, downforce: 0.4,
  },
  fc: {
    id: 'fc', name: 'RX-7 FC3S', team: '高橋涼介', model: 'assets/cars/fc.glb',
    modelRot: [0, -Math.PI / 2, 0],
    mass: 1230, drive: 'FR', wheelbase: 2.43, track: 1.44, cg: 0.50,
    peakTorque: 265, redline: 7600, idle: 900, gears: [3.48, 2.02, 1.39, 1.00, 0.79], final: 4.10,
    grip: 1.02, steerLock: 0.60, power: 205, color: 0xf2f2ef, accent: 0x1b2a4a,
    weight: 0.30, bodyLength: 4.30, wheelRadius: 0.31, brake: 11000, downforce: 0.6,
  },
  fd: {
    id: 'fd', name: 'RX-7 FD3S', team: '高橋啓介', model: 'assets/cars/fd.glb',
    mass: 1270, drive: 'FR', wheelbase: 2.43, track: 1.46, cg: 0.47,
    peakTorque: 320, redline: 8200, idle: 900, gears: [3.60, 2.13, 1.46, 1.09, 0.82, 0.68], final: 4.10,
    grip: 1.08, steerLock: 0.58, power: 280, color: 0xf5f5f2, accent: 0x14213d,
    weight: 0.31, bodyLength: 4.28, wheelRadius: 0.32, brake: 12500, downforce: 1.1,
  },
  r32: {
    id: 'r32', name: 'SKYLINE R32', team: '中里毅', model: 'assets/cars/r32.glb',
    mass: 1430, drive: 'AWD', wheelbase: 2.61, track: 1.48, cg: 0.54,
    peakTorque: 360, redline: 8000, idle: 900, gears: [3.83, 2.36, 1.69, 1.31, 1.00, 0.79], final: 3.55,
    grip: 1.12, steerLock: 0.56, power: 280, color: 0x2b2f36, accent: 0x9aa0a6,
    weight: 0.28, bodyLength: 4.55, wheelRadius: 0.32, brake: 13500, downforce: 1.4,
  },
  r33: {
    id: 'r33', name: 'SKYLINE R33', team: 'GT-R', model: 'assets/cars/r33.glb',
    mass: 1540, drive: 'AWD', wheelbase: 2.72, track: 1.48, cg: 0.55,
    peakTorque: 392, redline: 8000, idle: 900, gears: [3.83, 2.36, 1.69, 1.31, 1.00, 0.79], final: 3.55,
    grip: 1.10, steerLock: 0.55, power: 280, color: 0x1e2733, accent: 0xc0c4c8,
    weight: 0.30, bodyLength: 4.68, wheelRadius: 0.33, brake: 14000, downforce: 1.5,
  },
  altezza: {
    id: 'altezza', name: 'ALTEZZA RS200', team: '秋山', model: 'assets/cars/altezza.glb',
    mass: 1340, drive: 'FR', wheelbase: 2.67, track: 1.46, cg: 0.53,
    peakTorque: 216, redline: 7600, idle: 900, gears: [3.87, 2.19, 1.54, 1.19, 1.00, 0.82], final: 3.90,
    grip: 1.03, steerLock: 0.60, power: 210, color: 0xd8d9d4, accent: 0x2a2a2a,
    weight: 0.32, bodyLength: 4.40, wheelRadius: 0.32, brake: 11800, downforce: 0.7,
  },
};

const G = 9.81;

/* 引擎扭矩曲線（正規化 0~1） */
function torqueCurve(t, turbo) {
  // t: rpm 比例
  if (turbo) {
    const spool = clamp((t - 0.22) / 0.28, 0, 1);
    const shape = 0.55 + 0.45 * Math.sin(clamp((t - 0.15) / 0.8, 0, 1) * Math.PI * 0.92);
    return shape * (0.42 + 0.58 * spool) * (t > 0.94 ? 1 - (t - 0.94) * 1.6 : 1);
  }
  const shape = 0.52 + 0.48 * Math.sin(clamp((t - 0.08) / 0.86, 0, 1) * Math.PI * 0.95);
  return shape * (t > 0.95 ? 1 - (t - 0.95) * 1.4 : 1);
}

export class Vehicle {
  constructor(spec) {
    this.spec = spec;
    this.turbo = spec.id === 'fd' || spec.id === 'r32' || spec.id === 'r33' || spec.id === 'fc';

    // 狀態
    this.x = 0; this.z = 0; this.y = 0;
    this.heading = 0;
    this.u = 0;   // 前向速度
    this.v = 0;   // 左向速度
    this.yaw = 0; // 偏航角速度
    this.steer = 0;       // 實際前輪角（正 = 向左）
    this.steerInput = 0;
    this.gear = 1;
    this.rpm = spec.idle;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.shiftTimer = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.slip = [0, 0, 0, 0];
    this.load = [0, 0, 0, 0];
    this.slipAngle = 0;
    this.driftAngle = 0;
    this.isDrifting = false;
    this.driftTime = 0;
    this.driftScore = 0;
    this.driftCombo = 1;
    this.wallHit = 0;
    this.lastWallSide = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.trackIndex = 0;
    this.airborne = false;
    this.odometer = 0;
    this.rollAngle = 0;
    this.pitchAngle = 0;
    this.steerWheel = 0;
    this.rearSlip = 0;

    // 幾何
    const L = spec.wheelbase;
    this.axleF = L / 2;
    this.axleR = -L / 2;
    this.halfTrack = spec.track / 2;
    // 橫擺慣量：用真實的 I_z ≈ m·a·b（a、b 為質心到前後軸距離）。
    // 舊版係數 0.55 讓慣量只有真車一半，車身一碰就轉、滑移角壓不住。
    const aDist = L * spec.cg;
    const bDist = L * (1 - spec.cg);
    this.inertia = spec.mass * aDist * bDist;

    // 驅動分配
    this.driveFront = spec.drive === 'AWD' ? 0.32 : spec.drive === 'FWD' ? 1 : 0;
    this.driveRear = 1 - this.driveFront;
    // 渦輪遲滯狀態
    this.turboLag = 0;
    // 後輪抓地狀態量（1 = 完全抓地，0 = 完全打滑）。漂移是一個能開能關的模式。
    this.rearGrip = 1;
    // 倒車相關
    this._revHold = 0;
    // 檔位：-1 = R，1..N = 前進檔
    this.gear = 1;
  }

  reset(x, z, y, heading, trackIndex = 0) {
    this.x = x; this.z = z; this.y = y;
    this.heading = heading;
    this.u = 0; this.v = 0; this.yaw = 0;
    this.steer = 0; this.steerInput = 0;
    this.gear = 1; this.rpm = this.spec.idle;
    this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.driftScore = 0; this.driftCombo = 1; this.driftTime = 0;
    this.trackIndex = trackIndex;
    this.odometer = 0;
    this.rearGrip = 1;
    this._revHold = 0;
  }

  get speedKmh() { return Math.hypot(this.u, this.v) * 3.6; }
  get speedMs() { return Math.hypot(this.u, this.v); }

  /**
   * @param {number} dt 固定步長
   * @param {object} input { throttle, brake, steer(-1..1 正=左), handbrake }
   * @param {object} track 賽道
   */
  step(dt, input, track) {
    const sp = this.spec;
    const mass = sp.mass;
    const speed = Math.hypot(this.u, this.v);

    /* ================= 倒車檔 ================= */
    // 靜止時按煞車 → 掛 R 檔；前進中按煞車只是減速。
    // 放開煞車超過 1.1 秒、或踩了油門 → 自動回前進檔，避免一倒不停。
    const movingFwd = this.u > 1.2;
    if (input.brake > 0.5 && !movingFwd) {
      if (this.gear !== -1) { this.gear = -1; this.rpm = Math.max(this.rpm, sp.idle + 1600); this._revHold = 0; }
    }
    if (this.gear === -1) {
      if (input.brake < 0.2) this._revHold = (this._revHold || 0) + dt;
      else this._revHold = 0;
      // 倒退已有速度又踩油門 → 回前進檔（準備向前衝）
      if (this._revHold > 1.1 || (input.throttle > 0.3 && this.u < -0.5)) { this.gear = 1; this._revHold = 0; }
    }
    const reversing = this.gear === -1;

    /* ================= 轉向（NFS：零延遲） ================= */
    // 極速快感的方向盤是「打下去當幀就有反應」。但「反應快」≠「給滿舵」：
    // 舵角上限必須隨速度收，讓前輪滑移角穩在輪胎曲線峰值附近。
    // 給滿舵只會把前輪推過峰值、側向力反而下降 —— 那就是推頭＋黏滯。
    const steerInput = clamp(input.steer, -1, 1);
    // 兩級濾波串起來就是「轉向延遲」。34/26 加起來約 67ms 才到 63%，
    // 打方向會有明顯的黏手感，所以兩級都拉快。
    this.steerInput += (steerInput - this.steerInput) * clamp(dt * 46, 0, 1);
    // 轉角上限必須讓前輪滑移角落在峰值附近（B=9.6 → 峰值約 8.6°）。
    // 給太多轉角只會讓前輪衝過峰值、側向力反而下降 —— 那就是「推頭＋黏」。
    // 實測：80km/h 給到 26° 時前輪滑到 -39°，側向力只剩峰值的 74%，車就是在犁地。
    // 目標舵角：40km/h ≈ 21°、80km/h ≈ 9°、120km/h ≈ 5°（極限過彎剛好把前輪擺在峰值附近）
    const speedFalloff = 1 / (1 + Math.pow(speed / 13, 1.9));
    // 甩起來時放寬，反打才打得進去（但要有上限，否則滑越大→舵越多→更滑的正回授）
    const drifty = clamp(Math.abs(this.driftAngle) / 0.40, 0, 1);
    // 漂移中 yaw 與 driftAngle 反號，所以「反打」= 舵向與 driftAngle 同號。
    // 救車那一下要多給舵量，順著甩的方向則收著點，免得越打越開。
    const counter = this.steerInput * this.driftAngle > 0.02;
    const maxSteer = Math.min(
      sp.steerLock * 0.78,
      sp.steerLock * Math.max(0.20, speedFalloff) * (1 + drifty * (counter ? 0.95 : 0.40))
    );
    const targetSteer = this.steerInput * maxSteer;
    this.steer += (targetSteer - this.steer) * clamp(dt * 36, 0, 1);
    this.steer = clamp(this.steer, -maxSteer, maxSteer);

    /* ================= 踏板（倒車時互換） ================= */
    const pedalIn = reversing ? input.brake : input.throttle;
    const pedalOut = reversing ? input.throttle : input.brake;
    this.throttle += (pedalIn - this.throttle) * clamp(dt * 20, 0, 1);
    this.brake += (pedalOut - this.brake) * clamp(dt * 22, 0, 1);
    this.handbrake += (input.handbrake - this.handbrake) * clamp(dt * 30, 0, 1);

    /* ================= 變速箱 ================= */
    this.updateGearbox(dt, speed);

    /* ================= 引擎 ================= */
    const tNorm = clamp((this.rpm - sp.idle) / (sp.redline - sp.idle), 0, 1);
    const boostTarget = this.turbo ? clamp((this.rpm - sp.idle * 1.6) / (sp.redline * 0.45), 0, 1) : 1;
    const lagRate = this.throttle > 0.15 ? (this.turbo ? 3.4 : 30) : 6.5;
    this.turboLag += (boostTarget - this.turboLag) * clamp(dt * lagRate, 0, 1);
    let engineTorque = sp.peakTorque * torqueCurve(tNorm, this.turbo) * (0.42 + 0.58 * this.turboLag);
    if (this.shiftTimer > 0) engineTorque *= 0.05;
    const gearIdx = reversing ? 0 : clamp(this.gear - 1, 0, sp.gears.length - 1);
    const gearRatio = sp.gears[gearIdx] * sp.final * (reversing ? 1.05 : 1);
    const wheelR = sp.wheelRadius;
    // 倒車檔的驅動力必須反向，否則會掛著 R 往前飙
    const dirSign = reversing ? -1 : 1;
    let driveForceMax = (engineTorque * gearRatio * 0.92) / wheelR * this.throttle * dirSign;
    if (reversing) driveForceMax = Math.max(driveForceMax, -2600);

    // 阻力與滾阻一律沿「當前運動方向」，倒車時同樣成立
    const drag = 0.5 * 1.2 * 0.34 * 2.1 * this.u * Math.abs(this.u);
    const roll = 0.014 * mass * G * Math.sign(this.u || 1);

    /* ========== 後輪抓地狀態（漂移的核心） ========== */
    // 不靠「滑移角大了自動掉 μ」這種被動機制 —— 那只會讓車在不知不覺中失控。
    // 改成顯式狀態量：手剎／大油門壓下去，收油／回正時平滑回升。
    // 玩家因此有一個「能開能關的漂移開關」，而不是被車擺佈。
    const slipMagNow = Math.abs(this.driftAngle);
    let wantGrip = 1;
    // 手剎：抓地直接掉到 8%
    if (this.handbrake > 0.05) wantGrip = 1 - 0.92 * this.handbrake;
    // 油門過度轉向：油門越深、轉速越高，後輪越滑。
    // 係數不能太大 —— 全油門就掉到 0.40 會讓車在直線上也飄，變成「糊」而不是「滑」。
    // 直線全油門不該自己飄：只有在「有轉向需求」或「已經在滑」時才讓後輪鬆。
    // 少了這個閘門，全油門後輪恆定抓地 0.58，直線加速會覺得車尾浮浮的。
    // 門檻 0.42 太低：半油門過彎後輪就掉到 0.58，穩態側向 G 只剩 0.58g。
    // 動力滑胎要「踩到底」才發生，半油門過彎必須是穩穩咬住的。
    const demand = clamp(Math.abs(this.steer) * 1.5 + slipMagNow * 1.4, 0, 1);
    const powerSlide = clamp((this.throttle - 0.72) / 0.28, 0, 1) * clamp(tNorm * 1.35 - 0.25, 0, 1) * demand;
    if (powerSlide > 0) wantGrip = Math.min(wantGrip, 1 - powerSlide * 0.42);
    // 已經甩起來 → 維持在「半滑」狀態，讓玩家用油門深淺控制角度
    // 門檻 0.35 太低：一般過彎油門 0.5~0.6 也會被判成「維持漂移」，後輪直接掉到 0.56。
    if (slipMagNow > 0.26 && this.throttle > 0.60) wantGrip = Math.min(wantGrip, 0.34 + (1 - this.throttle) * 0.5);
    // 下降快、回升慢：甩出去乾脆，收回來有過程 —— 這個過程就是漂移手感
    const gripRate = wantGrip < this.rearGrip ? 18 : 4.6;
    this.rearGrip += (wantGrip - this.rearGrip) * clamp(dt * gripRate, 0, 1);

    /* ================= 各輪 ================= */
    const cosH = Math.cos(this.heading), sinH = Math.sin(this.heading);
    const e1x = cosH, e1z = -sinH;   // 左
    const e2x = sinH, e2z = cosH;    // 前

    const wheels = [
      { dx: this.halfTrack, dz: this.axleF, steer: this.steer, drive: this.driveFront, brake: 0.62, front: true },
      { dx: -this.halfTrack, dz: this.axleF, steer: this.steer, drive: this.driveFront, brake: 0.62, front: true },
      { dx: this.halfTrack, dz: this.axleR, steer: 0, drive: this.driveRear, brake: 0.38, front: false },
      { dx: -this.halfTrack, dz: this.axleR, steer: 0, drive: this.driveRear, brake: 0.38, front: false },
    ];

    const L = sp.wheelbase;
    const staticFront = mass * G * (0.5 + (sp.cg - 0.5) * 0.8);
    const staticRear = mass * G - staticFront;
    const transferLong = (mass * this.accelLong * sp.cg) / L;
    const transferLat = (mass * this.accelLat * sp.cg) / (sp.track * 2);
    const fzFront = clamp(staticFront - transferLong, mass * G * 0.12, mass * G * 0.9);
    const fzRear = clamp(staticRear + transferLong, mass * G * 0.12, mass * G * 0.9);

    let Fx = 0, Fz = 0, torque = 0;
    let rearSlipAvg = 0;

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      let fz = w.front ? fzFront / 2 : fzRear / 2;
      const latSign = w.dx > 0 ? 1 : -1;
      fz -= latSign * transferLat;
      fz = clamp(fz, 200, mass * G * 0.75);
      this.load[i] = fz;

      const vxw = this.u * e2x + this.v * e1x + this.yaw * (e1x * w.dz - e2x * w.dx);
      const vzw = this.u * e2z + this.v * e1z + this.yaw * (e1z * w.dz - e2z * w.dx);
      const lx = vxw * e1x + vzw * e1z;
      const lz = vxw * e2x + vzw * e2z;

      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const long = lz * cs + lx * sn;
      const lat = lx * cs - lz * sn;

      // 輪胎鬆弛：側向力要滾過一段距離才建立（NFS「重量感」的來源）
      const alphaRaw = Math.atan2(lat, Math.abs(long) + 0.45);
      const relax = clamp(dt * (9 + Math.abs(long) * 5.5), 0, 1);
      this.slip[i] += (alphaRaw - this.slip[i]) * relax;
      const alpha = this.slip[i];

      // ---- 側向摩擦 ----
      // 前輪永遠全抓地（車頭指哪打哪 = NFS 可控性的基礎）；
      // 後輪乘 rearGrip 狀態量。
      let mu = sp.grip * (1 - 0.00004 * (fz - (mass * G) / 4));
      if (!w.front) {
        mu *= 1.04 * this.rearGrip;
        rearSlipAvg += Math.abs(alpha) * 0.25;
      } else {
        const degF = Math.abs(alpha) * 57.3;
        if (degF > 16) mu *= 1 - clamp((degF - 16) / 60, 0, 1) * 0.25;
      }
      // B 越大 → 峰值滑移角越小 → 打方向立刻有力。
      // 7.6 的峰值在 13°，前輪要滑半個世紀才建立側向力，轉向就是「糊」的。
      const B = 9.6, C = 1.62;
      const maxF = mu * fz;

      // ---- 縱向力 ----
      let Fxw = 0;
      if (w.drive > 0) Fxw += driveForceMax * w.drive;
      const brakeForce = this.brake * sp.brake * w.brake * (this.u > 0 ? 1 : -1);
      Fxw -= brakeForce;
      if (!w.front && this.handbrake > 0.05) {
        Fxw -= this.handbrake * sp.brake * 0.30 * Math.sign(this.u || 1);
      }
      const slipRatio = clamp(Math.abs(Fxw) / (maxF + 1), 0, 1);

      // ---- 側向力 ----
      const Fy = -maxF * Math.sin(C * Math.atan(B * alpha));
      const lowSpeed = clamp((Math.abs(long) - 0.25) / 1.6, 0, 1);
      let FyF = Fy * lowSpeed;

      // ---- 摩擦橢圓 ----
      const satX = clamp((slipRatio - 0.78) / 0.22, 0, 1);
      FyF *= 1 - satX * 0.30;
      const useY = clamp(Math.abs(FyF) / (maxF + 1), 0, 1);
      const totalSq = slipRatio * slipRatio + useY * useY;
      if (totalSq > 1) {
        const k = 1 / Math.sqrt(totalSq);
        Fxw *= k;
        FyF *= k;
      }

      const fwx = e2x * cs + e1x * sn;
      const fwz = e2z * cs + e1z * sn;
      const lwx = e1x * cs - e2x * sn;
      const lwz = e1z * cs - e2z * sn;
      const Fwx = fwx * Fxw + lwx * FyF;
      const Fwz = fwz * Fxw + lwz * FyF;

      Fx += Fwx;
      Fz += Fwz;

      const rx = e1x * w.dx + e2x * w.dz;
      const rz = e1z * w.dx + e2z * w.dz;
      torque += rz * Fwx - rx * Fwz;

      const locked = !w.front && this.handbrake > 0.5;
      this.wheelSpin[i] += locked ? 0 : (long / wheelR) * dt;
      if (w.drive > 0 && slipRatio > 0.9 && this.throttle > 0.5) {
        this.wheelSpin[i] += (this.throttle * 9 * slipRatio) * dt;
      }
    }

    this.rearSlip = rearSlipAvg;

    const resist = -(drag + roll) * (this.u >= 0 ? 1 : -1);
    Fx += e2x * resist;
    Fz += e2z * resist;

    const ax = Fx / mass;
    const az = Fz / mass;
    this.accelLong = ax * e2x + az * e2z;
    this.accelLat = ax * e1x + az * e1z;

    let vx = this.u * e2x + this.v * e1x;
    let vz = this.u * e2z + this.v * e1z;
    vx += ax * dt;
    vz += az * dt;

    /* ============ 偏航（NFS 的「磁性」手感） ============ */
    // 三個分量疊加：
    //  1) 輪胎力矩（物理）
    //  2) 車頭對齊速度方向 —— NFS 最重要的輔助。但它只在「玩家沒有在主動反打」時
    //     強力介入：一旦玩家反打，輔助立刻減弱，把控制權還給玩家。
    //     沒有這個開關，漂移會被無形的手不停拉直，玩家會覺得「車不聽我的」。
    //  3) 適量阻尼（高速才需要，低速要能原地甩）
    const velHead = Math.atan2(vx, vz);
    let align = velHead - this.heading;
    while (align > Math.PI) align -= Math.PI * 2;
    while (align < -Math.PI) align += Math.PI * 2;
    // 玩家反打中 = 前輪轉向與偏航方向相反
    const counterSteering = this.steer * this.yaw < -0.02;
    // 2.4 太強了：它會不停把車頭拉回速度方向，車像被磁鐵吸在軌道上，
    // 打方向要先「克服」這股力 —— 這就是黏滯感的來源。降到 1.5。
    let alignK = clamp(speed / 13, 0, 1) * 1.5;
    if (this.rearGrip < 0.9) alignK *= counterSteering ? 0.25 : 1.0;
    const alignTorque = align * alignK;

    const slipMag = Math.abs(this.driftAngle);
    // 輪胎本身已經提供約 4 rad/s² 每 rad/s 的自然偏航阻尼（滑移角隨 ω 變化）。
    // 再疊 5.0 的人工阻尼等於把車泡在糖漿裡。降到 1.5→0.55，只補一點點收斂。
    let dampK = 1.5 - clamp(speed / 45, 0, 1) * 0.95;   // 1.5 → 0.55
    if (this.rearGrip < 0.9) dampK *= 0.5;              // 甩起來時放開
    let yawDamp = -dampK * this.yaw;
    // 只有甩過頭（>55°）才強行收斂
    if (slipMag > 0.96) yawDamp -= Math.sign(this.yaw) * (slipMag - 0.96) * 3.0;

    this.yaw += ((torque / this.inertia) + alignTorque + yawDamp) * dt;
    this.yaw = clamp(this.yaw, -3.4, 3.4);
    this.heading += this.yaw * dt;

    // 世界速度投影回「新的」車體基底（少了這步永遠建立不起滑移角）
    const c2 = Math.cos(this.heading), s2 = Math.sin(this.heading);
    const nU = vx * s2 + vz * c2;
    const nV = vx * c2 - vz * s2;

    if (Math.abs(nU) < 0.35 && this.throttle < 0.05 && this.brake < 0.05) {
      this.u = nU * 0.85;
      this.v = nV * 0.85;
    } else {
      this.u = nU;
      this.v = nV;
    }

    this.x += vx * dt;
    this.z += vz * dt;
    this.odometer += Math.abs(this.u) * dt;

    this.driftAngle = Math.atan2(this.v, Math.abs(this.u) + 0.5);
    this.isDrifting = Math.abs(this.driftAngle) > 0.16 && speed > 9;
    this.rollAngle += (clamp(-this.accelLat * 0.010, -0.068, 0.068) - this.rollAngle) * clamp(dt * 7, 0, 1);
    this.pitchAngle += (clamp(-this.accelLong * 0.0075, -0.038, 0.038) - this.pitchAngle) * clamp(dt * 7, 0, 1);
    this.steerWheel += (this.steer * 4.2 - this.steerWheel) * clamp(dt * 10, 0, 1);
    // 護欄碰撞
    this.resolveWalls(track, dt);
  }

  updateGearbox(dt, speed) {
    const sp = this.spec;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    // R 檔：齒比同一檔、轉速由倒車速度決定，不參與自動升檔
    if (this.gear === -1) {
      const rr = (Math.abs(this.u) / (2 * Math.PI * sp.wheelRadius)) * 60 * sp.gears[0] * sp.final * 1.05;
      // 倒車起步時 u≈0 → 轉速=怠速 → 渦輪車的 turboLag 起不來、扭矩只剩 23%，
      // 倒不出去。給一個轉速地板，讓六台車的倒車力道一致。
      const rpm = clamp(Math.max(rr, sp.idle + 1600), sp.idle, sp.redline * 0.55);
      this.rpm += (rpm - this.rpm) * clamp(dt * 12, 0, 1);
      return;
    }
    const gearRatio = sp.gears[clamp(this.gear - 1, 0, sp.gears.length - 1)] * sp.final;
    const wheelRpm = (Math.abs(this.u) / (2 * Math.PI * sp.wheelRadius)) * 60 * gearRatio;
    let rpm = clamp(wheelRpm, sp.idle, sp.redline * 1.02);
    // 起步/離合器
    if (Math.abs(this.u) < 3.2) {
      rpm = Math.max(rpm, sp.idle + this.throttle * (2200 + this.gear * 260));
    }
    this.rpm += (rpm - this.rpm) * clamp(dt * 12, 0, 1);

    if (this.shiftTimer <= 0 && this.gear > 0) {
      if (this.rpm > sp.redline * 0.965 && this.gear < sp.gears.length) {
        this.gear++; this.shiftTimer = 0.13;
      } else if (this.rpm < sp.redline * 0.42 && this.gear > 1 && this.throttle < 0.5) {
        this.gear--; this.shiftTimer = 0.1;
      }
    }
    // 只有當前不在倒車檔時才允許回 1 檔（否則會把 R 踢掉）
    if (this.gear !== -1 && this.brake > 0.6 && speed < 1.5) { this.gear = 1; }
  }

  resolveWalls(track, dt) {
    const S = track.samples;
    const hint = this.trackIndex || 0;
    let best = hint, bd = Infinity;
    const from = Math.max(0, hint - 120), to = Math.min(S.length - 1, hint + 120);
    for (let i = from; i <= to; i++) {
      const p = S[i];
      const d = (p.x - this.x) ** 2 + (p.z - this.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 900) {
      // 失去追蹤，全域搜尋
      for (let i = 0; i < S.length; i += 3) {
        const p = S[i];
        const d = (p.x - this.x) ** 2 + (p.z - this.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this.trackIndex = best;
    const p = S[best];
    // 橫向偏移（沿右向量 n = (tz, -tx)）
    const rx = p.nx, rz = p.nz;
    const lat = (this.x - p.x) * rx + (this.z - p.z) * rz;
    // 沿切線方向做一次插值，避免 2m 取樣間距造成的高度跳動（車會一階一階地浮沉）
    const lon = (this.x - p.x) * p.tx + (this.z - p.z) * p.tz;
    const nb = lon >= 0 ? Math.min(S.length - 1, best + 1) : Math.max(0, best - 1);
    const q = S[nb];
    const segLen = Math.max(0.5, Math.hypot(q.x - p.x, q.z - p.z));
    const ty = clamp(Math.abs(lon) / segLen, 0, 1);
    const yInterp = p.y + (q.y - p.y) * ty;
    this.y = yInterp + lat * Math.tan(p.bank);
    const limit = ROAD.edge - 0.95;
    if (Math.abs(lat) > limit) {
      const over = Math.abs(lat) - limit;
      const sign = Math.sign(lat);
      // 推回
      this.x -= rx * sign * over;
      this.z -= rz * sign * over;
      // 速度反彈
      const vx = this.u * Math.sin(this.heading) + this.v * Math.cos(this.heading);
      const vz = this.u * Math.cos(this.heading) - this.v * Math.sin(this.heading);
      const vn = vx * rx * sign + vz * rz * sign;
      if (vn > 0.4) {
        const restitution = 0.28;
        const nvx = vx - rx * sign * vn * (1 + restitution);
        const nvz = vz - rz * sign * vn * (1 + restitution);
        // 摩擦損失
        const loss = clamp(1 - vn * 0.012, 0.72, 1);
        this.u = (nvx * Math.sin(this.heading) + nvz * Math.cos(this.heading)) * loss;
        this.v = (nvx * Math.cos(this.heading) - nvz * Math.sin(this.heading)) * loss;
        this.yaw += -sign * vn * 0.06;
        this.wallHit = Math.min(1, vn / 14);
        this.lastWallSide = sign;
      }
    }
    if (this.wallHit > 0) this.wallHit = Math.max(0, this.wallHit - dt * 2.2);
  }
}

export const GRAVITY = G;
