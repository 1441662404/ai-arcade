/**
 * 渲染 —— 全部用 Canvas 2D 手绘，不依赖任何图片资源。
 * 风格：美式卡通 + 军事工业感（对齐原作 Strike Force Heroes 的观感）。
 */

import { PHYS, CLASSES, TEAMS, KEY } from '../shared/constants.js';
import { getMap } from '../shared/maps.js';
import { getWeapon } from '../shared/weapons.js';

const SKIN = {
  wall: { fill: '#33475d', top: '#4f6f8e', line: '#1d2b39' },
  ground: { fill: '#2a3f56', top: '#476b8c', line: '#182534' },
  walk: { fill: '#3a5069', top: '#587593', line: '#213245' },
  plat: { fill: '#45607d', top: '#6a8dae', line: '#26384b' },
  crate: { fill: '#6b5138', top: '#95724d', line: '#3a2a1c' },
  barrel: { fill: '#5a6b38', top: '#7f9550', line: '#333d20' },
  hull: { fill: '#5a4840', top: '#836a5b', line: '#332620' },
  ceiling: { fill: '#1a2530', top: '#263543', line: '#101a22' },
  wood: { fill: '#5a442e', top: '#806241', line: '#33251a' },
  trunk: { fill: '#483624', top: '#664e35', line: '#2a1e12' },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cam = { x: 0, y: 0, w: 1280, h: 720, shake: 0, shakeT: 0 };
    this.t = 0;
    this.flash = 0;
    this.hitMarkers = [];
    this.floaters = [];      // 伤害数字
    this.tracers = [];
    this.particles = [];
    this.decals = [];
    this.killFeed = [];
    this.zoom = 1;
    this.scoped = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.cam.w = w;
    this.cam.h = h;
  }

  setMap(mapId) {
    this.map = getMap(mapId);
    this.decals = [];
    this.particles = [];
    this.tracers = [];
    this.floaters = [];
    this.buildBackdrop();
  }

  /* ================================================================ */
  /*  背景（视差层）                                                   */
  /* ================================================================ */
  buildBackdrop() {
    const th = this.map.theme;
    this.bgStars = [];
    for (let i = 0; i < 90; i++) {
      this.bgStars.push({
        x: Math.random() * 4000, y: Math.random() * 900,
        r: Math.random() * 1.8 + 0.4, a: Math.random() * 0.6 + 0.2,
        s: Math.random() * 0.4 + 0.1,
      });
    }
    this.bgBlocks = [];
    const kind = th.parallax;
    for (let i = 0; i < 26; i++) {
      const x = i * 200 + Math.random() * 90;
      if (kind === 'tank') {
        this.bgBlocks.push({ x, y: 300 + Math.random() * 260, w: 130 + Math.random() * 90, h: 260 + Math.random() * 300, k: 'tank' });
      } else if (kind === 'trees') {
        this.bgBlocks.push({ x, y: 240 + Math.random() * 200, w: 70 + Math.random() * 60, h: 400 + Math.random() * 320, k: 'tree' });
      } else {
        this.bgBlocks.push({ x, y: 300 + Math.random() * 300, w: 100 + Math.random() * 120, h: 240 + Math.random() * 340, k: 'ruin' });
      }
    }
  }

  /* ================================================================ */
  /*  摄像机                                                           */
  /* ================================================================ */
  shake(amount, dur = 0.25) {
    this.cam.shake = Math.max(this.cam.shake, amount);
    this.cam.shakeT = Math.max(this.cam.shakeT, dur);
  }

  follow(target, dt, scoped) {
    const map = this.map;
    // 视野：开镜时缩小视野（放大画面），否则正常
    const baseW = Math.max(900, Math.min(1500, this.cam.w * 0.85));
    const zoom = scoped ? 0.62 : 1;
    const viewW = baseW * zoom;
    const viewH = (this.cam.h / this.cam.w) * viewW;

    if (!target) {
      this.cam.x = map.width / 2 - viewW / 2;
      this.cam.y = map.groundY - viewH * 0.7;
      this.viewW = viewW; this.viewH = viewH;
      return;
    }

    // 朝瞄准方向前瞻，射击手感更好
    const aheadX = Math.cos(target.aim || 0) * (scoped ? 180 : 90);
    const aheadY = Math.sin(target.aim || 0) * 40;
    const tx = (target.x + PHYS.W / 2) + aheadX - viewW / 2;
    const ty = (target.y + PHYS.H / 2) + aheadY - viewH * 0.62;

    const k = Math.min(1, dt * (scoped ? 12 : 7));
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;

    // 夹在地图内
    this.cam.x = Math.max(0, Math.min(map.width - viewW, this.cam.x));
    this.cam.y = Math.max(-520, Math.min(map.height - viewH + 40, this.cam.y));

    this.viewW = viewW;
    this.viewH = viewH;

    // 抖动
    if (this.cam.shakeT > 0) {
      this.cam.shakeT -= dt;
      this.cam.shake *= 0.9;
      if (this.cam.shakeT <= 0) this.cam.shake = 0;
    }
  }

  /* ================================================================ */
  /*  主绘制                                                           */
  /* ================================================================ */
  draw(world, me, dt) {
    this.t += dt;
    const ctx = this.ctx;
    const W = this.cam.w, H = this.cam.h;
    const sx = (Math.random() - 0.5) * this.cam.shake * 2;
    const sy = (Math.random() - 0.5) * this.cam.shake * 2;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    this.drawSky(ctx, W, H);
    this.drawParallax(ctx, W, H);

    // 世界变换
    const scale = W / (this.viewW || W);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(scale, scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.drawMapBack(ctx);
    this.drawPickups(ctx, world);
    this.drawPlayers(ctx, world, me, dt);
    this.drawBullets(ctx, world);
    this.drawParticles(ctx, dt);
    this.drawSmokes(ctx, world);
    this.drawTracers(ctx, dt);
    this.drawMapFront(ctx);
    this.drawFloaters(ctx, dt);
    this.drawKillFeed(ctx, W / scale, H / scale);

    ctx.restore();

    // 屏幕空间特效
    this.drawVignette(ctx, W, H);
    this.drawDamageFlash(ctx, W, H);
    this.drawHitMarkers(ctx, dt);
  }

  /* ---------------- 天空 ---------------- */
  drawSky(ctx, W, H) {
    const th = this.map.theme;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, th.sky[0]);
    g.addColorStop(0.55, th.sky[1]);
    g.addColorStop(1, th.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 星点 / 尘埃
    for (const s of this.bgStars) {
      const px = ((s.x - this.cam.x * 0.15) % 4000 + 4000) % 4000;
      if (px > W + 20) continue;
      const a = s.a * (0.6 + Math.sin(this.t * s.s * 3 + s.x) * 0.4);
      ctx.fillStyle = `rgba(200,225,255,${a})`;
      ctx.fillRect(px, s.y, s.r, s.r);
    }

    // 地平线光晕
    const glow = ctx.createRadialGradient(W * 0.5, H * 0.85, 10, W * 0.5, H * 0.85, W * 0.75);
    glow.addColorStop(0, th.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------------- 视差层 ---------------- */
  drawParallax(ctx, W, H) {
    const th = this.map.theme;
    const off = this.cam.x * 0.22;
    const baseY = H * 0.82 - this.cam.y * 0.12;

    for (const b of this.bgBlocks) {
      const x = b.x - off;
      if (x > W + 260 || x + b.w < -260) continue;
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = th.sky[2];
      if (b.k === 'tree') {
        ctx.fillRect(x, baseY - b.h, b.w * 0.45, b.h);
        // 树冠
        ctx.beginPath();
        ctx.ellipse(x + b.w * 0.22, baseY - b.h, b.w * 0.9, b.h * 0.24, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (b.k === 'tank') {
        ctx.fillRect(x, baseY - b.h, b.w, b.h);
        ctx.beginPath();
        ctx.ellipse(x + b.w / 2, baseY - b.h, b.w * 0.62, b.w * 0.2, 0, Math.PI, 0);
        ctx.fill();
      } else {
        ctx.fillRect(x, baseY - b.h, b.w, b.h);
      }
      ctx.globalAlpha = 1;
    }

    // 地面雾
    const fog = ctx.createLinearGradient(0, H * 0.6, 0, H);
    fog.addColorStop(0, 'rgba(0,0,0,0)');
    fog.addColorStop(1, th.fog);
    ctx.fillStyle = fog;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  /* ---------------- 地图后层（地面、墙体） ---------------- */
  drawMapBack(ctx) {
    const map = this.map;
    const th = map.theme;
    const cx0 = this.cam.x - 60, cx1 = this.cam.x + (this.viewW || 1200) + 60;

    for (const p of map.platforms) {
      if (p.x > cx1 || p.x + p.w < cx0) continue;
      if (p.type === 'plat') continue;   // 单向平台画在前层
      this.drawBlock(ctx, p, th);
    }
  }

  drawMapFront(ctx) {
    const map = this.map;
    const cx0 = this.cam.x - 60, cx1 = this.cam.x + (this.viewW || 1200) + 60;
    for (const p of map.platforms) {
      if (p.type !== 'plat') continue;
      if (p.x > cx1 || p.x + p.w < cx0) continue;
      this.drawBlock(ctx, p, map.theme);
    }
  }

  drawBlock(ctx, p, th) {
    const sk = SKIN[p.skin] || SKIN.wall;
    const { x, y, w, h } = p;

    // 主体
    ctx.fillStyle = sk.fill;
    ctx.fillRect(x, y, w, h);

    // 顶面高光
    ctx.fillStyle = sk.top;
    ctx.fillRect(x, y, w, Math.min(6, h));

    // 描边
    ctx.strokeStyle = sk.line;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    // 质感：条纹 / 铆钉
    if (h > 40) {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#000';
      for (let yy = y + 16; yy < y + h; yy += 26) {
        ctx.fillRect(x + 4, yy, w - 8, 1.5);
      }
      ctx.globalAlpha = 1;
    }

    // 边角高光（金属感）
    if (p.skin === 'wall' || p.skin === 'hull') {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3);
      ctx.lineTo(x + 3, y + Math.min(28, h));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 木箱：画个叉
    if (p.skin === 'crate') {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 6); ctx.lineTo(x + w - 6, y + h - 6);
      ctx.moveTo(x + w - 6, y + 6); ctx.lineTo(x + 6, y + h - 6);
      ctx.stroke();
    }
    // 油桶：横向条纹
    if (p.skin === 'barrel') {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 2;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(x + 2, y + h * i / 3);
        ctx.lineTo(x + w - 2, y + h * i / 3);
        ctx.stroke();
      }
    }
  }

  /* ---------------- 补给物 ---------------- */
  drawPickups(ctx, world) {
    for (const pk of world.pickupState) {
      if (pk.cd > 0) continue;
      const bob = Math.sin(this.t * 2.4 + pk.i) * 5;
      const y = pk.y - 26 + bob;
      const isHealth = pk.type === 'health';

      ctx.save();
      ctx.translate(pk.x, y);
      // 光晕
      const gr = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
      gr.addColorStop(0, isHealth ? 'rgba(90,255,140,0.45)' : 'rgba(255,200,80,0.45)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(-30, -30, 60, 60);

      // 盒子（小一点，别挡角色）
      ctx.fillStyle = isHealth ? '#173423' : '#3a2c12';
      ctx.strokeStyle = isHealth ? '#5aff8c' : '#ffc850';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-10, -10, 20, 20, 4);
      ctx.fill();
      ctx.stroke();

      // 图标
      ctx.fillStyle = isHealth ? '#5aff8c' : '#ffc850';
      if (isHealth) {
        ctx.fillRect(-1.5, -6, 3, 12);
        ctx.fillRect(-6, -1.5, 12, 3);
      } else {
        ctx.fillRect(-5, -5, 2.5, 10);
        ctx.fillRect(-1, -5, 2.5, 10);
        ctx.fillRect(3, -5, 2.5, 10);
      }
      ctx.restore();
    }
  }

  /* ---------------- 玩家 ---------------- */
  drawPlayers(ctx, world, me, dt) {
    const list = [];
    for (const p of world.players.values()) {
      if (!p.alive && p.id !== (me && me.id)) continue;
      list.push(p);
    }
    // 按 y 排序，让下方的人盖住上方（伪深度）
    list.sort((a, b) => a.y - b.y);
    for (const p of list) this.drawSoldier(ctx, p, p.id === (me && me.id), world, me);
  }

  drawSoldier(ctx, p, isMe, world, me) {
    const cls = CLASSES[p.cls] || CLASSES.assault;
    const team = TEAMS[p.team] || TEAMS.blue;
    const cx = p.x + p.w / 2;
    const foot = p.y + p.bh;

    // 死亡：躺地
    if (!p.alive) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(cx, foot);
      ctx.rotate(Math.PI / 2 * p.facing);
      this.drawBody(ctx, 0, 0, p, cls, team, true);
      ctx.restore();
      return;
    }

    // 出生保护闪烁
    if (p.spawnProtect > 0 && Math.floor(this.t * 12) % 2 === 0) ctx.globalAlpha = 0.45;
    // 隐身
    if (p.skillActive && cls.skill.id === 'cloak') ctx.globalAlpha = p.id === (me && me.id) ? 0.5 : 0.18;

    ctx.save();
    ctx.translate(cx, foot);

    // 脚下阴影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 15, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 队友/敌人标记（己方脚下小三角）
    if (isMe) {
      ctx.fillStyle = team.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(-6, -12);
      ctx.lineTo(6, -12);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    this.drawBody(ctx, 0, 0, p, cls, team, false, world);

    ctx.restore();
    ctx.globalAlpha = 1;

    // 血条（自己 & 队友 & 敌人受伤时显示）
    const friendly = me ? (!world.isEnemyOf(me.team, p) || p.id === me.id) : true;
    const showHp = isMe || friendly || p.hp < p.maxHp;
    if (showHp && p.hp > 0) this.drawHpBar(ctx, cx, p.y - 12, p, isMe, world, me);
    if (p.id !== (me && me.id)) this.drawNameTag(ctx, cx, p.y - (showHp ? 26 : 12), p, isMe, world, me);
  }

  drawBody(ctx, ox, oy, p, cls, team, dead, world) {
    const f = p.facing;
    const h = p.bh;
    const c = p.crouch;

    // 身体参数（放大一档，暗色场景里才看得清）
    const bodyH = c ? 22 : 30;
    const legH = c ? 9 : 19;
    const headR = 8.5;

    const baseY = oy - legH - bodyH;
    const bodyW = 18;

    // 轮廓描边：先画一圈深色，保证任何背景下都能分离出来
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;

    // ---- 腿 ----
    ctx.fillStyle = '#1c242f';
    const walk = p.alive && Math.abs(p.vx) > 30 ? Math.sin(this.t * 12) * 4 : 0;
    ctx.fillRect(ox - 8 + walk * 0.3, oy - legH, 7, legH);
    ctx.fillRect(ox + 1 - walk * 0.3, oy - legH, 7, legH);

    // ---- 躯干（亮色队服，高对比）----
    ctx.fillStyle = team.color;
    ctx.beginPath();
    ctx.roundRect(ox - bodyW / 2, baseY, bodyW, bodyH, 4);
    ctx.fill();

    // 暗色胸甲，制造层次
    ctx.fillStyle = team.color2;
    ctx.beginPath();
    ctx.roundRect(ox - bodyW / 2 + 2, baseY + bodyH * 0.42, bodyW - 4, bodyH * 0.52, 3);
    ctx.fill();

    // 兵种肩章（发光）
    ctx.fillStyle = cls.accent;
    ctx.beginPath();
    ctx.roundRect(ox - bodyW / 2 - 3, baseY + 1, 6, bodyH - 6, 2);
    ctx.fill();

    // ---- 头 ----
    const headY = baseY - headR - 2;
    ctx.fillStyle = '#d8b28c';
    ctx.beginPath();
    ctx.arc(ox + f * 2, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    // 头盔（兵种色，带高光）
    ctx.fillStyle = cls.accent;
    ctx.beginPath();
    ctx.arc(ox + f * 2, headY - 1.5, headR + 2, Math.PI * 1.0, Math.PI * 2.0);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(ox + f * 2 - 2, headY - 5, headR * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // 护目镜
    ctx.fillStyle = '#101a24';
    ctx.fillRect(ox + f * 2 + (f > 0 ? 1 : -7), headY - 1, 7, 4.5);

    ctx.restore();

    if (dead) return;

    // ---- 武器（沿瞄准角） ----
    const w = getWeapon(p.w);
    const gunY = baseY + bodyH * 0.42;
    ctx.save();
    ctx.translate(ox, gunY);
    ctx.rotate(p.aim || 0);
    if (f < 0) ctx.scale(1, -1);   // 朝左时翻转，避免倒持

    const gunLen = w.scope ? 40 : (w.shield ? 26 : (w.melee ? 28 : 28));
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    // 枪身
    ctx.fillStyle = '#39434f';
    ctx.fillRect(5, -3.5, gunLen, 7);
    // 枪口
    ctx.fillStyle = '#12181f';
    ctx.fillRect(5 + gunLen, -2.5, 5, 5);
    // 弹匣
    if (!w.melee && !w.shield) {
      ctx.fillStyle = '#4a5764';
      ctx.fillRect(12, 3.5, 6, 8);
    }
    ctx.shadowBlur = 0;
    if (w.scope) {
      ctx.fillStyle = '#1a2532';
      ctx.fillRect(14, -9, 16, 5);
      ctx.fillStyle = '#8be9ff';
      ctx.fillRect(27, -8, 3.5, 3.5);
    }
    if (w.shield) {
      ctx.fillStyle = '#a8bdd4';
      ctx.fillRect(5 + gunLen, -16, 4.5, 32);
      ctx.fillStyle = '#5d7a99';
      ctx.fillRect(5 + gunLen, -16, 4.5, 12);
    }
    ctx.restore();

    // 近战挥击弧线
    if (p.swing > 0) {
      const k = p.swing / 0.26;
      ctx.strokeStyle = w.shield ? 'rgba(200,220,255,0.75)' : 'rgba(200,160,255,0.85)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(ox, gunY, w.reach ? w.reach * 0.8 : 40, (p.aim || 0) - 0.9 + k * 1.8, (p.aim || 0) + 0.9 + k * 1.8);
      ctx.stroke();
    }

    // 开火闪光
    if (p.fireCd > 0 && p.fireCd > 1 / (w.rate || 1) * 0.75 && !w.melee && !w.shield) {
      ctx.save();
      ctx.translate(ox, gunY);
      ctx.rotate(p.aim || 0);
      ctx.fillStyle = 'rgba(255,220,140,0.9)';
      ctx.beginPath();
      ctx.moveTo(gunLen + 6, 0);
      ctx.lineTo(gunLen + 18, -7);
      ctx.lineTo(gunLen + 14, 0);
      ctx.lineTo(gunLen + 18, 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 技能光效
    if (p.skillActive) {
      const sk = cls.skill.id;
      ctx.save();
      ctx.globalAlpha = 0.55 + Math.sin(this.t * 8) * 0.25;
      const col = sk === 'ironskin' ? '#c084fc' : sk === 'nano' ? '#6ee7f9' : sk === 'cloak' ? '#7ee787' : '#ff8a3d';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(ox, oy - (p.bh * 0.5), p.bh * 0.75, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 蓄力指示（磁轨炮）
    if (p.charging && p.charge > 0) {
      ctx.save();
      ctx.translate(ox, gunY);
      ctx.rotate(p.aim || 0);
      ctx.fillStyle = '#8be9ff';
      ctx.globalAlpha = 0.4 + Math.random() * 0.5;
      ctx.fillRect(gunLen + 4, -2, 4 + p.charge * 10, 4);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  drawHpBar(ctx, cx, y, p, isMe, world, me) {
    const w = 40, h = 4;
    const x = cx - w / 2;
    const team = TEAMS[p.team];
    const friendly = me ? !world.isEnemyOf(me.team, p) || p.id === me.id : true;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    const k = Math.max(0, p.hp / p.maxHp);
    ctx.fillStyle = friendly ? (isMe ? '#4ade80' : '#60a5fa') : '#ef4444';
    ctx.fillRect(x, y, w * k, h);
    if (isMe) {
      ctx.strokeStyle = team.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
    }
  }

  drawNameTag(ctx, cx, y, p, isMe, world, me) {
    const team = TEAMS[p.team];
    const friendly = me ? !world.isEnemyOf(me.team, p) || p.id === me.id : true;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    // 敌人名字只在可见时显示，避免透视
    if (!friendly && me) {
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d > 900) return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const tw = ctx.measureText(p.name).width;
    ctx.fillRect(cx - tw / 2 - 4, y - 11, tw + 8, 14);
    ctx.fillStyle = friendly ? '#9fd4ff' : '#ff9a9a';
    ctx.fillText(p.name, cx, y);
  }

  /* ---------------- 烟幕 ---------------- */
  drawSmokes(ctx, world) {
    const list = world.smokes || [];
    if (!list.length) return;
    for (const s of list) {
      const left = (s.end || 0) - (world.time || 0);
      // 结束前 0.6 秒淡出
      const alpha = Math.max(0, Math.min(1, left / 0.6));
      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = 0.62 * alpha;
      // 多层柔和圆构成烟团
      const puffs = 7;
      for (let i = 0; i < puffs; i++) {
        const a = (i / puffs) * Math.PI * 2 + this.t * 0.4;
        const rr = s.r * (0.52 + 0.3 * Math.sin(this.t * 1.3 + i));
        const px = s.x + Math.cos(a) * s.r * 0.36;
        const py = s.y + Math.sin(a) * s.r * 0.28;
        const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, 'rgba(196,212,228,0.62)');
        g.addColorStop(0.55, 'rgba(150,172,192,0.34)');
        g.addColorStop(1, 'rgba(120,140,160,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ---------------- 子弹 ---------------- */
  drawBullets(ctx, world) {
    for (const b of world.bullets) {
      const w = getWeapon(b.w);
      const spd = Math.hypot(b.vx, b.vy) || 1;
      const tx = b.x - b.vx / spd * 26;
      const ty = b.y - b.vy / spd * 26;

      if (w.beam || b.pierce > 0) {
        // 穿透/光束：画长线
        ctx.strokeStyle = w.trace || '#8be9ff';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(tx * 2 - b.x, ty * 2 - b.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        // 曳光
        const g = ctx.createLinearGradient(tx, ty, b.x, b.y);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, w.trace || '#ffe08a');
        ctx.strokeStyle = g;
        ctx.lineWidth = b.rocket ? 4 : 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 弹头
      if (w.spin) {
        // 手里剑：画一个旋转的四角星
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(this.t * 18);
        ctx.fillStyle = w.trace || '#7ff0dd';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        const R = 7, r2 = 2.6;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
          ctx.lineTo(Math.cos(a + Math.PI / 4) * r2, Math.sin(a + Math.PI / 4) * r2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = '#fff8dc';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.rocket ? 3.5 : 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      if (b.rocket) {
        ctx.fillStyle = 'rgba(255,140,60,0.5)';
        ctx.beginPath();
        ctx.arc(tx, ty, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ---------------- 粒子 ---------------- */
  spawnParticle(o) {
    if (this.particles.length > 420) return;
    this.particles.push({
      x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
      life: o.life || 0.4, max: o.life || 0.4,
      r: o.r || 2, color: o.color || '#fff', grav: o.grav || 0,
      fade: o.fade !== false, glow: o.glow || false,
    });
  }

  burst(x, y, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (opts.speed || 200) * (0.4 + Math.random() * 0.6);
      this.spawnParticle({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - (opts.up || 0),
        life: (opts.life || 0.45) * (0.6 + Math.random() * 0.7),
        r: (opts.r || 2) * (0.5 + Math.random()),
        color: opts.color || '#ffd88a',
        grav: opts.grav != null ? opts.grav : 300,
        glow: opts.glow,
      });
    }
  }

  drawParticles(ctx, dt) {
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      ctx.globalAlpha = p.fade ? Math.max(0, k) : 1;
      if (p.glow) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - p.r * 3, p.y - p.r * 3, p.r * 6, p.r * 6);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
      }
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.life > 0);
  }

  /* ---------------- 曳光 / 命中特效 ---------------- */
  addTracer(x1, y1, x2, y2, color, life = 0.12) {
    this.tracers.push({ x1, y1, x2, y2, color, life, max: life });
  }

  drawTracers(ctx, dt) {
    for (const t of this.tracers) {
      t.life -= dt;
      if (t.life <= 0) continue;
      const k = t.life / t.max;
      ctx.strokeStyle = t.color;
      ctx.globalAlpha = k * 0.9;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.tracers = this.tracers.filter(t => t.life > 0);
  }

  /* ---------------- 伤害数字 ---------------- */
  addFloater(x, y, text, color, big = false) {
    this.floaters.push({ x, y, text, color, life: 0.85, max: 0.85, vy: -70, big });
  }

  drawFloaters(ctx, dt) {
    for (const f of this.floaters) {
      f.life -= dt;
      if (f.life <= 0) continue;
      f.y += f.vy * dt;
      f.vy *= 0.92;
      const k = f.life / f.max;
      ctx.globalAlpha = Math.min(1, k * 2);
      ctx.font = `900 ${f.big ? 22 : 15}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    this.floaters = this.floaters.filter(f => f.life > 0);
  }

  /* ---------------- 击杀播报（世界坐标） ---------------- */
  addKillFeed(entry) {
    this.killFeed.push({ ...entry, life: 4.5 });
    if (this.killFeed.length > 5) this.killFeed.shift();
  }

  drawKillFeed(ctx, viewW) {
    const x = this.cam.x + viewW - 250;
    let y = this.cam.y + 20;
    ctx.textAlign = 'left';
    for (const e of this.killFeed) {
      ctx.globalAlpha = Math.min(1, e.life / 0.6);
      ctx.font = '600 13px system-ui, sans-serif';
      const text = e.text;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const tw = ctx.measureText(text).width;
      ctx.fillRect(x - 8, y - 13, tw + 16, 20);
      ctx.fillStyle = e.color || '#fff';
      ctx.fillText(text, x, y);
      y += 24;
      e.life -= 0.016;
    }
    ctx.globalAlpha = 1;
    this.killFeed = this.killFeed.filter(e => e.life > 0);
  }

  /* ---------------- 屏幕特效 ---------------- */
  drawVignette(ctx, W, H) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  drawDamageFlash(ctx, W, H) {
    if (this.flash <= 0) return;
    this.flash = Math.max(0, this.flash - 0.03);
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(200,20,20,${this.flash * 0.75})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  damageFlash(v = 0.5) { this.flash = Math.max(this.flash, v); }

  addHitMarker(kind = 'hit') {
    this.hitMarkers.push({ kind, life: 0.28, max: 0.28 });
  }

  drawHitMarkers(ctx, dt) {
    const W = this.cam.w, H = this.cam.h;
    for (const m of this.hitMarkers) {
      m.life -= dt;
      if (m.life <= 0) continue;
      const k = m.life / m.max;
      const s = 8 + (1 - k) * 6;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.strokeStyle = m.kind === 'head' ? `rgba(255,220,80,${k})` : `rgba(255,255,255,${k})`;
      ctx.lineWidth = 2;
      const d = s * 0.55;
      ctx.beginPath();
      ctx.moveTo(-s, -s); ctx.lineTo(-d, -d);
      ctx.moveTo(s, -s); ctx.lineTo(d, -d);
      ctx.moveTo(-s, s); ctx.lineTo(-d, d);
      ctx.moveTo(s, s); ctx.lineTo(d, d);
      ctx.stroke();
      ctx.restore();
    }
    this.hitMarkers = this.hitMarkers.filter(m => m.life > 0);
  }

  /* ---------------- 小地图 ---------------- */
  drawMinimap(ctx, world, me, x, y, w, h) {
    const map = this.map;
    const k = w / map.width;
    const hh = map.height * k;

    ctx.fillStyle = 'rgba(8,14,22,0.82)';
    ctx.strokeStyle = 'rgba(90,130,170,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, 6);
    ctx.fill();
    ctx.stroke();

    // 地形轮廓
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, 6);
    ctx.clip();
    ctx.fillStyle = 'rgba(70,110,150,0.28)';
    for (const p of map.platforms) {
      if (p.type === 'plat') continue;
      ctx.fillRect(x + p.x * k, y + p.y * k, p.w * k, p.h * k);
    }
    // 据点
    for (const pt of world.points) {
      const col = pt.owner ? TEAMS[pt.owner].color : '#94a3b8';
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x + pt.x * k, y + pt.y * k, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // 玩家
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      const isMe = me && p.id === me.id;
      const friendly = me ? (!world.isEnemyOf(me.team, p) || isMe) : true;
      ctx.fillStyle = isMe ? '#ffffff' : (friendly ? TEAMS[p.team].color : '#ff5252');
      ctx.beginPath();
      ctx.arc(x + (p.x + p.w / 2) * k, y + (p.y + p.bh / 2) * k, isMe ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 视野框
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + this.cam.x * k, y + this.cam.y * k, (this.viewW || 0) * k, (this.viewH || 0) * k);
  }
}
