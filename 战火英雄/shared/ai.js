/**
 * AI 大脑 —— 由服务端在权威循环里驱动，同时负责「敌方 BOT」与「补位队友」。
 *
 * 设计目标（对齐原作 Quick Match 的手感）：
 *   - 会走位、会跳台、会找掩体、会撤退找血包
 *   - 会按武器距离选择交战距离（喷子贴脸、狙击拉远）
 *   - 会占点（dom 模式）
 *   - 有难度分级，可以整体调强
 */

import { KEY, CLASSES } from './constants.js';
import { currentWeapon } from './sim.js';
import { getNavMesh } from './nav.js';

const BOT_NAMES = [
  'Raze', 'Wheel', 'Dex', 'Jyn', 'Frost', 'Vex', 'Tank', 'Sparks', 'Nova',
  'Ghost', 'Rook', 'Blitz', 'Cinder', 'Bolt', 'Hex', 'Mace', 'Vandal', 'Pyro',
  'Sly', 'Duke', 'Riff', 'Kilo', 'Echo', 'Neon', 'Grit', 'Vega', 'Onyx', 'Zed',
];

const DIFF = {
  1: { aimErr: 0.20, react: 0.55, lead: 0.2, moveErr: 0.55, firePatience: 0.35, skillUse: 0.25 },
  2: { aimErr: 0.12, react: 0.36, lead: 0.45, moveErr: 0.35, firePatience: 0.55, skillUse: 0.5 },
  3: { aimErr: 0.07, react: 0.24, lead: 0.7, moveErr: 0.22, firePatience: 0.7, skillUse: 0.7 },
  4: { aimErr: 0.038, react: 0.15, lead: 0.92, moveErr: 0.12, firePatience: 0.85, skillUse: 0.88 },
  5: { aimErr: 0.018, react: 0.085, lead: 1.0, moveErr: 0.05, firePatience: 0.95, skillUse: 1.0 },
};

let nameCursor = 0;
export function botName() {
  const n = BOT_NAMES[nameCursor % BOT_NAMES.length];
  nameCursor++;
  return n;
}

export function resetBotNames() { nameCursor = 0; }

/**
 * 为所有 bot 初始化个人 AI 状态。
 */
export function initBot(p, difficulty = 3) {
  if (!p.ai) p.ai = {};
  const a = p.ai;
  a.diff = a.diff || difficulty;
  a.moveDir = Math.random() < 0.5 ? -1 : 1;
  a.moveTimer = 0;
  a.target = null;
  a.aimError = 0;
  a.aimErrTimer = 0;
  a.jumpCd = 0;
  a.shootHold = 0;
  a.reactTimer = 0;
  a.stuck = 0;
  a.lastX = p.x;
  a.lastY = p.y;
  a.roam = { x: p.x, y: p.y };
  a.roamTimer = 0;
  a.state = 'roam';
  a.stateTimer = 0;
  a.strafe = Math.random() < 0.5 ? -1 : 1;
  a.strafeTimer = 0;
  a.retreat = false;
  a.weaponPlan = 0;
  a.skillWait = 0;
  a.pickTarget = null;
  a.detour = 0;
  a.detourDir = 1;
  a.lastSeen = null;
  a.jumpHold = 0;
  a.stallTimer = 0;
  a.flankDir = 1;
  a.orbitSide = 0;
  a.orbitTimer = 0;
  a.waypoint = null;
  a.repathTimer = 0;
}

export function setDifficulty(p, d) {
  if (!p.ai) initBot(p, d);
  p.ai.diff = Math.max(1, Math.min(5, d | 0));
}

/**
 * 每个权威 tick 调用一次：写 p.keys 与 p.aimAngle。
 * aiOnlyAllies=true 时（纯人类房间）本函数不会被调用。
 */
export function botThink(p, world) {
  if (!p.ai) initBot(p);
  const a = p.ai;
  const cfg = DIFF[a.diff] || DIFF[3];
  const dt = 1 / 60;

  const w = currentWeapon(p);
  const cls = CLASSES[p.cls];

  a.jumpCd = Math.max(0, a.jumpCd - dt);
  a.aimErrTimer -= dt;
  a.strafeTimer -= dt;
  a.moveTimer -= dt;
  a.roamTimer -= dt;
  a.stateTimer -= dt;
  a.skillWait -= dt;

  // 本 tick 的位移量（用于卡滞判定，必须在决策前算好）
  const moved = Math.hypot(p.x - a.lastX, p.y - a.lastY);

  /* ---------- 1. 选目标 ---------- */
  a.target = pickEnemy(p, world, a);
  const tgt = a.target;
  if (tgt) {
    // 注意：必须用模拟时间 world.time，不能用 Date.now()——
    // 服务端一帧推进几十个 tick，墙钟时间在这里不可用。
    a.lastSeen = { x: tgt.x + tgt.w / 2, t: world.time };
    a.roamTimer = Math.min(a.roamTimer, 1.2);   // 交战期间缩短导航刷新
  }

  /* ---------- 2. 求生：血量低就找血包 / 撤退 ---------- */
  const lowHp = p.hp < p.maxHp * 0.35;
  if (lowHp && !a.retreat) {
    const pack = nearestPickup(p, world, 'health');
    if (pack) { a.pickTarget = pack; a.retreat = true; a.state = 'seek'; a.stateTimer = 6; }
  }
  if (a.retreat && p.hp > p.maxHp * 0.72) { a.retreat = false; a.pickTarget = null; }
  if (a.state === 'seek' && !a.pickTarget) a.retreat = false;

  /* ---------- 3. 技能 ---------- */
  if (a.skillWait <= 0 && Math.random() < cfg.skillUse * dt * 2.2) {
    const s = cls.skill;
    const should = (s.id === 'nano' && p.hp < p.maxHp * 0.55) ||
      (s.id === 'ironskin' && tgt && dist(p, tgt) < 260) ||
      (s.id === 'cloak' && tgt && dist(p, tgt) > 400) ||
      (s.id === 'adrenaline' && tgt && dist(p, tgt) < 620) ||
      (s.id === 'dash' && tgt && dist(p, tgt) > 90 && dist(p, tgt) < 320) ||
      (s.id === 'smoke' && (p.hp < p.maxHp * 0.6 || (tgt && dist(p, tgt) < 240)));
    if (should && p.skillCharge >= s.need) {
      p.keys |= KEY.SKILL;
      a.skillWait = 3;
      if (s.id === 'cloak') a.state = 'flank';
    }
  } else p.keys &= ~KEY.SKILL;

  /* ---------- 4. 目标选择后的行为 ---------- */
  let moveX = 0;
  let wantJump = false;
  let wantCrouch = false;
  let wantShoot = false;

  if (a.retreat && a.pickTarget) {
    // 撤退：跑向血包
    const pk = a.pickTarget;
    const dx = (pk.x) - (p.x + p.w / 2);
    moveX = Math.abs(dx) > 24 ? Math.sign(dx) : 0;
    wantJump = needJump(p, pk.x, pk.y, world);
    p.aimAngle = Math.atan2((pk.y - 20) - (p.y + p.bh * 0.4), (pk.x) - (p.x + p.w / 2));
    // 边跑边还击
    if (tgt && dist(p, tgt) < 520 && Math.random() < cfg.firePatience) wantShoot = true;
  } else if (world.mode === 'dom' && !tgt) {
    // 占点：去最近的未控/中立据点
    const pt = choosePoint(p, world);
    if (pt) {
      const dx = pt.x - (p.x + p.w / 2);
      moveX = Math.abs(dx) > pt.r * 0.55 ? Math.sign(dx) : 0;
      wantJump = needJump(p, pt.x, pt.y, world);
      p.aimAngle = Math.atan2((pt.y - 40) - (p.y + p.bh * 0.4), dx);
      if (Math.abs(dx) < 40) { moveX = 0; }
    }
  } else if (tgt) {
    /* ---- 交战 ---- */
    const d = dist(p, tgt);
    const prefer = preferredRange(w);
    const aim = aimAt(p, tgt, cfg, w, dt);

    // 目标高度差太大就跳
    if (tgt.y + tgt.bh < p.y - 30) wantJump = true;

    // 距离维持
    let wanted = 0;
    if (d > prefer.max) wanted = aim.signX;
    else if (d < prefer.min) wanted = -aim.signX;
    else {
      // 在理想距离：横向游走 + 打带跑
      if (a.strafeTimer <= 0) { a.strafe *= -1; a.strafeTimer = 0.5 + Math.random() * 0.9; }
      wanted = a.strafe;
    }

    // 绕开障碍：前方被墙挡住就跳或反向
    if (blockedAhead(p, wanted, world)) {
      if (a.jumpCd <= 0) { wantJump = true; a.jumpCd = 0.45; }
      else if (Math.random() < 0.5) wanted = -wanted;
    }

    moveX = wanted;

    // 打不到（被墙挡）就不开枪
    const clear = lineClear(p, tgt, world);
    const canSee = d < viewRange(w);

    // 僵持检测：有目标但视线不通、且自己没怎么动 → 开始计时，超时就换线
    if (!clear && moved < 3) {
      a.stallTimer = a.stallTimer > 0 ? a.stallTimer : 2.5;
    }

    if (clear && canSee) {
      a.shootHold += dt * (1 + cfg.firePatience);
      if (a.shootHold > cfg.react * 1.6) wantShoot = true;
    } else if (canSee && d < 320) {
      // 近距离但视线略被挡：压制射击（子弹能绕过矮掩体，也能逼对手挪位置）
      a.shootHold += dt;
      if (a.shootHold > cfg.react * 2.4) wantShoot = true;
    } else {
      a.shootHold = 0;

      /* 视线被挡：走导航图绕过去（这是唯一可靠的解法） */
      const ls = a.lastSeen;
      const wantX = (ls && world.time - ls.t < 8) ? ls.x : (tgt.x + tgt.w / 2);
      const dirX = Math.sign(wantX - (p.x + p.w / 2)) || aim.signX;

      // 每 0.4 秒重算一次路点（BFS 不算贵，但没必要每帧跑）
      a.repathTimer -= dt;
      if (a.repathTimer <= 0 || !a.waypoint) {
        a.repathTimer = 0.4 + Math.random() * 0.25;
        const nav = getNavMesh(world.map);
        a.waypoint = nav.nextWaypoint(p, wantX, tgt.y + tgt.bh);
      }

      // 战术优先：如果只是被矮掩体挡住，先横向挪一下找射界（比绕远路快得多）
      const peek = findPeek(p, tgt, world, dirX);
      if (peek !== 0) {
        moveX = peek;
        a.waypoint = null;
        a.repathTimer = Math.min(a.repathTimer, 0.15);
      } else if (a.waypoint) {
        const wdx = a.waypoint.x - (p.x + p.w / 2);
        const wdy = a.waypoint.y - (p.y + p.bh);
        moveX = Math.abs(wdx) > 18 ? Math.sign(wdx) : 0;
        // 需要往上跳才到得了
        if (wdy < -20 && p.onGround && a.jumpCd <= 0) { wantJump = true; a.jumpCd = 0.22; }
        // 前方有矮障碍也跳
        if (moveX !== 0 && blockedAhead(p, moveX, world) && p.onGround && a.jumpCd <= 0) {
          wantJump = true; a.jumpCd = 0.22;
        }
      } else {
        // 没有路点就直着走
        moveX = dirX;
        if (blockedAhead(p, dirX, world) && p.onGround && a.jumpCd <= 0) {
          wantJump = true; a.jumpCd = 0.28;
        }
      }

      // 僵持太久（路点也算不出来）→ 换目标点重算
      if (a.stallTimer > 0) {
        a.stallTimer -= dt;
        if (a.stallTimer <= 0) {
          a.waypoint = null;
          a.repathTimer = 0;
          a.roamTimer = 0;
        }
      }
    }

    // 坦克/喷子贴脸时举盾
    if (w && w.shield && d < 130) wantCrouch = true;
    // 狙击/机枪站桩时蹲下（更稳）
    if (d > 500 && (w.scope || w.spinUp)) wantCrouch = false;

    // 换弹：安全时换
    const slot = p.wp[p.slot];
    if (slot && slot.mag > 0 && slot.ammo <= 0 && slot.reserve > 0) {
      p.keys &= ~KEY.SHOOT; // 让 stepWeapon 自动换弹
    }
  } else {
    /* ---- 无目标：主动搜索推进（往敌方半场压，才会遇敌） ---- */
    if (a.roamTimer <= 0) {
      // 战役敌人要频繁重算，避免在远处徘徊
      a.roamTimer = world.mode === 'campaign' ? (1.6 + Math.random() * 1.4) : (3.5 + Math.random() * 3.5);
      const map = world.map;
      // 主推进方向：blue 往右、red 往左、ffa 往中间偏随机
      const myCenter = p.x + p.w / 2;
      let baseX;
      if (world.mode === 'ffa') {
        baseX = map.width * 0.5 + (Math.random() - 0.5) * map.width * 0.7;
      } else if (world.mode === 'dom') {
        const pt = choosePoint(p, world);
        baseX = pt ? pt.x + (Math.random() - 0.5) * 120 : (p.team === 'blue' ? map.width * 0.72 : map.width * 0.28);
      } else if (world.mode === 'campaign') {
        // 战役：红方必须主动压向蓝方，否则会缩在出生点等着被打
        if (p.team === 'red') {
          const seen = lastSeenEnemyX(a);
          // 优先锁定最近的蓝方玩家（战役里玩家是唯一威胁）
          let nearest = null, nd = Infinity;
          for (const q of world.players.values()) {
            if (q.team !== 'blue' || !q.alive) continue;
            const d = Math.abs(q.x - myCenter);
            if (d < nd) { nd = d; nearest = q; }
          }
          // 距离过远（>700）时直接压上去，不受巡逻抖动影响
          if (nearest && nd > 700) {
            baseX = nearest.x;
          } else if (seen != null && Math.random() < 0.7) {
            baseX = seen;
          } else if (nearest) {
            baseX = nearest.x + (Math.random() - 0.5) * 140;
          } else {
            baseX = map.width * 0.4;
          }
        } else {
          // 蓝方（玩家队）：守据点或原地警戒，不要盲目乱跑
          const pt = choosePoint(p, world);
          baseX = pt ? pt.x + (Math.random() - 0.5) * 160 : myCenter + (Math.random() - 0.5) * 240;
        }
      } else {
        // TDM：直奔敌方半场，同时带一点抖动避免所有人挤一条线
        const toward = p.team === 'blue' ? 1 : -1;
        const enemyBase = p.team === 'blue' ? map.width * 0.72 : map.width * 0.28;
        const seen = lastSeenEnemyX(a);
        baseX = (seen != null && Math.random() < 0.65)
          ? seen
          : enemyBase + (Math.random() - 0.5) * map.width * 0.26;
        // 已经深入敌后太久就回撤换线
        const deep = toward > 0 ? (myCenter > map.width * 0.78) : (myCenter < map.width * 0.22);
        if (deep && Math.random() < 0.5) baseX = map.width * 0.5 + (Math.random() - 0.5) * 300;
      }
      a.roam = { x: Math.max(90, Math.min(map.width - 90, baseX)), y: 300 + Math.random() * 480 };
    }

    const dx = a.roam.x - (p.x + p.w / 2);
    const roaming = Math.abs(dx) > 46;

    // 巡逻也用导航图，保证真的能走过去
    a.repathTimer -= dt;
    if (a.repathTimer <= 0 || !a.waypoint) {
      a.repathTimer = 0.5 + Math.random() * 0.3;
      const nav = getNavMesh(world.map);
      a.waypoint = nav.nextWaypoint(p, a.roam.x, a.roam.y);
    }

    if (a.waypoint) {
      const wdx = a.waypoint.x - (p.x + p.w / 2);
      const wdy = a.waypoint.y - (p.y + p.bh);
      moveX = Math.abs(wdx) > 18 ? Math.sign(wdx) : 0;
      if (wdy < -20 && p.onGround && a.jumpCd <= 0) { wantJump = true; a.jumpCd = 0.22; }
      if (moveX !== 0 && blockedAhead(p, moveX, world) && p.onGround && a.jumpCd <= 0) {
        wantJump = true; a.jumpCd = 0.22;
      }
    } else {
      moveX = roaming ? Math.sign(dx) : a.strafe;
      if (moveX !== 0 && blockedAhead(p, moveX, world) && p.onGround && a.jumpCd <= 0) {
        wantJump = true; a.jumpCd = 0.24;
      }
    }
    p.aimAngle = lerpAngle(p.aimAngle, moveX >= 0 ? 0 : Math.PI, 0.1);

    // 弹药不够时顺路捡弹药
    const needAmmo = (p.wp.primary.reserve <= 0 && p.wp.primary.def.mag > 0) ||
      (p.wp.secondary.reserve <= 0);
    if (needAmmo) {
      const pk = nearestPickup(p, world, 'ammo');
      if (pk) a.pickTarget = pk;
    } else if (a.pickTarget && a.pickTarget.type === 'ammo') {
      a.pickTarget = null;
    }
    if (a.pickTarget && !a.retreat) {
      const ddx = a.pickTarget.x - (p.x + p.w / 2);
      moveX = Math.abs(ddx) > 26 ? Math.sign(ddx) : 0;
      wantJump = needJump(p, a.pickTarget.x, a.pickTarget.y, world);
    }
  }

  /* ---------- 5. 卡住自救（分级处理，避免方向反复横跳） ---------- */
  if (moved < 1.6) a.stuck += dt; else a.stuck = Math.max(0, a.stuck - dt * 1.8);
  a.lastX = p.x; a.lastY = p.y;

  // 绕行计时器：生效期间强制走 detourDir，结束后再回到正常导航
  if (a.detour > 0) {
    a.detour -= dt;
    moveX = a.detourDir;
    wantJump = wantJump || a.jumpCd <= 0;
    if (a.jumpCd <= 0) a.jumpCd = 0.3;
  } else if (a.stuck > 0.30) {
    // 第一级：原地起跳试图翻越（保持原前进方向，不要反转）
    if (a.jumpCd <= 0) { wantJump = true; a.jumpCd = 0.30; }
    // 第二级：连续卡住 → 走一段绕行方向，并换一个导航目标
    if (a.stuck > 0.85) {
      a.detour = 0.9;
      a.detourDir = -(moveX || a.strafe || 1);
      a.strafe = a.detourDir;
      a.moveDir = a.detourDir;
      a.pickTarget = null;
      a.roamTimer = 0;
      a.stuck = 0;
      a.lastX = p.x; a.lastY = p.y;
    }
  }

  /* ---------- 6. 写入按键 ---------- */
  // 跳跃必须「按住」而不是点按：sim 里有 JUMP_CUT，松手会把跳跃削掉一大半
  // （130px 的满跳会被削到 26px，连矮箱子都翻不过去）
  if (wantJump && p.onGround) a.jumpHold = 0.30;
  if (a.jumpHold > 0) { a.jumpHold -= dt; wantJump = true; }
  else if (!wantJump) wantJump = false;

  let keys = 0;
  if (moveX < 0) keys |= KEY.LEFT;
  if (moveX > 0) keys |= KEY.RIGHT;
  if (wantJump) keys |= KEY.UP;
  if (wantCrouch) keys |= KEY.DOWN;
  if (wantShoot) keys |= KEY.SHOOT;
  p.keys = keys;

  p.aimAngle = normalize(p.aimAngle);
  a.state = a.retreat ? 'retreat' : (tgt ? 'fight' : 'roam');
}

/* ------------------------------------------------------------------ */
/*  感知辅助                                                            */
/* ------------------------------------------------------------------ */

function dist(p, q) {
  return Math.hypot((q.x + q.w / 2) - (p.x + p.w / 2), (q.y + q.bh / 2) - (p.y + p.bh / 2));
}

function viewRange(w) {
  if (!w) return 900;
  if (w.scope) return 1800;
  if (w.shield) return 400;
  if (w.melee) return 300;
  return 1050;
}

function preferredRange(w) {
  if (!w) return { min: 100, max: 420 };
  if (w.shield) return { min: 0, max: 90 };
  if (w.melee) return { min: 0, max: 70 };
  if (w.id === 'shotgun' || w.id === 'autoShotgun') return { min: 0, max: 160 };
  if (w.scope) return { min: 420, max: 1200 };
  if (w.spinUp) return { min: 180, max: 520 };
  if (w.rocket) return { min: 260, max: 780 };
  if (w.id === 'shuriken') return { min: 140, max: 520 };
  if (w.smoke) return { min: 200, max: 620 };
  if (w.slot === 'primary') return { min: 110, max: 480 };
  return { min: 70, max: 300 };
}

function pickEnemy(p, world, a) {
  let best = null, bestScore = -Infinity;
  for (const q of world.players.values()) {
    if (!q.alive || q.id === p.id) continue;
    if (!world.isEnemyOf(p.team, q)) continue;
    const d = dist(p, q);
    if (d > viewRange(currentWeapon(p))) continue;
    // 优先：血少的、正在打我的、距离近的
    let sc = 1400 - d * 0.7;
    sc += (q.hp < q.maxHp * 0.4) ? 320 : 0;
    if (q.lastHitBy === p.id && world.time - q.lastHitAt < 2) sc += 180;
    if (q.id === p.lastHitBy && world.time - p.lastHitAt < 1.5) sc += 260;
    if (q.skillActive && CLASSES[q.cls].skill.id === 'cloak') sc -= 500;
    if (sc > bestScore) { bestScore = sc; best = q; }
  }
  void a;
  return best;
}

function aimAt(p, tgt, cfg, w, dt) {
  const mx = p.x + p.w / 2;
  const my = p.y + p.bh * 0.36;
  const tx = tgt.x + tgt.w / 2 + tgt.vx * cfg.lead * 0.12;
  const ty = tgt.y + tgt.bh * 0.42 + tgt.vy * cfg.lead * 0.06;

  // 预瞄误差随时间缓慢漂移，避免一帧内瞬移瞄准
  const a = p.ai;
  if (a.aimErrTimer <= 0) {
    a.aimErrTimer = 0.35 + Math.random() * 0.5;
    a.aimError = (Math.random() - 0.5) * 2 * cfg.aimErr;
  }
  // 移动中更难瞄
  const movePenalty = Math.min(1, Math.hypot(p.vx, p.vy) / 300) * cfg.aimErr * 0.5;

  const ideal = Math.atan2(ty - my, tx - mx) + a.aimError + (Math.random() - 0.5) * movePenalty;
  // 平滑转向（高手转得快）
  const turn = (0.10 + cfg.lead * 0.16) * (60 * dt) * 1.0;
  p.aimAngle = lerpAngle(p.aimAngle, ideal, Math.min(1, turn));
  void w;
  return { signX: Math.sign(tx - mx) || 1 };
}

function needJump(p, targetX, targetY, world) {
  if (!p.onGround) return false;
  const myFoot = p.y + p.bh;
  const centerX = p.x + p.w / 2;

  // 目标明显在上方 → 跳
  if (targetY < p.y - 60) return true;

  const dir = Math.sign(targetX - centerX) || 1;

  // 前方预判：在 96~20px 的窗口内发现可跳越障碍就提前起跳
  // （撞上才跳会被卡在侧壁上，这是必须提前的原因）
  for (let ahead = 92; ahead >= 18; ahead -= 12) {
    const px = p.x + (dir > 0 ? p.w + ahead : -ahead);
    for (const s of world.solids) {
      if (px <= s.x || px >= s.x + s.w) continue;
      // 障碍顶面高度
      const rise = myFoot - s.y;
      if (rise > 6 && rise < MAX_JUMP_H) return true;      // 可跳越的抬升
      if (rise <= 6 && s.y + s.h > myFoot) return false;   // 比自己高太多，别跳
    }
  }

  // 前方是坑 → 跳过去
  const probeX = centerX + dir * 52;
  let ground = false;
  for (const s of [...world.solids, ...world.plats]) {
    if (probeX > s.x && probeX < s.x + s.w && myFoot >= s.y - 12 && myFoot <= s.y + 34) { ground = true; break; }
  }
  if (!ground && Math.abs(targetX - centerX) < 380) return true;

  return false;
}

const MAX_JUMP_H = 120;   // 与 PHYS 跳跃高度保持一致

/** 最近一次「看见敌人」的位置记录（用于 TDM 搜索） */
function lastSeenEnemyX(a) {
  if (!a.lastSeen) return null;
  return a.lastSeen.x;
}

/**
 * 找射界：当前视线被挡，试着左右挪一点能不能看见目标。
 * 返回 ±1（挪动方向）或 0（不用挪，绕不过去）。
 * 这是「掩体对枪」最基本的战术动作，比绕大圈更快见效。
 */
function findPeek(p, tgt, world, dirX) {
  const myY = p.y + p.bh * 0.30;
  // 依次试：小步左右 → 稍大步左右
  const offsets = [22, -22, 44, -44, 70, -70];
  for (const off of offsets) {
    const nx = p.x + off;
    // 目标位置不能跑出地图
    if (nx < 8 || nx > world.map.width - p.w - 8) continue;
    // 新位置要能站人
    if (world.solids.some(s => nx < s.x + s.w && nx + p.w > s.x && p.y < s.y + s.h && p.y + p.bh > s.y)) continue;

    const tx = tgt.x + tgt.w / 2;
    const ty = tgt.y + tgt.bh * 0.42;
    const x1 = nx + p.w / 2, y1 = myY;
    const steps = 12;
    let clear = true;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x1 + (tx - x1) * t;
      const y = y1 + (ty - y1) * t;
      for (const s of world.solids) {
        if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) { clear = false; break; }
      }
      if (!clear) break;
    }
    if (clear) return Math.sign(off);
  }
  void dirX;
  return 0;
}

function blockedAhead(p, dir, world) {
  if (dir === 0) return false;
  const probeX = p.x + (dir > 0 ? p.w + 10 : -10);
  const y1 = p.y + 8, y2 = p.y + p.bh - 8;
  for (const s of world.solids) {
    if (probeX > s.x && probeX < s.x + s.w && y2 > s.y && y1 < s.y + s.h) return true;
  }
  return false;
}

/**
 * 沿障碍绕行：正前方被挡时，返回一个「侧向绕行方向」。
 * 绕行方向由障碍的哪一侧更短决定，并且带记忆（避免左右抖）。
 */
function detourAround(p, dir, world) {
  const probeX = p.x + (dir > 0 ? p.w + 12 : -12);
  const y1 = p.y + 8, y2 = p.y + p.bh - 8;
  let hit = null;
  for (const s of world.solids) {
    if (probeX > s.x && probeX < s.x + s.w && y2 > s.y && y1 < s.y + s.h) { hit = s; break; }
  }
  if (!hit) return null;

  // 该障碍离地高度：如果矮（可跳越），优先跳
  const rise = (p.y + p.bh) - hit.y;
  if (rise > 8 && rise < MAX_JUMP_H - 8) return { jump: true };

  // 太高跳不过 → 沿它的一侧走开
  const centerX = p.x + p.w / 2;
  const toLeft = Math.abs(centerX - hit.x);
  const toRight = Math.abs((hit.x + hit.w) - centerX);
  // 往近的一侧退，退出去后就能从旁边绕
  return { side: toLeft < toRight ? -1 : 1 };
}

/**
 * 找一个「能跳上去、比现在高、且朝目标方向」的中转平台。
 * 这是破解「隔墙对视」僵局的关键：先抢高点，视线自然就通了。
 */
function findPerch(p, world, dirX) {
  const foot = p.y + p.bh;
  let best = null, bestCost = Infinity;
  const all = [...world.plats, ...world.solids.filter(s => s.h <= 30)];
  for (const s of all) {
    const top = s.y;
    const rise = foot - top;
    if (rise < 24 || rise > MAX_JUMP_H) continue;          // 必须在单跳范围内
    const cx = Math.max(s.x + 16, Math.min(p.x + p.w / 2 + dirX * 120, s.x + s.w - 16));
    const dx = Math.abs(cx - (p.x + p.w / 2));
    if (dx > 190) continue;                                // 不能太远
    // 越朝目标方向越优先
    const align = (cx - (p.x + p.w / 2)) * dirX;
    if (align < -40) continue;                             // 别往反方向爬
    const cost = dx * 0.6 - align * 0.4 + rise * 0.5;
    if (cost < bestCost) { bestCost = cost; best = { cx, cy: top }; }
  }
  return best;
}

/** 简化视线检测：沿直线采样，看是否撞到实体墙 */
function lineClear(p, tgt, world) {
  const x1 = p.x + p.w / 2, y1 = p.y + p.bh * 0.36;
  const x2 = tgt.x + tgt.w / 2, y2 = tgt.y + tgt.bh * 0.42;
  const steps = 14;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (const s of world.solids) {
      if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return false;
    }
  }
  return true;
}

function nearestPickup(p, world, kind) {
  let best = null, bd = Infinity;
  for (const pk of world.pickupState) {
    if (pk.type !== kind) continue;
    if (pk.cd > 0) continue;
    const d = Math.hypot(pk.x - (p.x + p.w / 2), (pk.y - 20) - (p.y + p.bh / 2));
    if (d < bd) { bd = d; best = pk; }
  }
  return bd < 1400 ? best : null;
}

function choosePoint(p, world) {
  const camp = world.mode === 'campaign';

  // 战役：蓝方必须守满目标据点，所以严格按「补缺口」分配，
  // 避免所有人都挤在同一个点上，导致其余据点被敌人白拿。
  if (camp && world.level && world.level.objective === 'capture') {
    const ids = world.level.capturePoints || null;
    const pool = ids ? world.points.filter(pt => ids.includes(pt.id)) : world.points;
    const need = ids ? pool.length : (world.level.captureNeed || 2);
    const mine = pool.filter(pt => pt.owner === p.team && pt.prog >= 1);
    // 还缺就抢新的（按距离优先）
    if (mine.length < need) {
      let best = null, bd = Infinity;
      for (const pt of pool) {
        if (pt.owner === p.team && pt.prog >= 1) continue;
        const d = Math.abs(pt.x - (p.x + p.w / 2));
        if (d < bd) { bd = d; best = pt; }
      }
      if (best) return best;
    }
    // 已经够了：守在被争夺的点上，否则守最近的自有点
    const contested = mine.find(pt => pt.contest);
    if (contested) return contested;
    let stay = null, sd = Infinity;
    for (const pt of mine) {
      const d = Math.abs(pt.x - (p.x + p.w / 2));
      if (d < sd) { sd = d; stay = pt; }
    }
    if (stay) return stay;
  }

  // 1. 优先救「正在被敌人抢的自己的点」
  for (const pt of world.points) {
    if (pt.owner === p.team && pt.contest) return pt;
  }
  // 2. 其次抢中立或敌方的点
  let best = null, bd = Infinity;
  for (const pt of world.points) {
    if (pt.owner === p.team && pt.prog >= 1) continue;
    const d = Math.hypot(pt.x - (p.x + p.w / 2), pt.y - (p.y + p.bh));
    if (d < bd) { bd = d; best = pt; }
  }
  if (best) return best;
  // 3. 全都占满了：守在最近的点上（别乱跑丢点）
  let stay = null, sd = Infinity;
  for (const pt of world.points) {
    const d = Math.hypot(pt.x - (p.x + p.w / 2), pt.y - (p.y + p.bh));
    if (d < sd) { sd = d; stay = pt; }
  }
  return stay;
}

function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function normalize(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
