/* =============================================================================
 * Nbike · js/main.js
 * 入口：渲染器 / 相机 / 输入 / 客户端预测 + 服务端校正 / 联机同步
 *
 * ── 网络模型（与服务端一致）──────────────────────────────────────────────
 *   服务端是唯一真相。客户端只上报"意图"（20Hz），本地用【同一份 physics.js】
 *   以同一固定步长预测，收到权威 state 后按位置误差做柔性校正。
 *   这样手感跟手，又不会被网络抖动拉扯。
 * ========================================================================== */
import * as THREE from '../lib/three.module.js';
import { createBike } from './bike.js';
import * as Terrain from './terrain.js';
import { buildEnvironment } from './environment.js';
import { createUI } from './ui.js';
import * as Audio from './audio.js';
import * as SpeedFx from './speedfx.js';

const C = window.NB && window.NB.C;
const Track = window.NB && window.NB.Track;
const Physics = window.NB && window.NB.Physics;
const io = window.io;

const ui = createUI();
const err = (e) => { console.error(e); ui.fatal(e); };

/* 共享模块缺失 → 给可读提示，而不是让后面的解构炸出天书堆栈 */
if (!C || !Track || !Physics) {
  ui.fatal('共享模块加载失败（constants / track / physics 未就绪）。\n' +
           '请强制刷新页面（Ctrl+F5 / Cmd+Shift+R）后重试；若仍然失败，说明网络拦截了 ' +
           '/shared/*.js。');
  throw new Error('shared modules missing');
}
if (!io) {
  ui.fatal('Socket.IO 客户端未加载（/socket.io/socket.io.js）。\n请检查网络或广告拦截插件，然后刷新页面。');
  throw new Error('socket.io client missing');
}

/* ============================================================================
 * 1. 渲染器 / 场景 / 相机
 * ---
 * ★ WebGL 上下文获取必须多级降级，不能一把梭。
 *   three r160 只支持 WebGL2。部分环境（关闭硬件加速 / 远程桌面 / 老集显 /
 *   某些隐私模式）在 antialias + high-performance 组合下会直接拿不到上下文并抛
 *   "Error creating WebGL context."，而换一组更保守的参数往往就能成功。
 *   这里从"画质最好"到"最保守"依次尝试，全部失败才报错。
 * ========================================================================== */
const canvas = document.getElementById('gl');

function createRenderer() {
  const attempts = [
    { label: '高质量', antialias: true, powerPreference: 'high-performance', stencil: false },
    { label: '标准', antialias: true, powerPreference: 'default', stencil: false },
    { label: '省电', antialias: false, powerPreference: 'low-power', stencil: false },
    { label: '兼容', antialias: false, powerPreference: 'default', stencil: false, alpha: false, depth: true, failIfMajorPerformanceCaveat: false }
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const opts = { canvas, ...a };
      delete opts.label;
      const r = new THREE.WebGLRenderer(opts);
      if (a.label !== '高质量') console.warn('[renderer] 降级到「' + a.label + '」模式');
      return r;
    } catch (e) { lastErr = e; }
  }
  /* 全部失败 → 给出人话指引（这才是用户真正需要的） */
  const gl = !!(window.WebGLRenderingContext || window.WebGL2RenderingContext);
  const hint = gl
    ? '你的浏览器支持 WebGL，但当前无法创建 3D 上下文。常见原因：\n' +
      '  · 浏览器「硬件加速」被关闭 —— 设置里搜索"硬件加速"并打开，然后重启浏览器\n' +
      '  · 正在使用远程桌面 / 虚拟机 —— 请在本机浏览器打开\n' +
      '  · 显卡驱动过旧 —— 更新驱动，或换用最新版 Chrome / Edge\n\n' +
      '原始错误：' + (lastErr && lastErr.message ? lastErr.message : lastErr)
    : '你的浏览器不支持 WebGL。请改用最新版 Chrome、Edge 或 Firefox 打开本页面。';
  const e = new Error(hint);
  e.__friendly = true;
  throw e;
}

let renderer;
try {
  renderer = createRenderer();
} catch (e) {
  ui.fatal(e.__friendly ? e.message : e);
  throw e;   // 交给全局捕获，但 fatal 有幂等守卫，不会被覆盖
}

renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xa9c0d4, 460, 4600);

const camera = new THREE.PerspectiveCamera(66, window.innerWidth / window.innerHeight, 0.16, 12000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ============================================================================
 * 2. 世界构建（分帧推进，避免长时间白屏）
 * ========================================================================== */
let env = null;
const riders = new Map();     // id → { bike, root, label, target }
let me = null;

const WORLD_POS = new THREE.Vector3();

function makeNameLabel(name, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(10,14,20,0.78)';
  const r = 14;
  g.beginPath();
  g.moveTo(r, 2); g.lineTo(cv.width - r, 2); g.arcTo(cv.width - 2, 2, cv.width - 2, r, r);
  g.lineTo(cv.width - 2, cv.height - r); g.arcTo(cv.width - 2, cv.height - 2, cv.width - r, cv.height - 2, r);
  g.lineTo(r, cv.height - 2); g.arcTo(2, cv.height - 2, 2, cv.height - r, r);
  g.lineTo(2, r); g.arcTo(2, 2, r, 2, r);
  g.closePath(); g.fill();
  g.fillStyle = color || '#fff';
  g.fillRect(9, 18, 5, 28);
  g.fillStyle = '#fff';
  g.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name.slice(0, 9), 24, cv.height / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, depthWrite: false, transparent: true
  }));
  sp.scale.set(1.5, 0.375, 1);
  sp.renderOrder = 900;
  return sp;
}

function createRider(id, name, color) {
  const bike = createBike({
    frameColor: parseInt(String(color).replace('#', '0x'), 16),
    jerseyColor: parseInt(String(color).replace('#', '0x'), 16)
  });
  const root = new THREE.Group();
  root.add(bike.root);
  const label = makeNameLabel(name, color);
  label.position.set(0, 2.15, 0);
  root.add(label);
  scene.add(root);
  bike.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  const rec = { id, name, color, bike, root, label, interp: null };
  riders.set(id, rec);
  return rec;
}

/* ============================================================================
 * 3. 输入
 * ========================================================================== */
const keys = Object.create(null);
const inputState = {
  a: 0, d: 0, steer: 0, brake: 0, throttle: 0, gearDelta: 0,
  /* 世界坐标下的转向意图：自己决定 left/right，服务端只认 steer */
};

const KEYMAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'slow', ArrowDown: 'brake',
  KeyA: 'a', KeyD: 'd', KeyQ: 'shiftDown', KeyE: 'shiftUp',
  KeyC: 'cam', KeyH: 'help', KeyR: 'restart', Enter: 'race', Space: 'brake'
};

window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  /* ★ 音频必须在用户手势里解锁（浏览器策略），第一次按键就调一次 */
  Audio.unlock();
  if (!k) return;
  e.preventDefault();
  if (k === 'cam' && !keys[k]) cycleCamera();
  if (k === 'help' && !keys[k]) ui.toggleHelp();
  if (k === 'restart' && !keys[k] && socket) socket.emit('restart');
  if (k === 'race' && !keys[k] && socket) startOrQuitRace();
  /* ★ 换挡必须在按下瞬间立即入队（边沿触发）。
   *   原来只在 readInput() 的冷却检查里读 keys 状态 → 短按（<1 帧间隔）会被整个丢掉，
   *   而且连按多次只有第一次生效，手感就是"挂不上挡"。
   *   方向：CASSETTE[11,12,...,32]，**index 越大齿比越轻**（踏频越高）。
   *   UI 标注「Q 轻 · E 重」→ Q 应让 index +1，E 应让 index −1。
   *   （原实现 Q 是 −1、E 是 +1，与标签完全相反，这也是"挂不上挡"的一部分。） */
  if (k === 'shiftDown' && !keys[k]) shiftQueue += 1;    // Q = 更轻
  if (k === 'shiftUp' && !keys[k]) shiftQueue -= 1;      // E = 更重
  keys[k] = true;
});
window.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (!k) return;
  keys[k] = false;
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

/* 触摸/点击兼容：给手机一个"加油"按钮意义不大，这里只做失焦保护 */

let ready = false;

/* 发起 / 退出比赛：自由训练是常态，比赛由玩家主动开启 */
let racePanelOpen = false;
function startOrQuitRace() {
  if (!socket) return;
  if (phase === 'racing' || phase === 'countdown') {
    socket.emit('endRace');
  } else {
    socket.emit('startRace', laps);
  }
}

/* ============================================================================
 * 4. 客户端预测状态
 * ========================================================================== */
let pred = null;              // 本地预测的 rider state
let authorS = 0, authorLat = 0; // 权威位置（用于柔性校正）
let lastStateAt = 0;
let phase = 'waiting';
let laps = C.RACE.DEFAULT_LAPS;
let myId = null;
let boardData = null;
let nearList = [];

const inputBuf = { a: 0, d: 0, steer: 0, brake: 0, throttle: 0, gearDeltaQ: 0 };
let shiftCooldown = 0;
let shiftQueue = 0;        // 按下瞬间入队，冷却到点后逐个消费（防短按丢失）
let localGearDelta = 0;    // 本地预测专用的换挡增量（与服务端上报分开，避免互相清零）

function readInput(dt) {
  inputBuf.a = keys.a ? 1 : 0;
  inputBuf.d = keys.d ? 1 : 0;
  inputBuf.brake = keys.brake ? 1 : 0;
  inputBuf.throttle = keys.slow ? 1 : 0;
  /* ★ 转向符号约定：steer > 0 = 向【左】（lateral 增大），steer < 0 = 向【右】。
   *   Track.posAt 的 lateral 正向经数值验证为"前进方向的左侧"（(t×d).y > 0），
   *   物理里 latTarget = steer * steerRate 直接加到 lateral 上，所以符号必须对上，
   *   否则按 → 车会往左跑（曾如此）。 */
  let st = 0;
  if (keys.left) st += 1;
  if (keys.right) st -= 1;
  inputBuf.steer = st;

  /* Q/E 换挡：
   *  ① 按下瞬间已入队 shiftQueue（见 keydown 边沿触发），保证短按永不丢；
   *  ② 按住不放时按冷却自动连续换挡（长按降/升挡的手感）。
   * 服务端同样有冷却，这里与之保持一致节奏。
   * ★ 本地预测与服务端必须各消费一份：共用一个字段会被先跑的那一方清零，
   *   另一方永远拿到 0（曾导致"换挡只在本机生效、服务端从不知道"）。 */
  shiftCooldown = Math.max(0, shiftCooldown - dt);
  if (shiftCooldown <= 0) {
    let step = 0;
    if (shiftQueue !== 0) {
      step = C.clamp(shiftQueue, -1, 1);
      shiftQueue -= step;
    } else if (keys.shiftDown) step = 1;      // Q = 更轻
    else if (keys.shiftUp) step = -1;         // E = 更重
    if (step !== 0) {
      inputBuf.gearDeltaQ += step;            // 上报给服务端
      localGearDelta += step;                 // 本地预测自用
      shiftCooldown = C.BIKE.GEAR_CD;
      Audio.shiftSound(step < 0);             // step<0 = 更重(升挡)，音调偏低
    }
  }
}

let sendAcc = 0, sendDt = 1 / C.NET.INPUT_HZ;
let lastSent = { a: 0, d: 0, steer: 0, brake: 0, throttle: 0 };

function flushInput(dt) {
  if (!socket || !socket.connected) return;
  sendAcc += dt;
  if (sendAcc < sendDt) return;

  const changed =
    lastSent.a !== inputBuf.a || lastSent.d !== inputBuf.d ||
    lastSent.steer !== inputBuf.steer || lastSent.brake !== inputBuf.brake ||
    lastSent.throttle !== inputBuf.throttle || inputBuf.gearDeltaQ !== 0;

  const gd = inputBuf.gearDeltaQ;
  inputBuf.gearDeltaQ = 0;
  sendAcc = 0;

  /* 心跳式上报：状态未变也每 0.5s 发一次，防服务端认为掉线 */
  if (!changed && performance.now() - lastInputSent < 500) return;
  lastInputSent = performance.now();
  lastSent.a = inputBuf.a; lastSent.d = inputBuf.d;
  lastSent.steer = inputBuf.steer; lastSent.brake = inputBuf.brake;
  lastSent.throttle = inputBuf.throttle;
  socket.emit('input', {
    a: inputBuf.a, d: inputBuf.d, steer: inputBuf.steer,
    brake: inputBuf.brake, throttle: inputBuf.throttle,
    gearDelta: C.clamp(gd, -1, 1)
  });
}
let lastInputSent = 0;

/* ============================================================================
 * 5. 相机
 * ========================================================================== */
const CAM_MODES = ['第三人称', '跟车', '第一人称', '俯瞰'];
let camMode = 0;
let camPos = new THREE.Vector3(0, 6, -10);
let camLook = new THREE.Vector3();
let shakeAmt = 0;

function cycleCamera() {
  camMode = (camMode + 1) % CAM_MODES.length;
  ui.showCenter(CAM_MODES[camMode], '视角 C', false);
  setTimeout(() => ui.hideCenter(), 900);
}

function updateCamera(dt) {
  if (!me || !pred) return;
  const p = Physics.worldPos(pred);
  const head = Math.atan2(p.tx, p.tz);
  const v = pred.speed;

  const fwd = new THREE.Vector3(Math.sin(head), 0, Math.cos(head));
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

  let want, look;
  const bob = Math.sin(pred.crank * Math.PI / 180 * 2) * 0.012 * (v / 12);
  const lean = pred.lean;

  switch (camMode) {
    case 1: { // 跟车（较近，带压弯倾斜）
      want = new THREE.Vector3(p.x, p.y + 1.42 + bob, p.z)
        .addScaledVector(fwd, -3.6)
        .addScaledVector(right, -lean * 0.55);
      look = new THREE.Vector3(p.x, p.y + 1.05, p.z).addScaledVector(fwd, 7);
      break;
    }
    case 2: { // 第一人称（车把视角）
      want = new THREE.Vector3(p.x, p.y + 1.28 + bob * 2.2, p.z)
        .addScaledVector(fwd, 0.62)
        .addScaledVector(right, pred.lateral * 0.02);
      want.x += shakeAmt * 0.02 * Math.sin(performance.now() * 0.05);
      look = new THREE.Vector3(p.x, p.y + 0.95, p.z).addScaledVector(fwd, 26).addScaledVector(right, pred.latVel * 0.12);
      break;
    }
    case 3: { // 俯瞰（看清赛道走向）
      want = new THREE.Vector3(p.x, p.y + 34, p.z).addScaledVector(fwd, -20);
      look = new THREE.Vector3(p.x, p.y, p.z).addScaledVector(fwd, 34);
      break;
    }
    default: { // 第三人称
      const dist = 5.4 + Math.min(2.6, v * 0.09);
      want = new THREE.Vector3(p.x, p.y + 2.05, p.z)
        .addScaledVector(fwd, -dist)
        .addScaledVector(right, -lean * 0.85);
      look = new THREE.Vector3(p.x, p.y + 1.02, p.z).addScaledVector(fwd, 8).addScaledVector(right, pred.latVel * 0.25);
    }
  }

  /* 相机不埋地：抬到地面之上 */
  const minY = Terrain.heightAt(want.x, want.z) + 0.42;
  if (want.y < minY) want.y = minY;

  const k = camMode === 2 ? 1 : 1 - Math.pow(0.0018, dt);
  camPos.lerp(want, k);
  camLook.lerp(look, camMode === 2 ? 1 : 1 - Math.pow(0.0009, dt));

  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.rotateZ(-lean * 0.16 * (camMode === 2 ? 0.5 : 1));
}

/* ============================================================================
 * 6. Socket
 * ========================================================================== */
let socket = null;
let clock = new THREE.Clock();

function connect() {
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 5000,
    timeout: C.NET.CONNECT_TIMEOUT
  });

  socket.on('connect', () => {
    ui.net(true, '已连接');
    ui.el.netStat.hidden = false;
  });
  socket.on('disconnect', (r) => {
    ui.net(false, '断开（' + r + '）');
    ui.setChatVisible(false);
  });
  socket.io.on('reconnect_attempt', () => ui.net(null, '重连中…'));
  socket.on('connect_error', () => ui.net(false, '连接失败'));

  /* --- 一次性静态数据 --- */
  socket.on('init', (d) => {
    myId = d.id;
    laps = d.laps;
    phase = d.phase;
    ui.el.netStat.hidden = true;
    buildRoster(d.players);
    ui.setChatVisible(true);
    /* 进来就是自由训练：除非正好在比赛中，否则不弹任何遮挡 */
    if (d.phase === 'racing') ui.showCenter('比赛进行中', '你会从大部队后方加入', false);
    else if (d.phase === 'countdown') ui.showCenter('即将发车', '比赛倒计时中', false);
    else ui.showCenter('自由训练', '按 Enter 发起比赛 · 现在就能骑', false), setTimeout(() => ui.hideCenter(), 2200);
  });

  socket.on('roster', (d) => buildRoster(d.players));

  socket.on('playerLeft', (d) => {
    const r = riders.get(d.id);
    if (r) { scene.remove(r.root); riders.delete(d.id); }
  });

  /* --- 权威状态：驱动自己的位置校正与他人插值 --- */
  socket.on('state', (d) => {
    lastStateAt = performance.now();
    phase = d.phase;
    laps = d.laps;
    nearList = d.near || [];

    if (d.you) {
      applyAuthority(d.you);
      me = d.you;
    }
    /* 近场车手：记录插值目标 */
    for (const q of nearList) {
      let r = riders.get(q.i);
      if (!r) r = createRider(q.i, q.n, q.c);
      r.interp = { s: q.s, l: q.l, cr: q.cr, v: q.v, ln: q.ln, g: q.g, t: performance.now() };
      r.lastSeen = performance.now();
    }
    /* 长时间未见 → 移除 */
    for (const [id, r] of riders) {
      if (id === myId) continue;
      if (!r.lastSeen || performance.now() - r.lastSeen > 3000) {
        scene.remove(r.root); riders.delete(id);
      }
    }

    if (d.phase === 'countdown' && d.countdown > 0.6) {
      ui.el.hud.hidden = false;
    }
    if (d.phase === 'countdown') {
      const s = Math.ceil(d.countdown);
      if (s <= 5) ui.showCenter(String(s), '准备', false);
    } else if (d.phase === 'racing' && phase !== 'racing') {
      ui.hideCenter();
    }
  });

  socket.on('board', (d) => {
    boardData = d;
    d.rows.forEach(r => {
      r.isMe = r.id === boardData.me;
      r._s = r.s; r._lat = 0;
    });
    const mi = d.rows.findIndex(r => r.id === d.me);
    d.myRank = mi >= 0 ? d.rows[mi].rank : null;
    d.myLat = 0;
  });

  socket.on('phase', (d) => {
    phase = d.phase;
    laps = d.laps || laps;
  });

  socket.on('countdownTick', (d) => {
    if (d.seconds > 0) ui.showCenter(String(d.seconds), '准备', false);
  });
  socket.on('raceStart', () => {
    ui.showCenter('GO', '出发！', true);
    setTimeout(() => ui.hideCenter(), 1200);
  });

  socket.on('lap', (d) => {
    ui.pushChat('系统', '#ffd200', `第 ${d.lap} 圈 · ${ui.fmtTime(d.lapTime)}`);
    if (d.lap < d.laps) ui.showCenter('LAP ' + d.lap, '还剩 ' + (d.laps - d.lap) + ' 圈', false);
    setTimeout(() => ui.hideCenter(), 1400);
  });

  socket.on('finish', (d) => {
    ui.pushChat('系统', '#30d158', `${d.name} 完赛 ${ui.fmtTime(d.time)}`);
  });

  socket.on('youFinished', (d) => {
    ui.showCenter('完赛', ui.fmtTime(d.time), true);
    setTimeout(() => ui.hideCenter(), 2400);
  });
  socket.on('dnf', () => ui.showCenter('DNF', '超时', false));

  socket.on('matchEnd', (d) => {
    const youRow = d.results.find(r => r.id === myId) || null;
    ui.showResults({
      title: '第 ' + d.round + ' 轮 · ' + d.laps + ' 圈 · 结束',
      you: youRow,
      results: d.results
    });
  });
  socket.on('matchReset', (d) => {
    laps = d.laps; phase = 'free';
    ui.hideResults();
    ui.showCenter('自由训练', '比赛已结束 · 按 Enter 再来一局', false);
    setTimeout(() => ui.hideCenter(), 1800);
  });

  socket.on('lapsSet', (d) => {
    laps = d.laps;
    ui.pushChat('系统', '#69c0ff', '圈数设为 ' + d.laps + (d.next ? '（下一轮生效）' : ''));
  });
  socket.on('readyState', (d) => {
    ui.pushChat('系统', '#9aa4b0', `已就绪 ${d.ready.length}/${d.total}`);
  });
  socket.on('raceInvite', (d) => {
    ui.pushChat('系统', '#ffd200', `${d.by} 发起了比赛${d.laps ? '（' + d.laps + ' 圈）' : ''}`);
  });
  socket.on('chat', (d) => ui.pushChat(d.name, d.color, d.text));
  socket.on('denied', (d) => {
    ui.showCenter('操作被拒绝', d.why || '', false);
    setTimeout(() => ui.hideCenter(), 1300);
  });
  socket.on('serverFull', (d) => {
    ui.fatal('服务器已满（上限 ' + d.max + ' 人）');
  });

  /* RTT 采样 */
  setInterval(() => {
    if (!socket.connected) return;
    const t = performance.now();
    socket.emit('pingCheck', t, () => {
      pendingRtt = performance.now() - t;
    });
  }, 3000);
  ui.onChatButton((t) => { if (socket.connected) socket.emit('emote', t); });
}
let pendingRtt = 0;

function buildRoster(list) {
  boardData = boardData || { rows: [] };
  for (const p of list) {
    if (p.id === myId) continue;
    if (!riders.has(p.id)) createRider(p.id, p.name, p.color);
  }
}

/* 权威状态 → 本地预测的柔性校正
 * ★ 只校正"位置类"量（s / lateral），不校正 speed / crank：
 *   速度与曲柄相位必须由本地物理连续推进，硬校正会让踩踏动画抖动。
 */
function applyAuthority(a) {
  if (!pred) {
    pred = Physics.newRiderState(a.s, a.l, a.g);
  }
  authorS = a.s; authorLat = a.l;
  let ds = a.s - pred.s;
  // 跨圈归一化
  if (ds > Track.PERIM * 0.5) ds -= Track.PERIM;
  else if (ds < -Track.PERIM * 0.5) ds += Track.PERIM;
  const dLat = a.l - pred.lateral;
  const posErr = Math.hypot(ds, dLat);

  /* 误差小 → 平滑贴合；误差大（被撞出界/传送）→ 直接归位 */
  if (posErr > 12) {
    pred.s = a.s; pred.lateral = a.l;
    pred.speed = a.v;
  } else {
    const corrS = ds * 0.28;
    pred.s = Track.normS(pred.s + corrS);
    pred.lateral += dLat * 0.28;
    /* 注意：dist 只由物理推进累积，不把校正位移算进去。
     * 否则 HUD 速度（按 dist 增量算）会被校正量污染 —— 曾出现显示 4km/h、
     * 画面却按 17km/h 前进的严重脱节。 */
  }
  /* 速度轻微收敛：只在偏差大时拉一把，避免预测发散又不干扰手感 */
  if (Math.abs(a.v - pred.speed) > 3.2) pred.speed += (a.v - pred.speed) * 0.25;
  /* 服务端判定的外部状态直接采用 */
  pred.draft = a.dft; pred.cdaFactor = a.cda;
  pred.gear = a.g;
  pred.stamina = a.st;

  /* ============ ★ 曲柄相位必须锚定服务端 ============
   * 这是"A/D 反了、按 A 没用"的真凶：
   *   本地预测从 START_CRANK 起自己推进，服务端也从 START_CRANK 起推进，
   *   但两边的输入到达时刻、帧边界、网络抖动都不一样 →
   *   实测本地与服务端曲柄角可差 100~155°（60rpm 下约 300~430ms）。
   *   而【判定在服务端、UI 在客户端】，于是：
   *     服务端 cr=160°（推压段，按 A 对）时，客户端以为 cr=290°（提拉段）→
   *     界面提示按 D、玩家按 A 被判"踩反"，体感就是"A 区间要按 D""按 A 没用"。
   *
   * 修法：收到 state 就把本地曲柄角拉到服务端值附近（环形插值，避免绕圈跳变），
   *   之后靠本地 cadence 继续推进（保证动画平滑、跟手）。
   *   同时把相位用于"预测未来"：用已抵达的相位 + 一个上报周期外推，
   *   这样按下判决基本落在服务端期望的窗口内。
   * ★ 不能用硬赋值：会让踩踏动画每 50ms 抖一下。 */
  if (typeof a.cr === 'number') {
    let dcr = a.cr - pred.crank;
    if (dcr > 180) dcr -= 360;
    else if (dcr < -180) dcr += 360;
    /* ★ 以服务端相位为唯一基准：判决在服务端做，UI 就必须跟服务端。
     *   做法：把本地相位"快速但平滑"地收敛到服务端值。
     *   - 偏差大（>60°，如刚连上/卡顿/换挡瞬间）→ 直接贴过去
     *   - 偏差小 → 每收到一帧消掉 55%（约 2 帧内对齐），既跟得上又不抖
     *   上一步试过"再往前推 RTT/2"，结果是补偿过头（相位跑快 60~77°），
     *   因为 RTT 里含本地回环开销、且 pred.crank 本身还在按 cadence 自走。
     *   → 不要叠加前推，老老实实对齐服务端。 */
    if (Math.abs(dcr) > 60) pred.crank = ((a.cr % 360) + 360) % 360;
    else pred.crank = ((pred.crank + dcr * 0.55) % 360 + 360) % 360;
    window.__nbCrank = { local: pred.crank, server: a.cr, cad: pred.cadence };
  }
}

/* ============================================================================
 * 7. 每帧主循环
 * ========================================================================== */
const localInput = { a: 0, d: 0, steer: 0, brake: 0, throttle: 0, gearDelta: 0 };
let acc = 0, lastT = performance.now();
let fpsAcc = 0, fpsCnt = 0, fpsT = 0;
/* HUD 显示速度（权威速度与本地预测融合，与画面位移自洽） */
let dispSpeed = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.25) dt = 0.25;

  /* ---------- 输入 ---------- */
  readInput(dt);
  flushInput(dt);

  /* ---------- 本地预测 ---------- */
  if (pred && me) {
    localInput.a = inputBuf.a; localInput.d = inputBuf.d;
    localInput.steer = inputBuf.steer; localInput.brake = inputBuf.brake;
    localInput.throttle = inputBuf.throttle;
    localInput.gearDelta = localGearDelta;
    localGearDelta = 0;

    const ctx = {
      slope: Track.slopeAt(pred.s),
      curv: Track.curvatureAt(pred.s),
      onRoad: Math.abs(pred.lateral) <= C.WORLD.LANE_HALF,
      cdaFactor: pred.cdaFactor || 1,
      headwind: 0
    };
    /* 与服务端一致：free / racing 都推进物理（自由训练也能骑） */
    Physics.step(pred, localInput, ctx, dt);
    if (pred.raceTime != null) pred.raceTime += dt;

    /* ★ HUD 速度取【权威速度 a.v】（服务端权威 state 下发）与本地预测速度的融合：
     *   - 权威 a.v 是服务端物理算出的真实速度（20~30Hz 到达）
     *   - 本地 pred.speed 是同源物理的即时预测
     *   两者同源，融合后既跟手又与"服务端认为你在跑多快"一致。
     *   曾经直接用 pred.speed，但本地预测与 applyAuthority 的位置校正不同步，
     *   导致显示速度与画面位移对不上（显示 4km/h、实际 17km/h）。 */
    const vAuth = (me && typeof me.v === 'number') ? me.v : pred.speed;
    const vLoc = pred.speed;
    /* 权威值权重随偏差增大而提高：偏差小信本地（跟手），偏差大信权威（纠偏） */
    const dev = Math.abs(vAuth - vLoc);
    const wAuth = Math.min(0.85, Math.max(0.12, dev / 6));
    dispSpeed += ((vAuth * wAuth + vLoc * (1 - wAuth)) - dispSpeed) * Math.min(1, dt / 0.12);
  }

  /* ---------- 车手姿态 ---------- */
  updateRiders(dt);

  /* ---------- 相机 ---------- */
  updateCamera(dt);

  /* ---------- 阴影跟随 ---------- */
  if (env && pred) {
    WORLD_POS.copy(Physics.worldPos(pred));
    env.updateShadow(WORLD_POS);
    env.updateSky(camera.position);
  }

  /* ---------- 持续音效（链条 / 风噪）：每帧只更新增益与滤波，不新建节点 ---------- */
  if (pred) {
    const pedaling = !!((inputBuf.a || inputBuf.d) && pred.speed > 0.5);
    Audio.update(pred.speed, pred.cadence, pedaling);
  }

  /* ---------- HUD ---------- */
  if (me) {
    const hudMe = uiMe();
    ui.frame({
      me: hudMe,
      board: boardData,
      near: nearList,
      laps,
      /* ★ 换挡建议：ui.js 会读 gearAdvice.recommended / .hint，必须在这里算好传下去。
       *   曾经漏传 → ui 里 undefined.recommended 直接抛错、整页"启动失败"。 */
      gearAdvice: Physics.gearAdvice(pred || { speed: hudMe.v, gear: hudMe.g, cadence: hudMe.cd }),
      ui: {
        gainBandOfL: C.gainBand(me.lg),
        gainBandOfR: C.gainBand(me.rg)
      },
      footScreen: footScreenPos()
    });
  }

  fpsAcc += dt; fpsCnt++;
  if (now - fpsT > 500) { ui.fps(fpsCnt / fpsAcc); fpsAcc = 0; fpsCnt = 0; fpsT = now; }

  renderer.render(scene, camera);
  /* 径向模糊：必须在 render 之后、同一帧内采样，否则 drawing buffer 已清空 */
  SpeedFx.render(renderer.domElement, dispSpeed);
}

/** 把权威 state 与本地预测融合成 HUD 数据源 */
function uiMe() {
  const a = me || {};
  return {
    v: dispSpeed,
    pw: a.pw || 0,
    cd: a.cd || 0,
    st: a.st != null ? a.st : 100,
    g: a.g != null ? a.g : C.BIKE.GEAR_DEFAULT,
    sf: a.sf || 0,
    cr: pred ? pred.crank : 0,
    lg: a.lg || 0, rg: a.rg || 0,
    lf: a.lf || 0, rf: a.rf || 0,
    la: a.la, ra: a.ra, lgood: a.lgood, rgood: a.rgood, lbad: a.lbad, rbad: a.rbad,
    s: a.s || 0, l: a.l != null ? a.l : 0,
    /* ★ 里程必须透传服务端 di（st.dist）。uiMe 是白名单重建对象，
     *   漏传会让 HUD 里程恒为 0（曾用 lap*PERIM+s 兜底，起步直接显示 8.10km）。 */
    di: a.di != null ? a.di : 0,
    /* 有效力矩与反向标记（红区反向拖拽提示） */
    dg: a.dg != null ? a.dg : 0,
    rv: a.rv === 1,
    lap: a.lap || 0, dft: a.dft || 0,
    or: a.or, gh: a.gh || 0, bh: a.bh || 0, pc: a.pc || 0,
    grade: a.grade || 0, elev: a.elev || 0,
    rt: a.rt
  };
}

/* 把两只脚 + 模型头顶投影到屏幕：
 *  - l / r：两只脚踝，用于"模型旁边"的按键提示点
 *  - top  ：头顶上方一点，用于功率浮标
 * ★ top 必须在脚部越界判断之前算好：脚出画不该把头顶浮标一起丢掉。 */
const _v = new THREE.Vector3();
const _vTop = new THREE.Vector3();
function footScreenPos() {
  if (!meRider || camMode === 2) return null;
  const rider = meRider.bike.rider;
  const o = rider.legs;
  if (!o || !o[0]) return null;
  const w = window.innerWidth, h = window.innerHeight;

  /* 头顶功率浮标的位置（先算，不受脚部越界影响）
   * ★ 锚点用名字牌（label, y≈2.15）而不是头部：
   *   用头部会正好落在名字牌上，两个数字叠在一起。 */
  let top = null;
  const anchor = meRider.label || rider.head || rider.torso;
  if (anchor) {
    anchor.getWorldPosition(_vTop);
    _vTop.y += anchor === meRider.label ? 0.48 : 0.42;
    _vTop.project(camera);
    if (_vTop.z <= 1) {
      top = {
        x: (_vTop.x * 0.5 + 0.5) * w,
        y: (-_vTop.y * 0.5 + 0.5) * h
      };
    }
  }

  const out = { l: null, r: null, top };
  for (let i = 0; i < 2; i++) {
    const leg = o[i];
    leg.ankle.getWorldPosition(_v);
    _v.project(camera);
    if (_v.z > 1) return { l: null, r: null, top };
    const px = (_v.x * 0.5 + 0.5) * w;
    const py = (-_v.y * 0.5 + 0.5) * h;
    if (px < 0 || px > w || py < 0 || py > h) return { l: null, r: null, top };
    out[i === 0 ? 'l' : 'r'] = { x: px, y: py };
  }
  return out;
}
let meRider = null;

/* ---------- 车手与单车姿态同步 ---------- */
function updateRiders(dt) {
  /* 自己：完全用本地预测（0 延迟） */
  if (myId) {
    let r = riders.get(myId);
    if (!r) { r = createRider(myId, '我', '#ffd200'); meRider = r; }
    meRider = r;
    if (pred) poseRider(r, pred, dt);
  }
  /* 他人：在两次 state 之间按速度外推 */
  for (const [id, r] of riders) {
    if (id === myId) continue;
    if (!r.interp) continue;
    const age = Math.min(0.4, (performance.now() - r.interp.t) / 1000);
    const s = Track.normS(r.interp.s + r.interp.v * age);
    const st = {
      s, lateral: r.interp.l,
      speed: r.interp.v, crank: (r.interp.cr + r.interp.v * 0.9 * age * 6 * 3) % 360,
      gear: r.interp.g, lean: r.interp.ln || 0, draft: 0
    };
    poseRider(r, st, dt);
  }
}

const _p = {};
function poseRider(rec, st, dt) {
  const p = Track.posAt(st.s, st.lateral);
  rec.root.position.set(p.x, p.y, p.z);
  rec.root.rotation.y = Math.atan2(p.tx, p.tz);
  /* 调试探针：暴露自己的模型世界坐标，用于校验「HUD 速度 vs 画面位移」 */
  if (rec === meRider) window.__nbProbe = { x: p.x, z: p.z, s: st.s };
  rec.bike.update(dt, {
    crankRad: st.crank * Math.PI / 180,
    gear: st.gear,
    lean: st.lean || 0,
    steer: st.latVel !== undefined ? C.clamp(st.latVel * 0.12, -1, 1) : 0,
    speed: st.speed,
    draft: st.draft || 0,
    braking: !!st.braking
  });
  /* 尾流真空带：长度随速度增长；吃到别人尾流时线条更亮（表示低压区更强） */
  if (rec.bike.updateWake) rec.bike.updateWake(st.speed, st.draft || 0);
  rec.label.position.y = 2.15;
}

/* ============================================================================
 * 8. 启动
 * ========================================================================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boot() {
  ui.progress(0.06, '正在生成赛道…');
  SpeedFx.init();          // 速度感叠加层（低分辨率 2D canvas，成本极低）
  await sleep(16);

  /* 赛道已由 shared/track.js 在加载时算好 */
  const perim = Track.PERIM;
  ui.progress(0.16,
    `赛道 ${(perim / 1000).toFixed(2)} km · ${Track.CLIMBS.length} 个爬坡 · ${Track.CORNERS.length} 个弯`,
    `最高点 ${Track.BOUNDS.maxY.toFixed(0)} m · 最低 ${Track.BOUNDS.minY.toFixed(0)} m`);

  await sleep(40);
  ui.progress(0.26, '正在构建地形（距离场 + 山体网格）…');
  await sleep(40);

  let terrain = null;
  try {
    terrain = Terrain.buildTerrain({ cols: 420 });
  } catch (e) { err(e); return; }
  scene.add(terrain.group);
  ui.progress(0.56, '地形完成',
    `延展带 ${(terrain.ribbonTris / 1000).toFixed(0)}k 三角面 · 山体 ${(terrain.diskTris / 1000).toFixed(0)}k · 山顶 ${terrain.peakY.toFixed(0)} m`);
  await sleep(30);

  ui.progress(0.64, '正在铺设路面 / 护栏 / 植被 / 观众…');
  await sleep(30);
  try {
    env = buildEnvironment(scene);
  } catch (e) { err(e); return; }
  ui.progress(0.92, '环境完成',
    `路面 ${(env.stats.roadTris / 1000).toFixed(1)}k 面 · 护栏 ${env.stats.rails} · ` +
    `树 ${env.stats.trees} · 石 ${env.stats.rocks} · 草 ${env.stats.grass} · 观众 ${env.stats.people}`);
  await sleep(30);

  ui.progress(0.96, '连接服务器…');
  connect();

  /* 首帧 */
  requestAnimationFrame(() => {
    renderer.render(scene, camera);
    ui.progress(1, '就绪');
    setTimeout(() => ui.ready(), 220);
  });

  frame();
}

boot().catch(err);
