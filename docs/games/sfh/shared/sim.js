/**
 * 权威世界模拟 —— 服务端与客户端共用同一份代码。
 *   服务端：以 60Hz 固定步长推进世界，判定一切命中与得分。
 *   客户端：用同样的步长做本地预测，并靠快照回滚校正。
 *
 * 因此这里的任何改动都必须保持双方一致；不要把随机因素写进权威路径。
 */

import {
  PHYS, KEY, COMBAT, CLASSES, TEAMS, MODES, DT,
} from './constants.js';
import { getWeapon, damageAt } from './weapons.js';
import { pointInRect, getMap } from './maps.js';
import { getLevel } from './campaign.js';

let _uid = 1;
export function nextId(prefix = 'e') { return `${prefix}${(_uid++).toString(36)}`; }

/* ------------------------------------------------------------------ */
/*  移动（客户端预测也调用这一段）                                      */
/* ------------------------------------------------------------------ */

/** 站立 / 下蹲时的碰撞盒高度 */
export function boxHeight(p) { return p.crouch ? PHYS.CROUCH_H : PHYS.H; }

/** 玩家脚下位置 */
export function feetY(p) { return p.y + p.bh; }

/**
 * 应用一次水平加速与摩擦。返回新的 vx。
 */
export function stepHorizontal(p, keys, dt, speedMul) {
  const left = !!(keys & KEY.LEFT);
  const right = !!(keys & KEY.RIGHT);
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  const accel = (p.onGround ? PHYS.GROUND_ACCEL : PHYS.AIR_ACCEL);
  const max = PHYS.MOVE_MAX * speedMul;

  if (dir !== 0) {
    p.vx += dir * accel * dt;
    if (Math.abs(p.vx) > max) p.vx = dir * max;
  } else {
    const fr = (p.onGround ? PHYS.GROUND_FRICTION : PHYS.AIR_FRICTION) * dt;
    if (Math.abs(p.vx) <= fr) p.vx = 0;
    else p.vx -= Math.sign(p.vx) * fr;
  }
  return dir;
}

/** 垂直速度与跳跃 */
export function stepVertical(p, keys, dt) {
  const wantJump = !!(keys & KEY.UP);

  // 跳跃缓冲 + 土狼时间
  if (wantJump && !p._jumpHeld) p._jumpBuf = PHYS.JUMP_BUFFER;
  p._jumpHeld = wantJump;
  if (p._jumpBuf > 0) p._jumpBuf -= dt;
  if (p._coyote > 0) p._coyote -= dt;

  if (p._jumpBuf > 0 && p._coyote > 0) {
    p.vy = PHYS.JUMP_V * (p.jumpMul || 1);
    p._jumpBuf = 0;
    p._coyote = 0;
    p.onGround = false;
    p._jumping = true;
  }
  // 提前松手 → 矮跳
  if (p._jumping && !wantJump && p.vy < 0) {
    p.vy *= PHYS.JUMP_CUT;
    p._jumping = false;
  }
  if (p.vy >= 0) p._jumping = false;

  p.vy += PHYS.GRAVITY * dt;
  if (p.vy > PHYS.MAX_FALL) p.vy = PHYS.MAX_FALL;
}

/**
 * 分轴碰撞解算。solids 为实体，plats 为单向平台。
 */
export function resolveCollisions(p, dt, solids, plats) {
  // ---- X 轴 ----
  p.x += p.vx * dt;
  for (const s of solids) {
    if (!overlap(p, s)) continue;
    if (p.vx > 0) p.x = s.x - p.w;
    else if (p.vx < 0) p.x = s.x + s.w;
    p.vx = 0;
  }

  // ---- Y 轴 ----
  const prevBottom = feetY(p);
  p.y += p.vy * dt;
  const wasGround = p.onGround;
  p.onGround = false;

  for (const s of solids) {
    if (!overlap(p, s)) continue;
    if (p.vy > 0) {
      p.y = s.y - p.bh;
      p.vy = 0;
      p.onGround = true;
    } else if (p.vy < 0) {
      p.y = s.y + s.h;
      p.vy = 0;
    }
  }

  // 单向平台：只在「从上往下」且上一帧脚底在平台顶面之上时才接住
  const downOnly = !(KEY.DOWN_ONLY);
  for (const s of plats) {
    if (!overlap(p, s)) continue;
    if (p.vy >= 0 && prevBottom <= s.y + 6) {
      p.y = s.y - p.bh;
      p.vy = 0;
      p.onGround = true;
    }
  }
  void downOnly;
  void wasGround;

  // 掉出地图
  if (p.y > 2000) {
    p.vy = 0;
    p.y = -400;
    p.x = Math.min(Math.max(p.x, 40), 3400);
  }
}

function overlap(p, s) {
  return p.x < s.x + s.w && p.x + p.w > s.x && p.y < s.y + s.h && p.y + p.bh > s.y;
}

/**
 * 完整一步移动（客户端预测复用）。
 */
export function stepPlayerMovement(p, keys, dt, solids, plats, speedMul) {
  syncCrouch(p, keys, solids);
  const dir = stepHorizontal(p, keys, dt, speedMul);
  if (dir !== 0) p.facing = dir;
  stepVertical(p, keys, dt);
  resolveCollisions(p, dt, solids, plats);
  if (p.onGround) p._coyote = PHYS.COYOTE_TIME;
}

/** 处理下蹲与起身（起身前检查头顶空间） */
function syncCrouch(p, keys, solids) {
  const wantCrouch = !!(keys & KEY.DOWN) && p.onGround;
  if (wantCrouch && !p.crouch) {
    p.crouch = true;
    p.y += PHYS.H - PHYS.CROUCH_H;
    p.bh = PHYS.CROUCH_H;
  } else if (!wantCrouch && p.crouch) {
    const test = { x: p.x, y: p.y - (PHYS.H - PHYS.CROUCH_H), w: p.w, h: PHYS.H };
    let blocked = false;
    for (const s of solids) {
      if (test.x < s.x + s.w && test.x + test.w > s.x && test.y < s.y + s.h && test.y + test.h > s.y) { blocked = true; break; }
    }
    if (!blocked) {
      p.crouch = false;
      p.y -= PHYS.H - PHYS.CROUCH_H;
      p.bh = PHYS.H;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  世界                                                                */
/* ------------------------------------------------------------------ */

export class World {
  constructor({ mode = 'tdm', mapId = 'labs', scoreLimit = null, timeLimit = null, levelId = null } = {}) {
    // 战役模式：地图与规则由关卡决定
    const level = mode === 'campaign' ? getLevel(levelId) : null;
    if (level) mapId = level.mapId;

    const map = requireMap(mapId);
    this.mapId = map.id;
    this.map = map;
    this.mode = mode;
    this.modeCfg = MODES[mode] || MODES.tdm;
    this.scoreLimit = scoreLimit || this.modeCfg.scoreLimit;
    // 战役不受 8 分钟常规时限约束（目标是击杀数/守点，给足时间）
    this.timeLimit = level ? 900 : (timeLimit || this.modeCfg.timeLimit);

    // ---- 战役状态 ----
    this.level = level;
    this.levelId = level ? level.id : null;
    this.camp = level ? {
      phase: 'wave',          // wave | cleared | failed
      wave: 0,
      waveTimer: level.waves[0].delay,
      spawnedTotal: 0,
      target: level.target,
      holdTimer: 0,           // capture 模式的保持计时
      killedByPlayer: 0,      // 玩家方击杀计数
      deaths: 0,              // 玩家方阵亡数
    } : null;
    this.pendingSpawns = [];  // 服务端消费：需要生成的敌人数

    this.solids = map.platforms.filter(p => p.type === 'solid');
    this.plats = map.platforms.filter(p => p.type === 'plat');

    this.players = new Map();
    this.bullets = [];
    this.smokes = [];
    this.pickupState = (map.pickups || []).map((pk, i) => ({ ...pk, i, cd: 0 }));

    this.tick = 0;
    this.time = 0;
    this.over = false;
    this.winner = null;
    this.results = null;

    this.events = [];
    this.scores = { blue: 0, red: 0 };
    this.points = (map.points || []).map(pt => ({
      id: pt.id, x: pt.x, y: pt.y, r: pt.r,
      owner: null, prog: 0, contest: false, capTeam: null,
    }));

    this.botThink = null;      // 由服务端注入
    this.lastSpawnIdx = { blue: 0, red: 0 };
  }

  /* ---------------- 玩家管理 ---------------- */

  addPlayer({ id, name, cls = 'assault', team = 'blue', isBot = false, weapons = null }) {
    const c = CLASSES[cls] || CLASSES.assault;
    const p = {
      id, name: String(name || '士兵').slice(0, 14),
      cls, team, isBot,
      x: 0, y: 0, vx: 0, vy: 0,
      w: PHYS.W, bh: PHYS.H, crouch: false,
      facing: 1, aim: 0,
      onGround: false, _coyote: 0, _jumpBuf: 0, _jumpHeld: false, _jumping: false,
      maxHp: c.hp, hp: c.hp, alive: true,
      respawnAt: 0, spawnProtect: 0,
      speedMul: c.speedMul, jumpMul: c.jumpMul,
      wp: buildLoadout(cls, weapons),
      slot: 'primary',
      fireCd: 0, reloadEnd: 0, burstLeft: 0, burstCd: 0,
      spin: 0, charge: 0, charging: false, swing: 0, swingHit: null,
      keys: 0, aimAngle: 0,
      kills: 0, deaths: 0, score: 0, streak: 0, bestStreak: 0,
      skillCharge: 0, skillActive: false, skillEnd: 0,
      healTick: 0,
      lastHitBy: null, lastHitAt: -99,
      seq: 0,
      joinTime: 0,
      killsSinceDeath: 0,
    };
    this.players.set(id, p);
    this.respawn(p, true);
    return p;
  }

  removePlayer(id) { this.players.delete(id); }

  get list() { return [...this.players.values()]; }

  isEnemyOf(team, p) {
    if (this.mode === 'ffa') return true;
    return p.team !== team;
  }

  /* ---------------- 出生点 ---------------- */

  respawn(p, initial = false) {
    const map = this.map;
    const pool = this.mode === 'ffa' ? (map.spawn.ffa || map.spawn.blue) : (map.spawn[p.team] || map.spawn.blue);
    const enemies = this.list.filter(q => q.alive && q.id !== p.id && this.isEnemyOf(p.team, q));

    let best = pool[0], bestScore = -Infinity;
    for (const sp of pool) {
      let near = Infinity;
      for (const e of enemies) near = Math.min(near, Math.abs((e.x) - sp.x));
      const score = (near === Infinity ? 9999 : near) + Math.random() * 60;
      if (score > bestScore) { bestScore = score; best = sp; }
    }

    p.x = best.x - p.w / 2;
    p.y = best.y - PHYS.H;
    p.vx = 0; p.vy = 0;
    p.crouch = false; p.bh = PHYS.H;
    p.hp = p.maxHp;
    p.alive = true;
    p.skillActive = false;
    p.skillEnd = 0;
    p.charge = 0; p.charging = false;
    p.fireCd = 0; p.reloadEnd = 0; p.burstLeft = 0; p.spin = 0;
    p.wp = buildLoadout(p.cls, null, p.wp);
    p.spawnProtect = initial ? 1.2 : COMBAT.SPAWN_PROTECT;
    p.onGround = false;
    if (!initial) this.events.push({ t: 'respawn', id: p.id, x: p.x, y: p.y });
  }

  /* ---------------- 主循环 ---------------- */

  step() {
    const dt = DT;
    this.tick++;
    this.time += dt;

    for (const p of this.list) {
      if (p.spawnProtect > 0) p.spawnProtect = Math.max(0, p.spawnProtect - dt);
      if (!p.alive) {
        if (this.time >= p.respawnAt && !this.over) this.respawn(p);
        continue;
      }
      if (p.isBot && this.botThink) {
        this.botThink(p, this);
      }
      this.stepPlayer(p, dt);
    }

    this.stepBullets(dt);
    this.stepPickups(dt);
    this.stepSmokes(dt);
    this.stepMode(dt);
    this.stepTimers(dt);
  }

  stepPlayer(p, dt) {
    const w = currentWeapon(p);

    // 技能计时
    if (p.skillActive && this.time >= p.skillEnd) {
      p.skillActive = false;
      this.events.push({ t: 'skillEnd', id: p.id });
    }

    // 速度修正：技能 / 举盾 / 转轮预热
    let speedMul = p.speedMul;
    if (p.skillActive && CLASSES[p.cls].skill.id === 'cloak') speedMul *= 1.35;
    if (p.skillActive && CLASSES[p.cls].skill.id === 'smoke') speedMul *= 1.25;
    if (p.skillActive && CLASSES[p.cls].skill.id === 'dash') speedMul *= 1.5;
    if (w && w.shield && (p.keys & KEY.DOWN) && p.onGround) speedMul *= 0.55;
    if (w && w.moveMul && p.charging) speedMul *= w.moveMul;
    if (p.reloadEnd > 0) speedMul *= 0.85;

    stepPlayerMovement(p, p.keys, dt, this.solids, this.plats, speedMul);

    // 瞄准角：玩家用客户端上传值，AI 用自身计算值
    if (!p.isBot) p.aim = p.aimAngle;

    // 换弹 / 武器
    if (p.reloadEnd > 0 && this.time >= p.reloadEnd) {
      p.reloadEnd = 0;
      const slot = p.slot;
      const cur = p.wp[slot];
      if (cur && cur.mag > 0) {
        const need = cur.mag * cur.def.mag - cur.ammo;
        const take = Math.min(need, cur.reserve * cur.def.mag);
        cur.ammo += take;
        cur.reserve -= Math.round(take / cur.def.mag);
        if (cur.reserve < 0) cur.reserve = 0;
      }
    }
    if (p.fireCd > 0) p.fireCd -= dt;
    if (p.burstCd > 0) p.burstCd -= dt;
    if (p.swing > 0) p.swing -= dt;

    if (p.keys & KEY.SWITCH) {
      if (!p._switchLatch) {
        p._switchLatch = true;
        p.slot = p.slot === 'primary' ? 'secondary' : 'primary';
        p.burstLeft = 0;
        p.reloadEnd = 0;
        p.charging = false;
        p.charge = 0;
        this.events.push({ t: 'switch', id: p.id, slot: p.slot });
      }
    } else p._switchLatch = false;

    if (p.keys & KEY.RELOAD) {
      if (!p._reloadLatch) { p._reloadLatch = true; this.tryReload(p); }
    } else p._reloadLatch = false;

    if (p.keys & KEY.SKILL) {
      if (!p._skillLatch) { p._skillLatch = true; this.useSkill(p); }
    } else p._skillLatch = false;

    this.stepWeapon(p, dt, w);

    // 医疗兵被动：范围内持续治疗友军（ffa 模式下只治自己）
    if (p.cls === 'medic') {
      p.healTick += dt;
      if (p.healTick >= 0.5) {
        p.healTick = 0;
        for (const q of this.players.values()) {
          if (!q.alive) continue;
          if (this.mode === 'ffa') {
            if (q.id !== p.id) continue;
          } else if (q.team !== p.team) continue;

          const d = Math.hypot((q.x - p.x), (q.y - p.y));
          if (d > COMBAT.MEDIC_HEAL_RADIUS) continue;
          const amt = (q.id === p.id ? COMBAT.MEDIC_HEAL_RATE : COMBAT.MEDIC_HEAL_SHARE) * 0.5;
          this.heal(q, amt);
        }
      }
    }

    // 纳米治疗场：开启期间持续治疗
    if (p.skillActive && CLASSES[p.cls].skill.id === 'nano') {
      p.healTick += dt;
      if (p.healTick >= 0.5) {
        p.healTick = 0;
        for (const q of this.players.values()) {
          if (!q.alive) continue;
          if (this.mode !== 'ffa' && q.team !== p.team) continue;
          if (this.mode === 'ffa' && q.id !== p.id) continue;
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d > 190) continue;
          this.heal(q, 9);
        }
      }
    }
  }

  /* ---------------- 武器 ---------------- */

  stepWeapon(p, dt, w) {
    if (!w) return;

    // 松开扳机就复位半自动锁定
    if (!(p.keys & KEY.SHOOT)) p._fireLatch = false;

    const slot = p.wp[p.slot];
    const skill = CLASSES[p.cls].skill;
    const adrenal = p.skillActive && skill.id === 'adrenaline';

    // 盾牌：靠下蹲举盾（近战判定）
    if (w.shield) {
      const guarding = !!(p.keys & KEY.DOWN) && p.onGround;
      if (!guarding) return;
      if (p.fireCd <= 0) {
        p.fireCd = 1 / w.rate;
        p.swing = 0.22;
        this.meleeSwing(p, w);
      }
      return;
    }
    if (w.melee) {
      if ((p.keys & KEY.SHOOT) && p.fireCd <= 0) {
        p.fireCd = 1 / w.rate;
        p.swing = 0.26;
        this.meleeSwing(p, w);
      }
      return;
    }

    // 转轮机枪预热
    if (w.spinUp) {
      if (p.keys & KEY.SHOOT) p.spin = Math.min(1, p.spin + dt / w.spinUp);
      else p.spin = Math.max(0, p.spin - dt / (w.spinUp * 1.6));
    }

    // 磁轨炮蓄力
    if (w.charge) {
      if (p.keys & KEY.SHOOT) {
        if (!p.charging) { p.charging = true; p.charge = 0; this.events.push({ t: 'charge', id: p.id, on: true }); }
        p.charge = Math.min(w.charge, p.charge + dt);
      } else if (p.charging) {
        p.charging = false;
        if (p.charge >= w.charge * 0.85) this.fire(p, w, true);
        else if (p.charge > 0) this.events.push({ t: 'charge', id: p.id, on: false });
        p.charge = 0;
      }
      return;
    }

    // 弹匣打空自动换弹
    if (slot.mag > 0 && slot.ammo <= 0 && p.reloadEnd <= 0 && p.fireCd <= 0) {
      this.tryReload(p);
      return;
    }

    const wantFire = !!(p.keys & KEY.SHOOT);
    if (p.reloadEnd > 0 || p.fireCd > 0) return;
    if (!wantFire && p.burstLeft <= 0) return;
    if (w.spinUp && p.spin < 0.98) return;

    let rate = w.rate;
    if (adrenal) rate *= 2;

    // 半自动：必须松开扳机才能再开一枪
    if (!w.auto && !w.burst && p._fireLatch) return;

    if (p.burstLeft > 0) {
      if (p.burstCd > 0) return;
      this.fire(p, w, false, adrenal);
      p.burstLeft--;
      p.burstCd = w.burstGap || 0.05;
      if (p.burstLeft <= 0) p.fireCd = 1 / rate;
      return;
    }

    if (w.burst) {
      p.burstLeft = w.burst - 1;
      p.burstCd = w.burstGap || 0.05;
      this.fire(p, w, false, adrenal);
      p.fireCd = 1 / rate;
      if (!w.auto) p._fireLatch = true;
      return;
    }

    this.fire(p, w, false, adrenal);
    p.fireCd = 1 / rate;
    if (!w.auto) p._fireLatch = true;
  }

  tryReload(p) {
    const slot = p.wp[p.slot];
    if (!slot || !slot.def.reload) return;
    if (slot.reserve <= 0) return;
    if (slot.ammo >= slot.def.mag) return;
    if (p.reloadEnd > 0) return;
    p.reloadEnd = this.time + slot.def.reload;
    p.burstLeft = 0;
    p.charging = false;
    this.events.push({ t: 'reload', id: p.id, dur: slot.def.reload });
  }

  useSkill(p) {
    const s = CLASSES[p.cls].skill;
    if (p.skillCharge < s.need) return;
    p.skillCharge -= s.need;
    p.skillActive = true;
    p.skillEnd = this.time + s.dur;

    if (s.id === 'nano') this.heal(p, p.maxHp);

    // 瞬步突袭：沿瞄准方向瞬移，期间无敌（由 applyDamage 判定）
    if (s.id === 'dash') {
      const dist = 190;
      const dirX = Math.cos(p.aim);
      const nx = p.x + dirX * dist;
      // 简化的落点搜索：从远到近找一个不与实体重叠的位置
      const step = 14;
      let placed = false;
      for (let d = dist; d >= 20; d -= step) {
        const tx = p.x + dirX * d;
        if (!this.boxHitsSolid(tx, p.y, p.w, p.bh)) {
          this.events.push({ t: 'dash', id: p.id, x0: p.x + p.w / 2, y0: p.y + p.bh / 2, x1: tx + p.w / 2, y1: p.y + p.bh / 2 });
          p.x = tx;
          placed = true;
          break;
        }
      }
      if (!placed) this.events.push({ t: 'dash', id: p.id, x0: p.x + p.w / 2, y0: p.y + p.bh / 2, x1: p.x + p.w / 2, y1: p.y + p.bh / 2 });
      p.vx = 0; p.vy = 0;
    }

    // 烟遁：留下烟幕，并对附近敌人造成短暂致盲
    if (s.id === 'smoke') {
      this.smokes.push({
        x: p.x + p.w / 2, y: p.y + p.bh / 2,
        r: 150, end: this.time + s.dur,
      });
      this.events.push({ t: 'smoke', x: p.x + p.w / 2, y: p.y + p.bh / 2, r: 150, dur: s.dur });
    }

    this.events.push({ t: 'skill', id: p.id, skill: s.id, dur: s.dur });
  }

  /** 矩形是否与任意实体重叠（瞬步落点检测用） */
  boxHitsSolid(x, y, w, h) {
    for (const s of this.solids) {
      if (x < s.x + s.w && x + w > s.x && y < s.y + s.h && y + h > s.y) return true;
    }
    return false;
  }

  /** 近战挥击判定 */
  meleeSwing(p, w) {
    const reach = w.reach || 60;
    const arc = w.arc || 1.4;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.bh * 0.4;
    for (const q of this.players.values()) {
      if (!q.alive || q.id === p.id) continue;
      if (!this.isEnemyOf(p.team, q)) continue;
      const tx = q.x + q.w / 2, ty = q.y + q.bh / 2;
      const dx = tx - cx, dy = ty - cy;
      const d = Math.hypot(dx, dy);
      if (d > reach) continue;
      const ang = Math.atan2(dy, dx);
      let diff = Math.abs(normalizeAngle(ang - p.aim));
      if (diff > arc) continue;
      this.events.push({ t: 'slash', x: cx, y: cy, dir: p.facing, kind: w.shield ? 'shield' : 'blade' });
      this.applyDamage(q, w.dmg, {
        from: p.id, weapon: w.id, dir: Math.sign(dx) || p.facing, knock: w.shield ? 240 : 160,
      });
    }
  }

  /** 开火：生成服务端权威子弹 + 广播事件供客户端绘制曳光 */
  fire(p, w, charged = false, adrenal = false) {
    const muzzle = this.muzzlePos(p, w);
    const pellets = w.pellets || 1;
    const dmgMul = adrenal ? 1.25 : 1;
    const spreadBase = (p.onGround ? w.spread : Math.max(w.spread, w.moveSpread));
    const speedMul = Math.hypot(p.vx, p.vy) > 60 ? (w.moveSpread || 0.03) : 0;
    const spread = spreadBase + speedMul + (w.recoil || 0) * 0.004;
    const recoilKick = adrenal ? 0 : (w.recoil || 0);

    const angles = [];
    for (let i = 0; i < pellets; i++) {
      const a = p.aim + (Math.random() - 0.5) * 2 * spread;
      angles.push(a);
      const speed = w.speed * (charged ? 1.15 : 1);
      this.bullets.push({
        x: muzzle.x, y: muzzle.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        grav: w.grav || 0,
        dmg: (charged ? w.dmg * 1.4 : w.dmg) * dmgMul,
        owner: p.id, team: p.team, w: w.id,
        life: w.life, pierce: charged ? (w.pierce || 0) + 1 : (w.pierce || 0),
        hitIds: new Set(),
        kick: w.kick || 60,
        rocket: false, explode: w.explode || null,
        falloff: w.falloff || 0,
        spin: !!w.spin,
        smoke: w.smoke || null,
        startX: muzzle.x, startY: muzzle.y,
      });
    }

    // 弹药扣除（RPG 类单发装填）
    const slot = p.wp[p.slot];
    if (slot && slot.mag > 0) {
      slot.ammo = Math.max(0, slot.ammo - 1);
    }

    // 后坐力
    if (recoilKick > 0) {
      p.vx -= Math.cos(p.aim) * recoilKick * 0.35;
      if (p.onGround) p.vy -= Math.sin(p.aim) * recoilKick * 0.12;
    }

    // 开火破隐
    if (p.skillActive && CLASSES[p.cls].skill.id === 'cloak') {
      p.skillActive = false;
      this.events.push({ t: 'skillEnd', id: p.id, revealed: true });
    }

    this.events.push({
      t: 'shot', id: p.id, w: w.id, x: muzzle.x, y: muzzle.y,
      a: p.aim, angles, nat: angles.length, charged,
    });

    if (w.explode || w.rocket) {
      for (const b of this.bullets.slice(-pellets)) b.rocket = true;
    }
  }

  muzzlePos(p, w) {
    // 枪口高度：站立时取胸口偏上，避免子弹一出手就撞上矮掩体
    const hFrac = p.crouch ? 0.55 : 0.30;
    const cy = p.y + p.bh * hFrac;
    const len = w.scope ? 40 : 26;
    return {
      x: p.x + p.w / 2 + Math.cos(p.aim) * len,
      y: cy + Math.sin(p.aim) * len,
    };
  }

  /* ---------------- 子弹 ---------------- */

  stepBullets(dt) {
    const alive = [];
    for (const b of this.bullets) {
      if (b.dead) continue;
      b.life -= dt;
      if (b.life <= 0) {
        if (b.explode) this.explode(b);
        continue;
      }
      b.vy += b.grav * dt;

      const spd = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((spd * dt) / 9));
      const sdt = dt / steps;
      let done = false;

      // 曳光轨迹点（给客户端做插值）
      b.trail = b.trail || [];
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 6) b.trail.shift();

      for (let s = 0; s < steps && !done; s++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;

        if (b.x < -300 || b.x > this.map.width + 300 || b.y > this.map.height + 600 || b.y < -1200) {
          done = true;
          break;
        }

        // 撞墙
        for (const pl of this.solids) {
          if (!pointInRect(b.x, b.y, pl.x, pl.y, pl.w, pl.h)) continue;
          // 薄甲板/横梁（h<=30）不挡子弹：横版射击里子弹应当能穿过薄板，
          // 否则地面交火线会被脚下平台的边缘全部吃掉（实测命中率不足 1%）
          if (pl.h <= 30) continue;
          if (b.explode) this.explode(b);
          else if (b.smoke) this.popSmoke(b);
          else this.events.push({ t: 'impact', x: b.x, y: b.y, w: b.w, n: -1 });
          done = true;
          break;
        }
        if (done) break;

        // 撞人
        for (const q of this.players.values()) {
          if (!q.alive || q.id === b.owner) continue;
          if (!this.isEnemyOf(b.team, q)) continue;
          if (b.hitIds.has(q.id)) continue;
          const inX = b.x > q.x && b.x < q.x + q.w;
          const inY = b.y > q.y && b.y < q.y + q.bh;
          if (!(inX && inY)) continue;

          const head = b.y < q.y + q.bh * 0.30;
          const dist = Math.hypot(b.x - b.startX, b.y - b.startY);
          let dmg = b.falloff ? damageAt({ dmg: b.dmg, falloff: 1 - (1 - b.falloff) }, dist) : b.dmg;
          // 头顶护罩判定（坦克举盾）
          dmg = this.shieldReduce(q, b, dmg);
          if (head) dmg *= PHYS.HEADSHOT_MUL;

          this.applyDamage(q, dmg, {
            from: b.owner, weapon: b.w, head,
            dir: Math.sign(b.vx) || 1, knock: b.kick,
          });
          b.hitIds.add(q.id);

          if (b.explode) { this.explode(b); done = true; }
          else if (b.smoke) { this.popSmoke(b); done = true; }
          else if (b.pierce > 0) { b.pierce--; b.dmg *= 0.72; }
          else done = true;
          break;
        }
      }
      if (!done) alive.push(b);
    }
    this.bullets = alive;
  }

  /** 烟雾弹落地：生成烟幕 */
  popSmoke(b) {
    if (!b.smoke) return;
    this.smokes.push({
      x: b.x, y: b.y,
      r: b.smoke.radius || 130,
      end: this.time + (b.smoke.dur || 4),
    });
    this.events.push({ t: 'smoke', x: b.x, y: b.y, r: b.smoke.radius || 130, dur: b.smoke.dur || 4 });
  }

  /** 盾牌正面减伤 + 反弹 */
  shieldReduce(target, b, dmg) {
    const w = currentWeapon(target);
    if (!w || !w.shield) return dmg;
    if (!(target.keys & KEY.DOWN)) return dmg;
    // 攻击是否来自正面
    const facing = target.facing;
    const fromDir = Math.sign(b.x - (target.x + target.w / 2));
    if (fromDir !== facing) return dmg;
    const reduced = dmg * (1 - w.reduce);
    // 反弹：生成一颗反向子弹
    this.bullets.push({
      x: b.x, y: b.y,
      vx: -b.vx * 0.75, vy: -b.vy * 0.75 - 40,
      grav: b.grav, dmg: dmg * w.reflect, owner: target.id, team: target.team,
      w: b.w, life: 0.6, pierce: 0, hitIds: new Set(), kick: 40,
      rocket: false, explode: null, falloff: 0, startX: b.x, startY: b.y,
    });
    this.events.push({ t: 'block', x: b.x, y: b.y, id: target.id });
    return reduced;
  }

  explode(b) {
    const e = b.explode;
    if (!e) return;
    this.events.push({ t: 'explode', x: b.x, y: b.y, r: e.radius });
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const cx = q.x + q.w / 2, cy = q.y + q.bh / 2;
      const d = Math.hypot(cx - b.x, cy - b.y);
      if (d > e.radius) continue;
      const isSelf = q.id === b.owner;
      if (!isSelf && !this.isEnemyOf(b.team, q)) continue;
      const f = 1 - d / e.radius;
      let dmg = e.dmg * f;
      if (isSelf) dmg *= e.self;
      this.applyDamage(q, dmg, {
        from: b.owner, weapon: b.w, explosive: true,
        dir: Math.sign(cx - b.x) || 1, knock: 140 * f,
      });
    }
  }

  /* ---------------- 伤害 / 治疗 / 死亡 ---------------- */

  heal(p, amount) {
    if (!p.alive) return;
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    const gained = p.hp - before;
    if (gained > 0.5 && p.id) {
      this.events.push({ t: 'heal', id: p.id, n: Math.round(gained) });
    }
    return gained;
  }

  applyDamage(target, amount, opts = {}) {
    if (!target.alive) return false;
    if (target.spawnProtect > 0 && opts.from !== target.id) return false;

    const attacker = this.players.get(opts.from);

    // 无敌技能减伤
    let mul = 1;
    if (target.skillActive && CLASSES[target.cls].skill.id === 'ironskin') mul *= 0.3;
    // 瞬步期间完全免伤（冲刺无敌帧）
    if (target.skillActive && CLASSES[target.cls].skill.id === 'dash' && this.time < target.skillEnd) mul = 0;
    let dmg = Math.max(0, Math.round(amount * mul));
    if (dmg <= 0) return false;

    target.hp -= dmg;
    target.lastHitBy = opts.from || null;
    target.lastHitAt = this.time;

    if (!opts.explosive) {
      target.vx += (opts.dir || 1) * (opts.knock || 60) * (target.skillActive && CLASSES[target.cls].skill.id === 'ironskin' ? 0.15 : 1);
    }

    if (attacker && attacker.id !== target.id) {
      this.events.push({
        t: 'hit', id: target.id, by: attacker.id, n: dmg,
        x: target.x + target.w / 2, y: target.y + target.bh * 0.3,
        head: !!opts.head, hp: Math.max(0, Math.round(target.hp)),
      });
    }

    if (target.hp <= 0) {
      this.kill(target, attacker, opts);
    }
    return true;
  }

  kill(target, killer, opts = {}) {
    target.hp = 0;
    target.alive = false;
    target.deaths++;
    target.streak = 0;
    target.respawnAt = this.time + COMBAT.RESPAWN_TIME;
    target.skillActive = false;
    target.charging = false;
    target.charge = 0;
    target.keys = 0;
    target.vx = 0; target.vy = 0;

    // 战役：统计玩家方阵亡
    if (this.camp && target.team === 'blue') this.camp.deaths++;

    const suicide = !killer || killer.id === target.id;
    const w = opts.weapon || 'unknown';

    this.events.push({
      t: 'kill', id: target.id, by: suicide ? null : killer.id,
      w, head: !!opts.head, streak: killer ? killer.streak + 1 : 0,
      x: target.x + target.w / 2, y: target.y + target.bh / 2,
    });

    if (!suicide) {
      killer.kills++;
      killer.killsSinceDeath++;
      killer.streak++;

      // 战役：玩家方击杀计入目标进度
      if (this.camp && killer.team === 'blue' && target.team === 'red') {
        this.camp.killedByPlayer++;
      }
      killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
      if (killer.skillCharge < 99) killer.skillCharge = Math.min(99, killer.skillCharge + 1);

      // 击杀奖励：个人分数
      killer.score += 100 + Math.max(0, Math.min(4, killer.streak - 1)) * 10;

      // 团队分数：只有 TDM / FFA 用击杀计分；DOM 完全靠占点
      if (this.mode === 'tdm') {
        this.scores[killer.team] = (this.scores[killer.team] || 0) + 1;
      }
    } else {
      // 自杀：TDM 扣自己队 1 分
      if (this.mode === 'tdm') {
        this.scores[target.team] = Math.max(0, (this.scores[target.team] || 0) - 1);
      }
      target.score = Math.max(0, target.score - 50);
    }
  }

  /* ---------------- 烟幕 ---------------- */

  stepSmokes(dt) {
    void dt;
    if (!this.smokes.length) return;
    this.smokes = this.smokes.filter(s => this.time < s.end);
  }

  /** 某点是否处于烟幕中（供 AI 视线判定使用） */
  inSmoke(x, y) {
    for (const s of this.smokes) {
      if (Math.hypot(x - s.x, y - s.y) < s.r) return true;
    }
    return false;
  }

  /* ---------------- 拾取物 ---------------- */

  stepPickups(dt) {
    for (const pk of this.pickupState) {
      if (pk.cd > 0) { pk.cd -= dt; continue; }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot((p.x + p.w / 2) - pk.x, (p.y + p.bh / 2) - (pk.y - 10));
        if (d > 44) continue;
        let ok = false;
        if (pk.type === 'health') {
          if (p.hp < p.maxHp) { this.heal(p, COMBAT.HEALTH_PICKUP); ok = true; }
        } else {
          let refilled = false;
          for (const key of ['primary', 'secondary']) {
            const s = p.wp[key];
            if (!s || !s.def.mag) continue;
            if (s.reserve < s.def.reserve) { s.reserve = s.def.reserve; refilled = true; }
          }
          if (refilled) ok = true;
        }
        if (ok) {
          pk.cd = COMBAT.PICKUP_RESPAWN;
          this.events.push({ t: 'pickup', i: pk.i, id: p.id, kind: pk.type, x: pk.x, y: pk.y });
          break;
        }
      }
    }
  }

  /* ---------------- 模式逻辑 ---------------- */

  stepMode(dt) {
    if (this.over) return;

    // 据点逻辑：dom 模式，或战役里的 capture 关卡
    const usesPoints = this.mode === 'dom'
      || (this.mode === 'campaign' && this.level && this.level.objective === 'capture');
    if (usesPoints) {
      for (const pt of this.points) {
        let blue = 0, red = 0;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          // 据点判定：以水平距离为主，垂直容差放宽到 130px
          // （中央缓坡等地形抬高地面后，仍应判定为「站在点内」）
          const dx = Math.abs((p.x + p.w / 2) - pt.x);
          const dy = Math.abs((p.y + p.bh) - pt.y);
          if (dx > pt.r || dy > 130) continue;
          if (p.team === 'blue') blue++; else red++;
        }
        pt.contest = blue > 0 && red > 0;

        if (pt.contest) continue;                 // 争夺中：进度冻结
        const holders = blue > 0 ? 'blue' : (red > 0 ? 'red' : null);
        if (!holders) continue;                   // 无人：进度冻结

        if (pt.owner === holders) {
          pt.prog = Math.min(1, pt.prog + dt / 0.55);   // 巩固自己已占的旗
        } else {
          // 先把对方旗降下，再升自己的
          pt.prog -= dt / (pt.owner ? 0.7 : 1.1);
          if (pt.prog <= 0) {
            pt.prog = 0;
            pt.owner = holders;                   // 归零即易主，随后开始升旗
          }
        }
      }
      // 占点得分：仅 dom 模式计分；战役 capture 只需「占满保持」
      if (this.mode === 'dom') {
        this._domAcc = (this._domAcc || 0) + dt;
        if (this._domAcc >= 1) {
          this._domAcc -= 1;
          for (const pt of this.points) {
            if (pt.owner && pt.prog >= 1) this.scores[pt.owner] = (this.scores[pt.owner] || 0) + 1;
          }
        }
      }
    }

    // 战役推进：波次、目标、失败判定
    if (this.mode === 'campaign') {
      this.stepCampaign(dt);
      if (this.over) return;
    }

    // 胜利判定
    if (this.mode === 'tdm' || this.mode === 'dom') {
      if (this.scores.blue >= this.scoreLimit) this.endMatch('blue');
      else if (this.scores.red >= this.scoreLimit) this.endMatch('red');
    } else if (this.mode !== 'campaign') {
      for (const p of this.players.values()) {
        if (p.kills >= this.scoreLimit) { this.endMatch(p.id); break; }
      }
    }
    if (this.over) return;
    void dt;
  }

  /**
   * 战役推进：按波次放敌人 → 判定目标完成 / 失败。
   * 不直接生成玩家，而是往 pendingSpawns 塞数量，由服务端补齐（保持「谁生成谁有权」）。
   */
  stepCampaign(dt) {
    const c = this.camp;
    const L = this.level;
    if (!c || !L || this.over) return;

    // 玩家方阵亡统计（用于失败判定）
    let aliveHumans = 0;
    for (const p of this.players.values()) {
      if (p.team !== 'blue') continue;
      if (p.alive) aliveHumans++;
    }
    void aliveHumans;

    // ---- 波次投放 ----
    if (c.phase === 'wave') {
      c.waveTimer -= dt;
      if (c.waveTimer <= 0) {
        if (c.wave < L.waves.length) {
          const w = L.waves[c.wave];
          this.pendingSpawns.push(w.n);
          c.spawnedTotal += w.n;
          c.wave++;
          const next = L.waves[c.wave];
          c.waveTimer = next ? next.delay : 9999;
          this.events.push({ t: 'wave', n: c.wave, total: L.waves.length, add: w.n });
        }
      }
    }

    // ---- 残敌补充：场上敌人过少时持续补充，保证战斗不冷场 ----
    // （战役是「打到目标数」而不是「清光场上」，所以要有人可打）
    const lvTarget = L.objective === 'eliminate' ? L.target : Math.max(6, L.waves.reduce((a, w) => a + w.n, 0));
    if (c.killedByPlayer < lvTarget) {
      const aliveRed = [...this.players.values()].filter(p => p.team === 'red' && p.alive).length;
      const desiredMin = 4 + Math.floor(L.difficulty * 0.8);
      c.lowTick = (c.lowTick || 0) + dt;
      // 场上没人就立刻补，否则最多等 0.8 秒
      const waitNeed = aliveRed === 0 ? 0.25 : 0.8;
      if (aliveRed < desiredMin && c.lowTick >= waitNeed) {
        c.lowTick = 0;
        this.pendingSpawns.push(Math.min(3, desiredMin - aliveRed));
      }
    }

    // ---- 目标判定 ----
    let done = false;
    if (L.objective === 'eliminate') {
      // 击杀数达标即通关（不必等场上敌人全灭，避免残敌僵持导致打不完）
      done = c.killedByPlayer >= L.target;
    } else if (L.objective === 'survive') {
      c.holdTimer += dt;
      if (c.holdTimer >= L.target) done = true;
    } else if (L.objective === 'capture') {
      // 需要夺取的据点：关卡可指定（默认取 2/3 数量）
      const ids = L.capturePoints || null;
      const pool = ids ? this.points.filter(pt => ids.includes(pt.id)) : this.points;
      const need = ids ? pool.length : (L.captureNeed || Math.max(1, Math.ceil(this.points.length * 0.66)));
      const held = pool.filter(pt => pt.owner === 'blue' && pt.prog >= 1).length;
      if (held >= need) {
        c.holdTimer += dt;
        if (c.holdTimer >= L.target) done = true;
      } else {
        c.holdTimer = Math.max(0, c.holdTimer - dt * 2);
      }
    }

    if (done) {
      this.events.push({ t: 'levelClear', level: this.levelId });
      this.endMatch('blue');
      return;
    }

    // ---- 失败判定：玩家方阵亡超限 ----
    if (c.deaths >= L.maxDeaths) {
      this.events.push({ t: 'levelFail', level: this.levelId, reason: 'deaths' });
      this.endMatch('red');
    }
  }

  stepTimers(dt) {
    void dt;
    if (this.over) {
      this._overTime = (this._overTime || 0) + DT;
      return;
    }
    if (this.time >= this.timeLimit) {
      if (this.mode === 'ffa') {
        let best = null;
        for (const p of this.players.values()) if (!best || p.kills > best.kills) best = p;
        this.endMatch(best ? best.id : null);
      } else {
        const b = this.scores.blue || 0, r = this.scores.red || 0;
        this.endMatch(b === r ? null : (b > r ? 'blue' : 'red'));
      }
    }
  }

  endMatch(winner) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this._overTime = 0;
    const rows = this.list.map(p => ({
      id: p.id, name: p.name, cls: p.cls, team: p.team, isBot: p.isBot,
      kills: p.kills, deaths: p.deaths, score: p.score, streak: p.bestStreak,
    })).sort((a, b) => b.score - a.score || b.kills - a.kills);
    this.results = {
      winner,
      mode: this.mode,
      scores: { ...this.scores },
      rows,
    };
    this.events.push({ t: 'over', winner, results: this.results });
  }

  /** 结算后重开一局 */
  restart() {
    this.over = false;
    this.winner = null;
    this.results = null;
    this.time = 0;
    this.tick = 0;
    this.scores = { blue: 0, red: 0 };
    this.bullets = [];
    this.smokes = [];
    this._overTime = 0;
    this.pickupState.forEach(pk => { pk.cd = 0; });
    this.points = (this.map.points || []).map(pt => ({
      id: pt.id, x: pt.x, y: pt.y, r: pt.r,
      owner: null, prog: 0, contest: false, capTeam: null,
    }));

    // 战役：重置关卡进度，并清掉上一局残留的敌人
    if (this.mode === 'campaign' && this.level) {
      this.camp = {
        phase: 'wave',
        wave: 0,
        waveTimer: this.level.waves[0].delay,
        spawnedTotal: 0,
        target: this.level.target,
        holdTimer: 0,
        killedByPlayer: 0,
        deaths: 0,
        lowTick: 0,
      };
      this.pendingSpawns = [];
      for (const p of [...this.players.values()]) {
        if (p.isBot && p.team === 'red') this.removePlayer(p.id);
      }
    }

    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.score = 0; p.streak = 0;
      p.skillCharge = 0; p.skillActive = false;
      this.respawn(p, true);
    }
    this.events.push({ t: 'restart' });
  }

  /** 是否需要自动重开 */
  needsRestart() {
    return this.over && (this._overTime || 0) > 14;
  }

  /* ---------------- 序列化 ---------------- */

  snapshot() {
    const ps = [];
    for (const p of this.players.values()) {
      ps.push({
        i: p.id, x: r1(p.x), y: r1(p.y), f: p.facing, c: p.crouch ? 1 : 0,
        a: p.alive ? 1 : 0, h: Math.max(0, Math.round(p.hp)), m: p.maxHp,
        t: p.team, k: p.cls, n: p.name, b: p.isBot ? 1 : 0,
        s: p.score, kl: p.kills, dt: p.deaths, ai: r2(p.aim),
        w: currentWeapon(p) ? currentWeapon(p).id : 'pistol',
        r: p.reloadEnd > 0 ? 1 : 0, sk: p.skillActive ? 1 : 0,
        sp: p.spawnProtect > 0 ? 1 : 0, sg: p.swing > 0 ? 1 : 0,
        ch: p.charge > 0 ? r2(p.charge) : 0,
        sn: p.seq, sq: p.streak, sc: p.skillCharge,
      });
    }
    return {
      t: 'snap',
      k: this.tick,
      tm: r2(this.time),
      ps,
      sc: { ...this.scores },
      pt: this.points.map(pt => ({ i: pt.id, o: pt.owner, p: r2(pt.prog), c: pt.contest ? 1 : 0 })),
      pk: this.pickupState.map(pk => (pk.cd > 0 ? 1 : 0)),
      sm: this.smokes.map(s => ({
        x: r1(s.x), y: r1(s.y), r: s.r,
        l: r2(Math.max(0, s.end - this.time)),
      })),
      ev: this.events,
      ov: this.over ? 1 : 0,
      wn: this.winner,
      // 战役进度（非战役模式为 null）
      cp: this.camp ? {
        lv: this.levelId, name: this.level.name, obj: this.level.objective,
        target: this.level.target,
        w: this.camp.wave, wt: Math.round(this.camp.wave * 10) / 10,
        tw: this.level.waves.length,
        prog: this.campObjectiveProgress(),
        deaths: this.camp.deaths, maxDeaths: this.level.maxDeaths,
        hold: Math.round(this.camp.holdTimer * 10) / 10,
        phase: this.camp.phase,
      } : null,
    };
  }

  /** 战役目标的完成进度（0-1），供 HUD 显示 */
  campObjectiveProgress() {
    const c = this.camp, L = this.level;
    if (!c || !L) return 0;
    if (L.objective === 'eliminate') {
      return Math.max(0, Math.min(1, c.killedByPlayer / L.target));
    }
    return Math.max(0, Math.min(1, c.holdTimer / L.target));
  }

  /** 玩家自己的详细状态（弹药等只发给本人） */
  selfState(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const mk = (s) => s ? {
      id: s.def.id, ammo: s.ammo, mag: s.def.mag,
      reserve: s.reserve, reserveMag: s.def.reserve,
    } : null;
    return {
      t: 'self',
      hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      slot: p.slot,
      wp: { primary: mk(p.wp.primary), secondary: mk(p.wp.secondary) },
      skill: CLASSES[p.cls].skill,
      charge: p.skillCharge, active: p.skillActive,
    };
  }

  clearEvents() { this.events = []; }
}

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

function requireMap(id) {
  return getMap(id);
}

export function currentWeapon(p) {
  const s = p.wp && p.wp[p.slot];
  return s ? s.def : null;
}

export function buildLoadout(cls, override, prev) {
  const c = CLASSES[cls] || CLASSES.assault;
  const mk = (id, slot) => {
    const def = getWeapon(id);
    return { def, mag: def.mag, ammo: def.mag, reserve: def.reserve || 0, slot };
  };
  const primaries = c.loadout || [];
  const primary = (override && override.primary && primaries.includes(override.primary))
    ? override.primary : primaries[0];
  const secondary = (override && override.secondary) ? override.secondary : c.secondary;
  void prev;
  return {
    primary: mk(primary, 'primary'),
    secondary: mk(secondary, 'secondary'),
  };
}

export function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export { TEAMS };
