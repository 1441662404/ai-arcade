/**
 * 本地单机服务端（LocalGame）
 * ------------------------------------------------------------
 * 由 server.js 第 19-956 行原样提取 —— 那一段是纯游戏逻辑（地图、物理、命中、技能）。
 * 剔除的部分：http/https/fs/os/ws 依赖、静态文件服务、WebSocket 收发。
 *
 * 用法：
 *   const g = createLocalGame({ name: '玩家' });
 *   g.setInput({ yaw, pitch, shoot, ... });
 *   g.tick();                    // 由 requestAnimationFrame 驱动，60Hz
 *   const snap = g.snapshot();   // 交给客户端 applySnapshot()
 */

const CFG = {
  port: 8080,
  tickRate: 60,                 // 服务器逻辑帧率（提升响应性，消除移动粘滞）
  snapRate: 20,                 // 快照广播帧率（网络负载控制，逻辑60Hz/快照20Hz分离）

  // 场地（扩大后的竞技场）
  arenaHalf: 56,                // 场地半边长
  wallHeight: 4.5,
  gravity: 26,                  // 重力加速度
  jumpSpeed: 8.6,

  // 玩家
  playerHalfW: 0.5,             // 碰撞盒半宽（正方形）
  playerHeight: 1.8,
  eyeHeight: 1.55,
  maxHp: 100,
  walkSpeed: 9.6,               // 基础移速（原 7.4，玩家反馈偏慢提速 30%）
  aimSpeedMul: 0.45,            // 瞄准时移动减速
  respawnDelay: 4.0,            // 死亡复活秒数

  // ============ 备屎量（弹药）============
  poopMax: 100,
  poopRegen: 8.5,               // 每秒缓慢恢复
  poopRegenDelay: 0.45,         // 消耗后延迟多久开始恢复
  gunPoopCost: 2.4,             // 每发子弹消耗
  grenadePoopCost: 20,          // 屎榴弹消耗
  rollPoopCost: 24,             // 滚粪球消耗
  flyPoopDrain: 170,            // 喷射每秒消耗（满条约 0.59 秒）
  flySpeed: 6.6,                // 喷射前进速度（满条约飞 3.9 米）
  flyLift: 4.6,                 // 喷射时维持的上升速度（比普通跳跃高一截）
  flyMaxTime: 0.9,              // 单次喷射最长时间
  flyMinPoop: 6,                // 少于这个量按不出来

  // 机关枪
  gunFireInterval: 0.105,       // 射击间隔（秒）
  gunDamageBody: 9,
  gunDamageHead: 18,
  gunRange: 160,
  gunSpread: 0.035,             // 腰射散布（弧度）
  gunSpreadAim: 0.006,          // 瞄准后散布
  gunBlurPerHit: 0.17,          // 每发命中给目标加多少「糊视野」
  blurDecay: 0.13,              // 糊视野每秒衰减
  hitKnockback: 2.0,

  // 屎榴弹（背对弯腰投掷）—— 炸开是屎块四处飞溅
  grenadeCooldown: 6.0,
  grenadeCastTime: 0.75,        // 弯腰背对姿势的表演时间
  grenadeSpeed: 24,
  grenadeGravity: 24,
  grenadeFuse: 0,               // 0 = 无时间引信，纯触地/撞墙/撞人爆炸
  grenadeRadius: 7.5,           // 爆炸半径（米），放大更炸裂
  grenadeMaxDamage: 75,
  grenadeMinDamage: 18,
  grenadeBlur: 0.7,

  // 打滚球（背对撅屁股，射出一颗向前滚 30 米的粪球；不是自己滚）
  rollCooldown: 7.0,
  rollCastTime: 0.6,            // 撅屁股发射动作时长
  rollDistance: 30,             // 粪球滚动距离（米）
  rollSpeed: 17,
  rollRadius: 0.85,             // 粪球半径（碰撞用）
  rollDamage: 35,
  rollDownTime: 2.6,            // 被撞倒地无法动弹的时间
  rollBlurTime: 3.6,            // 倒地后视野全糊持续时间
  rollBlurLevel: 1.0,

  // 比赛
  killLimit: 20,
  matchSeconds: 600,
  /* ★ 默认 0（用户要求"关掉测试脚本"）：原来开局就塞 4 个机器人，
     玩家一进来满场都是"看起来像人但不是人"的实体。需要时用 BOT_FILL=4 打开。 */
  botFill: 0,                  // 服务器启动时默认的机器人数量（房间总人数补足到几个）
  botMax: 8,                   // 玩家可在客户端调整的机器人数量上限
};

// 测试用覆盖（不设环境变量时保持默认）
// ★ 必须在 botCfg 之前生效，否则 BOT_FILL=4 改了 CFG.botFill 但 botCfg 已经按旧值固定了

// ============ 机器人开关（服务器权威，玩家可在客户端切） ============
// 由服务器统一维护并同步给所有玩家，避免各端各说各话。
const botCfg = { enabled: CFG.botFill > 0, count: Math.max(0, CFG.botFill) };

// ============================ 地图 ============================
// 盒子统一格式： { cx, cy, cz, hx, hy, hz }  中心 + 半尺寸
function buildMap() {
  const B = [];
  const S = CFG.arenaHalf;
  const H = CFG.wallHeight;
  const t = 1; // 墙厚半宽

  // 四面边界墙
  B.push({ cx: 0, cy: H / 2, cz: S + t, hx: S + t * 2, hy: H / 2, hz: t, kind: 'wall' });
  B.push({ cx: 0, cy: H / 2, cz: -S - t, hx: S + t * 2, hy: H / 2, hz: t, kind: 'wall' });
  B.push({ cx: S + t, cy: H / 2, cz: 0, hx: t, hy: H / 2, hz: S + t * 2, kind: 'wall' });
  B.push({ cx: -S - t, cy: H / 2, cz: 0, hx: t, hy: H / 2, hz: S + t * 2, kind: 'wall' });

  const box = (cx, cy, cz, hx, hy, hz, kind = 'crate') => B.push({ cx, cy, cz, hx, hy, hz, kind });
  const quad = (fn) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) fn(sx, sz); };

  // ============ 中央立体高台（三层，层层可跳） ============
  box(0, 0.5, 0, 8, 0.5, 8, 'stone');       // 一层：顶面 1.0m
  box(0, 1.5, 0, 5, 0.5, 5, 'stone');       // 二层：顶面 2.0m
  box(0, 2.5, 0, 2, 0.5, 2, 'stone');       // 三层：顶面 3.0m
  // 四向台阶
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ax = dx ? 1 : 0, az = dz ? 1 : 0;
    box(dx * 9.6, 0.33, dz * 9.6, ax ? 1.2 : 3.0, 0.33, az ? 1.2 : 3.0, 'stone');
    box(dx * 8.5, 0.67, dz * 8.5, ax ? 1.1 : 3.0, 0.67, az ? 1.1 : 3.0, 'stone');
  }
  // 高台四角立柱（掩体）
  quad((sx, sz) => box(sx * 6.4, 1.7, sz * 6.4, 0.7, 1.7, 0.7, 'stone'));

  // ============ 中场四座碉堡 ============
  box(26, 1.0, 0, 3.0, 1.0, 5.0, 'stone');
  box(26, 0.4, 6.4, 3.0, 0.4, 1.2, 'stone');
  box(-26, 1.0, 0, 3.0, 1.0, 5.0, 'stone');
  box(-26, 0.4, -6.4, 3.0, 0.4, 1.2, 'stone');
  box(0, 1.0, 26, 5.0, 1.0, 3.0, 'stone');
  box(0, 1.0, -26, 5.0, 1.0, 3.0, 'stone');
  // 碉堡顶的小掩体
  box(26, 2.35, 2.0, 1.2, 0.35, 1.2, 'stone');
  box(-26, 2.35, -2.0, 1.2, 0.35, 1.2, 'stone');

  // ============ 四角基地（L 形墙 + 箱子） ============
  quad((sx, sz) => {
    box(sx * 38, 1.4, sz * 30.5, 6.0, 1.4, 0.65, 'stone');
    box(sx * 30.5, 1.4, sz * 38, 0.65, 1.4, 6.0, 'stone');
    box(sx * 38, 0.75, sz * 38, 2.2, 0.75, 2.2);
    box(sx * 43.5, 0.55, sz * 43.5, 1.7, 0.55, 1.7);
    box(sx * 33.5, 2.0, sz * 33.5, 0.6, 2.0, 0.6, 'stone');
  });

  // ============ 斜向长廊掩体 ============
  quad((sx, sz) => {
    box(sx * 17, 1.15, sz * 17, 6.5, 1.15, 0.75, 'stone');
    box(sx * 17, 1.15, sz * 17, 0.75, 1.15, 6.5, 'stone');
  });

  // ============ 中场矮墙 / 散落箱子 ============
  box(12, 0.6, 0, 0.8, 0.6, 4.5);
  box(-12, 0.6, 0, 0.8, 0.6, 4.5);
  box(0, 0.6, 12, 4.5, 0.6, 0.8);
  box(0, 0.6, -12, 4.5, 0.6, 0.8);

  const crates = [
    [15, 0.85, -7, 1.7, 0.85, 1.7], [-15, 0.85, 7, 1.7, 0.85, 1.7],
    [22, 1.0, 15, 2.0, 1.0, 2.0], [-22, 1.0, -15, 2.0, 1.0, 2.0],
    [34, 0.75, 11, 1.5, 0.75, 1.5], [-34, 0.75, -11, 1.5, 0.75, 1.5],
    [11, 0.75, 34, 1.5, 0.75, 1.5], [-11, 0.75, -34, 1.5, 0.75, 1.5],
    [44, 1.1, -22, 2.2, 1.1, 1.4], [-44, 1.1, 22, 2.2, 1.1, 1.4],
    [7, 0.9, 20, 1.4, 0.9, 1.4], [-7, 0.9, -20, 1.4, 0.9, 1.4],
    [20, 0.6, 32, 2.6, 0.6, 1.2], [-20, 0.6, -32, 2.6, 0.6, 1.2],
    [32, 0.6, -32, 1.2, 0.6, 2.6], [-32, 0.6, 32, 1.2, 0.6, 2.6],
    [46, 0.75, 6, 1.5, 0.75, 1.5], [-46, 0.75, -6, 1.5, 0.75, 1.5],
    [6, 0.75, -46, 1.5, 0.75, 1.5], [-6, 0.75, 46, 1.5, 0.75, 1.5],
  ];
  for (const c of crates) box(...c);

  return B;
}

const MAP = buildMap();

// ============================ 数学工具 ============================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** 射线与 AABB 求交，返回命中距离（未命中返回 -1） */
function rayAABB(ox, oy, oz, dx, dy, dz, b) {
  let t0 = 0, t1 = Infinity;
  const o = [ox, oy, oz];
  let d = [dx, dy, dz];
  const bmin = [b.cx - b.hx, b.cy - b.hy, b.cz - b.hz];
  const bmax = [b.cx + b.hx, b.cy + b.hy, b.cz + b.hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) d[i] = d[i] >= 0 ? 1e-8 : -1e-8;
    const inv = 1 / d[i];
    let ta = (bmin[i] - o[i]) * inv;
    let tb = (bmax[i] - o[i]) * inv;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}

function playerAABB(p, yOff = 0) {
  const hw = CFG.playerHalfW;
  return {
    cx: p.x, cy: p.y + CFG.playerHeight / 2 + yOff, cz: p.z,
    hx: hw, hy: CFG.playerHeight / 2, hz: hw,
  };
}

function boxesOverlap(a, b) {
  return Math.abs(a.cx - b.cx) < a.hx + b.hx &&
         Math.abs(a.cy - b.cy) < a.hy + b.hy &&
         Math.abs(a.cz - b.cz) < a.hz + b.hz;
}

// ============================ 玩家 ============================
const NAME_POOL = ['便便侠', '黄金圣斗屎', '一坨闪电', '弹丸', '排污阀', '马桶塞子', '喷射战士', '下水道之王', '大肠刺客', '奥利给', '卷纸超人', '粪太狼'];
const COLORS = [0x8b5a2b, 0x6b4423, 0xa0522d, 0xcd853f, 0x5c4033, 0x7b3f00, 0x9c661f, 0x4a2f1b];

let nextId = 1;

/** 找一个不与箱子重叠的出生点 */
function findSpawnPoint() {
  const hw = CFG.playerHalfW, h = CFG.playerHeight;
  for (let i = 0; i < 60; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = rand(14, CFG.arenaHalf - 9);
    const x = Math.sin(ang) * r, z = Math.cos(ang) * r;
    const pb = { cx: x, cy: h / 2, cz: z, hx: hw, hy: h / 2, hz: hw };
    let ok = true;
    for (const b of MAP) { if (boxesOverlap(pb, b)) { ok = false; break; } }
    if (ok) return { x, z };
  }
  return { x: rand(-6, 6), z: rand(-6, 6) };
}

function makePlayer(name, isBot) {
  const sp = findSpawnPoint();
  return {
    id: nextId++,
    name: name || NAME_POOL[(Math.random() * NAME_POOL.length) | 0],
    color: COLORS[(Math.random() * COLORS.length) | 0],
    isBot: !!isBot,
    ws: null,

    x: sp.x, y: 0, z: sp.z,
    px: sp.x, py: 0, pz: sp.z,
    vy: 0, onGround: true,
    yaw: Math.atan2(-sp.x, -sp.z), pitch: 0,

    hp: CFG.maxHp, alive: true,
    blur: 0,             // 0~1，视野被糊住的程度
    kills: 0, deaths: 0,
    streak: 0, streakAt: 0,   // 连杀（3.5 秒内连续击杀）

    // 备屎量：技能与子弹共用，死亡不重置（复活补满）
    poop: CFG.poopMax,
    poopUseAt: 0,        // 最近一次消耗时间（用于延迟恢复）
    flyUntil: 0,         // 喷气飞行持续到什么时候
    wantFly: false,

    downUntil: 0,        // 倒地无法行动到什么时候
    blurUntil: 0,        // 强制糊视野到什么时候（倒地用）
    pose: 'idle',       // idle | aim | bent | down
    poseUntil: 0,
    castUntil: 0,        // 弯腰施法硬直（不能开枪/移动很慢）

    lastShot: 0,
    grenadeReadyAt: 0, rollReadyAt: 0,

    input: { mx: 0, mz: 0, yaw: 0, pitch: 0, shoot: false, aim: false, jump: false },
    wantGrenade: false, wantRoll: false,
    respawnAt: 0,
    spawnLockUntil: 0,   // 复活后出生朝向锁定截止时间（防旧输入覆盖）

    // bot 专用
    botTarget: null, botStrafe: Math.random() < 0.5 ? 1 : -1, botSkillAt: 0, botJumpAt: 0,
    botLastX: sp.x, botLastZ: sp.z, botProbeAt: 0, botAvoidUntil: 0, botAvoidDir: 1,
    botFlyAt: 0,
  };
}

function eyePos(p) {
  // 射击起点优先用客户端预测位置（消除移动中起点滞后），但做防作弊校验：
  // 与服务器权威位置差超过 3m（瞬移/伪造）就退回服务器位置
  const inp = p.input;
  if (inp.px != null && inp.pz != null) {
    const d = Math.hypot(inp.px - p.x, inp.pz - p.z);
    if (d < 3) return { x: inp.px, y: p.y + CFG.eyeHeight, z: inp.pz };
  }
  return { x: p.x, y: p.y + CFG.eyeHeight, z: p.z };
}

// ============================ 世界 ============================
const players = new Map();
const grenades = [];
const balls = [];        // 打滚球的粪球投射物
let nextBallId = 1;
const events = [];       // 每 tick 收集，随快照一起下发
let matchEndsAt = Date.now() + CFG.matchSeconds * 1000;

function emit(ev) { events.push(ev); if (events.length > 200) events.shift(); }

function movePlayer(p, dt) {
  const inp = p.input;
  const t = nowSec();
  const down = t < p.downUntil;
  const casting = t < p.castUntil;
  const flying = t < p.flyUntil && p.poop > 0;

  let speed = CFG.walkSpeed;
  if (inp.aim) speed *= CFG.aimSpeedMul;
  if (casting) speed *= 0.22;     // 弯腰放技能时几乎走不动

  let mx = inp.mx, mz = inp.mz;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }

  // 朝向：yaw 以 +Z 为前方
  const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
  const fx = sinY, fz = cosY;      // 前
  const rx = -cosY, rz = sinY;     // 右（与相机屏幕右方向一致）
  let vx, vz;

  if (flying) {
    // 喷气飞行：沿朝向快速推进，可轻微左右修正
    let dx = fx + rx * mx * 0.32;
    let dz = fz + rz * mx * 0.32;
    const dl = Math.hypot(dx, dz) || 1;
    vx = (dx / dl) * CFG.flySpeed;
    vz = (dz / dl) * CFG.flySpeed;
    p.vy = CFG.flyLift;

    // 快速消耗备屎量，耗尽立刻失去推力
    p.poop -= CFG.flyPoopDrain * dt;
    p.poopUseAt = t;
    if (p.poop <= 0) {
      p.poop = 0;
      p.flyUntil = 0;
      emit({ k: 'flyend', id: p.id, out: 1 });
    }
  } else if (down) {
    vx = 0; vz = 0;
  } else {
    vx = (fx * mz + rx * mx) * speed;
    vz = (fz * mz + rz * mx) * speed;
  }

  // 重力（喷射期间由推力维持上升，不受重力）
  if (!flying) {
    p.vy -= CFG.gravity * dt;
    if (down) p.vy = Math.min(p.vy, 0);
  }

  // 逐轴移动 + AABB 碰撞
  const hw = CFG.playerHalfW, h = CFG.playerHeight;
  const step = (axis, delta) => {
    p[axis] += delta;
    const pb = { cx: p.x, cy: p.y + h / 2, cz: p.z, hx: hw, hy: h / 2, hz: hw };
    for (const b of MAP) {
      if (!boxesOverlap(pb, b)) continue;
      if (axis === 'x') {
        p.x = delta > 0 ? b.cx - b.hx - hw - 1e-4 : b.cx + b.hx + hw + 1e-4;
      } else if (axis === 'z') {
        p.z = delta > 0 ? b.cz - b.hz - hw - 1e-4 : b.cz + b.hz + hw + 1e-4;
      } else {
        if (delta <= 0) { p.y = b.cy + b.hy; p.vy = 0; p.onGround = true; }
        else { p.y = b.cy - b.hy - h - 1e-4; p.vy = 0; }
      }
      pb.cx = p.x; pb.cy = p.y + h / 2; pb.cz = p.z;
    }
  };

  p.onGround = false;
  step('x', vx * dt);
  step('z', vz * dt);
  step('y', p.vy * dt);

  if (p.y <= 0) { p.y = 0; p.vy = 0; p.onGround = true; }

  // 喷射中落地 = 喷射结束（避免贴地滑行）
  if (flying && p.onGround) { p.flyUntil = 0; p.poopUseAt = t; }

  if (p.onGround && inp.jump && !down && !casting && !flying) {
    p.vy = CFG.jumpSpeed;
    p.onGround = false;
  }
}

/** 扣备屎量；不够就返回 false */
function spendPoop(p, amount) {
  if (p.poop < amount) return false;
  p.poop -= amount;
  p.poopUseAt = nowSec();
  return true;
}

/** 双空格喷射：跳得更高、并且沿着朝向冲一段距离 */
function tryFly(p) {
  const t = nowSec();
  p.wantFly = false;
  if (!p.alive || t < p.downUntil) return;
  if (t < p.flyUntil) return;
  if (p.poop < CFG.flyMinPoop) { emit({ k: 'dry', id: p.id, kind: 'fly' }); return; }
  p.flyUntil = t + CFG.flyMaxTime;
  // 喷射起跳：先给一个明显向上的初速（跳得比普通跳跃更高）
  p.vy = Math.max(p.vy, CFG.flyLift + 2.4);
  p.onGround = false;
  emit({ k: 'fly', id: p.id });
}

function damage(p, amount, attacker, kind, blurAdd = 0, forceDown = 0) {
  if (!p.alive) return;
  p.hp -= amount;
  const t = nowSec();
  if (blurAdd > 0) p.blur = clamp(p.blur + blurAdd, 0, 1);
  if (forceDown > 0) {
    p.flyUntil = 0;
    p.downUntil = Math.max(p.downUntil, t + forceDown);
    p.blurUntil = Math.max(p.blurUntil, t + Math.max(forceDown, CFG.rollBlurTime));
    p.blur = Math.max(p.blur, CFG.rollBlurLevel);
    p.pose = 'down';
    p.poseUntil = t + forceDown;
  }
  emit({
    k: 'hit', id: p.id, by: attacker ? attacker.id : 0, dmg: amount, kind,
    hp: Math.max(0, p.hp),
    // 受击方向：攻击者相对受击者的位置，客户端据此画方向指示器
    ax: attacker ? +attacker.x.toFixed(2) : 0,
    az: attacker ? +attacker.z.toFixed(2) : 0,
  });
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    p.deaths++;
    p.respawnAt = nowSec() + CFG.respawnDelay;
    p.blur = 1;
    p.pose = 'down';
    p.castUntil = 0;
    p.flyUntil = 0;
    p.wantFly = false;
    let streak = 0;
    if (attacker && attacker !== p) {
      attacker.kills++;
      // 连杀统计：3.5 秒内连续击杀算一次连杀
      if (t - (attacker.streakAt || 0) > 3.5) attacker.streak = 0;
      attacker.streak = (attacker.streak || 0) + 1;
      attacker.streakAt = t;
      streak = attacker.streak;
    }
    emit({ k: 'die', id: p.id, by: attacker ? attacker.id : 0, name: p.name, kind, streak });
    checkMatchEnd();
  }
}

function checkMatchEnd() {
  for (const p of players.values()) {
    if (!p.isBot && p.kills >= CFG.killLimit) {
      emit({ k: 'over', id: p.id, name: p.name });
      setTimeout(resetMatch, 4000);
      matchEndsAt = Infinity;
    }
  }
}

function resetMatch() {
  for (const p of players.values()) {
    p.kills = 0; p.deaths = 0; p.hp = CFG.maxHp; p.alive = true; p.blur = 0; p.pose = 'idle';
    p.streak = 0; p.streakAt = 0;
    p.poop = CFG.poopMax; p.poopUseAt = 0; p.flyUntil = 0; p.downUntil = 0; p.castUntil = 0;
    const sp = findSpawnPoint();
    p.x = sp.x; p.z = sp.z; p.y = 0; p.vy = 0;
    p.yaw = Math.atan2(-sp.x, -sp.z);
  }
  grenades.length = 0;
  balls.length = 0;
  matchEndsAt = Date.now() + CFG.matchSeconds * 1000;
  emit({ k: 'restart' });
}

/** 射线与 AABB 求交，返回命中距离 + 命中面法线（未命中返回 null） */
function rayAABBHit(ox, oy, oz, dx, dy, dz, b) {
  let t0 = 0, t1 = Infinity, axis = -1;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const bmin = [b.cx - b.hx, b.cy - b.hy, b.cz - b.hz];
  const bmax = [b.cx + b.hx, b.cy + b.hy, b.cz + b.hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) d[i] = d[i] >= 0 ? 1e-8 : -1e-8;
    const inv = 1 / d[i];
    let ta = (bmin[i] - o[i]) * inv;
    let tb = (bmax[i] - o[i]) * inv;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) { t0 = ta; axis = i; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (axis < 0) return null;                    // 起点在盒内
  const n = [0, 0, 0];
  n[axis] = d[axis] > 0 ? -1 : 1;               // 入口面朝向来向
  return { t: t0, nx: n[0], ny: n[1], nz: n[2] };
}

/** 机关枪：hitscan */
function tryShoot(p) {
  const t = nowSec();
  if (!p.alive || t < p.downUntil || t < p.castUntil || t < p.flyUntil) return;
  if (t - p.lastShot < CFG.gunFireInterval) return;
  if (p.poop < CFG.gunPoopCost) {
    if (t - (p.lastDry || 0) > 0.3) {
      p.lastDry = t;
      emit({ k: 'dry', id: p.id, kind: 'gun' });
    }
    return;
  }
  p.lastShot = t;
  spendPoop(p, CFG.gunPoopCost);

  let spread = p.input.aim ? CFG.gunSpreadAim : CFG.gunSpread;
  if (p.isBot) spread *= 3.2;   // bot 枪法别太准，给玩家留活路
  const dy = (Math.random() - 0.5) * spread * 2;
  const dp = (Math.random() - 0.5) * spread * 2;
  const e = eyePos(p);
  const d = dirFromYawPitch(p.yaw + dy, p.pitch + dp);

  let bestT = CFG.gunRange, hitPlayer = null, normal = null;
  // 地面平面（y=0）：朝下射击必须能打在地上，否则弹着点会飞到地下
  if (d.y < -1e-4) {
    const tg = -e.y / d.y;
    if (tg > 0 && tg < bestT) { bestT = tg; hitPlayer = null; normal = { nx: 0, ny: 1, nz: 0 }; }
  }
  for (const b of MAP) {
    const h = rayAABBHit(e.x, e.y, e.z, d.x, d.y, d.z, b);
    if (h && h.t < bestT) { bestT = h.t; hitPlayer = null; normal = h; }
  }
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    const h = rayAABBHit(e.x, e.y, e.z, d.x, d.y, d.z, playerAABB(q));
    if (h && h.t < bestT) {
      bestT = h.t; hitPlayer = q;
      normal = { nx: -d.x, ny: -d.y, nz: -d.z };   // 击中人：法线朝射手
    }
  }

  const hp2 = { x: e.x + d.x * bestT, y: e.y + d.y * bestT, z: e.z + d.z * bestT };
  emit({
    k: 'shot', id: p.id, x: e.x, y: e.y, z: e.z,
    hx: hp2.x, hy: hp2.y, hz: hp2.z, aim: !!p.input.aim,
    nx: normal ? normal.nx : 0, ny: normal ? normal.ny : 1, nz: normal ? normal.nz : 0,
    hit: hitPlayer ? 1 : 0,
  });

  if (hitPlayer) {
    const head = hp2.y > hitPlayer.y + CFG.playerHeight * 0.78;
    const dmg = head ? CFG.gunDamageHead : CFG.gunDamageBody;
    damage(hitPlayer, dmg, p, 'gun', CFG.gunBlurPerHit * (head ? 1.4 : 1));
    // 轻微击退
    const kb = CFG.hitKnockback * (head ? 1 : 0.7);
    hitPlayer.x += d.x * kb * 0.12;
    hitPlayer.z += d.z * kb * 0.12;
  }
}

function tryGrenade(p) {
  const t = nowSec();
  if (!p.alive || t < p.downUntil || t < p.castUntil) { p.wantGrenade = false; return; }
  if (t < p.grenadeReadyAt) { p.wantGrenade = false; return; }
  if (p.poop < CFG.grenadePoopCost) {
    p.wantGrenade = false;
    emit({ k: 'dry', id: p.id, kind: 'grenade' });
    return;
  }
  p.grenadeReadyAt = t + CFG.grenadeCooldown;
  p.wantGrenade = false;
  spendPoop(p, CFG.grenadePoopCost);

  // 弯腰背对姿势：先摆 pose，投出瞬间生成弹体
  p.pose = 'bent';
  p.poseUntil = t + CFG.grenadeCastTime;
  p.castUntil = t + CFG.grenadeCastTime * 0.8;

  const d = dirFromYawPitch(p.yaw, clamp(p.pitch + 0.35, -1.2, 1.2));
  // 出生点放在身前（别放在自己身体里，否则一出手就撞自己炸掉）
  const sx = p.x + d.x * 0.8, sz = p.z + d.z * 0.8;
  grenades.push({
    owner: p.id,
    x: sx, y: p.y + 1.15, z: sz,       // 从臀部高度甩出（背身弯腰时屁股朝向敌人）
    vx: d.x * CFG.grenadeSpeed,
    vy: d.y * CFG.grenadeSpeed + 4,
    vz: d.z * CFG.grenadeSpeed,
    at: t + CFG.grenadeCastTime * 0.45,
    safeUntil: t + CFG.grenadeCastTime * 0.45 + 0.3,   // 这段时间内不再撞自己
  });
  emit({ k: 'grenade', id: p.id });
}

function updateGrenades(dt) {
  const t = nowSec();
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    if (t < g.at) continue;
    g.vy -= CFG.grenadeGravity * dt;
    const steps = 3;
    let boom = false;
    for (let s = 0; s < steps && !boom; s++) {
      const sdt = dt / steps;
      const nx = g.x + g.vx * sdt, ny = g.y + g.vy * sdt, nz = g.z + g.vz * sdt;
      // 落地就爆（无时间引信：砸到地面/箱子/人才爆开，更符合"屎榴弹落地炸开"）
      if (ny <= 0.25) { g.x = nx; g.y = 0.25; g.z = nz; boom = true; break; }
      let hitBox = false;
      for (const b of MAP) {
        if (Math.abs(nx - b.cx) < b.hx + 0.25 && Math.abs(ny - b.cy) < b.hy + 0.25 && Math.abs(nz - b.cz) < b.hz + 0.25) { hitBox = true; break; }
      }
      // 撞到玩家直接炸（出手后一小段时间不判定投掷者自己，否则原地自杀）
      let hitPlayer = false;
      for (const q of players.values()) {
        if (!q.alive) continue;
        if (q.id === g.owner && t < g.safeUntil) continue;
        if (Math.abs(nx - q.x) < CFG.playerHalfW + 0.3 && Math.abs(nz - q.z) < CFG.playerHalfW + 0.3 && ny > q.y - 0.2 && ny < q.y + CFG.playerHeight) { hitPlayer = true; break; }
      }
      g.x = nx; g.y = ny; g.z = nz;
      if (hitBox || hitPlayer) boom = true;
    }
    if (boom) {
      explode(g);
      grenades.splice(i, 1);
    }
  }
}

function explode(g) {
  const owner = players.get(g.owner);
  // 屎榴弹炸开：一坨屎炸得四处飞溅（客户端按这个事件喷大量屎块）
  emit({
    k: 'boom', x: g.x, y: g.y, z: g.z, r: CFG.grenadeRadius,
    by: g.owner, name: owner ? owner.name : '',
  });
  for (const q of players.values()) {
    if (!q.alive) continue;
    const dist = Math.hypot(q.x - g.x, (q.y + 0.9) - g.y, q.z - g.z);
    if (dist > CFG.grenadeRadius) continue;
    const f = 1 - dist / CFG.grenadeRadius;
    const dmg = Math.round(lerp(CFG.grenadeMinDamage, CFG.grenadeMaxDamage, f));
    damage(q, dmg, owner, 'grenade', CFG.grenadeBlur * f);
    // 爆炸击退：更猛的"炸飞"感
    const dx = q.x - g.x, dz = q.z - g.z;
    const l = Math.hypot(dx, dz) || 1;
    q.x += (dx / l) * f * 2.4; q.z += (dz / l) * f * 2.4;
    q.vy += f * 8;
  }
}

/**
 * 打滚球：背对撅屁股，从屁股射出一颗大粪球，粪球自己向前滚 30 米
 * （玩家本人不滚动，滚动的是技能投射物）
 */
function tryRoll(p) {
  const t = nowSec();
  if (!p.alive || t < p.downUntil || t < p.castUntil) { p.wantRoll = false; return; }
  if (t < p.rollReadyAt) { p.wantRoll = false; return; }
  if (p.poop < CFG.rollPoopCost) {
    p.wantRoll = false;
    emit({ k: 'dry', id: p.id, kind: 'roll' });
    return;
  }
  p.rollReadyAt = t + CFG.rollCooldown;
  p.wantRoll = false;
  spendPoop(p, CFG.rollPoopCost);

  p.pose = 'bent';
  p.poseUntil = t + CFG.rollCastTime;
  p.castUntil = t + CFG.rollCastTime * 0.85;

  // 朝面向方向滚出去，出生点放在身前（模型弯腰后屁股朝前）
  const d = dirFromYawPitch(p.yaw, 0);
  balls.push({
    id: nextBallId++,
    owner: p.id,
    x: p.x + d.x * 0.8,
    y: CFG.rollRadius,
    z: p.z + d.z * 0.8,
    dx: d.x, dz: d.z,
    travelled: 0,
    spin: 0,
    hit: new Set(),
    stopAt: 0,
    blocked: 0,
  });
  emit({ k: 'ball', id: p.id });
}

function updateBalls(dt) {
  const t = nowSec();
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b.stopAt) {
      if (t >= b.stopAt) balls.splice(i, 1);
      continue;
    }

    let remain = CFG.rollSpeed * dt;
    while (remain > 0) {
      const s = Math.min(0.3, remain);      // 小步推进，防止高速穿过目标
      remain -= s;
      const nx = b.x + b.dx * s, nz = b.z + b.dz * s;
      const r = CFG.rollRadius;

      // 撞墙 / 高台：原地停下（矮箱子直接碾过去）
      let blocked = Math.abs(nx) > CFG.arenaHalf - r * 0.8 || Math.abs(nz) > CFG.arenaHalf - r * 0.8;
      if (!blocked) {
        for (const box of MAP) {
          if (box.cy + box.hy < 1.05) continue;                // 矮箱子：大粪球直接压过去
          if (Math.abs(nx - box.cx) < box.hx + r * 0.85 &&
              Math.abs(nz - box.cz) < box.hz + r * 0.85) { blocked = true; break; }
        }
      }
      if (blocked) { b.stopAt = t + 0.5; b.blocked = 1; break; }

      b.x = nx; b.z = nz;
      b.travelled += s;
      b.spin += s / CFG.rollRadius;

      // 撞人：撞飞 + 倒地 + 视野全糊
      for (const q of players.values()) {
        if (!q.alive || q.id === b.owner || b.hit.has(q.id)) continue;
        if (t < q.downUntil) continue;
        const dist = Math.hypot(q.x - b.x, q.z - b.z);
        if (dist > r + CFG.playerHalfW + 0.2) continue;
        if (Math.abs(q.y - (b.y - r)) > 2.0) continue;         // 站高台上就滚不到
        b.hit.add(q.id);
        emit({ k: 'smash', id: b.owner, target: q.id, x: q.x, y: q.y + 0.9, z: q.z });
        damage(q, CFG.rollDamage, players.get(b.owner), 'roll', 1, CFG.rollDownTime);
        q.vy = 5;
        q.x += b.dx * 1.6; q.z += b.dz * 1.6;
      }

      if (b.travelled >= CFG.rollDistance) { b.stopAt = t + 1.0; b.blocked = 1; break; }
    }
  }
}

// ============================ BOT ============================
function updateBot(p, dt) {
  const t = nowSec();
  if (!p.alive) { p.input.mx = 0; p.input.mz = 0; p.input.shoot = false; return; }
  if (t < p.downUntil) { p.input.mx = 0; p.input.mz = 0; p.input.shoot = false; return; }

  // 找最近的活人
  let best = null, bestD = 1e9;
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bestD) { bestD = d; best = q; }
  }
  if (!best) { p.input.mx = 0; p.input.mz = 0; p.input.shoot = false; return; }

  // 朝目标转向
  const want = Math.atan2(best.x - p.x, best.z - p.z);
  let diff = want - p.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  p.yaw += clamp(diff, -4 * dt, 4 * dt);
  // 抬枪：按距离粗瞄头部
  const dy = (best.y + 1.2) - (p.y + CFG.eyeHeight);
  p.pitch = Math.atan2(dy, Math.max(1, bestD));

  // 卡住检测：一段时间没位移就侧向绕开（大地图掩体多）
  if (t > p.botProbeAt) {
    const moved = Math.hypot(p.x - p.botLastX, p.z - p.botLastZ);
    if (moved < 0.55 && bestD > 7 && p.onGround && t >= p.flyUntil) {
      p.botAvoidUntil = t + rand(0.5, 1.0);
      p.botAvoidDir = Math.random() < 0.5 ? -1 : 1;
    }
    p.botLastX = p.x;
    p.botLastZ = p.z;
    p.botProbeAt = t + 0.8;
  }

  // 移动：远了靠近，近了横向绕
  if (t < p.botAvoidUntil) {
    p.input.mz = 0.45;
    p.input.mx = p.botAvoidDir;
  } else if (bestD > 16) { p.input.mz = 1; p.input.mx = p.botStrafe * 0.3; }
  else if (bestD < 6) { p.input.mz = -0.6; p.input.mx = p.botStrafe; }
  else { p.input.mz = 0.15; p.input.mx = p.botStrafe * 0.8; }

  if (Math.random() < 0.004) p.botStrafe *= -1;
  p.input.jump = Math.random() < 0.01;
  p.input.aim = bestD > 12 && Math.abs(diff) < 0.5;
  p.input.shoot = Math.abs(diff) < 0.35 && bestD < 40 && p.poop > CFG.gunPoopCost;
  if (Math.abs(diff) > 0.9) p.input.shoot = false;

  // 偶尔喷气飞行切进/拉开距离
  if (t > p.botFlyAt && t >= p.flyUntil && p.poop > 55 && bestD > 12 && bestD < 30 && Math.random() < 0.35) {
    p.botFlyAt = t + rand(7, 14);
    p.wantFly = true;
    p.input.shoot = false;
  }

  // 技能
  if (t > p.botSkillAt) {
    p.botSkillAt = t + rand(4, 9);
    if (bestD > 12 && bestD < 30 && p.poop >= CFG.grenadePoopCost) tryGrenade(p);
    else if (bestD < 26 && t >= p.rollReadyAt && p.poop >= CFG.rollPoopCost) tryRoll(p);
  }
}

// ============================ 主循环 ============================
function nowSec() { return Date.now() / 1000; }

function tick() {
  const dt = 1 / CFG.tickRate;
  const t = nowSec();

  for (const p of players.values()) {
    if (p.isBot) {
      updateBot(p, dt);
    } else if (p.alive) {
      // 视角由客户端权威（服务器只做转发与命中判定）。
      // 死亡期间不应用客户端朝向，且复活后短暂锁定出生朝向：
      // 否则复活帧设置的出生朝向会被在途的死亡前旧输入立刻覆盖，
      // 快照朝向在"出生朝向 ↔ 死亡朝向"之间来回翻转 → 客户端复活视角抽搐
      if (t >= (p.spawnLockUntil || 0)) {
        p.yaw = p.input.yaw;
        p.pitch = p.input.pitch;
      }
    }

    if (!p.alive) {
      p.blur = Math.max(p.blur - dt * 0.6, 0);
      if (t >= p.respawnAt) {
        const sp = findSpawnPoint();
        p.x = sp.x; p.z = sp.z; p.y = 0; p.vy = 0;
        p.yaw = Math.atan2(-sp.x, -sp.z);
        p.pitch = 0;
        // 出生朝向锁定 0.25s：等复活后客户端的新输入到达，防止死亡前的旧输入覆盖出生朝向
        p.spawnLockUntil = t + 0.25;
        p.hp = CFG.maxHp; p.alive = true; p.blur = 0; p.pose = 'idle';
        p.downUntil = 0; p.blurUntil = 0; p.castUntil = 0;
        p.poop = CFG.poopMax; p.poopUseAt = 0; p.flyUntil = 0;
        p.grenadeReadyAt = t + 1; p.rollReadyAt = t + 1;
        p.wantGrenade = false; p.wantRoll = false;
        emit({ k: 'spawn', id: p.id });
      }
      continue;
    }

    // 姿态恢复
    if (t > p.poseUntil && p.pose !== 'down') {
      p.pose = p.input.aim ? 'aim' : 'idle';
    }
    if (p.pose !== 'bent' && p.pose !== 'down') {
      p.pose = p.input.aim ? 'aim' : 'idle';
    }
    if (t < p.flyUntil) p.pose = 'fly';

    if (p.wantGrenade) tryGrenade(p);
    if (p.wantRoll) tryRoll(p);
    if (p.wantFly) tryFly(p);

    p.px = p.x; p.pz = p.z;
    movePlayer(p, dt);
    if (p.input.shoot) tryShoot(p);

    // 备屎量缓慢恢复（消耗后有一小段延迟，飞行时不回）
    if (t >= p.flyUntil && t > p.poopUseAt + CFG.poopRegenDelay) {
      p.poop = Math.min(CFG.poopMax, p.poop + CFG.poopRegen * dt);
    }

    // 糊视野衰减
    if (t >= p.blurUntil) p.blur = Math.max(0, p.blur - CFG.blurDecay * dt);
    if (t >= p.downUntil && p.pose === 'down' && p.alive) p.pose = 'idle';
  }

  updateBalls(dt);
  updateGrenades(dt);

  if (Date.now() > matchEndsAt) {
    emit({ k: 'over', id: 0, name: '时间到' });
    setTimeout(resetMatch, 4000);
    matchEndsAt = Infinity;
  }

  // 快照按 snapRate 节流广播（逻辑 60Hz，快照 20Hz，降低网络负载）
  snapAcc++;
  if (snapAcc >= CFG.tickRate / CFG.snapRate) {
    snapAcc = 0;
    broadcast();
  }
}

function snapshot() {
  const t = nowSec();
  const ps = [];
  for (const p of players.values()) {
    ps.push({
      id: p.id, name: p.name, color: p.color, bot: p.isBot ? 1 : 0,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      hp: Math.round(p.hp), alive: p.alive ? 1 : 0,
      blur: +p.blur.toFixed(3), pose: p.pose,
      down: t < p.downUntil ? 1 : 0,
      pp: Math.round(p.poop),
      fly: t < p.flyUntil ? 1 : 0,
      k: p.kills, d: p.deaths,
      g: Math.max(0, +(p.grenadeReadyAt - t).toFixed(2)),
      r: Math.max(0, +(p.rollReadyAt - t).toFixed(2)),
    });
  }
  const gs = grenades.map(g => ({ x: +g.x.toFixed(2), y: +g.y.toFixed(2), z: +g.z.toFixed(2) }));
  const bs = balls.map(b => ({
    x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2),
    a: +Math.atan2(b.dx, b.dz).toFixed(3), s: +b.spin.toFixed(2), stop: b.blocked,
    d: +b.travelled.toFixed(2),
  }));
  return {
    t: 'snap', tick: tickCount, time: +(matchEndsAt - Date.now()).toFixed(0) / 1000,
    players: ps, grenades: gs, balls: bs, ev: events,
    bots: { enabled: botCfg.enabled, count: botCfg.count, max: CFG.botMax },
    top: topBoard(),
  };
}

/** 排行榜：按击杀数排序（击杀 → 死亡少 → 名字），供游戏页面右侧榜单用 */
function topBoard() {
  const list = [...players.values()].map(p => ({
    id: p.id, name: p.name, bot: p.isBot ? 1 : 0,
    k: p.kills, d: p.deaths, hp: Math.round(p.hp), alive: p.alive ? 1 : 0,
  }));
  list.sort((a, b) => (b.k - a.k) || (a.d - b.d) || (a.id - b.id));
  return list.slice(0, 12);
}

let tickCount = 0;
let snapAcc = 0;   // 快照节流计数器（每 tickRate/snapRate 个 tick 广播一次快照）
function broadcast() {
  /* 本地模式：没有网络对端，不发送也不清空 events。
     events 由 snapshot() 取走后统一清理（见 createLocalGame）。 */
  tickCount++;
}


/* ================================================================
 *  本地对局接口
 * ================================================================ */

/** 按 botCfg 调整机器人数量（原在网络段，随主逻辑一并带过来） */
function ensureBots() {
  const want = botCfg.enabled ? clamp(botCfg.count | 0, 0, CFG.botMax) : 0;
  const all = [...players.values()].filter(p => p.isBot);

  for (let i = all.length; i < want; i++) {
    const b = makePlayer('[BOT] ' + NAME_POOL[(Math.random() * NAME_POOL.length) | 0], true);
    players.set(b.id, b);
  }
  for (let i = want; i < all.length; i++) {
    players.delete(all[i].id);
  }
  return true;
}

/** 创建一个本地单人对局（含 AI 机器人） */
export function createLocalGame(opts = {}) {
  const me = makePlayer(opts.name || null, false);
  players.set(me.id, me);

  /* 单机默认给几个 AI 对手，否则场上只有自己 */
  const wantBots = clamp(Number(opts.bots != null ? opts.bots : 5), 0, CFG.botMax);
  botCfg.enabled = wantBots > 0;
  botCfg.count = wantBots;
  ensureBots();

  matchEndsAt = Date.now() + CFG.matchSeconds * 1000;

  return {
    id: me.id,
    name: me.name,
    color: me.color,
    player: me,
    cfg: CFG,
    map: MAP,
    players,
    /** 写入本帧输入（映射规则与服务端 handle('input') 完全一致） */
    setInput(m) {
      if (!m) return;
      const inp = me.input;
      inp.mx = clamp(+m.mx || 0, -1, 1);
      inp.mz = clamp(+m.mz || 0, -1, 1);
      inp.yaw = +m.yaw || 0;
      inp.pitch = clamp(+m.pitch || 0, -1.4, 1.4);
      if (Number.isFinite(+m.px) && Number.isFinite(+m.pz)) { inp.px = +m.px; inp.pz = +m.pz; }
      inp.shoot = !!m.shoot;
      inp.aim = !!m.aim;
      inp.jump = !!m.jump;
      if (m.grenade) me.wantGrenade = true;
      if (m.roll) me.wantRoll = true;
      if (m.fly) me.wantFly = true;
    },
    /** 推进一个逻辑帧 */
    tick() { tick(); },
    /** 取当前快照（结构同服务端下发的 snap 消息） */
    snapshot() {
      const s = snapshot();
      events.length = 0;   // 本地：取完即清，避免同一事件被重复播放
      return s;
    },
    /** 玩家数量（含 bot） */
    count() { return players.size; },
  };
}

/** 本帧产生的事件（击杀、出生等），客户端可用于音效与提示 */
export function drainEvents() {
  const e = events.slice();
  events.length = 0;
  return e;
}
