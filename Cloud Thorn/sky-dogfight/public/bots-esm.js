/* =============================================================================
 * bots.js —— 服务端机器人飞行员
 *   目的：空服务器也能立刻开打，同时给真人玩家当陪练。
 *   机器人完全走与真人相同的输入通道（只产出 input 意图），
 *   不直接改位置/伤害，所以不会破坏权威模拟与计分。
 * ========================================================================== */
'use strict';

const FP = globalThis.FlightPhysics;
const V = FP.V;
const Q = FP.Q;
const clamp = FP.clamp;

const AXIS_FWD = { x: 0, y: 0, z: -1 };
const AXIS_RIGHT = { x: 1, y: 0, z: 0 };
const AXIS_UP = { x: 0, y: 1, z: 0 };

function emptyInput() {
  return {
    pitch: 0, yaw: 0, roll: 0, rudder: 0,
    throttleAxis: 0, throttleSet: -1, brake: false, gear: true,
    fire: false, missile: false, flare: false
  };
}

// 找最近的敌机（优先活的、距离近的）
function nearestEnemy(world, me) {
  let best = null, bestD = Infinity;
  for (const a of world.aircraft) {
    if (!a.alive || a.team === me.team || a.id === me.id) continue;
    const d = V.dist(a.pos, me.pos);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best ? { a: best, d: bestD } : null;
}

// 把世界方向换算成机体坐标（右/上/前）
function bodyErrors(me, point) {
  const d = V.sub(point, me.pos);
  const fwd = Q.rotate(me.quat, AXIS_FWD);
  const right = Q.rotate(me.quat, AXIS_RIGHT);
  const up = Q.rotate(me.quat, AXIS_UP);
  const fd = V.dot(d, fwd);
  const rd = V.dot(d, right);
  const ud = V.dot(d, up);
  return {
    yaw: Math.atan2(rd, Math.max(1, fd)),
    pitch: Math.atan2(ud, Math.max(1, fd)),
    forward: fd
  };
}

/**
 * 生成一帧机器人输入
 * @param {object} p    player（含 aircraft / botPhase）
 * @param {object} world 服务端世界
 * @param {number} dt
 */
function updateBot(p, world, dt) {
  const a = p.aircraft;
  const inp = emptyInput();
  if (!a || !a.alive || a.wreck) return inp;

  const C = FP.CONFIG;
  const B = C.bots;
  const skill = clamp(B.skill + (p.botSkillBias || 0), 0.35, 1);

  // ---------- 1. 起飞 ----------
  if (a.onGround) {
    inp.gear = true;
    inp.throttleSet = 1;
    // 先直线加速，到抬轮速度再拉杆
    if (a.speed > C.aircraft.takeoffSpeed * 1.12) inp.pitch = 1;
    // 跑道对正（起飞方向）
    const ap = FP.teamAirport(a.team);
    const yawWant = FP.runwayHeading(ap);
    let dy = yawWant - a.gYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    inp.yaw = clamp(-dy * 1.6, -1, 1);
    return inp;
  }

  // 离地后先爬升到安全高度
  const ground = Math.max(0, FP.terrainHeight(a.pos.x, a.pos.z));
  const agl = a.pos.y - ground;

  if (agl < 380 && a.speed < 240) {
    inp.throttleSet = 1;
    inp.gear = false;
    inp.pitch = clamp((380 - agl) / 260, 0.15, 1);
    inp.roll = clamp(-FP.yprFromQuat(a.quat).roll * 1.5, -1, 1);
    return inp;
  }

  // ---------- 2. 目标选择 ----------
  const en = nearestEnemy(world, a);
  const tgt = en ? en.a : null;
  const dist = en ? en.d : Infinity;

  // ---------- 3. 基础飞行参数 ----------
  inp.gear = false;
  inp.throttleSet = dist < 500 ? 0.72 : 1;

  // 越界/迷航：强制回地图中心
  const nearEdge = Math.abs(a.pos.x) > C.world.half - 2600 || Math.abs(a.pos.z) > C.world.half - 2600;
  const homeAp = FP.teamAirport(a.team);

  let aimPoint = null;
  if (nearEdge) {
    aimPoint = { x: homeAp.x * 0.72, y: Math.max(650, a.pos.y), z: homeAp.z * 0.72 };
  } else if (tgt) {
    // 提前量：按炮弹速度粗算，空战里 1.2~2.5 秒的提前量足够
    const leadT = Math.min(2.4, dist / 780);
    aimPoint = V.add(tgt.pos, V.mul(tgt.vel, leadT * skill));
  } else {
    // 没有目标：在战场中线巡逻
    const ang = world.time * 0.08 + (p.id % 5) * 1.1;
    aimPoint = {
      x: Math.cos(ang) * 5200,
      y: 1600 + Math.sin(world.time * 0.13 + p.id) * 450,
      z: Math.sin(ang) * 5200
    };
  }

  const err = bodyErrors(a, aimPoint);
  const ypr = FP.yprFromQuat(a.quat);

  // 俯仰/偏航：技能越低，抖动越大、反应越慢
  const wobble = (1 - skill) * 0.10;
  const noiseY = Math.sin(world.time * 2.3 + p.id * 1.7) * wobble;
  const noiseP = Math.cos(world.time * 1.9 + p.id * 2.1) * wobble;

  inp.pitch = clamp(err.pitch * (1.8 + skill * 1.7) + noiseP, -1, 1);
  inp.yaw = clamp(err.yaw * (1.3 + skill * 1.2) + noiseY, -1, 1);
  // 压坡度协调转弯：偏航误差越大，坡度越大
  inp.roll = clamp(err.yaw * 1.15 - ypr.roll * 1.35, -1, 1);

  // ---------- 4. 地形规避（最高优先级）----------
  if (agl < 420) {
    const up = clamp((420 - agl) / 240, 0.25, 1);
    inp.pitch = Math.max(inp.pitch, up);
    inp.roll = clamp(-ypr.roll * 1.8, -1, 1);
    inp.throttleSet = 1;
  }
  if (a.pos.y < ground + 80) {
    inp.pitch = 1;
    inp.roll = 0;
    inp.yaw = 0;
  }

  // ---------- 5. 导弹规避 ----------
  if (a.lockedBy && dist < B.evadeRange) {
    // 投放干扰弹（一次性意图）
    if (a.flares > 0 && Math.random() < 0.10) inp.flare = true;
    // 大坡度脱离 + 俯冲/爬升交替
    inp.roll = clamp(inp.roll - 0.9, -1, 1);
    inp.yaw = clamp(inp.yaw + 0.7, -1, 1);
    if (Math.sin(world.time * 1.7 + p.id) > 0) inp.pitch = clamp(inp.pitch + 0.55, -1, 1);
  }

  // ---------- 6. 开火 ----------
  if (tgt && dist < B.fireRange) {
    const aimTol = 0.018 + (1 - skill) * 0.045;
    const aligned = Math.abs(err.yaw) < aimTol && Math.abs(err.pitch) < aimTol;
    if (aligned && a.ammo > 0 && !a.overheated) inp.fire = true;
  }

  // 导弹：完成锁定且在射程内
  if (tgt && dist < B.missileRange && dist > 350 && a.lockProgress >= 1 && a.missiles > 0 && a.missileCd <= 0) {
    if (Math.random() < 0.03 + skill * 0.05) inp.missile = true;
  }

  return inp;
}

export { updateBot };
