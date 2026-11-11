/**
 * 主逻辑 —— 串起网络、渲染、输入、HUD
 */

import { Net } from './net.js';
import { Renderer } from './render.js';
import { Input, Predictor } from './input.js';
import * as audio from './audio.js';

import { World, currentWeapon } from '../shared/sim.js';
import {
  CLASSES, CLASS_LIST, TEAMS, MODES, MODE_LIST, PHYS, KEY, COMBAT, CLASS_UNLOCK,
} from '../shared/constants.js';
import { getMap, MAPS, MAP_LIST } from '../shared/maps.js';
import { POOL, WEAPONS, getWeapon, WEAPON_UNLOCK, isWeaponUnlocked } from '../shared/weapons.js';
import { CAMPAIGN, CAMPAIGN_LIST, getLevel, levelIndex } from '../shared/campaign.js';
import * as PROG from '../shared/progression.js';

/* ================================================================ */
/*  全局状态                                                         */
/* ================================================================ */
const S = {
  net: null,
  renderer: null,
  input: null,
  predictor: new Predictor(),
  world: null,          // 本地世界（用于预测与渲染）
  me: null,             // 本地玩家对象
  self: null,           // 服务端下发的自身状态（弹药等）
  room: null,
  cls: 'assault',
  loadout: { primary: null, secondary: null },
  name: '',
  state: 'menu',        // menu | lobby | playing | result
  lastShotAt: 0,
  hitFlashT: 0,
  respawnT: 0,
  startedAt: 0,
  countdown: 0,
  mapId: 'labs',
  mode: 'tdm',
  diff: 3,
  botCount: 7,
  // ---- 成长系统 ----
  profile: PROG.defaultProfile(),
  levelId: CAMPAIGN_LIST[0],   // 当前选择的战役关卡
  matchXpGain: 0,              // 本局获得经验（结算页显示）
  levelUp: false,
};

const $ = (id) => document.getElementById(id);
const el = {};

/* ================================================================ */
/*  初始化                                                           */
/* ================================================================ */
function cacheEls() {
  [
    'screen-menu', 'screen-lobby', 'screen-result', 'hud',
    'inp-name', 'menu-class', 'btn-solo', 'btn-create', 'inp-code', 'btn-join', 'room-list',
    'lobby-title', 'lobby-sub', 'lobby-code', 'btn-copy', 'lobby-teams',
    'cfg-mode', 'cfg-map', 'cfg-diff', 'cfg-bots', 'cfg-bots-val',
    'cfg-level', 'cfg-level-row', 'cfg-map-row', 'level-info', 'level-badge',
    'lobby-weapons', 'btn-leave', 'btn-start',
    'score-blue', 'score-red', 'hud-mode', 'hud-time', 'hud-points',
    'score-blue-lbl', 'score-red-lbl',
    'minimap', 'hp-class', 'hp-num', 'hp-fill',
    'w-primary', 'w-secondary', 'skill-ring', 'skill-icon', 'skill-name', 'skill-need',
    'reload-hint', 'killfeed', 'respawn-tip', 'big-center',
    'result-title', 'result-sub', 'result-xp', 'result-table', 'btn-again', 'btn-back',
    'overlay', 'ov-text', 'ov-err',
  ].forEach(id => { el[camel(id)] = $(id); });
}
function camel(s) { return s.replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }

function boot() {
  cacheEls();

  // 暴露状态给调试/自动化使用（不影响游戏逻辑）
  window.__S = S;

  const canvas = $('game');
  S.renderer = new Renderer(canvas);
  S.input = new Input(canvas);

  S.name = loadName();
  el.inpName.value = S.name;
  S.cls = loadCls();
  S.profile = loadProfile();
  S.levelId = loadLevel();
  // 若存档等级不足，回落到基础兵种
  if (!PROG.classUnlocked(S.cls, S.profile.level)) {
    S.cls = 'assault';
    saveCls('assault');
  }

  buildClassCards();
  buildLobbyUI();
  bindMenu();

  // 空闲时画个静态背景，避免菜单后面一片黑
  S.renderer.setMap('labs');
  idleLoop();

  connect();
}

/* ================================================================ */
/*  本地存储                                                         */
/* ================================================================ */
function loadName() {
  try { return localStorage.getItem('sfh_name') || ''; } catch (e) { return ''; }
}
function saveName(v) {
  try { localStorage.setItem('sfh_name', v); } catch (e) {}
}
function loadCls() {
  try {
    const c = localStorage.getItem('sfh_cls');
    return CLASS_LIST.includes(c) ? c : 'assault';
  } catch (e) { return 'assault'; }
}
function saveCls(c) {
  try { localStorage.setItem('sfh_cls', c); } catch (e) {}
}

/* ---- 成长存档 ---- */
function loadProfile() {
  try {
    const raw = localStorage.getItem('sfh_profile');
    return PROG.normalizeProfile(raw ? JSON.parse(raw) : null);
  } catch (e) { return PROG.defaultProfile(); }
}
function saveProfile(p) {
  try { localStorage.setItem('sfh_profile', JSON.stringify(p)); } catch (e) {}
}
function loadLevel() {
  try {
    const v = localStorage.getItem('sfh_level');
    return CAMPAIGN_LIST.includes(v) ? v : CAMPAIGN_LIST[0];
  } catch (e) { return CAMPAIGN_LIST[0]; }
}
function saveLevel(id) {
  try { localStorage.setItem('sfh_level', id); } catch (e) {}
}

/* ================================================================ */
/*  菜单                                                             */
/* ================================================================ */
function buildClassCards() {
  el.menuClass.innerHTML = '';
  const lv = S.profile.level;
  for (const id of CLASS_LIST) {
    const c = CLASSES[id];
    const need = CLASS_UNLOCK[id] || 0;
    const locked = lv < need;
    const d = document.createElement('div');
    d.className = 'class-card' + (id === S.cls ? ' on' : '') + (locked ? ' locked' : '');
    d.style.color = c.accent;
    d.dataset.cls = id;
    d.innerHTML = `
      <div class="cc-icon">${classIcon(id)}</div>
      <div class="cc-name">${c.name}</div>
      <div class="cc-hp">${locked ? '🔒 Lv' + need : c.hp + ' HP'}</div>`;
    d.onclick = () => {
      if (locked) {
        toast(`需要等级 ${need} 才能使用${c.name}（当前 Lv${lv}）`);
        return;
      }
      S.cls = id;
      saveCls(id);
      audio.play('uiClick');
      for (const n of el.menuClass.children) n.classList.toggle('on', n.dataset.cls === id);
      buildWeaponCards();
      if (S.room) sendLoadout();
    };
    el.menuClass.appendChild(d);
  }
  updateLevelBadge();
}

/** 战役关卡选择器 */
function buildLevelPicker() {
  const wrap = el.cfgLevel;
  if (!wrap) return;
  wrap.innerHTML = '';
  const cleared = S.profile.campaignCleared || [];
  CAMPAIGN.forEach((L, i) => {
    const b = document.createElement('button');
    b.dataset.v = L.id;
    b.className = 'lvl-btn';
    // 关卡解锁：第一关永远可玩，之后需要前一关通关
    const prev = i === 0 ? null : CAMPAIGN[i - 1].id;
    const unlocked = i === 0 || cleared.includes(prev);
    const done = cleared.includes(L.id);
    if (!unlocked) b.classList.add('locked');
    if (done) b.classList.add('done');
    b.innerHTML = `<span class="lvl-n">${i + 1}</span><span class="lvl-t">${L.name.replace(/^第.关 · /, '')}</span>
      <span class="lvl-s">${!unlocked ? '🔒' : done ? '★' : L.objective === 'eliminate' ? `消灭 ${L.target}` : L.objective === 'survive' ? `守 ${L.target}s` : `占点 ${L.target}s`}</span>`;
    b.onclick = () => {
      if (!isHost()) return;
      if (!unlocked) { toast('先通关上一关才能解锁'); return; }
      S.levelId = L.id;
      saveLevel(L.id);
      syncSeg(wrap, L.id);
      S.net.send({ t: 'setLevel', level: L.id });
      audio.play('uiClick');
      updateLevelInfo();
    };
    wrap.appendChild(b);
  });
  syncSeg(wrap, S.levelId);
  updateLevelInfo();
}

/** 关卡简介（房主在房间页看到的说明） */
function updateLevelInfo() {
  const box = el.levelInfo;
  if (!box) return;
  const L = getLevel(S.levelId);
  box.innerHTML = `<b>${L.name}</b><span>${L.brief}</span>
    <em>目标：${L.objective === 'eliminate' ? `消灭 ${L.target} 名敌人` : L.objective === 'survive' ? `坚守 ${L.target} 秒` : `占领并守住 ${L.target} 秒`} · 阵亡上限 ${L.maxDeaths} · 奖励 ${L.reward} XP×2</em>`;
}
function updateLevelBadge() {
  const p = S.profile;
  const badge = $('level-badge');
  if (!badge) return;
  const prog = Math.round(PROG.levelProgress(p.xp) * 100);
  const nx = PROG.nextUnlock(p.level);
  const hint = nx
    ? (nx.kind === 'class' ? `再升 ${nx.need - p.level} 级解锁${CLASSES[nx.id].name}` : `再升 ${nx.need - p.level} 级解锁${getWeapon(nx.id).name}`)
    : '已全解锁';
  badge.innerHTML = `
    <div class="lb-row"><span class="lb-lv">Lv ${p.level}</span><span class="lb-xp">${p.xp} XP</span></div>
    <div class="lb-bar"><i style="width:${prog}%"></i></div>
    <div class="lb-hint">${hint}</div>`;
}

/** 轻提示 */
function classIcon(id) {
  return {
    assault: '🔫', sniper: '🎯', medic: '✚', tank: '🛡',
    assassin: '🗡', ninja: '✴',
  }[id] || '🔫';
}

function bindMenu() {
  el.inpName.oninput = () => {
    S.name = el.inpName.value.trim().slice(0, 12) || '士兵';
    saveName(el.inpName.value);
  };
  el.btnSolo.onclick = () => { audio.play('uiClick'); createRoom(true); };
  el.btnCreate.onclick = () => { audio.play('uiClick'); createRoom(false); };
  el.btnJoin.onclick = () => {
    audio.play('uiClick');
    const code = el.inpCode.value.trim().toUpperCase();
    if (!code) return;
    joinRoom(code);
  };
  el.inpCode.onkeydown = (e) => { if (e.key === 'Enter') el.btnJoin.click(); };

  el.btnCopy.onclick = () => {
    const code = el.lobbyCode.textContent;
    navigator.clipboard?.writeText(code).catch(() => {});
    el.btnCopy.textContent = '已复制';
    setTimeout(() => { el.btnCopy.textContent = '复制'; }, 1200);
  };
  el.btnLeave.onclick = () => { audio.play('uiClick'); S.net.send({ t: 'leave' }); showMenu(); };
  el.btnStart.onclick = () => {
    audio.play('uiClick');
    if (S.room && S.room.host !== S.net.id) return;
    S.net.send({ t: 'restart' });
    // 本地立刻切，不等回包（服务端也会广播 restart，重复调用是幂等的）
    startPlaying(S.room?.map || S.mapId);
    bigText('战斗开始', '#ff8a3d');
  };
  el.btnAgain.onclick = () => {
    audio.play('uiClick');
    S.net.send({ t: 'restart' });
    startPlaying(S.room?.map || S.mapId);
  };
  el.btnBack.onclick = () => { audio.play('uiClick'); showMenu(); };

  // 首次点击解锁音频
  const unlock = () => {
    audio.initAudio();
    audio.resumeAudio();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

/* ================================================================ */
/*  房间 UI                                                          */
/* ================================================================ */
function buildLobbyUI() {
  // 模式（含战役）
  el.cfgMode.innerHTML = '';
  const modeItems = [...MODE_LIST, 'campaign'];
  for (const id of modeItems) {
    const isCamp = id === 'campaign';
    const m = isCamp ? { name: '战役' } : MODES[id];
    const b = document.createElement('button');
    b.textContent = m.name;
    b.dataset.v = id;
    if (isCamp) b.classList.add('camp-btn');
    b.onclick = () => {
      if (!isHost()) return;
      sendRoomSetting({ mode: id });
      S.mode = id;
      syncSeg(el.cfgMode, id);
      if (el.cfgLevelRow) el.cfgLevelRow.style.display = isCamp ? '' : 'none';
      // 战役不切图（由关卡决定），普通模式保留地图选择
      if (el.cfgMapRow) el.cfgMapRow.style.display = isCamp ? 'none' : '';
      audio.play('uiClick');
    };
    el.cfgMode.appendChild(b);
  }
  buildLevelPicker();
  // 地图
  el.cfgMap.innerHTML = '';
  for (const id of MAP_LIST) {
    const m = MAPS[id];
    const b = document.createElement('button');
    b.textContent = m.name;
    b.dataset.v = id;
    b.onclick = () => {
      if (!isHost()) return;
      S.net.send({ t: 'switchMap', map: id });
      S.mapId = id;
      syncSeg(el.cfgMap, id);
      audio.play('uiClick');
    };
    el.cfgMap.appendChild(b);
  }
  // 难度
  el.cfgDiff.innerHTML = '';
  const diffs = ['非常简单', '简单', '普通', '困难', '疯狂'];
  diffs.forEach((n, i) => {
    const b = document.createElement('button');
    b.textContent = n;
    b.dataset.v = String(i + 1);
    b.onclick = () => {
      if (!isHost()) return;
      S.diff = i + 1;
      S.net.send({ t: 'setDiff', v: S.diff });
      syncSeg(el.cfgDiff, String(S.diff));
      audio.play('uiClick');
    };
    el.cfgDiff.appendChild(b);
  });
  // AI 数量
  el.cfgBots.oninput = () => {
    S.botCount = Number(el.cfgBots.value);
    el.cfgBotsVal.textContent = String(S.botCount);
    if (isHost()) S.net.send({ t: 'setBots', fill: true, n: S.botCount });
  };

  syncSeg(el.cfgMode, S.mode);
  syncSeg(el.cfgMap, S.mapId);
  syncSeg(el.cfgDiff, String(S.diff));
  el.cfgBotsVal.textContent = String(S.botCount);

  buildWeaponGrid();
}

/**
 * 房主修改房间设置。
 * 切模式走服务端 setMode（保留房间码、保留玩家）；
 * 战役关卡走 setLevel。
 */
function sendRoomSetting(obj) {
  if (!S.net || !S.net.id) return;
  if (obj.mode) {
    S.net.send({ t: 'setMode', mode: obj.mode, level: S.levelId });
    return;
  }
  if (obj.level) {
    S.net.send({ t: 'setLevel', level: obj.level });
  }
}
function isHost() {
  return S.room && S.net && S.room.host === S.net.id;
}

function syncSeg(node, v) {
  for (const b of node.children) b.classList.toggle('on', b.dataset.v === v);
}

function buildWeaponGrid() {
  el.lobbyWeapons.innerHTML = '';
  const pool = POOL[S.cls] || POOL.assault;
  const add = (slot, ids) => {
    for (const id of ids) {
      const w = WEAPONS[id];
      if (!w) continue;
      const cur = S.loadout[slot] || (slot === 'primary' ? CLASSES[S.cls].loadout[0] : CLASSES[S.cls].secondary);
      const d = document.createElement('div');
      d.className = 'wcard' + (cur === id ? ' on' : '');
      d.dataset.id = id;
      d.dataset.slot = slot;
      const dps = Math.round(w.dmg * (w.pellets || 1) * (w.rate || 1));
      d.innerHTML = `
        <div class="wc-top"><span class="wc-icon">${w.icon}</span><span class="wc-name">${w.name}</span></div>
        <div class="wc-stat">伤害 ${w.dmg}${w.pellets ? `×${w.pellets}` : ''} · 射速 ${w.rate}/s · 弹匣 ${w.mag || '∞'}</div>
        ${slot === 'primary' ? '<div class="wc-tag">主</div>' : '<div class="wc-tag" style="background:rgba(255,138,61,.16);color:var(--orange)">副</div>'}`;
      d.title = w.desc || '';
      d.onclick = () => {
        S.loadout[slot] = id;
        audio.play('uiClick');
        for (const n of el.lobbyWeapons.children) {
          if (n.dataset.slot === slot) n.classList.toggle('on', n.dataset.id === id);
        }
        sendLoadout();
      };
      void dps;
      el.lobbyWeapons.appendChild(d);
    }
  };
  add('primary', pool.primary);
  add('secondary', pool.secondary);
}

function sendLoadout() {
  if (!S.net || !S.room) return;
  S.net.send({
    t: 'loadout',
    cls: S.cls,
    weapons: {
      primary: S.loadout.primary,
      secondary: S.loadout.secondary,
    },
  });
}

function renderLobby() {
  const room = S.room;
  if (!room) return;
  el.lobbyTitle.textContent = room.name || '房间';
  el.lobbyCode.textContent = room.id;
  el.lobbySub.textContent = isHost() ? '你是房主 · 可调整配置' : '等待房主开始';

  const teams = { blue: [], red: [] };
  for (const p of room.players) {
    (teams[p.team] || teams.blue).push(p);
  }
  el.lobbyTeams.innerHTML = '';
  for (const t of ['blue', 'red']) {
    const list = teams[t];
    const box = document.createElement('div');
    box.className = 'team-block ' + t;
    box.innerHTML = `
      <div class="tb-head"><span>${TEAMS[t].name}</span><span>${list.length}</span></div>
      ${list.map(p => `
        <div class="tb-mem ${p.isBot ? 'bot' : ''} ${p.id === S.net.id ? 'me' : ''}">
          <span>${classIcon(p.cls)} ${escapeHtml(p.name)}${p.id === S.net.id ? ' (你)' : ''}</span>
          <span>${p.isBot ? 'AI' : '玩家'}</span>
        </div>`).join('') || '<div class="tb-mem bot">— 空 —</div>'}`;
    el.lobbyTeams.appendChild(box);
  }

  // 房主才能改配置
  const host = isHost();
  for (const n of [el.cfgMode, el.cfgMap, el.cfgDiff]) {
    for (const b of n.children) b.disabled = !host;
  }
  el.cfgBots.disabled = !host;
  el.btnStart.disabled = !host;
  el.btnStart.textContent = host ? '开始战斗' : '等待房主开始';

  // 同步服务端状态到 UI
  if (room.mode) { S.mode = room.mode; syncSeg(el.cfgMode, room.mode); }
  if (room.map) { S.mapId = room.map; syncSeg(el.cfgMap, room.map); }
  if (room.difficulty) { S.diff = room.difficulty; syncSeg(el.cfgDiff, String(room.difficulty)); }
  if (room.botTarget != null) {
    S.botCount = room.botTarget;
    el.cfgBots.value = String(room.botTarget);
    el.cfgBotsVal.textContent = String(room.botTarget);
  }
  void host;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================================================================ */
/*  网络                                                             */
/* ================================================================ */
function connect() {
  S.net = new Net();
  showOverlay('正在连接服务器…');

  S.net.on('welcome', (m) => {
    hideOverlay();
    S.net.send({ t: 'hello', name: S.name || '士兵', cls: S.cls });
  });

  S.net.on('rooms', (m) => {
    if (S.state === 'menu') renderRoomList(m.rooms || []);
  });

  S.net.on('room', (m) => {
    S.room = m.room;
    // 同步模式与关卡，保证所有人界面一致（房主切换后其他玩家也要跟上）
    if (S.room && S.room.mode) {
      S.mode = S.room.mode;
      S.mapId = S.room.map || S.mapId;
      if (S.room.levelId) S.levelId = S.room.levelId;
      if (el.cfgMode) syncSeg(el.cfgMode, S.mode);
      if (el.cfgMap) syncSeg(el.cfgMap, S.mapId);
      if (el.cfgLevel) syncSeg(el.cfgLevel, S.levelId);
      const isCamp = S.mode === 'campaign';
      if (el.cfgLevelRow) el.cfgLevelRow.style.display = isCamp ? '' : 'none';
      if (el.cfgMapRow) el.cfgMapRow.style.display = isCamp ? 'none' : '';
      updateLevelInfo();
    }
    if (S.state === 'menu' || S.state === 'lobby') {
      enterLobby();
      renderLobby();
    }
  });

  S.net.on('error', (m) => {
    toast(m.msg || '出错了');
  });

  S.net.on('close', () => {
    if (S.state === 'playing' || S.state === 'lobby') {
      showOverlay('连接已断开，正在重连…');
      setTimeout(() => { location.reload(); }, 2500);
    }
  });

  S.net.on('snap', (m) => onSnapshot(m));

  // 服务端广播的独立事件（不是快照里的 ev 数组）
  S.net.on('restart', (m) => {
    S.resultShown = false;
    S.resultCounted = false;
    el.screenResult.classList.remove('active');
    if (m && m.mode) S.mode = m.mode;
    startPlaying((m && m.map) || S.room?.map || S.mapId);
    bigText('战斗开始', '#ff8a3d');
  });

  S.net.on('left', () => { showMenu(); });

  S.net.connect().then(() => {
    S.net.send({ t: 'list' });
  }).catch((err) => {
    showOverlay('无法连接服务器');
    el.ovErr.textContent = '请确认游戏服务已启动，或刷新页面重试。\n' + (err && err.message ? err.message : '');
  });
}

function showOverlay(text) {
  el.overlay.classList.add('on');
  el.ovText.textContent = text;
  el.ovErr.textContent = '';
}
function hideOverlay() {
  el.overlay.classList.remove('on');
}

function toast(msg) {
  el.bigCenter.textContent = msg;
  el.bigCenter.style.color = 'var(--red)';
  el.bigCenter.classList.add('on');
  setTimeout(() => el.bigCenter.classList.remove('on'), 1800);
}

function createRoom(solo) {
  S.name = el.inpName.value.trim().slice(0, 12) || '士兵';
  saveName(el.inpName.value);
  const isCamp = S.mode === 'campaign';
  S.net.send({
    t: 'create',
    name: solo ? (S.name + ' 的战局') : (S.name + ' 的房间'),
    mode: S.mode,
    map: isCamp ? getLevel(S.levelId).mapId : S.mapId,
    level: isCamp ? S.levelId : null,
    max: 12,
    difficulty: isCamp ? getLevel(S.levelId).difficulty : S.diff,
    fillBots: true,
    botCount: isCamp ? 4 : (solo ? 11 : S.botCount),
  });
}

function joinRoom(code) {
  S.name = el.inpName.value.trim().slice(0, 12) || '士兵';
  saveName(el.inpName.value);
  S.net.send({ t: 'hello', name: S.name, cls: S.cls });
  S.net.send({ t: 'join', id: code });
}

function renderRoomList(rooms) {
  if (!rooms.length) {
    el.roomList.innerHTML = '<div class="room-empty">暂无房间 · 点「创建房间」开一局</div>';
    return;
  }
  el.roomList.innerHTML = '';
  for (const r of rooms) {
    const d = document.createElement('div');
    d.className = 'room-item';
    d.innerHTML = `
      <div class="ri-left">
        <span class="ri-code">${r.id}</span>
        <span>${escapeHtml(r.name)}</span>
      </div>
      <div class="ri-meta">${MODES[r.mode]?.name || r.mode} · ${MAPS[r.map]?.name || r.map} · ${r.count}/${r.max}</div>`;
    d.onclick = () => { audio.play('uiClick'); joinRoom(r.id); };
    el.roomList.appendChild(d);
  }
}

/* ================================================================ */
/*  屏幕切换                                                         */
/* ================================================================ */
function showMenu() {
  S.state = 'menu';
  S.room = null;
  el.screenMenu.classList.add('active');
  el.screenLobby.classList.remove('active');
  el.screenResult.classList.remove('active');
  el.hud.classList.remove('on');
  S.net.send({ t: 'list' });
}

function enterLobby() {
  if (S.state === 'playing') return;
  S.state = 'lobby';
  el.screenMenu.classList.remove('active');
  el.screenLobby.classList.add('active');
  el.screenResult.classList.remove('active');
  el.hud.classList.remove('on');
}

function startPlaying(mapId) {
  const target = mapId || S.mapId;
  const isCamp = S.mode === 'campaign';
  const wantLevel = isCamp ? S.levelId : null;
  // 已经同图同模式在战斗 → 只做轻量重置，不重建世界（避免画面闪）
  if (S.state === 'playing' && S.world
      && S.world.mapId === target
      && S.world.mode === S.mode
      && (!isCamp || S.world.levelId === wantLevel)) {
    el.screenResult.classList.remove('active');
    el.hud.classList.add('on');
    return;
  }

  S.state = 'playing';
  S.mapId = target;
  el.screenMenu.classList.remove('active');
  el.screenLobby.classList.remove('active');
  el.screenResult.classList.remove('active');
  el.hud.classList.add('on');

  S.renderer.setMap(S.mapId);
  // 战役必须带 levelId，否则拿不到关卡目标与波次数据
  S.world = new World({
    mode: S.mode,
    mapId: S.mapId,
    levelId: isCamp ? S.levelId : null,
  });
  S.world.smokes = [];
  S.me = null;
  S.predictor = new Predictor();
  S.overT = 0;

  el.killfeed.innerHTML = '';
  el.hpFill.style.width = '100%';
  audio.play('spawn');
}

/* ================================================================ */
/*  快照处理                                                         */
/* ================================================================ */
function onSnapshot(m) {
  if (!m || !S.net) return;

  // 服务端地图/模式变化 → 重建本地世界
  const mapId = S.room?.map || S.mapId;

  // 只在「已经开始战斗」后才处理快照；否则快照只用来刷新房间信息
  if (S.state !== 'playing') return;
  if (S.world && S.world.mapId !== mapId) {
    S.renderer.setMap(mapId);
    S.world = new World({ mode: S.mode, mapId });
    S.me = null;
  }

  const world = S.world;
  if (!world) return;

  // 同步玩家
  const seen = new Set();
  for (const p of m.ps) {
    seen.add(p.i);
    let ent = world.players.get(p.i);
    if (!ent) {
      ent = makeLocalPlayer(p, world);
      world.players.set(p.i, ent);
      if (p.i === S.net.id) {
        S.me = ent;
        audio.play('spawn');
      }
    }
    // 己方：位置由预测器接管，只同步状态字段
    const isMe = p.i === S.net.id;
    if (isMe) {
      ent.prevX = ent.x;
      ent.prevY = ent.y;
      S.predictor.reconcile(ent, {
        x: p.x, y: p.y, bh: p.c ? PHYS.CROUCH_H : PHYS.H,
      });
      ent.hp = p.h; ent.maxHp = p.m; ent.alive = p.a === 1;
      ent.crouch = p.c === 1;
      ent.facing = p.f;
      ent.skillActive = p.sk === 1;
      ent.spawnProtect = p.sp ? COMBAT.SPAWN_PROTECT : 0;
      ent.swing = p.sg ? 0.2 : 0;
      ent.charging = p.ch > 0;
      ent.charge = p.ch;
      ent.kills = p.kl; ent.deaths = p.dt; ent.score = p.s;
      ent.streak = p.sq; ent.skillCharge = p.sc;
      ent.reloading = p.r === 1;
    } else {
      ent.hp = p.h; ent.maxHp = p.m; ent.alive = p.a === 1;
      ent.crouch = p.c === 1;
      ent.facing = p.f;
      ent.aim = p.ai;
      ent.skillActive = p.sk === 1;
      ent.spawnProtect = p.sp ? COMBAT.SPAWN_PROTECT : 0;
      ent.swing = p.sg ? 0.2 : 0;
      ent.charging = p.ch > 0;
      ent.charge = p.ch;
      ent.kills = p.kl; ent.deaths = p.dt; ent.score = p.s;
      ent.weaponId = p.w;
      ent.reloading = p.r === 1;
      // 插值
      const smp = S.net.sample(p.i, 100);
      if (smp) {
        ent.x = smp.x; ent.y = smp.y; ent.aim = smp.a;
      }
    }
  }
  // 移除离开的
  for (const id of [...world.players.keys()]) {
    if (!seen.has(id)) {
      world.players.delete(id);
      if (S.me && S.me.id === id) S.me = null;
    }
  }

  // 自身详情
  if (m.self) S.self = m.self;

  // 比分 / 据点
  world.scores = m.sc || { blue: 0, red: 0 };
  if (m.pt) {
    for (const pt of m.pt) {
      const lp = world.points.find(x => x.id === pt.i);
      if (lp) { lp.owner = pt.o; lp.prog = pt.p; lp.contest = pt.c === 1; }
    }
  }
  if (m.pk) {
    for (let i = 0; i < m.pk.length && i < world.pickupState.length; i++) {
      world.pickupState[i].cd = m.pk[i] ? 1 : 0;
    }
  }
  // 烟幕：直接采用服务端权威列表
  world.smokes = (m.sm || []).map(s => ({ x: s.x, y: s.y, r: s.r, end: (m.tm || 0) + (s.l || 0) }));
  world.time = m.tm || world.time;
  world.over = m.ov === 1;
  world.winner = m.wn;
  world.time = m.tm || world.time;

  // 事件
  if (m.ev) for (const e of m.ev) handleEvent(e, world);

  // 结算
  if (world.over && S.state === 'playing') {
    S.resultShown = S.resultShown || 0;
  }

  updateHud(world, m);
}

function makeLocalPlayer(p, world) {
  const cls = CLASSES[p.k] || CLASSES.assault;
  const w = getWeapon(p.w);
  return {
    id: p.i, name: p.n, cls: p.k, team: p.t, isBot: p.b === 1,
    x: p.x, y: p.y, vx: 0, vy: 0,
    w: PHYS.W, bh: p.c ? PHYS.CROUCH_H : PHYS.H,
    crouch: p.c === 1, facing: p.f, aim: p.ai || 0,
    onGround: false, _coyote: 0, _jumpBuf: 0, _jumpHeld: false, _jumping: false,
    maxHp: p.m, hp: p.h, alive: p.a === 1,
    spawnProtect: 0, speedMul: cls.speedMul, jumpMul: cls.jumpMul,
    wp: { primary: { def: w, mag: w.mag, ammo: w.mag, reserve: w.reserve, slot: 'primary' },
          secondary: { def: getWeapon('pistol'), mag: 15, ammo: 15, reserve: 8, slot: 'secondary' } },
    slot: 'primary',
    fireCd: 0, reloadEnd: 0, burstLeft: 0, burstCd: 0, reloading: false,
    spin: 0, charge: 0, charging: false, swing: 0,
    keys: 0, aimAngle: p.ai || 0,
    kills: p.kl || 0, deaths: p.dt || 0, score: p.s || 0,
    streak: p.sq || 0, skillCharge: p.sc || 0,
    skillActive: p.sk === 1, skillEnd: 0,
    weaponId: p.w, lastHitBy: null, lastHitAt: -99,
    seq: 0, healTick: 0,
  };
}

/* ================================================================ */
/*  事件处理                                                         */
/* ================================================================ */
function handleEvent(e, world) {
  const R = S.renderer;
  const me = S.me;

  switch (e.t) {
    case 'shot': {
      // 枪口火光 + 音效 + 曳光
      const w = getWeapon(e.w);
      const isMe = e.id === S.net.id;
      const dist = me ? Math.hypot(e.x - (me.x + 13), e.y - (me.y + 23)) : 0;

      if (!isMe) audio.playAt(w.sfx, dist);
      else {
        audio.play(w.sfx);
        R.shake(w.kick ? Math.min(6, w.kick / 60) : 1, 0.12);
      }

      // 曳光：从枪口到第一个遮挡物
      if (e.angles) {
        for (const a of e.angles) {
          const len = w.scope ? 1600 : 420;
          R.addTracer(e.x, e.y, e.x + Math.cos(a) * len, e.y + Math.sin(a) * len, w.trace || '#ffe08a', 0.09);
        }
      }
      // 枪口火花
      R.burst(e.x, e.y, isMe ? 4 : 3, {
        color: w.trace || '#ffd88a', speed: 160, life: 0.2, r: 2, grav: 120,
      });
      break;
    }

    case 'hit': {
      const isMine = e.by === S.net.id;
      const isOnMe = e.id === S.net.id;
      if (isMine) {
        R.addHitMarker(e.head ? 'head' : 'hit');
        audio.play(e.head ? 'headshot' : 'hit');
        R.addFloater(e.x, e.y - 10, String(e.n), e.head ? '#fbbf24' : '#fff', e.head);
      }
      if (isOnMe) {
        R.damageFlash(Math.min(0.85, 0.25 + e.n / 60));
        R.shake(4, 0.2);
      }
      R.burst(e.x, e.y, 5, {
        color: e.head ? '#fbbf24' : '#ff6b6b', speed: 220, life: 0.3, r: 2.4,
      });
      break;
    }

    case 'kill': {
      const byMe = e.by === S.net.id;
      const isMe = e.id === S.net.id;
      const victim = world.players.get(e.id);
      const killer = e.by ? world.players.get(e.by) : null;

      R.burst(e.x, e.y, 14, { color: '#ff5252', speed: 280, life: 0.6, r: 3, grav: 420 });
      R.burst(e.x, e.y, 8, { color: '#8b1a1a', speed: 180, life: 0.8, r: 4, grav: 500 });

      if (byMe) {
        audio.play('kill');
        R.addFloater(e.x, e.y - 30, '击杀!', '#ff8a3d', true);
        if (e.streak >= 3) R.addFloater(e.x, e.y - 52, `${e.streak} 连杀`, '#fbbf24', true);
      } else if (isMe) {
        audio.play('death');
        R.damageFlash(0.9);
        R.shake(8, 0.4);
      } else {
        audio.playAt('death', me ? Math.hypot(e.x - me.x, e.y - me.y) : 0);
      }

      // 击杀播报
      const txt = killer
        ? `${escapeHtml(killer.name)} <span class="kf-w">[${getWeapon(e.w).name}]</span> ${escapeHtml(victim ? victim.name : '?')}`
        : `${escapeHtml(victim ? victim.name : '?')} 阵亡`;
      addKillRow(txt, byMe ? 'mine' : (isMe ? 'death' : ''), e.head);
      break;
    }

    case 'impact':
      R.burst(e.x, e.y, 4, { color: '#cfd8e3', speed: 140, life: 0.22, r: 1.8, grav: 200 });
      break;

    case 'explode': {
      R.burst(e.x, e.y, 26, { color: '#ffb347', speed: 420, life: 0.5, r: 4, grav: 300, glow: true });
      R.burst(e.x, e.y, 14, { color: '#ff5a3d', speed: 300, life: 0.7, r: 5, grav: 200, glow: true });
      R.shake(14, 0.5);
      audio.playAt('explode', me ? Math.hypot(e.x - me.x, e.y - me.y) : 0, 1800);
      break;
    }

    case 'pickup': {
      if (e.id === S.net.id) {
        audio.play('pickup');
        R.addFloater(e.x, e.y, e.kind === 'health' ? '+HP' : '弹药', e.kind === 'health' ? '#4ade80' : '#fbbf24');
      }
      R.burst(e.x, e.y, 8, { color: e.kind === 'health' ? '#4ade80' : '#fbbf24', speed: 130, life: 0.4, r: 2, glow: true });
      break;
    }

    case 'reload':
      if (e.id === S.net.id) audio.play('reload');
      break;

    case 'skill': {
      const p = world.players.get(e.id);
      if (p) {
        R.burst(p.x + p.w / 2, p.y + p.bh / 2, 18, {
          color: (CLASSES[p.cls] || CLASSES.assault).accent, speed: 260, life: 0.6, r: 3, glow: true,
        });
      }
      if (e.id === S.net.id) audio.play('skill');
      break;
    }

    case 'slash': {
      R.burst(e.x, e.y, 8, { color: e.kind === 'shield' ? '#cfe0ff' : '#c9a3ff', speed: 200, life: 0.3, r: 2.4 });
      if (me) audio.playAt('slash', Math.hypot(e.x - me.x, e.y - me.y));
      break;
    }

    case 'dash': {
      // 瞬步：起点到终点拉一条残影
      const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
      const len = Math.hypot(dx, dy);
      const n = Math.max(4, Math.floor(len / 22));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        R.burst(e.x0 + dx * t, e.y0 + dy * t, 3, {
          color: '#f472b6', speed: 90, life: 0.35, r: 2.6, glow: true,
        });
      }
      if (e.id === S.net.id) {
        audio.play('dash');
        R.shake(3, 0.12);
      }
      break;
    }

    case 'smoke': {
      // 烟幕生成：喷发一圈灰白粒子
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * e.r * 0.7;
        R.burst(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, 2, {
          color: '#c4d4e4', speed: 70, life: 0.9, r: 5, glow: false,
        });
      }
      if (me) audio.playAt('smoke', Math.hypot(e.x - me.x, e.y - me.y));
      break;
    }

    case 'block':
      R.burst(e.x, e.y, 10, { color: '#a8c8ff', speed: 240, life: 0.3, r: 2.4, glow: true });
      if (me) audio.playAt('shield', Math.hypot(e.x - me.x, e.y - me.y));
      break;

    case 'heal': {
      const p = world.players.get(e.id);
      if (p && e.n >= 3) R.addFloater(p.x + p.w / 2, p.y, '+' + e.n, '#4ade80');
      break;
    }

    case 'over': {
      showResult(e.winner, e.results);
      break;
    }

    case 'restart': {
      S.resultShown = false;
      S.resultCounted = false;
      el.screenResult.classList.remove('active');
      // 无论当前在哪个界面，都切到战斗
      startPlaying(e.map || S.room?.map || S.mapId);
      bigText('战斗开始', '#ff8a3d');
      break;
    }

    case 'wave': {
      // 战役波次提示
      bigText(`第 ${e.n} 波 · ${e.add} 名敌人`, '#ff8a3d');
      break;
    }

    case 'levelClear': {
      bigText('关卡通过！', '#4ade80');
      break;
    }

    case 'levelFail': {
      bigText('任务失败', '#ff5a52');
      break;
    }

    default: break;
  }
}

function addKillRow(html, cls, headshot) {
  const d = document.createElement('div');
  d.className = 'kf-row ' + cls;
  d.innerHTML = html + (headshot ? '<span class="kf-hs">爆头</span>' : '');
  el.killfeed.appendChild(d);
  while (el.killfeed.children.length > 5) el.killfeed.removeChild(el.killfeed.firstChild);
  setTimeout(() => {
    d.style.transition = 'opacity .3s, transform .3s';
    d.style.opacity = '0';
    d.style.transform = 'translateX(20px)';
    setTimeout(() => d.remove(), 320);
  }, 4200);
}

/* ================================================================ */
/*  HUD                                                              */
/* ================================================================ */
function updateHud(world, m) {
  const me = S.me;
  const isCamp = S.mode === 'campaign';
  const mode = MODES[S.mode] || MODES.tdm;
  const cp = m.cp || null;

  if (isCamp && cp) {
    // 战役：顶部改为「阵亡 x / 上限」，不再用蓝红比分
    el.hudMode.textContent = cp.name || '战役';
    if (el.scoreBlueLbl) el.scoreBlueLbl.textContent = '阵亡';
    if (el.scoreRedLbl) el.scoreRedLbl.textContent = '上限';
    el.scoreBlue.textContent = String(cp.deaths);
    el.scoreRed.textContent = String(cp.maxDeaths);
    el.hudTime.textContent = `波次 ${cp.w}/${cp.tw}`;
  } else {
    if (el.scoreBlueLbl) el.scoreBlueLbl.textContent = '蓝队';
    if (el.scoreRedLbl) el.scoreRedLbl.textContent = '红队';
    el.hudMode.textContent = mode.name;
    el.scoreBlue.textContent = String(world.scores.blue || 0);
    el.scoreRed.textContent = String(world.scores.red || 0);
    // 倒计时
    const left = Math.max(0, (mode.timeLimit || 480) - (m.tm || 0));
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    el.hudTime.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  }

  // 据点（dom 或战役 capture）
  const isCapCamp = isCamp && cp && cp.obj === 'capture';
  if ((S.mode === 'dom' || isCapCamp) && world.points.length) {
    el.hudPoints.innerHTML = world.points.map(pt => {
      const col = pt.owner ? TEAMS[pt.owner].color : '#94a3b8';
      return `<div class="point-chip ${pt.contest ? 'contest' : ''}" style="color:${col}">
        <span class="pc-id">${pt.id}</span>
        <span class="pc-bar"><i style="width:${Math.round((pt.prog || 0) * 100)}%"></i></span>
      </div>`;
    }).join('');
  } else if (isCamp && cp) {
    // 战役非占点关：显示目标进度条
    const pct = Math.round((cp.prog || 0) * 100);
    const objTxt = cp.obj === 'eliminate'
      ? `消灭 ${Math.round((cp.prog || 0) * (cp.target || 0))}/${cp.target}`
      : `坚守 ${cp.hold.toFixed(0)}/${cp.target}s`;
    el.hudPoints.innerHTML = `<div class="camp-prog">
      <span class="cp-txt">${objTxt}</span>
      <span class="cp-barc"><i style="width:${pct}%"></i></span>
      <span class="cp-wave">波次 ${cp.w}/${cp.tw}</span>
    </div>`;
  } else {
    el.hudPoints.innerHTML = '';
  }

  // 自身
  if (me && S.self) {
    const self = S.self;
    const cls = CLASSES[me.cls] || CLASSES.assault;
    el.hpClass.textContent = cls.name;
    el.hpNum.textContent = String(self.hp);
    const k = Math.max(0, self.hp / self.maxHp);
    el.hpFill.style.width = (k * 100) + '%';
    el.hpFill.classList.toggle('low', k < 0.32);
    el.hpNum.style.color = k < 0.32 ? 'var(--red)' : 'var(--green)';

    // 弹药
    const setSlot = (node, slot, active) => {
      const s = self.wp[slot];
      node.classList.toggle('on', active);
      if (!s) { node.querySelector('.w-name').textContent = '—'; return; }
      const w = getWeapon(s.id);
      node.querySelector('.w-name').textContent = w.name;
      const b = node.querySelector('.w-ammo b');
      const sp = node.querySelector('.w-ammo span');
      b.textContent = String(s.ammo);
      b.classList.toggle('empty', s.ammo <= 0);
      sp.textContent = s.mag ? `/${s.reserve * s.mag}` : '';
    };
    setSlot(el.wPrimary, 'primary', self.slot === 'primary');
    setSlot(el.wSecondary, 'secondary', self.slot === 'secondary');

    // 技能
    const sk = self.skill || cls.skill;
    el.skillIcon.textContent = { adrenaline: '⚡', cloak: '👻', nano: '✚', ironskin: '🛡' }[sk.id] || '⚡';
    el.skillName.textContent = sk.name;
    el.skillNeed.textContent = `${self.charge} / ${sk.need}`;
    el.skillRing.classList.toggle('ready', self.charge >= sk.need);
    el.skillRing.style.borderColor = self.charge >= sk.need ? 'var(--orange)' : '';

    // 装填
    el.reloadHint.classList.toggle('on', !!me.reloading);

    // 复活提示
    if (!me.alive) {
      el.respawnTip.classList.add('on');
      el.respawnTip.innerHTML = `你已阵亡<b>${Math.max(0, Math.ceil(S.respawnT))}</b>`;
    } else {
      el.respawnTip.classList.remove('on');
    }
  }
}

function bigText(text, color) {
  el.bigCenter.textContent = text;
  el.bigCenter.style.color = color || 'var(--text)';
  el.bigCenter.classList.add('on');
  clearTimeout(bigText._t);
  bigText._t = setTimeout(() => el.bigCenter.classList.remove('on'), 1600);
}

/* ================================================================ */
/*  结算                                                             */
/* ================================================================ */
function showResult(winner, results) {
  if (!results) return;
  S.state = 'result';
  el.screenResult.classList.add('active');
  el.hud.classList.remove('on');

  const me = S.me;
  const myTeam = me ? me.team : null;
  const isFfa = S.mode === 'ffa';

  let win = false;
  if (isFfa) win = winner === (me && me.id);
  else win = winner === myTeam;

  el.resultTitle.textContent = win ? '胜利' : (winner ? '失败' : '平局');
  el.resultTitle.className = win ? 'win' : 'lose';
  audio.play(win ? 'victory' : 'defeat');

  const isCampResult = S.mode === 'campaign';
  let scoreTxt = '';
  if (isCampResult) {
    const L = getLevel(S.levelId);
    scoreTxt = win
      ? `${L.name} 通关 · 奖励 ${L.reward} XP`
      : `${L.name} 失败 · 阵亡 ${S.world?.camp?.deaths || 0}/${L.maxDeaths}`;
  } else if (!isFfa) {
    scoreTxt = `蓝队 ${results.scores.blue} : ${results.scores.red} 红队`;
  }
  el.resultSub.textContent = scoreTxt || (win ? '你赢得了这场混战' : '继续努力');

  // ---- 成长结算：仅结算一次 ----
  if (!S.resultCounted) {
    S.resultCounted = true;
    const mine = (results.rows || []).find(r => me && r.id === me.id);
    const isCamp = S.mode === 'campaign';
    const out = PROG.applyMatch(S.profile, {
      kills: mine ? mine.kills : 0,
      deaths: mine ? mine.deaths : 0,
      score: mine ? mine.score : 0,
      win,
      mode: S.mode,
      levelCleared: isCamp && win,
      levelId: isCamp ? S.levelId : null,
      reward: isCamp ? getLevel(S.levelId).reward : 0,
    });
    S.profile = out.profile;
    S.matchXpGain = out.gain;
    S.levelUp = out.levelUp;
    saveProfile(S.profile);
    updateLevelBadge();
    buildClassCards();
    buildLevelPicker();
  }

  // 经验面板
  if (el.resultXp) {
    const nx = PROG.nextUnlock(S.profile.level);
    const nextHint = nx
      ? `再升 ${nx.need - S.profile.level} 级解锁「${nx.kind === 'class' ? CLASSES[nx.id].name : getWeapon(nx.id).name}」`
      : '全部内容已解锁';
    el.resultXp.innerHTML = `
      <span class="xp-gain">+${S.matchXpGain} XP</span>
      <span class="xp-lv">Lv ${S.profile.level}</span>
      ${S.levelUp ? '<span class="xp-up">升级！</span>' : ''}
      <span class="xp-next">${nextHint}</span>`;
  }

  const rows = results.rows || [];
  el.resultTable.innerHTML = `
    <div class="rt-head">
      <span></span><span style="text-align:left">玩家</span><span>击杀</span><span>死亡</span><span>K/D</span><span>得分</span>
    </div>
    ${rows.map((r, i) => {
      const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
      const isMe = me && r.id === me.id;
      return `<div class="rt-row ${isMe ? 'me' : ''}">
        <span class="r-cls">${i === 0 ? '👑' : classIcon(r.cls)}</span>
        <span class="r-name">${escapeHtml(r.name)}
          ${isFfa ? '' : `<span class="tag ${r.team}">${TEAMS[r.team]?.name || r.team}</span>`}
          ${r.isBot ? '<span class="tag bot">AI</span>' : ''}
        </span>
        <span class="r-kd">${r.kills}</span>
        <span>${r.deaths}</span>
        <span class="r-kd ${+kd >= 1 ? 'good' : 'bad'}">${kd}</span>
        <span>${r.score}</span>
      </div>`;
    }).join('')}`;
}

/* ================================================================ */
/*  主循环                                                           */
/* ================================================================ */
let lastT = performance.now();
let idleT = 0;

function idleLoop() {
  requestAnimationFrame(frame);
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (S.state === 'playing' && S.world) {
    tickPlaying(dt);
  } else {
    tickIdle(dt);
  }

  requestAnimationFrame(frame);
}

function tickIdle(dt) {
  idleT += dt;
  const R = S.renderer;
  if (!R.map) R.setMap('labs');
  // 缓慢平移的展示镜头
  const map = R.map;
  R.cam.x = (map.width - (R.viewW || R.cam.w)) * (0.5 + Math.sin(idleT * 0.12) * 0.42);
  R.cam.y = map.groundY - (R.viewH || R.cam.h) * 0.72;
  R.viewW = Math.max(900, Math.min(1500, R.cam.w * 0.85));
  R.viewH = (R.cam.h / R.cam.w) * R.viewW;
  R.draw({ players: new Map(), bullets: [], pickupState: [], points: [], isEnemyOf: () => false }, null, dt);
}

function tickPlaying(dt) {
  const world = S.world;
  const R = S.renderer;
  const me = S.me;

  // ---- 输入 → 本地预测 ----
  if (me) {
    S.input.aim = S.input.computeAim(me, R);
    if (me.alive) {
      S.predictor.step(me, S.input.keys, S.input.aim, world, dt);
      me.keys = S.input.keys;
      // 本地武器表现（换弹、枪口闪光的视觉节奏）
      const w = currentWeapon(me);
      if (me.fireCd > 0) me.fireCd -= dt;
      if (me.reloading) {
        me.reloadEnd -= dt;
        if (me.reloadEnd <= 0) me.reloading = false;
      }
    }
    // 开镜
    const w = currentWeapon(me);
    R.scoped = !!(w && w.scope && S.input.mouse.down && me.alive);
  }

  // ---- 发送输入（限速 ~40Hz，节省带宽）----
  S.sendAcc = (S.sendAcc || 0) + dt;
  if (S.sendAcc >= 0.025 && me) {
    S.sendAcc = 0;
    S.net.send({ t: 'in', k: S.input.keys, a: S.input.aim, s: ++S.seq });
  }

  // ---- 复活倒计时 ----
  if (me && !me.alive) {
    S.respawnT = Math.max(0, S.respawnT - dt);
    if (S.respawnT <= 0) S.respawnT = COMBAT.RESPAWN_TIME;
  } else if (me && me.alive) {
    S.respawnT = COMBAT.RESPAWN_TIME;
  }

  // ---- 渲染 ----
  R.follow(me, dt, R.scoped);
  R.draw(world, me, dt);

  // 小地图
  const mm = el.minimap;
  if (mm && mm.getContext) {
    const c = mm.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (mm.width !== mm.clientWidth * dpr) {
      mm.width = mm.clientWidth * dpr;
      mm.height = mm.clientHeight * dpr;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, mm.clientWidth, mm.clientHeight);
    R.drawMinimap(c, world, me, 0, 0, mm.clientWidth, mm.clientHeight);
  }

  // 结算检查
  if (world.over && S.state === 'playing') {
    S.overT = (S.overT || 0) + dt;
    if (S.overT > 1.2) {
      S.overT = 0;
      const rows = [...world.players.values()].map(p => ({
        id: p.id, name: p.name, cls: p.cls, team: p.team, isBot: p.isBot,
        kills: p.kills, deaths: p.deaths, score: p.score,
      })).sort((a, b) => b.score - a.score);
      showResult(world.winner, { winner: world.winner, scores: world.scores, rows });
    }
  }
}

/* ================================================================ */
/*  启动                                                             */
/* ================================================================ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
