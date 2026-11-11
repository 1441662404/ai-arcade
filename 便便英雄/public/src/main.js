/**
 * 便便英雄 3D · 下水道大乱斗 —— 客户端主逻辑
 * 输入采集 / 相机 / 姿态同步 / HUD / 糊视野表现
 */
import * as THREE from 'three';
import { createWorld, createRenderer } from './world.js';
import { createPoopHero, createViewModel, createGrenadeMesh, createRollBallMesh } from './model.js';
import { FX, SFX, initAudio, makeSplatBlob, toggleMute } from './fx.js';
import { createLocalGame } from './local-server.js';

/* 单机模式：URL 带 ?local=1 时用浏览器内的本地服务端，不连 WebSocket */
const LOCAL_MODE = new URLSearchParams(location.search).has('local');
let localGame = null;
let localAcc = 0;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

// ============================ 状态 ============================
let ws = null, myId = null, mapData = null, cfg = null;
let scene = null, camera = null, renderer = null, fx = null, vm = null, world = null;
/** id -> { hero, cur:{x,y,z,yaw,pitch}, tgt:{...}, hpBar, meta } */
const heroes = new Map();
let grenadeMeshes = [];
let rollBallMeshes = [];
let mySnapshot = null;
let started = false;
let netTimer = 0, lastSnapAt = 0, ping = 0;

// 本地输入状态
const keys = Object.create(null);
let camYaw = 0, camPitch = 0;
let mouseShoot = false, mouseAim = false;
let wantGrenade = false, wantRoll = false, wantFly = false;
let lastSpaceAt = 0;
let rollSound = null;
let lastMuzzleAt = 0, recoil = 0, aimK = 0, walkT = 0, bentK = 0, bob = 0, landK = 0, prevY = 0;
let recoilPitch = 0;   // 后坐力俯仰偏移（独立衰减，不污染 camPitch，避免射击方向永久漂移）
let camWalkT = 0, wasAir = false;   // 镜头跑动摆动相位 / 上一帧是否在空中（落地缓冲）
let dmgFlash = 0;
let timeLeft = 0;
let lastBlur = -1, lastTint = -1;   // 缓存糊视野 blur / tint 值，避免每帧重复 set 触发重排
let hitMarkAt = 0;
let deadAt = 0;

// ============================ DOM ============================
const elSplats = $('#splats'), elTint = $('#messTint'), elCanvas = $('#game');
const elSpeed = $('#speedfx'), elHitmark = $('#hitmark');
const elHpFill = $('#hpFill'), elHpNum = $('#hpNum'), elPName = $('#pName');
const elPoopFill = $('#poopFill'), elPoopNum = $('#poopNum'), elPoopBar = $('#poopBar');
const elCross = $('#cross'), elFeed = $('#feed'), elCenter = $('#center');
const elDead = $('#dead'), elDeadS = $('#deadS'), elHint = $('#hint');
const elSkG = $('#skG'), elSkR = $('#skR'), elSkF = $('#skF');
const elMenu = $('#menu'), elStatus = $('#status');
const elScore = $('#score'), elScoreRows = $('#scoreRows');
const elDmg = $('#dmgFlash');

/** 环形冷却：用 stroke-dashoffset 画进度（2πr ≈ 176） */
const RING_LEN = 176;
function setRing(el, pct) {
  const fg = el.querySelector ? el.querySelector('.ring .fg') : null;
  if (!fg) return;
  fg.style.strokeDashoffset = (RING_LEN * clamp(pct, 0, 1)).toFixed(1);
}
/** 技能释放成功时闪一下 */
function skillFlash(el) {
  if (!el) return;
  el.classList.remove('did');
  void el.offsetWidth;
  el.classList.add('did');
}

// 溅片纹理：预生成几张，命中时随机往屏幕上糊一小片
const SPLAT_TEXES = [0, 0, 0, 0, 0].map(() => makeSplatBlob(512));
function spawnSplat(n = 1) {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'splat';
    const s = 112 + Math.random() * 184;   // 镜头上糊的屎点子（比之前大一倍）
    d.style.width = d.style.height = s + 'px';
    d.style.left = (8 + Math.random() * 84) + '%';
    d.style.top = (8 + Math.random() * 84) + '%';
    d.style.transform = `translate(-50%,-50%) rotate(${Math.random() * 360 | 0}deg)`;
    d.style.backgroundImage = `url(${SPLAT_TEXES[(Math.random() * SPLAT_TEXES.length) | 0]})`;
    elSplats.appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = (0.7 + Math.random() * 0.3).toFixed(2); });
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 900); }, 2600 + Math.random() * 1800);
  }
  while (elSplats.children.length > 12) elSplats.removeChild(elSplats.firstChild);   // 最多同时 12 片
}
function clearSplats() { elSplats.innerHTML = ''; }

// ============================ 联网 ============================
function connect() {
  /* ---- 单机模式：不建 WebSocket，直接起本地服务端 ---- */
  if (LOCAL_MODE) {
    return new Promise((resolve) => {
      localGame = createLocalGame({ name: '玩家' });
      ws = { readyState: 1, close() {}, send() {} };
      myId = localGame.id;
      mapData = localGame.map;
      cfg = localGame.cfg;
      elPName.textContent = localGame.name;
      botCfg.enabled = true;
      botCfg.count = Math.max(0, localGame.players.size - 1);
      botCfg.max = 8;
      buildScene();
      syncBotUI();
      resolve();
    });
  }

  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连接失败'));
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'welcome') {
        myId = m.id; mapData = m.map; cfg = m.cfg;
        elPName.textContent = m.name;
        if (m.bots) { botCfg.enabled = !!m.bots.enabled; botCfg.count = m.bots.count | 0; botCfg.max = m.bots.max || 8; }
        buildScene();
        syncBotUI();
  // 调试接口（控制台可用）：window.__dbg() / window.__third = true
  window.__dbg = () => ({ heroes, camera, fx, get myId() { return myId; }, get snap() { return mySnapshot; }, spawnSplat });
  window.__setAim = (yaw, pitch = 0) => { camYaw = yaw + Math.PI; camPitch = pitch; };
  // 调试：自杀（触发完整死亡→复活流程，自动化测试用）
  window.__kill = () => send({ t: 'chat', text: '/kill' });
  // 调试：机器人配置只读快照（自动化测试用）
  window.__botCfg = () => ({ ...botCfg });
  window.__myState = () => {
    const me = heroes.get(myId);
    return mySnapshot ? {
      x: mySnapshot.x, y: mySnapshot.y, z: mySnapshot.z,
      pp: mySnapshot.pp, fly: mySnapshot.fly, hp: mySnapshot.hp, alive: mySnapshot.alive,
      // 渲染位置（客户端预测）与服务器权威位置的差值，用于诊断移动抖动
      renderX: me ? me.cur.x : null, renderZ: me ? me.cur.z : null,
      predX: me ? me.pred.x : null, predZ: me ? me.pred.z : null,
      anchorX: me ? me.anchor.x : null, anchorZ: me ? me.anchor.z : null,
    } : null;
  };
  window.__input = () => ({ mouseShoot, mouseAim, wantFly, started });
  window.__mouse = (down, btn = 0) => { if (btn === 0) mouseShoot = down; else mouseAim = down; };
      } else if (m.t === 'snap') {
        lastSnapAt = performance.now();
        window.__rawSnap = m;          // 调试：完整快照（含 grenades / balls）
        applySnapshot(m);
      }
    };
    ws.onclose = () => {
      elStatus.textContent = '⚠️ 与服务器断开，刷新页面重连（确认 server.js 还在运行）';
      elStatus.style.color = '#ff8f7a';
    };
  });
}

function send(obj) {
  /* 单机：输入直接喂给本地服务端，其余消息忽略 */
  if (LOCAL_MODE) {
    if (obj && obj.t === 'input' && localGame) localGame.setInput(obj);
    return;
  }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ============================ 场景 ============================
function buildScene() {
  if (scene) return;
  const w = createWorld(mapData, cfg);
  scene = w.scene;
  world = w;
  camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.06, 500);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  renderer = createRenderer(elCanvas);
  fx = new FX(scene, camera);
  // 把地图碰撞盒交给特效系统：屎炸开时才知道污渍该贴在箱子/墙上还是地上
  fx.coverBoxes = Array.isArray(mapData) ? mapData : [];

  vm = createViewModel();
  vm.group.position.set(0.23, -0.2, -0.44);
  camera.add(vm.group);

  // 给手持武器补一点光，不然逆光时枪就是一坨黑
  const vmLight = new THREE.PointLight(0xfff1dd, 1.1, 2.2, 2);
  vmLight.position.set(0.35, 0.25, 0.15);
  camera.add(vmLight);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });
}

function makeHpBar() {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.12),
    new THREE.MeshBasicMaterial({ color: 0x1a0f06, transparent: true, opacity: 0.6, depthTest: false }));
  const fg = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.09),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, depthTest: false }));
  fg.position.z = 0.002;
  g.add(bg, fg);
  g.position.y = 1.95;
  g.renderOrder = 999;
  g.userData.fg = fg;
  return g;
}

function ensureHero(p) {
  let h = heroes.get(p.id);
  if (!h) {
    const hero = createPoopHero(p.color);
    const hpBar = makeHpBar();
    hero.root.add(hpBar);
    scene.add(hero.root);
    hero.setLabel(p.name, p.id === myId ? '#ffd34d' : '#ffffff');
    h = {
      hero, hpBar,
      cur: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch },
      tgt: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch },
      // 客户端预测状态：pred = 本地推演位置，err = 相对服务器的误差（逐步补偿）
      pred: { x: p.x, z: p.z },
      err: { x: 0, z: 0 },
      anchor: { x: p.x, z: p.z },
      meta: { name: p.name, hp: p.hp, pose: 'idle', down: 0, alive: 1, poop: 100, fly: 0 },
    };
    heroes.set(p.id, h);
  }
  return h;
}

function applySnapshot(msg) {
  // 清理离线玩家
  const alive = new Set(msg.players.map(p => p.id));
  for (const [id, h] of heroes) {
    if (!alive.has(id)) { scene.remove(h.hero.root); heroes.delete(id); }
  }
  for (const p of msg.players) {
    const h = ensureHero(p);
    h.tgt.x = p.x; h.tgt.y = p.y; h.tgt.z = p.z; h.tgt.yaw = p.yaw; h.tgt.pitch = p.pitch;
    h.meta.name = p.name; h.meta.hp = p.hp; h.meta.pose = p.pose;
    h.meta.down = p.down; h.meta.alive = p.alive;
    h.meta.blur = p.blur; h.meta.gcd = p.g; h.meta.rcd = p.r;
    h.meta.poop = p.pp; h.meta.fly = p.fly;
    h.meta.k = p.k; h.meta.d = p.d; h.meta.bot = p.bot;
    if (p.id === myId) {
      // 复活检测：alive 从 0→1 = 服务器权威传送，必须"整包对齐"（视角 + 预测位置）。
      // 旧实现只同步视角、位置仍走"距离>6m 才瞬移"：出生点若距死亡位置不到 6m，
      // 预测残差会交给 errD>3 的软对齐暴力拉扯（首帧可达 20m/s+）→ 复活后视角抽搐
      const wasAlive = mySnapshot ? mySnapshot.alive : 1;
      const resetPv = () => { h.pv = { x: p.x, y: p.y, z: p.z, vy: 0, onGround: true }; };
      if (wasAlive === 0 && p.alive === 1) {
        camYaw = p.yaw + Math.PI;
        camPitch = p.pitch;
        h.cur.x = h.pred.x = h.anchor.x = p.x;
        h.cur.z = h.pred.z = h.anchor.z = p.z;
        h.cur.y = p.y;
        h.err.x = h.err.z = 0;
        resetPv();
      } else if (p.alive === 0) {
        // 死亡期间服务器不移动玩家：预测位置钉死在服务器位置，
        // 防止死亡镜头漂移 + 残差累积到复活瞬间集中爆发
        h.cur.x = h.pred.x = h.anchor.x = p.x;
        h.cur.z = h.pred.z = h.anchor.z = p.z;
        h.err.x = h.err.z = 0;
        resetPv();
      }
      mySnapshot = p;
    }
    // 复活/传送：距离过大直接瞬移，避免拖尾
    const d = Math.hypot(h.cur.x - p.x, h.cur.z - p.z);
    if (d > 6) {
      h.cur.x = h.pred.x = p.x; h.cur.y = p.y; h.cur.z = h.pred.z = p.z;
      h.err.x = h.err.z = 0;
      if (p.id === myId) h.pv = { x: p.x, y: p.y, z: p.z, vy: 0, onGround: true };
    } else if (p.id === myId) {
      // 自己角色：本地预测独立推进，服务器位置作为"锚点"
      // 关键：不做持续误差拉扯。只记录一个缓慢跟随的"服务器锚点"，用于在误差过大时软对齐
      h.anchor.x = p.x; h.anchor.z = p.z;
    }
  }
  timeLeft = msg.time;
  if (msg.bots) {
    const ch = botCfg.enabled !== !!msg.bots.enabled || botCfg.count !== (msg.bots.count | 0);
    botCfg.enabled = !!msg.bots.enabled; botCfg.count = msg.bots.count | 0; botCfg.max = msg.bots.max || 8;
    if (ch) syncBotUI();
  }
  if (msg.top) updateLeaderboard(msg.top);
  syncGrenades(msg.grenades);
  syncBalls(msg.balls);
  handleEvents(msg.players, msg.ev);
}

// ============================ 排行榜 ============================
let lastTopKey = '';
function updateLeaderboard(top) {
  const box = document.getElementById('lbRows');
  if (!box) return;
  const myRank = top.findIndex(r => r.id === myId);
  const key = top.map(r => `${r.id}:${r.k}:${r.d}:${r.alive}`).join('|') + '#' + myRank;
  if (key === lastTopKey) return;
  lastTopKey = key;
  box.innerHTML = top.map((r, i) => {
    const isMe = r.id === myId;
    const rank = i + 1;
    const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    const kd = r.d > 0 ? (r.k / r.d).toFixed(2) : (r.k > 0 ? r.k.toFixed(2) : '0.00');
    return `<div class="lb-row ${isMe ? 'me' : ''} ${r.alive ? '' : 'off'}">
      <span class="lb-rank ${medal}">${rank}</span>
      <span class="lb-name">${r.bot ? '<em class="lb-bot">BOT</em>' : ''}${r.name}${isMe ? '<em class="lb-you">你</em>' : ''}</span>
      <span class="lb-k">${r.k}</span>
      <span class="lb-d">${r.d}</span>
      <span class="lb-kd">${kd}</span>
    </div>`;
  }).join('');
}

function syncBalls(list) {
  list = list || [];
  while (rollBallMeshes.length < list.length) {
    const m = createRollBallMesh();
    scene.add(m);
    rollBallMeshes.push(m);
  }
  for (let i = 0; i < rollBallMeshes.length; i++) {
    const m = rollBallMeshes[i];
    m.visible = i < list.length;
    if (i < list.length) {
      const b = list[i];
      m.position.set(b.x, b.y, b.z);
      m.rotation.y = b.a;
      m.userData.spin.rotation.x = b.s;
      m.scale.setScalar(b.stop ? 0.9 : 1);

      // ===== 滚粪球路径：非常夸张的屎点子轨迹 =====
      const ud = m.userData;
      const dir = { x: Math.sin(b.a), z: Math.cos(b.a) };
      if (!ud.lastTrail) ud.lastTrail = new THREE.Vector2(b.x, b.z);
      const dt2 = Math.hypot(b.x - ud.lastTrail.x, b.z - ud.lastTrail.y);
      // 采样更密（0.45m 一次）→ 路径上的屎点子连成一条明显的痕迹
      if (dt2 > 0.42 && !b.stop) {
        const steps = Math.min(4, Math.max(1, Math.round(dt2 / 0.45)));
        for (let s = 1; s <= steps; s++) {
          const k = s / steps;
          const px = ud.lastTrail.x + (b.x - ud.lastTrail.x) * k;
          const pz = ud.lastTrail.y + (b.z - ud.lastTrail.y) * k;
          fx.ballTrail(new THREE.Vector3(px, 0, pz), dir, b.s);
        }
        // 球体本身也在甩屎：沿滚动方向抛出一串大颗粒
        fx.burst(new THREE.Vector3(b.x, 0.35, b.z), 0x6b4423, 5, 4.2, 1.1, 0.7);
        fx.burst(new THREE.Vector3(b.x, 0.22, b.z), 0x8b5a2b, 3, 2.6, 0.8, 0.55);
        ud.lastTrail.set(b.x, b.z);
      }
      // 球还在滚：每帧补一点点扬起的屎点子（让画面一直是"在甩屎"的状态）
      if (!b.stop && Math.random() < 0.7) {
        fx.ballTrail(new THREE.Vector3(b.x, 0, b.z), dir, b.s);
      }
    } else {
      m.userData.lastTrail = null;
    }
  }
}

function syncGrenades(list) {
  while (grenadeMeshes.length < list.length) {
    const m = createGrenadeMesh();
    scene.add(m);
    grenadeMeshes.push(m);
  }
  for (let i = 0; i < grenadeMeshes.length; i++) {
    grenadeMeshes[i].visible = i < list.length;
    if (i < list.length) grenadeMeshes[i].position.set(list[i].x, list[i].y, list[i].z);
  }
}

// ============================ 事件 ============================
function nameOf(players, id) {
  const p = players.find(q => q.id === id);
  return p ? p.name : '某路人';
}
function feed(html) {
  const d = document.createElement('div');
  d.className = 'feedline'; d.innerHTML = html;
  elFeed.appendChild(d);
  while (elFeed.children.length > 6) elFeed.removeChild(elFeed.firstChild);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 5200);
}
function centerMsg(text, sub = '') {
  elCenter.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
  elCenter.style.opacity = '1';
  clearTimeout(centerMsg._t);
  centerMsg._t = setTimeout(() => { elCenter.style.opacity = '0'; }, 2200);
}
function showHitmark(lethal = false) {
  elHitmark.classList.add('on');
  elHitmark.classList.toggle('lethal', !!lethal);
  clearTimeout(showHitmark._t);
  showHitmark._t = setTimeout(() => elHitmark.classList.remove('on'), lethal ? 190 : 110);
}

// ---------- 受击方向指示器（主流射击游戏标配：被打时告诉你子弹从哪来） ----------
function showHitDir(ax, az) {
  const me = heroes.get(myId);
  if (!me) return;
  const d = document.getElementById('hitdirs');
  if (!d) return;
  const v = document.createElement('i');
  v.className = 'hitdir';
  // 相对我朝向的角度（我的 yaw 以 +Z 为前）
  const ang = Math.atan2(ax - me.cur.x, az - me.cur.z) - me.cur.yaw;
  v.style.transform = `translate(-50%,-50%) rotate(${(ang * 180 / Math.PI).toFixed(1)}deg) translateY(-88px)`;
  d.appendChild(v);
  requestAnimationFrame(() => { v.style.opacity = '1'; });
  setTimeout(() => { v.style.opacity = '0'; setTimeout(() => v.remove(), 500); }, 700);
}

// ---------- CF 风格击杀反馈卡片 ----------
// CF 风格击杀图标：金色骷髅 + 右下角武器徽章（纯 SVG，不吃平台 emoji 差异）
function killIconSVG(kind) {
  const skull = `
    <path d="M32 5C18 5 9.5 14.6 9.5 26.4c0 7.2 3.2 12.6 8.3 15.8v7.4c0 2.3 1.9 4.2 4.2 4.2h20c2.3 0 4.2-1.9 4.2-4.2v-7.4c5.1-3.2 8.3-8.6 8.3-15.8C54.5 14.6 46 5 32 5z" fill="#ffd34d" stroke="#6b3f06" stroke-width="2.6" stroke-linejoin="round"/>
    <ellipse cx="23.6" cy="27.5" rx="5.6" ry="6.6" fill="#2a1804"/>
    <ellipse cx="40.4" cy="27.5" rx="5.6" ry="6.6" fill="#2a1804"/>
    <path d="M32 34.5l4.4 7.5h-8.8z" fill="#2a1804"/>
    <path d="M25.5 50.5v5.5M32 50.5v6.5M38.5 50.5v5.5" stroke="#6b3f06" stroke-width="2.6" stroke-linecap="round"/>`;
  const crossbones = `
    <g stroke="#6b3f06" stroke-width="2.2" fill="#f0b32a">
      <rect x="6" y="28.5" width="52" height="7" rx="3.5" transform="rotate(28 32 32)"/>
      <rect x="6" y="28.5" width="52" height="7" rx="3.5" transform="rotate(-28 32 32)"/>
    </g>`;
  const badge = (inner) => `
    <g transform="translate(40,40) scale(0.42)">
      <circle cx="11" cy="11" r="10.5" fill="#2a1804"/>
      ${inner}
    </g>`;
  const badges = {
    gun: badge('<path d="M3.5 8.5h13l-1 2.2h-4.2l-.8 2.6h-2.4l.7-2.6H5.6z" fill="#ffd34d"/><rect x="13.8" y="7.2" width="3.2" height="1.8" fill="#ffd34d"/>'),
    head: badge('<circle cx="11" cy="11" r="6.6" fill="none" stroke="#ffd34d" stroke-width="1.9"/><circle cx="11" cy="11" r="1.7" fill="#ffd34d"/><path d="M11 2.6v3.4M11 16v3.4M2.6 11H6M16 11h3.4" stroke="#ffd34d" stroke-width="1.9" stroke-linecap="round"/>'),
    grenade: badge('<rect x="7.4" y="7.5" width="7.2" height="9.5" rx="3.4" fill="#ffd34d"/><rect x="9.6" y="4.6" width="2.8" height="2.6" fill="#ffd34d"/><path d="M12.2 4.8c2 .4 3 1.6 3.4 3.1" fill="none" stroke="#ffd34d" stroke-width="1.7"/>'),
    roll: badge('<path d="M11 3.6a7.4 7.4 0 1 1-7.4 7.4" fill="none" stroke="#ffd34d" stroke-width="2.6" stroke-linecap="round"/><path d="M11 7.4a3.6 3.6 0 1 1-3.6 3.6" fill="none" stroke="#ffd34d" stroke-width="2.2" stroke-linecap="round"/>'),
  };
  const base = kind === 'head'
    ? `<circle cx="32" cy="32" r="29" fill="none" stroke="#ffd34d" stroke-width="2.4" opacity=".85"/>
       <path d="M32 3v10M32 51v10M3 32h10M51 32h10" stroke="#ffd34d" stroke-width="2.4" stroke-linecap="round" opacity=".9"/>${skull}`
    : (kind === 'grenade' || kind === 'roll' ? crossbones + skull : skull);
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${base}${badges[kind] || ''}</svg>`;
}
const STREAK_TEXT = {
  1: { t: '', s: '' },
  2: { t: '双杀', s: 'DOUBLE KILL' },
  3: { t: '三杀', s: 'TRIPLE KILL' },
  4: { t: '四杀', s: 'QUADRA KILL' },
  5: { t: '五杀', s: 'PENTA KILL' },
};
function showKillCard(victim, streak, kind) {
  const box = document.getElementById('killcard');
  if (!box) return;
  const info = STREAK_TEXT[Math.min(streak, 5)] || { t: `连杀 ${streak}`, s: 'KILL STREAK' };
  box.innerHTML = `
    <div class="kc-icon">${killIconSVG(kind)}${streak >= 2 ? `<span class="kc-x">×${streak}</span>` : ''}</div>
    <div class="kc-main">
      <div class="kc-name">${victim}</div>
      ${info.t ? `<div class="kc-streak">${info.t}<span>${info.s}</span></div>` : '<div class="kc-streak kc-single">击杀<span>KILL</span></div>'}
    </div>`;
  box.classList.remove('on');
  void box.offsetWidth;
  box.classList.add('on');
  clearTimeout(showKillCard._t);
  showKillCard._t = setTimeout(() => box.classList.remove('on'), 1500);
}
window.__killCard = showKillCard;   // 调试：控制台可试卡片

// ---------- 机器人开关（服务器权威同步） ----------
let botCfg = { enabled: false, count: 0, max: 8 };
function syncBotUI() {
  const box = document.getElementById('bots');
  const sw = document.getElementById('botSw');
  const rg = document.getElementById('botCount');
  const num = document.getElementById('botNum');
  if (!box) return;
  if (sw) sw.classList.toggle('on', !!botCfg.enabled);
  if (rg) { rg.value = String(botCfg.count); rg.max = String(botCfg.max || 8); }
  if (num) { num.textContent = botCfg.enabled ? String(botCfg.count) : '关'; num.dataset.on = botCfg.enabled ? '1' : '0'; }
}
function sendBots(patch) {
  Object.assign(botCfg, patch);
  syncBotUI();
  send({ t: 'bots', enabled: botCfg.enabled, count: botCfg.count });
}

function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
const myPos = () => (heroes.get(myId) ? heroes.get(myId).cur : { x: 0, y: 0, z: 0 });
function volAt(pos) { const d = dist3(pos, myPos()); return clamp(1 - d / 55, 0.05, 1); }

function handleEvents(players, evs) {
  if (!evs || !evs.length) return;
  for (const e of evs) {
    const near = (p) => clamp(1 - dist3(p, myPos()) / 60, 0, 1);
    if (e.k === 'shot') {
      const to = new THREE.Vector3(e.hx, e.hy, e.hz);
      let from = new THREE.Vector3(e.x, e.y, e.z);
      const mine = e.id === myId;
      // 自己开枪：从画面右下角的枪口喷出去（别在镜头正前方糊一大块）
      if (mine && vm && camera) {
        camera.updateMatrixWorld();
        const mp = vm.muzzleLocal.clone();
        vm.group.localToWorld(mp);
        from = mp;
        fx.muzzle(mp.clone(), to.clone().sub(mp).normalize(), 0.075);
      } else {
        fx.muzzle(from.clone().addScaledVector(to.clone().sub(from).normalize(), 0.55), null);
      }
      fx.poopShot(from, to, { nx: e.nx, ny: e.ny, nz: e.nz, hit: e.hit });   // 可见的粪弹 + 拖尾
      const v = volAt(from);
      SFX.shot(v);
      if (mine) {
        // 后坐力：枪身后退 + 轻微上跳 + 准星扩散（主流射击游戏的枪感）
        recoil = Math.min(1, recoil + 0.5);
        recoilPitch += 0.003;                     // 枪口上跳（独立偏移，指数衰减自动回落，不污染视角）
        fx.addShake(0.05);
        lastMuzzleAt = performance.now();
      }
    } else if (e.k === 'hit') {
      const t = heroes.get(e.id);
      if (t && e.id !== myId) {          // 自己中弹只溅屏幕，别在脸前炸 3D 碎块
        fx.splat(new THREE.Vector3(t.cur.x, t.cur.y + 1.2, t.cur.z));
      }
      if (e.id === myId) {
        dmgFlash = 1;
        fx.addShake(0.26);
        SFX.splat();
        // 受击方向指示：从攻击者方向来的红色弧线（主流射击游戏标配）
        if (e.ax || e.az) showHitDir(e.ax, e.az);
        spawnSplat(1 + (Math.random() < 0.4 ? 1 : 0));   // 被糊一脸：溅一小片
      } else if (e.by === myId) {
        SFX.hitmark(0.9);
        showHitmark(e.hp <= 0);
      }
    } else if (e.k === 'fly') {
      SFX.jet(volAt(myPos()));
      if (e.id === myId) {
        fx.addShake(0.3);
        centerMsg('🚀 喷气起跳！', '跳得更高 · 屎量狂喷中');
      }
    } else if (e.k === 'flyend') {
      if (e.id === myId && e.out) centerMsg('💩 屎喷光了', '等条子慢慢回满');
    } else if (e.k === 'dry') {
      if (e.id === myId) {
        SFX.dry();
        elPoopBar.classList.remove('dry');
        void elPoopBar.offsetWidth;
        elPoopBar.classList.add('dry');
        centerMsg('💩 你已经拉不出来了！', '等屎条慢慢恢复');
      }
    } else if (e.k === 'boom') {
      const p = new THREE.Vector3(e.x, e.y, e.z);
      // 屎榴弹炸开 = 屎炸得四处飞溅（不是火球）
      fx.shiBoom(p, e.r || 5.5);
      SFX.splatWet(volAt(p));
      if (Math.hypot(p.x - myPos().x, p.z - myPos().z) < (e.r || 5.5)) showHitDir(e.x, e.z);
    } else if (e.k === 'grenade') {
      SFX.throwG(volAt(myPos()));
      if (e.id === myId) centerMsg('💣 背身投弹！', '撅起屁股，把屎榴弹甩出去');
    } else if (e.k === 'ball') {
      SFX.ballRoll(volAt(myPos()));
      if (e.id === myId) centerMsg('🌀 滚粪球！', '放出的大粪球自己滚 30 米');
    } else if (e.k === 'smash') {
      const p = new THREE.Vector3(e.x, e.y, e.z);
      // 被大粪球碾到：一大坨屎糊上来
      fx.burst(p, 0x8b5a2b, 26, 9, 1.3, 0.8);
      fx.burst(p, 0x4a2f1b, 16, 6, 1.6, 1.0);
      fx.poopDecal(new THREE.Vector3(e.x, 0.014, e.z), new THREE.Vector3(0, 1, 0), 1.5 + Math.random() * 0.8, 18000);
      fx.addShake(e.target === myId ? 1.0 : 0.34);
      SFX.down(volAt(p));
      if (e.target === myId) {
        centerMsg('💥 被滚球撞飞！', '倒地 · 溅一脸');
        spawnSplat(5);
      }
      else if (e.id === myId) {
        centerMsg('💥 命中！', '粪球把他滚倒了');
        showHitmark(true);
      }
    } else if (e.k === 'die') {
      const victim = nameOf(players, e.id);
      const killer = nameOf(players, e.by);
      const self = e.by === myId && e.id !== myId;
      feed(`${self ? '💀' : '💩'} <b style="color:#ffd34d">${killer}</b> 糊死了 <b>${victim}</b>`);
      if (e.id === myId) {
        SFX.die();
        spawnSplat(6);
        deadAt = performance.now();
        elDead.style.display = 'flex';
        elDeadS.textContent = `被 ${e.by === e.id ? '自己' : killer} 解决 · 4 秒后满血复活`;
      } else if (self) {
        // ===== CF 风格击杀反馈 =====
        const st = Math.max(1, e.streak | 0);
        SFX.killFeed(st, 1);
        showKillCard(victim, st, e.kind);
      }
    } else if (e.k === 'bots') {
      botCfg.enabled = !!e.enabled; botCfg.count = e.count | 0;
      syncBotUI();
      feed(`<span style="opacity:.8">🤖 ${e.by || '服务器'} 把机器人设为 ${e.enabled ? e.count + ' 个' : '关闭'}</span>`);
      centerMsg(e.enabled ? `🤖 机器人 ×${e.count}` : '🤖 机器人已关闭', '所有玩家同步生效');
    } else if (e.k === 'spawn') {
      if (e.id === myId) {
        clearSplats();
        elDead.style.display = 'none';
        centerMsg('复活！', '继续糊他们');
      }
    } else if (e.k === 'join') {
      feed(`<span style="opacity:.8">${e.name} 加入战场</span>`);
    } else if (e.k === 'chat') {
      pushChat(e.name, e.text, e.id === myId);
    } else if (e.k === 'leave') {
      feed(`<span style="opacity:.8">${e.name} 离开了</span>`);
    } else if (e.k === 'over') {
      centerMsg('🏆 本局结束', e.id ? `${e.name} 达成 ${cfg ? cfg.killLimit : 20} 杀` : '时间到');
    } else if (e.k === 'restart') {
      centerMsg('🔄 新一局开始', '杀穿他们');
      clearSplats();
      elDead.style.display = 'none';
    }
  }
}

// ============================ 输入 ============================
const KEYMAP = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', Space: 'jump' };

// ---------- 文字聊天（回车开关）+ 中键圆盘快捷指令 ----------
let chatOpen = false;
const elChatbar = $('#chatbar'), elChatInput = $('#chatInput'), elChatlog = $('#chatlog');

function toggleChat(open) {
  chatOpen = open;
  if (elChatbar) elChatbar.style.display = open ? 'flex' : 'none';
  if (open) {
    if (elChatInput) { elChatInput.value = ''; elChatInput.focus(); }
    if (document.pointerLockElement) document.exitPointerLock();
    Object.keys(keys).forEach((k) => { keys[k] = false; });
    mouseShoot = false; mouseAim = false;
  } else {
    if (elChatInput) elChatInput.blur();
    if (started && document.pointerLockElement !== elCanvas) elCanvas.requestPointerLock();
  }
}

function pushChat(name, text, mine) {
  if (!elChatlog) return;
  const line = document.createElement('div');
  line.className = 'chatline' + (mine ? ' mine' : '');
  line.innerHTML = `<b>${name}：</b>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}`;
  elChatlog.appendChild(line);
  while (elChatlog.children.length > 6) elChatlog.removeChild(elChatlog.firstChild);
  requestAnimationFrame(() => line.classList.add('on'));
  setTimeout(() => { line.classList.remove('on'); setTimeout(() => line.remove(), 400); }, 6500);
}

// 中键圆盘：按住中键拉出圆盘，松开在指令上即发送
const QUICK_MSGS = [
  { t: '上啊！兄弟们！', ico: '⚔️' },
  { t: '掩护我！', ico: '🛡️' },
  { t: '撤退！快跑！', ico: '🏃' },
  { t: '哈哈哈哈！糊死你！', ico: '💩' },
  { t: '干得漂亮！', ico: '👍' },
  { t: '救救我……', ico: '🆘' },
];
let radialOpen = false, radialPick = -1;
const elRadial = $('#radial');

function buildRadial() {
  if (!elRadial) return;
  elRadial.innerHTML = '<div class="rhub">松开发送 · 中键</div>';
  const R = 96;
  QUICK_MSGS.forEach((q, i) => {
    const a = (i / QUICK_MSGS.length) * Math.PI * 2 - Math.PI / 2;
    const it = document.createElement('div');
    it.className = 'ritem';
    it.style.transform = `translate(${Math.cos(a) * R}px, ${Math.sin(a) * R}px)`;
    it.innerHTML = `<span class="rico">${q.ico}</span>${q.t}`;
    elRadial.appendChild(it);
  });
}
buildRadial();

function openRadial(x, y) {
  if (!elRadial || !started) return;
  radialOpen = true; radialPick = -1;
  elRadial.style.left = x + 'px';
  elRadial.style.top = y + 'px';
  elRadial.classList.add('on');
  if (document.pointerLockElement) document.exitPointerLock();
  mouseShoot = false; mouseAim = false;
}
function moveRadial(x, y) {
  if (!radialOpen || !elRadial) return;
  const dx = x - parseFloat(elRadial.style.left), dy = y - parseFloat(elRadial.style.top);
  const d = Math.hypot(dx, dy);
  const kids = elRadial.querySelectorAll('.ritem');
  let pick = -1;
  if (d > 26) {
    let a = Math.atan2(dy, dx) + Math.PI / 2;         // 与 buildRadial 的角度对齐
    if (a < 0) a += Math.PI * 2;
    pick = Math.round(a / (Math.PI * 2) * QUICK_MSGS.length) % QUICK_MSGS.length;
  }
  radialPick = pick;
  kids.forEach((k, i) => k.classList.toggle('sel', i === pick));
}
function closeRadial(doSend) {
  if (!radialOpen) return;
  radialOpen = false;
  if (elRadial) elRadial.classList.remove('on');
  if (doSend && radialPick >= 0) {
    send({ t: 'chat', text: QUICK_MSGS[radialPick].t });
  }
  if (started && document.pointerLockElement !== elCanvas) elCanvas.requestPointerLock();
}

addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && started && !radialOpen) {
    e.preventDefault();
    if (chatOpen) {
      const v = elChatInput ? elChatInput.value.trim() : '';
      if (v) send({ t: 'chat', text: v });
      toggleChat(false);
    } else toggleChat(true);
    return;
  }
  if (e.code === 'Escape' && chatOpen) { toggleChat(false); return; }
  if (chatOpen) return;                       // 打字时不触发游戏按键
  if (e.code === 'Tab') { e.preventDefault(); elScore.style.display = 'block'; updateScore(); return; }
  if (!started) return;
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; if (e.code === 'Space') e.preventDefault(); }
  if (e.code === 'Space' && !e.repeat) {
    // 双击空格 = 喷射（300ms 内第二下）
    const now = performance.now();
    if (now - lastSpaceAt < 300) {
      wantFly = true; lastSpaceAt = 0;
      window.__flyKeyCount = (window.__flyKeyCount || 0) + 1;
    } else lastSpaceAt = now;
  }
  if (e.code === 'KeyQ') { wantGrenade = true; skillFlash(elSkG); }
  if (e.code === 'KeyE') { wantRoll = true; skillFlash(elSkR); }
  if (e.code === 'KeyM') toggleMute();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Tab') { elScore.style.display = 'none'; return; }
  if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false;
});

elCanvas.addEventListener('mousedown', (e) => {
  if (!started || chatOpen || radialOpen) return;
  if (e.button === 0) mouseShoot = true;
  if (e.button === 2) mouseAim = true;
  if (e.button === 1) { e.preventDefault(); openRadial(e.clientX, e.clientY); }
});
addEventListener('mousemove', (e) => { if (radialOpen) moveRadial(e.clientX, e.clientY); });
addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseShoot = false;
  if (e.button === 2) mouseAim = false;
  if (e.button === 1 && radialOpen) closeRadial(true);
});
// 中键松开兜底：用 pointerup（比 mouseup 更可靠，pointer lock 切换时也不会丢事件）
addEventListener('pointerup', (e) => {
  if (e.button === 1 && radialOpen) closeRadial(true);
});
// 终极兜底：鼠标进入画布时若转盘还开着却没按住中键，强制关闭
addEventListener('pointerdown', (e) => {
  if (radialOpen && e.button !== 1) closeRadial(false);
});
addEventListener('blur', () => { if (radialOpen) closeRadial(false); });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });  // 禁掉中键自动滚动

// ============================ 机器人开关（服务器同步） ============================
(function bindBotPanel() {
  const sw = $('#botSw'), rg = $('#botCount'), num = $('#botNum');
  if (!sw) return;
  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendBots({ enabled: !botCfg.enabled, count: botCfg.count || (+rg.value || 1) });
  };
  sw.addEventListener('click', toggle);
  rg.addEventListener('input', () => {
    const v = +rg.value;
    sendBots({ count: v, enabled: v > 0 });
    if (num) num.textContent = v > 0 ? String(v) : '关';
  });
  rg.addEventListener('mousedown', (e) => e.stopPropagation());
  rg.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
})();

// ============================ 音乐播放器（客户端拉取免费音源） ============================
/**
 * 音源用 SoundHelix 的公开示例曲（免费、允许外链、无版权纠纷），
 * 由玩家浏览器直接向后台上拉流，不占用本服务器带宽与资源。
 * 首次点击/按键后再尝试自动播放（浏览器自动播放策略要求用户手势）。
 */
function initMusic() {
  const box = $('#music'), title = $('#mTitle'), state = $('#mState');
  const btnPlay = $('#mPlay'), btnPrev = $('#mPrev'), btnNext = $('#mNext'), vol = $('#mVol');
  if (!box) return null;

  // 免费订阅音源（同源代理拉流：走 /music/<key>，浏览器同源无 CORS/防盗链问题；
  // 服务器只做流式透传，音频带宽仍走第三方免费 CDN，不占本服务器资源）
  const TRACKS = [
    { n: '热血开场', url: '/music/hot', loop: true },
    { n: '黄金时刻', url: '/music/gold', loop: true },
    { n: '战场节奏', url: '/music/battle', loop: true },
    { n: '喷射小调', url: '/music/jet', loop: true },
    { n: '下水道 Disco', url: '/music/disco', loop: false },
    { n: '下水道主题曲', url: '/music/theme', loop: false },
  ];
  const audio = new Audio();
  audio.preload = 'auto';   // 当前曲预缓冲，点播即响（流量走第三方 CDN，不占本服务器）
  // 注意：不要设 crossOrigin='anonymous'，否则无 CORS 头的免费音源会被浏览器拦截；
  // 普通 <audio> 直接播放不需要 CORS。

  let idx = +(localStorage.getItem('dc_music_idx') || 0) % TRACKS.length;
  let wanted = localStorage.getItem('dc_music_on') !== '0';
  const vol0 = +(localStorage.getItem('dc_music_vol') || 45);
  vol.value = String(vol0);
  audio.volume = vol0 / 100;

  function paint(playing) {
    const t = TRACKS[idx];
    title.textContent = t.n;
    btnPlay.textContent = playing ? '⏸' : '▶';
    box.classList.toggle('spin', !!playing);
    if (!playing) state.textContent = wanted ? '已暂停 · 点击播放' : '免版权音源 · 网页端拉流';
  }
  function load(i, autoplay) {
    idx = (i + TRACKS.length) % TRACKS.length;
    localStorage.setItem('dc_music_idx', String(idx));
    audio.pause();
    audio.removeAttribute('src');   // 清空旧源，重置 error 状态
    audio.load();
    audio.src = TRACKS[idx].url;
    audio.loop = !!TRACKS[idx].loop;    // 短样曲循环播放，长曲播完自动切下一首
    paint(false);
    if (autoplay) play();
  }
  function play() {
    if (!audio.src) { load(idx, false); }
    if (audio.readyState < 3) state.textContent = '正在缓冲…';
    audio.play().then(() => { paint(true); state.textContent = `正在播放 · ${TRACKS[idx].n}`; })
      .catch(() => { paint(false); state.textContent = '等下按一下画面再播放'; });
  }
  function pause() { audio.pause(); paint(false); }

  btnPlay.addEventListener('click', (e) => { e.stopPropagation(); audio.paused ? play() : pause(); wanted = !audio.paused; localStorage.setItem('dc_music_on', wanted ? '1' : '0'); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); wanted = true; localStorage.setItem('dc_music_on', '1'); load(idx + 1, true); });
  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); wanted = true; localStorage.setItem('dc_music_on', '1'); load(idx - 1, true); });
  vol.addEventListener('input', (e) => {
    e.stopPropagation();
    audio.volume = (+vol.value) / 100;
    localStorage.setItem('dc_music_vol', vol.value);
  });
  vol.addEventListener('mousedown', (e) => e.stopPropagation());
  box.addEventListener('mousedown', (e) => e.stopPropagation());
  audio.addEventListener('ended', () => load(idx + 1, true));
  audio.addEventListener('error', () => { state.textContent = '音源拉取失败 · 点下一首重试'; paint(false); });

  load(idx, false);
  if (wanted) play();     // 若在用户手势的调用栈里（点"开始游戏"），这里能直接播起来
  // 兜底：首次用户手势后再尝试（silent autoplay 会被浏览器拦截）
  const kick = () => {
    removeEventListener('pointerdown', kick);
    removeEventListener('keydown', kick);
    if (wanted && audio.paused) play();
  };
  addEventListener('pointerdown', kick);
  addEventListener('keydown', kick);
  return { audio, play, pause, next: () => load(idx + 1, true), prev: () => load(idx - 1, true) };
}
let music = null;

// 鼠标灵敏度：基础倍率 0.0022，玩家可在"设置"里调（0.2~3.0，默认 1.0）
const SENS_BASE = 0.0022;
let sensMult = +(localStorage.getItem('dc_sens') || 1.0);
if (!(sensMult >= 0.2 && sensMult <= 3.0)) sensMult = 1.0;

addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== elCanvas) return;
  const s = SENS_BASE * sensMult * (mouseAim ? 0.52 : 1) * (camera && camera.fov < 70 ? 0.85 : 1);
  camYaw -= e.movementX * s;
  camPitch -= e.movementY * s;
  camPitch = clamp(camPitch, -1.35, 1.35);
});

// ---- 设置面板：鼠标灵敏度 ----
(() => {
  const btn = $('#setbtn'), panel = $('#settings'), range = $('#sensRange'), val = $('#sensVal'), close = $('#setClose');
  if (!btn || !panel || !range) return;
  range.value = String(sensMult);
  val.textContent = (+sensMult).toFixed(2);

  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.add('on'); });
  range.addEventListener('input', (e) => {
    e.stopPropagation();
    sensMult = +range.value;
    val.textContent = sensMult.toFixed(2);
    localStorage.setItem('dc_sens', String(sensMult));
  });
  close.addEventListener('click', () => panel.classList.remove('on'));
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
})();

elCanvas.addEventListener('click', () => {
  if (started && document.pointerLockElement !== elCanvas) elCanvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  elHint.style.display = (started && document.pointerLockElement !== elCanvas) ? 'block' : 'none';
});

function sendInput(dt) {
  netTimer += dt;
  if (netTimer < 1 / 30) return;   // 30Hz 上行（配合本地预测，降低网络负载）
  netTimer = 0;
  const mx = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
  const mz = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
  const flying = !!(mySnapshot && mySnapshot.fly);
  send({
    t: 'input',
    mx, mz,
    yaw: camYaw - Math.PI, pitch: camPitch,
    // 同步本地预测位置：服务器射击起点用它（移动中服务器位置滞后0.5m会导致弹道起点偏移）
    px: (() => { const m = heroes.get(myId); return m ? m.pred.x : 0; })(),
    pz: (() => { const m = heroes.get(myId); return m ? m.pred.z : 0; })(),
    shoot: mouseShoot && !wantRoll && !flying,
    aim: mouseAim,
    jump: !!keys.jump,
    grenade: wantGrenade, roll: wantRoll, fly: wantFly,
  });
  wantGrenade = false; wantRoll = false; wantFly = false;
}

// ============================ 主循环 ============================
// ===== 客户端预测专用：与服务器 movePlayer 完全一致的逐轴 AABB 碰撞滑行 =====
// 旧预测只裸推不碰撞，贴墙/掩体走时本地与服务器位置分叉，
// 攒到阈值触发暴力拉回 → 移动一顿一顿。必须复刻服务器碰撞。
function slideMove(st, dx, dz, dy) {
  const hw = (cfg && cfg.playerHalfW) || 0.5;
  const ph = (cfg && cfg.playerHeight) || 1.7;
  const boxes = mapData || [];
  const stepAxis = (axis, delta) => {
    st[axis] += delta;
    let cx = st.x, cy = st.y + ph / 2, cz = st.z;
    for (const b of boxes) {
      if (Math.abs(cx - b.cx) >= hw + b.hx) continue;
      if (Math.abs(cy - b.cy) >= ph / 2 + b.hy) continue;
      if (Math.abs(cz - b.cz) >= hw + b.hz) continue;
      if (axis === 'x') {
        st.x = delta > 0 ? b.cx - b.hx - hw - 1e-4 : b.cx + b.hx + hw + 1e-4;
      } else if (axis === 'z') {
        st.z = delta > 0 ? b.cz - b.hz - hw - 1e-4 : b.cz + b.hz + hw + 1e-4;
      } else {
        if (delta <= 0) { st.y = b.cy + b.hy; st.vy = 0; st.onGround = true; }
        else { st.y = b.cy - b.hy - ph - 1e-4; st.vy = 0; }
      }
      cx = st.x; cy = st.y + ph / 2; cz = st.z;
    }
  };
  st.onGround = false;
  stepAxis('x', dx);
  stepAxis('z', dz);
  stepAxis('y', dy);
  if (st.y <= 0) { st.y = 0; st.vy = 0; st.onGround = true; }
}

const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!scene) return;

  /* 单机：本地推进逻辑帧（60Hz），并按 20Hz 出快照交给渲染层，
     与网络版 snapRate 保持一致，插值手感才不变 */
  if (LOCAL_MODE && localGame) {
    localGame.tick();
    localAcc += dt;
    if (localAcc >= 1 / 20) {
      localAcc = 0;
      applySnapshot(localGame.snapshot());
    }
  }

  sendInput(dt);

  // --- 玩家插值与姿态 ---
  for (const [id, h] of heroes) {
    const self = id === myId;
    const rate = self ? 34 : 22;
    const px0 = h.cur.x, pz0 = h.cur.z;
    if (self) {
      // ============ 自己的角色：客户端预测（含与服务器一致的碰撞物理）============
      // 预测必须复刻服务器物理（碰撞/重力/跳跃/喷射/施法减速），
      // 否则贴墙走、喷射、被击退都会让本地与服务器位置分叉，
      // 攒到阈值触发一次暴力拉回 → 移动一顿一顿
      const w = (cfg && cfg.walkSpeed) || 7.4;
      const aimMul = (cfg && cfg.aimSpeedMul) || 0.45;
      const mx = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
      const mz = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
      const len = Math.hypot(mx, mz);
      // 自己角色朝向直接用本地相机朝向（即时，无服务器朝向插值延迟）
      const selfYaw = camYaw - Math.PI;
      const dead = !!(mySnapshot && mySnapshot.alive === 0);
      const down = !!(mySnapshot && mySnapshot.down === 1);
      const casting = !!(mySnapshot && mySnapshot.pose === 'bent');   // 弯腰施法几乎走不动（与服务器一致）
      const flying = !!(mySnapshot && mySnapshot.fly === 1);
      const canMove = !dead && !down;

      if (!h.pv) h.pv = { x: h.pred.x, y: h.cur.y || 0, z: h.pred.z, vy: 0, onGround: true };
      const st = h.pv;

      if (dead) {
        // 死亡：完全冻结本地物理（服务器不动尸体），位置由快照钉住
        st.x = h.pred.x; st.z = h.pred.z; st.y = h.tgt.y; st.vy = 0; st.onGround = true;
      } else {
        let vx = 0, vz = 0;
        if (flying && canMove) {
          // 喷射：沿朝向快速推进 + 左右 0.32 修正（与服务器公式一致）
          const fs = (cfg && cfg.flySpeed) || 6.6;
          const sinY = Math.sin(selfYaw), cosY = Math.cos(selfYaw);
          const dx = sinY - cosY * mx * 0.32, dz = cosY + sinY * mx * 0.32;
          const dl = Math.hypot(dx, dz) || 1;
          vx = dx / dl * fs; vz = dz / dl * fs;
          st.vy = (cfg && cfg.flyLift) || 4.6;
        } else {
          if (len > 0 && canMove) {
            const spd = w * (mouseAim ? aimMul : 1) * (casting ? 0.22 : 1);
            const nx = mx / len, nz = mz / len;
            const sinY = Math.sin(selfYaw), cosY = Math.cos(selfYaw);
            vx = (sinY * nz - cosY * nx) * spd;   // 前=+Z 与服务器一致
            vz = (cosY * nz + sinY * nx) * spd;
          }
          // 重力 + 起跳（与服务器一致）
          st.vy -= (cfg && cfg.gravity || 26) * dt;
          if (st.onGround && canMove && keys.jump && !casting) {
            st.vy = (cfg && cfg.jumpSpeed) || 9;
            st.onGround = false;
          }
        }
        // 逐轴碰撞滑行（复刻服务器 movePlayer）
        slideMove(st, vx * dt, vz * dt, st.vy * dt);
        h.pred.x = st.x; h.pred.z = st.z;
      }

      // 误差分级对齐：碰撞正确后，稳态误差只剩网络延迟×速度（公网约 1~1.6m）。
      // 延迟误差不纠正（相机=预测，自己看不见；射击起点上报的也是预测位置），
      // 只纠正真实"位移事件"（击退/爆炸炸飞/传送），避免高延迟下持续轻拽 = 粘滞感
      h.err.x = h.pred.x - h.anchor.x;
      h.err.z = h.pred.z - h.anchor.z;
      const errD = Math.hypot(h.err.x, h.err.z);
      if (errD > 3.0) {
        // 严重跑偏（爆炸炸飞/异常/传送）：较快拉回
        h.pred.x = damp(h.pred.x, h.anchor.x, 8, dt);
        h.pred.z = damp(h.pred.z, h.anchor.z, 8, dt);
        st.x = h.pred.x; st.z = h.pred.z;
      } else if (errD > 2.2) {
        // 轻度偏差（枪击退/爆炸残差）：温和拉回，肉眼是"被推动"而不是"抽搐"
        h.pred.x = damp(h.pred.x, h.anchor.x, 2.5, dt);
        h.pred.z = damp(h.pred.z, h.anchor.z, 2.5, dt);
        st.x = h.pred.x; st.z = h.pred.z;
      }
      h.cur.x = h.pred.x;
      h.cur.z = h.pred.z;
      h.cur.y = dead ? h.tgt.y : st.y;   // y 本地预测：消除跳跃/落地的 20Hz 阶梯感
      h.cur.yaw = selfYaw;
      h.cur.pitch = camPitch;
    } else {
      h.cur.x = damp(h.cur.x, h.tgt.x, rate, dt);
      h.cur.y = damp(h.cur.y, h.tgt.y, rate, dt);
      h.cur.z = damp(h.cur.z, h.tgt.z, rate, dt);
    }
    // 速度（给走路摆腿用）
    const spd = Math.hypot(h.cur.x - px0, h.cur.z - pz0) / Math.max(dt, 1e-4);
    // 角度插值（处理环绕）—— 自己角色已在上面直接设为本地相机朝向，跳过服务器朝向插值
    if (!self) {
      let d = h.tgt.yaw - h.cur.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      h.cur.yaw += d * (1 - Math.exp(-18 * dt));
      h.cur.pitch = damp(h.cur.pitch, h.tgt.pitch, 18, dt);
    }

    h.hero.root.visible = !self;
    h.hero.root.position.set(h.cur.x, h.cur.y, h.cur.z);
    h.hero.root.rotation.y = h.cur.yaw;
    h.hero.update(dt, {
      pose: window.__pose || h.meta.pose,
      down: h.meta.down,
      speed: spd,
      fly: h.meta.fly,
    });

    // 别人的喷气尾焰 / 日常滴屎
    if (!self && h.meta.alive === 1) {
      const ms = performance.now();
      if (h.meta.fly === 1) {
        if (ms - (h.fxAt || 0) > 50) {
          h.fxAt = ms;
          const bx = h.cur.x - Math.sin(h.cur.yaw) * 0.12;
          const bz = h.cur.z - Math.cos(h.cur.yaw) * 0.12;
          fx.jetExhaust(new THREE.Vector3(bx, h.cur.y + 0.62, bz));
        }
      } else if (ms - (h.dripAt || 0) > 1500) {
        h.dripAt = ms;
        fx.poopDrip(new THREE.Vector3(h.cur.x, h.cur.y + 0.62, h.cur.z));
      }
    }

    // 血条（始终面向相机：抵消 root 的朝向旋转）
    const bar = h.hpBar;
    bar.visible = !self && h.meta.alive === 1;
    tmpQ.copy(camera.quaternion);
    h.hero.root.getWorldQuaternion(tmpQ2).invert();
    bar.quaternion.copy(tmpQ).premultiply(tmpQ2);
    const f = clamp(h.meta.hp / (cfg ? cfg.maxHp : 100), 0, 1);
    bar.userData.fg.scale.x = Math.max(0.001, f);
    bar.userData.fg.position.x = -(1 - f) / 2;
    bar.userData.fg.material.color.setHex(f > 0.6 ? 0x4ade80 : f > 0.3 ? 0xfacc15 : 0xef4444);
  }

  updateCamera(dt);
  updateViewModel(dt);
  if (world && world.update) world.update(dt);
  fx.update(dt);
  updateHud(dt);
  renderer.render(scene, camera);
}

function updateCamera(dt) {
  const me = heroes.get(myId);
  if (!me) return;
  const p = me.cur;
  const down = me.meta.down === 1;
  const flying = me.meta.fly === 1;

  // 调试第三人称：控制台输入 window.__third = true 开启
  if (window.__third) {
    const t = performance.now() * 0.0004;
    camera.position.set(p.x + Math.sin(t) * 4.2, p.y + 2.4, p.z + Math.cos(t) * 4.2);
    camera.lookAt(p.x, p.y + 1.0, p.z);
    camera.fov = 60; camera.updateProjectionMatrix();
    return;
  }

  let eyeY = p.y + 1.55;
  let roll = 0;
  let fovTarget = 78;

  // ---- 落地缓冲：从空中掉到地面的一瞬间给镜头一个下沉 + 回弹（走路摇晃已按需求取消）----
  const groundedNow = !flying && !down && p.y <= 0.02;
  if (groundedNow && wasAir && prevY > 0.35) {
    landK = Math.min(1, (prevY - 0.2) * 0.55);
    bob = Math.max(bob, landK * 0.9);
  }
  wasAir = !groundedNow;
  prevY = p.y;
  landK = Math.max(0, landK - dt * 3.6);
  const landDip = landK * 0.34;   // 下沉幅度（米）

  if (down) {
    eyeY = p.y + 0.55;
    roll = 1.15;
  } else if (flying) {
    eyeY = p.y + 1.66;
    roll = (keys.r ? -1 : 0) * 0.06 + (keys.l ? 0.06 : 0) + Math.sin(performance.now() * 0.02) * 0.012;
    fovTarget = 96;
    fx.addShake(0.006);
    // 第一人称也能看到脚下的喷射气流（从画面下方向上喷）
    fx.jetExhaust(new THREE.Vector3(p.x - Math.sin(camYaw - Math.PI) * 0.1, p.y + 0.5, p.z - Math.cos(camYaw - Math.PI) * 0.1));
  }
  if (mouseAim && !down && !flying) fovTarget = 52;

  camera.fov = damp(camera.fov, fovTarget, 12, dt);
  camera.updateProjectionMatrix();

  // 屏幕震动：分成低频（位移）+ 高频（抖动），比纯随机更像主流游戏
  const sh = fx.shake;
  const tt = performance.now();
  const sx = (Math.random() - 0.5) * sh * 0.34 + Math.sin(tt * 0.03) * sh * 0.05;
  const sy = (Math.random() - 0.5) * sh * 0.34 + Math.cos(tt * 0.037) * sh * 0.05;
  const sz = (Math.random() - 0.5) * sh * 0.18;
  camera.position.set(
    p.x + sx,
    eyeY + sy - landDip,
    p.z + sz
  );
  camera.rotation.set(
    camPitch + (flying ? 0.05 : 0) - landDip * 0.55 + sh * (Math.random() - 0.5) * 0.012,
    camYaw + sh * (Math.random() - 0.5) * 0.008,
    roll + landK * 0.06 + sh * (Math.random() - 0.5) * 0.05,
    'YXZ'
  );
}

function updateViewModel(dt) {
  const me = heroes.get(myId);
  if (!me || !vm) return;
  const down = me.meta.down === 1;
  const flying = me.meta.fly === 1;
  const dead = me.meta.alive === 0;
  vm.group.visible = !down && !flying && !dead;

  // 瞄准：枪抬到中线
  aimK = damp(aimK, (mouseAim && !down && !flying) ? 1 : 0, 12, dt);
  const bx = 0.23, by = -0.2, bz = -0.44;
  const ax = 0.0, ay = -0.11, az = -0.36;
  vm.group.position.set(
    bx + (ax - bx) * aimK,
    by + (ay - by) * aimK + Math.sin(performance.now() * 0.0022) * 0.012,
    bz + (az - bz) * aimK + recoil * 0.06
  );
  // 走路摆动已按需求取消（保持枪身稳定，只有后坐与落地反应）

  // 背身弯腰投弹：手从身下甩出去（第一人称也能看出动作）
  const bent = mySnapshot && mySnapshot.pose === 'bent' ? 1 : 0;
  bentK = damp(bentK, bent, 11, dt);
  vm.group.position.y -= bentK * 0.3;
  vm.group.position.z += bentK * 0.12;

  vm.group.rotation.set(recoil * 0.16 + recoilPitch - bentK * 1.35, recoil * 0.05, recoil * 0.05 + bentK * 0.4);
  // 枪身后坐的位移（不只是旋转，位移感更"实"）
  vm.group.position.z += recoil * 0.055;
  vm.group.position.y += recoil * 0.012;
  recoil = Math.max(0, recoil - dt * 4.5);
  recoilPitch *= Math.exp(-dt * 7);   // 后坐俯仰指数衰减（连续射击稳定在~0.3°，停止后~0.5s回落）
  bob = Math.max(0, bob - dt * 3.2);
}

function updateHud(dt) {
  if (!mySnapshot) return;
  const s = mySnapshot;
  const hp = clamp(s.hp, 0, cfg.maxHp);
  const hpPct = hp / cfg.maxHp;
  elHpFill.style.width = (hpPct * 100) + '%';
  elHpFill.classList.toggle('low', hpPct <= 0.25);
  elHpFill.classList.toggle('mid', hpPct > 0.25 && hpPct <= 0.55);
  elHpNum.innerHTML = `${hp}<small>/${cfg.maxHp}</small>`;
  $('#bKills').textContent = s.k;
  $('#bDeaths').textContent = s.d;
  $('#bTime').textContent = timeLeft > 0 ? Math.ceil(timeLeft) + 's' : '--';

  // 备屎量
  const ppMax = cfg.poopMax || 100;
  const pp = clamp(s.pp != null ? s.pp : ppMax, 0, ppMax);
  const ppPct = pp / ppMax;
  elPoopFill.style.width = (ppPct * 100) + '%';
  elPoopFill.classList.toggle('low', ppPct < 0.25);
  elPoopNum.textContent = Math.round(pp);
  elSkG.classList.toggle('noammo', pp < (cfg.grenadePoopCost || 20));
  elSkR.classList.toggle('noammo', pp < (cfg.rollPoopCost || 24));
  // 喷射跳：环形冷却直接用"屎量条"表示（屎越多越能喷）
  setRing(elSkF, 1 - ppPct);
  elSkF.classList.toggle('ready', pp >= (cfg.flyMinPoop || 6));
  elSkF.classList.toggle('noammo', pp < (cfg.flyMinPoop || 6));
  elSkF.classList.toggle('cooling', pp < 55);
  elSpeed.style.opacity = s.fly ? '0.9' : '0';

  // 技能冷却环
  const gPct = clamp(s.g / cfg.grenadeCooldown, 0, 1);
  const rPct = clamp(s.r / cfg.rollCooldown, 0, 1);
  setRing(elSkG, gPct);
  setRing(elSkR, rPct);
  elSkG.classList.toggle('ready', gPct <= 0);
  elSkR.classList.toggle('ready', rPct <= 0);
  elSkG.classList.toggle('cooling', gPct > 0);
  elSkR.classList.toggle('cooling', rPct > 0);

  // 准星：后坐 + 移动 + 瞄准都会影响扩散（主流射击游戏手感）
  const moving = (keys.f || keys.b || keys.l || keys.r) ? 1 : 0;
  const spread = 1 + (mouseAim ? -0.34 : 0) + recoil * 0.62 + moving * 0.14;
  elCross.style.transform = `translate(-50%,-50%) scale(${spread.toFixed(3)})`;
  elCross.style.opacity = s.alive ? '1' : '0';

  // 糊视野：溅片由事件驱动（spawnSplat），这里只做轻微的整体朦胧
  // 关键优化：只在 blur 值变化时才设置 filter（对整块 canvas 做 blur 极贵，每帧 set 会严重掉帧）
  const b = clamp(s.blur, 0, 1);
  // 低血濒死：最后 10 点血再加高斯模糊，血量越少越糊，糊到看不清（10血→轻微，0血→最糊）
  const hpNow = clamp(s.hp, 0, cfg.maxHp);
  const lowHpK = hpNow <= 10 ? (10 - hpNow) / 10 : 0;   // 10血=0 → 0血=1
  const lowHpBlur = lowHpK * lowHpK * 3.5;              // 平方曲线，濒死时快速变糊（最大 3.5px，配合红色tint达到"看不清"）
  const blurTarget = (b > 0.02 ? Math.round(b * 1.6 * 10) / 10 : 0) + lowHpBlur;
  if (blurTarget !== lastBlur) {
    lastBlur = blurTarget;
    elCanvas.style.filter = blurTarget > 0 ? `blur(${blurTarget.toFixed(1)}px)` : 'none';
  }
  const tintTarget = Math.round((s.down ? 0.5 : b * 0.15 + lowHpK * 0.35) * 100) / 100;
  if (tintTarget !== lastTint) { lastTint = tintTarget; elTint.style.opacity = tintTarget.toFixed(2); }

  // 受伤红闪
  dmgFlash = Math.max(0, dmgFlash - dt * 2.2);
  elDmg.style.opacity = (dmgFlash * 0.55).toFixed(3);

  // 死亡倒计时
  if (!s.alive && s.alive === 0) {
    elDead.style.display = 'flex';
    const left = Math.max(0, 4 - (performance.now() - deadAt) / 1000);
    $('#deadCd').textContent = `复活倒计时 ${left.toFixed(1)}s`;
  }

  // ping 显示
  const nowMs = performance.now();
  if (nowMs - lastSnapAt < 6000) {
    $('#pPing').textContent = ping ? ping + ' ms' : '';
  }

  if (elScore.style.display === 'block') updateScore();
}

function updateScore() {
  const rows = [...heroes.entries()]
    .map(([id, h]) => ({
      id, name: h.meta.name, bot: h.meta.bot,
      k: h.meta.k || 0, d: h.meta.d || 0, hp: h.meta.hp,
    }))
    .sort((a, b) => (b.k - a.k) || (a.d - b.d));
  elScoreRows.innerHTML = rows.map((r, i) =>
    `<div class="srow ${r.id === myId ? 'me' : ''}">
      <span class="sr-i">${i + 1}</span>
      <span class="sr-n">${r.bot ? '<em class="lb-bot">BOT</em> ' : ''}${r.name}${r.id === myId ? ' <em class="lb-you">你</em>' : ''}</span>
      <span class="sr-s">${r.k} 杀 · ${r.d} 死 · ${r.hp} 血</span>
    </div>`
  ).join('');
}

// ============================ 开场过场 + 名字界面 ============================
// POOP HERO 黑底红字过场，1.7 秒后渐隐
(function initSplash() {
  const sp = $('#splash');
  if (!sp) return;
  setTimeout(() => {
    sp.classList.add('out');
    setTimeout(() => sp.remove(), 900);
  }, 1700);
})();

// 名字界面：人物模型站中间慢慢转（双击模型进入战场）
(function initMenuHero() {
  const cv = $('#menuCanvas');
  if (!cv) return;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  r.setSize(innerWidth, innerHeight, false);
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.shadowMap.enabled = true;
  const sc = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50);
  cam.position.set(0, 1.3, 3.5);
  cam.lookAt(0, 0.95, 0);

  sc.add(new THREE.AmbientLight(0xfff0dd, 0.8));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.7);
  key.position.set(2.4, 4.4, 3);
  sc.add(key);
  const rimL = new THREE.DirectionalLight(0x66aaff, 0.75);
  rimL.position.set(-3, 2.2, -2.6);
  sc.add(rimL);

  // 脚下的黑色地台 + 红圈
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.92, 1.08, 0.07, 48),
    new THREE.MeshStandardMaterial({ color: 0x191007, roughness: 0.55 })
  );
  disc.position.y = -0.035;
  disc.receiveShadow = true;
  sc.add(disc);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.06, 0.022, 8, 72),
    new THREE.MeshBasicMaterial({ color: 0xe02015 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.015;
  sc.add(ring);

  const hero = createPoopHero(0xe02015);
  hero.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  sc.add(hero.root);
  window.__menuHero = { hero, cam, sc, r };   // 调试：控制台可摆拍

  let t = 0, last = performance.now(), alive = true;
  (function tick() {
    if (!alive) return;
    requestAnimationFrame(tick);
    if (started || !document.body.contains(cv)) { alive = false; return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    if (!window.__menuHeroFreeze) {
      hero.root.rotation.y = t * 0.5;                 // 慢慢转圈展示
      hero.root.position.y = Math.sin(t * 1.4) * 0.02; // 呼吸感
    }
    hero.update(dt, { pose: 'idle' });
    r.render(sc, cam);
  })();

  addEventListener('resize', () => {
    if (!alive) return;
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
    r.setSize(innerWidth, innerHeight, false);
  });

  // 双击人物模型 = 进入战场
  cv.addEventListener('dblclick', () => { $('#play').click(); });
})();

// ============================ 启动 ============================
$('#play').addEventListener('click', async () => {
  const nick = $('#nick').value.trim();
  elStatus.textContent = '正在连接服务器…';
  try {
    await connect();
  } catch (err) {
    elStatus.textContent = '❌ 连接失败：请先运行 node server.js，再打开 http://localhost:8080';
    elStatus.style.color = '#ff8f7a';
    return;
  }
  if (nick) send({ t: 'rename', name: nick });
  initAudio();
  if (!music) music = initMusic();      // 边角音乐播放器：网页端自己拉流，不占服务器
  elMenu.style.display = 'none';
  started = true;
  elStatus.textContent = '';
  elCanvas.requestPointerLock && elCanvas.requestPointerLock();
  centerMsg('开糊！', '左键机枪 · Q 屎榴弹 · E 滚粪球 · 空格×2 喷射跳');
  // 等待场景构建
  const wait = setInterval(() => { if (scene) { clearInterval(wait); } }, 100);
  if (!loop._started) { loop._started = true; requestAnimationFrame(loop); }
});

// 页面关闭时释放鼠标锁
addEventListener('beforeunload', () => { if (ws) ws.close(); });
