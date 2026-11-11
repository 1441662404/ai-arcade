/* =============================================================================
 * game.js —— 浏览器客户端（Three.js ESM）
 *   · 程序化低多边形地形 / 海面 / 山脉 / 双机场 / 云层 / 日照雾
 *   · 第一人称座舱 + 第三人称追尾（C 切换）
 *   · 本地预测 + 服务端权威回滚（共享 flight-physics.js）
 *   · 透明 HUD：地平仪 / 速度高度 / 油门 / 起落架 / 弹药 / 雷达 / 锁定框 / 比分 / 网络
 *   · WebAudio 程序化音效（引擎 / 风噪 / 机炮 / 导弹 / 爆炸 / 告警）
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';
import { createPostFX } from './hd-postfx.js';
import { createSky } from './hd-sky.js';
import { createOcean } from './hd-ocean.js';
import { createClouds } from './hd-clouds.js';

const FP = window.FlightPhysics;
const SIM = FP.CONFIG;
const clamp = FP.clamp;
const lerp = FP.lerp;

// =============================================================================
// === CONFIG === 客户端可调参数（渲染 / 视角 / 输入 / 特效 / 音频 / HUD）======
// =============================================================================
const CONFIG = {
  render: {
    terrainSegments: 300,     // 地形网格分段（越高越细）
    seaSegments: 40,          // 海面波动网格
    cloudCount: 240,          // 云朵数量
    fogNear: 4200,
    fogFar: 28000,
    maxPixelRatio: 1.6
  },
  view: {
    fov: 74, near: 1, far: 46000,
    cockpitFov: 66,           // 座舱视角收窄，增强压迫感和速度感
    chaseBack: 24, chaseUp: 5.4, chaseLag: 7.0,
    cockpitOffset: { x: 0, y: 1.15, z: 0.35 },
    // 轰炸机：眼位在机鼻上方的驾驶舱里，机身长 18m，追尾机位要退出 1.5 倍
    bomberCockpitOffset: { x: 0, y: 0.94, z: -5.20 },
    bomberChaseScale: 1.55,
    shakeDecay: 3.2
  },
  input: {
    stickRange: 240,          // 鼠标虚拟杆行程（像素）—— 飞机俯仰/偏航、舰炮方位共用
    shipStickY: 620,          // 舰炮密位（射程）轴独立行程：更细的档位，输入钳制与映射必须一致
    autoCenter: 0.85,         // 自动回中速率
    keyRate: 1.0
  },
  fx: {
    // 粒子池：爆炸改多层结构后单次大爆炸 ~130 颗（核心+火球+火舌+烟柱+火星+碎屑），
    // 混战时同屏 3~4 个爆炸 + 尾焰/曳光/弹着，2800 会在激战区把新爆炸挤掉。
    maxParticles: 4200,
    contrailSpeed: 95,        // 产生尾迹的最小速度
    contrailInterval: 0.04,
    smokeHealth: 45,          // 低于该血量开始冒烟
    afterburner: 0.55,        // 油门超过该值开始喷加力火焰
    tracerRange: 3500         // 超过该距离只画简版曳光（省粒子）
  },
  audio: { master: 0.5, voice: 0.95 },   // voice = 无线电语音音量（相对 master）
  hud: { radarRange: 6000, pitchPxPerDeg: 5 }
};

const COL = {
  team0: 0x2f6ea8, team1: 0xa8402f,
  teamHud0: '#4db6ff', teamHud1: '#ff6b5b',
  sky: 0x9fd0f0, fog: 0x93b3cf, sea: 0x1f5f86
};
const SUN_DIR = new THREE.Vector3(0.42, 0.52, 0.74).normalize();

// =============================================================================
// === 全局状态 ================================================================
// =============================================================================
const game = {
  playing: false,
  myId: 0, myTeam: 0, myName: '',
  view: 'chase',                 // 'chase' | 'cockpit'
  snaps: [],                     // 快照缓冲（插值用）
  views: new Map(),              // id -> 插值后的可视状态
  aaas: [],                      // 防空阵地（快照 s3）
  aaaMeshes: new Map(),          // 阵地 id -> {group, barrel}
  viewObjs: new Map(),           // id -> 复用的 Vector3/Quaternion
  mViews: new Map(),             // 导弹可视状态
  fViews: [],                    // 干扰弹可视状态
  meshes: new Map(),             // id -> 飞机模型
  mMeshes: new Map(),            // 导弹模型
  roster: [],
  teamScore: [0, 0], timeLeft: 900, matchOver: false,
  own: null,                     // { state }
  hist: [],                      // 本地预测历史（用于服务端回滚重放）
  renderOffset: new THREE.Vector3(),
  timeOffset: 0, haveOffset: false,
  rtt: 40, pingSent: 0, lastPing: 0,
  snapsPerSec: 0, snapCount: 0, snapTimer: 0,
  shake: 0,
  deathTimer: 0,
  camQuat: new THREE.Quaternion(),
  smoothQuat: new THREE.Quaternion(),
  camSnap: true,                    // 相机瞬间吸附（出生/重生/切视角时用）
  tmpEvts: [],
  inputSendAt: 0,
  lastCtl: '',                      // 上次发送的二值操纵组合（变化即发，见 sendInput）
  lastNow: performance.now() * 0.001,
  showBoard: false,
  fpsAvg: 60, qualityScale: 1, qTimer: 0,
  accum: 0,                         // （保留字段，已不用于积分）
  // 本地状态对应的服务器时间。客户端不再自由累加 dt，而是按服务器时钟推进固定步，
  // 这样本地状态永远落在服务器同一条步网格上，回包重放时不会差半步（见 predict）。
  stTime: 0,
  poseAlpha: 1,                     // 渲染插值系数（两步之间）
  renderPose: new THREE.Vector3(),  // 本帧用于渲染的机身位置（插值后）
  renderQuat: new THREE.Quaternion(),
  // 姿态修正残差：回包把机头掰了几度，用这个四元数把视觉上的“掰”抵掉，再缓慢归零。
  quatErr: new THREE.Quaternion(),
  radioMsg: null, radioT: 0,
  camSmooth: null, camSmoothInit: false,   // 追尾相机平滑位置（不含 renderOffset）
  hudMode: 0,                       // 0 = 完整 1 = 简洁 2 = 关闭（` 键切换）
  hudOp: 1,
  hudTip: 0,
  touchMode: false,
  throttleValue: 0,
  devThrottle: -1,                // <0 = 未接管；自动化测试用绝对油门
  mouse: { x: 0, y: 0 },
  gunSoundAt: 0,
  mouseDown: false, shipThr: 2, torpDir: 0,
  tracers: new Map(),            // id -> 上次生成曳光的时间
  hitFlash: 0, hitMarker: 0, killFlash: 0,
  hitDir: null,                    // 受击方向指示 {ang, t}
  deathCamId: 0,                   // 死亡观战跟随的击杀者 id（重生后自动失效）
  cvCat: [],                       // 正在弹射的飞机 [{i,ct}]（快照 cv.cat）
  cvTaxi: [],                      // 正在甲板牵引的飞机 [{i,ct}]
  cvWire: [],                      // 正在钩阻拦索的飞机 [{i,ct,k}]
  cvParkedN: [0, 0],               // 每艘舰上停放的飞机数
  cvWireFx: new Map(),             // 'team:id' -> {idx, t} 刚钩住阻拦索的抖动
  cvCatFx: new Map(),              // 'team:id' -> t 弹射蒸汽剩余时间
  cvSupplied: 0,                   // 甲板补给计时（HUD 用）
  // ---- 海战（玩家登舰后启用）----
  myShipId: 0,                     // 我所在战舰的 id（0 = 不在舰上）
  mySplashes: [],                  // 自己主炮的落水点标记 [{x,z,t,big}]（HUD 画 X 用）
  shipSpotted: new Map(),          // 开火暴露：shipId -> 暴露截止时刻（炮口闪光定位）
  shipView: 1,                     // 1 追尾（默认）/ 0 舰桥 / 2 主炮位
  shipAim: { x: 0, z: 0 },         // 主炮指令点（世界坐标，上行给服务端）
  shipAimReal: { x: 0, z: 0 },     // 炮塔实际指向的落点（HUD 画圈用）
  shipAimYaw: 0,                   // 指令方位（世界 heading 约定）
  aimMx: 0, aimMy: 0,              // 归一化瞄准输入（HUD 画准星）
  aimRange: 6000,                  // 当前瞄准射程（米）
  aimMuzX: 0, aimMuzY: 0, aimMuzZ: 0,   // 0 号炮塔炮口位置（弹道预览起点）
  aimDirX: 0, aimDirZ: -1,             // 瞄准方向（水平单位向量）
  aimFlight: 0,                        // 当前瞄准距离的弹丸飞行时间（秒）
  turretOff: 0,                    // 炮塔实际方位偏移（相对舰体，右为正）
  centerMsg: '', centerMsgAt: 0,
  clouds: [],                    // 云团数据 {x,y,z,r,h}（穿云判定用）
  beacons: [],                   // 塔顶障碍灯（红色慢闪）
  inCloud: 0,                    // 0~1 在云中的程度（只用于声音发闷）
  gVis: 1,                       // 平滑后的 G 值（视觉用）：G 效果不能跟着瞬时过载跳
  raBeepAt: 0                    // 无线电高度告警音时间
};

// 控制意图（本地预测与上传共用同一个对象）
const input = {
  pitch: 0, yaw: 0, roll: 0, rudder: 0,
  throttleAxis: 0, throttleSet: -1,
  brake: false, ab: false, gear: true,
  fire: false, missile: false, flare: false, cat: false,
  torp: false, bomb: false
};
const keys = Object.create(null);
// 一次性武器意图的缓存（导弹 / 干扰弹），避免极短按键落在两次上行包之间被吞掉
const pending = { missile: 0, flare: 0, cat: 0, torp: 0 };

// =============================================================================
// === DOM =====================================================================
// =============================================================================
const el = (id) => document.getElementById(id);
const canvas = el('scene');
const hudCanvas = el('hud');
const hudCtx = hudCanvas.getContext('2d');
const domMenu = el('menu');
const domEnd = el('endcard');
const domName = el('nameInput');
const domJoin = el('joinBtn');
const domKill = el('killfeed');
const domCenter = el('centermsg');
const domBoard = el('board');
const domScore0 = el('score0');
const domScore1 = el('score1');
const domClock = el('clock');
const domTarget = el('target');
const domObjFill = el('objFill');
const domTouch = el('touch');
const domHelp = el('help');
const domHelpHint = el('helpHint');
const domHelpAir = el('helpAir');       // 飞机键位块
const domHelpShip = el('helpShip');     // 战舰键位块（上舰时切换）
const domHelpBomber = el('helpBomber'); // 轰炸机键位块（机种不同，投弹键也不同于战斗机）

// 帮助面板：开局显示十几秒，之后自动收起，按 H 随时开关
let helpTimer = 0;
// 三套操作互不重叠：舰船 / 战斗机 / 轰炸机。混着显示会让玩家按错键。
function updateHelpPanel() {
  const st = game.own && game.own.state;
  const ship = game.myShipId > 0;
  const bomber = !ship && !!(st && st.atype === 'bomber');
  if (domHelpAir) domHelpAir.classList.toggle('hidden', ship || bomber);
  if (domHelpShip) domHelpShip.classList.toggle('hidden', !ship);
  if (domHelpBomber) domHelpBomber.classList.toggle('hidden', !bomber);
}
function setHelp(on) {
  if (on) updateHelpPanel();
  domHelp.classList.toggle('hidden', !on);
  domHelpHint.classList.toggle('hidden', on);
}
function autoHideHelp() {
  clearTimeout(helpTimer);
  setHelp(true);
  helpTimer = setTimeout(() => setHelp(false), 16000);
}

// =============================================================================
// === 渲染器 / 场景 / 相机 ====================================================
// =============================================================================
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', alpha: false
});
renderer.setClearColor(COL.sky, 1);
if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
else if ('outputEncoding' in renderer && THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
// 色调映射交给后处理（场景先渲染到 HDR RT，ACES + 泛光在合成 pass 里做）。
// 如果这里也 tonemap 一次，画面会被压两遍，高光直接死白。
renderer.toneMapping = THREE.NoToneMapping;
renderer.info.autoReset = false;   // 每帧在 POSTFX 里 reset，统计包含所有后处理 pass
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COL.fog, CONFIG.render.fogNear, CONFIG.render.fogFar);

// ---- 程序化环境贴图（等距柱状天空 + 太阳光斑）----
// 给金属机身/座舱玻璃提供环境反射，纯靠方向光会显得像塑料
function buildEnvMap() {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.00, '#3f74b8');   // 天顶偏深
  grad.addColorStop(0.42, '#9fd0f0');
  grad.addColorStop(0.52, '#cfe4f2');   // 地平线附近发白
  grad.addColorStop(0.56, '#7c8b74');   // 地面
  grad.addColorStop(1.00, '#3a4230');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // 太阳光斑（位置与 SUN_DIR 大致对应：偏右上前方）
  const sx = W * 0.68, sy = H * 0.24;
  const sg = g.createRadialGradient(sx, sy, 0, sx, sy, W * 0.16);
  sg.addColorStop(0, 'rgba(255,252,240,1)');
  sg.addColorStop(0.25, 'rgba(255,238,205,0.65)');
  sg.addColorStop(1, 'rgba(255,235,200,0)');
  g.fillStyle = sg;
  g.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
const ENV_MAP = buildEnvMap();
scene.environment = ENV_MAP;

const camera = new THREE.PerspectiveCamera(CONFIG.view.fov, 1, CONFIG.view.near, CONFIG.view.far);
camera.position.set(-11800, 400, -2000);
scene.add(camera);

// HDR 后处理管线（泛光 / ACES / 太阳眩光 / 速度感 / G 力 / 颗粒）
// threshold 是「多亮的像素才发光」。原来写 0.92（小于 1！），等于整幅画面都在
// 泛光，天空、山体、海面全被糊上一层白光，对比度彻底没了。
// 真实相机只有高光（>1.0 的 HDR 值）才溢出，这里取 1.35。
const POSTFX = createPostFX(renderer, {
  exposure: 1.0,
  bloomStrength: 0.42,
  threshold: 1.35,
  knee: 0.50
});

// 座舱内构用「独立场景 + 独立近裁剪面」渲染：
// 主相机 near=1m 会让近处仪表台被整块裁掉，改窗口近面又会远处 z-fighting，
// 所以座舱单独一遍渲染（清深度不清颜色），近面 0.02m，仪表台可以贴到眼前。
const cpScene = new THREE.Scene();
cpScene.environment = ENV_MAP;
const cpCamera = new THREE.PerspectiveCamera(CONFIG.view.cockpitFov, 1, 0.02, 30);
cpCamera.position.set(0, 0, 0);
cpScene.add(cpCamera);

// 光照：太阳 + 半球环境 + 反向补光（狗斗时要能看清任何角度的敌机）
// 直射光与环境光的比例要控制住：太阳 3.1 时，背光的山面只剩环境光，
// ACES + 曝光 1.0 会把这点光直接压成纯黑（实测背光山坡像素是 0,0,0）。
// 真实世界里天光大约是直射光的 1/4~1/3，所以太阳降到 2.9、天光提到 0.95。
const sun = new THREE.DirectionalLight(0xfff2d6, 3.35);
sun.position.copy(SUN_DIR).multiplyScalar(10000);
sun.castShadow = true;
// 阴影只覆盖玩家周围 ~800m：km 级阴影贴图在网页端必然糊成一片，
// 近处飞机/机库/树有实打实的投影，远处交给雾和明暗关系。
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 4600;
sun.shadow.camera.left = -430;
sun.shadow.camera.right = 430;
sun.shadow.camera.top = 430;
sun.shadow.camera.bottom = -430;
sun.shadow.bias = -0.00032;
sun.shadow.normalBias = 1.1;
sun.shadow.radius = 2.2;
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);
scene.add(sun.target);
// hemi 与 scene.environment(IBL) 是背光面唯二的天光来源。
// 0.86 时实测远山只有 24~45/255，而同一帧的天空是 87 —— 地面比天空暗三倍多，
// 眼睛读到的就是「灰蒙蒙一层纱」。真实世界天光约为直射光的 1/4~1/3，
// 原来 0.86/2.9 = 30% 看着对，但那是没算 IBL 的；这里抬 hemi 是唯一安全解：
// 它只作用于吃光照的实体（地形/飞机/机场），天空穹顶是自发光 HDR 球壳、
// 云有自己的 uLight，都不会被带亮，所以抬它不会连太阳盘一起烤过头。
const hemi = new THREE.HemisphereLight(0xaec2d2, 0x6b7162, 1.58);
scene.add(hemi);
const amb = new THREE.AmbientLight(0x4a5a6c, 0.44);
scene.add(amb);
// 补光：从太阳反方向打一束冷光，避免敌机背光时变成黑剪影
const fill = new THREE.DirectionalLight(0x9db8d6, 0.38);
fill.position.copy(SUN_DIR).multiplyScalar(-6000);
fill.position.y = -3000;
scene.add(fill);

// =============================================================================
// === 天空穹顶（大气散射 + 程序化卷云，见 hd-sky.js）=========================
// =============================================================================
const SKY = createSky(SUN_DIR, {
  zenith: 0x1d57a4,
  horizon: COL.fog,
  ground: 0x53636b,
  sunColor: 0xfff0cf,
  cirrus: 0.85
});
const sky = SKY.mesh;
scene.add(sky);

// =============================================================================
// === 程序化地形 ==============================================================
// =============================================================================
const TERRAIN_NOISE_GLSL = `
float tnHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float tn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = tnHash(i);
  float b = tnHash(i + vec2(1.0, 0.0));
  float c = tnHash(i + vec2(0.0, 1.0));
  float d = tnHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

// 按高度分层着色：水下 / 沙滩 / 草地 / 岩石 / 雪
//
// ⚠️ 这里写的数值是 **sRGB 观感值**，下面 buildTerrain 会做 pow(c, 2.2) 转到线性空间。
// 之前反复「提亮 18%」却没有效果，就是因为提的是 sRGB 而不是线性 —— 换算后
// 草地线性反照率只有 0.071，比真实草地（0.12~0.22）暗一倍，甚至比 shader 里
// 手写的裸岩 rockCol=0.080 还暗，所以草地和岩石在画面上一样黑。
// 现在这一版的 sRGB 值是**从目标线性反照率反推**出来的（见 shots/alb2.js），
// 目标值取真实世界量级：草 0.14~0.20 / 针叶林 0.045~0.07 / 裸岩 0.07 / 雪 0.72~0.78。
// 另外把原来 260m / 760m / 900m 处的**硬跳变**改成了连续过渡：
// 原代码草地段末尾 0.300 直接跳到针叶林段开头 0.185，在山上刷出一条肉眼可见的
// 水平色带；现在每段的终点就是下一段的起点。
function heightColor(h, out) {
  let r, g, b;
  if (h < 0) { r = 0.169; g = 0.203; b = 0.256; }                 // 水下
  else if (h < 18) { r = 0.596; g = 0.551; b = 0.459; }           // 沙滩
  else if (h < 260) {                                             // 草甸：0.14 -> 0.18 线性
    const t = (h - 18) / 242;
    r = 0.409 + 0.050 * t; g = 0.447 + 0.034 * t; b = 0.335 + 0.046 * t;
  }
  else if (h < 760) {                                             // 针叶林坡：0.15 -> 0.055 线性
    const t = (h - 260) / 500;
    r = 0.420 - 0.152 * t; g = 0.446 - 0.147 * t; b = 0.352 - 0.126 * t;
  }
  else if (h < 900) {                                             // 林线以上裸岩/碎石：渐亮
    const t = (h - 760) / 140;
    r = 0.268 + 0.282 * t; g = 0.299 + 0.283 * t; b = 0.226 + 0.322 * t;
  }
  else {                                                          // 雪：0.61 -> 0.78 线性
    const t = Math.min(1, (h - 900) / 120);
    r = 0.550 + 0.311 * t; g = 0.582 + 0.295 * t; b = 0.548 + 0.345 * t;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

// 地形渲染网格的高度缓存（规则格点，索引 = iy*(seg+1)+ix）
let TERR_GRID = null, TERR_SEG = 0, TERR_STEP = 1, TERR_HALF = 0;

// 双线性采样「渲染出来的地表高度」。树、机场摆件、地面特效都应该用它，
// 而不是 terrainHeight() 的解析高度。
function meshHeightAt(x, z) {
  if (!TERR_GRID) return FP.terrainHeight(x, z);
  const g = TERR_SEG + 1;
  let fx = (x + TERR_HALF) / TERR_STEP;
  let fz = (z + TERR_HALF) / TERR_STEP;
  fx = fx < 0 ? 0 : (fx > TERR_SEG - 1e-4 ? TERR_SEG - 1e-4 : fx);
  fz = fz < 0 ? 0 : (fz > TERR_SEG - 1e-4 ? TERR_SEG - 1e-4 : fz);
  const ix = fx | 0, iz = fz | 0;
  const tx = fx - ix, tz = fz - iz;
  const i0 = iz * g + ix;
  const h00 = TERR_GRID[i0], h10 = TERR_GRID[i0 + 1];
  const h01 = TERR_GRID[i0 + g], h11 = TERR_GRID[i0 + g + 1];
  return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
}

// 该点的坡度（0=平地，1=垂直），同样取自渲染网格，避免解析高度与网格不一致
function meshSlopeAt(x, z) {
  const d = TERR_STEP * 0.5;
  const hx = meshHeightAt(x + d, z) - meshHeightAt(x - d, z);
  const hz = meshHeightAt(x, z + d) - meshHeightAt(x, z - d);
  const grad = Math.sqrt(hx * hx + hz * hz) / (2 * d);
  return grad / Math.sqrt(1 + grad * grad);     // sin(坡度角)
}

// 一次双线性采样同时给出高度和坡度（坡度用同一格的四个角点差分）。
// 分两次算的话每棵树要 5 次采样，铺 1.6 万棵就是 8 万次，肉眼可见地卡一下。
const _hsOut = [0, 0];
function meshHeightSlope(x, z) {
  if (!TERR_GRID) return _hsOut;
  const g = TERR_SEG + 1;
  let fx = (x + TERR_HALF) / TERR_STEP;
  let fz = (z + TERR_HALF) / TERR_STEP;
  fx = fx < 0 ? 0 : (fx > TERR_SEG - 1e-4 ? TERR_SEG - 1e-4 : fx);
  fz = fz < 0 ? 0 : (fz > TERR_SEG - 1e-4 ? TERR_SEG - 1e-4 : fz);
  const ix = fx | 0, iz = fz | 0;
  const tx = fx - ix, tz = fz - iz;
  const i0 = iz * g + ix;
  const h00 = TERR_GRID[i0], h10 = TERR_GRID[i0 + 1];
  const h01 = TERR_GRID[i0 + g], h11 = TERR_GRID[i0 + g + 1];
  _hsOut[0] = (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  const gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / TERR_STEP;
  const gz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / TERR_STEP;
  const grad = Math.sqrt(gx * gx + gz * gz);
  _hsOut[1] = grad / Math.sqrt(1 + grad * grad);
  return _hsOut;
}

function buildTerrain() {
  const seg = CONFIG.render.terrainSegments;
  const size = SIM.world.size;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const half = SIM.world.half;
  const edge = half * 0.925;          // 从 92.5% 处开始向海面下沉
  // 把渲染出来的顶点高度缓存成规则网格。
  // 树必须长在「渲染出来的地表」上，而不是 terrainHeight() 的真实高度：
  // 网格一格 109m，陡坡上两者的差能有二三十米，树按真实高度放就会被山体吞掉。
  TERR_GRID = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let y = FP.terrainHeight(x, z);
    // 海岸线用低频扰动弯曲，否则 32km 见方的地图会露出一条笔直的切边
    const wob = Math.sin(x * 0.00042 + 1.3) * 520 + Math.cos(z * 0.00037) * 640
      + Math.sin((x + z) * 0.00021) * 380;
    const edgeLocal = edge + wob;
    const d = Math.max(Math.abs(x), Math.abs(z));
    if (d > edgeLocal) {
      // 视觉上把地块边缘压到海面以下：远处看到的是海岸线而不是断崖。
      const t = clamp((half - d) / Math.max(1, half - edgeLocal), 0, 1);
      const k = t * t * (3 - 2 * t);
      y = y * k - (1 - k) * 60;
    }
    pos.setY(i, y);
    TERR_GRID[i] = y;
  }
  TERR_SEG = seg;
  TERR_STEP = size / seg;
  TERR_HALF = half;
  geo.computeVertexNormals();          // 平滑法线：山坡不再是硬邦邦的三角面
  const colors = new Float32Array(pos.count * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    heightColor(pos.getY(i), c);
    // 位置相关的细微色差（不是逐面随机），远看是植被/岩层的斑驳而不是马赛克
    const nx = pos.getX(i), nz = pos.getZ(i);
    const n = 0.92 + 0.16 * (((Math.sin(nx * 0.013) * 31.7 + Math.cos(nz * 0.011) * 17.3) % 1) + 1) % 1;
    // 这些高度色是按 sRGB 观感调的，顶点色属性是线性空间：
    // 不转直接喂给 PBR 会亮一大截，草地变成荧光绿。
    colors[i * 3] = Math.pow(clamp(c[0] * n, 0, 1), 2.2);
    colors[i * 3 + 1] = Math.pow(clamp(c[1] * n, 0, 1), 2.2);
    colors[i * 3 + 2] = Math.pow(clamp(c[2] * n, 0, 1), 2.2);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // PBR 地形：接收阴影 + 环境光，再叠一层世界坐标噪声当“植被/岩层”细节，
  // 否则 200m 一格的大三角面在低空看就是一块块纯色塑料。
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.97, metalness: 0.0,
    // 环境贴图（scene.environment 里那张晴朗天空 PMREM）是地表在「直射光打不到」
    // 的那一半能量来源。受控实验实测：envMapIntensity 0.30 -> 5.0 时陆地像素亮度
    // 从 35 涨到 63（+80%），是所有参数里杠杆最大的一项，而且它只影响吃光照的
    // 实体（地形/飞机/机场），完全不碰天空穹顶和云的 uLight —— 抬它不会把
    // 太阳盘和云顶高光一起烤过头。0.30 明显偏小，这里给到 0.95。
    envMapIntensity: 0.95
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vTerrW;\nvarying vec3 vNormalW;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTerrW = position;')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vNormalW = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = 'varying vec3 vTerrW;\nvarying vec3 vNormalW;\n' + TERRAIN_NOISE_GLSL + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // 地表细节分三层，频率都落在“几十米到几米”这个玩家真正看得见的尺度上。
      // 之前 312m 的低频占主导，100m 视距内几乎没有变化，草地就成了一块纯色地毯。
      float dFar  = tn(vTerrW.xz * 0.0034);            // ~300m 大地块
      float dMid  = tn(vTerrW.xz * 0.0165 + 11.0);     // ~60m 草甸
      float dNear = tn(vTerrW.xz * 0.072 + 23.0);      // ~14m 草丛团
      float dGrit = tn(vTerrW.xz * 0.34 + 5.0);        // ~3m 颗粒
      float detail = dFar * 0.18 + dMid * 0.26 + dNear * 0.30 + dGrit * 0.26;
      float nearFade = 1.0 - smoothstep(420.0, 3600.0, length(vViewPosition));
      float farFade = 1.0 - smoothstep(2500.0, 9000.0, length(vViewPosition));
      // 细节噪声只负责“起伏”，均值必须压在 1.0 以下：真实地表没有一块是纯白反照率。
      diffuseColor.rgb *= mix(0.94, 0.52 + 0.62 * detail, nearFade);

      // 干草 / 裸土斑块：只在近海平原出现。门限原来是 300m，结果 180m 的山脚
      // 被整片染成黄褐色（山看着像光秃的黄土坡），现在压到 60~230m。
      float lowLand = 1.0 - smoothstep(60.0, 230.0, vTerrW.y);
      float dryN = tn(vTerrW.xz * 0.0072 + 37.0) * 0.62 + tn(vTerrW.xz * 0.031 + 61.0) * 0.38;
      float dry = smoothstep(0.42, 0.70, dryN);
      diffuseColor.rgb = mix(diffuseColor.rgb,
        diffuseColor.rgb * vec3(1.55, 1.20, 0.64), dry * 0.46 * nearFade * lowLand);

      // 成片的深色灌木/林地（远处也能看出地貌差异）：可以上到林线附近
      float wood = smoothstep(0.56, 0.78, tn(vTerrW.xz * 0.0041 + 91.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.52, 0.64, 0.48),
        wood * mix(0.55, 0.30, farFade) * (1.0 - smoothstep(680.0, 860.0, vTerrW.y)));

      // 针叶林覆盖带：高频斑点当作树冠，远看就是粗糙的暗绿林相。
      // 没有这层，300~600m 的山坡就是一块光滑的绿绒布。
      // 起始高度从 200m 下探到 80m（山脚也要有林子），并且这个乘数**只压不抬**：
      // 原来写成 0.58+0.84*canopy，canopy 高时会把反照率抬到 1.42 倍，整座山被照亮。
      float forestBand = smoothstep(80.0, 240.0, vTerrW.y) * (1.0 - smoothstep(760.0, 900.0, vTerrW.y));
      float canopyFar = tn(vTerrW.xz * 0.085 + 3.0);
      float canopyNear = tn(vTerrW.xz * 0.26 + 7.0);
      float canopy = mix(canopyFar, canopyFar * 0.45 + canopyNear * 0.55, nearFade);
      // 不能只“压暗”：只压暗的话地面还是褐色的，看起来像刚烧过的荒地。
      // 必须真的混向林绿色（线性空间），整片山坡才读得出“树冠层”。
      // 三层频率：80m 的林斑 + 12m 的树冠团 + 3.8m 的枝叶颗粒，
      // 只有高频的话远看就是一片均匀绿，还是塑料。
      float forestPatch = tn(vTerrW.xz * 0.0122 + 17.0);
      vec3 forestCol = vec3(0.062, 0.088, 0.041)
                     * (0.62 + 0.70 * canopy)
                     * (0.72 + 0.58 * forestPatch);
      // 混合权重从 0.80 降到 0.62：0.80 时整座山被林色彻底盖住，
      // 下面的高程配色（草甸/裸岩/雪）一点也透不出来，远看就是一块深绿绒布。
      diffuseColor.rgb = mix(diffuseColor.rgb, forestCol, forestBand * 0.62);

      // 陡坡露出岩石（按世界法线的坡度判断），雪线以上保持雪
      // 岩石色必须又暗又中性：原来 0.115/0.105/0.092 是暖灰，一整面陡坡
      // 被刷成米黄色，远看像沙漠崖壁。真实裸岩反照率只有 4~6%。
      //
      // 门限是原来最大的坑：写成 smoothstep(0.50, 0.80, slope)，而 109m 一格
      // 的地形法线量级下实测全图坡度 p50=0.116 / p90=0.362 / p99=0.559，
      // 也就是只有 0.3% 的陆地够得着 —— 整座山因此没有任何岩石层次。
      // 现在改成「随海拔下移」的门限：低海拔要真陡坡才露岩（保住草甸），
      // 越接近林线以上门限越低（那里本来就是裸岩带，岩石遍地是常态）。
      float aboveTree = smoothstep(640.0, 860.0, vTerrW.y);   // 0=林线以下 1=林线以上
      float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
      float rockLo = mix(0.30, 0.17, aboveTree);
      float rockHi = mix(0.54, 0.36, aboveTree);
      // 再叠一层噪声打断 smoothstep 的均匀过渡带，否则整座山会出现一圈
      // 「等高线式」的岩石/植被分界，一眼假。
      float rockEdge = tn(vTerrW.xz * 0.0091 + 53.0) * 0.16 - 0.08;
      float rockMask = smoothstep(rockLo, rockHi, slope + rockEdge)
                     * (1.0 - smoothstep(880.0, 960.0, vTerrW.y));
      // 裸岩反照率抬到 ~8%：配色抬亮之后若岩石还压在 4.5%，陡坡会变成
      // 画面里唯一的黑洞，明暗反差反而更假。
      vec3 rockCol = vec3(0.080, 0.077, 0.072);
      diffuseColor.rgb = mix(diffuseColor.rgb, rockCol, rockMask * 0.82);
      // 岩层：用噪声代替正弦 —— 正弦会在地形上画出等间距横条，像等高线图
      float strata = tn(vTerrW.xz * 0.030 + vTerrW.y * 0.0055);
      strata = strata * 0.62 + tn(vTerrW.xz * 0.085 + vTerrW.y * 0.014) * 0.38;
      diffuseColor.rgb *= mix(1.0, 0.74 + 0.46 * strata, rockMask * 0.62);`
    ).replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      // 法线扰动（bump）：让山体表面有沟壑/起伏，而不是一整块光滑塑料。
      // 用噪声梯度近似高度场导数，成本比真正的高度图采样低得多。
      if (nearFade > 0.01) {
        vec2 pp = vTerrW.xz;
        float h0 = tn(pp * 0.028) * 0.62 + tn(pp * 0.095) * 0.38;
        float hx = tn((pp + vec2(1.1, 0.0)) * 0.028) * 0.62 + tn((pp + vec2(1.1, 0.0)) * 0.095) * 0.38;
        float hz = tn((pp + vec2(0.0, 1.1)) * 0.028) * 0.62 + tn((pp + vec2(0.0, 1.1)) * 0.095) * 0.38;
        vec3 bw = normalize(vec3(-(hx - h0) * 2.6, 1.0, -(hz - h0) * 2.6));
        vec3 bv = normalize((viewMatrix * vec4(bw, 0.0)).xyz);
        // 噪声是按世界 xz 平面投到斜坡上的，坡越陡拉伸越厉害，权重一大
        // 就会在山面上拉出一条条竖向的“雨痕”——远看尤其明显。
        // 所以坡度越大权重越小，并且 600m 之外就基本关掉。
        float bumpFade = 1.0 - smoothstep(600.0, 2400.0, length(vViewPosition));
        normal = normalize(mix(normal, bv, 0.42 * bumpFade * (1.0 - slope * 0.80)));
      }`
    );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
const terrainMesh = buildTerrain();

// =============================================================================
// === 海面（GPU 波浪 + 菲涅尔 + 太阳 glitter，见 hd-ocean.js）================
// =============================================================================
const OCEAN = createOcean({
  size: SIM.world.size * 1.45,
  segments: 256,
  sunDir: SUN_DIR,
  // 海水色刻意压暗、去饱和：原来 0x061c2a/0x0f4256 + 饱和蓝的 zenith 反射，
  // 整片海是一块艳蓝塑料。真实海面从 500m 看是「暗蓝灰」。
  deep: 0x05141d,
  shallow: 0x11404f,
  zenith: 0x2c66ab,
  horizon: COL.fog,
  fog: COL.fog,
  fogNear: CONFIG.render.fogNear,
  fogFar: CONFIG.render.fogFar
});
const seaMesh = OCEAN.mesh;
scene.add(seaMesh);

// 波浪完全在 GPU 上跑，CPU 每帧只需要推进时间与相机位置
function updateSea(t) {
  OCEAN.update(t, camera, seaMesh.position.x, seaMesh.position.z);
}

// =============================================================================
// === 云层（体积感 billboard 云团，见 hd-clouds.js）==========================
// =============================================================================
const CLOUDS = createClouds({
  count: CONFIG.render.cloudCount,
  puffsPer: 26,
  worldHalf: SIM.world.half * 0.98,
  sunDir: SUN_DIR,
  fog: COL.fog,
  fogNear: CONFIG.render.fogNear,
  fogFar: CONFIG.render.fogFar
});
const cloudMesh = CLOUDS.mesh;
scene.add(cloudMesh);
// 云团元数据给「穿云」判定用（白罩 / 闷响 / 颠簸）
for (const c of CLOUDS.clusters) game.clouds.push({ x: c.x, y: c.y, z: c.z, r: c.r, h: c.h });

// =============================================================================
// === 机场：跑道 / 标线 / 机库 / 塔台 ========================================
// =============================================================================
function flatRect(w, l, yaw) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2);
  g.rotateY(yaw);
  return g;
}
function addFlat(group, geo, color, x, y, z, opacity) {
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.2,
    transparent: opacity !== undefined, opacity: opacity === undefined ? 1 : opacity
  }));
  m.position.set(x, y, z);
  group.add(m);
  return m;
}

// 跑道贴图：把中线、门槛斑马线、接地区、跑道号一次性画进 canvas，
// 整条跑道只占 1 个 draw call（原来 40 多个小方块，帧率杀手）
function makeRunwayTexture(ap) {
  const W = 384, H = 6144;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // 沥青底色 + 细噪点（#3f444a 太黑，实机看整条跑道是一道黑带，标线全浮在上面）
  g.fillStyle = '#4b5057';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 34000; i++) {
    const v = 52 + Math.random() * 40;
    g.fillStyle = 'rgba(' + v + ',' + (v + 3) + ',' + (v + 6) + ',0.55)';
    g.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  // 接地区轮胎印
  g.fillStyle = 'rgba(18,20,22,0.30)';
  for (let i = 0; i < 80; i++) {
    const y = H * (0.12 + Math.random() * 0.12) + (Math.random() < 0.5 ? H * 0.64 : 0);
    g.fillRect(W * (0.18 + Math.random() * 0.6), y, 2 + Math.random() * 4, 26 + Math.random() * 60);
  }

  const white = '#e6e6da';
  // 边线
  g.fillStyle = white;
  g.fillRect(W * 0.055, H * 0.03, 3, H * 0.94);
  g.fillRect(W * 0.925, H * 0.03, 3, H * 0.94);
  // 中线虚线
  for (let y = H * 0.09; y < H * 0.91; y += 74) {
    g.fillRect(W * 0.492, y, 5, 42);
  }
  // 两端门槛斑马线（8 条）
  for (const end of [0, 1]) {
    const base = end === 0 ? H * 0.055 : H * 0.895;
    for (let i = 0; i < 4; i++) {
      const bw = W * 0.055;
      const x1 = W * 0.14 + i * W * 0.105;
      g.fillRect(x1, base, bw, 46);
      g.fillRect(W - x1 - bw, base, bw, 46);
    }
  }
  // 接地区标志（两侧成对短杠）
  for (const end of [0, 1]) {
    for (let k = 0; k < 3; k++) {
      const y = end === 0 ? H * (0.15 + k * 0.055) : H * (0.79 - k * 0.055);
      for (const s of [0.24, 0.68]) {
        g.fillRect(W * s, y, W * 0.08, 7);
      }
    }
  }
  // 跑道号（两端各一个，朝进近方向）
  g.fillStyle = white;
  g.font = 'bold 74px "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const num = (hdg) => {
    let n = Math.round(hdg / 10);
    if (n === 0) n = 36;
    return String(n).padStart(2, '0');
  };
  const h1 = ((Math.atan2(ap.hx, -ap.hz) * 180 / Math.PI) + 360) % 360;
  const h2 = (h1 + 180) % 360;
  g.save();
  g.translate(W / 2, H * 0.115);
  g.fillText(num(h1), 0, 0);
  g.restore();
  g.save();
  g.translate(W / 2, H * 0.885);
  g.rotate(Math.PI);
  g.fillText(num(h2), 0, 0);
  g.restore();

  const tex = new THREE.CanvasTexture(cv);
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// 机库墙面：波纹钢板 + 搭接缝 + 锈迹 + 底部溅泥。
// 原来是一块 MeshLambertMaterial 纯色，太阳一照直接烧成一个白盒子。
function makeHangarMaterial(baseY) {
  const m = new THREE.MeshStandardMaterial({
    // metalness 必须低：网页端没有环境贴图，金属度一高 diffuse 就被吃掉，
    // 只剩半球光的天空色反射 —— 机库会整栋变成蓝色塑料。
    color: 0xa8a394, roughness: 0.70, metalness: 0.06, envMapIntensity: 0.28
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBase = { value: baseY };
    sh.vertexShader = 'varying vec3 vHW;\nvarying vec3 vHWN;\n' + sh.vertexShader
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vHW = (modelMatrix * vec4(position, 1.0)).xyz;')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vHWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = 'uniform float uBase;\nvarying vec3 vHW;\nvarying vec3 vHWN;\n'
      + TERRAIN_NOISE_GLSL + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec3 hn = normalize(vHWN);
      float yl = vHW.y - uBase;
      // 竖向波纹钢板：沿墙面水平方向做正弦；屋顶（法线朝上）沿进深方向
      float u = abs(hn.y) > 0.60 ? vHW.z : (abs(hn.x) > abs(hn.z) ? vHW.z : vHW.x);
      float rib = 0.5 + 0.5 * sin(u * 5.6);
      float shade = 0.78 + 0.34 * rib;
      // 横向搭接缝（每 2m 一道）
      shade *= 1.0 - smoothstep(0.955, 1.0, fract(yl * 0.50)) * 0.26;

      // 锈迹：成片出现，靠下更重（雨水积聚）
      float rustN = tn(vHW.xz * 0.24 + yl * 0.17);
      float rust = smoothstep(0.58, 0.85, rustN) * smoothstep(15.0, 1.5, yl);
      vec3 c = diffuseColor.rgb * shade;
      c = mix(c, vec3(0.185, 0.088, 0.042), rust * 0.70);

      // 底部溅泥 + 屋顶被晒得发白
      c = mix(c, vec3(0.15, 0.13, 0.10), smoothstep(5.0, 0.0, yl) * 0.55);
      c *= 1.0 + smoothstep(19.0, 22.0, yl) * 0.12;
      diffuseColor.rgb = c;`
    );
  };
  return m;
}

// 机库卷帘门：横向条带 + 观察窗 + 底部污渍 + 编号
// 停机坪混凝土：板缝 + 裂缝 + 油渍 + 轮胎印。
// 纯色平面在近处就是一块灰塑料，起降时正对着看特别假。
function makeApronTexture() {
  const S = 512;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  g.fillStyle = '#4d535a';
  g.fillRect(0, 0, S, S);

  // 骨料颗粒
  for (let i = 0; i < 14000; i++) {
    const v = 52 + Math.random() * 40;
    g.fillStyle = 'rgba(' + v + ',' + (v + 2) + ',' + (v + 5) + ',' + (0.20 + Math.random() * 0.35) + ')';
    g.fillRect(Math.random() * S, Math.random() * S, 1.6, 1.6);
  }

  // 混凝土板缝（每块约 5m）
  g.strokeStyle = 'rgba(28,32,36,0.55)';
  g.lineWidth = 2.2;
  for (let i = 0; i <= 8; i++) {
    const p = i * S / 8;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
  g.strokeStyle = 'rgba(190,198,206,0.10)';
  g.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = i * S / 8 + 2;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }

  // 裂缝
  g.strokeStyle = 'rgba(20,24,28,0.42)';
  g.lineWidth = 1.2;
  for (let i = 0; i < 16; i++) {
    let x = Math.random() * S, y = Math.random() * S;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (Math.random() - 0.5) * 46;
      y += (Math.random() - 0.5) * 46;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // 油渍（深色不规则斑）
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 8 + Math.random() * 34;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(16,18,20,0.34)');
    rg.addColorStop(0.7, 'rgba(16,18,20,0.12)');
    rg.addColorStop(1, 'rgba(16,18,20,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 轮胎印（沿一个方向的短条）
  g.fillStyle = 'rgba(24,26,28,0.18)';
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    g.fillRect(x, y, 2 + Math.random() * 5, 10 + Math.random() * 40);
  }

  const t = new THREE.CanvasTexture(cv);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function makeHangarDoorTexture(label) {
  const W = 256, H = 256;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#5a6169';
  g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 8) {
    g.fillStyle = 'rgba(255,255,255,0.085)';
    g.fillRect(0, y, W, 2);
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.fillRect(0, y + 5, W, 2);
  }
  // 观察窗
  g.fillStyle = 'rgba(18,26,32,0.85)';
  g.fillRect(W * 0.16, H * 0.22, W * 0.20, H * 0.10);
  g.fillRect(W * 0.64, H * 0.22, W * 0.20, H * 0.10);
  // 底部泥污
  const dg = g.createLinearGradient(0, H, 0, H * 0.62);
  dg.addColorStop(0, 'rgba(26,22,16,0.75)');
  dg.addColorStop(1, 'rgba(26,22,16,0)');
  g.fillStyle = dg;
  g.fillRect(0, H * 0.62, W, H * 0.38);
  // 编号
  g.font = 'bold 46px "Segoe UI", Arial, sans-serif';
  g.fillStyle = 'rgba(226,232,238,0.62)';
  g.textAlign = 'center';
  g.fillText(label, W / 2, H * 0.52);

  const t = new THREE.CanvasTexture(cv);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function buildAirport(ap) {
  const g = new THREE.Group();
  const yaw = Math.atan2(-ap.hx, -ap.hz);
  const y = ap.elev + 0.45;

  // 跑道（单网格 + 贴图）
  const rwGeo = new THREE.PlaneGeometry(ap.wid, ap.len);
  rwGeo.rotateX(-Math.PI / 2);
  rwGeo.rotateY(yaw);
  const rw = new THREE.Mesh(rwGeo, new THREE.MeshStandardMaterial({
    map: makeRunwayTexture(ap), roughness: 0.88, metalness: 0.0, envMapIntensity: 0.25
  }));
  rw.position.set(ap.x, y, ap.z);
  g.add(rw);

  // 停机坪
  const apron = flatRect(240, 760, yaw);
  const apx = ap.x + ap.hx * -330 + ap.rx * 255;
  const apz = ap.z + ap.hz * -330 + ap.rz * 255;
  const apronTex = makeApronTexture();
  apronTex.repeat.set(6, 19);
  const apronMesh = new THREE.Mesh(apron, new THREE.MeshStandardMaterial({
    map: apronTex, color: 0xb9bfc6, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.18
  }));
  apronMesh.position.set(apx, y - 0.03, apz);
  g.add(apronMesh);

  // 机库（波纹钢板机身 + 半圆屋顶 + 卷帘门）
  const hangarMat = makeHangarMaterial(ap.elev);
  const doorMat = new THREE.MeshStandardMaterial({
    map: makeHangarDoorTexture(ap.name === 'B' ? 'B-02' : 'A-01'),
    roughness: 0.80, metalness: 0.02, envMapIntensity: 0.25
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x2f353c, roughness: 0.82, metalness: 0.35, envMapIntensity: 0.3
  });
  for (let i = 0; i < 3; i++) {
    const along = -560 + i * 220;
    const px = ap.x + ap.hx * along + ap.rx * 300;
    const pz = ap.z + ap.hz * along + ap.rz * 300;
    const hg = new THREE.Group();
    hg.position.set(px, ap.elev, pz);
    hg.rotation.y = yaw;

    const body = new THREE.Mesh(new THREE.BoxGeometry(70, 22, 90), hangarMat);
    body.position.y = 11;
    hg.add(body);

    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(36, 36, 92, 16, 1, false, 0, Math.PI), hangarMat);
    roof.rotation.z = Math.PI / 2;
    roof.position.y = 22;
    hg.add(roof);

    // 卷帘门朝跑道一侧（局部 -x）
    const door = new THREE.Mesh(new THREE.PlaneGeometry(54, 16), doorMat);
    door.position.set(-35.06, 8, 0);
    door.rotation.y = -Math.PI / 2;
    hg.add(door);
    // 门框
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 58), frameMat);
    lintel.position.set(-35.2, 17.2, 0);
    hg.add(lintel);
    for (const dz of [-28, 28]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(1.2, 17, 2.2), frameMat);
      jamb.position.set(-35.2, 8.5, dz);
      hg.add(jamb);
    }
    g.add(hg);
  }

  // 塔台
  const tpx = ap.x + ap.hx * 120 + ap.rx * -190;
  const tpz = ap.z + ap.hz * 120 + ap.rz * -190;
  const towerMat = new THREE.MeshStandardMaterial({
    color: 0xa8a294, roughness: 0.90, metalness: 0.02, envMapIntensity: 0.14, flatShading: true
  });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(9, 13, 46, 8), towerMat);
  tower.position.set(tpx, ap.elev + 23, tpz);
  g.add(tower);
  // 塔台下方的附属楼（真实塔台不会是一根孤零零的柱子）
  const annex = new THREE.Mesh(new THREE.BoxGeometry(34, 9, 24), towerMat);
  annex.position.set(tpx + ap.rx * -26, ap.elev + 4.5, tpz + ap.rz * -26);
  annex.rotation.y = yaw;
  g.add(annex);

  const cab = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 10, 8), towerMat);
  cab.position.set(tpx, ap.elev + 50, tpz);
  g.add(cab);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(15.4, 15.4, 6.4, 8),
    new THREE.MeshStandardMaterial({
      color: 0x24404f, roughness: 0.06, metalness: 0.55,
      transparent: true, opacity: 0.72, envMapIntensity: 1.5
    }));
  glass.position.set(tpx, ap.elev + 50, tpz);
  g.add(glass);
  // 塔顶平台 + 天线 + 障碍灯
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(15.8, 15.8, 1.2, 8), towerMat);
  cap.position.set(tpx, ap.elev + 55.6, tpz);
  g.add(cap);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 14, 6),
    new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.7 }));
  mast.position.set(tpx, ap.elev + 63, tpz);
  g.add(mast);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
  beacon.position.set(tpx, ap.elev + 70.2, tpz);
  g.add(beacon);
  game.beacons.push(beacon);

  // 跑道边灯：InstancedMesh（1 个 draw call）
  const nLight = 2 * (Math.floor(ap.len / 60) + 1);
  const lightGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xb0a179 });
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, nLight);
  const m4 = new THREE.Matrix4();
  let li = 0;
  for (let i = 0; i <= Math.floor(ap.len / 60); i++) {
    const along = -ap.len / 2 + i * 60;
    for (const s of [-1, 1]) {
      const lat = s * (ap.wid / 2 + 7);
      m4.makeTranslation(
        ap.x + ap.hx * along + ap.rx * lat,
        ap.elev + 1.2,
        ap.z + ap.hz * along + ap.rz * lat
      );
      lights.setMatrixAt(li++, m4);
    }
  }
  lights.instanceMatrix.needsUpdate = true;
  lights.frustumCulled = false;
  g.add(lights);
  // 机库/塔台投影到跑道与停机坪上（阴影相机只覆盖近距，正好覆盖起降航线）
  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  // 进近灯（两端各 6 个，帮助夜航/低能见进近找到跑道）
  const appGeo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  const appMat = new THREE.MeshBasicMaterial({ color: 0xbfe9ff });
  const apps = new THREE.InstancedMesh(appGeo, appMat, 12);
  let ai = 0;
  for (const end of [-1, 1]) {
    for (let k = 1; k <= 6; k++) {
      const along = end * (ap.len / 2 + k * 70);
      m4.makeTranslation(
        ap.x + ap.hx * along,
        ap.elev + 1.2 + k * 0.4,
        ap.z + ap.hz * along
      );
      apps.setMatrixAt(ai++, m4);
    }
  }
  apps.instanceMatrix.needsUpdate = true;
  apps.frustumCulled = false;
  g.add(apps);

  scene.add(g);
  return g;
}
for (const ap of FP.AIRPORTS) buildAirport(ap);

// === 航空母舰 ×2：舰体 / 飞行甲板 / 舰岛 / 阻拦索 / 弹射器 ====================
// 每队一艘，位置取 FP.CARRIERS[team]。舰体局部坐标沿 +z 为舰艉方向、
// -z 为舰艏方向（与 hx/hz 轴线约定一致），最后整组旋转到该舰的实际朝向。
function buildCarrier(cv) {
  const C = cv || FP.CARRIER;
  const g = new THREE.Group();
  const DECK_Y = C.y;

  const steel = (col, rough, metal) => new THREE.MeshStandardMaterial({
    color: col, roughness: rough === undefined ? 0.85 : rough,
    metalness: metal === undefined ? 0.15 : metal, envMapIntensity: 0.45
  });

  // ---- 舰体：吃水线以下的船身（上宽下窄的棱柱）----
  const hullShape = new THREE.Shape();
  const L = C.len * 0.5, Wd = C.wid * 0.5;
  hullShape.moveTo(-Wd * 0.72, -L);
  hullShape.lineTo(Wd * 0.72, -L);
  hullShape.lineTo(Wd, L * 0.62);
  hullShape.lineTo(Wd * 0.82, L);
  hullShape.lineTo(-Wd * 0.82, L);
  hullShape.lineTo(-Wd, L * 0.62);
  hullShape.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: DECK_Y + 9, bevelEnabled: false });
  hullGeo.rotateX(-Math.PI / 2);
  const hull = new THREE.Mesh(hullGeo, steel(0x4a5057, 0.82, 0.25));
  hull.position.y = -9;
  hull.castShadow = true; hull.receiveShadow = true;
  g.add(hull);

  // ---- 飞行甲板：主甲板（灰黑防滑涂层）----
  const deckMat = steel(0x3b4046, 0.94, 0.08);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(C.wid, 1.6, C.len), deckMat);
  deck.position.y = DECK_Y - 0.8;
  deck.receiveShadow = true;
  g.add(deck);

  // ---- 斜角甲板（降落跑道，偏转 9°）----
  const ang = C.angle;
  const angled = new THREE.Mesh(
    new THREE.BoxGeometry(C.wid * 0.42, 0.7, C.deckLen),
    steel(0x34393f, 0.95, 0.06)
  );
  angled.position.set(-C.wid * 0.14, DECK_Y + 0.15, C.len * 0.06);
  angled.rotation.y = ang;
  angled.receiveShadow = true;
  g.add(angled);

  // ---- 跑道中线虚线（斜角甲板）----
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xd8d2c0, transparent: true, opacity: 0.55 });
  const dashN = 22;
  for (let i = 0; i < dashN; i++) {
    const t = (i / (dashN - 1) - 0.5) * (C.deckLen * 0.86);
    const d = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 7), dashMat);
    d.rotation.x = -Math.PI / 2;
    d.rotation.z = ang;
    d.position.set(
      -C.wid * 0.14 + Math.sin(ang) * t,
      DECK_Y + 0.55,
      C.len * 0.06 - Math.cos(ang) * t
    );
    g.add(d);
  }

  // ---- 甲板边缘的白/黄边线 ----
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xe8e4d4, transparent: true, opacity: 0.45 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.PlaneGeometry(2.2, C.len * 0.94), edgeMat);
    e.rotation.x = -Math.PI / 2;
    e.position.set(s * (C.wid * 0.5 - 2), DECK_Y + 0.5, 0);
    g.add(e);
  }

  // ---- 阻拦索：三根横跨甲板的钢索（细圆柱 + 两端支柱）----
  const wireGroup = new THREE.Group();
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9, envMapIntensity: 0.8 });
  C.wireZ.forEach((wz, i) => {
    const span = C.wid * 0.34;
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, span * 2, 8), wireMat);
    w.rotation.z = Math.PI / 2;
    // 阻拦索按斜角甲板方向横置
    w.position.set(-C.wid * 0.14 + Math.sin(ang) * (wz - C.len * 0.06), DECK_Y + 0.55,
      wz);
    w.rotation.y = ang;
    wireGroup.add(w);
    // 两端支柱
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 1.6, 6), wireMat);
      post.position.set(
        -C.wid * 0.14 + Math.sin(ang) * (wz - C.len * 0.06) + s * Math.cos(ang) * span,
        DECK_Y + 0.7,
        wz - s * Math.sin(ang) * span
      );
      wireGroup.add(post);
    }
  });
  g.add(wireGroup);

  // ---- 弹射器轨道（舰艏两条蒸汽弹射槽）----
  const catMat = new THREE.MeshBasicMaterial({ color: 0x6d6a60, transparent: true, opacity: 0.7 });
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.PlaneGeometry(1.5, C.catapultLen + 30), catMat);
    rail.rotation.x = -Math.PI / 2;
    rail.position.set(s * 13, DECK_Y + 0.52, C.catZ - (C.catapultLen + 30) * 0.5);
    g.add(rail);
  }

  // ---- 舰岛（右舷，含雷达桅杆与烟囱）----
  const isl = new THREE.Group();
  const islX = C.wid * 0.30, islZ = C.len * 0.16;
  const islBody = new THREE.Mesh(new THREE.BoxGeometry(15, 17, 46), steel(0x555b62, 0.8, 0.2));
  islBody.position.set(islX, DECK_Y + 8.5, islZ);
  islBody.castShadow = true;
  isl.add(islBody);
  // 舰桥窗带
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1b2630, roughness: 0.25, metalness: 0.6, envMapIntensity: 0.9 });
  const win = new THREE.Mesh(new THREE.BoxGeometry(15.3, 2.4, 40), winMat);
  win.position.set(islX, DECK_Y + 14.5, islZ);
  isl.add(win);
  // 桅杆 + 旋转雷达
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 22, 6), steel(0x8d949c, 0.5, 0.8));
  mast.position.set(islX, DECK_Y + 27, islZ - 8);
  isl.add(mast);
  const radarMat = new THREE.MeshStandardMaterial({ color: 0x2e3439, roughness: 0.6, metalness: 0.5 });
  const radar = new THREE.Mesh(new THREE.BoxGeometry(11, 2.6, 1.2), radarMat);
  radar.position.set(islX, DECK_Y + 36, islZ - 8);
  isl.add(radar);
  // 烟囱
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 13), steel(0x44494f, 0.9, 0.15));
  funnel.position.set(islX, DECK_Y + 21, islZ + 16);
  isl.add(funnel);
  g.add(isl);

  // ---- 甲板停机标线（斜角甲板外侧的停机区）----
  const parkMat = new THREE.MeshBasicMaterial({ color: 0xb8b2a2, transparent: true, opacity: 0.28 });
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.2), parkMat);
    p.rotation.x = -Math.PI / 2;
    p.position.set(-C.wid * 0.30, DECK_Y + 0.52, -C.len * 0.22 + i * 26);
    g.add(p);
  }

  // ---- 航行尾迹（静态贴片，靠材质动画太贵；这里用两条淡色长条示意）----
  const wakeMat = new THREE.MeshBasicMaterial({
    color: 0xdff0ff, transparent: true, opacity: 0.10, depthWrite: false
  });
  for (const s of [-1, 1]) {
    const wk = new THREE.Mesh(new THREE.PlaneGeometry(16, C.len * 1.6), wakeMat);
    wk.rotation.x = -Math.PI / 2;
    wk.position.set(s * C.wid * 0.42, 0.6, C.len * 0.9);
    g.add(wk);
  }

  // 整组落到舰位，并绕 Y 轴转到该舰的实际甲板朝向。
  // 局部坐标里甲板轴是 +z（along 正方向 = 舰艉侧），世界轴向是 (hx,hz)，
  // 所以旋转角 = atan2(hx, hz)。这样舰艏（局部 -z）正好指向 -h 方向。
  g.position.set(C.x, 0, C.z);
  g.rotation.y = Math.atan2(C.hx, C.hz);
  scene.add(g);
  return { group: g, radar, wireGroup, cv: C };
}
// 每队一艘：CV_MESH[team]
const CV_MESH = [buildCarrier(FP.CARRIERS[0]), buildCarrier(FP.CARRIERS[1])];
const CARRIER_MESH = CV_MESH[0];        // 兼容旧引用（蓝队舰）

// === 战舰模型：舰体 / 上层建筑 / 主炮塔 / 副炮 / 防空 / 鱼雷管 ================
// 局部坐标系：舰艏朝 -z，舰艉 +z，右舷 +x（与飞机/航母同向约定）。
// 放置时 group.rotation.y = heading，舰艏就指向舰船的 forward。
// 三舰种共用一套构建器，用舰种参数控制比例与细节等级。
// ---------------------------------------------------------------------------
// 程序化材质纹理（不加载外部图片，纯 canvas 生成）
//   木甲板：横向柚木条 + 色差 + 缝线
//   舰体：钢板拼缝 + 水渍流痕
// 贴图是中性灰度的乘法层，只加明暗变化，不改色相。
// ---------------------------------------------------------------------------
function makeDeckTexture(isDD) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d');
  if (isDD) {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, S, S);
    c.strokeStyle = 'rgba(0,0,0,0.10)'; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      c.beginPath(); c.moveTo(0, i * S / 4); c.lineTo(S, i * S / 4); c.stroke();
      c.beginPath(); c.moveTo(i * S / 4, 0); c.lineTo(i * S / 4, S); c.stroke();
    }
    for (let i = 0; i < 60; i++) {
      c.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.04).toFixed(3) + ')';
      c.fillRect(Math.random() * S, Math.random() * S, 6 + Math.random() * 20, 3);
    }
  } else {
    // 柚木甲板：竖条纹 —— UV 的 u 是船宽、v 是船长，
    // 木板要顺着船长铺，所以条纹沿 v（画布 y）方向延伸。
    const plank = 10;
    for (let x = 0; x < S; x += plank) {
      const v = 0.88 + Math.random() * 0.20;
      c.fillStyle = 'rgb(' + Math.round(255 * v) + ',' + Math.round(252 * v) + ',' + Math.round(246 * v) + ')';
      c.fillRect(x, 0, plank - 1, S);
      c.fillStyle = 'rgba(0,0,0,0.24)';
      c.fillRect(x + plank - 1, 0, 1, S);
      // 木纹（沿板长方向的细线）
      for (let k = 0; k < 5; k++) {
        c.fillStyle = 'rgba(0,0,0,' + (0.02 + Math.random() * 0.05).toFixed(3) + ')';
        c.fillRect(x + 1 + Math.random() * (plank - 3), Math.random() * S, 1, 24 + Math.random() * 70);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHullTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#ececec'; c.fillRect(0, 0, S, S);
  // 钢板拼缝（竖缝 + 横缝）
  c.strokeStyle = 'rgba(0,0,0,0.34)'; c.lineWidth = 1.8;
  // 竖缝只留 3 条：8 条在舭部斜面上会被投影成一组交叉斜线，
  // 远看像编织袋。横缝交给 repeat 沿船长铺（间距约 10m）。
  for (let i = 0; i <= 3; i++) {
    c.beginPath(); c.moveTo(i * S / 3, 0); c.lineTo(i * S / 3, S); c.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    c.beginPath(); c.moveTo(0, i * S / 6); c.lineTo(S, i * S / 6); c.stroke();
  }
  // 水渍/锈痕：竖向长条，靠上淡
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S;
    const w = 2 + Math.random() * 7;
    const h = 30 + Math.random() * 140;
    const y = Math.random() * S;
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(70,60,50,0.00)');
    g.addColorStop(0.4, 'rgba(58,48,38,' + (0.10 + Math.random() * 0.14).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(70,60,50,0.00)');
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
  }
  // 大块明暗不均（漆面老化）
  for (let i = 0; i < 8; i++) {
    c.fillStyle = 'rgba(0,0,0,' + (0.05 + Math.random() * 0.07).toFixed(3) + ')';
    c.fillRect(Math.random() * S, Math.random() * S, 40 + Math.random() * 90, 20 + Math.random() * 50);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWarship(T) {
  const g = new THREE.Group();
  const L = T.len, B = T.beam, FB = T.freeboard, DR = T.draft;
  const hl = L * 0.5, hb = B * 0.5;
  const ty = T.type || T.id;          // 舰种标识（数据里两个字段都有，取其一）
  const isBB = ty === 'bb', isCA = ty === 'ca', isDD = ty === 'dd';

  // ===========================================================================
  // 材质：军舰是哑光防锈漆，metalness 必须很低（无环境贴图时高金属度会吃成黑块）
  // ===========================================================================
  const mkMat = (c, rough, metal, emi) => {
    const col = new THREE.Color(c);
    const m = new THREE.MeshStandardMaterial({
      color: col, roughness: rough === undefined ? 0.78 : rough,
      metalness: metal === undefined ? 0.06 : metal, envMapIntensity: 0.32
    });
    // 环境底光：渲染器是 NoToneMapping、只有一盏 3.35 的平行光，
    // 背光舷侧拿不到足够的天光就会压成黑块（另一侧又过曝成白）。
    // emissive 是纯加法，只抬暗部、不动高光，是这种情况下唯一干净的补法。
    if (emi !== 0) {
      m.emissive = col.clone().multiplyScalar(emi === undefined ? 0.34 : emi);
      m.emissiveIntensity = 1;
    }
    return m;
  };
  // ⚠️ 反照率必须按光照强度反推。
  // 渲染器是 NoToneMapping（高光不做压缩），太阳强度 3.35，
  // 所以 albedo 超过 ~0.30 的材质在阳光直射下会直接削顶成纯白。
  // 之前干舷写死 0x8d969d（0.55）—— 截图里整条船白成一块塑料板就是这么来的。
  // 现在从舰种配色取基色再乘 0.66，阳光面大约落在 0.75，暗面靠天光抬起。
  const hullBase = new THREE.Color((T.color && T.color.hull) || 0x5a6778).multiplyScalar(0.90);
  const cHull = hullBase.clone();               // 干舷灰
  const cBoot = new THREE.Color(0x141a1e);      // 水线漆（黑）
  const cBottom = new THREE.Color(0x25313c);    // 水下防污漆
  const texHull = makeHullTexture();
  texHull.repeat.set(1, 24);                 // 沿舰长重复 24 次：钢板缝间距约 10m（太密像瓦楞纸）
  const matHull = new THREE.MeshStandardMaterial({
    vertexColors: true, map: texHull, roughness: 0.76, metalness: 0.05,
    envMapIntensity: 0.32, side: THREE.DoubleSide,
    // 顶点色材质不能靠 color 抬底光，emissive 用基色的一半
    emissive: hullBase.clone().multiplyScalar(0.30), emissiveIntensity: 1
  });
  const texDeck = makeDeckTexture(isDD);
  texDeck.repeat.set(4, isDD ? 26 : 34);     // 木条沿舰长方向长条铺设
  // 灰阶层次：舰体最亮 → 舷墙/上层建筑略暗 → 炮塔更暗 → 炮管最深。
  // 统一色相（偏冷灰蓝），只靠明度分层，这样远看是"一艘灰船"而不是"彩色补丁"。
  const deckColor = isDD ? 0x4a525a : 0x5b4a37;         // 驱逐舰钢甲板 / 主力舰柚木甲板（压暗，和舰体拉开）
  const matDeck = new THREE.MeshStandardMaterial({
    map: texDeck, color: deckColor, roughness: 0.92, metalness: 0.02, envMapIntensity: 0.25
  });
  // 明度阶梯（同一色相）：上层建筑最亮（刷白漆）→ 炮塔 → 舷墙 → 舰体 → 炮管最深
  const matSuper = mkMat(hullBase.clone().multiplyScalar(1.18), 0.76, 0.05);
  const matTurret = mkMat(hullBase.clone().multiplyScalar(1.06), 0.70, 0.07);
  const matBarrel = mkMat(hullBase.clone().multiplyScalar(0.46), 0.52, 0.20);
  const matDark = mkMat(0x1d2329, 0.82, 0.06);
  const matGlass = new THREE.MeshStandardMaterial({
    color: 0x16242e, roughness: 0.14, metalness: 0.62, envMapIntensity: 1.1
  });
  const matRail = new THREE.LineBasicMaterial({ color: 0x394047, transparent: true, opacity: 0.8 });
  const matHullWall = mkMat(hullBase.clone().multiplyScalar(0.92), 0.78, 0.04);   // 舷墙：略暗于舰体，形成水沟阴影

  // ===========================================================================
  // 1. 舰体：横剖面放样（这是"像船"的关键）
  //    ExtrudeGeometry 只能挤出等截面，做出来必然是"平底驳船"。
  //    真实舰体有三件东西：舰艏前倾、舷弧（sheer，甲板线中低艏艉高）、舷侧外飘（flare）。
  // ===========================================================================
  const tableLerp = (tbl, t) => {
    if (t <= tbl[0][0]) return tbl[0][1];
    for (let i = 1; i < tbl.length; i++) {
      if (t <= tbl[i][0]) {
        const a = tbl[i - 1], b = tbl[i];
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        const s = k * k * (3 - 2 * k);
        return a[1] + (b[1] - a[1]) * s;
      }
    }
    return tbl[tbl.length - 1][1];
  };
  // 半宽（占最大半宽的比例）：艏部细长、中段平行、艉部保持"方尾"再垂直切断
  // （收成尖角会立刻变成"木船"）
  const tblW = [[0, 0.03], [0.05, 0.28], [0.12, 0.60], [0.22, 0.85], [0.34, 0.96],
    [0.52, 1.0], [0.76, 1.0], [0.90, 0.97], [0.965, 0.93], [1, 0.90]];
  // 舷弧（占干舷的比例）：舰艏抬高最多，中段最低
  // 舷弧：艏部抬得更陡（0 → 4% 舰长就抬 2.5m），侧视才有一条前倾的艏柱曲线。
  // 原来 7% 舰长只抬 1.4m，侧面看舰艏就是一条竖直的方块。
  const tblS = [[0, 1.62], [0.04, 1.36], [0.10, 1.20], [0.22, 1.08], [0.44, 1.00], [0.78, 0.99], [1, 0.93]];
  // 龙骨线（占吃水的比例）：艏艉上翘
  const tblK = [[0, 0.60], [0.13, 1.0], [0.94, 1.0], [1, 0.94]];

  const ST = 40, NP = 11;
  const stations = [];
  for (let i = 0; i <= ST; i++) {
    const t = i / ST;
    const z = -hl + L * t;
    const w = Math.max(0.4, hb * tableLerp(tblW, t));
    const dy = FB * tableLerp(tblS, t);
    const ky = -DR * tableLerp(tblK, t);
    const prof = [];
    for (let j = 0; j <= NP; j++) {
      const u = j / NP;
      const y = ky + (dy - ky) * u;
      // 横剖面：龙骨处收成一条线，往上迅速张开到接近满宽，
      // 水线以上几乎垂直（真实军舰的水线宽 ≈ 甲板宽的 94%），
      // 只在最上面一点点做外飘（flare）。用低次幂会把船做成"尖底木盆"。
      const shrink = 1 - Math.pow(1 - u, 5.0);
      const flare = 1 + 0.030 * Math.pow(u, 4.0);
      prof.push({ x: w * shrink * flare, y });
    }
    stations.push({ z, w, dy, ky, prof });
  }

  const vp = [], vc = [], vuv = [], vidx = [];
  const addV = (x, y, z, c, u, v) => {
    vp.push(x, y, z); vc.push(c.r, c.g, c.b); vuv.push(u || 0, v || 0);
    return vp.length / 3 - 1;
  };
  // 水线黑带加宽到 1.5m：远看才有那条"黑影线"，船才像压在水里
  const colorAt = (y) => (y > 0.55 ? cHull : (y > -0.95 ? cBoot : cBottom));

  const rows = [];
  for (let i = 0; i <= ST; i++) {
    const st = stations[i];
    const row = { s: [], p: [] };
    const vcoord = i / ST;
    for (let j = 0; j <= NP; j++) {
      const pt = st.prof[j], c = colorAt(pt.y);
      const ucoord = j / NP;
      row.s.push(addV(pt.x, pt.y, st.z, c, ucoord, vcoord));
      row.p.push(addV(-pt.x, pt.y, st.z, c, ucoord, vcoord));
    }
    rows.push(row);
  }
  for (let i = 0; i < ST; i++) {
    for (let j = 0; j < NP; j++) {
      const a = rows[i].s[j], b = rows[i].s[j + 1], c2 = rows[i + 1].s[j + 1], d = rows[i + 1].s[j];
      vidx.push(a, b, c2, a, c2, d);
      const a2 = rows[i].p[j], b2 = rows[i].p[j + 1], c3 = rows[i + 1].p[j + 1], d2 = rows[i + 1].p[j];
      vidx.push(a2, c3, b2, a2, d2, c3);
    }
  }
  // 艏/艉封板（扇形收口）
  const capEnd = (row, z, midY, c) => {
    const ci = addV(0, midY, z, c, 0.5, 0);
    const ring = [];
    for (let j = 0; j <= NP; j++) ring.push(row.s[j]);
    for (let j = NP; j >= 0; j--) ring.push(row.p[j]);
    for (let k = 0; k < ring.length - 1; k++) vidx.push(ci, ring[k], ring[k + 1]);
  };
  {
    const s0 = stations[0], s1 = stations[ST];
    capEnd(rows[0], s0.z, (s0.ky + s0.dy) * 0.5, cHull);
    capEnd(rows[ST], s1.z, (s1.ky + s1.dy) * 0.5, cBoot);
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
  hullGeo.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
  hullGeo.setAttribute('uv', new THREE.Float32BufferAttribute(vuv, 2));
  hullGeo.setIndex(vidx);
  hullGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hullGeo, matHull);
  hull.castShadow = true; hull.receiveShadow = true;
  g.add(hull);

  // ===========================================================================
  // 2. 甲板：跟随舷弧与外飘轮廓，带横向拱度
  // ===========================================================================
  const deckEdgeY = (i) => stations[i].dy + 0.14;
  {
    const NC = 8;
    const dp = [], duv = [], di = [];
    const dAdd = (x, y, z, u, v) => { dp.push(x, y, z); duv.push(u, v); return dp.length / 3 - 1; };
    const dRows = [];
    for (let i = 0; i <= ST; i++) {
      const st = stations[i];
      const wD = st.prof[NP].x * 0.92;   // 木甲板铺中间，外圈留钢甲板水沟
      const r = [];
      for (let k = 0; k <= NC; k++) {
        const xn = (k / NC) * 2 - 1;
        r.push(dAdd(xn * wD, st.dy + 0.16 + 0.30 * (1 - xn * xn), st.z, (xn + 1) * 0.5, i / ST));
      }
      dRows.push(r);
    }
    for (let i = 0; i < ST; i++) {
      for (let k = 0; k < NC; k++) {
        const a = dRows[i][k], b = dRows[i][k + 1], c2 = dRows[i + 1][k + 1], d = dRows[i + 1][k];
        di.push(a, c2, b, a, d, c2);
      }
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    dg.setAttribute('uv', new THREE.Float32BufferAttribute(duv, 2));
    dg.setIndex(di);
    dg.computeVertexNormals();
    const deck = new THREE.Mesh(dg, matDeck);
    deck.receiveShadow = true;
    g.add(deck);
  }

  // ---- 舷边：甲板外圈到舷墙之间的一圈灰色钢面（水沟）----
  {
    const ep = [], ei = [];
    const eAdd = (x, y, z) => { ep.push(x, y, z); return ep.length / 3 - 1; };
    const inA = [], outA = [];
    for (let i = 0; i <= ST; i++) {
      const st = stations[i];
      const wIn = st.prof[NP].x * 0.92;
      const wOut = st.prof[NP].x * 0.998;
      const yy = st.dy + 0.15;
      inA.push([eAdd(wIn, yy, st.z), eAdd(-wIn, yy, st.z)]);
      outA.push([eAdd(wOut, yy, st.z), eAdd(-wOut, yy, st.z)]);
    }
    for (let i = 0; i < ST; i++) {
      for (const sd of [0, 1]) {
        const a = inA[i][sd], b = inA[i + 1][sd], c2 = outA[i + 1][sd], d = outA[i][sd];
        if (sd === 0) ei.push(a, b, c2, a, c2, d);
        else ei.push(a, c2, b, a, d, c2);
      }
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    eg.setIndex(ei);
    eg.computeVertexNormals();
    const edgeMesh = new THREE.Mesh(eg, matHullWall);
    edgeMesh.receiveShadow = true;
    g.add(edgeMesh);
  }

  // ===========================================================================
  // 3. 舷墙 + 栏杆：把甲板与舰体的接缝盖住，剪影立刻"舰"起来
  // ===========================================================================
  const bulH = isDD ? 0.95 : 1.30;
  {
    const bp = [], bi = [];
    const bAdd = (x, y, z) => { bp.push(x, y, z); return bp.length / 3 - 1; };
    const lo = [], up = [];
    for (let i = 0; i <= ST; i++) {
      const st = stations[i];
      const wD = st.prof[NP].x;
      const yD = st.dy + 0.14;
      lo.push([bAdd(wD * 0.998, yD, st.z), bAdd(-wD * 0.998, yD, st.z)]);
      up.push([bAdd(wD * 0.985, yD + bulH, st.z), bAdd(-wD * 0.985, yD + bulH, st.z)]);
    }
    for (let i = 0; i < ST; i++) {
      for (const sd of [0, 1]) {
        const a = lo[i][sd], b = lo[i + 1][sd], c2 = up[i + 1][sd], d = up[i][sd];
        if (sd === 0) bi.push(a, b, c2, a, c2, d);
        else bi.push(a, c2, b, a, d, c2);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    bg.setIndex(bi);
    bg.computeVertexNormals();
    const bw = new THREE.Mesh(bg, matHullWall);
    bw.castShadow = true;
    g.add(bw);
  }
  {
    const pts = [];
    for (const sgn of [1, -1]) {
      for (let i = 0; i <= ST; i += 2) {
        const st = stations[i];
        const wD = st.prof[NP].x * 0.985;
        const y0 = st.dy + 0.14 + bulH;
        pts.push(sgn * wD, y0, st.z, sgn * wD, y0 + 0.92, st.z);
      }
      for (let i = 0; i < ST; i++) {
        const s0 = stations[i], s1 = stations[i + 1];
        const w0 = s0.prof[NP].x * 0.985, w1 = s1.prof[NP].x * 0.985;
        const y0 = s0.dy + 0.14 + bulH, y1 = s1.dy + 0.14 + bulH;
        for (const hh of [0.48, 0.92]) {
          pts.push(sgn * w0, y0 + hh, s0.z, sgn * w1, y1 + hh, s1.z);
        }
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(rg, matRail));
  }

  // ===========================================================================
  // 4. 上层建筑：塔式舰桥（战列舰要"高"，这是巨舰感的主要来源）
  // ===========================================================================
  const sup = new THREE.Group();
  g.add(sup);
  const rise = isBB ? 1.0 : isCA ? 0.84 : 0.62;
  const supZ = -L * 0.025;
  // [宽系数, 长系数, 基高(m), 高(m)]
  const tierDef = isDD
    ? [[0.60, 0.20, 0, 3.6], [0.46, 0.13, 3.6, 3.2], [0.32, 0.08, 6.8, 2.8]]
    : [[0.68, 0.26, 0, 6.4], [0.56, 0.175, 6.4, 5.8], [0.42, 0.115, 12.2, 5.2], [0.27, 0.07, 17.4, 4.2]];
  const tierTop = [];
  for (let i = 0; i < tierDef.length; i++) {
    const [wk, dk, rise0, h0] = tierDef[i];
    const w = B * wk, d = L * dk, h = h0 * rise, y0 = FB + rise0 * rise;
    // 四棱台而不是长方体：每层向上收 8%，侧面有内倾角，
    // 靠明暗就能读出层级。直上直下的 Box 叠起来就是一摞灰砖。
    const tg = new THREE.CylinderGeometry(0.92, 1.0, 1, 4);
    tg.rotateY(Math.PI / 4);
    tg.scale(w * 0.707, h, d * 0.707);
    const box = new THREE.Mesh(tg, matSuper);
    box.position.set(0, y0 + h * 0.5, supZ + (i === 0 ? 0 : L * 0.006 * i));
    box.castShadow = true;
    sup.add(box);
    tierTop.push({ w, d, y: y0 + h, z: box.position.z });

    // 舷窗：不用整条玻璃带（贴在盒子上就是一条黑腰带），
    // 改成栏杆层上的一排独立小窗，前后各一排。这是"有人操作"的唯一线索。
    if (i >= 1) {
      const nWin = Math.max(3, Math.round(w / 3.6));
      const winW = w * 0.062, winH = Math.max(0.55, h * 0.15);
      for (let q = 0; q < nWin; q++) {
        const wx = (q - (nWin - 1) / 2) * (w * 0.74 / nWin);
        for (const sd of [1, -1]) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.22), matGlass);
          win.position.set(wx, y0 + h * 0.56, box.position.z + sd * (d * 0.455));
          sup.add(win);
        }
      }
    }
  }
  // 舰桥两翼（开放式平台 + 栏杆）
  {
    const t1 = tierTop[1] || tierTop[0];
    const wingW = B * (isDD ? 0.20 : 0.30);
    for (const sgn of [1, -1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(wingW, 0.45, t1.d * 0.7), matSuper);
      wing.position.set(sgn * (t1.w * 0.5 + wingW * 0.5), t1.y - 0.22, t1.z + t1.d * 0.1);
      sup.add(wing);
      const rp = [];
      const x0 = sgn * (t1.w * 0.5 + wingW), x1 = sgn * t1.w * 0.5;
      rp.push(x0, t1.y + 0.9, t1.z + t1.d * 0.45, x0, t1.y - 0.2, t1.z + t1.d * 0.45);
      rp.push(x0, t1.y + 0.9, t1.z + t1.d * 0.45, x1, t1.y + 0.9, t1.z + t1.d * 0.45);
      const rgeo = new THREE.BufferGeometry();
      rgeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
      sup.add(new THREE.LineSegments(rgeo, matRail));
    }
  }
  // 三脚桅
  const topT = tierTop[tierTop.length - 1];
  const mastH = (isBB ? 30 : isCA ? 25 : 17) * rise;
  {
    const apex = new THREE.Vector3(0, topT.y + mastH, topT.z - L * 0.004);
    const legs = [[0, 0, -1], [0.82, 0, 0.58], [-0.82, 0, 0.58]];
    for (const [lx, , lz] of legs) {
      const base = new THREE.Vector3(lx * topT.w * 0.34, topT.y - 1.2, topT.z + lz * topT.d * 0.3);
      const dir = new THREE.Vector3().subVectors(apex, base);
      const len = dir.length();
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.42, len, 6), matDark);
      leg.position.copy(base).addScaledVector(dir, 0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      sup.add(leg);
    }
    // 横桁 + 支索
    for (const [hh, ww] of [[0.55, 0.55], [0.78, 0.34]]) {
      const yy = topT.y + mastH * hh;
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, B * ww, 5), matDark);
      yard.rotation.z = Math.PI / 2;
      yard.position.set(0, yy, apex.z + (1 - hh) * L * 0.012);
      sup.add(yard);
    }
  }
  // 旋转雷达（桅顶，同步代码会转它）
  const radar = new THREE.Mesh(new THREE.BoxGeometry(B * 0.34, 1.6, 0.5), matDark);
  radar.position.set(0, topT.y + mastH + 1.0, topT.z);
  sup.add(radar);
  {
    const nr = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 6), matDark);
    nr.position.set(0, topT.y + mastH + 0.2, topT.z);
    sup.add(nr);
  }

  // ===========================================================================
  // 5. 烟囱：后倾 + 顶部黑口 + 侧排气管
  // ===========================================================================
  const funnelZ = [];
  {
    const n = isDD ? 1 : 2;
    const fh = (isBB ? 13 : isCA ? 11 : 8) * rise;
    const fr = B * (isBB ? 0.085 : 0.09);
    for (let i = 0; i < n; i++) {
      const fz = supZ + L * (0.085 + i * 0.10);
      const fn = new THREE.Mesh(new THREE.CylinderGeometry(fr * 0.92, fr, fh, 10), matSuper);
      fn.position.set(0, FB + fh * 0.5 + 2.2, fz);
      fn.rotation.x = -0.06;              // 后倾
      fn.castShadow = true;
      g.add(fn);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(fr * 0.95, fr * 0.95, 0.7, 10),
        new THREE.MeshBasicMaterial({ color: 0x12161a }));
      cap.position.set(0, FB + fh + 2.2, fz + 0.5);
      g.add(cap);
      funnelZ.push({ z: fz, y: FB + fh + 2.2 });
      // 烟囱两侧的排烟管
      for (const sgn of [1, -1]) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, fh * 0.55, 6), matDark);
        pipe.position.set(sgn * fr * 0.85, FB + fh * 0.45 + 2.2, fz + 1.2);
        g.add(pipe);
      }
    }
  }

  // ===========================================================================
  // 6. 主炮塔：四棱台塔体（不是方盒子）+ 长炮管 + 测距仪耳台
  //    方盒子在阳光下就是一块白板；真炮塔的三面都有内倾角，靠明暗就能读出来。
  // ===========================================================================
  const mg = T.mainGuns;
  const turrets = [];
  // 尺寸注记：真实 203mm 炮管直径 0.25m，在这台相机距离下只有 1~2 像素，
  // 等于不存在。海战游戏里主炮是"主角"，必须按可读性放大 —— 炮塔 1.35 倍、
  // 炮管按舰宽取径（约 2.8~3.6m 粗），远看才能一眼数出几座炮塔。
  const tW = B * (isBB ? 0.48 : isCA ? 0.46 : 0.44);    // 塔体宽
  const tD = tW * 1.22;                                 // 塔体长
  const tH = B * (isBB ? 0.200 : isCA ? 0.190 : 0.195); // 塔体高
  const barrelLen = L * (isBB ? 0.105 : isCA ? 0.098 : 0.085);
  const barrelR = Math.max(0.62, B * 0.055);
  const bSpace = Math.max(barrelR * 3.0, tW * 0.26);
  for (let i = 0; i < mg.count; i++) {
    const spot = mg.turretSpots[i] || { along: 0, lateral: 0, elev: 1, dy: 0 };
    const tur = new THREE.Group();

    // 座圈（旋转环）
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(tW * 0.46, tW * 0.50, 1.1, 16), matDark);
    ring.position.y = 0.55;
    tur.add(ring);

    // 塔体：CylinderGeometry(4 边) → 旋转 45° → 缩放成矩形棱台
    // 上窄下宽，四周侧面都有内倾角，这是炮塔"金属块感"的来源
    const bodyGeo = new THREE.CylinderGeometry(0.84, 1.0, 1, 4, 1);
    bodyGeo.rotateY(Math.PI / 4);
    bodyGeo.scale(tW * 0.707, tH, tD * 0.707);
    const body = new THREE.Mesh(bodyGeo, matTurret);
    body.position.y = 1.0 + tH * 0.5;
    body.castShadow = true; body.receiveShadow = true;
    tur.add(body);

    // 顶板（略窄一圈，形成檐口阴影）
    const roof = new THREE.Mesh(new THREE.BoxGeometry(tW * 0.72, tH * 0.16, tD * 0.70), matTurret);
    roof.position.set(0, 1.0 + tH * 1.04, 0);
    tur.add(roof);

    // 正面装甲板（垂直面，颜色稍深 —— 炮塔正脸本来就比侧面脏）
    const face = new THREE.Mesh(new THREE.BoxGeometry(tW * 0.62, tH * 0.72, 0.5), matDark);
    face.position.set(0, 1.0 + tH * 0.50, -tD * 0.455);
    tur.add(face);

    // 测距仪耳台（两侧伸出的横筒，战列舰最醒目的炮塔特征）
    if (!isDD) {
      const rfLen = tW * 0.30, rfR = tH * 0.115;
      for (const sgn of [1, -1]) {
        const rf = new THREE.Mesh(new THREE.CylinderGeometry(rfR, rfR, rfLen, 10), matDark);
        rf.rotation.z = Math.PI / 2;
        rf.position.set(sgn * (tW * 0.42 + rfLen * 0.42), 1.0 + tH * 0.86, tD * 0.10);
        tur.add(rf);
        const rfc = new THREE.Mesh(new THREE.CylinderGeometry(rfR * 0.55, rfR * 0.55, rfLen * 1.06, 8), matBarrel);
        rfc.rotation.z = Math.PI / 2;
        rfc.position.set(sgn * (tW * 0.42 + rfLen * 0.42), 1.0 + tH * 0.86, tD * 0.10);
        tur.add(rfc);
      }
    }

    // 炮管组（俯仰轴；每根炮管 = 炮身 + 炮口套 + 炮尾）
    const barrels = new THREE.Group();
    barrels.position.y = 1.0 + tH * 0.42;
    for (let b = 0; b < mg.barrels; b++) {
      const bx = (b - (mg.barrels - 1) / 2) * bSpace;
      const bl = new THREE.Mesh(new THREE.CylinderGeometry(barrelR * 0.80, barrelR, barrelLen, 12), matBarrel);
      bl.rotation.x = Math.PI / 2;
      bl.position.set(bx, 0, -tD * 0.40 - barrelLen * 0.5);
      bl.castShadow = true;
      barrels.add(bl);
      // 炮口套环（前端加粗一点，远看才有"炮口"这个视觉落点）
      const mz = new THREE.Mesh(new THREE.CylinderGeometry(barrelR * 1.10, barrelR * 1.10, barrelLen * 0.07, 12), matBarrel);
      mz.rotation.x = Math.PI / 2;
      mz.position.set(bx, 0, -tD * 0.40 - barrelLen * 0.96);
      barrels.add(mz);
      // 炮尾/炮盾（挡住炮塔内部的断口）
      const br = new THREE.Mesh(new THREE.CylinderGeometry(barrelR * 1.45, barrelR * 1.45, tD * 0.55, 10), matDark);
      br.rotation.x = Math.PI / 2;
      br.position.set(bx, 0, -tD * 0.12);
      barrels.add(br);
    }
    tur.add(barrels);

    // 炮口焰
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(barrelR * 24, barrelR * 24),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    flash.rotation.x = Math.PI / 2;
    flash.position.set(0, 0, -tD * 0.40 - barrelLen - barrelR * 5);
    barrels.add(flash);

    const p = toShipXY(T, spot.along * hl, spot.lateral * hb);
    const dy = spot.dy || 0;
    tur.position.set(p.x, FB + dy + 0.25, p.z);
    barrels.rotation.x = 0.04;
    g.add(tur);                       // 座圈已挂在 tur 下，不要再单独 add
    turrets.push({
      grp: tur, barrels, flash, base: ring,
      along: spot.along * hl, lateral: spot.lateral * hb,
      yawBase: 0, barrelLen, muzzleR: barrelR,
      yaw: 0, pitch: 0.04, recoil: 0, flashV: 0, hp: 1
    });
  }

  // ===========================================================================
  // 7. 副炮：上层建筑两舷的封闭式炮座（战列舰的"肩部"细节）
  // ===========================================================================
  const secondaries = [];
  if (T.secondary) {
    const rows2 = isDD ? 1 : 2;
    const per = Math.ceil(T.secondary.count / (rows2 * 2));
    for (let r = 0; r < rows2; r++) {
      for (const sgn of [1, -1]) {
        for (let k = 0; k < per; k++) {
          const sg = new THREE.Group();
          const sw = B * (isBB ? 0.10 : 0.12);
          const body = new THREE.Mesh(new THREE.BoxGeometry(sw * 1.1, sw * 0.9, sw * 1.3), matTurret);
          body.position.y = sw * 0.45;
          sg.add(body);
          const barrels2 = new THREE.Group();
          for (let b = 0; b < (T.secondary.barrels || 2); b++) {
            const bb = new THREE.Mesh(new THREE.CylinderGeometry(sw * 0.105, sw * 0.125, L * 0.048, 7), matBarrel);
            bb.rotation.x = Math.PI / 2;
            bb.position.set((b - (T.secondary.barrels - 1) / 2) * sw * 0.30, sw * 0.52, -L * 0.024);
            barrels2.add(bb);
          }
          sg.add(barrels2);
          const zz = supZ + L * (0.03 + r * 0.12 + k * 0.055);
          sg.position.set(sgn * (B * 0.30), FB + (isBB ? 4.2 : 3.4) + (r ? 3.4 : 0), zz);
          sg.rotation.y = sgn > 0 ? 0 : Math.PI;
          g.add(sg);
          secondaries.push({
            grp: sg, barrels: barrels2, side: sgn, baseYaw: sg.rotation.y,
            ph: Math.random() * 6.28
          });
        }
      }
    }
  }

  // ===========================================================================
  // 8. 防空炮座（上层建筑两翼的平台）
  // ===========================================================================
  const aaGuns = [];
  {
    const n = Math.min(10, Math.ceil(T.aa.count / 2));
    for (let i = 0; i < n; i++) {
      const ag = new THREE.Group();
      const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.9, 8), matDark);
      mount.position.y = 0.45;
      ag.add(mount);
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.9, 8, 1, true), matSuper);
      shield.position.y = 1.1;
      ag.add(shield);
      const twin = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.6, 6), matBarrel);
      twin.rotation.x = Math.PI / 2 - 0.55;
      twin.position.set(0, 1.35, -1.2);
      ag.add(twin);
      const sgn = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      const zz = supZ + L * (-0.02 + row * 0.055);
      ag.position.set(sgn * (B * 0.33), FB + (isBB ? 8.5 : 7.0) + (row % 2) * 2.4, zz);
      g.add(ag);
      // 记录初始朝向与相位：对空炮平时会左右缓慢扫视（见 syncShipMeshes）
      aaGuns.push({ grp: ag, barrel: twin, baseYaw: 0, ph: Math.random() * 6.28, side: sgn });
    }
  }

  // ===========================================================================
  // 9. 鱼雷发射管（巡洋舰/驱逐舰）
  // ===========================================================================
  const torpTubes = [];
  if (T.torpedo) {
    for (let i = 0; i < T.torpedo.tubes; i++) {
      const spot = T.torpedo.tubeSpots[i] || { along: 0.02, lateral: 1 };
      const tg = new THREE.Group();
      const rack = new THREE.Mesh(new THREE.BoxGeometry(B * 0.26, 0.9, L * 0.055), matDark);
      rack.position.y = 0.9;
      tg.add(rack);
      for (let k = 0; k < T.torpedo.perTube; k++) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.40, L * 0.052, 8), matBarrel);
        tube.rotation.x = Math.PI / 2;
        tube.position.set((k - (T.torpedo.perTube - 1) / 2) * 0.86, 1.5, 0);
        tg.add(tube);
      }
      const sgn = spot.lateral >= 0 ? 1 : -1;
      const sp = toShipXY(T, spot.along * hl, sgn * (hb * 0.62));
      tg.position.set(sp.x, FB + 0.6, sp.z);
      tg.rotation.y = sgn > 0 ? -0.25 : Math.PI + 0.25;
      g.add(tg);
      // 记录基准方位 + 每管炮口参考点：发射时整座回转（见 syncShipMeshes 的 torpTubes 段）
      torpTubes.push({ grp: tg, baseYaw: tg.rotation.y, side: sgn, fireT: 0, idx: i });
    }
  }

  // ===========================================================================
  // 10. 舰艏细节：锚链、锚机、系缆桩（近距离最能说明"这是艘船"）
  // ===========================================================================
  {
    const bowZ = -hl + L * 0.10;
    // 锚机
    for (const sgn of [1, -1]) {
      const wind = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 8), matDark);
      wind.rotation.z = Math.PI / 2;
      wind.position.set(sgn * B * 0.10, FB + 1.0, bowZ);
      g.add(wind);
      // 锚链
      for (let k = 0; k < 5; k++) {
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.06, 4, 6), matDark);
        link.position.set(sgn * B * 0.16, FB + 0.9, bowZ - k * 0.75);
        link.rotation.y = k % 2 ? Math.PI / 2 : 0;
        g.add(link);
      }
    }
    // 系缆桩
    for (let k = 0; k < 4; k++) {
      for (const sgn of [1, -1]) {
        const bl2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.7, 6), matDark);
        bl2.position.set(sgn * B * 0.34, FB + 0.6, -hl + L * (0.06 + k * 0.05));
        g.add(bl2);
      }
    }
    // 通风筒（甲板上一排小蘑菇）
    for (let k = 0; k < 6; k++) {
      const sgn = k % 2 ? 1 : -1;
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.30, 1.5, 6), matSuper);
      vent.position.set(sgn * B * 0.24, FB + 1.1, -hl + L * (0.16 + Math.floor(k / 2) * 0.09));
      g.add(vent);
      const capV = new THREE.Mesh(new THREE.SphereGeometry(0.38, 6, 5), matSuper);
      capV.position.set(sgn * B * 0.24, FB + 1.9, -hl + L * (0.16 + Math.floor(k / 2) * 0.09));
      g.add(capV);
    }
    // 救生艇（两舷各一）
    if (!isDD) {
      for (const sgn of [1, -1]) {
        const boat = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 3.4, 4, 8), matSuper);
        boat.rotation.z = Math.PI / 2;
        boat.rotation.y = Math.PI / 2;
        boat.position.set(sgn * B * 0.36, FB + 3.4, supZ + L * 0.10);
        g.add(boat);
      }
    }
  }

  // ===========================================================================
  // 11. 舵 / 螺旋桨 / 轴系
  // ===========================================================================
  const prop = new THREE.Group();
  {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, L * 0.05, 6), matDark);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.set(0, -DR * 0.55, hl - L * 0.035);
    prop.add(shaft);
    for (const sgn of [1, -1]) {
      const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.2, 4), matDark);
      blade.rotation.z = Math.PI / 2;
      blade.position.set(sgn * B * 0.16, -DR * 0.55, hl - L * 0.012);
      prop.add(blade);
    }
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.5, DR * 0.8, L * 0.035), matDark);
    rudder.position.set(0, -DR * 0.45, hl - L * 0.004);
    prop.add(rudder);
    g.add(prop);
  }

  // ===========================================================================
  // 12. 战损表现点（火/烟）
  // ===========================================================================
  const firePts = [];
  for (let i = 0; i < 3; i++) {
    const fp = new THREE.Group();
    const flame = new THREE.Mesh(new THREE.ConeGeometry(2.2, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xff8028, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    flame.position.y = 3;
    fp.add(flame);
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(3.4, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x202020, transparent: true, opacity: 0, depthWrite: false }));
    smoke.position.y = 8;
    fp.add(smoke);
    const sp = toShipXY(T, (i - 1) * L * 0.22, (i % 2 ? 1 : -1) * hb * 0.34);
    fp.position.set(sp.x, FB + 2.5, sp.z);
    g.add(fp);
    firePts.push(fp);
  }

  // ===========================================================================
  // 13. 沉没泡沫圈
  // ===========================================================================
  const foam = new THREE.Mesh(new THREE.RingGeometry(B * 0.55, B * 0.68, 24),
    new THREE.MeshBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.16, depthWrite: false }));
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 0.4;
  g.add(foam);

  return {
    group: g, turrets, secondaries, aaGuns, torpTubes, radar,
    firePts, foam, sup, prop, funnelZ,
    sim: null,
    lastYaw: 0
  };
}
// 舰体局部 (along比例, lat比例) → 模型坐标（along>0 舰艏 → -z）
function toShipXY(T, along, lat) {
  return { x: lat, z: -along };
}

// === 战舰实例化与快照同步 =====================================================
// 客户端不预测舰船（速度慢、惯性大，插值就够），全部走插值表现。
// NP = NavalPhysics（UMD，服务端同源配置，保证浪高/弹道两端一致）
const N = (typeof NavalPhysics !== 'undefined') ? NavalPhysics : null;
const shipMeshes = new Map();      // shipId -> buildWarship() 结果
let shipViews = new Map();        // shipId -> 插值后的可视状态 {p,h,roll,pitch,...}

// 三舰种的形状参数（客户端侧镜像，避免依赖服务端对象里的函数）
const SHIP_TYPES_CL = N ? N.SHIP_TYPES : null;

function ensureShipMesh(s) {
  let m = shipMeshes.get(s.i);
  if (m) return m;
  const T = SHIP_TYPES_CL ? SHIP_TYPES_CL[s.t] : null;
  if (!T) return null;
  m = buildWarship(T);
  shipMeshes.set(s.i, m);
  scene.add(m.group);
  return m;
}

// 快照里的战舰条目 → 插值状态（与飞机同一套插值管线，延迟一致）
function interpolateShips(snaps, rt) {
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > rt) i--;
  const A = snaps[i], B = snaps[i + 1] || A;
  const alpha = (B !== A) ? clamp((rt - A.t) / Math.max(1e-4, B.t - A.t), 0, 1) : 0;
  if (!A.sp) return;
  const mapB = new Map();
  if (B.sp) for (const s of B.sp) mapB.set(s.i, s);
  const out = new Map();
  for (const e of A.sp) {
    const e2 = mapB.get(e.i);
    const o = { i: e.i, e };
    if (e2) {
      o.p = { x: lerp(e.p[0], e2.p[0], alpha), y: lerp(e.p[1], e2.p[1], alpha), z: lerp(e.p[2], e2.p[2], alpha) };
      // 航向角插值要走最短弧（不能直接 lerp，否则会绕远路转一圈）
      let dh = e2.h - e.h;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      o.h = e.h + dh * alpha;
      o.roll = lerp(e.rp, e2.rp, alpha);
      o.pitch = lerp(e.pi, e2.pi, alpha);
    } else {
      o.p = { x: e.p[0], y: e.p[1], z: e.p[2] };
      o.h = e.h; o.roll = e.rp; o.pitch = e.pi;
    }
    out.set(e.i, o);
  }
  // 清掉已消失的舰（沉没超时被服务端移除）
  for (const id of Array.from(shipMeshes.keys())) {
    if (!out.has(id)) {
      const m = shipMeshes.get(id);
      scene.remove(m.group);
      shipMeshes.delete(id);
    }
  }
  shipViews = out;
}

// 每帧把插值状态套到模型上：位置/航向/横摇/纵摇 + 炮塔动画 + 战损/沉没
function syncShipMeshes(dt, t) {
  if (!shipViews) return;
  for (const [id, v] of shipViews) {
    const m = ensureShipMesh(v.e);
    if (!m) continue;
    const e = v.e;
    const T = (SHIP_TYPES_CL && SHIP_TYPES_CL[e.t]) || null;
    const g = m.group;

    // ---- 基础位姿 ----
    g.position.set(v.p.x, v.p.y, v.p.z);
    g.rotation.set(v.pitch, v.h, v.roll, 'YXZ');
    const fwdXs = -Math.sin(v.h), fwdZs = -Math.cos(v.h);   // 先 yaw 再 pitch 再 roll（YXZ 顺序避免万向锁）

    // ---- 沉没动画：服务端给 wn = 沉没进度 0..1 ----
    if (e.wn > 0) {
      g.position.y = v.p.y - e.wn * (e.mx ? 0 : 0) - e.wn * 30;
      g.rotation.z = lerp(v.roll, 0.95, Math.min(1, e.wn * 1.3));
      g.rotation.x = lerp(v.pitch, -0.4, Math.min(1, e.wn));
      // 沉没时不再画泡沫/火
      m.foam.material.opacity = 0;
    } else {
      m.foam.material.opacity = 0.10 + Math.abs(v.h - (m.lastYaw || v.h)) * 2.2;
      m.foam.material.opacity = Math.min(0.3, m.foam.material.opacity);
      m.foam.visible = !!e.al;
    }
    m.lastYaw = v.h;

    // ---- 主炮塔：方位/俯仰/后坐/炮口焰/损毁 ----
    if (e.gy) {
      for (let i = 0; i < m.turrets.length; i++) {
        const tu = m.turrets[i];
        const hp = e.gh ? e.gh[i] : 1;
        if (hp <= 0.05) {
          tu.grp.visible = false;
          continue;
        }
        tu.grp.visible = true;
        // ⚠️ 取负：服务端 gy 的约定是「右舷为正」（fireMainGun 里 dir = f*cos + r*sin，
        // r 是右向量），而 THREE 里舰艏朝 -z 时 rotation.y 为正等于左转。
        // 直接套 gy 会让炮塔往炮弹相反的方向转。
        const yawTgt = -e.gy[i];
        // 视觉平滑：快照 20Hz，方向牌硬赋值会在两帧间跳 1~2°
        tu.yawVis = tu.yawVis === undefined ? yawTgt : tu.yawVis + (yawTgt - tu.yawVis) * clamp(dt * 16, 0, 1);
        tu.grp.rotation.y = tu.yawVis;
        const pitTgt = clamp(e.gp[i], -0.1, 0.9);
        tu.pitVis = tu.pitVis === undefined ? pitTgt : tu.pitVis + (pitTgt - tu.pitVis) * clamp(dt * 14, 0, 1);
        tu.barrels.rotation.x = tu.pitVis;
        // 后坐：炮管组沿 +z 后缩
        tu.barrels.position.z = (e.gr ? e.gr[i] : 0) * tu.barrelLen * 0.10;
        // 炮口焰：透明度随 flash 值
        tu.flash.material.opacity = (e.gf ? e.gf[i] : 0) * 0.9;
        // 炮塔受损：整体略微歪斜
        tu.grp.rotation.x = (1 - hp) * 0.10;
      }

      // ---- 齐射震动：任何一座炮塔的炮口焰刚亮起，全舰抖一下 ----
      // 一万多吨的舰体被 3 门 406mm 同时后坐，不可能纹丝不动。
      // 这不是装饰：玩家按齐射键后要立刻有"力量"反馈，否则会觉得炮没打出去。
      let flashNow = 0;
      for (let i = 0; i < e.gf.length; i++) flashNow = Math.max(flashNow, e.gf[i] || 0);
      if (flashNow > 0.55 && !m.flashPrev) m.recoilT = 0.30;
      m.flashPrev = flashNow > 0.55;
      if (m.recoilT > 0) {
        m.recoilT -= dt;
        const k = clamp(m.recoilT / 0.30, 0, 1);
        // 横摇 + 下沉：频率高、幅度小，读起来是"轰"的一下
        g.rotation.z += Math.sin(m.recoilT * 62) * 0.008 * k;
        g.position.y -= Math.abs(Math.sin(m.recoilT * 48)) * 0.10 * k;
      }
    }

    // ---- 受击震动：被命中的舰整体抖一下（幅度随口径）----
    // 衰减用指数：0.55s 左右收干净，不会和横摇/纵摇打架
    if (m.hitShake > 0) {
      m.hitShake = Math.max(0, m.hitShake - dt * 2.0);
      const hk = m.hitShake;
      g.rotation.z += Math.sin(t * 52) * 0.016 * hk;
      g.rotation.x += Math.sin(t * 61 + 1.7) * 0.010 * hk;
      g.position.y -= Math.abs(Math.sin(t * 44)) * 0.55 * hk;
    }

    // ---- 战损：火势 → 火点/黑烟 ----
    const fire = e.fi || 0;
    const showFire = e.al && fire > 0.05;
    for (let i = 0; i < m.firePts.length; i++) {
      const fp = m.firePts[i];
      const on = showFire && (i < Math.ceil(fire * m.firePts.length));
      fp.children[0].material.opacity = on ? 0.55 + Math.sin(t * 11 + i) * 0.2 : 0;
      fp.children[1].material.opacity = on ? 0.28 + Math.sin(t * 3.3 + i * 2) * 0.12 : 0;
      if (on) {
        fp.children[1].position.y = 8 + Math.sin(t * 1.7 + i) * 1.6;
        fp.children[1].scale.setScalar(1 + Math.sin(t * 2.1 + i) * 0.18);
      }
    }
    // 进水：舰体下沉一点点（视觉）
    if (e.al && (e.fl || 0) > 0.05) {
      g.position.y -= (e.fl || 0) * (e.p[1] !== undefined ? 0 : 0) - (e.fl || 0) * 2.2;
    }

    // ---- 雷达旋转 ----
    if (m.radar) m.radar.rotation.y = (t * 0.8) % (Math.PI * 2);

    // ---- 副炮 / 防空炮：追踪动画 ----
    // 之前这些炮座建好后从未被驱动，是一排"焊死"的静态模型。
    // 现在按目标驱动：附近有敌机 → 防空炮指向它（含仰角），否则缓慢扫视；
    // 副炮优先指最近的水面目标，没有目标就跟着舰体小幅摆动。
    // 一律用低通（dt*k），快照 20Hz 的跳变不会让炮座抽搐。
    if (m.aaGuns || m.secondaries) {
      // 找一个最近的敌机（对空）和最近的敌舰（对海）作为指向目标
      let airT = null, airD = 1e9, seaT = null, seaD = 1e9;
      const myTeam = e.tm;
      for (const av of game.views.values()) {
        if (!av.e.al || av.e.tm === myTeam) continue;   // 飞机字段在 e 上（e.al / e.tm）
        const dx = av.pos.x - v.p.x, dz = av.pos.z - v.p.z;
        const d = Math.hypot(dx, dz);
        if (d < 4200 && d < airD && av.pos.y > 6) { airD = d; airT = av; }
      }
      for (const [, sv] of shipViews) {
        if (sv.e.tm === myTeam || !sv.e.al) continue;
        const d = Math.hypot(sv.p.x - v.p.x, sv.p.z - v.p.z);
        if (d < 9000 && d < seaD) { seaD = d; seaT = sv; }
      }
      const aaK = Math.min(1, dt * 3.2);
      if (m.aaGuns) {
        for (let i = 0; i < m.aaGuns.length; i++) {
          const ag = m.aaGuns[i];
          let wantYaw, wantPitch;
          if (airT) {
            // 指向敌机：方位相对舰体（模型坐标 z 轴朝艏为 -z）
            const dx = airT.pos.x - v.p.x, dz = airT.pos.z - v.p.z;
            const bearing = Math.atan2(-dx, -dz);       // 世界方位
            wantYaw = bearing - v.h;                    // 转成相对舰体
            while (wantYaw > Math.PI) wantYaw -= Math.PI * 2;
            while (wantYaw < -Math.PI) wantYaw += Math.PI * 2;
            // 仰角：距离 + 高度差
            const hor = Math.max(1, Math.hypot(dx, dz));
            wantPitch = Math.atan2(airT.pos.y - (v.p.y + 10), hor);
          } else {
            // 无目标：缓慢左右扫视（每座相位不同，看起来像在搜索）
            wantYaw = Math.sin(t * 0.45 + ag.ph) * 0.55;
            wantPitch = 0.30 + Math.sin(t * 0.33 + ag.ph * 1.7) * 0.14;
          }
          ag.grp.rotation.y += (wantYaw - ag.grp.rotation.y) * aaK;
          // 炮管仰角：barrel 初始 rotation.x = π/2 - 0.55（约 58° 仰起）
          const pitBase = Math.PI / 2 - 0.55;
          const pitWant = pitBase - clamp(wantPitch, -0.2, 1.1);
          if (ag.barrel) ag.barrel.rotation.x += (pitWant - ag.barrel.rotation.x) * aaK;
        }
      }
      if (m.secondaries) {
        const secK = Math.min(1, dt * 2.4);
        for (let i = 0; i < m.secondaries.length; i++) {
          const sg = m.secondaries[i];
          let wantYaw = sg.baseYaw;
          if (seaT) {
            const dx = seaT.p.x - v.p.x, dz = seaT.p.z - v.p.z;
            const bearing = Math.atan2(-dx, -dz);
            let rel = bearing - v.h;
            while (rel > Math.PI) rel -= Math.PI * 2;
            while (rel < -Math.PI) rel += Math.PI * 2;
            // 只在本舷射界内（±70°）才追，超出就回到舷侧待机位
            if (Math.abs(rel) < 1.22) wantYaw = rel;
          }
          // 待机时轻微摆动（海风 + 舰体微晃），避免一排完全静止的死模型
          wantYaw += Math.sin(t * 0.7 + sg.ph) * 0.035;
          sg.grp.rotation.y += (wantYaw - sg.grp.rotation.y) * secK;
          // 炮管俯仰：追水面目标时压低，待机时平指
          if (sg.barrels) {
            const pitWant = seaT ? 0.02 : 0.08 + Math.sin(t * 0.55 + sg.ph) * 0.03;
            sg.barrels.rotation.x += (pitWant - sg.barrels.rotation.x) * secK;
          }
        }
      }
    }

    // ---- 鱼雷管：发射后整座回转（回座）+ 短促抖动 ----
    if (m.torpTubes && m.torpTubes.length) {
      for (const tt of m.torpTubes) {
        if (tt.fireT > 0) {
          tt.fireT -= dt;
          const k = clamp(tt.fireT / 0.9, 0, 1);
          // 后坐：沿管轴方向缩回一小段 + 高频抖动
          tt.grp.position.z = Math.sin(tt.fireT * 55) * 0.22 * k;
          tt.grp.rotation.y = tt.baseYaw + Math.sin(tt.fireT * 40) * 0.03 * k;
        } else {
          tt.grp.position.z += (0 - tt.grp.position.z) * Math.min(1, dt * 6);
          tt.grp.rotation.y += (tt.baseYaw - tt.grp.rotation.y) * Math.min(1, dt * 4);
        }
      }
    }

    // ---- 烟囱冒烟：从真实烟囱口位置冒（模型里记录了 funnelZ）----
    if (e.al && !e.wn && m.funnelZ) {
      m.smokeAt = (m.smokeAt || 0) - dt;
      if (m.smokeAt <= 0) {
        m.smokeAt = 0.19;
        const spd = e.v || 0;
        // 航速越高，烟越淡（锅炉燃烧充分）——细节但很有说服力。
        // 尺寸/透明度必须克制：原来单粒子能涨到 28m、每 0.11s 生成一次，
        // 两个烟囱叠起来是一根糊住半个屏幕的黑柱（真实军舰巡航时是淡灰细烟）。
        const load = clamp(spd / 16, 0, 1);
        for (const fz of m.funnelZ) {
          const wp = new THREE.Vector3(0, fz.y, fz.z).applyEuler(g.rotation).add(g.position);
          pSmoke.spawn({
            x: wp.x + (Math.random() - 0.5) * 1.4, y: wp.y, z: wp.z + (Math.random() - 0.5) * 1.4,
            vx: -fwdXs * (3 + load * 9) + (Math.random() - 0.5) * 2.2,
            vy: 4.2 + Math.random() * 1.8,
            vz: -fwdZs * (3 + load * 9) + (Math.random() - 0.5) * 2.2,
            life: 1.9 + Math.random() * 1.3,
            s0: 1.6, s1: 7.5 + load * 4.5 + Math.random() * 2.5,
            alpha: 0.09 + (1 - load) * 0.10, kind: 1, acurve: 1,
            r: 0.42, g: 0.42, b: 0.44, r1: 0.66, g1: 0.66, b1: 0.68
          });
        }
      }
    }

    // ---- 螺旋桨：航行时转起来（水下看不清，但尾流位置对得上）----
    if (m.prop && (e.v || 0) > 0.5) m.prop.rotation.z += dt * (0.6 + e.v * 0.12);

    // ---- 舰艏破浪 + 舰艉尾流：船在水里的"重量感"全靠这两处白沫 ----
    // 水花留在世界坐标里（几乎不给速度），船自己开走 → 天然拉出 V 形尾迹。
    if (e.al && !e.wn && (e.v || 0) > 1.2 && T) {
      m.wakeAt = (m.wakeAt || 0) - dt;
      if (m.wakeAt <= 0) {
        const spd = e.v || 0;
        const inten = clamp(spd / 14, 0, 1);
        m.wakeAt = 0.30 - inten * 0.14;
        const L = T.len, B = T.beam;
        // 尾流是"贴在水面上的一层碎沫"，不是烟雾。
        // 之前单个粒子能涨到 8m、alpha 0.28、每 0.08s 生成 3~4 个，
        // 叠起来就是舰艉挂了一团白雾（截图里像着火）。
        // 现在：起始尺寸减半、寿命缩短、带重力快速压回水面、透明度减半。
        const foam = (lx, ly, lz, lvx, lvy, lvz, size) => {
          const wp = new THREE.Vector3(lx, ly, lz).applyEuler(g.rotation).add(g.position);
          const vv = new THREE.Vector3(lvx, lvy, lvz).applyEuler(g.rotation);
          pSmoke.spawn({
            x: wp.x, y: Math.min(wp.y, 0.6), z: wp.z,
            vx: vv.x, vy: vv.y, vz: vv.z,
            life: 0.85 + Math.random() * 0.55,
            s0: size * 0.30, s1: size * (1.05 + inten * 0.45),
            alpha: 0.10 + inten * 0.09, drag: 1.9, gravity: 2.6,
            r: 0.95, g: 0.98, b: 1.0, r1: 0.80, g1: 0.88, b1: 0.96, kind: 1
          });
        };
        // 舰艏两侧破浪（向外翻）
        for (const sd of [-1, 1]) {
          foam(sd * B * 0.46, 0.28, -L * 0.34,
            sd * (1.0 + inten * 1.9), 0.9 + inten * 1.1, 0,
            1.3 + inten * 0.8);
        }
        // 舰艉螺旋桨尾流（船身中后部一股翻滚的白水）
        foam((Math.random() - 0.5) * B * 0.42, 0.28, L * 0.46,
          (Math.random() - 0.5) * 1.0, 0.5 + inten * 0.7, 0,
          1.7 + inten * 1.2);
        // 高速时舷侧再补一条细碎白边
        if (inten > 0.6 && Math.random() < 0.45) {
          const sd = Math.random() < 0.5 ? -1 : 1;
          foam(sd * B * 0.48, 0.24, (Math.random() - 0.5) * L * 0.7, sd * 0.7, 0.5, 0, 0.9);
        }
      }
    }
  }
}

// === 舰炮弹曳光 / 落水水柱 / 鱼雷航迹 =========================================
// 炮弹与鱼雷都从快照拿权威位置（客户端不积分弹道），这里只做表现。
const shellTracers = [];         // {mesh, born}
const shellSplashes = [];        // {mesh, born, big}
const torpMeshes = new Map();    // torpKey -> {mesh, wake timer}
const bombMeshes = [];           // 航空炸弹（按快照下标复用）
const bombGeo = new THREE.CapsuleGeometry(0.42, 1.5, 4, 8);
const bombMat = new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.6, metalness: 0.45 });

function initShellFx() {
  // 炮弹：小加色球（大口径更大更亮）
  const geoS = new THREE.SphereGeometry(1.4, 6, 5);
  const geoB = new THREE.SphereGeometry(2.6, 8, 6);
  shellTracers.geoS = geoS; shellTracers.geoB = geoB;
}
initShellFx();

function updateShellTracers(dt) {
  if (!shipViews) return;
  // ---- 1. 当前在飞的炮弹：为每发维持一个 mesh ----
  const snaps = game.snaps;
  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const seen = new Set();
  if (latest && latest.sh) {
    for (let i = 0; i < latest.sh.length; i++) {
      const s = latest.sh[i];
      seen.add(i);
      let rec = shellTracers[i];
      if (!rec || !rec.mesh) {
        if (rec) { scene.remove(rec.mesh); }
        const mesh = new THREE.Mesh(
          s.b ? shellTracers.geoB : shellTracers.geoS,
          new THREE.MeshBasicMaterial({ color: s.b ? 0xffd090 : 0xffa860, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
        scene.add(mesh);
        rec = shellTracers[i] = { mesh };
      }
      rec.mesh.visible = true;
      rec.mesh.position.set(s.p[0], s.p[1], s.p[2]);
    }
  }
  for (let i = 0; i < shellTracers.length; i++) {
    const rec = shellTracers[i];
    if (rec && !seen.has(i)) {
      if (rec.mesh) { scene.remove(rec.mesh); rec.mesh = null; }
    }
  }

  // ---- 2. 鱼雷：网格 + 航迹泡 ----
  if (latest && latest.tp) {
    for (const tp of latest.tp) {
      const key = tp.p[0].toFixed(0) + '_' + tp.p[2].toFixed(0);
      let rec = torpMeshes.get(key);
      if (!rec) {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5, 0.5, 7.2, 8),
          new THREE.MeshStandardMaterial({ color: 0x30363c, roughness: 0.5, metalness: 0.5 }));
        mesh.rotation.z = Math.PI / 2;
        scene.add(mesh);
        rec = { mesh, wakeAt: 0 };
        torpMeshes.set(key, rec);
      }
      rec.mesh.visible = true;
      // 空投段还没入水 → 用真实高度；入水后贴水面
      rec.mesh.position.set(tp.p[0], tp.air ? Math.max(0.9, tp.p[1]) : 0.9, tp.p[2]);
      rec.mesh.rotation.y = -tp.d + Math.PI / 2;
      // 航迹泡：鱼雷后面拖一条白沫（空中段不冒泡）
      rec.wakeAt -= dt;
      if (rec.wakeAt <= 0 && !tp.air) {
        rec.wakeAt = 0.06;
        const dirX = Math.cos(tp.d), dirZ = Math.sin(tp.d);
        pSmoke.spawn({
          x: tp.p[0] - dirX * 5 + (Math.random() - 0.5) * 1.6,
          y: 0.6,
          z: tp.p[2] - dirZ * 5 + (Math.random() - 0.5) * 1.6,
          vx: 0, vy: 0.6, vz: 0,
          life: 1.4, s0: 1.8, s1: 9, alpha: 0.5, drag: 0.5, gravity: 0,
          r: 0.92, g: 0.96, b: 1.0
        });
      }
    }
    // 清掉已消失的鱼雷
    const aliveKeys = new Set(latest.tp.map((tp) => tp.p[0].toFixed(0) + '_' + tp.p[2].toFixed(0)));
    for (const [key, rec] of torpMeshes) {
      if (!aliveKeys.has(key)) {
        scene.remove(rec.mesh);
        torpMeshes.delete(key);
      }
    }
  }

  // ---- 3. 航空炸弹：小暗色弹体 + 尾迹（下落中） ----
  const seenB = new Set();
  if (latest && latest.bm) {
    for (let i = 0; i < latest.bm.length; i++) {
      const b = latest.bm[i];
      seenB.add(i);
      let rec = bombMeshes[i];
      if (!rec) {
        const mesh = new THREE.Mesh(bombGeo, bombMat);
        scene.add(mesh);
        rec = bombMeshes[i] = { mesh };
      }
      rec.mesh.visible = true;
      rec.mesh.position.set(b.p[0], b.p[1], b.p[2]);
      // 弹体朝速度方向（快照没有速度，用相邻帧位置差近似太贵 → 统一朝下微倾）
      rec.mesh.rotation.x = Math.PI * 0.5;
      // 下落尾迹
      if (Math.random() < 0.5) {
        pSmoke.spawn({
          x: b.p[0] + (Math.random() - 0.5) * 1.2, y: b.p[1] + 1.5, z: b.p[2] + (Math.random() - 0.5) * 1.2,
          vx: 0, vy: 1.2, vz: 0,
          life: 0.5, s0: 1.2, s1: 4.5, alpha: 0.20, drag: 1.2, gravity: 0,
          r: 0.86, g: 0.86, b: 0.88
        });
      }
    }
  }
  for (let i = 0; i < bombMeshes.length; i++) {
    const rec = bombMeshes[i];
    if (rec && !seenB.has(i)) { scene.remove(rec.mesh); rec.mesh = null; }
  }
}

// 事件：舰炮开火（炮管后座由炮塔动画处理，这里做炮口焰+火花+冲击波+烟）
function fxShipFire(e) {
  const big = !!e.big;
  // ---- 炮口焰：白热火球（加色混合，白热→橙红），大口径是一团明显的火球 ----
  const nFlash = big ? 10 : 4;
  for (let i = 0; i < nFlash; i++) {
    const sp = (8 + Math.random() * 26) * (big ? 1.6 : 1);
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    pFire.spawn({
      x: e.p[0], y: e.p[1], z: e.p[2],
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp * 0.7 + (big ? 3 : 1),
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: big ? 0.16 + Math.random() * 0.14 : 0.10 + Math.random() * 0.06,
      s0: big ? 7 : 3, s1: big ? 26 : 9,
      alpha: 1, drag: 3.2, gravity: 1,
      r: 1.0, g: 0.93, b: 0.72, r1: 1.0, g1: 0.45, b1: 0.10,
      kind: 0, acurve: 0
    });
  }
  // ---- 径向火花：高速小粒子拉出放射线感 ----
  const nSpark = big ? 14 : 5;
  for (let i = 0; i < nSpark; i++) {
    const sp = (40 + Math.random() * 90) * (big ? 1.5 : 1);
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 1.6 - 0.6);
    pFire.spawn({
      x: e.p[0], y: e.p[1], z: e.p[2],
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp * 0.55,
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: 0.3 + Math.random() * 0.35, s0: 1.6, s1: 0.3,
      alpha: 0.95, drag: 1.6, gravity: 6,
      r: 1.0, g: 0.82, b: 0.42
    });
  }
  // ---- 炮口烟：量大、挂着慢慢散（齐射时的"硝烟弥漫"感）----
  const n = big ? 14 : 6;
  for (let i = 0; i < n; i++) {
    pSmoke.spawn({
      x: e.p[0], y: e.p[1], z: e.p[2],
      vx: (Math.random() - 0.5) * (big ? 22 : 14), vy: 2 + Math.random() * (big ? 5 : 3), vz: (Math.random() - 0.5) * (big ? 22 : 14),
      life: big ? 2.2 + Math.random() * 1.6 : 1.2 + Math.random() * 0.8,
      s0: big ? 6 : 3, s1: big ? 46 : 24,
      alpha: big ? 0.5 : 0.4, kind: 1, acurve: 1,
      r: 0.82, g: 0.80, b: 0.77, r1: 0.52, g1: 0.51, b1: 0.50
    });
  }
  // 大口径：炮口冲击波环 + 明亮照明；小口径也给一点弱闪
  if (big) {
    spawnShockwave(e.p[0], e.p[1], e.p[2], 0.9);
    spawnExplosionLight(e.p[0], e.p[1], e.p[2], 0.65);
  } else {
    spawnExplosionLight(e.p[0], e.p[1], e.p[2], 0.18);
  }
}
// 事件：炮弹落水（三段式水柱：主喷泉 + 根部水裙 + 泡沫圈）
function fxShellSplash(e) {
  const big = !!e.big;
  const h = big ? 42 : 12;                  // 主水柱视觉峰高（米）
  const w = big ? 3.6 : 1.7;                // 喷口散布半径
  // ---- 1) 主体水柱：窄口垂直上喷，到顶后自然下坠（重力弧线）----
  const nJet = big ? 18 : 8;
  for (let i = 0; i < nJet; i++) {
    pSmoke.spawn({
      x: e.p[0] + (Math.random() - 0.5) * w, y: e.p[1] + 0.5,
      z: e.p[2] + (Math.random() - 0.5) * w,
      vx: (Math.random() - 0.5) * 4, vy: h * (0.55 + Math.random() * 0.45), vz: (Math.random() - 0.5) * 4,
      life: big ? 1.9 + Math.random() * 1.1 : 0.9 + Math.random() * 0.4,
      s0: big ? 2.6 : 1.6, s1: h * 0.42,
      alpha: 0.72, kind: 1, acurve: 1, drag: 0.15, gravity: 9.8,
      r: 0.92, g: 0.96, b: 1.0, r1: 0.70, g1: 0.79, b1: 0.88
    });
  }
  // ---- 2) 根部水裙：水柱底部向外翻卷的一圈白沫 ----
  const nCrown = big ? 16 : 7;
  for (let i = 0; i < nCrown; i++) {
    const a = (i / nCrown) * Math.PI * 2 + Math.random() * 0.5;
    const sp = (big ? 14 : 6) + Math.random() * (big ? 10 : 4);
    pSmoke.spawn({
      x: e.p[0] + Math.cos(a) * 1.5, y: e.p[1] + 1.5, z: e.p[2] + Math.sin(a) * 1.5,
      vx: Math.cos(a) * sp, vy: 6 + Math.random() * 8, vz: Math.sin(a) * sp,
      life: big ? 1.1 + Math.random() * 0.6 : 0.7 + Math.random() * 0.3,
      s0: big ? 2.2 : 1.3, s1: big ? 8 : 4,
      alpha: 0.6, kind: 1, acurve: 1, drag: 1.1, gravity: 9.8,
      r: 0.90, g: 0.95, b: 1.0, r1: 0.72, g1: 0.80, b1: 0.88
    });
  }
  // ---- 3) 水面泡沫圈：外圈大而慢（扩散的涟漪），内圈小而快 ----
  spawnShockwave(e.p[0], e.p[1] + 0.5, e.p[2], e.big ? 2.0 : 0.7);
  if (big) spawnShockwave(e.p[0], e.p[1] + 0.5, e.p[2], 1.1);
  if (big) Sound.splash && Sound.splash(clamp(1 - camera.position.distanceTo(new THREE.Vector3(e.p[0], 0, e.p[2])) / 5000, 0.05, 0.7));
}

// === 航母动态：雷达旋转 / 弹射蒸汽 / 阻拦索受力 / 停机热浪 / 牵引摩擦烟 ========
// 两艘舰各跑一遍；所有甲板坐标都用该舰自己的 (hx,hz,rx,rz) 换算。
const _cvTmp = new THREE.Vector3();
function updateCarrier(dt, t) {
  // 先把"每队正在弹射/牵引/钩索"的飞机分桶（快照 cv 已按队标好）
  const catByTeam = [[], []], taxiByTeam = [[], []], wireByTeam = [[], []];
  for (const it of (game.cvCat || [])) {
    const tm = (it && it.ct !== undefined) ? it.ct : 0;
    if (catByTeam[tm]) catByTeam[tm].push(it.i === undefined ? it : it.i);
  }
  for (const it of (game.cvTaxi || [])) {
    const tm = (it && it.ct !== undefined) ? it.ct : 0;
    if (taxiByTeam[tm]) taxiByTeam[tm].push(it.i === undefined ? it : it.i);
  }
  for (const it of (game.cvWire || [])) {
    const tm = (it && it.ct !== undefined) ? it.ct : 0;
    if (wireByTeam[tm]) wireByTeam[tm].push(it);
  }

  for (let team = 0; team < CV_MESH.length; team++) {
    const M = CV_MESH[team];
    if (!M) continue;
    const C = M.cv || FP.CARRIERS[team];

    // 舰载雷达匀速旋转（两舰相位错开，看起来不是复制粘贴）
    if (M.radar) M.radar.rotation.y = ((t + team * 1.7) * 1.05) % (Math.PI * 2);

    // 甲板局部坐标 → 世界坐标（含该舰朝向）
    const cosR = Math.cos(g_rotOf(C)), sinR = Math.sin(g_rotOf(C));
    const toWorld = (along, lat) => ({
      x: C.x + C.hx * along + C.rx * lat,
      z: C.z + C.hz * along + C.rz * lat
    });

    // ---- 弹射蒸汽：正在弹射的飞机，从两条弹射轨道两侧喷出白汽 ----
    for (const id of catByTeam[team]) {
      const key = team + ':' + id;
      if (!game.cvCatFx.has(key)) game.cvCatFx.set(key, 0.9);
    }
    for (const [key, tt] of game.cvCatFx) {
      if (!key.startsWith(team + ':')) continue;
      const ntt = tt - dt;
      if (ntt <= 0) { game.cvCatFx.delete(key); continue; }
      game.cvCatFx.set(key, ntt);
      const prog = 1 - ntt / 0.9;
      const pz = C.catZ - C.catapultLen * prog * 0.85;
      // 蒸汽沿舰艏方向（-h）喷出去
      const bowX = -C.hx, bowZ = -C.hz;
      for (const s of [-1, 1]) {
        const p = toWorld(pz, s * 13);
        pSmoke.spawn({
          x: p.x + (Math.random() - 0.5) * 5,
          y: C.y + 1.4,
          z: p.z + (Math.random() - 0.5) * 6,
          vx: bowX * (6 + Math.random() * 8) + (Math.random() - 0.5) * 4,
          vy: 1.2 + Math.random() * 2.4,
          vz: bowZ * (6 + Math.random() * 8) + (Math.random() - 0.5) * 4,
          life: 1.1 + Math.random() * 1.3,
          s0: 5 + Math.random() * 4, s1: 26 + Math.random() * 16,
          alpha: 0.34, kind: 1, acurve: 1,
          r: 0.88, g: 0.88, b: 0.90, r1: 0.62, g1: 0.63, b1: 0.66
        });
      }
    }

    // ---- 阻拦索受力：钩住瞬间整根索下压并抖动 ----
    for (const [key, w] of game.cvWireFx) {
      if (!key.startsWith(team + ':')) continue;
      const ntt = w.t - dt;
      if (ntt <= 0) { game.cvWireFx.delete(key); continue; }
      game.cvWireFx.set(key, { idx: w.idx, t: ntt });
    }
    if (M.wireGroup) {
      const kids = M.wireGroup.children;
      for (let i = 0; i < C.wireZ.length; i++) {
        const wire = kids[i * 3];
        if (!wire) continue;
        let load = 0;
        for (const w of game.cvWireFx.values()) {
          if (w.idx === i) load = Math.max(load, Math.min(1, w.t / 1.2));
        }
        const sag = load * 0.55;
        const jit = load * Math.sin(t * 42) * 0.10;
        wire.position.y = C.y + 0.55 - sag + jit;
        wire.scale.x = 1 + load * 0.06;
      }
    }

    // ---- 甲板牵引：正在被拖到弹射位的飞机，轮下起摩擦烟 ----
    if (taxiByTeam[team].length) {
      for (const id of taxiByTeam[team]) {
        const v = game.views.get(id);
        if (!v || Math.random() > 0.55) continue;
        pSmoke.spawn({
          x: v.pos.x + (Math.random() - 0.5) * 6,
          y: C.y + 0.6,
          z: v.pos.z + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 2.5, vy: 0.9 + Math.random() * 1.3, vz: (Math.random() - 0.5) * 2.5,
          life: 0.7 + Math.random() * 0.8,
          s0: 2.5 + Math.random() * 2, s1: 11 + Math.random() * 8,
          alpha: 0.22, kind: 1, acurve: 1,
          r: 0.66, g: 0.64, b: 0.62, r1: 0.52, g1: 0.51, b1: 0.50
        });
      }
    }

    // ---- 甲板停机热浪：该舰上停着飞机就冒淡淡热气 ----
    const parked = (game.cvParkedN && game.cvParkedN[team]) || 0;
    if (parked > 0 && Math.random() < 0.28) {
      const p = toWorld((Math.random() - 0.5) * C.len * 0.7, (Math.random() - 0.5) * C.wid * 0.6);
      pSmoke.spawn({
        x: p.x, y: C.y + 1.2, z: p.z,
        vx: (Math.random() - 0.5) * 1.2, vy: 1.8 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 1.2,
        life: 1.4 + Math.random() * 1.2,
        s0: 4 + Math.random() * 3, s1: 16 + Math.random() * 10,
        alpha: 0.10, kind: 1, acurve: 1,
        r: 0.72, g: 0.70, b: 0.68, r1: 0.58, g1: 0.57, b1: 0.56
      });
    }
  }
}
function g_rotOf(C) { return Math.atan2(C.hx, C.hz); }

function buildAaaMesh(team) {
  const g = new THREE.Group();
  const teamCol = team === 0 ? 0x2a5f9e : 0x9e3a2a;
  // 八边形混凝土基座（带轻微色差）
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 10.5, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.35 })
  );
  base.position.y = 1.1;
  base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  // 队伍色识别环（远看就知道是敌是友）
  const ringGeo = new THREE.TorusGeometry(9.4, 0.5, 8, 24);
  ringGeo.rotateX(Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
    color: teamCol, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.4
  }));
  ring.position.y = 2.3;
  g.add(ring);
  // 炮塔座
  const house = new THREE.Mesh(
    new THREE.BoxGeometry(5.2, 2.4, 5.2),
    new THREE.MeshStandardMaterial({ color: 0x5c6152, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.4 })
  );
  house.position.y = 3.4;
  house.castShadow = true;
  g.add(house);
  // 双联炮管（pivot 绕 Y 转向 / 绕 X 抬仰角，管身沿 -Z）
  const barrelPivot = new THREE.Group();
  barrelPivot.position.y = 4.6;
  const barrelGeo = new THREE.CylinderGeometry(0.32, 0.42, 8.5, 10);
  barrelGeo.rotateX(Math.PI / 2);
  barrelGeo.translate(0, 0, -3.4);
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x3c4043, roughness: 0.6, metalness: 0.55, envMapIntensity: 0.6 });
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(barrelGeo, barrelMat);
    b.position.x = s * 0.85;
    b.castShadow = true;
    barrelPivot.add(b);
  }
  barrelPivot.rotation.x = -0.5;   // 待机 30° 仰角（rotation.x 为正是抬头）
  g.add(barrelPivot);
  return { group: g, barrel: barrelPivot };
}

// =============================================================================
// === 树木（InstancedMesh，给低空飞行提供速度参照）============================
// =============================================================================
// 树木：按格点哈希铺，玩家移动时只重算窗口内的格点。
// 全图撒点做不到“森林”密度（32km² 要几十万棵），所以只在玩家周围铺，
// 远处的林相交给地形着色器里的 canopy 层。
const TREE_CELL = 17;          // 格点间距（米）——26m 太稀，看起来是一颗颗孤立的绿锥
const TREE_RADIUS = 2600;      // 铺树半径
// 2600m 半径 / 17m 格点 = 307×307 格点，按 ~24% 命中率约 2.2 万棵。
// 上限写小的话循环会提前 break，树只铺满窗口的西半边（东边光秃秃）。
const TREE_COUNT = 30000;      // 实例上限
let treeMesh = null;
let treeAnchorX = 1e9, treeAnchorZ = 1e9;

function treeHash(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildTrees() {
  // 开口锥体（省掉看不见的底面 5 个三角面）：2.4 万棵仍然只有 12 万面
  const geo = new THREE.ConeGeometry(1, 1, 5, 1, true);
  geo.translate(0, 0.5, 0);
  // 树冠上部亮、下部暗，锥体才不会是一块纯色三角
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 0.62 + 0.38 * pos.getY(i);
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mat = new THREE.MeshLambertMaterial({
    // 树冠色必须比地表更暗、更去饱和：原来 0x55684a 被 3.1 强度的太阳一照，
    // 每棵树都成了亮绿色纸锥，跟底下的深色地表完全脱节。
    color: 0x475840, vertexColors: true, flatShading: true,
    emissive: 0x121a10, emissiveIntensity: 1.0
  });
  treeMesh = new THREE.InstancedMesh(geo, mat, TREE_COUNT);
  treeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  treeMesh.frustumCulled = false;
  treeMesh.receiveShadow = true;
  // 树投影：阴影 pass 里也只是 1 个 draw call（实例化），
  // 但近处地面会立刻多出一层树影，体积感完全不同。
  treeMesh.castShadow = true;
  scene.add(treeMesh);
  fillTrees(0, 0);
}

function fillTrees(cx, cz) {
  if (!treeMesh) return;
  const t0 = performance.now();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const cTmp = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const n = Math.ceil(TREE_RADIUS / TREE_CELL);
  const cx0 = Math.round(cx / TREE_CELL), cz0 = Math.round(cz / TREE_CELL);
  const nSq = n * n;
  let count = 0;

  // 机场包围圆：绝大多数树离机场很远，没必要每次跑 4 次机场局部坐标变换
  // （16300 棵树 × 4 个机场 = 6.5 万次三角函数，光这一项就是好几毫秒）
  const apCircles = FP.AIRPORTS.map((ap) => ({ ap, r: ap.len * 0.5 + 900 }));

  for (let ix = cx0 - n; ix <= cx0 + n && count < TREE_COUNT; ix++) {
    const dix = ix - cx0;
    for (let iz = cz0 - n; iz <= cz0 + n && count < TREE_COUNT; iz++) {
      const diz = iz - cz0;
      // 圆形窗口（方形窗口有 21% 的格点在半径外，白算）
      if (dix * dix + diz * diz > nSq) continue;
      const r1 = treeHash(ix, iz);
      // 林带：两个尺度的低频调制决定这一片是密林还是林间空地。
      // 只有 5km 尺度那一层的话，一整屏看下去密度是常数，像人工播种。
      const wx = ix * TREE_CELL, wz = iz * TREE_CELL;
      const band = Math.sin(wx * 0.0011 + 1.7) * Math.cos(wz * 0.0013 - 0.6) * 0.5 + 0.5;
      const patch = Math.sin(wx * 0.0072 + 2.3) * Math.cos(wz * 0.0061 + 0.9) * 0.5 + 0.5;
      const dens = 0.30 + 0.18 * band + 0.34 * patch;
      if (r1 > dens) continue;

      const r2 = treeHash(ix + 7919, iz - 3571);
      const r3 = treeHash(ix - 4231, iz + 6151);
      const x = wx + (r2 - 0.5) * TREE_CELL * 1.5;
      const z = wz + (r3 - 0.5) * TREE_CELL * 1.5;
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > TREE_RADIUS * TREE_RADIUS) continue;

      const hs = meshHeightSlope(x, z);
      const h = hs[0];
      if (h < 5 || h > 700) continue;
      // 陡崖上没有树（真实林线之外还有坡度限制），
      // 顺便避开网格插值最失真的地方
      if (hs[1] > 0.56) continue;
      let onAp = false;
      for (let k = 0; k < apCircles.length; k++) {
        const c = apCircles[k];
        const ax = x - c.ap.x, az = z - c.ap.z;
        if (ax * ax + az * az < c.r * c.r && FP.onAirport(c.ap, x, z, 2.6)) { onAp = true; break; }
      }
      if (onAp) continue;

      const sz = 8 + r2 * 11;         // 8~19m：再高就成巨人森林了
      p.set(x, h - 1.1, z);
      q.setFromAxisAngle(up, r3 * Math.PI * 2);
      sc.set(sz * (0.40 + r2 * 0.18), sz, sz * (0.40 + r2 * 0.18));
      m4.compose(p, q, sc);
      treeMesh.setMatrixAt(count, m4);
      const v = 0.62 + r3 * 0.34;
      cTmp.setRGB(v * 0.94, v, v * 0.82);
      treeMesh.setColorAt(count, cTmp);
      count++;
    }
  }
  treeMesh.count = count;
  treeMesh.instanceMatrix.needsUpdate = true;
  if (treeMesh.instanceColor) treeMesh.instanceColor.needsUpdate = true;
  treeAnchorX = cx;
  treeAnchorZ = cz;
  game.treeMs = performance.now() - t0;
  game.treeCount = count;
}
buildTrees();

// =============================================================================
// === 飞机模型（全程序化，低多边形）===========================================
// =============================================================================
// =============================================================================
// === 机体模型 ================================================================
// =============================================================================
// =============================================================================
// === 机体涂装：程序化蒙皮（拼缝/铆钉/检修口盖/喷字/队徽）=====================
// =============================================================================
const _skinTex = new Map();
function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

// 机身蒙皮（u 绕机身一周，v 机头→机尾）：带队徽、尾号、警示喷字
function planeSkinTexture(team) {
  const key = 'fuse' + team;
  let t = _skinTex.get(key);
  if (t) return t;
  const W = 1024, H = 512;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  const base = team === 0 ? ['#5f7488', '#6d8296', '#54687b'] : ['#6b6359', '#797066', '#5e564d']
  g.fillStyle = base[0];
  g.fillRect(0, 0, W, H);

  // 蒙皮色差（大块斑驳，模拟不同批次补漆）
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const r = 10 + Math.random() * 80;
    const c = base[1 + (i % 2)];
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, c);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.03 + Math.random() * 0.05;
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.globalAlpha = 1;

  // ---- 框（横向环缝，带断续缺口，避免像网格纸）----
  for (let y = 24; y < H; y += 26 + Math.random() * 22) {
    let x = 0;
    while (x < W) {
      const seg = 40 + Math.random() * 150;
      g.fillStyle = 'rgba(28,34,40,0.34)';
      g.fillRect(x, y, seg, 1.2);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x, y + 1.2, seg, 1);
      // 铆钉
      for (let rx = x + 4; rx < x + seg - 3; rx += 9) {
        g.fillStyle = 'rgba(30,36,42,0.30)';
        g.fillRect(rx, y + 3, 1.4, 1.4);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(rx, y + 4.4, 1.2, 1);
      }
      x += seg + 4 + Math.random() * 30;
    }
  }
  // ---- 纵向桁条 ----
  for (let x = 30; x < W; x += 46 + Math.random() * 40) {
    let y = 0;
    while (y < H) {
      const seg = 70 + Math.random() * 180;
      g.fillStyle = 'rgba(28,34,40,0.26)';
      g.fillRect(x, y, 1.1, seg);
      y += seg + 10 + Math.random() * 40;
    }
  }

  // ---- 检修口盖：带边框的矩形 / 圆形 ----
  for (let i = 0; i < 26; i++) {
    const w = 34 + Math.random() * 90, h = 26 + Math.random() * 54;
    const x = Math.random() * (W - w), y = Math.random() * (H - h);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(26,32,38,0.42)';
    g.lineWidth = 1.2;
    g.strokeRect(x + 0.5, y + 0.5, w, h);
    // 角落螺钉
    g.fillStyle = 'rgba(22,28,34,0.4)';
    for (const [dx, dy] of [[4, 4], [w - 4, 4], [4, h - 4], [w - 4, h - 4]]) {
      g.beginPath(); g.arc(x + dx, y + dy, 1.7, 0, Math.PI * 2); g.fill();
    }
  }

  // ---- 警示喷字（真实尺寸感：字高约 5cm）----
  const marks = [
    ['NO STEP', 0.10, 0.30], ['NO STEP', 0.62, 0.30],
    ['DANGER · INTAKE', 0.40, 0.62], ['RESCUE', 0.16, 0.72],
    ['LIFT HERE', 0.70, 0.70], ['GROUND', 0.86, 0.44],
    ['⚠', 0.30, 0.52], ['DO NOT PAINT', 0.04, 0.52]
  ];
  g.textBaseline = 'middle';
  for (const [txt, u, v] of marks) {
    g.save();
    g.translate(u * W, v * H);
    g.font = 'bold 10px "Consolas",monospace';
    g.fillStyle = 'rgba(238,242,246,0.55)';
    g.fillText(txt, 0, 0);
    g.strokeStyle = 'rgba(238,242,246,0.30)';
    g.lineWidth = 1;
    g.strokeRect(-3, -7, g.measureText(txt).width + 6, 14);
    g.restore();
  }

  // ---- 队徽（机身两侧各一个）----
  const accent = team === 0 ? '#4db6ff' : '#ff6b5b';
  for (const u of [0.25, 0.75]) {
    const x = u * W, y = 0.46 * H;
    g.save();
    g.translate(x, y);
    g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2);
    g.fillStyle = 'rgba(226,232,238,0.80)'; g.fill();
    g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2);
    g.strokeStyle = accent; g.lineWidth = 6; g.stroke();
    // 简化的翼形徽标
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(9, 2); g.lineTo(22, 8); g.lineTo(0, 6);
    g.lineTo(-22, 8); g.lineTo(-9, 2);
    g.closePath();
    g.fillStyle = accent; g.fill();
    g.restore();
  }

  // ---- 尾号 ----
  const num = team === 0 ? '07' : '21';
  for (const u of [0.25, 0.75]) {
    g.save();
    g.translate(u * W, 0.78 * H);
    g.font = 'bold 34px "Consolas",monospace';
    g.fillStyle = 'rgba(232,238,244,0.72)';
    g.textAlign = 'center';
    g.fillText(num, 0, 0);
    g.restore();
  }

  // ---- 油污/排气熏黑（靠机尾更重）----
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * W;
    const y = H * (0.6 + Math.random() * 0.4);
    const rg = g.createLinearGradient(x, y, x, y + 60);
    rg.addColorStop(0, 'rgba(20,22,24,0.16)');
    rg.addColorStop(1, 'rgba(20,22,24,0)');
    g.fillStyle = rg;
    g.fillRect(x - 8, y, 16 + Math.random() * 18, 60);
  }

  t = new THREE.CanvasTexture(cv);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  t.wrapS = THREE.RepeatWrapping;
  _skinTex.set(key, t);
  return t;
}

// 翼面蒙皮（可平铺，无队徽）：只放拼缝与铆钉
function panelTexture(team) {
  const key = 'panel' + team;
  let t = _skinTex.get(key);
  if (t) return t;
  const W = 256, H = 256;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = team === 0 ? '#687d91' : '#776e64';
  g.fillRect(0, 0, W, H);
  // 轻斑驳
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * W, y = Math.random() * H, r = 8 + Math.random() * 30;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,255,255,0.05)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 翼肋缝（横向）+ 桁条（纵向），保证四边可平铺
  for (let y = 0; y < H; y += 64) {
    g.fillStyle = 'rgba(30,36,42,0.30)'; g.fillRect(0, y, W, 1.2);
    g.fillStyle = 'rgba(255,255,255,0.09)'; g.fillRect(0, y + 1.2, W, 1);
    for (let x = 3; x < W; x += 8) {
      g.fillStyle = 'rgba(30,36,42,0.26)'; g.fillRect(x, y + 3, 1.3, 1.3);
    }
  }
  for (let x = 0; x < W; x += 64) {
    g.fillStyle = 'rgba(30,36,42,0.24)'; g.fillRect(x, 0, 1.2, H);
  }
  // 操纵面缝（副翼/襟翼边界）
  g.fillStyle = 'rgba(22,28,34,0.5)';
  g.fillRect(0, 196, W, 1.8);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(0, 197.8, W, 1);

  t = new THREE.CanvasTexture(cv);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.26, 0.26);
  _skinTex.set(key, t);
  return t;
}

// =============================================================================
// === 材质 / 几何体缓存 =======================================================
// =============================================================================
const _planeMats = new Map();
function planeMats(team) {
  let M = _planeMats.get(team);
  if (M) return M;
  const accent = team === 0 ? 0x8fd0ff : 0xffb9a6;
  M = {
    // 机身：蒙皮贴图 + 轻微金属感，靠环境贴图出高光
    body: new THREE.MeshStandardMaterial({
      map: planeSkinTexture(team), roughness: 0.68, metalness: 0.22, envMapIntensity: 0.7
    }),
    // 翼面：拼缝贴图
    panel: new THREE.MeshStandardMaterial({
      map: panelTexture(team), roughness: 0.62, metalness: 0.28, envMapIntensity: 0.75
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x171c21, roughness: 0.72, metalness: 0.45 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xaab4be, roughness: 0.3, metalness: 0.92, envMapIntensity: 1.1 }),
    hot: new THREE.MeshStandardMaterial({ color: 0x4a3a34, roughness: 0.55, metalness: 0.85 }),
    acc: new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.35, envMapIntensity: 1.0 }),
    // 座舱玻璃：低粗糙度 + 环境反射，深色镀膜玻璃质感
    glass: new THREE.MeshStandardMaterial({
      color: 0x2a4a56, roughness: 0.07, metalness: 0.3,
      transparent: true, opacity: 0.6, envMapIntensity: 1.4,
      side: THREE.FrontSide, depthWrite: false
    }),
    tire: new THREE.MeshStandardMaterial({ color: 0x121417, roughness: 0.95, metalness: 0.0 })
  };
  // 边缘光：狗斗时飞机经常背光，纯 PBR 会糊成一团黑剪影。
  // 沿视线方向补一圈菲涅尔冷光，任何角度都能读出机体轮廓（战雷同款做法）。
  for (const key of ['body', 'panel', 'metal', 'acc', 'hot', 'dark']) {
    const m = M[key];
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float rimF = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 3.4);
        gl_FragColor.rgb += vec3(0.30, 0.47, 0.64) * rimF * 0.42;`
      );
    };
    m.customProgramCacheKey = () => 'skyrim1';
  }
  _planeMats.set(team, M);
  return M;
}

// 叠加混合的自发光材质（枪口火光 / 航行灯共用；透明度必须静态）
const _glowMats = new Map();
function glowMat(color, opacity) {
  const key = color + '|' + opacity;
  let m = _glowMats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    _glowMats.set(key, m);
  }
  return m;
}

// 几何体按 key 全局复用：16 架飞机共用同一批顶点/索引，省显存也省 GC
const _geoCache = new Map();
function geoOnce(key, make) {
  let g = _geoCache.get(key);
  if (!g) { g = make(); _geoCache.set(key, g); }
  return g;
}

// 用 2D 平面形状挤出“带翼型厚度的翼面”：比盒子更像真飞机
// pts: [[展向x, 弦向y], ...]（弦向 y 为负=机头方向）；flip 镜像到另一侧
function extrudeWing(pts, thickness, mat, flip, bevel) {
  const sh = new THREE.Shape();
  const P = (i) => (flip ? [-pts[i][0], pts[i][1]] : pts[i]);
  sh.moveTo(P(0)[0], P(0)[1]);
  for (let i = 1; i < pts.length; i++) sh.lineTo(P(i)[0], P(i)[1]);
  sh.closePath();
  const key = 'wing_' + JSON.stringify(pts) + thickness + (flip ? 'F' : '') + (bevel === false ? 'N' : 'B');
  const geo = geoOnce(key, () => {
    const gg = new THREE.ExtrudeGeometry(sh, {
      depth: thickness,
      bevelEnabled: bevel !== false,
      bevelThickness: 0.028, bevelSize: 0.028, bevelSegments: 2, curveSegments: 1
    });
    gg.translate(0, 0, -thickness / 2);   // 厚度以中面对称
    gg.rotateX(Math.PI / 2);              // 形状X→世界X(展向)，形状Y→世界Z(弦向)，厚度→Y
    gg.computeVertexNormals();
    return gg;
  });
  return new THREE.Mesh(geo, mat);
}

// 垂直翼面：形状 (弦x, 展向y) → 弦沿Z、展向沿Y、厚度沿X
function makeFinGeo(pts, thickness) {
  const key = 'fin_' + JSON.stringify(pts) + thickness;
  return geoOnce(key, () => {
    const sh = new THREE.Shape();
    sh.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    const gg = new THREE.ExtrudeGeometry(sh, {
      depth: thickness, bevelEnabled: true,
      bevelThickness: 0.026, bevelSize: 0.026, bevelSegments: 2, curveSegments: 1
    });
    gg.translate(0, 0, -thickness / 2);
    gg.rotateY(-Math.PI / 2);            // 弦→Z，展向保持 Y，厚度→X
    gg.computeVertexNormals();
    return gg;
  });
}

// 圆角矩形（进气道外形）：Shape，用于挤出
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// =============================================================================
// === 第一人称座舱内构 ========================================================
// 独立场景渲染（cpScene），视点固定在原点、朝 -Z，仪表台可以贴到眼前 0.4m。
// 结构参考 F-16 气泡座舱：遮光罩 + 仪表台（3 块 MFD）+ HUD 组合玻璃 +
// 左右操纵台 + 中央驾驶杆 + 机头甲板 + 舱盖下沿导轨。
// =============================================================================
function mfdScreenTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const x = c.getContext('2d');
  const BG = '#07100c', FG = '#57c795';
  x.fillStyle = BG; x.fillRect(0, 0, 128, 96);
  x.strokeStyle = 'rgba(87,199,149,0.13)'; x.lineWidth = 1;
  for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo(0, i * 16); x.lineTo(128, i * 16); x.stroke(); }
  for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(i * 16, 0); x.lineTo(i * 16, 96); x.stroke(); }
  x.strokeStyle = FG; x.fillStyle = FG;
  if (kind === 0) {
    // 雷达：同心圆 + 扫描线 + 两个目标
    x.lineWidth = 1;
    for (let r = 12; r <= 40; r += 14) { x.beginPath(); x.arc(64, 52, r, 0, Math.PI * 2); x.stroke(); }
    x.beginPath(); x.moveTo(64, 52); x.lineTo(64, 6); x.stroke();
    x.globalAlpha = 0.35;
    x.beginPath(); x.arc(64, 52, 40, -0.9, -0.25); x.stroke();
    x.globalAlpha = 1;
    x.fillRect(84, 34, 3, 3); x.fillRect(44, 66, 3, 3);
  } else if (kind === 1) {
    // 发动机/系统：竖条 + 数字
    x.font = 'bold 9px monospace';
    x.fillText('ENG  96%', 8, 17); x.fillText('FUEL 72%', 8, 32);
    x.fillText('OIL  31', 8, 47); x.fillText('HYD  2A', 8, 62);
    for (let i = 0; i < 5; i++) {
      x.strokeRect(8 + i * 22, 78.5, 16, 9);
      if (i < 3) x.fillRect(8 + i * 22, 79, 16, 8);
    }
  } else {
    // 武器：挂点示意 + 余弹
    x.font = 'bold 9px monospace';
    x.fillText('AIM-9X  4', 8, 16); x.fillText('GUN 510', 8, 31);
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(16, 44); x.lineTo(112, 44); x.stroke();
    for (let i = 0; i < 4; i++) {
      x.beginPath(); x.moveTo(28 + i * 22, 50); x.lineTo(28 + i * 22, 64); x.stroke();
      x.fillRect(24 + i * 22, 60, 7, 11);
    }
    x.font = 'bold 8px monospace'; x.fillText('RDY', 8, 90);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// 仪表板正面贴图：分块拼缝 / 螺钉 / 英文标签 / 轻微磨损。
// 没有这张图，0.9m 宽的仪表台就是一整块纯色塑料，近距离一眼假。
function makePanelFaceTexture() {
  const W = 512, H = 192;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#171b1f';
  g.fillRect(0, 0, W, H);

  // 磨损与灰尘
  for (let i = 0; i < 2600; i++) {
    const v = 18 + Math.random() * 22;
    g.fillStyle = 'rgba(' + v + ',' + (v + 2) + ',' + (v + 4) + ',' + (0.25 + Math.random() * 0.35) + ')';
    g.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
  }

  // 分块：3 列 2 行
  const xs = [0, W / 3, W * 2 / 3, W];
  const ys = [0, H * 0.46, H];
  g.lineWidth = 2;
  for (const x of xs.slice(1, -1)) {
    g.strokeStyle = 'rgba(0,0,0,0.75)'; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, H - 6); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.055)'; g.beginPath(); g.moveTo(x + 2, 6); g.lineTo(x + 2, H - 6); g.stroke();
  }
  for (const y of ys.slice(1, -1)) {
    g.strokeStyle = 'rgba(0,0,0,0.75)'; g.beginPath(); g.moveTo(6, y); g.lineTo(W - 6, y); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.055)'; g.beginPath(); g.moveTo(6, y + 2); g.lineTo(W - 6, y + 2); g.stroke();
  }

  // 螺钉
  for (const x of xs) {
    for (const y of ys) {
      const px = Math.min(Math.max(x, 9), W - 9);
      const py = Math.min(Math.max(y, 9), H - 9);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.beginPath(); g.arc(px, py, 2.2, 0, 6.2832); g.fill();
      g.fillStyle = 'rgba(190,200,210,0.35)';
      g.beginPath(); g.arc(px - 0.4, py - 0.5, 1.1, 0, 6.2832); g.fill();
    }
  }

  // 标签文字（小到看不清具体字，但能提供真实的“有字”密度）
  const labels = [
    ['MASTER ARM', 14, 22], ['GUN', 14, 40], ['LASER', 14, 58],
    ['LANDING GEAR', 190, 22], ['FLAPS', 190, 40], ['BRAKE', 190, 58],
    ['TRIM', 360, 22], ['ECM', 360, 40], ['LIGHTS', 360, 58],
    ['ENGINE', 14, 112], ['FUEL', 120, 112], ['HYD', 226, 112],
    ['ELEC', 330, 112], ['OXY', 410, 112]
  ];
  g.font = 'bold 9px "Consolas", monospace';
  for (const [txt, x, y] of labels) {
    g.fillStyle = 'rgba(196,208,218,0.52)';
    g.fillText(txt, x, y);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x, y + 3, g.measureText(txt).width, 1);
  }

  // 几个拨杆/旋钮的底座
  for (let i = 0; i < 7; i++) {
    const x = 30 + i * 66, y = 150;
    g.fillStyle = 'rgba(8,10,12,0.8)';
    g.beginPath(); g.arc(x, y, 7, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(160,175,190,0.18)';
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(x, y, 7, 0, 6.2832); g.stroke();
    g.fillStyle = 'rgba(120,135,150,0.30)';
    g.fillRect(x - 1, y - 6, 2, 6);
  }

  const t = new THREE.CanvasTexture(cv);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

const _UP_Y = new THREE.Vector3(0, 1, 0);

function buildCockpit() {
  const G = new THREE.Group();
  // 眼位在原点，朝 -Z；尺寸按 F-16 座舱比例（仪表板离眼约 0.8m）
  // 面板贴图同时当自发光贴图用（强度很低）：座舱是背光环境，
  // 纯靠灯照的话丝印文字和屏幕边框会全部沉进黑里，看不出结构。
  const panelTex = makePanelFaceTexture();
  const matPanel = new THREE.MeshStandardMaterial({ color: 0xffffff, map: panelTex,
    roughness: 0.92, metalness: 0.06, envMapIntensity: 0.55,
    emissive: 0xffffff, emissiveMap: panelTex, emissiveIntensity: 0.30 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x12161a, roughness: 0.92, metalness: 0.16, envMapIntensity: 0.9 });
  const matEdge = new THREE.MeshStandardMaterial({ color: 0x2b333a, roughness: 0.62, metalness: 0.32, envMapIntensity: 0.50 });
  const matRubber = new THREE.MeshStandardMaterial({ color: 0x171c21, roughness: 0.98, metalness: 0.04, envMapIntensity: 0.4 });
  const box = (w, h, d, m, x, y, z) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    G.add(o);
    return o;
  };

  // ---- 座舱桶底：兜住向下的视线，面板边缘不会漏出天空 ----
  box(1.60, 0.05, 1.50, matDark, 0, -0.78, -0.30);

  // ---- 遮光罩：顶面受光（读得出是一块实体），前缘是软包边 ----
  const shieldTop = box(0.94, 0.014, 0.28, matEdge, 0, -0.238, -0.92);
  shieldTop.rotation.x = -0.075;
  const shieldBody = box(0.94, 0.055, 0.28, matPanel, 0, -0.270, -0.92);
  shieldBody.rotation.x = -0.075;
  const lip = box(0.95, 0.018, 0.04, matRubber, 0, -0.250, -1.055);
  lip.rotation.x = -0.075;

  // ---- 主仪表板（后倾 19°）----
  const panel = box(0.90, 0.34, 0.05, matPanel, 0, -0.405, -0.855);
  panel.rotation.x = 0.33;
  // 面板与遮光罩之间的过渡眉板，堵住缝隙
  box(0.90, 0.10, 0.03, matDark, 0, -0.262, -0.852).rotation.x = 0.33;

  // 三块 MFD：左雷达 / 中系统 / 右武器
  for (let i = 0; i < 3; i++) {
    const tex = mfdScreenTexture(i);
    const bez = box(0.198, 0.150, 0.012, matDark, (i - 1) * 0.244, -0.372, -0.822);
    bez.rotation.x = 0.32;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.166, 0.122),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0x9aaba2 }));
    scr.position.set((i - 1) * 0.244, -0.372, -0.813);
    scr.rotation.x = 0.32;
    G.add(scr);
  }

  // 面板下方的告警灯矩阵（两排）
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 8; i++) {
      const warm = (i + r) % 4 === 0;
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.024, 0.013),
        new THREE.MeshBasicMaterial({ color: warm ? 0x8a3a24 : 0x2f6b4a, toneMapped: false }));
      lamp.position.set(-0.33 + i * 0.094, -0.478 + r * 0.024, -0.786);
      lamp.rotation.x = 0.32;
      G.add(lamp);
    }
  }
  // 一排骨碌旋钮
  for (let i = 0; i < 6; i++) {
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.012, 8), matEdge);
    k.rotation.x = Math.PI / 2 - 0.33;
    k.position.set(-0.30 + i * 0.120, -0.522, -0.762);
    G.add(k);
  }

  // ---- HUD 组合玻璃的底框（只有一条窄边，不挡视线）----
  const cbFrame = new THREE.Mesh(new THREE.BoxGeometry(0.205, 0.004, 0.004), matEdge);
  cbFrame.position.set(0, -0.196, -0.66);
  cbFrame.rotation.x = 0.26;
  G.add(cbFrame);

  // ---- 左右操纵台：压在画面下角，做出“座舱包住人”的边界感 ----
  for (const s of [-1, 1]) {
    const con = box(0.34, 0.05, 0.42, matDark, s * 0.56, -0.335, -0.66);
    con.rotation.z = s * -0.10;
    con.rotation.x = -0.04;
    const conEdge = box(0.36, 0.016, 0.44, matPanel, s * 0.555, -0.311, -0.66);
    conEdge.rotation.z = s * -0.10;
    conEdge.rotation.x = -0.04;
    // 台面上的开关盒
    for (let i = 0; i < 2; i++) {
      box(0.055, 0.014, 0.032, matDark, s * 0.52, -0.306, -0.74 + i * 0.17);
    }
    // 台面到仪表板的过渡侧板，堵住角落漏光
    const sidew = box(0.03, 0.16, 0.30, matDark, s * 0.475, -0.345, -0.80);
    sidew.rotation.z = s * -0.10;
  }

  // ---- 中央驾驶杆（只露出握把顶部，压在下边缘）----
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.34, 8), matEdge);
  stick.position.set(0, -0.55, -0.52);
  stick.rotation.x = 0.10;
  G.add(stick);
  const grip = box(0.052, 0.10, 0.05, matRubber, 0, -0.365, -0.50);
  grip.rotation.x = 0.10;

  // ---- 左侧油门杆（立在左操纵台上，画面左下方能看见）----
  box(0.09, 0.03, 0.20, matDark, -0.50, -0.303, -0.68);
  const lever = box(0.024, 0.080, 0.024, matRubber, -0.49, -0.268, -0.66);
  lever.rotation.x = -0.30;

  // ---- 光照：座舱内偏暗但要能看出结构 ----
  // 之前 1.0 / 0.34 / 0.38 的组合下整个仪表台是一块黑剪影，
  // 面板贴图上的铆钉、开关、屏幕边框全看不见。
  const cpSun = new THREE.DirectionalLight(0xfff0d8, 1.35);
  cpSun.position.set(-1.6, 2.4, -1.2);
  G.add(cpSun);
  const cpAmb = new THREE.HemisphereLight(0x9dc0dd, 0x1b2026, 0.62);
  G.add(cpAmb);
  // 飞行员侧的补光：仪表板正面朝向飞行员，否则整块是黑剪影
  const cpFace = new THREE.PointLight(0xe6f0fa, 0.80, 3.2, 1.4);
  cpFace.position.set(0, 0.10, 0.45);
  G.add(cpFace);
  cpScene.userData.sun = cpSun;

  cpScene.add(G);
  return G;
}
const COCKPIT = buildCockpit();

// =============================================================================
// === 轰炸机座舱（玻璃机鼻 + 投弹手站位）=======================================
// 之前轰炸机进座舱视角看到的是战斗机座舱 —— 面板、HUD 玻璃、驾驶杆全是 F-16 的，
// 一眼就假。这里单独做一套：窄框风挡（绿屋骨架）+ 6 表仪表板 + 双发油门台
// + 升降舵配平轮 + 投弹瞄准具。同样挂在 cpScene 下，与战斗机座舱互斥显示。
// =============================================================================
function gaugeFaceTexture(kind) {
  const S = 128;
  const cv = makeCanvas(S, S);
  const x = cv.getContext('2d');
  x.fillStyle = '#0a0d0f';
  x.beginPath(); x.arc(64, 64, 63, 0, 6.2832); x.fill();
  x.strokeStyle = 'rgba(206,216,224,0.55)'; x.lineWidth = 2.4;
  x.beginPath(); x.arc(64, 64, 60, 0, 6.2832); x.stroke();
  // 刻度：从 225° 扫到 -45°（航空仪表标准 270° 行程）
  const A0 = Math.PI * 1.25, SWEEP = Math.PI * 1.5;
  const major = kind === 2 ? 9 : 8;
  x.strokeStyle = 'rgba(232,238,244,0.85)';
  x.fillStyle = 'rgba(232,238,244,0.9)';
  x.font = 'bold 13px monospace';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  for (let i = 0; i <= major * 5; i++) {
    const a = A0 + (i / (major * 5)) * SWEEP;
    const isMaj = i % 5 === 0;
    const r0 = isMaj ? 45 : 51;
    x.lineWidth = isMaj ? 2.6 : 1.2;
    x.beginPath();
    x.moveTo(64 + Math.cos(a) * r0, 64 + Math.sin(a) * r0);
    x.lineTo(64 + Math.cos(a) * 57, 64 + Math.sin(a) * 57);
    x.stroke();
    if (isMaj) {
      const n = kind === 2 ? (i / 5) * 5 : (i / 5) * (kind === 1 ? 4 : 20);
      x.fillText(String(n), 64 + Math.cos(a) * 36, 64 + Math.sin(a) * 36);
    }
  }
  // 红色危险区（转速表 / 空速表）
  if (kind !== 1) {
    x.strokeStyle = 'rgba(255,86,60,0.9)'; x.lineWidth = 4;
    x.beginPath(); x.arc(64, 64, 58, A0 + SWEEP * 0.78, A0 + SWEEP); x.stroke();
  }
  // 指针
  const na = A0 + SWEEP * (kind === 2 ? 0.32 : 0.46);
  x.strokeStyle = '#f2f6fa'; x.lineWidth = 3.4; x.lineCap = 'round';
  x.beginPath();
  x.moveTo(64 - Math.cos(na) * 10, 64 - Math.sin(na) * 10);
  x.lineTo(64 + Math.cos(na) * 50, 64 + Math.sin(na) * 50);
  x.stroke();
  x.fillStyle = '#22282c';
  x.beginPath(); x.arc(64, 64, 7, 0, 6.2832); x.fill();
  x.strokeStyle = 'rgba(210,220,228,0.5)'; x.lineWidth = 1.6;
  x.beginPath(); x.arc(64, 64, 7, 0, 6.2832); x.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildBomberCockpit() {
  const G = new THREE.Group();
  G.visible = false;
  const panelTex = makePanelFaceTexture();
  const matPanel = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: panelTex, roughness: 0.92, metalness: 0.06, envMapIntensity: 0.55,
    emissive: 0xffffff, emissiveMap: panelTex, emissiveIntensity: 0.26
  });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.93, metalness: 0.18, envMapIntensity: 0.85 });
  const matEdge = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.6, metalness: 0.35, envMapIntensity: 0.5 });
  const matRubber = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.98, metalness: 0.04, envMapIntensity: 0.4 });
  const matPrimer = new THREE.MeshStandardMaterial({ color: 0x3c4a3f, roughness: 0.86, metalness: 0.2, envMapIntensity: 0.45 });
  const box = (w, h, d, m, x, y, z) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    G.add(o);
    return o;
  };

  // ---- 舱底 / 侧壁：把向下的视线兜住，别露出天空 ----
  box(1.70, 0.05, 1.90, matDark, 0, -0.74, -0.35);
  for (const s of [-1, 1]) {
    const sw = box(0.04, 0.42, 1.70, matPrimer, s * 0.72, -0.54, -0.40);
    sw.rotation.z = s * 0.10;
  }

  // ---- 风挡：绿屋骨架（两侧 A 柱 + 顶弓 + 两根斜撑），中间留出干净视场 ----
  const bar = (ax, ay, az, bx, by, bz, r, m) => {
    const g2 = tubeBetween(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), r, r, m, 6);
    if (g2) G.add(g2);
    return g2;
  };
  for (const s of [-1, 1]) {
    bar(s * 0.30, -0.10, -1.62, s * 0.50, 0.42, -0.30, 0.026, matEdge);   // A 柱
    bar(s * 0.30, -0.10, -1.62, s * 0.56, -0.34, -0.55, 0.020, matEdge);   // 下框
  }
  bar(-0.52, 0.44, -0.28, 0.52, 0.44, -0.28, 0.028, matEdge);             // 顶弓
  bar(-0.30, -0.10, -1.62, 0, -0.34, -1.62, 0.020, matEdge);
  bar(0.30, -0.10, -1.62, 0, -0.34, -1.62, 0.020, matEdge);
  // 顶弓到机鼻的两根斜框（形成绿屋的三角形分格）
  for (const s of [-1, 1]) bar(s * 0.50, 0.42, -0.30, s * 0.16, 0.06, -1.55, 0.016, matEdge);

  // ---- 遮光罩 + 主仪表板 ----
  const shield = box(1.08, 0.05, 0.30, matPanel, 0, -0.20, -0.92);
  shield.rotation.x = -0.10;
  const shieldLip = box(1.10, 0.02, 0.05, matRubber, 0, -0.185, -1.06);
  shieldLip.rotation.x = -0.10;
  const panel = box(1.06, 0.36, 0.05, matPanel, 0, -0.40, -0.86);
  panel.rotation.x = 0.30;
  box(1.06, 0.09, 0.03, matDark, 0, -0.225, -0.865).rotation.x = 0.30;

  // ---- 6 只圆形仪表（空速 / 高度 / 转速 / 升降速度 / 油量 / 滑油）----
  const gaugeKinds = [0, 1, 2, 1, 0, 1];
  for (let i = 0; i < 6; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    const gx = (col - 1) * 0.325, gy = -0.335 - row * 0.135;
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.030, 18), matDark);
    bezel.rotation.x = Math.PI / 2 + 0.30;
    bezel.position.set(gx, gy, -0.836);
    G.add(bezel);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.062, 22),
      new THREE.MeshBasicMaterial({ map: gaugeFaceTexture(gaugeKinds[i]), toneMapped: false, color: 0xb9c4cc }));
    face.position.set(gx, gy, -0.852);
    face.rotation.x = 0.30;
    face.rotation.y = Math.PI;
    G.add(face);
  }
  // 面板下的告警灯 + 磁罗盘
  for (let i = 0; i < 6; i++) {
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.030, 0.014),
      new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0x8f3a22 : 0x2f6b4a, toneMapped: false }));
    lamp.position.set(-0.30 + i * 0.062, -0.545, -0.815);
    lamp.rotation.x = 0.30;
    lamp.rotation.y = Math.PI;
    G.add(lamp);
  }
  const compass = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 12), matDark);
  compass.rotation.x = Math.PI / 2;
  compass.position.set(0, -0.05, -1.02);
  G.add(compass);

  // ---- 驾驶盘（轰炸机是盘式，不是战斗机的中置杆）----
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.024, 0.42, 8), matEdge);
  col.position.set(0, -0.60, -0.56);
  col.rotation.x = 0.12;
  G.add(col);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.020, 6, 20), matRubber);
  wheel.position.set(0, -0.44, -0.60);
  wheel.rotation.x = 1.05;
  G.add(wheel);
  for (let i = 0; i < 3; i++) {
    const sp = box(0.020, 0.135, 0.014, matEdge, 0, -0.44, -0.60);
    sp.rotation.z = i * Math.PI / 3;
    sp.rotation.x = 1.05;
  }

  // ---- 双发油门台（左侧）：两根油门杆 + 桨距杆 + 混油气杆 ----
  const quad = box(0.20, 0.05, 0.34, matDark, -0.50, -0.34, -0.62);
  quad.rotation.x = -0.12;
  for (let i = 0; i < 3; i++) {
    const lv = box(0.022, 0.115, 0.022, i === 2 ? matRubber : matEdge, -0.545 + i * 0.045, -0.285, -0.66);
    lv.rotation.x = -0.34 + i * 0.06;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), i === 2 ? matRubber : matPrimer);
    knob.position.set(-0.545 + i * 0.045, -0.232, -0.638);
    G.add(knob);
  }
  // 配平轮（左舷）
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 5, 14), matEdge);
  trim.position.set(-0.52, -0.50, -0.88);
  trim.rotation.y = Math.PI / 2;
  G.add(trim);

  // ---- 投弹瞄准具（左前方，垂直稳定器 + 目镜 + 控制盒）----
  const sight = new THREE.Group();
  const sBase = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.10, 10), matDark);
  sBase.position.set(-0.30, -0.30, -1.06);
  sight.add(sBase);
  const sCol = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.28, 8), matEdge);
  sCol.position.set(-0.30, -0.16, -1.06);
  sight.add(sCol);
  const sHead = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.20), matDark);
  sHead.position.set(-0.30, 0.00, -1.06);
  sight.add(sHead);
  const sLens = new THREE.Mesh(new THREE.CircleGeometry(0.042, 16),
    new THREE.MeshStandardMaterial({ color: 0x2c4a58, roughness: 0.06, metalness: 0.5, envMapIntensity: 1.4 }));
  sLens.position.set(-0.30, 0.00, -1.162);
  sLens.rotation.y = Math.PI;
  sight.add(sLens);
  G.add(sight);

  // ---- 右侧无线电 / 氧气瓶 ----
  box(0.26, 0.24, 0.20, matDark, 0.50, -0.48, -0.86);
  box(0.20, 0.10, 0.16, matEdge, 0.50, -0.35, -0.86);
  const oxy = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 10), matPrimer);
  oxy.position.set(0.58, -0.56, -0.72);
  oxy.rotation.z = 0.18;
  G.add(oxy);

  // ---- 光照：太阳从风挡射进来（随机身姿态转动）+ 面板补光 ----
  const cpSun = new THREE.DirectionalLight(0xfff0d8, 1.30);
  cpSun.position.set(-1.2, 2.2, -1.6);
  G.add(cpSun);
  const cpAmb = new THREE.HemisphereLight(0x9dc0dd, 0x141a1f, 0.55);
  G.add(cpAmb);
  const cpFace = new THREE.PointLight(0xe6f0fa, 0.62, 2.6, 1.5);
  cpFace.position.set(0, -0.10, -0.30);
  G.add(cpFace);

  G.userData.sun = cpSun;
  cpScene.add(G);
  return G;
}
const BOMBER_COCKPIT = buildBomberCockpit();


// =============================================================================
// === 通用曲面工具：翼型放样 / 超椭圆机身放样 / 双点圆管 ======================
// 战斗机与轰炸机共用同一套"曲面语言"：
//   机翼/尾翼 = NACA 对称翼型沿展向放样（有厚度、有圆前缘、有翼尖收口）
//   机身     = 超椭圆剖面沿轴向放样（上半圆、下半平，机腹才能是弹舱）
//   拉杆/钢索 = 两点之间的圆管
// 原来轰炸机用 Box 拼，近看就是一堆方盒子，这是"丑"的根因。
// =============================================================================
function airfoilSurface(stations, opt) {
  const o = opt || {};
  const n = o.samples || 10;
  const S = o.span || [1, 0, 0];
  const T = o.thick || [0, 1, 0];
  const mir = o.mirror ? -1 : 1;
  const naca = (xa) => 0.2969 * Math.sqrt(xa) - 0.126 * xa - 0.3516 * xa * xa
    + 0.2843 * xa * xa * xa - 0.1015 * xa * xa * xa * xa;
  // 归一化环：上表面 TE→LE，再下表面 LE→TE（闭合）
  const ring = [];
  for (let i = n; i >= 0; i--) { const xa = i / n; ring.push([xa, 1]); }
  for (let i = 1; i < n; i++) { const xa = i / n; ring.push([xa, -1]); }
  const L = ring.length;
  const pos = [], uv = [], idx = [];
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    for (let j = 0; j < L; j++) {
      const xa = ring[j][0], sign = ring[j][1];
      const th = sign * 5 * st.t * naca(xa) * st.c;
      const px = mir * (S[0] * st.p) + T[0] * th;
      const py = S[1] * st.p + (st.off || 0) + T[1] * th;
      const pz = S[2] * st.p + st.le + xa * st.c;
      pos.push(px, py, pz);
      uv.push(xa * st.c * 0.34, st.p * 0.34);
    }
  }
  for (let s = 0; s < stations.length - 1; s++) {
    for (let j = 0; j < L; j++) {
      const j2 = (j + 1) % L;
      const a = s * L + j, b = s * L + j2, c = (s + 1) * L + j2, d = (s + 1) * L + j;
      if (mir > 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  // 翼尖封口：最后一个剖面的重心做扇形，避免露出空心
  if (o.cap !== false) {
    const last = stations[stations.length - 1];
    const base = pos.length / 3;
    pos.push(mir * S[0] * last.p, S[1] * last.p + (last.off || 0), S[2] * last.p + last.le + last.c * 0.45);
    uv.push(0.5, last.p * 0.34);
    const off = (stations.length - 1) * L;
    for (let j = 0; j < L; j++) {
      const j2 = (j + 1) % L;
      if (mir > 0) idx.push(base, off + j, off + j2);
      else idx.push(base, off + j2, off + j);
    }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.setIndex(idx);
  gg.computeVertexNormals();
  return gg;
}

// 超椭圆剖面放样：stations = [{ z, w, h, y, nTop, nBot }]
//   w/h  = 半宽 / 半高
//   nTop = 上半部方形度（2 = 椭圆，3 = 方肩），nBot 同理控制机腹平坦度
// 上下两端自动封口（风扇三角），所以机身不会露出空腔。
function loftHull(stations, seg) {
  const S = seg || 24, N = stations.length;
  const pos = [], uv = [], idx = [];
  const ringPt = (st, a) => {
    const cx = Math.cos(a), sy = Math.sin(a);
    const n = sy >= 0 ? (st.nTop || 2.1) : (st.nBot || 2.8);
    const k = 2 / n;
    return [
      Math.sign(cx) * Math.pow(Math.abs(cx), k) * st.w,
      Math.sign(sy) * Math.pow(Math.abs(sy), k) * st.h + (st.y || 0),
      st.z
    ];
  };
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < S; i++) {
      const p = ringPt(stations[s], (i / S) * Math.PI * 2);
      pos.push(p[0], p[1], p[2]);
      uv.push(i / S, stations[s].z * 0.09);
    }
  }
  for (let s = 0; s < N - 1; s++) {
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const a = s * S + i, b = s * S + j, c = (s + 1) * S + j, d = (s + 1) * S + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  // 首端封口（朝 -Z）：反向绕序，否则法线朝里
  for (const [si, flip] of [[0, true], [N - 1, false]]) {
    const st = stations[si];
    const base = pos.length / 3;
    pos.push(0, st.y || 0, st.z);
    uv.push(0.5, 0.5);
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const a = si * S + i, b = si * S + j;
      if (flip) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.setIndex(idx);
  gg.computeVertexNormals();
  return gg;
}

// 两点之间的圆管（起落架支柱 / 座舱框 / 天线 / 张线）
function tubeBetween(a, b, r0, r1, mat, seg) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-4) return null;
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg || 7, 1, false);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_UP_Y, dir.normalize());
  return m;
}

// 弹舱内壁：只看内侧（DoubleSide），从下往上看是"洞"而不是一块实心
let _bayMat = null;
function bombBayMat() {
  if (!_bayMat) {
    _bayMat = new THREE.MeshStandardMaterial({
      color: 0x0b0e11, roughness: 0.95, metalness: 0.28,
      side: THREE.DoubleSide, envMapIntensity: 0.25
    });
  }
  return _bayMat;
}

// 螺旋桨高速旋转的模糊盘：径向渐变，中段几乎透明、桨尖一圈发白
let _propDiscTex = null;
function propDiscTexture() {
  if (_propDiscTex) return _propDiscTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 3, 64, 64, 64);
  gr.addColorStop(0.00, 'rgba(220,232,244,0)');
  gr.addColorStop(0.45, 'rgba(220,232,244,0.05)');
  gr.addColorStop(0.80, 'rgba(232,242,252,0.16)');
  gr.addColorStop(0.96, 'rgba(245,250,255,0.42)');
  gr.addColorStop(1.00, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.beginPath(); x.arc(64, 64, 64, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _propDiscTex = t;
  return t;
}

// === 轰炸机：双发中单翼 · 玻璃机鼻 · 内埋弹舱 · 双垂尾 ======================
// 参照 B-25 级中型轰炸机：玻璃机鼻（投弹手舱）+ 双 R-2600 星型发动机 + 前三点
// 起落架 + 双垂尾 + 背/腹/腰炮塔。定位：反舰平台，慢、重、皮厚、自卫火力密。
// 全部用翼型/超椭圆放样建面；动态件（螺旋桨/弹舱门/起落架/舵面）单独打 dyn。
function buildBomberMesh(team) {
  const g = new THREE.Group();
  const M = planeMats(team);
  const shell = new THREE.Group();
  g.add(shell);
  const bayMat = bombBayMat();

  const addMesh = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    if (x !== undefined) m.position.set(x, y, z);
    shell.add(m);
    return m;
  };
  const boxM = (w, h, d, mat, x, y, z) => addMesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const bar = (ax, ay, az, bx, by, bz, r, mat, seg) =>
    tubeBetween(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), r, r, mat, seg);

  // ---------------------------------------------------------------- 机身 ----
  const HULL = [
    [-6.98, 1.19, 1.14, 0.00, 2.10, 2.70],
    [-6.30, 1.24, 1.22, 0.00, 2.10, 2.80],
    [-5.10, 1.27, 1.30, 0.00, 2.10, 2.85],
    [-3.30, 1.29, 1.36, 0.00, 2.10, 2.90],
    [-1.10, 1.30, 1.38, 0.01, 2.20, 2.90],
    [1.50, 1.27, 1.34, 0.03, 2.20, 2.85],
    [3.40, 1.18, 1.25, 0.06, 2.20, 2.75],
    [5.20, 1.02, 1.10, 0.09, 2.20, 2.65],
    [6.60, 0.80, 0.88, 0.12, 2.30, 2.55],
    [7.70, 0.54, 0.60, 0.15, 2.30, 2.45],
    [8.40, 0.30, 0.34, 0.17, 2.40, 2.40],
    [8.78, 0.12, 0.14, 0.18, 2.40, 2.40]
  ].map((p) => ({ z: p[0], w: p[1], h: p[2], y: p[3], nTop: p[4], nBot: p[5] }));
  addMesh(geoOnce('bmHull', () => loftHull(HULL, 28)), M.body);

  // 贴合超椭圆剖面的"箍"：用同一条放样曲线生成一圈薄环，
  // 用 Torus 套椭圆会埋在机身里（超椭圆在 45° 处比椭圆更鼓），所以必须按剖面重建
  const hullBand = (st, thick, mat, grow) => {
    const k = 1 + (grow || 0.006);
    const mesh = addMesh(loftHull([
      { z: st.z - thick * 0.5, w: st.w * k, h: st.h * k, y: st.y, nTop: st.nTop, nBot: st.nBot },
      { z: st.z + thick * 0.5, w: st.w * k, h: st.h * k, y: st.y, nTop: st.nTop, nBot: st.nBot }
    ], 30), mat);
    return mesh;
  };
  // 机身分模线（两圈暗色细箍）+ 后机身队色带
  for (const zz of [-1.10, 3.40]) {
    hullBand(HULL.find((s) => Math.abs(s.z - zz) < 0.4) || HULL[4], 0.05, M.dark, 0.004);
  }
  hullBand(HULL[7], 0.46, M.acc, 0.010);

  // ------------------------------------------------------------ 玻璃机鼻 ----
  const NOSE = [
    [-9.34, 0.24, 0.20, -0.05, 2.0, 2.4],
    [-9.06, 0.56, 0.48, -0.04, 2.0, 2.4],
    [-8.70, 0.80, 0.70, -0.03, 2.0, 2.5],
    [-8.25, 0.96, 0.86, -0.02, 2.0, 2.5],
    [-7.75, 1.06, 0.98, 0.00, 2.0, 2.6],
    [-7.30, 1.13, 1.07, 0.00, 2.05, 2.65],
    [-6.98, 1.19, 1.14, 0.00, 2.10, 2.70]
  ].map((p) => ({ z: p[0], w: p[1], h: p[2], y: p[3], nTop: p[4], nBot: p[5] }));
  addMesh(geoOnce('bmNose', () => loftHull(NOSE, 24)), M.glass);

  // 机鼻玻璃框：横向环肋（贴合每一站剖面）+ 纵向框条（沿曲面走折线）
  const noseBand = (st, thick, rr) => addMesh(loftHull([
    { z: st.z - thick * 0.5, w: st.w + rr, h: st.h + rr, y: st.y, nTop: st.nTop, nBot: st.nBot },
    { z: st.z + thick * 0.5, w: st.w + rr, h: st.h + rr, y: st.y, nTop: st.nTop, nBot: st.nBot }
  ], 26), M.dark);
  for (const k of [1, 2, 3, 4, 5]) noseBand(NOSE[k], 0.045, k === 5 ? 0.030 : 0.020);
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2 + Math.PI / 8;
    for (let k = 0; k < NOSE.length - 1; k++) {
      const p0 = NOSE[k], p1 = NOSE[k + 1];
      const n0 = Math.sin(ang) >= 0 ? p0.nTop : p0.nBot;
      const n1 = Math.sin(ang) >= 0 ? p1.nTop : p1.nBot;
      const kx = 2 / n0, kx1 = 2 / n1;
      const c = Math.cos(ang), s = Math.sin(ang);
      const x0 = Math.sign(c) * Math.pow(Math.abs(c), kx) * p0.w;
      const y0 = Math.sign(s) * Math.pow(Math.abs(s), kx) * p0.h + p0.y;
      const x1 = Math.sign(c) * Math.pow(Math.abs(c), kx1) * p1.w;
      const y1 = Math.sign(s) * Math.pow(Math.abs(s), kx1) * p1.h + p1.y;
      shell.add(bar(x0, y0, p0.z, x1, y1, p1.z, 0.019, M.dark, 5));
    }
  }
  // 投弹手舱内的深色隔板：从外面看进去不是一个透空的壳
  boxM(1.30, 0.10, 1.90, M.dark, 0, -0.62, -8.20);
  boxM(0.34, 0.42, 0.40, M.dark, 0, -0.34, -8.05);   // 投弹瞄准具基座

  // -------------------------------------------------------------- 驾驶舱 ----
  // 上凸的阶梯座舱：玻璃罩 + 三根环框 + 风挡 A 柱
  const CANOPY = [
    { z: -6.66, w: 0.50, h: 0.30, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -6.32, w: 0.62, h: 0.42, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -5.72, w: 0.69, h: 0.49, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -5.14, w: 0.65, h: 0.45, y: 1.02, nTop: 2.4, nBot: 2.4 },
    { z: -4.94, w: 0.52, h: 0.34, y: 1.02, nTop: 2.4, nBot: 2.4 }
  ];
  addMesh(geoOnce('bmCanopy', () => loftHull(CANOPY, 20)), M.glass);
  for (const k of [1, 2, 3]) {
    const st = CANOPY[k];
    addMesh(loftHull([
      { z: st.z - 0.022, w: st.w + 0.018, h: st.h + 0.018, y: st.y, nTop: 2.4, nBot: 2.4 },
      { z: st.z + 0.022, w: st.w + 0.018, h: st.h + 0.018, y: st.y, nTop: 2.4, nBot: 2.4 }
    ], 20), M.dark);
  }
  for (const s of [-1, 1]) {
    shell.add(bar(s * 0.34, 1.06, -6.60, s * 0.50, 1.50, -5.70, 0.020, M.dark, 5));
  }
  // 侧窗（机身两侧各三扇）
  for (const s of [-1, 1]) {
    for (const zz of [-4.55, -3.55, -2.55]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.30), M.glass);
      w.position.set(s * 1.283, 0.34, zz);
      w.rotation.y = s * Math.PI / 2;
      shell.add(w);
    }
  }

  // ---------------------------------------------------------------- 主翼 ----
  const WING = [
    { p: 1.10, le: -1.42, c: 4.45, off: 0.34, t: 0.072 },
    { p: 2.30, le: -1.16, c: 4.12, off: 0.45, t: 0.068 },
    { p: 3.70, le: -0.74, c: 3.66, off: 0.58, t: 0.064 },
    { p: 5.40, le: -0.20, c: 3.12, off: 0.73, t: 0.059 },
    { p: 7.20, le: 0.38, c: 2.54, off: 0.89, t: 0.055 },
    { p: 8.90, le: 0.94, c: 1.96, off: 1.04, t: 0.051 },
    { p: 10.10, le: 1.30, c: 1.50, off: 1.15, t: 0.048 },
    { p: 10.62, le: 1.46, c: 1.24, off: 1.20, t: 0.046 }
  ];
  for (const s of [-1, 1]) {
    addMesh(airfoilSurface(WING, { mirror: s < 0 }), M.panel);
    // 翼根整流（把机身与机翼之间的夹角填成曲面，不然是硬折角）
    addMesh(airfoilSurface([
      { p: 1.05, le: -1.30, c: 3.30, off: 0.30, t: 0.11 },
      { p: 1.70, le: -1.28, c: 3.55, off: 0.36, t: 0.09 },
      { p: 2.25, le: -1.20, c: 3.80, off: 0.42, t: 0.08 }
    ], { mirror: s < 0 }), M.body);
    // 前缘缝翼分缝线（一条贴前缘的暗线，读出机翼是分段的）
    addMesh(airfoilSurface([
      { p: 1.60, le: -1.30, c: 0.34, off: 0.38, t: 0.055 },
      { p: 5.40, le: -0.22, c: 0.30, off: 0.72, t: 0.052 },
      { p: 8.90, le: 0.90, c: 0.26, off: 1.03, t: 0.050 },
      { p: 10.55, le: 1.42, c: 0.22, off: 1.19, t: 0.048 }
    ], { mirror: s < 0 }), M.dark);
    // 翼尖队色条
    addMesh(airfoilSurface([
      { p: 9.90, le: 1.24, c: 1.52, off: 1.13, t: 0.049 },
      { p: 10.58, le: 1.43, c: 1.20, off: 1.19, t: 0.047 }
    ], { mirror: s < 0 }), M.acc);
  }

  // ------------------------------------------------- 副翼（可动，跟滚转）----
  const ailerons = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 6.40, 0.80, 2.42);
    const geo = airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.60, off: 0.00, t: 0.060 },
      { p: 2.50, le: 0.05, c: 0.50, off: 0.19, t: 0.056 },
      { p: 4.10, le: 0.02, c: 0.34, off: 0.34, t: 0.052 }
    ], { mirror: s < 0 });
    const m = new THREE.Mesh(geo, M.panel);
    grp.add(m);
    grp.userData.sign = s;
    shell.add(grp);
    ailerons.push(grp);
  }

  // -------------------------------------------------------------- 发动机 ----
  const PROP_X = 3.68, PROP_Y = 0.28;
  const NAC = [
    [-2.42, 0.80, 0.80, 0.00],
    [-2.22, 0.94, 0.94, 0.00],
    [-1.70, 0.98, 0.98, 0.00],
    [-0.60, 0.96, 0.96, 0.00],
    [0.55, 0.88, 0.88, 0.00],
    [1.45, 0.74, 0.74, 0.00],
    [2.10, 0.54, 0.54, 0.00],
    [2.48, 0.30, 0.30, 0.00]
  ].map((p) => ({ z: p[0], w: p[1], h: p[1], y: 0, nTop: 2.0, nBot: 2.0 }));
  const nacGeo = geoOnce('bmNac', () => loftHull(NAC, 22));
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(nacGeo, M.body);
    nac.position.set(s * PROP_X, PROP_Y, 0);
    shell.add(nac);
    // 整流罩唇口（进气口翻边）
    const lip = new THREE.Mesh(geoOnce('bmCowlLip', () => new THREE.TorusGeometry(0.93, 0.075, 6, 26)), M.metal);
    lip.position.set(s * PROP_X, PROP_Y, -2.30);
    shell.add(lip);
    // 进气口内的黑暗 + 星型发动机气缸（从正面能看见 9 个缸头）
    const dark = new THREE.Mesh(geoOnce('bmCowlDark', () => new THREE.CircleGeometry(0.86, 22)), M.dark);
    dark.position.set(s * PROP_X, PROP_Y, -2.19);
    dark.rotation.y = Math.PI;
    shell.add(dark);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const cyl = boxM(0.20, 0.20, 0.40, M.hot,
        s * PROP_X + Math.cos(a) * 0.62, PROP_Y + Math.sin(a) * 0.62, -2.12);
      cyl.rotation.z = a;
    }
    // 整流罩散热 flap 环
    const flapRing = new THREE.Mesh(geoOnce('bmCowlFlap', () => new THREE.TorusGeometry(0.905, 0.028, 4, 26)), M.dark);
    flapRing.position.set(s * PROP_X, PROP_Y, -0.62);
    shell.add(flapRing);
    // 排气管（每侧 3 根，从罩壳侧下方伸出来）
    for (let i = 0; i < 3; i++) {
      const zz = -1.30 + i * 0.52;
      const ex = boxM(0.16, 0.13, 0.26, M.hot, s * (PROP_X + 0.86), PROP_Y - 0.52, zz);
      ex.rotation.x = 0.24;
    }
  }

  // ------------------------------------------------------------ 螺旋桨 ----
  const propDiscMat = new THREE.MeshBasicMaterial({
    map: propDiscTexture(), transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const bladeGeo = geoOnce('bmBlade', () => airfoilSurface([
    { p: 0.20, le: -0.15, c: 0.24, off: 0, t: 0.17 },
    { p: 0.62, le: -0.14, c: 0.30, off: 0, t: 0.12 },
    { p: 1.24, le: -0.13, c: 0.27, off: 0, t: 0.10 },
    { p: 1.86, le: -0.11, c: 0.19, off: 0, t: 0.09 },
    { p: 1.96, le: -0.09, c: 0.13, off: 0, t: 0.08 }
  ], { span: [0, 1, 0], thick: [1, 0, 0], samples: 8 }));
  const props = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * PROP_X, PROP_Y, -2.62);
    // 桨毂整流罩
    const spinner = new THREE.Mesh(geoOnce('bmSpinner', () => {
      const geo = new THREE.ConeGeometry(0.30, 0.66, 16);
      geo.rotateX(-Math.PI / 2);
      return geo;
    }), M.metal);
    spinner.position.z = -0.26;
    grp.add(spinner);
    const spTip = new THREE.Mesh(geoOnce('bmSpinnerTip', () => new THREE.SphereGeometry(0.075, 8, 6)), M.acc);
    spTip.position.z = -0.60;
    grp.add(spTip);
    // 3 片桨叶：绕 Y 拧一个桨距角，再绕 Z 均分 120°
    for (let i = 0; i < 3; i++) {
      const bl = new THREE.Mesh(bladeGeo, M.dark);
      bl.rotation.order = 'YZX';
      bl.rotation.y = 0.42;
      bl.rotation.z = (i / 3) * Math.PI * 2;
      grp.add(bl);
    }
    // 模糊盘
    const disc = new THREE.Mesh(geoOnce('bmDisc', () => new THREE.CircleGeometry(1.98, 40)), propDiscMat);
    disc.position.z = -0.04;
    grp.add(disc);
    shell.add(grp);
    props.push({ grp, disc });
  }

  // ---------------------------------------------------------------- 尾翼 ----
  const TAIL_Y = 0.12;
  for (const s of [-1, 1]) {
    addMesh(airfoilSurface([
      { p: 0.34, le: 6.32, c: 2.34, off: 0.10, t: 0.062 },
      { p: 1.60, le: 6.66, c: 1.98, off: 0.15, t: 0.058 },
      { p: 2.90, le: 7.02, c: 1.56, off: 0.20, t: 0.054 },
      { p: 4.10, le: 7.32, c: 1.16, off: 0.23, t: 0.050 },
      { p: 4.62, le: 7.46, c: 0.92, off: 0.24, t: 0.048 }
    ], { mirror: s < 0 }), M.panel);
  }
  // 平尾升降舵（可动）
  const elevators = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 0.52, TAIL_Y + 0.10, 8.16);
    grp.add(new THREE.Mesh(airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.52, off: 0.00, t: 0.060 },
      { p: 1.70, le: 0.10, c: 0.44, off: 0.05, t: 0.056 },
      { p: 3.60, le: 0.18, c: 0.34, off: 0.12, t: 0.050 }
    ], { mirror: s < 0 }), M.panel));
    shell.add(grp);
    elevators.push(grp);
  }
  // 双垂尾（外倾 6°）+ 方向舵（可动）
  const CANT = 0.10;
  const rudders = [];
  for (const s of [-1, 1]) {
    const finSpan = [Math.sin(CANT) * s, Math.cos(CANT), 0];
    const finThick = [Math.cos(CANT), -Math.sin(CANT) * s, 0];
    addMesh(airfoilSurface([
      { p: 0.00, le: 6.55, c: 2.16, off: 0, t: 0.075 },
      { p: 0.72, le: 6.88, c: 1.94, off: 0, t: 0.068 },
      { p: 1.46, le: 7.24, c: 1.62, off: 0, t: 0.060 },
      { p: 2.06, le: 7.56, c: 1.22, off: 0, t: 0.054 },
      { p: 2.42, le: 7.76, c: 0.86, off: 0, t: 0.050 }
    ], { span: finSpan, thick: finThick, samples: 10 }), M.panel).position.set(s * 3.86, TAIL_Y + 0.24, 0);
    // 垂尾顶队色
    const tip = boxM(0.085, 0.14, 0.78, M.acc, s * (3.86 + Math.sin(CANT) * 2.40), TAIL_Y + 0.24 + Math.cos(CANT) * 2.40, 8.10);
    tip.rotation.z = -s * CANT;
    // 方向舵
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(s * 3.86, TAIL_Y + 0.24, 8.22);
    grp.add(new THREE.Mesh(airfoilSurface([
      { p: 0.00, le: 0.00, c: 0.50, off: 0, t: 0.070 },
      { p: 0.90, le: 0.06, c: 0.42, off: 0, t: 0.064 },
      { p: 1.86, le: 0.10, c: 0.32, off: 0, t: 0.056 },
      { p: 2.30, le: 0.06, c: 0.22, off: 0, t: 0.050 }
    ], { span: finSpan, thick: finThick, samples: 8 }), M.panel));
    shell.add(grp);
    rudders.push(grp);
  }

  // ------------------------------------------------------- 炮塔 / 机枪 ----
  // muzzles 只放**前射**炮口（玩家开火的弹道起点）；防御炮塔的炮口单独记在
  // turrets 里，不能混进这个数组，否则玩家扣扳机会从背/腹炮塔吐子弹。
  const muzzles = [];
  const mkGun = (x0, y0, z0, x1, y1, z1, r) => {
    const barrel = bar(x0, y0, z0, x1, y1, z1, r || 0.055, M.dark, 6);
    if (barrel) shell.add(barrel);
    muzzles.push(new THREE.Vector3(x1, y1, z1));
    return barrel;
  };
  // 机鼻 2×12.7mm 前射机枪
  for (const s of [-1, 1]) {
    boxM(0.26, 0.24, 0.34, M.dark, s * 0.30, -0.30, -8.62);
    mkGun(s * 0.30, -0.32, -8.66, s * 0.30, -0.34, -9.30, 0.048);
  }
  // 背部炮塔：半圆罩 + 双联装
  // 改成可转动的 Group：罩壳 + 两根枪管整体绕 Y 转、枪管绕 X 俯仰，
  // 这样被咬尾时能看到炮塔转过来对着你（原来是一块焊死的半球 + 两根斜棍）。
  const topT = new THREE.Mesh(new THREE.SphereGeometry(0.54, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), M.panel);
  topT.position.set(0, 1.30, -3.30);
  shell.add(topT);
  const topTurret = new THREE.Group();
  topTurret.userData.dyn = true;
  topTurret.position.set(0, 1.34, -3.30);
  const topGunGrp = new THREE.Group();
  for (const s of [-1, 1]) {
    const b = bar(s * 0.13, 0.10, -0.20, s * 0.13, 0.16, -1.10, 0.045, M.dark, 6);
    if (b) topGunGrp.add(b);
  }
  topTurret.add(topGunGrp);
  shell.add(topTurret);

  // 腹部球型炮塔（同样可转）
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 10, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55), M.panel);
  ball.position.set(0, -1.30, 1.95);
  shell.add(ball);
  const bellyTurret = new THREE.Group();
  bellyTurret.userData.dyn = true;
  bellyTurret.position.set(0, -1.34, 1.95);
  const bellyGunGrp = new THREE.Group();
  for (const s of [-1, 1]) {
    const b = bar(s * 0.11, -0.08, 0.30, s * 0.11, -0.16, 1.00, 0.042, M.dark, 6);
    if (b) bellyGunGrp.add(b);
  }
  bellyTurret.add(bellyGunGrp);
  shell.add(bellyTurret);
  // 腰部机枪（两侧舷窗，向后）
  for (const s of [-1, 1]) {
    mkGun(s * 1.24, 0.10, 3.20, s * 1.30, 0.06, 3.95, 0.042);
  }

  // ---------------------------------------------------- 弹舱门 / 挂弹 ----
  // 舱内结构：五个面围出空腔（底面不封）
  // 如果用一个实心 Box，打开舱门只会看到一块黑砖，看不见里面的炸弹
  boxM(1.94, 0.06, 3.86, bayMat, 0, -0.60, 1.75);            // 顶
  for (const s of [-1, 1]) {
    boxM(0.06, 0.72, 3.86, bayMat, s * 0.94, -0.96, 1.75);   // 侧壁
  }
  boxM(1.94, 0.72, 0.06, bayMat, 0, -0.96, -0.18);           // 前壁
  boxM(1.94, 0.72, 0.06, bayMat, 0, -0.96, 3.68);            // 后壁
  const bayDoors = [];
  for (const s of [-1, 1]) {
    const d = new THREE.Group();
    d.userData.dyn = true;
    d.position.set(s * 0.98, -1.28, 1.75);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.07, 3.80), M.panel);
    panel.position.x = -s * 0.48;
    d.add(panel);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 3.84, 8), M.dark);
    hinge.rotation.x = Math.PI / 2;
    d.add(hinge);
    d.userData.sign = s;
    shell.add(d);
    bayDoors.push(d);
  }
  // 舱内 2 枚 500 磅航弹（投完就消失）
  const bombs = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Group();
    b.userData.dyn = true;
    b.position.set((i ? 1 : -1) * 0.46, -0.92, 1.05 + i * 1.42);
    const body = new THREE.Mesh(geoOnce('bmBombBody', () => {
      const geo = new THREE.CapsuleGeometry(0.27, 1.30, 4, 8);
      geo.rotateX(Math.PI / 2);
      return geo;
    }), M.dark);
    b.add(body);
    const fin = new THREE.Mesh(geoOnce('bmBombFin', () => new THREE.BoxGeometry(0.06, 0.42, 0.34)), M.metal);
    fin.position.z = 0.72;
    b.add(fin);
    shell.add(b);
    bombs.push(b);
  }
  // 机腹挂架 + 鱼雷（外部挂载，投完消失）
  const torpGrp = new THREE.Group();
  torpGrp.userData.dyn = true;
  torpGrp.position.set(0, -1.62, 1.30);
  const tpBody = new THREE.Mesh(geoOnce('bmTorpBody', () => {
    const geo = new THREE.CylinderGeometry(0.40, 0.40, 4.30, 14);
    geo.rotateX(Math.PI / 2);
    return geo;
  }), new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.52, metalness: 0.55, envMapIntensity: 0.8 }));
  torpGrp.add(tpBody);
  const tpNose = new THREE.Mesh(geoOnce('bmTorpNose', () => {
    const geo = new THREE.SphereGeometry(0.40, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }), M.metal);
  tpNose.position.z = -2.15;
  torpGrp.add(tpNose);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(geoOnce('bmTorpFin', () => new THREE.BoxGeometry(0.05, 0.52, 0.44)), M.metal);
    fin.position.set(Math.cos(i * Math.PI / 2) * 0.24, Math.sin(i * Math.PI / 2) * 0.24, 2.02);
    fin.rotation.z = i * Math.PI / 2;
    torpGrp.add(fin);
  }
  shell.add(torpGrp);
  // 挂架
  boxM(0.10, 0.30, 0.30, M.dark, -0.34, -1.34, 0.30);
  boxM(0.10, 0.30, 0.30, M.dark, 0.34, -1.34, 0.30);

  // ------------------------------------------------------------ 起落架 ----
  // 轮底必须落在 y = -2.70（物理 CONFIG.aircraft.gearHeight），否则落地会陷进地面
  const gear = new THREE.Group();
  gear.userData.dyn = true;
  shell.add(gear);
  const wheel = (r, w, x, y, z) => {
    const t = new THREE.Mesh(geoOnce('bmTire' + r, () => {
      const geo = new THREE.CylinderGeometry(r, r, w, 16);
      geo.rotateZ(Math.PI / 2);
      return geo;
    }), M.tire);
    t.position.set(x, y, z);
    gear.add(t);
    const hub = new THREE.Mesh(geoOnce('bmHub' + r, () => {
      const geo = new THREE.CylinderGeometry(r * 0.52, r * 0.52, w * 1.06, 12);
      geo.rotateZ(Math.PI / 2);
      return geo;
    }), M.metal);
    hub.position.set(x, y, z);
    gear.add(hub);
    return t;
  };
  // 前起落架
  const nWheelY = -2.70 + 0.40;
  gear.add(bar(0, -0.72, -6.05, 0, nWheelY, -6.05, 0.075, M.metal, 8));
  gear.add(bar(0, -0.72, -5.72, 0, -1.72, -6.02, 0.045, M.metal, 6));
  wheel(0.40, 0.24, 0, nWheelY, -6.05);
  for (const s of [-1, 1]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.72), M.panel);
    d.position.set(s * 0.19, -1.05, -6.10);
    d.rotation.z = s * 1.15;
    gear.add(d);
  }
  // 主起落架：收在发动机短舱里
  const mWheelY = -2.70 + 0.56;
  for (const s of [-1, 1]) {
    gear.add(bar(s * PROP_X, -0.62, 0.55, s * PROP_X, mWheelY, 0.55, 0.095, M.metal, 8));
    gear.add(bar(s * (PROP_X - 0.28), -0.66, 0.82, s * PROP_X, -1.62, 0.62, 0.048, M.metal, 6));
    wheel(0.56, 0.34, s * PROP_X, mWheelY, 0.55);
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.92, 1.10), M.panel);
    d.position.set(s * (PROP_X + 0.30), -1.28, 0.60);
    d.rotation.z = s * 0.92;
    gear.add(d);
  }

  // ------------------------------------------------------ 灯 / 天线 ----
  const nav = [
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.085, 8, 6)), glowMat(0xff2a18, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.085, 8, 6)), glowMat(0x22ff5a, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.065, 8, 6)), glowMat(0xffffff, 0.95)),
    new THREE.Mesh(geoOnce('bmNavS', () => new THREE.SphereGeometry(0.065, 8, 6)), glowMat(0xff4030, 0.95))
  ];
  nav[0].position.set(-10.58, 1.20, 2.10);
  nav[1].position.set(10.58, 1.20, 2.10);
  nav[2].position.set(0, 0.55, 8.72);
  nav[3].position.set(0, -1.36, 3.60);
  for (const n of nav) shell.add(n);
  // 背鳍天线柱 + 到双垂尾的张线
  shell.add(bar(0, 1.14, -1.90, 0, 1.72, -1.55, 0.026, M.dark, 5));
  for (const s of [-1, 1]) {
    shell.add(bar(0, 1.70, -1.58, s * (3.86 + Math.sin(CANT) * 2.3), TAIL_Y + 0.24 + Math.cos(CANT) * 2.3, 7.95, 0.011, M.dark, 4));
  }
  // 空速管
  shell.add(bar(0, -0.10, -9.34, 0, -0.10, -9.95, 0.021, M.metal, 5));

  // -------------------------------------------------------------- 尾焰 ----
  // 活塞机没有加力：只在大油门时给排气口一圈短促的橙黄火舌 + 喷口辉光
  const nozMat = new THREE.MeshBasicMaterial({
    color: 0xffa860, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const mkFlameSet = (x, y, z) => {
    const grp = new THREE.Group();
    grp.userData.dyn = true;
    grp.position.set(x, y, z);
    grp.visible = false;
    const mkLayer = (r, len, col, op) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, len, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.geometry.rotateX(Math.PI / 2);
      m.geometry.translate(0, 0, len / 2);
      grp.add(m);
      return m;
    };
    const layers = [
      mkLayer(0.16, 0.62, 0xff5a14, 0.16),
      mkLayer(0.10, 0.40, 0xffa63c, 0.26),
      mkLayer(0.05, 0.24, 0xfff1c8, 0.60)
    ];
    shell.add(grp);
    return { grp, layers, dia: [], noz: [x, y, z + 0.5] };
  };
  const flameSets = [
    mkFlameSet(-PROP_X, PROP_Y - 0.52, -0.30),
    mkFlameSet(PROP_X, PROP_Y - 0.52, -0.30)
  ];
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(geoOnce('bmNozRing', () => new THREE.TorusGeometry(0.16, 0.05, 5, 12)), nozMat);
    ring.position.set(s * PROP_X, PROP_Y - 0.52, -0.28);
    shell.add(ring);
  }

  // ---------------------------------------------------- 机炮火光（前射）----
  const gunFlash = [];
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.36, 5), glowMat(0xffe6b8, 0.85));
    f.geometry.rotateX(-Math.PI / 2);
    f.geometry.translate(0, 0, -0.18);
    f.position.set(s * 0.30, -0.34, -9.34);
    f.visible = false;
    g.add(f);
    gunFlash.push(f);
  }

  // -------------------------------------------- 静态网格合批（60→6 draw call）----
  mergeStatic(shell, [M.body, M.panel, M.dark, M.metal, M.hot, M.acc, bayMat]);

  g.traverse((o) => {
    if (o.isMesh && o.userData.dyn !== undefined) { /* 动态件照常投影 */ }
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  g.userData = {
    shell, nav, gear,
    props, bayDoors, bayT: 0, bayOpen: 0, lastTw: -1, lastBw: -1,
    bombs, torpMesh: torpGrp,
    ailerons, elevators, rudders,
    // 防御炮塔（可动）：被咬尾时会转向最近的敌机
    turrets: [
      { yawGrp: topTurret, pitGrp: topGunGrp, kind: 'top', yaw: 0, pitch: 0 },
      { yawGrp: bellyTurret, pitGrp: bellyGunGrp, kind: 'belly', yaw: 0, pitch: 0 }
    ],
    flameSets,
    flame: flameSets[0].grp, flameLayers: flameSets[0].layers, flameDia: [],
    nozGlow: { material: nozMat },
    muzzle: muzzles,
    gunFlash, gunFlashT: 0,
    cockpit: null
  };
  return g;
}

function buildPlaneMesh(team) {
  const g = new THREE.Group();
  const M = planeMats(team);
  // 机体外壳统一挂到 shell 下：第一人称时整体隐藏，避免机翼/机身挡住视野
  const shell = new THREE.Group();
  g.add(shell);

  const box = (w, h, d, mat, x, y, z, ry, rz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    if (rz) m.rotation.z = rz;
    return m;
  };

  // 翼型放样函数 airfoilSurface() 已提到模块级，与轰炸机共用（见文件上方）

  // ---- 机身：车削纺锤体（15m 长，椭圆截面，机头尖、尾部收成机尾锥）----
  // 注意 LatheGeometry 入参是 (半径, 高度)，剖面是 [轴向z, 半径r]，必须对调
  const profile = [
    [-7.45, 0.02], [-7.25, 0.14], [-6.95, 0.24], [-6.60, 0.32], [-6.20, 0.385],
    [-5.70, 0.44], [-5.10, 0.50], [-4.55, 0.56], [-4.00, 0.61], [-3.20, 0.645], [-2.20, 0.70],
    [-0.90, 0.755], [0.60, 0.775], [2.10, 0.765], [3.50, 0.72], [4.80, 0.66],
    [5.90, 0.60], [6.75, 0.545], [7.35, 0.50]
  ].map((p) => new THREE.Vector2(p[1], p[0]));
  const fuseGeo = geoOnce('fuse', () => {
    const gg = new THREE.LatheGeometry(profile, 28);
    gg.rotateX(Math.PI / 2);        // 车削轴 Y→Z：机头朝 -Z
    gg.scale(1.04, 0.94, 1);        // 椭圆截面：略宽略扁，更像真机
    gg.computeVertexNormals();
    return gg;
  });
  shell.add(new THREE.Mesh(fuseGeo, M.body));

  // 雷达罩分模缝（一圈细环，替代原来的黑色尖锥）
  const radomeSeam = new THREE.Mesh(geoOnce('radomeSeam', () => new THREE.TorusGeometry(0.30, 0.012, 6, 24)), M.dark);
  radomeSeam.rotation.x = Math.PI / 2;
  radomeSeam.position.set(0, 0, -6.55);
  shell.add(radomeSeam);
  // 空速管（细长，不抢轮廓）
  const tip = new THREE.Mesh(geoOnce('pitot', () => {
    const gg = new THREE.CylinderGeometry(0.014, 0.022, 1.0, 6);
    gg.rotateX(Math.PI / 2);
    return gg;
  }), M.metal);
  tip.position.set(0, 0.0, -7.95);
  shell.add(tip);
  // 迎角叶片（机头两侧）
  for (const s of [-1, 1]) {
    const vane = box(0.018, 0.10, 0.18, M.metal, s * 0.28, 0.02, -6.55);
    vane.rotation.z = s * 0.25;
    shell.add(vane);
  }

  // ---- 座舱：镀膜玻璃泡盖 + 风挡框 + 暗色舱盆 ----
  const canopyGeo = geoOnce('canopy', () => {
    const gg = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5);
    gg.scale(0.46, 0.72, 1.36);
    gg.computeVertexNormals();
    return gg;
  });
  const canopy = new THREE.Mesh(canopyGeo, M.glass);
  canopy.position.set(0, 0.50, -3.55);
  shell.add(canopy);
  // 舱盆（从外面看进去不是空的）
  const tub = new THREE.Mesh(geoOnce('tub', () => {
    const gg = new THREE.SphereGeometry(1, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.5);
    gg.scale(0.40, 0.62, 1.24);
    return gg;
  }), M.dark);
  tub.position.set(0, 0.40, -3.55);
  shell.add(tub);
  // 风挡前框（A 柱）+ 中梁：略微向内收，形成座舱的“框”
  for (const s of [-1, 1]) {
    const ap = box(0.045, 0.66, 0.06, M.dark, s * 0.32, 0.80, -4.80);
    ap.rotation.set(-0.16, 0, s * 0.20);
    shell.add(ap);
  }
  const cPost = box(0.035, 0.10, 0.72, M.dark, 0, 1.16, -4.28);
  cPost.rotation.x = 0.12;
  shell.add(cPost);
  // 舱盖下沿导轨（左右两条细线）
  for (const s of [-1, 1]) {
    const sill = box(0.03, 0.05, 2.40, M.dark, s * 0.42, 0.60, -3.55);
    sill.rotation.z = s * -0.05;
    shell.add(sill);
  }
  // 座舱后整流脊（脊背一直延伸到垂尾根部）
  const spine = new THREE.Mesh(geoOnce('spine', () => {
    const gg = new THREE.CylinderGeometry(0.26, 0.44, 5.6, 14, 1, false);
    gg.rotateX(Math.PI / 2);
    gg.scale(1.22, 0.55, 1);
    gg.translate(0, 0, 2.8);
    return gg;
  }), M.body);
  spine.position.set(0, 0.56, -2.30);
  shell.add(spine);

  // ---- 腹部进气道（F-16 式皮托管进气道）----
  const inletGeo = geoOnce('inlet', () => {
    const sh = roundedRect(1.02, 0.60, 0.16);
    const gg = new THREE.ExtrudeGeometry(sh, {
      depth: 3.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 4
    });
    gg.computeVertexNormals();
    return gg;
  });
  const inlet = new THREE.Mesh(inletGeo, M.body);
  inlet.position.set(0, -0.62, -5.62);
  shell.add(inlet);
  // 进气口唇口 + 内壁（深色）
  const lip = new THREE.Mesh(geoOnce('lip', () => {
    const gg = new THREE.ExtrudeGeometry(roundedRect(0.95, 0.54, 0.14), {
      depth: 0.26, bevelEnabled: false, curveSegments: 4
    });
    return gg;
  }), M.dark);
  lip.position.set(0, -0.62, -5.69);
  shell.add(lip);
  // 附面层隔板
  shell.add(box(1.20, 0.04, 0.85, M.dark, 0, -0.34, -6.05));

  // ---- 主翼：NACA 翼型放样，40° 前缘后掠，带前缘缝翼线与翼尖弹轨 ----
  const wingStations = [
    { p: 0.75, le: -2.15, c: 3.55, off: -0.10, t: 0.056 },
    { p: 1.50, le: -1.62, c: 3.28, off: -0.085, t: 0.054 },
    { p: 2.30, le: -1.02, c: 2.94, off: -0.068, t: 0.051 },
    { p: 3.10, le: -0.42, c: 2.58, off: -0.050, t: 0.048 },
    { p: 3.90, le: 0.24, c: 2.10, off: -0.030, t: 0.044 },
    { p: 4.55, le: 0.82, c: 1.62, off: -0.012, t: 0.041 },
    { p: 4.95, le: 1.28, c: 1.18, off: 0.0, t: 0.038 }
  ];
  for (const s of [-1, 1]) {
    shell.add(new THREE.Mesh(airfoilSurface(wingStations, { mirror: s < 0 }), M.panel));
    // 前缘缝翼分缝线
    const slat = new THREE.Mesh(airfoilSurface([
      { p: 0.80, le: -2.12, c: 0.32, off: -0.090, t: 0.048 },
      { p: 2.30, le: -1.02, c: 0.28, off: -0.062, t: 0.045 },
      { p: 3.90, le: 0.24, c: 0.24, off: -0.028, t: 0.042 },
      { p: 4.95, le: 1.28, c: 0.20, off: 0.0, t: 0.040 }
    ], { mirror: s < 0 }), M.dark);
    shell.add(slat);
    // 翼尖挂弹轨
    shell.add(box(0.13, 0.09, 1.30, M.metal, s * 4.98, -0.06, 2.10));
  }

  // ---- 边条翼（LERX）：机身到主翼的涡流过渡 ----
  for (const s of [-1, 1]) {
    shell.add(new THREE.Mesh(airfoilSurface([
      { p: 0.38, le: -5.30, c: 3.30, off: 0.035, t: 0.034 },
      { p: 0.85, le: -4.45, c: 3.15, off: 0.025, t: 0.033 },
      { p: 1.35, le: -3.55, c: 2.92, off: 0.015, t: 0.032 },
      { p: 1.85, le: -2.75, c: 2.55, off: 0.005, t: 0.031 },
      { p: 2.25, le: -2.20, c: 2.10, off: 0.0, t: 0.030 }
    ], { mirror: s < 0 }), M.panel));
  }

  // ---- 平尾（全动）：翼型放样，后掠 ----
  for (const s of [-1, 1]) {
    shell.add(new THREE.Mesh(airfoilSurface([
      { p: 0.40, le: 4.22, c: 2.05, off: 0.0, t: 0.055 },
      { p: 0.95, le: 4.55, c: 1.80, off: 0.010, t: 0.052 },
      { p: 1.55, le: 4.92, c: 1.48, off: 0.020, t: 0.049 },
      { p: 2.05, le: 5.22, c: 1.15, off: 0.028, t: 0.046 },
      { p: 2.35, le: 5.42, c: 0.92, off: 0.032, t: 0.044 }
    ], { mirror: s < 0 }), M.panel));
  }

  // ---- 双外倾垂尾：翼型放样，外倾 25° ----
  const cant = 0.42;                                  // 约 24°
  const finSpan = [Math.sin(cant), Math.cos(cant), 0];
  const finThick = [Math.cos(cant), -Math.sin(cant), 0];
  for (const s of [-1, 1]) {
    const gg = airfoilSurface([
      { p: 0.0, le: 3.05, c: 2.95, off: 0.0, t: 0.062 },
      { p: 0.55, le: 3.52, c: 2.62, off: 0.0, t: 0.058 },
      { p: 1.15, le: 4.02, c: 2.18, off: 0.0, t: 0.054 },
      { p: 1.75, le: 4.55, c: 1.62, off: 0.0, t: 0.050 },
      { p: 2.25, le: 5.02, c: 1.05, off: 0.0, t: 0.046 },
      { p: 2.50, le: 5.24, c: 0.72, off: 0.0, t: 0.044 }
    ], { span: [s * finSpan[0], finSpan[1], 0], thick: [s * finThick[0], finThick[1], 0], samples: 10 });
    gg.translate(s * 0.52, 0.62, 0);
    shell.add(new THREE.Mesh(gg, M.panel));
    // 方向舵分缝
    const rud = box(0.045, 1.5, 0.03, M.dark, s * (0.52 + Math.sin(cant) * 1.05), 0.62 + Math.cos(cant) * 1.05, 5.55);
    rud.rotation.z = -s * cant;
    rud.rotation.x = 0.26;
    shell.add(rud);
    // 垂尾尖（队色）
    const ftip = box(0.10, 0.13, 0.55, M.acc, s * (0.52 + Math.sin(cant) * 2.50), 0.62 + Math.cos(cant) * 2.50, 5.05);
    ftip.rotation.z = -s * cant;
    shell.add(ftip);
    // 腹鳍（小）
    const vf = box(0.05, 0.42, 0.85, M.dark, s * 0.42, -0.62, 4.70);
    vf.rotation.z = -s * 0.22;
    shell.add(vf);
  }

  // ---- 发动机喷口：花瓣环 + 内锥 + 内壁辉光 ----
  const nozzle = new THREE.Mesh(geoOnce('nozzle', () => {
    const gg = new THREE.CylinderGeometry(0.50, 0.62, 1.05, 20, 1, true);
    gg.rotateX(-Math.PI / 2);
    gg.translate(0, 0, 0.52);
    return gg;
  }), M.hot);
  nozzle.position.z = 6.55;
  shell.add(nozzle);
  // 出口唇环 + 收敛段分段线（替代原来放射状的“花瓣棍”）
  const nozLip = new THREE.Mesh(geoOnce('nozLip', () => new THREE.TorusGeometry(0.505, 0.035, 8, 26)), M.hot);
  nozLip.position.z = 7.05;
  shell.add(nozLip);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const seg = box(0.022, 0.055, 0.95, M.dark,
      Math.cos(a) * 0.575, Math.sin(a) * 0.575, 6.58);
    seg.rotation.z = -a;
    seg.rotation.x = 0.06;
    shell.add(seg);
  }
  const nozInner = new THREE.Mesh(geoOnce('nozInner', () => {
    const gg = new THREE.ConeGeometry(0.44, 0.9, 16, 1, true);
    gg.rotateX(Math.PI / 2);
    gg.translate(0, 0, -0.45);
    return gg;
  }), M.dark);
  nozInner.position.z = 7.5;
  shell.add(nozInner);
  const nozGlow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16),
    new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  nozGlow.position.z = 7.28;
  shell.add(nozGlow);

  // ---- 机炮：左侧翼根单管（真实布局），带炮口整流罩 ----
  const gunFair = new THREE.Mesh(geoOnce('gunFair', () => {
    const gg = new THREE.CylinderGeometry(0.13, 0.09, 1.5, 10);
    gg.rotateX(-Math.PI / 2);
    return gg;
  }), M.body);
  gunFair.position.set(-1.18, 0.20, -2.55);
  shell.add(gunFair);
  const barrel = new THREE.Mesh(geoOnce('barrel', () => {
    const gg = new THREE.CylinderGeometry(0.042, 0.042, 0.62, 8);
    gg.rotateX(-Math.PI / 2);
    return gg;
  }), M.hot);
  barrel.position.set(-1.18, 0.20, -3.35);
  shell.add(barrel);

  // ---- 加力尾焰：外焰 / 主焰 / 核心 + 激波钻石（收敛尺寸，写实）----
  const dynGlow = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  const flame = new THREE.Group();
  flame.userData.dyn = true;
  flame.position.set(0, 0, 7.3);
  flame.visible = false;
  const mkFlameLayer = (r, len, col, op) => {
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(r, len, 12, 1, true),
      dynGlow(col, op));
    m.geometry.rotateX(Math.PI / 2);      // 尖端朝后 (+Z)
    m.geometry.translate(0, 0, len / 2);
    flame.add(m);
    return m;
  };
  const flameLayers = [
    mkFlameLayer(0.52, 2.95, 0xff5a14, 0.16),   // 外焰：橙红
    mkFlameLayer(0.34, 2.00, 0xffa63c, 0.26),   // 主焰：金橙
    mkFlameLayer(0.14, 1.10, 0xfff1c8, 0.62)    // 核心：暖白热
  ];
  const flameDia = [];
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Mesh(geoOnce('fdia' + i, () => new THREE.SphereGeometry(0.14 - i * 0.028, 6, 5)), dynGlow(0xffe0b0, 0.62));
    d.position.z = 1.15 + i * 0.66;
    d.scale.set(1, 1, 0.42);
    d.visible = false;
    flame.add(d);
    flameDia.push(d);
  }
  shell.add(flame);

  // ---- 枪口火光：小尺寸星芒（挂根组，座舱视角也看得到）----
  const gunFlash = [];
  for (const s of [-1]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.34, 5), glowMat(0xffe6b8, 0.85));
    f.geometry.rotateX(-Math.PI / 2);      // 尖端朝前
    f.geometry.translate(0, 0, -0.17);
    f.position.set(s * 1.18, 0.20, -3.66);
    f.visible = false;
    g.add(f);
    gunFlash.push(f);
  }

  // ---- 航行灯：左红右绿（小灯珠），尾部/腹部频闪 ----
  const nav = [
    new THREE.Mesh(geoOnce('navL', () => new THREE.SphereGeometry(0.075, 8, 6)), glowMat(0xff2a18, 0.95)),
    new THREE.Mesh(geoOnce('navL', () => new THREE.SphereGeometry(0.075, 8, 6)), glowMat(0x22ff5a, 0.95)),
    new THREE.Mesh(geoOnce('navS', () => new THREE.SphereGeometry(0.06, 8, 6)), glowMat(0xffffff, 0.95)),
    new THREE.Mesh(geoOnce('navS', () => new THREE.SphereGeometry(0.06, 8, 6)), glowMat(0xff4030, 0.95))
  ];
  nav[0].position.set(-6.12, -0.02, 1.62);
  nav[1].position.set(6.12, -0.02, 1.62);
  nav[2].position.set(0, 0.94, 6.62);
  nav[3].position.set(0, -0.74, 1.6);
  for (const n of nav) shell.add(n);

  // ---- 天线 / 传感器 ----
  shell.add(box(0.05, 0.20, 0.55, M.dark, 0, 0.86, -1.15));       // 背部刀形天线
  shell.add(box(0.04, 0.20, 0.42, M.dark, 0, -0.72, 4.2));        // 腹部天线
  shell.add(box(0.22, 0.08, 0.3, M.dark, 0, 0.80, 1.9));          // 脊背传感器

  // ---- 翼下挂架 + 导弹：剩余几发露几发 ----
  const mslBodyGeo = geoOnce('mslBody', () => {
    const gg = new THREE.CylinderGeometry(0.088, 0.088, 1.95, 10);
    gg.rotateX(Math.PI / 2);
    return gg;
  });
  const mslTipGeo = geoOnce('mslTip', () => {
    const gg = new THREE.ConeGeometry(0.088, 0.52, 10);
    gg.rotateX(-Math.PI / 2);
    return gg;
  });
  const mslFinGeo = geoOnce('mslFin', () => new THREE.BoxGeometry(0.018, 0.24, 0.26));
  const missiles = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const mg = new THREE.Group();
      mg.userData.dyn = true;    // 跟着剩余弹量显隐
      // 挂架
      const pyl = new THREE.Mesh(geoOnce('pylon', () => {
        const gg = new THREE.BoxGeometry(0.10, 0.26, 1.3);
        return gg;
      }), M.dark);
      pyl.position.set(0, 0.30, 0.1);
      mg.add(pyl);
      mg.add(new THREE.Mesh(mslBodyGeo, M.body));
      const tipM = new THREE.Mesh(mslTipGeo, M.dark);
      tipM.position.z = -1.22;
      mg.add(tipM);
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(mslFinGeo, M.dark);
        f.position.set(Math.cos(k * Math.PI / 2) * 0.10, Math.sin(k * Math.PI / 2) * 0.10, 0.82);
        f.rotation.z = k * Math.PI / 2;
        mg.add(f);
      }
      mg.position.set(s * (3.05 + i * 1.55), -0.44, 1.05 + i * 0.30);
      shell.add(mg);
      missiles.push(mg);
    }
  }

  // ---- 起落架（可切换显隐）：支柱 + 收放作动筒 + 轮胎 + 轮毂 + 舱门 ----
  const gear = new THREE.Group();
  gear.userData.dyn = true;      // 收放动画：不参与静态合并
  shell.add(gear);
  const strutMat = new THREE.MeshStandardMaterial({ color: 0x8b949c, roughness: 0.5, metalness: 0.7 });
  // 起落架按「机身中心到轮底 = CONFIG.gearHeight」反推支柱长度，落地时轮子正好贴地
  const GEAR_H = 2.70;
  const mkGear = (x, y, z, big) => {
    const tireR = big ? 0.42 : 0.34;
    const tireW = big ? 0.30 : 0.22;
    const wheelY = -GEAR_H + tireR;
    const len = y - wheelY;
    const rad = big ? 0.085 : 0.065;
    const s = new THREE.Mesh(geoOnce('gStrut' + (big ? 'B' : 'S'), () => {
      const gg = new THREE.CylinderGeometry(rad * 0.86, rad, 1.0, 10);
      return gg;
    }), strutMat);
    s.scale.y = len;
    s.position.set(x, y - len / 2, z);
    gear.add(s);
    // 收放作动筒（斜撑）
    const act = new THREE.Mesh(geoOnce('gAct', () => new THREE.CylinderGeometry(0.038, 0.038, 1.0, 8)), strutMat);
    act.scale.y = len * 0.55;
    act.position.set(x * 0.48, y - len * 0.42, z + 0.34);
    act.rotation.z = x >= 0 ? 0.5 : -0.5;
    act.rotation.x = -0.36;
    gear.add(act);
    // 轮胎
    const w = new THREE.Mesh(geoOnce('gTire' + (big ? 'B' : 'S'), () => {
      const gg = new THREE.CylinderGeometry(tireR, tireR, tireW, 16);
      gg.rotateZ(Math.PI / 2);
      return gg;
    }), M.tire);
    w.position.set(x, wheelY, z);
    gear.add(w);
    // 轮毂
    const hub = new THREE.Mesh(geoOnce('gHub' + (big ? 'B' : 'S'), () => {
      const gg = new THREE.CylinderGeometry(tireR * 0.55, tireR * 0.55, tireW * 1.06, 12);
      gg.rotateZ(Math.PI / 2);
      return gg;
    }), strutMat);
    hub.position.set(x, wheelY, z);
    gear.add(hub);
    // 舱门（下垂打开状态）
    const door = box(0.03, big ? 0.55 : 0.42, big ? 1.0 : 0.7, M.panel,
      x + (x >= 0 ? 0.20 : -0.20), y - 0.42, z + 0.12);
    door.rotation.z = x >= 0 ? 1.15 : -1.15;
    gear.add(door);
  };
  mkGear(0, -0.56, -5.35, false);
  mkGear(-1.85, -0.5, 0.95, true);
  mkGear(1.85, -0.5, 0.95, true);

  // 座舱内构改到独立场景 cpScene 渲染（见 buildCockpit）

  // ---- 静态网格按材质合并：每架飞机从 60+ 个 draw call 降到 5~6 个 ----
  // 16 人空战下这是“能不能稳 60fps”的关键；动态部件（起落架/尾焰/导弹/灯/玻璃）
  // 在各自 group 上打了 userData.dyn，不参与合并。
  mergeStatic(shell, [M.body, M.panel, M.dark, M.metal, M.hot, M.acc]);

  g.userData = {
    flame, flameLayers, flameDia, nozGlow,
    gunFlash, gunFlashT: 0,
    gear, canopy, cockpit: null, shell, nav, missiles
  };
  // 机体既投影也接收阴影（机翼投在机身上，低空看非常明显）
  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}

// 把同一材质下的一堆静态小网格烘焙成一个 BufferGeometry
function mergeStatic(root, matList) {
  const allow = new Set(matList);
  const buckets = new Map();
  const collect = (node) => {
    for (const child of [...node.children]) {
      if (child.userData && child.userData.dyn) continue;
      if (child.isGroup) { collect(child); continue; }
      if (!child.isMesh || !allow.has(child.material)) continue;
      const key = child.material.uuid;
      if (!buckets.has(key)) buckets.set(key, { mat: child.material, geos: [] });
      child.updateMatrix();
      const g = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone());
      g.applyMatrix4(child.matrix);
      buckets.get(key).geos.push(g);
      child.parent.remove(child);
    }
  };
  collect(root);
  for (const { mat, geos } of buckets.values()) {
    const pos = [], nor = [], uvs = [];
    let total = 0;
    for (const g of geos) total += g.attributes.position.count;
    const aPos = new Float32Array(total * 3);
    const aNor = new Float32Array(total * 3);
    const aUv = new Float32Array(total * 2);
    let o3 = 0, o2 = 0;
    for (const g of geos) {
      const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
      aPos.set(p.array, o3);
      if (n) aNor.set(n.array, o3);
      if (u) aUv.set(u.array, o2);
      o3 += p.array.length;
      o2 += p.count * 2;
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(aNor, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(aUv, 2));
    merged.computeBoundingSphere();
    root.add(new THREE.Mesh(merged, mat));
  }
}

// =============================================================================
// === 粒子系统（Points + 自定义着色器，1 个 draw call）========================
// =============================================================================
const PARTICLE_VS = `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aKind;      // 0=火焰(噪声硬边) 1=烟(柔和) 2=碎片(实心点)
  uniform float uPix;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dep = -mv.z;
    // 近处粒子不再被透视放大成整屏光球（追尾视角喷流会贴到镜头上）；
    // 上限 170px：260px 时代的加色大粒子在两弹齐爆时 overdraw 瞬间爆表
    // （1080p 下一颗就吃掉 ~2.5% 屏幕的像素，两发航弹齐中 = 掉帧悬崖）。
    float sz = aSize * uPix * (820.0 / max(55.0, dep));
    // 远距补偿：>1500m 后按距离缓慢放大，模拟爆炸火球的视觉尺寸下限
    sz *= 1.0 + smoothstep(1500.0, 6000.0, dep) * 0.85;
    gl_PointSize = clamp(sz, 0.0, 170.0 * uPix);
    vAlpha *= smoothstep(7.0, 34.0, dep);
    gl_Position = projectionMatrix * mv;
  }`;
const PARTICLE_FS = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;

  // 便宜的 3D 值噪声（点精灵里用 uv 当作 2D 采样，够用且省）
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm2(vec2 p) {
    return vnoise(p) * 0.62 + vnoise(p * 2.13 + 7.7) * 0.26 + vnoise(p * 4.31 + 19.3) * 0.12;
  }

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;               // 0 中心 → 1 边缘
    if (r > 1.0) discard;

    float a;
    vec3 col = vColor;
    if (vKind < 0.5) {
      // ---- 火焰：径向衰减 + 噪声撕边，中心白热 ----
      float n = fbm2(gl_PointCoord * 3.4 + vec2(vColor.r * 7.0, vColor.g * 5.0));
      float core = smoothstep(1.0, 0.0, r);
      a = core * (0.55 + 0.65 * n);
      // 中心略偏白热，但幅度要小：0.55 时整团火球会变成"白球带橙边"
      col = mix(col, vec3(1.0, 0.94, 0.80), smoothstep(0.42, 0.0, r) * 0.30);
      // HDR 增益：火焰是自发光体，亮度要超过 1.0 才能被 bloom 拾取，
      // 否则加色混合在明亮天空背景下会被完全冲淡（表现为“淡粉色雾团”）。
      col *= 2.2;
    } else if (vKind < 1.5) {
      // ---- 烟：柔和球状 + 低频噪声起伏，边缘自然消散 ----
      // 烟是**遮挡物**（NormalBlending 的暗色不透明团），不能做中心白化/亮度增益，
      // 否则一团浓黑烟会被画成"中间发白的棉花糖"。
      float n = fbm2(gl_PointCoord * 2.6 + vec2(vColor.r * 11.0, vColor.b * 9.0));
      float soft = smoothstep(1.0, 0.30, r);
      a = soft * (0.70 + 0.45 * n);
      // 中心更暗（真实烟团是"核厚边薄"、核心自遮挡），整体再压暗一档：
      // 后处理里的鲜度找回/ACES 会把中灰抬亮，不加这层压暗，黑烟会被"洗"成灰白。
      col *= 0.55 + 0.30 * smoothstep(0.0, 0.85, r);
    } else if (vKind < 2.5) {
      // ---- 碎片：小实心点，边缘 1px 柔化 ----
      a = smoothstep(1.0, 0.72, r);
      col *= 1.8;                            // 火星也是自发光
    } else {
      // ---- 柔和加色（默认）：曳光弹 / 加力尾焰 / 凝结尾 / 干扰弹沿用原外观 ----
      // 这些不是"火焰"，不能套 HDR 增益，否则曳光会被 bloom 糊成一条光带。
      a = smoothstep(0.5, 0.08, r);
    }

    a *= vAlpha;
    if (a < 0.008) discard;
    gl_FragColor = vec4(col, a);
  }`;

class Particles {
  constructor(max, blending) {
    this.max = max;
    this.n = 0;
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.t = new Float32Array(max); this.tm = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drg = new Float32Array(max); this.gv = new Float32Array(max);
    this.cr = new Float32Array(max); this.cg = new Float32Array(max); this.cb = new Float32Array(max);
    // 色温演变终点（爆炸火球会从白热 → 橙 → 暗红），与起点色 lerp
    this.er = new Float32Array(max); this.eg = new Float32Array(max); this.eb = new Float32Array(max);
    this.hue = new Uint8Array(max);        // 0 有终点色 / 1 纯单色
    this.knd = new Uint8Array(max);        // 0 火焰 / 1 烟 / 2 碎片
    this.acv = new Uint8Array(max);        // alpha 曲线：0 二次衰减 / 1 先升后降 / 2 线性

    const geo = new THREE.BufferGeometry();
    this.aPos = new Float32Array(max * 3);
    this.aCol = new Float32Array(max * 3);
    this.aSize = new Float32Array(max);
    this.aAlpha = new Float32Array(max);
    this.aKind = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(this.aKind, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPix: { value: renderer.getPixelRatio() } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  spawn(o) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.px[i] = o.x; this.py[i] = o.y; this.pz[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.t[i] = this.tm[i] = o.life;
    this.s0[i] = o.s0; this.s1[i] = o.s1 === undefined ? o.s0 : o.s1;
    this.a0[i] = o.alpha === undefined ? 1 : o.alpha;
    this.drg[i] = o.drag === undefined ? 0.6 : o.drag;
    this.gv[i] = o.gravity === undefined ? 0 : o.gravity;
    this.cr[i] = o.r; this.cg[i] = o.g; this.cb[i] = o.b;
    // 色温终点（不传则保持单色）
    if (o.r1 !== undefined) {
      this.hue[i] = 0;
      this.er[i] = o.r1; this.eg[i] = o.g1; this.eb[i] = o.b1;
    } else {
      this.hue[i] = 1;
      this.er[i] = o.r; this.eg[i] = o.g; this.eb[i] = o.b;
    }
    // 默认 3 = 柔和加色（曳光/尾焰/凝结尾等旧调用点全部走这条，外观保持原样）
    this.knd[i] = o.kind === undefined ? 3 : o.kind;
    this.acv[i] = o.acurve === undefined ? 0 : o.acurve;
  }
  remove(i) {
    const j = --this.n;
    if (i !== j) {
      this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
      this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
      this.t[i] = this.t[j]; this.tm[i] = this.tm[j];
      this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j]; this.a0[i] = this.a0[j];
      this.drg[i] = this.drg[j]; this.gv[i] = this.gv[j];
      this.cr[i] = this.cr[j]; this.cg[i] = this.cg[j]; this.cb[i] = this.cb[j];
      this.er[i] = this.er[j]; this.eg[i] = this.eg[j]; this.eb[i] = this.eb[j];
      this.hue[i] = this.hue[j]; this.knd[i] = this.knd[j]; this.acv[i] = this.acv[j];
    }
  }
  update(dt) {
    for (let i = 0; i < this.n;) {
      this.t[i] -= dt;
      if (this.t[i] <= 0) { this.remove(i); continue; }
      const k = Math.max(0, 1 - this.drg[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
      this.vy[i] -= this.gv[i] * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      const u = 1 - this.t[i] / this.tm[i];          // 0 → 1
      this.aPos[i * 3] = this.px[i]; this.aPos[i * 3 + 1] = this.py[i]; this.aPos[i * 3 + 2] = this.pz[i];
      // 色温演变：爆炸火球白热 → 橙 → 暗红；烟从深灰渐淡
      if (this.hue[i] === 0) {
        const t2 = Math.min(1, u * 1.35);
        this.aCol[i * 3] = this.cr[i] + (this.er[i] - this.cr[i]) * t2;
        this.aCol[i * 3 + 1] = this.cg[i] + (this.eg[i] - this.cg[i]) * t2;
        this.aCol[i * 3 + 2] = this.cb[i] + (this.eb[i] - this.cb[i]) * t2;
      } else {
        this.aCol[i * 3] = this.cr[i]; this.aCol[i * 3 + 1] = this.cg[i]; this.aCol[i * 3 + 2] = this.cb[i];
      }
      this.aSize[i] = lerp(this.s0[i], this.s1[i], u);
      // alpha 曲线：0 = 快亮快灭（火球） / 1 = 烟（快速鼓起后长平台再散） / 2 = 线性
      const ac = this.acv[i];
      this.aAlpha[i] = this.a0[i] * (ac === 1
        // 烟：前 12% 快速充满（u*8），随后长时间维持高浓度（平台期），
        // 最后 35% 才明显变淡 —— 这样黑烟能在空中挂住，而不是"一秒消失"。
        ? Math.min(1, u * 8.0) * (u < 0.65 ? 1.0 : (1 - (u - 0.65) / 0.35) * 0.92 + 0.08)
        : (ac === 2 ? (1 - u) : (1 - u) * (1 - u)));
      this.aKind[i] = this.knd[i];
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aKind.needsUpdate = true;
  }
  setPixelRatio(p) { this.points.material.uniforms.uPix.value = p; }
}
const pFire = new Particles(CONFIG.fx.maxParticles, THREE.AdditiveBlending);
const pSmoke = new Particles(Math.floor(CONFIG.fx.maxParticles * 0.6), THREE.NormalBlending);

// --- 爆炸冲击波：池化环形 billboard（加色混合，不写深度）---
const SHOCK_POOL = [];
const SHOCK_GEO = new THREE.RingGeometry(0.70, 1.0, 44, 1);
for (let i = 0; i < 12; i++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe6bc, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
  });
  const m = new THREE.Mesh(SHOCK_GEO, mat);
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  SHOCK_POOL.push({ mesh: m, t: 0, life: 0, scale: 1 });
}
let shockCursor = 0;
function spawnShockwave(x, y, z, scale) {
  const s = SHOCK_POOL[shockCursor++ % SHOCK_POOL.length];
  s.t = 0;
  s.life = 0.5 + Math.min(0.35, scale * 0.12);
  s.scale = Math.max(0.12, scale);
  s.mesh.position.set(x, y, z);
  s.mesh.visible = true;
  s.mesh.material.opacity = 0;
}
function updateShocks(dt) {
  for (const s of SHOCK_POOL) {
    if (!s.mesh.visible) continue;
    s.t += dt;
    if (s.t >= s.life) { s.mesh.visible = false; continue; }
    const u = s.t / s.life;
    // 冲击波以极快速度外扩，亮度按二次曲线衰减（前段最亮）
    const sc = s.scale * (6 + u * 52);
    s.mesh.scale.set(sc, sc, sc);
    s.mesh.quaternion.copy(camera.quaternion);
    s.mesh.material.opacity = (1 - u) * (1 - u) * 0.42;
  }
}

function spawnExplosion(x, y, z, scale) {
  spawnShockwave(x, y, z, scale * 0.85);
  spawnFlashCore(x, y, z, scale);
  spawnExplosionLight(x, y, z, scale);

  // ---- 1) 白热火球核心：极短寿命、亮白→橙红，形成爆心的“白闪” ----
  // 尺寸/寿命都要小：上一版核心粒子 30m、活 0.3s，会把橙色主体火球整个盖成
  // 一个白色圆盘（截图里就是“白团带橙边”）。现在只负责最初 0.15s 的白闪。
  const nCore = Math.floor(12 * scale);
  for (let i = 0; i < nCore; i++) {
    const sp = (18 + Math.random() * 46) * scale;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    pFire.spawn({
      x, y, z,
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp * 0.8 + 8,
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: 0.15 + Math.random() * 0.16,
      s0: 8 * scale, s1: 20 * scale, alpha: 1,
      drag: 3.0, gravity: 2,
      r: 1.0, g: 0.95, b: 0.80,             // 起点：接近纯白
      r1: 1.0, g1: 0.52, b1: 0.12,          // 终点：橙红
      kind: 0, acurve: 0
    });
  }

  // ---- 2) 主体火球：白热→橙→暗红的三段色温，噪声撕边 ----
  const n = Math.floor(32 * scale);
  for (let i = 0; i < n; i++) {
    const sp = (30 + Math.random() * 95) * scale;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    pFire.spawn({
      x, y, z,
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp + 14,
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: 0.75 + Math.random() * 1.1,
      s0: 7 * scale, s1: 26 * scale, alpha: 1.0,
      drag: 1.35, gravity: 4.5,
      r: 1.0, g: 0.74, b: 0.30,             // 起点：亮橙黄
      r1: 0.72, g1: 0.13, b1: 0.03,         // 终点：暗红余烬
      kind: 0, acurve: 0
    });
  }

  // ---- 2b) 余烬层：慢速、长寿命、暗红，火球消散后仍留一圈发热的红光 ----
  const nEmber = Math.floor(10 * scale);
  for (let i = 0; i < nEmber; i++) {
    const th = Math.random() * Math.PI * 2;
    const rr = Math.random() * 16 * scale;
    pFire.spawn({
      x: x + Math.cos(th) * rr, y: y + (Math.random() - 0.4) * 10 * scale, z: z + Math.sin(th) * rr,
      vx: Math.cos(th) * 3, vy: 5 + Math.random() * 7, vz: Math.sin(th) * 3,
      life: 1.5 + Math.random() * 1.2,
      s0: 6 * scale, s1: 16 * scale, alpha: 0.55,
      drag: 1.0, gravity: -0.8,
      r: 0.85, g: 0.22, b: 0.04,
      r1: 0.22, g1: 0.03, b1: 0.01, kind: 0, acurve: 1
    });
  }

  // ---- 3) 向上翻卷的油火舌：慢速、寿命长、偏橙（爆炸后的持续燃烧）----
  const nFlame = Math.floor(12 * scale);
  for (let i = 0; i < nFlame; i++) {
    const th = Math.random() * Math.PI * 2;
    const rr = Math.random() * 14 * scale;
    pFire.spawn({
      x: x + Math.cos(th) * rr, y: y + Math.random() * 6 * scale, z: z + Math.sin(th) * rr,
      vx: Math.cos(th) * 5 * scale, vy: 16 + Math.random() * 18, vz: Math.sin(th) * 5 * scale,
      life: 0.8 + Math.random() * 0.9,
      s0: 5 * scale, s1: 15 * scale, alpha: 0.75,
      drag: 1.1, gravity: -2.5,             // 负重力 = 上浮
      r: 1.0, g: 0.62, b: 0.16,
      r1: 0.55, g1: 0.09, b1: 0.02,
      kind: 0, acurve: 1
    });
  }

  // ---- 4) 黑烟柱：先升后降的 alpha（烟是先鼓起来再散）----
  // 浓度与寿命是本轮重点：之前烟太淡太短，爆炸 1 秒后就"没了"，
  // 而真实飞机爆炸的黑烟会在空中挂十几秒（这里压到 5~7 秒，兼顾粒子预算）。
  const nSmoke = Math.floor(28 * scale);
  for (let i = 0; i < nSmoke; i++) {
    const sp = (14 + Math.random() * 44) * scale;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    pSmoke.spawn({
      x, y, z,
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp + 24,
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: 3.4 + Math.random() * 3.4,
      s0: 9 * scale, s1: 78 * scale, alpha: 0.62,
      drag: 0.85, gravity: -1.6,
      r: 0.05, g: 0.045, b: 0.043,           // 起点：几乎纯黑的浓烟
      r1: 0.14, g1: 0.135, b1: 0.13,         // 扩散后变深灰（不是白灰）
      kind: 1, acurve: 1
    });
  }
  // 4b) 少量明火熄灭后的白灰蒸汽（只在爆心附近，量必须很小，
  //     否则会把上面的黑烟冲成"棉花糖"——上一版就是这个毛病）
  for (let i = 0; i < Math.floor(3 * scale); i++) {
    const th = Math.random() * Math.PI * 2;
    pSmoke.spawn({
      x: x + Math.cos(th) * 8 * scale, y: y + 4, z: z + Math.sin(th) * 8 * scale,
      vx: Math.cos(th) * 5, vy: 9 + Math.random() * 7, vz: Math.sin(th) * 5,
      life: 1.4, s0: 6 * scale, s1: 30 * scale, alpha: 0.14,
      drag: 0.7, gravity: -1.2,
      r: 0.45, g: 0.44, b: 0.43,
      r1: 0.62, g1: 0.61, b1: 0.60, kind: 1, acurve: 1
    });
  }

  // ---- 5) 高温火星/碎片：小、快、亮，抛物线坠落并带拖尾感 ----
  const nDeb = Math.floor(16 * scale);
  for (let i = 0; i < nDeb; i++) {
    const sp = (45 + Math.random() * 110) * scale;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    pFire.spawn({
      x, y, z,
      vx: Math.sin(ph) * Math.cos(th) * sp,
      vy: Math.cos(ph) * sp + 30,
      vz: Math.sin(ph) * Math.sin(th) * sp,
      life: 0.7 + Math.random() * 1.1,
      s0: 2.6, s1: 0.7, alpha: 1,
      drag: 0.35, gravity: 30,
      r: 1.0, g: 0.86, b: 0.5,
      r1: 0.85, g1: 0.20, b1: 0.02,
      kind: 2, acurve: 2
    });
  }
  // 实体碎屑（暗色小块，比火星落得更快更远）
  for (let i = 0; i < Math.floor(10 * scale); i++) {
    const sp = (50 + Math.random() * 90) * scale;
    const th = Math.random() * Math.PI * 2;
    pSmoke.spawn({
      x, y, z,
      vx: Math.cos(th) * sp, vy: 24 + Math.random() * 55, vz: Math.sin(th) * sp,
      life: 2.4, s0: 2.8, s1: 1.1, alpha: 0.95, drag: 0.22, gravity: 28,
      r: 0.09, g: 0.085, b: 0.08,
      kind: 2, acurve: 2
    });
  }
}

// 爆心白闪：单个快速膨胀再收缩的加色 billboard，模拟爆炸瞬间的过曝核心。
// 只在近处明显（远距离已经被 bloom 处理），避免整屏泛白。
const FLASH_POOL = [];
const FLASH_GEO = new THREE.PlaneGeometry(1, 1);
for (let i = 0; i < 10; i++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff4dc, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide
  });
  const m = new THREE.Mesh(FLASH_GEO, mat);
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  FLASH_POOL.push({ m, t: 0, tm: 1, s: 1 });
}
let flashIdx = 0;
function spawnFlashCore(x, y, z, scale) {
  const f = FLASH_POOL[flashIdx++ % FLASH_POOL.length];
  f.m.position.set(x, y, z);
  f.t = f.tm = 0.10 + scale * 0.045;
  f.s = 26 * scale;
  f.m.visible = true;
}
function updateFlash(dt) {
  for (const f of FLASH_POOL) {
    if (!f.m.visible) continue;
    f.t -= dt;
    if (f.t <= 0) { f.m.visible = false; f.m.material.opacity = 0; continue; }
    const u = 1 - f.t / f.tm;                 // 0 → 1
    // 尺寸先猛涨再略微收（冲击波前沿），不透明度快速衰减
    const sz = f.s * (0.35 + u * 1.15);
    f.m.scale.set(sz, sz, sz);
    f.m.material.opacity = (1 - u) * (1 - u) * 0.95;
    // 面向相机
    f.m.quaternion.copy(camera.quaternion);
  }
}

// 爆炸动态光照：给场景补一盏瞬时点光源，让近处地形/机体被火光照亮。
// 用一个池化的 PointLight（不新增灯 = 不增加着色器分支），强度按衰减曲线驱动。
// ⚠️ 灯必须**常驻 visible**、只用 intensity 驱动：three.js 里灯光数量一变，
// 所有 MeshStandardMaterial 的着色器都要按新灯数重新编译 —— 表现就是
// 爆炸瞬间整帧掉 100~300ms（玩家报的"一投弹就非常卡"就是它）。
const BOOM_LIGHTS = [];
for (let i = 0; i < 3; i++) {
  const l = new THREE.PointLight(0xffb264, 0, 0, 2);
  l.visible = true;              // 永远可见，intensity=0 即"无灯"
  scene.add(l);
  BOOM_LIGHTS.push({ l, t: 0, tm: 1, i0: 1 });
}
let boomLightIdx = 0;
function spawnExplosionLight(x, y, z, scale) {
  const b = BOOM_LIGHTS[boomLightIdx++ % BOOM_LIGHTS.length];
  b.l.position.set(x, y, z);
  b.t = b.tm = 0.32 + scale * 0.12;
  b.i0 = 900 * scale * scale;      // 强度（decay=2 下需较大数值才有可见照明）
}
function updateBoomLights(dt) {
  for (const b of BOOM_LIGHTS) {
    if (b.t <= 0) continue;       // 常驻灯：到时后 intensity 已归零，不再驱动
    b.t -= dt;
    if (b.t <= 0) { b.l.intensity = 0; continue; }
    const u = 1 - b.t / b.tm;
    b.l.intensity = b.i0 * (1 - u) * (1 - u);
  }
}

// =============================================================================
// === WebAudio 程序化音效 =====================================================
// =============================================================================
const Sound = {
  ctx: null, master: null, noise: null, ready: false, muted: false,
  eng: null, wind: null, lastWarn: 0, lastStall: 0, lastGun: 0, lastLock: 0,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.audio.master;
    this.master.connect(this.ctx.destination);

    // 白噪声缓冲（复用）
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // --- 引擎：锯齿 + 方波 + 涡轮噪声 ---
    const eg = this.ctx.createGain(); eg.gain.value = 0.0;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    const o1 = this.ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 48;
    const o2 = this.ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 72;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.35;
    o1.connect(lp); o2.connect(g2); g2.connect(lp);
    const ns = this.ctx.createBufferSource(); ns.buffer = buf; ns.loop = true;
    const nf = this.ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.8;
    const ng = this.ctx.createGain(); ng.gain.value = 0.22;
    ns.connect(nf); nf.connect(ng); ng.connect(lp);
    lp.connect(eg); eg.connect(this.master);
    o1.start(); o2.start(); ns.start();
    this.eng = { o1, o2, lp, eg };

    // --- 风噪 ---
    const wg = this.ctx.createGain(); wg.gain.value = 0;
    const wf = this.ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 600; wf.Q.value = 0.55;
    const ws = this.ctx.createBufferSource(); ws.buffer = buf; ws.loop = true;
    ws.connect(wf); wf.connect(wg); wg.connect(this.master);
    ws.start();
    this.wind = { wg, wf };

    this.ready = true;
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  noiseBurst(dur, freq, q, gain, type) {
    if (!this.ready) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.02);
    return { f, g };
  },
  tone(freq, dur, gain, type) {
    if (!this.ready) return;
    const o = this.ctx.createOscillator(); o.type = type || 'square'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
    return o;
  },
  gun(vol) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    if (t - this.lastGun < 0.05) return;
    this.lastGun = t;
    const v = 0.22 * vol;
    // 三层：枪口爆音（高频脆响）+ 机体低频震动 + 机械咔哒
    this.noiseBurst(0.07, 1700 + Math.random() * 900, 0.9, v, 'bandpass');
    this.tone(118 + Math.random() * 44, 0.09, 0.10 * vol, 'square');
    this.tone(320 + Math.random() * 130, 0.03, 0.05 * vol, 'sawtooth');
  },
  missile(vol) {
    if (!this.ready || this.muted) return;
    const b = this.noiseBurst(1.1, 320, 0.5, 0.30 * vol, 'lowpass');
    if (b) b.f.frequency.exponentialRampToValueAtTime(2400, this.ctx.currentTime + 0.9);
    this.tone(120, 0.5, 0.10 * vol, 'sawtooth');
  },
  boom(vol) {
    if (!this.ready || this.muted) return;
    const b = this.noiseBurst(1.0, 900, 0.4, 0.55 * vol, 'lowpass');
    if (b) b.f.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.8);
    this.tone(58, 0.6, 0.34 * vol, 'sine');
  },
  thud(vol) { this.noiseBurst(0.22, 200, 0.6, 0.3 * vol, 'lowpass'); },
  // 减速板液压作动声：放板时“嘶——”下行，收板时上行
  airbrake(open) {
    if (!this.ready || this.muted) return;
    const b = this.noiseBurst(0.5, open ? 1500 : 900, 1.3, 0.15, 'bandpass');
    if (b && this.ctx) b.f.frequency.exponentialRampToValueAtTime(open ? 380 : 1700, this.ctx.currentTime + 0.45);
    this.thud(0.32);
  },
  beep(freq, vol, dur) { this.tone(freq, dur || 0.07, (vol || 0.14), 'square'); },
  // 每帧更新引擎与风噪；cloud=0~1 表示在云中的程度（声音发闷）
  update(speed, throttle, alive, dt, cloud) {
    if (!this.ready) return;
    const target = this.muted ? 0 : 1;
    const cf = 1 - (cloud || 0) * 0.65;          // 云中整体发闷
    if (alive) {
      const f = 44 + throttle * 92 + Math.min(60, speed * 0.09);
      this.eng.o1.frequency.value += (f - this.eng.o1.frequency.value) * Math.min(1, dt * 5);
      this.eng.o2.frequency.value = this.eng.o1.frequency.value * 1.51;
      this.eng.lp.frequency.value = (420 + throttle * 2400) * (1 - (cloud || 0) * 0.5);
      this.eng.eg.gain.value = (0.05 + throttle * 0.13) * target * cf;
      const ws = clamp(speed / 420, 0, 1);
      this.wind.wg.gain.value = ws * ws * 0.16 * target * cf;
      this.wind.wf.frequency.value = (380 + speed * 2.2) * (1 - (cloud || 0) * 0.6);
    } else {
      this.eng.eg.gain.value = 0;
      this.wind.wg.gain.value = 0;
    }
  }
};

// =============================================================================
// === 无线电语音包（public/voice/*.wav）======================================
// =============================================================================
// 语音是离线合成的成品音频（SAPI + 电台滤波），运行时只做 fetch + decodeAudioData，
// 不依赖浏览器 TTS，所以每台机器的听感一致。字幕走 HUD，静音也能看。
const RADIO_TEXT = {
  lock: '目标锁定',
  launch: '导弹发射',
  kill: '敌机击落',
  hit: '命中',
  six: '六点方向，敌机',
  missile: '导弹来袭',
  stall: '失速，失速',
  pullup: '拉起，拉起',
  takeoff: '抬轮，离地',
  touchdown: '接地',
  landed: '降落成功',
  lowammo: '弹药不足',
  contact: '发现敌机',
  cleared: '空域已清空',
  friendly: '友军被击落',
  wreck: '跳伞，跳伞',
  win: '任务完成',
  lose: '撤离战区',
  approach: '进近，放下起落架',
  checkgear: '起落架未放下'
};

const Radio = {
  on: true, loaded: false, loading: false, buf: {}, q: [], cur: null, lastT: {},
  init() {
    if (this.loading || !Sound.ctx) return;
    this.loading = true;
    const ctx = Sound.ctx;
    const ids = Object.keys(RADIO_TEXT);
    const one = (id) => fetch('voice/' + id + '.wav')
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? new Promise((res) => {
        ctx.decodeAudioData(ab, (b) => { this.buf[id] = b; res(); }, () => res());
      }) : null))
      .catch(() => { });
    Promise.all(ids.map(one)).then(() => {
      this.loaded = true;
      this.pump();
    });
  },
  // pri 越大越优先（告警类会盖掉普通播报）；gap = 同一句的最短间隔
  say(id, opt) {
    if (!this.on) return;
    const o = opt || {};
    const now = nowSec();
    const gap = o.gap === undefined ? 4.0 : o.gap;
    if (this.lastT[id] && now - this.lastT[id] < gap) return;
    this.lastT[id] = now;
    // 字幕：语音没加载出来也照样给文字
    game.radioMsg = { text: RADIO_TEXT[id] || id, t: o.hold || 2.8, pri: o.pri || 0 };
    const item = { id, pri: o.pri || 0 };
    if (item.pri >= 2) this.q.length = 0;         // 高优先级清空排队
    this.q.push(item);
    if (this.q.length > 5) this.q.shift();
    this.pump();
  },
  pump() {
    if (!this.loaded || this.cur || !this.q.length || !Sound.ctx) return;
    const item = this.q.shift();
    const b = this.buf[item.id];
    if (!b) { this.pump(); return; }
    const ctx = Sound.ctx;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = CONFIG.audio.voice === undefined ? 0.9 : CONFIG.audio.voice;
    src.connect(g); g.connect(Sound.master);
    this.cur = item;
    src.onended = () => { this.cur = null; this.pump(); };
    try { src.start(); } catch (e) { this.cur = null; }
  }
};

// =============================================================================
// === 网络：Socket.IO =========================================================
// =============================================================================
let sock = null;
const nowSec = () => performance.now() * 0.001;
const serverNow = () => nowSec() + game.timeOffset;

function connect() {
  if (sock) { try { sock.disconnect(); } catch (e) { /* ignore */ } }
  /* ★ 显式开启断线自动重连（云端网络抖动时 socket.io 默认会重连，
     但默认退避较长；这里收紧重连节奏，避免玩家感觉"掉线了再也回不来"）。 */
  sock = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
  });

  sock.on('connect', () => {
    if (domName.value.trim()) sock.emit('rename', domName.value.trim());
    // 兵种随握手上报（服务端 spawnPlayer 按这个生成）
    if (game.vehicle) sock.emit('vehicle', game.vehicle);
  });

  sock.on('connect_error', () => {
    domJoin.disabled = false;
    domJoin.textContent = '重试连接';
    el('menuTip').textContent = '连不上服务器 — 正在自动重试…';
  });

  sock.on('welcome', (w) => {
    game.myId = w.id;
    game.myTeam = w.team;
    game.myName = domName.value.trim() || w.name;
    game.playing = true;
    game.snaps.length = 0;
    game.views = new Map();
    game.roster = [];
    game.own = null;
    game.hist.length = 0;
    domTarget.textContent = SIM.match.targetScore;
    domMenu.classList.add('hidden');
    document.body.classList.add('playing');
    Sound.init();
    Sound.resume();
    requestLock();
    pushCenter('加入 ' + (w.teamName || '') + ' · 滑跑起飞！', 2.2);
    autoHideHelp();
  });

  sock.on('renamed', (n) => { if (n) game.myName = n; });

  sock.on('full', () => {
    domMenu.classList.remove('hidden');
    document.body.classList.remove('playing');
    domJoin.disabled = false;
    domJoin.textContent = '加入战斗';
    el('menuTip').textContent = '服务器已满（' + SIM.net.maxPlayers + ' 人）';
  });

  sock.on('snap', onSnapshot);

  sock.on('pong', (payload) => {
    if (payload && typeof payload.t === 'number') {
      const r = (nowSec() - payload.t) * 1000;
      game.rtt = game.rtt * 0.7 + r * 0.3;
    }
  });

  /* ★ 断线处理（用户反馈"开局后自动失去连接"）：
     原实现直接把 playing=false、弹回菜单，玩家被踢出且无法自动恢复。
     现在改为：保留对局状态，提示"正在重连"，socket.io 会自动重连；
     只有确认彻底连不上（重连失败）才退回菜单。 */
  sock.on('disconnect', () => {
    el('menuTip') && (el('menuTip').textContent = '连接中断，正在自动重连…');
    if (domJoin) { /* 保持不可点，避免重复 join */ }
  });
  sock.io.on('reconnect_failed', () => {
    game.playing = false;
    domMenu.classList.remove('hidden');
    domJoin.disabled = false;
    domJoin.textContent = '重新加入';
    el('menuTip').textContent = '与服务器断开 — 点击重新加入';
  });
}

function onSnapshot(s) {
  const recv = nowSec();
  // 服务器时钟偏移估计（考虑单程延迟）
  const est = s.t + game.rtt * 0.0005 - recv;
  if (!game.haveOffset) { game.timeOffset = est; game.haveOffset = true; }
  else game.timeOffset += (est - game.timeOffset) * 0.08;

  game.snaps.push(s);
  if (game.snaps.length > 40) game.snaps.shift();
  game.snapCount++;
  game.teamScore = s.sc;
  game.timeLeft = s.tl;
  game.matchOver = !!s.mo;
  game.roster = s.r || [];
  if (s.s3) game.aaas = s.s3;   // 防空阵地
  if (s.cv) {                   // 航母状态：两艘舰各自停放的飞机数 / 弹射 / 牵引 / 钩索
    game.cvParkedN = s.cv.n || [0, 0];
    game.cvCat = s.cv.cat || [];
    game.cvTaxi = s.cv.taxi || [];
    game.cvWire = s.cv.wire || [];
  }

  // 事件
  for (const e of (s.e || [])) handleEvent(e);

  // 自身状态权威同步 + 回滚重放
  reconcile(s);
}

function entryToState(e) {
  const q = { x: e.q[0], y: e.q[1], z: e.q[2], w: e.q[3] };
  const ypr = FP.yprFromQuat(q);
  return {
    id: e.i, name: e.n, team: e.tm,
    atype: e.at === 'b' ? 'bomber' : 'fighter',
    torps: e.tw || 0, bombs: e.bw || 0,
    pos: { x: e.p[0], y: e.p[1], z: e.p[2] },
    vel: { x: e.v[0], y: e.v[1], z: e.v[2] },
    quat: q,
    throttle: e.thr, gear: !!e.gr, onGround: !!e.og, airborne: !e.og,
    gYaw: ypr.yaw, gPitch: clamp(ypr.pitch, 0, SIM.aircraft.maxRotate),
    speed: e.s, gLoad: e.g, aoa: e.ao || 0, stalled: !!e.st,
    alive: !!e.al, wreck: !!e.wk, health: e.hp,
    spawnId: e.sid, serviced: true,
    ammo: e.am, missiles: e.ms, flares: e.fl, heat: e.ht, overheated: !!e.oh,
    firing: !!e.fi, fireAccum: 0, missileCd: 0, flareCd: 0,
    lockProgress: e.lk, lockTargetId: e.lt, lockedBy: e.lb,
    // 近地屏蔽：mc = 视锥内最优目标（锁不上也画框），mr = 原因（1 地形 / 2 贴地杂波）
    lockCandId: e.mc || 0, lockReason: e.mr || 0,
    ctl: e.c ? { r: e.c[0], p: e.c[1], y: e.c[2], d: e.c[3] } : { p: 0, r: 0, y: 0, d: 0 },
    // 起降状态必须一起带上：客户端会用它跑同一套 groundStep，缺字段会算出 NaN
    tdT: 0, susp: 0,
    // 航母甲板状态（服务端权威）：钩住索/停稳/弹射中/牵引中必须恢复，
    // 否则回滚重放会把"已被阻拦索拽住"或"正在被牵引"的飞机算成"自由滑跑"。
    wireCaught: !!(e.dkf & 2), wireIdx: (e.dk ? e.dk - 1 : 0),
    deckStopped: !!(e.dkf & 4), catActive: !!(e.dkf & 8),
    taxiActive: !!(e.dkf & 16),
    // 牵引一定是为了弹射（服务端只在收到 J 且不在弹射位时启动牵引），
    // 所以牵引位为真即等价于"到位后自动接弹射"，不需要额外传一个字段。
    catQueued: !!(e.dkf & 16),
    // wirePrevAlong 用快照位置反推（而不是留 undefined）：
    // 每次回包都重置的话，每 50ms 会有一个"看不见索"的盲帧，60m/s 下就是 1m 的漏钩窗口。
    // 反推成权威 along，钩索的跨面判定立刻就能接上。
    // 两艘舰：先定位飞机在哪艘舰上，再用那艘舰的甲板系反推。
    wirePrevAlong: (e.dkf & 1) ? (() => {
      const cv = FP.carrierAt(e.p[0], e.p[2], 1.2);
      return cv ? FP.carrierLocal(e.p[0], e.p[2], cv).along : undefined;
    })() : undefined,
    // 弹射进度由末速反推，避免回包把 2.6s 加速曲线从头重启（视觉上会"弹一半又缩回去"）
    catT: (e.dkf & 8) ? (e.s * 2.6 / 78) : 0,
    cvTeam: -1,
    out: 0, damageLog: {}
  };
}

const _visP = new THREE.Vector3();        // 回包前的视觉位置（含修正偏移）
const _visQ = new THREE.Quaternion();     // 回包前的视觉姿态（含残差）
const _corrV = new THREE.Vector3();       // 回包修正量（位置）
const _dq = new THREE.Quaternion();       // 回包修正量（姿态）
const _qTmp = new THREE.Quaternion();
function reconcile(s) {
  let me = null;
  for (const e of s.a) if (e.i === game.myId) { me = e; break; }
  if (!me) { if (game.own) game.own.state = null; return; }

  if (!game.own || !game.own.state || game.own.state.spawnId !== me.sid) {
    // 新出生 / 首次同步：硬重置
    game.own = { state: entryToState(me) };
    game.hist.length = 0;
    game.renderOffset.set(0, 0, 0);
    game.deathTimer = 0;
    game.snaps = [s];
    game.accum = 0;
    game.stTime = s.t;
    game.quatErr.identity();
    _poseA.ok = false;
    // 起落架跟随服务器状态（否则上一局收起的起落架会被带进新出生点）
    input.gear = game.own.state.gear;
    input.ab = false;        // 新出生收减速板
    const q = game.own.state.quat;
    game.smoothQuat.set(q.x, q.y, q.z, q.w);
    game.camSnap = true;
    game.snapChase = true;
    return;
  }

  const prev = game.own.state;
  const s2 = entryToState(me);
  // 用“快照之后走过的固定步数”来重放，而不是逐条比时间戳：
  // 时间戳有 ±10ms 的钟差，按时间戳筛选会多算/少算一步，200m/s 下就是 3m 的假修正。
  // 按步数取整后再重放，误差最多半帧。
  const stepN = 1 / SIM.net.simHz;
  // 重放到「本地当前时间」为止，而不是「现在」为止：
  // game.stTime 是本地状态自己那条步网格上的时间，和 s.t 同网格，所以 n 是精确整数，
  // 每次回包都稳定，重放后的 s2 与本地状态只差真实预测误差（厘米级）。
  // 若用 serverNow() 算，时钟估计的几毫秒噪声会让 n 在 2/3/4 之间乱跳，
  // 每跳一次差一整步 = 200m/s 下 3.2m 的来回抽动。
  let n = Math.round((game.stTime - s.t) / stepN);
  // 本地时间轴和服务器差太多（切后台、服务器卡顿）就直接以服务器为准重新对表
  const resync = n > 60 || n < -2;
  if (resync) n = Math.round((serverNow() - s.t) / stepN);
  n = clamp(n, 0, game.hist.length);
  const tmp = game.tmpEvts; tmp.length = 0;
  for (let i = game.hist.length - n; i < game.hist.length; i++) {
    if (i < 0) continue;
    const h = game.hist[i];
    FP.stepAircraft(s2, h.input, h.dt, tmp);
  }
  tmp.length = 0;

  // 重放后的状态对应的服务器时间：落在 1/60 的步网格上，本地后续推进也从这里接着数，
  // 于是客户端和服务器始终同相位（否则每次回包都会差半步 = 200m/s 下 3.3m 的来回跳）。
  game.stTime = s.t + n * stepN;

  // 视觉连续性：回包把机位/机头“掰”了一下，直接把画面拽过去就是抽搐。
  // 正确做法是把这一掰记成残差（位置偏移 + 姿态四元数），让画面停在原处，
  // 再让残差平滑归零 —— 视觉上是“慢慢纠回来”，不是“跳一下”。
  const oldVis = _visP.copy(game.renderPose).add(game.renderOffset);
  // renderQuat 已经是“最终视觉姿态”（predict 里叠过 quatErr），这里直接用，不要再乘一次
  const oldQ = _visQ.copy(game.renderQuat);

  // 诊断用：game.dbgNet 为数组时记录每次回包的修正量（正常游戏为 null，零开销）
  if (game.dbgNet) {
    let qa = Math.abs(prev.quat.x * s2.quat.x + prev.quat.y * s2.quat.y
      + prev.quat.z * s2.quat.z + prev.quat.w * s2.quat.w);
    qa = 2 * Math.acos(Math.min(1, qa)) * 180 / Math.PI;
    game.dbgNet.push({
      d: Math.hypot(s2.pos.x - prev.pos.x, s2.pos.y - prev.pos.y, s2.pos.z - prev.pos.z),
      qa, n, rtt: game.rtt, off: game.renderOffset.length(),
      ds: game.stTime - s.t, hl: game.hist.length, pa: game.poseAlpha,
      pp: [prev.pos.x, prev.pos.y, prev.pos.z], sp: [s2.pos.x, s2.pos.y, s2.pos.z],
      vv: [prev.vel.x, prev.vel.y, prev.vel.z], v2: [s2.vel.x, s2.vel.y, s2.vel.z],
      stp: game.stTime - s.t, rp: [game.renderPose.x, game.renderPose.y, game.renderPose.z]
    });
    if (game.dbgNet.length > 400) game.dbgNet.shift();
  }

  game.own.state = s2;

  // ---- 视觉连续性 ----
  // 回包把机位/机头“掰”了一下，直接把画面拽过去就是抽搐。做法是：
  // 1) 把渲染插值的那一对端点整体平移到新路径上（保留亚步相位 alpha，视觉上一点不跳）
  // 2) 平移量里包含了真实修正量 c，把它记进 renderOffset / quatErr 慢慢归零
  // 注意：不能把端点直接压成 s2 —— 那样每次回包都会把“半步插值”抹掉，
  // 残差就会一直累积（实测会稳定在 -13m 左右，画面 20Hz 地来回蹭）。
  const c = _corrV.set(s2.pos.x - prev.pos.x, s2.pos.y - prev.pos.y, s2.pos.z - prev.pos.z);
  _dq.set(s2.quat.x, s2.quat.y, s2.quat.z, s2.quat.w);
  _qTmp.set(prev.quat.x, prev.quat.y, prev.quat.z, prev.quat.w).invert();
  _dq.multiply(_qTmp);                        // 世界系下的修正旋转
  _poseA.p.add(c); _poseA.q.premultiply(_dq); _poseA.ok = true;
  _poseB.p.copy(s2.pos); _poseB.q.set(s2.quat.x, s2.quat.y, s2.quat.z, s2.quat.w);

  game.renderPose.copy(_poseA.p).lerp(_poseB.p, game.poseAlpha);
  game.renderQuat.copy(_poseA.q).slerp(_poseB.q, game.poseAlpha);
  game.renderOffset.copy(oldVis).sub(game.renderPose);
  game.quatErr.copy(game.renderQuat).invert().multiply(oldQ);

  // 偏差过大（切后台回来、长时间卡顿）直接硬吸附，避免机身飞到镜头外
  if (game.renderOffset.lengthSq() > 2500) {
    game.renderOffset.set(0, 0, 0);
    game.quatErr.identity();
    game.camSnap = true;
    game.snapChase = true;
  }
}

function handleEvent(e) {
  switch (e.k) {
    case 'kill': {
      const a = nameOf(e.a), v = nameOf(e.v);
      const w = e.w === 'missile' ? '导弹' : (e.w === 'gun' ? '机炮' : (e.w === 'ram' ? '撞击' : '击落'));
      const bonus = e.tk ? SIM.scoring.teamKill : SIM.scoring.kill;
      const stTail = (!e.tk && e.st >= 3 && e.a !== game.myId) ? ' <span class="w">连杀×' + e.st + '</span>' : '';
      addKill(e.tk ? a + ' 误伤 ' + v
        : a + ' <span class="w">' + w + '</span> ' + v + ' <span class="w">+' + bonus + '</span>' + stTail,
        teamOf(e.a), false,
        e.tk ? '⚠' : (e.w === 'missile' ? '➤' : (e.w === 'gun' ? '⊹' : '✖')),
        e.a === game.myId || e.v === game.myId);
      if (e.v === game.myId) {
        game.deathTimer = 3; pushCenter('被 ' + a + ' 击落', 3); Radio.say('wreck', { gap: 2, pri: 2 });
        game.deathCamId = e.a || 0;   // 死亡观战：跟随击杀者
      }
      else if (e.a === game.myId) {
        Radio.say('kill', { gap: 1.5, pri: 1 });
        game.killFlash = 1.6;
        // 连杀播报：×2 起给专属提示与递进音效（双杀/三杀/四杀/连杀×N）
        const st = e.st || 0;
        const stTxt = st >= 5 ? '连杀 ×' + st : (st === 2 ? '双杀' : (st === 3 ? '三杀' : (st === 4 ? '四杀' : '')));
        pushCenter((e.w === 'missile' ? '导弹击落' : '击落') + (stTxt ? '  ' + stTxt : '') + '  +' + bonus, 2.2);
        Sound.beep(1200, 0.16, 0.1);
        setTimeout(() => Sound.beep(1600, 0.14, 0.1), 90);
        if (st >= 2) setTimeout(() => Sound.beep(1900, 0.18, 0.12), 190);
      }
      break;
    }
    case 'crash': {
      addKill(nameOf(e.id) + ' 坠毁', -1, false, '✖', e.id === game.myId);
      if (e.id === game.myId) {
        // 按坠毁原因给具体提示（服务端 e.r）。含糊的"注意高度与姿态"对玩家没帮助
        const why = {
          water: '坠海 — 注意高度，海面不是跑道',
          terrain: '撞地 — 拉起来，别贴山飞',
          deckfast: '着舰超速 — 进场速度要压到 110m/s 以内',
          enemydeck: '试图降落在敌舰甲板 — 敌舰不可降落',
          nogear: '未放起落架 — 落地前按 G 放轮',
          attitude: '着陆姿态错误 — 保持机翼水平、机头略抬',
          hard: '下沉率过大 — 进场下滑角太陡',
          overspeed: '着陆超速 — 起落架承受不住',
          lost: '飞出战区边界'
        }[e.r] || '坠毁 — 注意高度与姿态';
        game.deathTimer = 3; pushCenter(why, 3);
        Radio.say('wreck', { gap: 2, pri: 2 });
      } else if (teamOf(e.id) === game.myTeam) Radio.say('friendly', { gap: 6, pri: 1 });
      break;
    }
    case 'touchdown':
      if (e.id === game.myId) {
        if (e.cv) {
          // 着舰瞬间：机体砸在甲板上的闷响 + 轮胎尖叫
          Sound.thud(1.0);
          Radio.say('touchdown', { gap: 3, pri: 2 });
        } else Radio.say('touchdown', { gap: 3, pri: 1 });
      }
      break;
    case 'wire': {
      // 钩住阻拦索：钢索被拉出的金属摩擦 + 机体猛减速
      // 服务端发的是 e.i（索序号 0~2）和 e.ct（哪艘舰）；老字段 e.n 是 1 起的序号
      const idx0 = (typeof e.i === 'number') ? e.i : ((e.n || 1) - 1);
      const idx = idx0 + 1;
      const ct = (e.ct === undefined || e.ct < 0) ? 0 : e.ct;
      const key = ct + ':' + e.id;
      if (e.id === game.myId) {
        game.cvWireFx.set(key, { idx: idx0, t: 1.2 });
        Sound.thud(1.3);
        Sound.noiseBurst(0.5, 900, 0.7, 0.30, 'bandpass');
        pushCenter('钩住第 ' + idx + ' 根阻拦索 — 减速中', 2.0);
        game.shake = Math.min(1.2, game.shake + 0.55);
      } else {
        game.cvWireFx.set(key, { idx: idx0, t: 1.2 });
        addKill(nameOf(e.id) + ' 着舰 · 钩住第 ' + idx + ' 根阻拦索', -1, false, '⚓');
      }
      break;
    }
    case 'taxi':
      if (e.id === game.myId) {
        pushCenter('甲板牵引中 — 正在转移到弹射位', 2.6);
        Sound.thud(0.5);
      }
      break;
    // ---- 海战 ----
    case 'shipfire':
      fxShipFire(e);
      // 炮口闪光定位：开火的敌舰暴露 8s（超视距也能看到标记），
      // AI 16km 外开炮时玩家至少知道"谁在打我、它在哪"
      if (e.id && e.id !== game.myShipId) game.shipSpotted.set(e.id, nowSec() + 8);
      // 炮弹视角画中画：本舰主炮开火（所有舰种）→ 武装认领（跟最新出膛的弹）
      // 一次只跟一发：正跟弹时再开火不重置，落水看完水柱后由下一轮开火重新武装
      if (e.id === game.myShipId && !_pipState.phase) {
        _pipState.armed = true;
        _pipState.armedAt = nowSec();
      }
      // 近处的大口径齐射有轰鸣与震屏
      {
        const d = camera.position.distanceTo(new THREE.Vector3(e.p[0], e.p[1], e.p[2]));
        if (e.big) {
          Sound.boom(clamp(1 - d / 9000, 0.05, 0.85));
          if (d < 1200) game.shake = Math.min(1.0, game.shake + clamp(1 - d / 1200, 0.1, 1) * 0.5);
        } else if (d < 3000) Sound.thud(clamp(1 - d / 3000, 0.05, 0.5));
      }
      break;
    case 'shellsplash':
      fxShellSplash(e);
      // 调试：记录最近一次落水点，供瞄准精度自检读取
      // sh.from 是**舰船 id**（不是玩家 id），必须和 myShipId 比
      if (e.p && e.by === game.myShipId) {
        game.lastSplash = { x: e.p[0], y: e.p[1], z: e.p[2], t: nowSec() };
        // 世界内落点标记（2.5s）：水上一个 X 记号，玩家能看到上一发打哪了
        game.mySplashes.push({ x: e.p[0], z: e.p[2], t: nowSec(), big: !!e.big });
        if (game.mySplashes.length > 6) game.mySplashes.shift();
        // 打近/打远反馈：锁定目标存在时，比较落水点与目标的距离
        // （节流：齐射多弹几乎同时落水，1.2s 内不重复提示，避免刷屏）
        if (game.aimLead && e.big && nowSec() - (game.lastSplashHintAt || 0) > 1.2) {
          const myV = shipViews.get(game.myShipId);
          const tdist = game.aimLead.dist;
          const sdist = myV ? Math.hypot(e.p[0] - myV.p.x, e.p[2] - myV.p.z) : 0;
          const err = sdist - tdist;
          if (Math.abs(err) > 220) {
            game.lastSplashHintAt = nowSec();
            pushCenter(err > 0 ? ('打远了 · 射程减 ' + Math.round(Math.abs(err) / 100) + '00m')
                               : ('打近了 · 射程加 ' + Math.round(Math.abs(err) / 100) + '00m'), 1.8);
          }
        }
      }
      break;
    case 'torpdrop':
      // 鱼雷离机：机腹一沉 + 轻微水花预备
      if (e.id === game.myId) pushCenter('鱼雷已投放 — 保持直航', 1.6);
      break;
    case 'bombdrop':
      // 航弹离机：机体瞬间变轻（视觉上没有额外表现，靠自由落体轨迹）
      if (e.id === game.myId) pushCenter('投弹！', 1.0);
      break;
    case 'torpsplash':
      // 鱼雷入水：白色水柱 + 涟漪
      pSmoke.spawn({
        x: e.p[0], y: 1.2, z: e.p[2],
        vx: 0, vy: 7 + Math.random() * 4, vz: 0,
        life: 1.0, s0: 2.0, s1: 11, alpha: 0.5, drag: 2.2, gravity: 9,
        r: 0.92, g: 0.96, b: 1.0, r1: 0.72, g1: 0.80, b1: 0.88
      });
      break;
    case 'shiphit': {
      // 命中舰体：爆炸 + 水柱（若近水线）+ 声音
      spawnExplosion(e.p[0], e.p[1], e.p[2], e.big ? 1.15 : 0.6);
      // 命中即暴露：打中我舰的敌舰暴露 12s（比开火暴露更久——它已经锁死你了）
      if (e.tgt === game.myShipId && e.by) game.shipSpotted.set(e.by, nowSec() + 12);
      // 舰体受击震动：几千吨的船被 406mm 命中会整体抖一下，
      // 之前只有爆炸粒子、舰体纹丝不动，看着像"炸弹贴纸"。
      {
        const hm = shipMeshes.get(e.tgt);
        if (hm) hm.hitShake = Math.min(1.2, (hm.hitShake || 0) + (e.big ? 0.85 : 0.45));
      }
      const d = camera.position.distanceTo(new THREE.Vector3(e.p[0], e.p[1], e.p[2]));
      Sound.boom(clamp(1 - d / 8000, 0.05, 0.9));
      if (e.pen) {
        // 击穿：装甲碎屑
        for (let i = 0; i < 8; i++) {
          pSmoke.spawn({
            x: e.p[0], y: e.p[1], z: e.p[2],
            vx: (Math.random() - 0.5) * 30, vy: 4 + Math.random() * 20, vz: (Math.random() - 0.5) * 30,
            life: 1.1, s0: 1.2, s1: 4, alpha: 0.9, drag: 0.8, gravity: 2.2,
            r: 0.95, g: 0.85, b: 0.6
          });
        }
      } else {
        // 未击穿：火花四溅
        for (let i = 0; i < 12; i++) {
          pFire.spawn({
            x: e.p[0], y: e.p[1], z: e.p[2],
            vx: (Math.random() - 0.5) * 46, vy: Math.random() * 34, vz: (Math.random() - 0.5) * 46,
            life: 0.5 + Math.random() * 0.4, s0: 1.6, s1: 0.4,
            r: 1.0, g: 0.78, b: 0.38
          });
        }
      }
      if (e.tgt && e.by === game.myId) {
        // 自己命中的反馈
        game.hitMarker = 0.5;
        Sound.beep(1500, 0.10, 0.08);
      }
      break;
    }
    case 'torphit': {
      // 鱼雷命中：巨型水柱 + 巨响 + 强震屏
      spawnExplosion(e.p[0], e.p[1], e.p[2], 2.0);
      fxShellSplash({ p: [e.p[0], 0, e.p[2]], big: 1 });
      const d = camera.position.distanceTo(new THREE.Vector3(e.p[0], 0, e.p[2]));
      Sound.boom(clamp(1 - d / 10000, 0.1, 1.0));
      if (d < 2500) game.shake = Math.min(1.6, game.shake + clamp(1 - d / 2500, 0.1, 1) * 1.1);
      break;
    }
    case 'torpshot':
      // 鱼雷出管也有暴露（发射舰 torpshot 的 id = 开火舰）
      if (e.id && e.id !== game.myShipId) game.shipSpotted.set(e.id, nowSec() + 8);
      // 发射舰的鱼雷管做后坐/回座动画（不管敌我，看得见就该动）
      {
        const tm2 = shipMeshes.get(e.id);
        if (tm2 && tm2.torpTubes && tm2.torpTubes.length) {
          const tt = tm2.torpTubes[(e.tube | 0) % tm2.torpTubes.length] || tm2.torpTubes[0];
          tt.fireT = 0.9;
        }
      }
      break;
    case 'aahit': {
      // 防空命中飞机
      if (e.id === game.myId) {
        game.hitFlash = Math.min(1, game.hitFlash + 0.35);
        game.shake = Math.min(1.0, game.shake + 0.25);
        // 受击方向指示：指向开火的舰船（防空炮没有 views 实体，用 shipViews 定位）
        const mv = game.views.get(game.myId);
        const sv = shipViews.get(e.by);
        if (mv && sv) {
          _hdDir.set(sv.p.x - mv.pos.x, 0 - mv.pos.y, sv.p.z - mv.pos.z)
            .applyQuaternion(_hdInv.copy(mv.quat).invert());
          game.hitDir = { ang: Math.atan2(_hdDir.x, -_hdDir.z), t: 1.6 };
        }
        // 提示文字：知道该去炸谁
        pushCenter('遭到防空炮击 · 来自敌方战舰', 1.4);
      }
      break;
    }
    case 'aatrace':
      // 防空曳光：从舰到机的细线（粒子表现）
      {
        const dx = e.q[0] - e.p[0], dy = e.q[1] - e.p[1], dz = e.q[2] - e.p[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const n = 4;
        for (let i = 1; i <= n; i++) {
          const f = i / (n + 1);
          pFire.spawn({
            x: e.p[0] + dx * f, y: e.p[1] + dy * f, z: e.p[2] + dz * f,
            vx: (Math.random() - 0.5) * 3, vy: 2, vz: (Math.random() - 0.5) * 3,
            life: 0.22 + Math.random() * 0.14, s0: 1.6, s1: 0.4,
            r: 1.0, g: 0.85, b: 0.45
          });
        }
      }
      break;
    case 'shellair': {
      // 炮弹近炸波及飞机
      spawnExplosion(e.p[0], e.p[1], e.p[2], 0.5);
      break;
    }
    case 'shipsink': {
      const m = shipMeshes.get(e.id);
      const pos = m ? m.group.position : null;
      if (pos) {
        // 沉没：大爆炸 + 持续冒烟
        spawnExplosion(pos.x, pos.y + 8, pos.z, 2.2);
        Sound.boom(0.9);
      }
      addKill((e.name || '战舰') + ' 被击沉' + (e.by === game.myId ? ' — 你击沉的！' : ''), -1, false, '⚓', e.by === game.myId);
      // 自己坐舰被击沉：明确告知后续（45 秒后在编队锚点重新下水）
      if (e.id === game.myShipId) {
        pushCenter('本舰被击沉 — 正在重新出击（优先同型舰）', 3.2);
        Sound.boom(1.0);
        game.shake = Math.min(1.2, game.shake + 0.8);
      }
      if (e.by === game.myId) {
        pushCenter('击沉 ' + (e.name || '敌舰') + '  +' + (e.gain || 300), 2.6);
        Radio.say('kill', { gap: 1.5, pri: 1 });
        Sound.beep(1200, 0.16, 0.1);
        setTimeout(() => Sound.beep(1600, 0.14, 0.1), 90);
      }
      break;
    }
    case 'cat':
      if (e.id === game.myId) {
        pushCenter('弹射器接通 — 保持机头对正', 1.8);
        Sound.beep(880, 0.14, 0.1);
        setTimeout(() => Sound.beep(1320, 0.13, 0.12), 110);
      }
      break;
    case 'launch':
      if (e.id === game.myId) {
        pushCenter('弹射离舰 · 收起落架开始爬升', 2.0);
        Radio.say('takeoff', { gap: 2, pri: 1 });
        Sound.beep(1560, 0.16, 0.14);
      }
      break;
    case 'land':
      if (e.id === game.myId) {
        Radio.say('landed', { gap: 3, pri: 1 });
        if (e.cv) pushCenter('着舰成功  +' + SIM.scoring.landing + ' · 停稳后补给 · 按 J 弹射起飞', 2.8);
        else if (e.base) pushCenter('返场降落  +' + SIM.scoring.landing + ' · 滑行到停机坪补给', 2.6);
        else pushCenter('场外迫降 · 不计返场分', 2.4);
      } else {
        addKill(nameOf(e.id) + (e.cv ? ' 着舰' : (e.base ? ' 返场降落' : ' 场外迫降')), -1, false, '✔');
      }
      break;
    case 'supply':
      if (e.id === game.myId) {
        pushCenter(e.cv ? '母舰补给完成  +' + SIM.scoring.resupply + ' · 满弹满油' : '机场补给完成  +' + SIM.scoring.resupply + ' · 满弹满油', 1.8);
      }
      break;
    case 'takeoff':
      if (e.id === game.myId) {
        pushCenter('已离地 — 按 G 收起落架', 2.0);
        Radio.say('takeoff', { gap: 3, pri: 1 });
      }
      break;
    case 'boom': {
      spawnExplosion(e.p[0], e.p[1], e.p[2], e.s || 1);
      const dist = camera.position.distanceTo(new THREE.Vector3(e.p[0], e.p[1], e.p[2]));
      Sound.boom(clamp(1 - dist / 6000, 0.05, 1));
      if (dist < 900) game.shake = Math.min(1.4, game.shake + (e.s || 1) * clamp(1 - dist / 900, 0.1, 1) * 0.9);
      break;
    }
    case 'sd': {
      // 防空阵地被摧毁（a=摧毁者，0=无归属）
      addKill('防空阵地被摧毁' + (e.a ? ' — ' + nameOf(e.a) : ''), -1, false, '💥', e.a === game.myId);
      if (e.a === game.myId) {
        pushCenter('摧毁防空阵地  +' + SIM.scoring.siteKill, 2.2);
        Radio.say('kill', { gap: 1.5, pri: 1 });
        Sound.beep(1200, 0.16, 0.1);
        setTimeout(() => Sound.beep(1600, 0.14, 0.1), 90);
      }
      break;
    }
    case 'impact': {
      // 地面/水面弹着：尘土 + 火花 + 碎屑，近处还有一声脆响
      const ix = e.p[0], iy = e.p[1], iz = e.p[2];
      // 尘土团（先鼓后散，偏暖灰）
      for (let i = 0; i < 7; i++) {
        pSmoke.spawn({
          x: ix, y: iy, z: iz,
          vx: (Math.random() - 0.5) * 18, vy: 5 + Math.random() * 14, vz: (Math.random() - 0.5) * 18,
          life: 0.85, s0: 2.5, s1: 11, alpha: 0.55, drag: 1.4, gravity: 1.2,
          r: 0.72, g: 0.68, b: 0.60,
          r1: 0.86, g1: 0.84, b1: 0.80, kind: 1, acurve: 1
        });
      }
      // 火花：白热→橙，快速坠落
      for (let i = 0; i < 9; i++) {
        pFire.spawn({
          x: ix, y: iy + 0.4, z: iz,
          vx: (Math.random() - 0.5) * 30, vy: 8 + Math.random() * 22, vz: (Math.random() - 0.5) * 30,
          life: 0.36, s0: 2.0, s1: 0.4, alpha: 1, drag: 2.0, gravity: 24,
          r: 1.0, g: 0.92, b: 0.62, r1: 0.85, g1: 0.25, b1: 0.03, kind: 2, acurve: 2
        });
      }
      // 少量小石屑
      for (let i = 0; i < 4; i++) {
        pSmoke.spawn({
          x: ix, y: iy + 0.3, z: iz,
          vx: (Math.random() - 0.5) * 22, vy: 12 + Math.random() * 18, vz: (Math.random() - 0.5) * 22,
          life: 1.1, s0: 1.4, s1: 0.6, alpha: 0.9, drag: 0.4, gravity: 26,
          r: 0.14, g: 0.13, b: 0.12, kind: 2, acurve: 2
        });
      }
      const dImp = camera.position.distanceTo(_v3.set(ix, iy, iz));
      if (dImp < 500) Sound.noiseBurst(0.06, 900 + Math.random() * 500, 0.8, clamp(1 - dImp / 500, 0.05, 1) * 0.3, 'bandpass');
      break;
    }
    case 'ml': {
      Sound.missile(0.8);
      const st = game.own && game.own.state;
      if (st && e.id === game.myId) {
        game.shake = Math.max(game.shake, 0.25);
        if (e.dumb) pushCenter('无制导发射 — 哑弹直飞', 1.4);
        else Radio.say('launch', { gap: 1.0, pri: 1 });
      }
      break;
    }
    case 'fl': {
      Sound.noiseBurst(0.35, 900, 0.6, 0.16, 'bandpass');
      break;
    }
    // 发射被近地屏蔽拦下：1 = 地形遮挡，2 = 目标贴地杂波
    case 'mf': {
      pushCenter(e.r === 1 ? '无制导 — 地形遮挡' : '无制导 — 目标贴地杂波', 1.4);
      Sound.beep(240, 0.10, 0.10);
      break;
    }
    // 导弹导引头被近地屏蔽压死（转哑弹直飞）：自己打的才提示
    case 'mb': {
      if (e.p) {
        pSmoke.spawn({
          x: e.p[0], y: e.p[1], z: e.p[2],
          vx: 0, vy: 0, vz: 0, life: 0.8, s0: 5, s1: 16, alpha: 0.22, drag: 1.4, gravity: -1,
          r: 0.72, g: 0.72, b: 0.74
        });
      }
      if (e.o === game.myId) pushCenter('导弹丢失制导', 1.2);
      break;
    }
    case 'hit': {
      const v = game.views && game.views.get(e.v);
      if (v) {
        // 命中机身：白热火花窜 + 一闪即逝的火团 + 焦烟
        for (let i = 0; i < 16; i++) {
          pFire.spawn({
            x: v.pos.x, y: v.pos.y, z: v.pos.z,
            vx: (Math.random() - 0.5) * 55, vy: (Math.random() - 0.5) * 55, vz: (Math.random() - 0.5) * 55,
            life: 0.34, s0: 3.4, s1: 0.4, alpha: 1, drag: 2.4, gravity: 5,
            r: 1.0, g: 0.94, b: 0.68, r1: 0.9, g1: 0.28, b1: 0.03, kind: 2, acurve: 2
          });
        }
        // 命中火团（加色、短促）
        pFire.spawn({
          x: v.pos.x, y: v.pos.y, z: v.pos.z,
          vx: 0, vy: 0, vz: 0,
          life: 0.20, s0: 5, s1: 13, alpha: 0.9, drag: 2, gravity: 0,
          r: 1.0, g: 0.9, b: 0.7, r1: 0.95, g1: 0.35, b1: 0.05, kind: 0, acurve: 0
        });
        for (let i = 0; i < 6; i++) {
          pSmoke.spawn({
            x: v.pos.x, y: v.pos.y, z: v.pos.z,
            vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, vz: (Math.random() - 0.5) * 14,
            life: 1.0, s0: 3, s1: 14, alpha: 0.42, drag: 1.2, gravity: -0.5,
            r: 0.09, g: 0.085, b: 0.08,
            r1: 0.28, g1: 0.27, b1: 0.27, kind: 1, acurve: 1
          });
        }
      }
      if (v) spawnShockwave(v.pos.x, v.pos.y, v.pos.z, 0.12);
      if (e.v === game.myId) {
        game.hitFlash = 1;
        game.postFlash = 0.16;
        game.shake = Math.min(1.2, game.shake + 0.35);
        Sound.thud(0.5);
      }
      else if (e.a === game.myId) { game.hitMarker = 0.35; Radio.say('hit', { gap: 4.5, hold: 1.2 }); }
      if (e.v === game.myId && v) {
        // 受击方向指示：解算攻击者相对机头的方位（0=正前，右为正），HUD 画弧 1.25s
        const av = game.views.get(e.a);
        if (av) {
          _hdDir.set(av.pos.x - v.pos.x, av.pos.y - v.pos.y, av.pos.z - v.pos.z)
            .applyQuaternion(_hdInv.copy(v.quat).invert());
          game.hitDir = { ang: Math.atan2(_hdDir.x, -_hdDir.z), t: 1.25 };
        }
      }
      break;
    }
    case 'join': addKill(e.n + ' 加入战场', -1, false, '＋'); break;
    case 'leave': addKill(nameOf(e.id) + ' 离开', -1, false, '－'); break;
    case 'msg': addKill(e.t, -1, true, 'ℹ'); break;
    case 'end': showEnd(e); break;
  }
}

function nameOf(id) {
  if (id === game.myId) return '<b>' + (game.myName || '你') + '</b>';
  for (const r of game.roster) if (r.i === id) return r.n;
  const v = game.views && game.views.get(id);
  return v ? (v.e.n || '?') : ('#' + id);
}
function teamOf(id) {
  if (id === game.myId) return game.myTeam;
  for (const r of game.roster) if (r.i === id) return r.t;
  return -1;
}

// =============================================================================
// === 输入：键鼠 / 指针锁定 / 触控 ============================================
// =============================================================================
function requestLock() {
  if (game.touchMode) return;
  if (canvas.requestPointerLock) canvas.requestPointerLock();
}
canvas.addEventListener('click', () => {
  Sound.resume();
  if (game.playing && document.pointerLockElement !== canvas) requestLock();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) {
    // 释放鼠标时清空输入，避免“卡键”
    for (const k in keys) keys[k] = false;
    input.fire = false;
  }
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  game.mouse.x += e.movementX;
  game.mouse.y += e.movementY;
  // ⚠️ 钳制范围必须与消费端的映射行程一致：
  //   飞机：X/Y 都是 stickRange（240）
  //   舰上：X 走 stickRange（方位），Y 走 shipStickY（620，密位细档）——
  //   之前 Y 也被钳在 240，而密位按 620 归一化，射程被压成 3.4~9.7km 且滚轮一调就弹回。
  const lim = CONFIG.input.stickRange;
  game.mouse.x = clamp(game.mouse.x, -lim, lim);
  const limY = game.myShipId ? CONFIG.input.shipStickY : lim;
  game.mouse.y = clamp(game.mouse.y, -limY, limY);
});
// 滚轮：舰上 = 主炮密位微调（±35m/格）。飞机滚轮不用（油门是 W/S 增量）。
window.addEventListener('wheel', (e) => {
  if (!game.myShipId || !game.playing) return;
  game.aimRangeWheel = 1;
  game.aimRangeWheelDir = e.deltaY < 0 ? 1 : -1;    // 上滚打远，下滚打近
}, { passive: true });
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  // 舰上：左键主炮齐射 / 右键鱼雷
  if (game.myShipId) {
    if (e.button === 0) game.mouseDown = true;
    if (e.button === 2) pending.torp++;
    return;
  }
  if (e.button === 0) input.fire = true;
  if (e.button === 2) { input.missile = true; pending.missile++; }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) { input.fire = false; game.mouseDown = false; }
  if (e.button === 2) input.missile = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  switch (e.code) {
    case 'KeyC':
      // 舰上：循环 追尾 → 舰桥 → 主炮位 → 追尾
      if (game.myShipId) {
        const names = { 0: '舰桥视角', 1: '追尾视角', 2: '主炮位视角' };
        game.shipView = game.shipView === 1 ? 0 : (game.shipView === 0 ? 2 : 1);
        game.snapChase = true;
        pushCenter(names[game.shipView] || '追尾视角', 1.0);
        break;
      }
      game.view = game.view === 'chase' ? 'cockpit' : 'chase';
      game.snapChase = true;
      pushCenter(game.view === 'cockpit' ? '座舱视角' : '追尾视角', 1.0);
      break;
    case 'KeyW':
      // 舰上 W = 油门加档（0~3）
      if (game.myShipId && game.shipThr < 3) { game.shipThr++; pushCenter('油门 ' + ['停','慢','中','全'][game.shipThr], 0.8); }
      break;
    case 'KeyS':
      // 舰上 S = 油门减档（0 以下为倒车）
      if (game.myShipId && game.shipThr > -1) {
        game.shipThr--;
        pushCenter(game.shipThr < 0 ? '倒车' : ('油门 ' + ['停','慢','中','全'][game.shipThr] || '停'), 0.8);
      }
      break;
    case 'KeyG': input.gear = !input.gear; break;
    case 'KeyJ': {
      // 弹射起飞：在甲板上按 J。不在弹射位时服务端会先牵引到弹射位再自动弹射，
      // 所以这里的提示要按"是否已在弹射位"分别给，否则玩家会以为按错了。
      const st = game.own && game.own.state;
      let atSlot = false, onCv = false;
      if (st) {
        const cv = FP.carrierAt(st.pos.x, st.pos.z, 1.0);
        if (cv) {
          onCv = true;
          const l = FP.carrierLocal(st.pos.x, st.pos.z, cv);
          atSlot = l.along >= cv.catZ - 40;
        }
      }
      input.cat = true; pending.cat++;
      if (!onCv) pushCenter('不在甲板上 — 需降落到航母才能弹射', 1.6);
      else pushCenter(atSlot ? '弹射请求已发送' : '弹射请求已发送 — 将先牵引至弹射位', 1.4);
      break;
    }
    case 'KeyX':
      input.ab = !input.ab;
      pushCenter(input.ab ? '减速板 · 放下' : '减速板 · 收起', 0.9);
      Sound.airbrake(input.ab);
      break;
    case 'KeyF':
      // 舰上 F = 鱼雷；轰炸机 F = 投雷；战斗机 F = 干扰弹
      if (game.myShipId) {
        const sv = shipViews.get(game.myShipId);
        const ty = sv && sv.e ? sv.e.t : '';
        if (ty === 'bb') { pushCenter('战列舰没有鱼雷管 · 用主炮齐射', 1.8); break; }
        pending.torp++;
        pushCenter('鱼雷已发射', 1.2);
      }
      else if (game.own && game.own.state && game.own.state.atype === 'bomber') {
        const st = game.own.state;
        if ((st.torps | 0) <= 0) { pushCenter('鱼雷已用尽 · 只剩航弹（B）', 1.5); break; }
        // 客户端预判投放条件，避免"按了没反应像卡死"：
        // 服务端 dropTorpedo 要求 ≤65m 高、≤95m/s、水面上空
        if (st.pos.y > 65) { pushCenter('高度过高 · 降到 65m 以下再投雷', 1.6); break; }
        if (st.speed > 95) { pushCenter('速度过快 · 减到 350km/h 以下再投雷', 1.6); break; }
        const gh = window.__sky && window.__sky.terrain ? window.__sky.terrain(st.pos.x, st.pos.z) : -10;
        if (gh >= -3) { pushCenter('必须在水面上空投放', 1.6); break; }
        input.torp = true; pushCenter('鱼雷投放', 1.2);
      }
      else { input.flare = true; pending.flare++; }
      break;
    case 'KeyB':
      // 轰炸机 B = 投弹（原来 B 同时是刹车，两个动作会一起触发 —— 已把机轮刹车改到 Shift）
      if (game.own && game.own.state && game.own.state.atype === 'bomber') {
        if ((game.own.state.bombs | 0) <= 0) { pushCenter('航弹已用尽 · 只剩鱼雷（F）', 1.5); break; }
        input.bomb = true; pushCenter('航弹投放', 1.2);
      }
      break;
    case 'KeyR':
      // 舰上 R = 损管（按住生效）
      if (game.myShipId) pushCenter('损管作业中…', 0.9);
      break;
    case 'KeyM': Sound.muted = !Sound.muted; pushCenter(Sound.muted ? '静音' : '取消静音', 0.9); break;
    case 'KeyV':
      Radio.on = !Radio.on;
      if (!Radio.on) { Radio.q.length = 0; game.radioMsg = null; }
      pushCenter(Radio.on ? '无线电：开' : '无线电：关', 1.0);
      break;
    case 'KeyH': setHelp(domHelp.classList.contains('hidden')); break;
    case 'Backquote':
      game.hudMode = (game.hudMode + 1) % 3;
      game.hudTip = 1.4;
      break;
    case 'BracketLeft':
    case 'BracketRight': {
      // HUD 整体大小微调（记在本地，下次进游戏还是这个大小）
      const z = hudZoom() + (e.code === 'BracketRight' ? 0.1 : -0.1);
      game._hudZoom = clamp(Math.round(z * 100) / 100, 0.85, 1.5);
      localStorage.setItem('sky.hudZoom', String(game._hudZoom));
      applyUiScale();
      pushCenter('HUD 大小 ' + Math.round(game._hudZoom * 100) + '%', 1.1);
      break;
    }
    case 'KeyP': {
      // 游戏内快速切画质：自动 → 流畅 → 均衡 → 高清 → 极致
      const seq = ['auto', 'low', 'medium', 'high', 'ultra'];
      const next = seq[(seq.indexOf(game.qualityMode) + 1) % seq.length];
      setQualityMode(next, true);
      pushCenter('画质 · ' + QUALITY_LABEL[next], 1.4);
      break;
    }
    case 'Tab': e.preventDefault(); game.showBoard = true; break;
    case 'Enter': input.missile = true; pending.missile++; break;
    case 'Space': e.preventDefault(); input.fire = true; break;
  }
});
document.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') game.showBoard = false;
  if (e.code === 'Enter') input.missile = false;
  if (e.code === 'Space') input.fire = false;
});
// 失焦清理（切标签页/弹窗后不会卡住油门或机炮）
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  input.fire = false; input.missile = false; input.flare = false;
  input.throttleAxis = 0;
});

// ---- 触控 ----
function setupTouch() {
  game.touchMode = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!game.touchMode) return;
  domTouch.classList.remove('hidden');
  const stick = el('stick'), knob = el('stickKnob');
  let sx = 0, sy = 0, sid = null;
  const R = 52;
  const setKnob = () => { knob.style.transform = 'translate(' + sx + 'px,' + sy + 'px)'; };
  stick.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; sid = t.identifier;
    const r = stick.getBoundingClientRect();
    stick._cx = r.left + r.width / 2; stick._cy = r.top + r.height / 2;
    e.preventDefault();
  }, { passive: false });
  stick.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== sid) continue;
      let dx = t.clientX - stick._cx, dy = t.clientY - stick._cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      sx = dx; sy = dy; setKnob();
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) if (t.identifier === sid) { sid = null; sx = 0; sy = 0; setKnob(); }
  };
  stick.addEventListener('touchend', end);
  stick.addEventListener('touchcancel', end);
  game.stickState = () => ({ x: sx / R, y: sy / R });

  // 按钮
  const btns = document.querySelectorAll('#tbtns .tb');
  btns.forEach((b) => {
    const act = b.dataset.act;
    const on = (e) => {
      e.preventDefault();
      if (act === 'fire') input.fire = true;
      else if (act === 'msl') { input.missile = true; pending.missile++; }
      else if (act === 'flr') { input.flare = true; pending.flare++; }
      else if (act === 'gear') { input.gear = !input.gear; b.classList.toggle('on', !input.gear); }
      else if (act === 'view') { game.view = game.view === 'chase' ? 'cockpit' : 'chase'; game.snapChase = true; }
      else if (act === 'brake') input.brake = true;
      b.classList.add('on');
    };
    const off = (e) => {
      e.preventDefault();
      if (act === 'fire') input.fire = false;
      else if (act === 'msl') input.missile = false;
      else if (act === 'flr') input.flare = false;
      else if (act === 'brake') input.brake = false;
      if (act !== 'gear') b.classList.remove('on');
    };
    b.addEventListener('touchstart', on, { passive: false });
    b.addEventListener('touchend', off, { passive: false });
    b.addEventListener('touchcancel', off, { passive: false });
  });

  // 油门滑条
  const thr = el('thrWrap'), fill = el('thrFill');
  const setThr = (clientY) => {
    const r = thr.getBoundingClientRect();
    const v = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    game.throttleValue = v;
    fill.style.height = (v * 100) + '%';
  };
  thr.addEventListener('touchstart', (e) => { setThr(e.changedTouches[0].clientY); e.preventDefault(); }, { passive: false });
  thr.addEventListener('touchmove', (e) => { setThr(e.changedTouches[0].clientY); e.preventDefault(); }, { passive: false });
}

function updateInput(dt) {
  // --- 鼠标虚拟杆 ---
  // 飞机：带回中（松手回零，模拟自回中摇杆）。
  // 战舰：**绝不回中**。鼠标位置是炮塔的绝对方位指令，一回中就变成
  // "准星刚移到目标就自己飘回中心"，玩家永远锁不住目标 —— 这是瞄准手感崩掉的
  // 第二个根因（第一个是准星和落点用了两套坐标系）。
  let mx = game.mouse.x, my = game.mouse.y;
  if (!game.myShipId) {
    mx -= mx * CONFIG.input.autoCenter * dt;
    my -= my * CONFIG.input.autoCenter * dt;
    game.mouse.x = mx; game.mouse.y = my;
  }

  let pitch = -my / CONFIG.input.stickRange;   // 鼠标上移 = 抬头
  let yaw = mx / CONFIG.input.stickRange;      // 鼠标右移 = 右转

  // --- 键盘 ---
  let roll = 0, rudder = 0, thrAxis = 0;
  if (keys['KeyA']) roll -= 1;
  if (keys['KeyD']) roll += 1;
  if (keys['KeyQ']) rudder -= 1;
  if (keys['KeyE']) rudder += 1;
  if (keys['KeyW']) thrAxis += 1;
  if (keys['KeyS']) thrAxis -= 1;
  // 方向键作为备用俯仰/偏航
  if (keys['ArrowUp']) pitch += 1;
  if (keys['ArrowDown']) pitch -= 1;
  if (keys['ArrowLeft']) yaw -= 1;
  if (keys['ArrowRight']) yaw += 1;

  if (game.touchMode && game.stickState) {
    const s = game.stickState();
    yaw += s.x;
    pitch += -s.y;
    roll += s.x * 0.5;
  }

  input.pitch = clamp(pitch, -1, 1);
  input.yaw = clamp(yaw, -1, 1);
  input.roll = clamp(roll, -1, 1);
  input.rudder = clamp(rudder, -1, 1);
  input.throttleAxis = clamp(thrAxis, -1, 1);
  // 调试/自动化：外部指定油门时优先（正常游戏下 devThrottle 为 -1）
  input.throttleSet = game.devThrottle >= 0 ? game.devThrottle
    : (game.touchMode ? game.throttleValue : -1);
  input.brake = game.touchMode ? input.brake : !!(keys['ShiftLeft'] || keys['ShiftRight']);
}

function sendInput() {
  if (!sock || !game.playing) return;
  const t = nowSec();
  // ---- 战舰玩家：单独的控制包（不走飞机 normalizeInput）----
  if (game.myShipId) {
    const st = updateShipControls();
    const t2 = nowSec();
    // 转向/开火变化立即上行，其余按 30Hz 节流（高频包会把一次性意图冲掉）
    const urgent = st.fireMain !== game.lastShipFire || st.rudder !== game.lastShipRud ||
      st.fireTorp || st.dc;
    if (!urgent && t2 - (game.shipSendAt || 0) < 1 / 30) return;
    game.shipSendAt = t2;
    game.lastShipFire = st.fireMain;
    game.lastShipRud = st.rudder;
    sock.emit('input', {
      thr: st.throttle, rud: st.rudder,
      fireMain: st.fireMain, tX: st.targetX, tZ: st.targetZ,
      torp: st.fireTorp, torpDir: st.torpDir, dc: st.dc
    });
    if (st.fireTorp) pending.torp = 0;   // 发射意图已上行，清掉计数
    if (t - game.lastPing > 1.0) { game.lastPing = t; sock.emit('ping', { t }); }
    return;
  }
  // ---- 飞机玩家 ----
  // 二值操纵（A/D/Q/E/W/S/G/ fire 等）发生变化时立即发送，不等 30Hz 节流：
  // 否则服务端比本地预测晚一个发送周期才开始动舵面，回滚修正会出现可感知的姿态抖动
  const ctlNow = input.roll + ',' + input.rudder + ',' + input.throttleAxis + ',' +
    (input.brake ? 1 : 0) + ',' + (input.ab ? 1 : 0) + ',' + (input.gear ? 1 : 0) + ',' + (input.fire ? 1 : 0);
  const edge = ctlNow !== game.lastCtl;
  game.lastCtl = ctlNow;
  if (!edge && t - game.inputSendAt < 1 / 30) return;
  game.inputSendAt = t;
  // 一次性意图用计数器缓存：快速点按（<33ms）不会在两次上行之间丢失
  // 导弹：锁定完成按下即发（一次性）；未锁定按住蓄力 → 按住期间持续上行 true，
  // 服务端按 holdMissile 累计时长，蓄满才发哑弹。松手回 false。
  const lockedNow = game.own && game.own.state &&
    game.own.state.lockProgress >= 1 && game.own.state.lockTargetId;
  const msl = lockedNow ? (pending.missile > 0 || input.missile) : input.missile;
  const flr = pending.flare > 0 || input.flare;
  const cat = pending.cat > 0 || input.cat;
  const payload = {
    pitch: input.pitch, yaw: input.yaw, roll: input.roll, rudder: input.rudder,
    throttleAxis: input.throttleAxis, throttleSet: input.throttleSet,
    brake: input.brake, ab: input.ab, gear: input.gear,
    fire: input.fire, missile: msl, flare: flr, cat: cat,
    torp: input.torp, bomb: input.bomb
  };
  sock.emit('input', payload);
  pending.missile = 0;
  pending.flare = 0;
  pending.cat = 0;
  input.flare = false;           // 干扰弹为一次性意图
  if (lockedNow) input.missile = false;   // 锁定发射=一次性；未锁定按住时保留 true（蓄力中）
  input.cat = false;             // 弹射请求同样一次性
  input.torp = false; input.bomb = false;   // 轰炸机投弹一次性
  // RTT 采样
  if (t - game.lastPing > 1.0) { game.lastPing = t; sock.emit('ping', { t }); }
}

// =============================================================================
// === 本地预测（与服务端同一套物理）===========================================
// =============================================================================
// 固定步长积分：客户端步长必须和服务端一致（1/simHz），否则每帧 dt 不同会让两边
// 的积分结果慢慢分叉，服务端每次回包都要把机位“拉回去”，看起来就是机身一顿一顿。
//
// 关键：本地推进用真实 dt 累加（稳定 60 步/秒，不受时钟估计噪声影响），
// 但**回包重放的步数按本地自己的时间轴算**（见 reconcile 的 n）。
// 之前用 serverNow() 算 n：时钟估计有几毫秒噪声，n 就在 2/3/4 之间乱跳，
// 每跳一次就差一整步 —— 200m/s 下每次回包机位来回抽 3.2m，肉眼就是“抽搐”。
const _poseA = { p: new THREE.Vector3(), q: new THREE.Quaternion(), ok: false };
const _poseB = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
const _qId = new THREE.Quaternion();

function predict(dt) {
  const st = game.own && game.own.state;
  const step = 1 / SIM.net.simHz;
  if (!st || !st.alive || st.wreck) {
    game.accum = 0;
    game.poseAlpha = 1;
    if (st) {
      game.renderPose.set(st.pos.x, st.pos.y, st.pos.z);
      game.renderQuat.set(st.quat.x, st.quat.y, st.quat.z, st.quat.w);
      _poseA.ok = false;
    }
    game.stTime = serverNow();
    return;
  }
  game.accum = Math.min(game.accum + dt, step * 5);
  let k = 0;
  while (game.accum >= step && k < 5) {
    _poseA.p.copy(st.pos); _poseA.q.copy(st.quat); _poseA.ok = true;
    game.hist.push({ t: game.stTime, dt: step, input: Object.assign({}, input) });
    game.tmpEvts.length = 0;
    FP.stepAircraft(st, input, step, game.tmpEvts);
    game.tmpEvts.length = 0;
    game.stTime += step;
    game.accum -= step;
    k++;
  }
  if (!_poseA.ok) {
    _poseA.p.copy(st.pos); _poseA.q.copy(st.quat); _poseA.ok = true;
    _poseB.p.copy(st.pos); _poseB.q.copy(st.quat);
  } else if (k) {
    _poseB.p.copy(st.pos); _poseB.q.copy(st.quat);
  }
  game.poseAlpha = clamp(game.accum / step, 0, 1);
  while (game.hist.length && game.hist[0].t < game.stTime - 1.5) game.hist.shift();

  game.renderPose.copy(_poseA.p).lerp(_poseB.p, game.poseAlpha);
  game.renderQuat.copy(_poseA.q).slerp(_poseB.q, game.poseAlpha);

  // 叠加“回包残差”：视觉上先停在原处，再平滑归零。
  // 位置残差由 renderOffset 承担（网格与相机都加同一份），姿态残差在这里叠加。
  if (Math.abs(game.quatErr.w) < 0.9999999) {
    game.renderQuat.multiply(game.quatErr);
  }
}

// =============================================================================
// === 远端插值 ================================================================
// =============================================================================
function viewObj(id) {
  let o = game.viewObjs.get(id);
  if (!o) {
    o = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), dir: new THREE.Vector3(), used: 0 };
    game.viewObjs.set(id, o);
  }
  return o;
}

function interpolate() {
  const snaps = game.snaps;
  if (!snaps.length) return;
  const rt = serverNow() - SIM.net.interpDelay;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > rt) i--;
  const A = snaps[i], B = snaps[i + 1] || A;
  const alpha = (B !== A) ? clamp((rt - A.t) / Math.max(1e-4, B.t - A.t), 0, 1) : 0;

  const mapB = new Map();
  for (const e of B.a) mapB.set(e.i, e);

  const out = new Map();
  const myTeam = game.myTeam | 0;
  const myBit = 1 << myTeam;
  for (const e of A.a) {
    // 敌机：必须被本队（自己或任一友军）发现才可见；友机始终可见
    if (e.tm !== myTeam && !(e.sp & myBit)) continue;
    const e2 = mapB.get(e.i);
    const o = viewObj(e.i);
    o.e = e;
    if (e2 && e2.sid === e.sid) {
      o.pos.set(lerp(e.p[0], e2.p[0], alpha), lerp(e.p[1], e2.p[1], alpha), lerp(e.p[2], e2.p[2], alpha));
      const qa = new THREE.Quaternion(e.q[0], e.q[1], e.q[2], e.q[3]);
      const qb = new THREE.Quaternion(e2.q[0], e2.q[1], e2.q[2], e2.q[3]);
      o.quat.copy(qa).slerp(qb, alpha);
    } else {
      o.pos.set(e.p[0], e.p[1], e.p[2]);
      o.quat.set(e.q[0], e.q[1], e.q[2], e.q[3]);
    }
    o.used = 1;
    out.set(e.i, o);
  }
  game.views = out;

  // 战舰插值（与飞机同一快照缓冲、同一插值延迟）
  if (A.sp) {
    interpolateShips(snaps, rt);
    // 我是否在某艘舰上（快照 ow 字段 = 玩家 id）
    const prevShip = game.myShipId;
    game.myShipId = 0;
    for (const s of A.sp) if (s.ow === game.myId) { game.myShipId = s.i; break; }
    // 上舰/下舰时切换键位面板（两套操作完全不同，混着显示会误导）
    if ((game.myShipId > 0) !== (prevShip > 0)) {
      updateHelpPanel();
      if (game.myShipId > 0) {
        autoHideHelp();
        game.hudTip = 12;
        // 上舰时把虚拟杆归零：飞机的鼠标位置是大行程的杆位，
        // 直接带过来会让炮塔一上舰就歪向某一舷（玩家会以为"视角又错了"）。
        // 默认略微上移：炮战默认打 6~8km，准星本来就该落在船前方的海面上，
        // 归零会让准星正好压在自家舰桥顶上（玩家第一反应是"准星被挡住了"）。
        game.mouse.x = 0; game.mouse.y = -CONFIG.input.shipStickY * 0.225;   // ≈-140，密位档行程下仍打 6~8km
        game.aimRangeY = undefined;               // 清掉上一次上舰残留的密位状态（可能超出 ±1）
        // 上舰先停车：AI 交船时油门还挂在 2 档，玩家光看 HUD 的几秒里
        // 船已经自己开出 1km 顶到浅滩上了（上来就是一动不动的搁浅状态）。
        game.shipThr = 0;
      }
    }
  }

  // 导弹
  const mb = new Map();
  for (const e of B.m) mb.set(e.i, e);
  const mv = new Map();
  for (const e of A.m) {
    const e2 = mb.get(e.i);
    const o = viewObj('m' + e.i);
    if (e2) o.pos.set(lerp(e.p[0], e2.p[0], alpha), lerp(e.p[1], e2.p[1], alpha), lerp(e.p[2], e2.p[2], alpha));
    else o.pos.set(e.p[0], e.p[1], e.p[2]);
    o.dir.set(e.d[0], e.d[1], e.d[2]);
    o.b = e.b || 0;                  // 1 = 导引头被近地屏蔽压死（哑弹直飞）
    o.used = 1;
    mv.set(e.i, o);
  }
  game.mViews = mv;

  // 干扰弹
  game.fViews = (A.f || []).map((e) => ({ i: e.i, p: new THREE.Vector3(e.p[0], e.p[1], e.p[2]) }));

  // 清理不再使用的可视对象
  for (const [k, o] of game.viewObjs) {
    if (!o.used) { game.viewObjs.delete(k); continue; }
    o.used = 0;
  }
}

// =============================================================================
// === 可视对象同步 ============================================================
// =============================================================================
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ownQuat = new THREE.Quaternion();
const _mAxis = new THREE.Vector3(0, 0, -1);
// 尾焰/曳光复用的临时向量（避免每帧 new）
const _flNoz = new THREE.Vector3();
const _flDir = new THREE.Vector3();
const _dist = new THREE.Vector3();
const _trFwd = new THREE.Vector3();
const _trMuz = new THREE.Vector3();
const _trDir = new THREE.Vector3();
const _hdDir = new THREE.Vector3();          // 受击方向解算
const _hdInv = new THREE.Quaternion();

// 导弹模型共享几何体（避免每帧创建）
const MISS_GEO = new THREE.ConeGeometry(0.5, 4.4, 6);
MISS_GEO.rotateX(-Math.PI / 2);
const MISS_FIN_GEO = new THREE.BoxGeometry(2.6, 0.15, 0.9);
const MISS_BODY_MAT = new THREE.MeshPhongMaterial({ color: 0xd8dde3, flatShading: true });
const MISS_FIN_MAT = new THREE.MeshPhongMaterial({ color: 0x8b9299, flatShading: true });

function syncMeshes(dt) {
  const seen = new Set();
  const ownSt = game.own && game.own.state;
  // ---- 防空阵地：懒建模型 / 显隐 / 炮塔指向 / 受损冒烟 ----
  for (const s of game.aaas) {
    let ud = game.aaaMeshes.get(s.i);
    if (!ud) {
      ud = buildAaaMesh(s.tm);
      ud.group.position.set(s.p[0], s.p[1], s.p[2]);
      scene.add(ud.group);
      game.aaaMeshes.set(s.i, ud);
    }
    ud.group.visible = !!s.al;
    if (!s.al) continue;
    const tv = s.ta ? game.views.get(s.ta) : null;
    if (tv) {
      const dx = tv.pos.x - s.p[0], dy = tv.pos.y - (s.p[1] + 4.6), dz = tv.pos.z - s.p[2];
      // 管身沿 -Z：yaw = atan2(-dx, -dz)；rotation.x 正值 = 抬头
      ud.barrel.rotation.y = Math.atan2(-dx, -dz);
      ud.barrel.rotation.x = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.2, 1.25);
    }
    if (s.hp < 55 && Math.random() < 0.45) {
      pSmoke.spawn({
        x: s.p[0] + (Math.random() - 0.5) * 6, y: s.p[1] + 5, z: s.p[2] + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * 3, vy: 6 + Math.random() * 5, vz: (Math.random() - 0.5) * 3,
        life: 2.2, s0: 3, s1: 16, alpha: 0.30, drag: 0.4, gravity: -1,
        r: 0.13, g: 0.12, b: 0.12
      });
    }
  }
  for (const [id, v] of game.views) {
    seen.add(id);
    let m = game.meshes.get(id);
    if (!m) {
      // 机种分型：轰炸机用独立建模（双发、大翼展、弹舱）
      m = (v.e.at === 'b') ? buildBomberMesh(v.e.tm) : buildPlaneMesh(v.e.tm);
      scene.add(m);
      game.meshes.set(id, m);
    }
    const isOwn = id === game.myId;

    // 自己的飞机必须用“本地预测状态”，否则追尾视角里机身会比相机慢半拍
    let px, py, pz;
    let mq = v.quat;
    if (isOwn && ownSt) {
      px = game.renderPose.x;
      py = game.renderPose.y;
      pz = game.renderPose.z;
      mq = _ownQuat.copy(game.renderQuat);
      px += game.renderOffset.x; py += game.renderOffset.y; pz += game.renderOffset.z;
    } else {
      px = v.pos.x; py = v.pos.y; pz = v.pos.z;
    }
    m.position.set(px, py, pz);
    m.quaternion.copy(mq);

    let e = v.e;
    if (isOwn && ownSt) {
      e = Object.assign({}, v.e, {
        thr: ownSt.throttle, gr: ownSt.gear, og: ownSt.onGround,
        hp: ownSt.health, al: ownSt.alive, wk: ownSt.wreck,
        s: ownSt.speed, st: ownSt.stalled,
        am: ownSt.ammo, ms: ownSt.missiles
      });
    }
    // 与相机的距离（特效 LOD / 音量衰减用）
    const near = _dist.set(px, py, pz).distanceTo(camera.position);
    // 死亡残骸：保持可见，改为燃烧下坠（服务端仍在模拟残骸物理）
    if (e.wk && !e.al) {
      // 主火舌：白热→橙红，噪声撕边
      pFire.spawn({
        x: px, y: py, z: pz,
        vx: (Math.random() - 0.5) * 10, vy: 3 + Math.random() * 6, vz: (Math.random() - 0.5) * 10,
        life: 0.45, s0: 9, s1: 20, alpha: 0.95, drag: 1.4, gravity: 2,
        r: 1.0, g: 0.72, b: 0.30,
        r1: 0.7, g1: 0.12, b1: 0.02, kind: 0, acurve: 0
      });
      // 拖在后面的小火苗（燃烧的碎片流）
      if (Math.random() < 0.6) {
        pFire.spawn({
          x: px + (Math.random() - 0.5) * 14, y: py + (Math.random() - 0.5) * 8, z: pz + (Math.random() - 0.5) * 14,
          vx: (Math.random() - 0.5) * 6, vy: 1 + Math.random() * 4, vz: (Math.random() - 0.5) * 6,
          life: 0.55, s0: 3.5, s1: 9, alpha: 0.8, drag: 1.2, gravity: 3,
          r: 1.0, g: 0.55, b: 0.14, r1: 0.6, g1: 0.1, b1: 0.02, kind: 0, acurve: 0
        });
      }
      // 浓黑烟柱（先鼓后散）
      pSmoke.spawn({
        x: px, y: py, z: pz,
        vx: (Math.random() - 0.5) * 8, vy: 6 + Math.random() * 8, vz: (Math.random() - 0.5) * 8,
        life: 2.0, s0: 8, s1: 44, alpha: 0.46, drag: 0.8, gravity: -1.5,
        r: 0.10, g: 0.095, b: 0.09,
        r1: 0.30, g1: 0.29, b1: 0.29, kind: 1, acurve: 1
      });
      // 掉落的火星
      if (Math.random() < 0.35) {
        pFire.spawn({
          x: px + (Math.random() - 0.5) * 10, y: py + (Math.random() - 0.5) * 6, z: pz + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 26, vy: -4 - Math.random() * 10, vz: (Math.random() - 0.5) * 26,
          life: 1.1, s0: 2.2, s1: 0.6, alpha: 1, drag: 0.2, gravity: 22,
          r: 1.0, g: 0.82, b: 0.4, r1: 0.8, g1: 0.16, b1: 0.02, kind: 2, acurve: 2
        });
      }
    }
    const ud = m.userData;
    // ---- 加力尾焰：三层羽流 + 激波钻石，随油门平滑伸出 ----
    // 单发（战斗机）走 ud.flame/flameLayers/flameDia；双发（轰炸机）走 ud.flameSets 数组。
    const ab = clamp((e.thr - CONFIG.fx.afterburner) / (1 - CONFIG.fx.afterburner), 0, 1);
    const flameOn = e.al && ab > 0.02;
    const sets = ud.flameSets || [{ grp: ud.flame, layers: ud.flameLayers, dia: ud.flameDia, noz: [0, 0, 7.0] }];
    const ft = nowSec();
    // 多层异频噪声叠加 → 真实的湍流闪动（每台发动机相位略不同）
    const nz = 0.78 + Math.sin(ft * 43 + id) * 0.07 + Math.sin(ft * 97) * 0.05 + Math.random() * 0.06;
    const nr = 0.88 + Math.sin(ft * 57 + id) * 0.08 + Math.random() * 0.06;
    const Ls = (0.4 + ab * 0.6) * nz;
    const Rs = (0.5 + ab * 0.5) * nr;
    for (let si = 0; si < sets.length; si++) {
      const fs = sets[si];
      if (!fs || !fs.grp) continue;
      fs.grp.visible = flameOn;
      if (!flameOn) continue;
      const jit = si === 0 ? 1 : (0.94 + Math.sin(ft * 61 + si * 2.7) * 0.06);
      const R = Rs * jit, L = Ls * jit;
      const lay = fs.layers;
      lay[0].scale.set(R, R, L);                       // 外焰
      lay[1].scale.set(R * 0.72, R * 0.72, L * 0.78);  // 主焰
      lay[2].scale.set(R * 0.42, R * 0.42, L * 0.55);  // 核心
      lay[0].material.opacity = 0.22 * ab;
      lay[1].material.opacity = 0.40 * ab;
      lay[2].material.opacity = 0.95 * ab;
      // 激波钻石：全加力才浮现（驻波亮点）
      const diaOn = ab > 0.88;
      for (let i = 0; i < fs.dia.length; i++) {
        const d = fs.dia[i];
        d.visible = diaOn;
        if (diaOn) d.material.opacity = (0.55 + Math.sin(ft * 90 + i * 2.1) * 0.25) * clamp((ab - 0.88) / 0.12, 0, 1);
      }
      // 喷口射流粒子（从每台发动机喷口真实位置向后喷）
      if (isOwn || near < 2600) {
        _flNoz.set(fs.noz[0], fs.noz[1], fs.noz[2]).applyQuaternion(mq);
        _flDir.set(0, 0, 1).applyQuaternion(mq);
        const sp = 50 + ab * 160;
        pFire.spawn({
          x: px + _flNoz.x, y: py + _flNoz.y, z: pz + _flNoz.z,
          vx: _flDir.x * sp + (Math.random() - 0.5) * 16,
          vy: _flDir.y * sp + (Math.random() - 0.5) * 16,
          vz: _flDir.z * sp + (Math.random() - 0.5) * 16,
          life: 0.22 + ab * 0.14, s0: 1.0, s1: 3.6 + ab * 2.2, alpha: 0.26,
          drag: 2.6, gravity: 0, r: 1.0, g: 0.52, b: 0.16
        });
      }
    }
    // 喷口内壁辉光（任何油门都有微光，加力时变亮）
    if (ud.nozGlow) ud.nozGlow.material.opacity = e.al ? clamp(e.thr * 0.55, 0, 0.55) : 0;
    // 起落架
    if (ud.gear) ud.gear.visible = !!e.gr;
    // ---- 轰炸机动态件：螺旋桨 / 弹舱门 / 舵面 ----
    if (ud.props) {
      // 转速跟油门走；熄火后高速滑翔时桨叶被气流带着空转（真实且好认）
      const rpm = e.al ? clamp(0.14 + e.thr * 0.86, 0, 1)
        : clamp((e.s || 0) / 220, 0, 0.35);
      const spin = dt * (4 + rpm * 108);
      for (let i = 0; i < ud.props.length; i++) {
        const pr = ud.props[i];
        pr.grp.rotation.z = (pr.grp.rotation.z + spin) % (Math.PI * 2);
        pr.disc.material.opacity = rpm * 0.32;
      }
    }
    if (ud.bayDoors) {
      const tw = e.tw | 0, bw = e.bw | 0;
      // 弹药数减少 = 刚刚投放：舱门打开 2.8 秒再关上
      if (ud.lastTw >= 0 && (tw < ud.lastTw || bw < ud.lastBw)) ud.bayT = 2.8;
      ud.lastTw = tw; ud.lastBw = bw;
      if (ud.bayT > 0) ud.bayT -= dt;
      const want = ud.bayT > 0 ? 1 : 0;
      ud.bayOpen += (want - ud.bayOpen) * Math.min(1, dt * (want ? 9 : 3.0));
      for (const d of ud.bayDoors) d.rotation.z = d.userData.sign * ud.bayOpen * 1.34;
      if (ud.torpMesh) ud.torpMesh.visible = tw > 0;
      if (ud.bombs) for (let i = 0; i < ud.bombs.length; i++) ud.bombs[i].visible = i < bw;
    }
    if (ud.ailerons) {
      const cr = isOwn ? input.roll : (e.ctl ? e.ctl.r : 0);
      const cp = isOwn ? input.pitch : (e.ctl ? e.ctl.p : 0);
      const cy = isOwn ? input.yaw : (e.ctl ? e.ctl.y : 0);
      for (const a of ud.ailerons) a.rotation.x = -a.userData.sign * clamp(cr, -1, 1) * 0.26;
      for (const el of ud.elevators) el.rotation.x = -clamp(cp, -1, 1) * 0.20;
      for (const rd of ud.rudders) rd.rotation.y = clamp(cy, -1, 1) * 0.22;
    }
    // ---- 防御炮塔：转向最近的敌机（被咬尾时能看到炮口对着你）----
    // 之前这两座炮塔是焊死的半球 + 两根斜棍，完全没有"在还击"的感觉。
    if (ud.turrets) {
      // 找最近的敌机（相对本机、本机机体坐标系）
      let tgt = null, td = 1e9;
      for (const [oid, ov] of game.views) {
        if (oid === id || !ov.e.al || ov.e.tm === e.tm) continue;
        const dx = ov.pos.x - px, dy = ov.pos.y - py, dz = ov.pos.z - pz;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1600 && d < td) { td = d; tgt = { dx, dy, dz }; }
      }
      for (const tt of ud.turrets) {
        let wantYaw = 0, wantPitch = 0;
        if (tgt) {
          // 机体系：机头 -z。用四元数逆变换把世界方向转到机体坐标
          _hdDir.set(tgt.dx, tgt.dy, tgt.dz).applyQuaternion(_hdInv.copy(mq).invert());
          // 机体系下 atan2(-x, -z) = 相对机头的方位角（0 = 正前）
          wantYaw = Math.atan2(-_hdDir.x, -_hdDir.z);
          const hor = Math.max(1, Math.hypot(_hdDir.x, _hdDir.z));
          wantPitch = Math.atan2(_hdDir.y, hor);
          // 背部炮塔打不了正下方、腹部打不了正上方：按 kind 限位
          if (tt.kind === 'top') { wantYaw = clamp(wantYaw, -2.6, 2.6); wantPitch = clamp(wantPitch, -0.15, 1.25); }
          else { wantYaw = clamp(wantYaw, -2.6, 2.6); wantPitch = clamp(wantPitch, -1.25, 0.15); }
        } else {
          // 无目标：缓慢搜索扫视
          wantYaw = Math.sin(t * 0.6 + (tt.kind === 'top' ? 0 : 2.1)) * 0.85;
          wantPitch = tt.kind === 'top' ? 0.12 : -0.12;
        }
        const k2 = Math.min(1, dt * 2.6);
        tt.yaw += (wantYaw - tt.yaw) * k2;
        tt.pitch += (wantPitch - tt.pitch) * k2;
        // 模型里炮管朝 -z 伸；rotation.y 正 = 左转（与方位角符号相反）
        tt.yawGrp.rotation.y = tt.yaw;
        tt.pitGrp.rotation.x = -tt.pitch;
      }
    }
    // ---- 航行灯：左红右绿常亮；尾/腹频闪（双闪节奏）----
    if (ud.nav) {
      const lit = !!e.al;
      const ph = nowSec() % 1.0;
      const st = ph < 0.05 || (ph > 0.14 && ph < 0.19);
      ud.nav[0].visible = lit;
      ud.nav[1].visible = lit;
      ud.nav[2].visible = lit && st;
      ud.nav[3].visible = lit && st;
    }
    // ---- 翼下导弹：剩余几发露几发 ----
    if (ud.missiles) {
      const n = e.al ? (e.ms | 0) : 0;
      for (let i = 0; i < ud.missiles.length; i++) ud.missiles[i].visible = i < n;
    }
    // 座舱内构：只有自己 + 座舱视角才显示；同时隐藏外壳，否则机翼会挡住视线
    const inCockpit = !!(isOwn && game.view === 'cockpit' && e.al);
    if (ud.cockpit) ud.cockpit.visible = inCockpit;
    if (ud.shell) ud.shell.visible = !inCockpit;
    // 受伤冒烟
    if (e.al && e.hp < CONFIG.fx.smokeHealth && Math.random() < (1 - e.hp / CONFIG.fx.smokeHealth) * 0.9) {
      const hpr = 1 - e.hp / CONFIG.fx.smokeHealth;   // 0 轻伤 → 1 濒危
      pSmoke.spawn({
        x: px, y: py, z: pz,
        vx: (Math.random() - 0.5) * 6, vy: 2 + Math.random() * 4, vz: (Math.random() - 0.5) * 6,
        life: 1.6, s0: 4, s1: 26, alpha: 0.34, drag: 0.5, gravity: -1.5,
        r: 0.12, g: 0.11, b: 0.11,
        r1: 0.32, g1: 0.31, b1: 0.31, kind: 1, acurve: 1
      });
      // 重伤时偶发可见火苗（受损的发动机/油箱）
      if (hpr > 0.55 && Math.random() < 0.5) {
        pFire.spawn({
          x: px, y: py, z: pz,
          vx: (Math.random() - 0.5) * 8, vy: 4 + Math.random() * 6, vz: (Math.random() - 0.5) * 8,
          life: 0.35, s0: 4, s1: 8, alpha: 0.85, drag: 1.2, gravity: 1,
          r: 1.0, g: 0.62, b: 0.2, r1: 0.75, g1: 0.12, b1: 0.02, kind: 0, acurve: 0
        });
      }
    }
    // 尾迹（高空高速凝结尾）
    if (e.al && e.s > CONFIG.fx.contrailSpeed && py > 700) {
      const last = game.tracers.get('c' + id) || 0;
      const t = nowSec();
      if (t - last > CONFIG.fx.contrailInterval) {
        game.tracers.set('c' + id, t);
        for (const s of [-1, 1]) {
          const off = new THREE.Vector3(s * 6.2, -0.2, 0.6).applyQuaternion(mq);
          pSmoke.spawn({
            x: px + off.x, y: py + off.y, z: pz + off.z,
            vx: 0, vy: 1.2, vz: 0,
            life: 1.6, s0: 2.2, s1: 13, alpha: 0.30, drag: 0.3, gravity: 0,
            r: 0.93, g: 0.96, b: 1.0
          });
        }
      }
    }
    // 翼尖涡流（高 G 凝结）：大过载机动时翼尖拖出白色涡流索。
    // 真实飞机在湿度充足、机翼上表面低压区温度跌破露点时出现——空战里
    // 拉杆/滚转最激烈的瞬间最有观赏性，G 越大越浓，松杆立即消失。
    if (e.al && e.g > 2.6 && py < 8500) {
      const v = Math.min(1, (e.g - 2.6) / 2.6);          // 2.6G 起雾，5.2G 全浓
      const last = game.tracers.get('v' + id) || 0;
      const t = nowSec();
      if (t - last > 0.045) {
        game.tracers.set('v' + id, t);
        for (const s of [-1, 1]) {
          const off = new THREE.Vector3(s * 6.9, -0.05, 0.1).applyQuaternion(mq);
          pSmoke.spawn({
            x: px + off.x, y: py + off.y, z: pz + off.z,
            vx: 0, vy: 0, vz: 0,
            life: 0.9, s0: 0.9, s1: 5.5, alpha: 0.05 + 0.30 * v, drag: 0.2, gravity: 0,
            r: 0.92, g: 0.97, b: 1.0
          });
        }
      }
    }
    // ---- 机炮：单管（左翼根）细曳光 + 极小枪口焰 + 后坐 ----
    // 写实要点：真实 20~25mm 曳光弹是“细短光点”，只有弹头本身发光、没有大片尾焰；
    // 旧版 5.2px 粗、8 颗 42m 长链看起来像激光束，这里收敛到 1.8~2.6px、4 颗 14m 短冲。
    const firing = isOwn && ownSt
      ? (input.fire && ownSt.ammo > 0 && !ownSt.overheated)
      : !!e.fi;
    if (firing && e.al) {
      const last = game.tracers.get('g' + id) || 0;
      const t = nowSec();
      if (t - last > 0.07) {
        game.tracers.set('g' + id, t);
        const full = near < CONFIG.fx.tracerRange;
        // 弹链：6 段 12m 的小光点，远看是一条细虚线（替代原来那团“火球”）
        const chain = full ? 8 : 4;
        const spacing = full ? 9 : 18;
        const life = full ? 1.35 : 0.7;
        _trFwd.set(0, 0, -1).applyQuaternion(mq);
        // 炮口随型号：战斗机是左翼根单管，轰炸机是机鼻双联（左右交替出弹）
        const muzList = ud.muzzle;
        if (muzList && muzList.length) {
          game.muzIdx = ((game.muzIdx || 0) + 1) % muzList.length;
          _trMuz.copy(muzList[game.muzIdx]).applyQuaternion(mq);
        } else {
          _trMuz.set(-1.18, 0.20, -3.66).applyQuaternion(mq);
        }
        // 第一人称：弹链从机头前方 26m 起（否则炮口火光直接糊在脸上）
        const eye = isOwn && game.view === 'cockpit' ? 26 : 0;
        const mx = px + _trMuz.x + _trFwd.x * eye;
        const my = py + _trMuz.y + _trFwd.y * eye;
        const mz = pz + _trMuz.z + _trFwd.z * eye;
        // 弹速贴近 CONFIG.weapons.gun.speed(900)
        const spd = 890 + Math.random() * 50;
        _trDir.copy(_trFwd);
        _trDir.x += (Math.random() - 0.5) * 0.016;
        _trDir.y += (Math.random() - 0.5) * 0.016;
        _trDir.normalize();
        // 弹头光点 + 极短余辉（第 0 颗最亮，后面快速衰减成尾部）
        for (let k = 0; k < chain; k++) {
          const d = k * spacing;
          pFire.spawn({
            x: mx + _trDir.x * d, y: my + _trDir.y * d, z: mz + _trDir.z * d,
            vx: _trDir.x * spd, vy: _trDir.y * spd, vz: _trDir.z * spd,
            life, s0: k === 0 ? 1.55 : 0.95, s1: 0.45, alpha: k === 0 ? 0.95 : 0.46 - k * 0.03,
            drag: 0, gravity: 0,
            r: 1.0, g: k === 0 ? 0.90 : 0.70, b: k === 0 ? 0.64 : 0.28
          });
        }
        // 枪口焰：一闪即逝的小星芒（0.024s）
        const f = ud.gunFlash[(game.muzIdx || 0) % ud.gunFlash.length];
        if (f) {
          f.visible = true;
          const sc = 0.55 + Math.random() * 0.35;
          f.scale.set(sc, sc, 0.8 + Math.random() * 0.5);
          f.rotation.z = Math.random() * Math.PI;
        }
        ud.gunFlashT = 0.024;
        // 少量火药烟：真实机炮会在炮口留一小团灰烟（座舱视角不喷，否则糊屏）
        if (!(isOwn && game.view === 'cockpit') && Math.random() < 0.35) {
          pSmoke.spawn({
            x: mx, y: my, z: mz,
            vx: _trDir.x * 30 + (Math.random() - 0.5) * 4,
            vy: _trDir.y * 30 + (Math.random() - 0.5) * 4,
            vz: _trDir.z * 30 + (Math.random() - 0.5) * 4,
            life: 0.55, s0: 0.9, s1: 4.5, alpha: 0.16, drag: 2.4, gravity: 0.4,
            r: 0.55, g: 0.54, b: 0.52
          });
        }
        if (id === game.myId) {
          Sound.gun(1);
          game.shake = Math.min(0.10, game.shake + 0.016);   // 后坐振动（写实收敛）
        } else if (near < 600) Sound.gun(0.35);
      }
    }
    // 枪口火光衰减
    if (ud.gunFlashT > 0) {
      ud.gunFlashT -= dt;
      if (ud.gunFlashT <= 0) for (const gf of ud.gunFlash) if (gf) gf.visible = false;
    }
  }
  // 清理消失的飞机
  for (const [id, m] of game.meshes) {
    if (!seen.has(id)) {
      scene.remove(m);
      game.meshes.delete(id);
      game.tracers.delete('g' + id);
      game.tracers.delete('c' + id);
    }
  }

  // ---- 导弹 ----
  const mSeen = new Set();
  for (const [id, v] of game.mViews) {
    mSeen.add(id);
    let m = game.mMeshes.get(id);
    if (!m) {
      m = new THREE.Group();
      const body = new THREE.Mesh(MISS_GEO, MISS_BODY_MAT);
      m.add(body);
      const fin = new THREE.Mesh(MISS_FIN_GEO, MISS_FIN_MAT);
      fin.position.z = 1.9;
      m.add(fin);
      scene.add(m);
      game.mMeshes.set(id, m);
    }
    m.position.copy(v.pos);
    _q.setFromUnitVectors(_mAxis, v.dir);
    m.quaternion.copy(_q);
    // 尾烟：丢失制导的哑弹不再喷火，烟也变稀变灰 —— 一眼能看出“导弹跟丢了”
    const dumb = v.b === 1;
    pSmoke.spawn({
      x: v.pos.x, y: v.pos.y, z: v.pos.z,
      vx: -v.dir.x * 20, vy: -v.dir.y * 20, vz: -v.dir.z * 20,
      life: 0.9, s0: 3.5, s1: dumb ? 12 : 17, alpha: dumb ? 0.18 : 0.34, drag: 1.0, gravity: -0.6,
      r: dumb ? 0.62 : 0.85, g: dumb ? 0.62 : 0.85, b: dumb ? 0.64 : 0.86
    });
    if (!dumb) {
      pFire.spawn({
        x: v.pos.x - v.dir.x * 2, y: v.pos.y - v.dir.y * 2, z: v.pos.z - v.dir.z * 2,
        vx: 0, vy: 0, vz: 0, life: 0.16, s0: 4, s1: 8, alpha: 0.9, drag: 2, gravity: 0,
        r: 1, g: 0.7, b: 0.3
      });
    }
  }
  for (const [id, m] of game.mMeshes) {
    if (!mSeen.has(id)) { scene.remove(m); game.mMeshes.delete(id); }
  }

  // ---- 干扰弹 ----
  for (const f of game.fViews) {
    pFire.spawn({
      x: f.p.x, y: f.p.y, z: f.p.z,
      vx: (Math.random() - 0.5) * 8, vy: -6 + Math.random() * 4, vz: (Math.random() - 0.5) * 8,
      life: 0.4, s0: 9, s1: 3, alpha: 1, drag: 1.6, gravity: 3,
      r: 1, g: 0.92, b: 0.6
    });
  }
}

// =============================================================================
// === 相机 ====================================================================
// =============================================================================
const camTarget = new THREE.Vector3();
const camOffset = new THREE.Vector3();
const lookQ = new THREE.Quaternion();

const _camOff = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();   // 目标姿态（复用，避免每帧 new）
const _camFwdV = new THREE.Vector3();
const _shadowFocus = new THREE.Vector3();

// === 战舰相机：舰桥（跟随舰艏）/ 追尾 / 主炮位 ================================
// 鼠标控制准星：从相机发射线与海面（y≈0）求交 = 主炮瞄准点。
// 舰上视角比飞机简单：船慢，跟随平滑系数可以更松。
const _shipCamPos = new THREE.Vector3();
const _shipCamTgt = new THREE.Vector3();
function updateShipCamera(dt) {
  const v = shipViews.get(game.myShipId);
  if (!v) return;
  const e = v.e;
  const T = (SHIP_TYPES_CL && SHIP_TYPES_CL[e.t]) || null;
  const len = T ? T.len : 180;
  const fb = T ? T.freeboard : 10;

  // ===========================================================================
  // 1. 先解算瞄准（相机要依赖它）——顺序很关键
  // ---------------------------------------------------------------------------
  // 上一版把「鼠标位置」直接映射成屏幕坐标画准星，而炮塔落点用世界坐标投影，
  // 这是两套坐标系，永远对不上：鼠标推到底时准星在屏幕 80% 处，
  // 而真正的指令点（方位偏 66°、射程 10km）早就跑出视野了。
  // 现在统一成一套：准星就画在**指令点的投影**上，玩家看到哪就打哪。
  // ===========================================================================
  const STICK = CONFIG.input.stickRange;
  const mx = clamp(game.mouse.x / STICK, -1, 1);
  game.aimMx = mx;

  // 方位：鼠标右移 → 炮塔右转。world heading 的「右」是负数方向，所以取负。
  const MAX_DEFL = 1.05;                       // ±60°，覆盖两舷大半射界
  const aimOff = -mx * MAX_DEFL;
  const aimYaw = v.h + aimOff;
  game.shipAimYaw = aimYaw;

  // 射程：鼠标上移打远。对数映射 —— 近处一格 0.3km、远处一格 3km，
  // 线性映射会让 3~10km 这段最常用的交战距离全挤在屏幕中间一小条里。
  // ⚠️ 密位细调（用户反馈"动一下就跳一大格子"）：
  //   1) 舰上鼠标 Y 走独立的细档行程（shipStickY = 620px，约为方位档的 2.6 倍），
  //      同样 1px 手移的射程变化在 10km 处从 ~24m 降到 ~9m；
  //   2) aimRangeY 用低通平滑（约 0.25s 时间常数），抖手不再直接打在落点上。
  //   3) mousemove 的钳制上限也走这个常量（否则射程上限被偷偷砍掉）。
  // 方位轴保持原行程 240px（转火快），只有密位轴变细。
  const R0 = 1500, R1 = 22000;
  const SHIP_STICK_Y = CONFIG.input.shipStickY;   // 与 mousemove 钳制共用同一个常量
  const myRaw = clamp(game.mouse.y / SHIP_STICK_Y, -1, 1);
  if (game.aimRangeY === undefined) game.aimRangeY = myRaw;
  game.aimRangeY += (myRaw - game.aimRangeY) * Math.min(1, dt * 9);
  const my = clamp(game.aimRangeY, -1, 1);
  game.aimMy = my;
  // 滚轮微调：每格 ±35m。把当前射程换算回对数 k，平移后反解 aimRangeY，
  // 这样滚轮和鼠标共享同一映射，不会互相跳。
  if (game.aimRangeWheel) {
    const dir = game.aimRangeWheelDir || 1;
    game.aimRangeWheel = 0;
    const cur = R0 * Math.pow(R1 / R0, (1 - (game.aimRangeY + 1) / 2));
    const want = clamp(cur + dir * 35, R0, R1);
    const k2 = Math.log(want / R0) / Math.log(R1 / R0);
    game.aimRangeY = 1 - 2 * k2;
    game.mouse.y = game.aimRangeY * SHIP_STICK_Y;    // 同步杆位，鼠标不再"拉回去"
  }
  game.aimRange = R0 * Math.pow(R1 / R0, (1 - (my + 1) / 2));

  // 炮塔安装位（世界坐标）：落点从炮口量起，否则近距离时方位会偏
  const spot0 = (T && T.mainGuns && T.mainGuns.turretSpots && T.mainGuns.turretSpots[0]) || { along: 0.5, lateral: 0 };
  const along0 = (spot0.along || 0) * len * 0.5;
  const lat0 = (spot0.lateral || 0) * (T ? T.beam * 0.5 : 10);
  const bfx = -Math.sin(v.h), bfz = -Math.cos(v.h);      // 舰艏方向
  const brx = -bfz, brz = bfx;                           // 舰体右向
  const turX = v.p.x + bfx * along0 + brx * lat0;
  const turZ = v.p.z + bfz * along0 + brz * lat0;
  game.aimMuzX = turX;
  game.aimMuzZ = turZ;
  game.aimMuzY = v.p.y + fb + 3;

  const aimDX = -Math.sin(aimYaw), aimDZ = -Math.cos(aimYaw);
  game.shipAim.x = turX + aimDX * game.aimRange;
  game.shipAim.z = turZ + aimDZ * game.aimRange;
  game.aimDirX = aimDX;
  game.aimDirZ = aimDZ;

  // 炮塔实际指向：gy 是「相对舰体、右为正」的方位角 → 世界方位要取负
  const gy0 = (e.gy && e.gy.length) ? e.gy[0] : 0;
  const realYaw = v.h - gy0;
  game.turretOff = gy0;
  game.shipAimReal.x = turX + (-Math.sin(realYaw)) * game.aimRange;
  game.shipAimReal.z = turZ + (-Math.cos(realYaw)) * game.aimRange;

  // 鱼雷方向 = 准星方位（atan2(dz,dx) 形式，与 fireTorpedo 的 dir 约定一致）
  game.torpDir = Math.atan2(game.shipAim.z - v.p.z, game.shipAim.x - v.p.x);

  // ===========================================================================
  // 2. 相机：绕「瞄准方位」布置，而不是死盯舰艏
  // ---------------------------------------------------------------------------
  // 相机必须跟转，否则准星一旦偏出 FOV 半角（31°）就看不见落点了，
  // 玩家会把鼠标推到底但屏幕上什么都没有。跟随 90% 留 10% 余量：
  // 满偏 60° 时相机只转 54°，指令点仍在视野内偏 6°，同时能看出船在转向。
  // ===========================================================================
  // 跟随 100%：留余量的话准星会偏离画面中心（满偏 60° 时差 6°），
  // 玩家的直觉是"准星永远在正前方"，偏离反而要重新找。完全跟随之后
  // 水平方向准星恒定居中，垂直方向由射程决定（上=远），符合炮术直觉。
  const CAMSIDE = 1.0;
  const camYaw = v.h + aimOff * CAMSIDE;
  game.camYaw = camYaw;
  const cfx = -Math.sin(camYaw), cfz = -Math.cos(camYaw);   // 相机朝向前向
  const crx = -cfz, crz = cfx;                              // 相机右向
  const mode = game.shipView === undefined ? 1 : game.shipView;

  if (mode === 0) {
    // 舰桥：站在罗经平台前方（放在塔顶正中会卡进三脚桅的三条腿之间）。
    // 视角跟着瞄准方位环顾 —— 舰长本来就应该能朝目标方向看。
    _shipCamPos.set(
      v.p.x + bfx * (len * 0.05 + 12),
      v.p.y + fb + ((T && (T.type || T.id) === 'dd') ? 20 : 28),
      v.p.z + bfz * (len * 0.05 + 12));
    _shipCamTgt.set(
      _shipCamPos.x + cfx * 5000,
      _shipCamPos.y - 90,
      _shipCamPos.z + cfz * 5000);
  } else if (mode === 2) {
    // 主炮位：机位站在 0 号炮塔右后上方，但**视线朝瞄准方位**。
    // 之前这里是朝"炮塔实际指向"，结果炮塔还没转到位时准星直接跑出画面，
    // 这个视角就完全没法瞄准了。机位跟着炮塔（能看到炮管压在画面里），
    // 视线跟着指令（能瞄准），两者分离才是对的。
    const spot = (T && T.mainGuns && T.mainGuns.turretSpots[0]) || { along: 0.6, dy: 0 };
    const along = (spot.along || 0.6) * len * 0.5;
    const dy = spot.dy || 0;
    const tx = v.p.x + bfx * along;
    const tz = v.p.z + bfz * along;
    _shipCamPos.set(
      tx - cfx * len * 0.10 + brx * len * 0.03,
      v.p.y + fb + dy + (T ? T.beam * 0.50 : 12),
      tz - cfz * len * 0.10 + brz * len * 0.03);
    _shipCamTgt.set(
      _shipCamPos.x + cfx * 2000,
      _shipCamPos.y - (T ? T.beam * 0.9 : 20),
      _shipCamPos.z + cfz * 2000);
  } else {
    // 追尾：舰艉后上方 + 右舷偏移，绕 camYaw 旋转。
    const back = len * 0.95 + 52;
    const high = fb + 44 + len * 0.058;
    // 侧偏减小到 0.12L：侧偏越大，"相机→船"与"瞄准方位"的夹角越大，
    // 准星就会被顶偏出中线（0.22L 时偏右 106px，切视角还会变，很难适应）。
    const side = len * 0.12;
    _shipCamPos.set(
      v.p.x - cfx * back + crx * side,
      v.p.y + high,
      v.p.z - cfz * back + crz * side);
    // 视线严格对准**瞄准方位**（不是"相机→船"）：
    // 这样沿瞄准方位延伸出去的落点必然落在屏幕中线上，准星不会左右漂。
    // 代价是船偏到中线左侧约 6°（保留了一点 3/4 视角，还能读出舰体长度）。
    _shipCamTgt.set(
      _shipCamPos.x + cfx * 2000,
      _shipCamPos.y - 240,
      _shipCamPos.z + cfz * 2000);
  }

  // 相机平滑 + 瞬移吸附
  if (!game.camSmoothInit || game.snapChase) {
    game.camSmooth = _shipCamPos.clone();
    game.camSmoothInit = true;
    game.snapChase = false;
  } else if (game.camSmooth.distanceToSquared(_shipCamPos) > 500 * 500) {
    game.camSmooth.copy(_shipCamPos);
  }
  // 转向时相机跟转要快一点（否则准星会甩出画面），平移用同样的平滑
  game.camSmooth.lerp(_shipCamPos, clamp(dt * (mode === 0 ? 6.5 : 8.0), 0, 1));
  camera.position.copy(game.camSmooth);
  camera.lookAt(_shipCamTgt);
  camera.fov = mode === 0 ? 68 : (mode === 2 ? 58 : 62);
  camera.updateProjectionMatrix();
  sky.position.copy(camera.position);
}

// === 飞机相机 =================================================================
function updateCamera(dt) {
  // 调试机位（美术校准 / 自动化截图）：只有 __sky.setCam() 才会设置，正常玩家流程不触发
  if (game.camOverride) {
    camera.position.copy(game.camOverride.p);
    camera.lookAt(game.camOverride.l);
    if (camera.fov !== CONFIG.view.fov) { camera.fov = CONFIG.view.fov; camera.updateProjectionMatrix(); }
    return;
  }
  // ---- 舰上：战舰追尾/舰桥相机 ----
  if (game.myShipId) { updateShipCamera(dt); return; }
  const own = game.own && game.own.state;
  let px, py, pz;
  const quat = _camQuat;

  // ---- 死亡观战：被击落后的重生等待期，镜头跟随击杀者（拉更远的追尾位）----
  // 击杀者不在可见列表（未被本队发现）或已阵亡时回落到默认残骸镜头。
  let spectate = null;
  if (own && !own.alive && game.deathCamId) {
    const kv = game.views.get(game.deathCamId);
    if (kv && kv.e && (kv.e.al || kv.e.wk)) spectate = kv;
  }

  if (spectate) {
    px = spectate.pos.x; py = spectate.pos.y; pz = spectate.pos.z;
    quat.copy(spectate.quat);
  } else if (own) {
    // 注意：这里**不含** renderOffset。修正偏移必须最后精确叠加到相机上，
    // 否则相机 lerp 追赶偏移的每一跳，就会出现“机身在画面里蹭一下”的台阶。
    px = game.renderPose.x;
    py = game.renderPose.y;
    pz = game.renderPose.z;
    quat.copy(game.renderQuat);
  } else if (game.views.size) {
    const v = game.views.values().next().value;
    px = v.pos.x; py = v.pos.y; pz = v.pos.z; quat.copy(v.quat);
  } else {
    px = camera.position.x; py = camera.position.y; pz = camera.position.z;
  }

  // 平滑姿态（追尾相机跟随）
  if (game.camSnap) {
    game.smoothQuat.copy(quat);
    game.camSnap = false;
  } else if (game.view !== 'cockpit') {
    game.smoothQuat.slerp(quat, 1 - Math.exp(-dt * CONFIG.view.chaseLag));
  } else {
    game.smoothQuat.copy(quat);
  }

  // 机种视角：轰炸机体量大一圈，眼位在机鼻、追尾距离也要拉开
  const bigAircraft = !!(own && own.atype === 'bomber');
  const vOff = bigAircraft ? CONFIG.view.bomberCockpitOffset : CONFIG.view.cockpitOffset;

  if (game.view === 'cockpit' && own && !spectate) {
    _camOff.set(vOff.x, vOff.y, vOff.z)
      .applyQuaternion(quat);
    camera.position.set(px + _camOff.x, py + _camOff.y, pz + _camOff.z);
    camera.quaternion.copy(quat);
    game.camSmoothInit = false;      // 切回追尾时重新吸附，避免从旧位置飘过来
  } else {
    // 观战时拉得更远更高，过场镜头感
    const sizeK = bigAircraft ? CONFIG.view.bomberChaseScale : 1;
    const upN = (spectate ? CONFIG.view.chaseUp * 1.6 : CONFIG.view.chaseUp) * sizeK;
    const backN = (spectate ? CONFIG.view.chaseBack * 1.7 : CONFIG.view.chaseBack) * sizeK;
    const back = _camBack.set(0, upN, backN).applyQuaternion(game.smoothQuat);
    camTarget.set(px, py, pz).add(back);
    // 平滑位置必须单独存一份：如果直接对 camera.position 做 lerp，
    // 而偏移是在 lerp 之后叠加的，下一帧 lerp 又会把偏移“拉回去”，
    // 形成正反馈——相机会一路漂到机头前面去（表现为“飞机突然贴脸”）。
    if (!game.camSmooth) game.camSmooth = new THREE.Vector3().copy(camTarget);
    if (game.snapChase || !game.camSmoothInit) {
      game.camSmooth.copy(camTarget);
      game.camSmoothInit = true;
      camera.quaternion.copy(game.smoothQuat);
      game.snapChase = false;
    } else {
      game.camSmooth.lerp(camTarget, 1 - Math.exp(-dt * 10.5));
      camera.quaternion.slerp(game.smoothQuat, 1 - Math.exp(-dt * 8));
    }
    camera.position.copy(game.camSmooth);
  }

  // 修正偏移：与机身网格用同一份、同一帧精确叠加（不参与平滑）
  // 观战时不叠加——renderOffset 是自己残骸的修正量，跟击杀者无关
  if (own && !spectate) camera.position.add(game.renderOffset);

  // 速度感：高速时轻微拉大 FOV；座舱视角整体收窄
  const baseFov = (game.view === 'cockpit' && own) ? CONFIG.view.cockpitFov : CONFIG.view.fov;
  const fovTarget = baseFov + clamp(((own ? own.speed : 0) - 120) / 320, 0, 1) * 7;
  if (Math.abs(camera.fov - fovTarget) > 0.02) {
    camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * 2.2);
    camera.updateProjectionMatrix();
  }

  // 相机震动
  if (game.shake > 0.001) {
    game.shake = Math.max(0, game.shake - CONFIG.view.shakeDecay * dt * game.shake);
    const s = game.shake * 0.9;
    const ts = nowSec();
    // 逐帧 Math.random() 是白噪声：帧率越高抖动频率越高，看起来就是“掉帧/抽帧”。
    // 改成几组固定频率正弦叠加，抖的是机体（低频），但每一帧都是连续的。
    camera.position.x += (Math.sin(ts * 41.3) * 0.62 + Math.sin(ts * 73.1 + 1.7) * 0.38) * s;
    camera.position.y += (Math.sin(ts * 47.9 + 2.1) * 0.62 + Math.sin(ts * 67.3) * 0.38) * s;
    camera.position.z += Math.sin(ts * 36.7 + 0.8) * 0.5 * s;
    camera.rotateZ(Math.sin(ts * 31.1 + 0.4) * s * 0.02);
  }

  // 天空跟随相机
  sky.position.copy(camera.position);
  // 海面跟随（保持波纹连续：按整格吸附）
  seaMesh.position.x = Math.round(camera.position.x / 2000) * 2000;
  seaMesh.position.z = Math.round(camera.position.z / 2000) * 2000;
  // 阴影焦点放在视线前方：脚下的阴影反而不常看见，机头前方的目标/地面更重要
  _camFwdV.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _shadowFocus.copy(camera.position).addScaledVector(_camFwdV, 70);
  sun.position.copy(_shadowFocus).addScaledVector(SUN_DIR, 1600);
  sun.target.position.copy(_shadowFocus);
  sun.target.updateMatrixWorld();
}

// ---- 座舱内构：可见性 + 抖动/光照 ----
// 未开局时：绕本方机场缓慢环拍，给大厅一个真实场景背景
const MENU_AP = FP.AIRPORTS[0];
const _menuLook = new THREE.Vector3();
function updateMenuCamera(t) {
  // 调试机位（美术校准用）：不影响正常流程
  if (game.camOverride) {
    camera.position.copy(game.camOverride.p);
    camera.lookAt(game.camOverride.l);
    if (camera.fov !== CONFIG.view.fov) { camera.fov = CONFIG.view.fov; camera.updateProjectionMatrix(); }
    sky.position.copy(camera.position);
    seaMesh.position.x = Math.round(camera.position.x / 2000) * 2000;
    seaMesh.position.z = Math.round(camera.position.z / 2000) * 2000;
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 1600);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    CLOUDS.update(camera, t);
    SKY.update(t);
    return;
  }
  // 机位放在背光侧、朝太阳方向看：天空亮、机场有轮廓光
  const a = Math.sin(t * 0.045) * 0.55;
  const R = 320;
  const cx = MENU_AP.x, cz = MENU_AP.z;
  const bx = SUN_DIR.x * Math.cos(a) + SUN_DIR.z * Math.sin(a);
  const bz = SUN_DIR.z * Math.cos(a) - SUN_DIR.x * Math.sin(a);
  const y = MENU_AP.elev + 30 + Math.sin(t * 0.17) * 3;
  camera.position.set(cx + bx * R, y, cz + bz * R);
  _menuLook.set(cx - SUN_DIR.x * 60, MENU_AP.elev + 14, cz - SUN_DIR.z * 60);
  camera.lookAt(_menuLook);
  if (camera.fov !== CONFIG.view.fov) { camera.fov = CONFIG.view.fov; camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
  seaMesh.position.x = Math.round(camera.position.x / 2000) * 2000;
  seaMesh.position.z = Math.round(camera.position.z / 2000) * 2000;
  sun.position.copy(camera.position).addScaledVector(SUN_DIR, 1600);
  sun.target.position.copy(camera.position);
  sun.target.updateMatrixWorld();
  CLOUDS.update(camera, t);
  SKY.update(t);
}

function inCockpitView() {
  const o = game.own && game.own.state;
  return !!(game.playing && game.view === 'cockpit' && o && o.alive);
}

const _cpSunV = new THREE.Vector3();
const _cpInvQ = new THREE.Quaternion();
function updateCockpitCam(dt) {
  const o = game.own && game.own.state;
  const t = performance.now() * 0.001;
  let amp = 0;
  if (o) {
    const g = Math.abs(o.gLoad || 1);
    amp = Math.min(0.0055, Math.max(0, g - 1) * 0.0011)
      + (o.stalled ? 0.004 : 0)
      + Math.min(0.003, Math.max(0, o.speed - 170) * 0.000018);
  }
  // 高频小抖动：仪表台跟着机身颤，比整屏乱晃更真实
  cpCamera.position.set(Math.sin(t * 41.3) * amp * 0.6, Math.sin(t * 33.7) * amp, Math.sin(t * 27.1) * amp * 0.4);
  cpCamera.rotation.set(Math.sin(t * 29.3) * amp * 0.35, Math.sin(t * 24.1) * amp * 0.25, Math.sin(t * 37.9) * amp * 0.3);
  // 阳光随机身姿态变化：转弯/拉起时座舱内的光斑会移动
  const sunD = (o && o.atype === 'bomber') ? BOMBER_COCKPIT.userData.sun : cpScene.userData.sun;
  if (sunD && o) {
    _cpInvQ.copy(o.quat).invert();
    _cpSunV.copy(SUN_DIR).applyQuaternion(_cpInvQ);
    sunD.position.copy(_cpSunV).multiplyScalar(3);
  }
}

// =============================================================================
// === HUD（全透明，无黑色矩形）===============================================
// =============================================================================
let hudW = 0, hudH = 0, hudDpr = 1;

// =============================================================================
// === 画质档位（自动 / 流畅 / 均衡 / 高清 / 极致）=============================
// =============================================================================
const QUALITY_PRESETS = {
  low:    { scale: 0.62, msaa: 0, bloom: false, shadow: false, clouds: 0.30, exposure: 1.06, cloudDetail: 0 },
  medium: { scale: 0.80, msaa: 0, bloom: true,  shadow: false, clouds: 0.60, exposure: 1.03, cloudDetail: 0 },
  high:   { scale: 0.94, msaa: 2, bloom: true,  shadow: true,  clouds: 1.00, exposure: 1.00, cloudDetail: 1 },
  ultra:  { scale: 1.06, msaa: 4, bloom: true,  shadow: true,  clouds: 1.00, exposure: 0.98, cloudDetail: 1 }
};
const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];
const QUALITY_LABEL = { auto: '自动', low: '流畅', medium: '均衡', high: '高清', ultra: '极致' };
game.qualityMode = 'auto';
game.qualityLevel = 'high';
game.qualityScale = QUALITY_PRESETS.high.scale;
game.postFlash = 0;          // 受击闪白（后处理用）
game.qHold = 0;              // 高档位稳定计时（防抖）

function refreshShadowMaterials() {
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => { if (x) x.needsUpdate = true; });
    else m.needsUpdate = true;
  });
}

function applyQualityLevel(level, scaleOverride) {
  const p = QUALITY_PRESETS[level] || QUALITY_PRESETS.high;
  game.qualityLevel = level;
  game.qualityScale = scaleOverride !== undefined ? scaleOverride : p.scale;
  POSTFX.setScale(game.qualityScale);
  POSTFX.setSamples(p.msaa);
  POSTFX.setBloom(p.bloom);
  if (renderer.shadowMap.enabled !== p.shadow) {
    renderer.shadowMap.enabled = p.shadow;
    sun.castShadow = p.shadow;
    // 开关阴影会改变 shader 的 USE_SHADOWMAP 分支，必须让材质重编译一次
    refreshShadowMaterials();
  }
  CLOUDS.setDensity(p.clouds);
  CLOUDS.setDetail(p.cloudDetail);
}

function setQualityMode(mode, persist) {
  game.qualityMode = QUALITY_ORDER.indexOf(mode) >= 0 ? mode : 'auto';
  if (game.qualityMode === 'auto') {
    applyQualityLevel('high', QUALITY_PRESETS.high.scale * 0.93);
  } else {
    applyQualityLevel(game.qualityMode);
  }
  if (persist) {
    try { localStorage.setItem('sky.quality', game.qualityMode); } catch (e) { /* 隐私模式忽略 */ }
  }
  const sel = document.getElementById('qualitySel');
  if (sel) sel.value = game.qualityMode;
}

// 画质档位切换后：canvas 保持全分辨率（HUD/文字永远清晰），
// 只有 3D 内部渲染分辨率随档位缩放，所以这里不再改 renderer 的 pixelRatio。
function applyPixelRatio() {
  const base = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
  renderer.setPixelRatio(base);
  POSTFX.setSize(window.innerWidth, window.innerHeight, base);
  POSTFX.setScale(game.qualityScale || 1);
}

// 自适应：先降内部渲染分辨率；降到底仍然卡，再降特效档；恢复后缓慢升回
function adaptQuality(dt) {
  const inst = 1 / Math.max(0.008, dt);
  game.fpsAvg += (inst - game.fpsAvg) * Math.min(0.12, dt * 2.5);
  if (!game.playing || game.qualityMode !== 'auto') return;
  game.qTimer = (game.qTimer || 0) + dt;
  if (game.qTimer < 2.0) return;
  game.qTimer = 0;

  if (game.fpsAvg < 50) {
    game.qHold = 0;
    if (game.qualityScale > 0.64) {
      applyQualityLevel(game.qualityLevel, Math.max(0.62, game.qualityScale - 0.09));
    } else {
      const i = QUALITY_ORDER.indexOf(game.qualityLevel);
      if (i > 0) applyQualityLevel(QUALITY_ORDER[i - 1], QUALITY_PRESETS[QUALITY_ORDER[i - 1]].scale * 0.93);
    }
  } else if (game.fpsAvg > 57) {
    game.qHold += 2.0;
    if (game.qHold > 7) {
      game.qHold = 0;
      if (game.qualityScale < 0.98) {
        applyQualityLevel(game.qualityLevel, Math.min(1.0, game.qualityScale + 0.07));
      } else {
        const i = QUALITY_ORDER.indexOf(game.qualityLevel);
        if (i < QUALITY_ORDER.length - 1) {
          applyQualityLevel(QUALITY_ORDER[i + 1], QUALITY_PRESETS[QUALITY_ORDER[i + 1]].scale * 0.93);
        }
      }
    }
  } else {
    game.qHold = 0;
  }
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  POSTFX.setSize(w, h, dpr);
  POSTFX.setScale(game.qualityScale || 1);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  cpCamera.aspect = w / h;
  cpCamera.updateProjectionMatrix();
  hudDpr = Math.min(dpr, 1.5);        // HUD 文字不需要跟到 2x，省一半 2D 填充
  hudW = w; hudH = h;
  hudCanvas.width = Math.floor(w * hudDpr);
  hudCanvas.height = Math.floor(h * hudDpr);
  hudCanvas.style.width = w + 'px';
  hudCanvas.style.height = h + 'px';
  hudCtx.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
  pFire.setPixelRatio(dpr);
  pSmoke.setPixelRatio(dpr);
  applyUiScale();
}
window.addEventListener('resize', resize);
resize();

function hudText(txt, x, y, opt) {
  const o = opt || {};
  const c = hudCtx;
  c.font = (o.weight || 600) + ' ' + (o.size || 13) + 'px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
  c.textAlign = o.align || 'left';
  c.textBaseline = o.base || 'alphabetic';
  if (o.glow !== false) {
    c.shadowColor = o.shadow || 'rgba(0,0,0,0.9)';
    c.shadowBlur = o.blur || 8;
  } else {
    c.shadowBlur = 0;
  }
  c.fillStyle = o.color || '#eaf6ff';
  c.fillText(txt, x, y);
  c.shadowBlur = 0;
}
function hudLine(x1, y1, x2, y2, color, w) {
  const c = hudCtx;
  c.strokeStyle = color;
  c.lineWidth = w || 1.4;
  c.shadowColor = 'rgba(0,0,0,0.85)';
  c.shadowBlur = 4;
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  c.shadowBlur = 0;
}

// ---- 单位换算与格式化（航空惯例，全 HUD 统一走这里）----
// 距离：< 1km 用米（整数），≥ 1km 用公里（2km~10km 两位小数，更远一位）
function fmtDist(m) {
  if (!isFinite(m)) return '--';
  if (m < 0) return '--';
  if (m < 1000) return Math.round(m) + ' m';
  if (m < 10000) return (m / 1000).toFixed(2) + ' km';
  return (m / 1000).toFixed(1) + ' km';
}
// 音速随高度变化（对流层）：a = 340.29·√(T/288.15)，T = 288.15 − 0.0065·h
function soundSpeed(alt) {
  const T = Math.max(216.65, 288.15 - 0.0065 * Math.max(0, alt));
  return 340.29 * Math.sqrt(T / 288.15);
}

const _proj = new THREE.Vector3();
const _projCam = new THREE.Vector3();
function project(x, y, z) {
  // 相机背后的点会被透视除法翻到屏幕另一侧，投影后会拉出横跨全屏的怪线，必须先剔掉
  _projCam.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  if (_projCam.z > -0.5) return null;
  _proj.set(x, y, z).project(camera);
  if (_proj.z > 1) return null;
  return { x: (_proj.x * 0.5 + 0.5) * hudW, y: (-_proj.y * 0.5 + 0.5) * hudH };
}

// -----------------------------------------------------------------------------
// 本场引导：机场标记 + 跑道轮廓 + 下滑道/航向道（降落时最需要的东西）
// -----------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 轰炸机专用 HUD：航弹弹着点预测环 + 鱼雷投放包线
//   航弹是从机腹"扔"出去的，落点 = 初速 + 重力 + 空气阻力一起积分的结果，
//   玩家靠这个环去套目标（和真实轰炸瞄准具一个道理）。
// ---------------------------------------------------------------------------
function drawBomberHud(st, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  const ink = 'rgba(255,214,140,0.95)';
  const dim = 'rgba(255,214,140,0.55)';

  // ---- 航弹弹着点：从机腹投放点开始积分（与 dropBomb 的初速一致）----
  let px = st.pos.x, py = Math.max(2, st.pos.y - 4), pz = st.pos.z;
  let vx = st.vel.x, vy = st.vel.y, vz = st.vel.z;
  let tf = 0;
  const h = 1 / 25;
  let impact = null;
  for (let i = 0; i < 220; i++) {
    vy -= 9.81 * h;
    vx *= (1 - 0.02 * h); vz *= (1 - 0.02 * h);
    px += vx * h; py += vy * h; pz += vz * h;
    tf += h;
    const gh = Math.max(0, FP.terrainHeight(px, pz));
    if (py <= gh + 0.4) { impact = { x: px, y: gh + 0.4, z: pz, t: tf }; break; }
  }

  if (impact) {
    const p = project(impact.x, impact.y, impact.z);
    const haveBombs = (st.bombs || 0) > 0;
    const ringCol = haveBombs ? ink : 'rgba(255,120,90,0.75)';
    if (p && p.x > 0 && p.x < hudW && p.y > 0 && p.y < hudH) {
      // 落点环 + 十字
      const r = 11 * K;
      hudStroke((k) => {
        k.moveTo(p.x - r, p.y); k.arc(p.x, p.y, r, Math.PI, 0);
        k.moveTo(p.x + r, p.y); k.arc(p.x, p.y, r, 0, Math.PI);
        k.moveTo(p.x, p.y - r * 0.45); k.lineTo(p.x, p.y + r * 0.45);
        k.moveTo(p.x - r * 0.45, p.y); k.lineTo(p.x + r * 0.45, p.y);
      }, ringCol, 1.2);
      hudMono('IMPACT ' + impact.t.toFixed(1) + 's', p.x, p.y + r + 10 * K, 7 * K, ringCol, 'center', 600);
      // 从准星到落点的引导线（俯冲时几乎重合，平飞时明显在前方）
      hudStroke((k) => { k.moveTo(cx, cy); k.lineTo(p.x, p.y); }, dim, 0.9);
    } else {
      // 落点在屏幕外：底部给个方位
      const ang = Math.atan2(impact.z - st.pos.z, impact.x - st.pos.x);
      const yaw = FP.yprFromQuat(st.quat).yaw;
      let rel = ang - yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const bx = cx + Math.sin(rel) * 120 * K;
      hudStroke((k) => { k.moveTo(bx - 6 * K, cy + 46 * K); k.lineTo(bx, cy + 40 * K); k.lineTo(bx + 6 * K, cy + 46 * K); },
        ringCol, 1.1);
      hudMono('IMPACT ' + impact.t.toFixed(1) + 's', bx, cy + 58 * K, 6.8 * K, ringCol, 'center', 600);
    }
  }

  // ---- 鱼雷投放包线：高度 < 65m、速度 < 95m/s、下方是海 ----
  const torps = st.torps || 0;
  const gh = FP.terrainHeight(st.pos.x, st.pos.z);
  const overSea = gh < -3;
  const altOk = st.pos.y <= 65;
  const spdOk = st.speed <= 95;
  const ready = torps > 0 && overSea && altOk && spdOk;
  let why = '';
  if (torps <= 0) why = 'NO TORP';
  else if (!overSea) why = 'OVER LAND';
  else if (!altOk) why = 'ALT HIGH';
  else if (!spdOk) why = 'TOO FAST';

  // 投放包线指示：机头前方 900m 的两条平行线（鱼雷航迹示意）
  if (torps > 0 && overSea) {
    const yaw = FP.yprFromQuat(st.quat).yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = -fz, rz = fx;
    const a1 = project(st.pos.x + fx * 260 + rx * 42, 1.2, st.pos.z + fz * 260 + rz * 42);
    const a2 = project(st.pos.x + fx * 900 + rx * 42, 1.2, st.pos.z + fz * 900 + rz * 42);
    const b1 = project(st.pos.x + fx * 260 - rx * 42, 1.2, st.pos.z + fz * 260 - rz * 42);
    const b2 = project(st.pos.x + fx * 900 - rx * 42, 1.2, st.pos.z + fz * 900 - rz * 42);
    if (a1 && a2 && b1 && b2) {
      hudStroke((k) => {
        k.moveTo(a1.x, a1.y); k.lineTo(a2.x, a2.y);
        k.moveTo(b1.x, b1.y); k.lineTo(b2.x, b2.y);
      }, ready ? 'rgba(150,255,196,0.55)' : 'rgba(255,150,110,0.45)', 1.0);
    }
  }

  const boxY = cy + 74 * K;
  hudMono('TORP ' + torps + (ready ? '  READY' : (why ? '  ' + why : '')),
    cx - 40 * K, boxY, 7.4 * K,
    ready ? 'rgba(150,255,196,0.95)' : 'rgba(255,170,120,0.90)', 'right', 700);
  hudMono('BOMB ' + (st.bombs || 0), cx + 40 * K, boxY, 7.4 * K, ink, 'left', 700);
}

function drawHomeBase(st, ypr, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  const ap = FP.teamAirport(game.myTeam);
  const dx = ap.x - st.pos.x, dz = ap.z - st.pos.z;
  const dist = Math.hypot(dx, dz);

  const loc = FP.airportLocal(ap, st.pos.x, st.pos.z);
  const fromFar = loc.along > 0;                 // 从跑道远端进近
  const hx = fromFar ? -ap.hx : ap.hx;           // 进近航向
  const hz = fromFar ? -ap.hz : ap.hz;
  const baseCol = game.myTeam === 0 ? COL.teamHud0 : COL.teamHud1;

  // ---- 机场标记：屏幕上画菱形；出了视野/在身后就贴边指方向（回航用）----
  const p0 = project(ap.x, ap.elev + 6, ap.z);
  let p = p0;
  // 座舱视角：机场标记落到仪表盘后面就别画了（否则字形压在 MFD 上）
  if (p && game.view === 'cockpit' && p.y > hudH - 330 * K) p = null;
  const onScreen = p && p.x > 26 * K && p.x < hudW - 26 * K && p.y > 40 * K && p.y < hudH - 26 * K;

  if (onScreen) {
    c.strokeStyle = baseCol; c.lineWidth = 1.6;
    c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(p.x, p.y - 9); c.lineTo(p.x + 9, p.y); c.lineTo(p.x, p.y + 9); c.lineTo(p.x - 9, p.y);
    c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(p.x - 13, p.y); c.lineTo(p.x + 13, p.y); c.stroke();
    c.shadowBlur = 0;
    hudText('本场 ' + fmtDist(dist), p.x, p.y - 16, { size: 11, align: 'center', color: baseCol });
  } else {
    // 屏幕外：把机场方向压到屏幕边缘，画箭头 + 距离
    const inset = 46 * K;
    let ex, ey;
    if (p0) {
      // 在视野前方但超出安全区：按投影方向贴边
      ex = p0.x - hudW / 2; ey = p0.y - hudH / 2;
    } else {
      // 在相机背后：贴左右边缘（箭头指向该往哪边转），别压住底部的武器块和字幕
      const hdgRad = -ypr.yaw;
      let rel = Math.atan2(dx, -dz) - hdgRad;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      ex = rel >= 0 ? 1 : -1;
      ey = 0.32;
    }
    const mx = hudW / 2 - inset, my = hudH / 2 - inset;
    const k = Math.min(mx / Math.max(1e-4, Math.abs(ex)), my / Math.max(1e-4, Math.abs(ey)));
    const x = hudW / 2 + ex * k, y = hudH / 2 + ey * k;
    const ang = Math.atan2(ey, ex);
    const tri = 9 * K;
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = baseCol;
    c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(tri, 0); c.lineTo(-tri * 0.72, -tri * 0.72); c.lineTo(-tri * 0.3, 0); c.lineTo(-tri * 0.72, tri * 0.72);
    c.closePath(); c.fill();
    c.restore();
    // 文字放在箭头内侧（左右贴边时向屏幕里侧让开）
    let lx = x - Math.cos(ang) * 22 * K;
    let ly = y - Math.sin(ang) * 22 * K;
    lx = clamp(lx, 70 * K, hudW - 70 * K);
    ly = clamp(ly, 70 * K, hudH - 26 * K);
    hudText('本场 ' + fmtDist(dist), lx, ly, { size: 11, align: 'center', color: baseCol });
  }

  // 远的只留方向箭头，不再画跑道框
  if (dist > 13000) return;

  // ---- 跑道轮廓（四角投影）----
  const corner = (along, lat) => project(
    ap.x + ap.hx * along + ap.rx * lat,
    ap.elev + 0.8,
    ap.z + ap.hz * along + ap.rz * lat
  );
  const A = corner(-ap.len / 2, -ap.wid / 2), B = corner(ap.len / 2, -ap.wid / 2);
  const C = corner(ap.len / 2, ap.wid / 2), D = corner(-ap.len / 2, ap.wid / 2);
  if (A && B && C && D) {
    c.strokeStyle = 'rgba(150,235,255,0.55)';
    c.lineWidth = 1.3;
    c.setLineDash([7, 6]);
    c.beginPath();
    c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.lineTo(C.x, C.y); c.lineTo(D.x, D.y); c.closePath();
    c.stroke();
    c.setLineDash([]);
    // 进近端的门槛加粗
    const thr = fromFar ? [B, C] : [A, D];
    c.strokeStyle = 'rgba(150,255,190,0.85)';
    c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(thr[0].x, thr[0].y); c.lineTo(thr[1].x, thr[1].y); c.stroke();
  }

  // ---- 进近引导（只在本场附近且空中显示）----
  if (st.onGround || dist > 9000) return;

  const thrAlong = fromFar ? ap.len / 2 : -ap.len / 2;
  const distToThr = Math.abs(loc.along - thrAlong);
  // 只在“正在朝跑道飞”的进近航段显示引导，避免刚起飞爬升时满屏都是下滑道提示
  const thrX = ap.x + ap.hx * thrAlong, thrZ = ap.z + ap.hz * thrAlong;
  const tvx = thrX - st.pos.x, tvz = thrZ - st.pos.z;
  const tl = Math.hypot(tvx, tvz) || 1;
  const closing = (tvx * st.vel.x + tvz * st.vel.z) / tl;    // 朝跑道的接近率（m/s）
  if (closing < 12) return;                                  // 不是在进近（如刚起飞离场）就不显示

  const desiredAlt = ap.elev + Math.max(0, distToThr) * Math.tan(3 * Math.PI / 180) + 18;
  const altErr = st.pos.y - desiredAlt;           // + 高于下滑道
  const lateral = fromFar ? -loc.lat : loc.lat;   // + 偏右（相对进近方向）

  // 引导框放在屏幕中下方，不挡视线；座舱视角下要抬到仪表台上方
  const gx = cx, gy = hudH - (game.view === 'cockpit' ? 300 : 118);
  const halfW = 128, halfH = 28;
  c.strokeStyle = 'rgba(160,225,255,0.55)'; c.lineWidth = 1.2;
  // 航向道（横）
  c.beginPath();
  c.moveTo(gx - halfW, gy); c.lineTo(gx - 22, gy);
  c.moveTo(gx + 22, gy); c.lineTo(gx + halfW, gy);
  // 下滑道（竖）
  c.moveTo(gx, gy - halfH); c.lineTo(gx, gy - 12);
  c.moveTo(gx, gy + 12); c.lineTo(gx, gy + halfH);
  c.stroke();
  // 中心刻度
  for (const s of [-1, 1]) {
    c.beginPath(); c.moveTo(gx + s * 30, gy - 5); c.lineTo(gx + s * 30, gy + 5); c.stroke();
    c.beginPath(); c.moveTo(gx - 5, gy + s * 16); c.lineTo(gx + 5, gy + s * 16); c.stroke();
  }
  // 偏差点：横向 ±80m 满偏，纵向 ±70m 满偏
  const latPx = clamp(lateral / 80, -1, 1) * halfW;
  const altPx = clamp(altErr / 70, -1, 1) * halfH;
  const onLoc = Math.abs(lateral) < 14, onGs = Math.abs(altErr) < 12;
  c.fillStyle = (onLoc && onGs) ? 'rgba(140,255,180,0.95)' : 'rgba(255,210,100,0.95)';
  c.beginPath(); c.arc(gx + latPx, gy, 4.2, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(gx, gy + altPx, 4.2, 0, Math.PI * 2); c.fill();

  let rwyDeg = (Math.atan2(hx, -hz) * 180 / Math.PI + 360) % 360;
  let rwyNum = Math.round(rwyDeg / 10);
  if (rwyNum === 0) rwyNum = 36;
  hudText('跑道 ' + String(rwyNum).padStart(2, '0') + ' · ' + fmtDist(distToThr),
    gx, gy - halfH - 9, { size: 10.5, align: 'center', color: 'rgba(200,235,255,0.85)', blur: 5 });

  // 提示文字放到引导框左侧（原来压在准星上，太碍事）
  let msg = '', msgCol = '#ffd166';
  if (!st.gear && closing > 15 && distToThr < 6000) { msg = '起落架未放 — 按 G'; msgCol = '#ff8f6b'; }
  else if (onLoc && onGs && st.speed < 150) { msg = '下滑道稳定'; msgCol = '#8ef08e'; }
  else {
    const msgs = [];
    if (!onGs) msgs.push(altErr > 0 ? '下滑偏高' : '下滑偏低');
    if (!onLoc) msgs.push(lateral > 0 ? '偏右' : '偏左');
    msg = msgs.join(' · ');
  }
  if (msg) hudText(msg, gx - halfW - 10, gy + 4, { size: 11, align: 'right', color: msgCol, blur: 5 });
}

// =============================================================================
// === HUD 配色与基础绘制（军用绿色单色系，细线 + 暗描边，保证任何背景可读）=====
// =============================================================================
// =============================================================================
// === HUD：轻量化（细线 + 无底框 + 边缘布局，中间留干净视野）===================
// =============================================================================
const HUD = {
  // 绿色底（草地/跑道）上淡字会整片糊掉，二三级刻度的透明度比早先提高了一档
  g:      'rgba(198,255,226,0.94)',
  gMid:   'rgba(190,250,218,0.74)',
  gDim:   'rgba(178,238,206,0.58)',
  gFaint: 'rgba(168,228,198,0.26)',
  ink:    'rgba(246,254,255,0.96)',
  w:      'rgba(255,198,96,0.96)',
  d:      'rgba(255,92,76,0.97)',
  mono:   '"Consolas","SF Mono","Roboto Mono","Courier New",monospace',
  ui:     '"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  S: 1,          // 全局缩放（按窗口尺寸自适应）
  op: 1,         // 整体透明度（0 = 完全隐藏）
  detail: 2      // 2 = 完整，1 = 简洁
};

// HUD 缩放：小窗口自动缩小，避免读数糊住视野
function hudZoom() {
  // 玩家自己微调（[ ] 键），存本地：默认 115%（原 100% 实测偏小），范围 85%~150%
  if (game._hudZoom === undefined) {
    const v = parseFloat(localStorage.getItem('sky.hudZoom') || '1.15');
    game._hudZoom = isFinite(v) ? clamp(v, 0.85, 1.5) : 1.15;
  }
  return game._hudZoom;
}
function hudScale() {
  // 1.42 是整体放大系数（1.22 实测仍偏小，读数要凑近看）。
  // 采用开方折中，避免 4K 上无限放大、小窗又被压得太小。
  const base = Math.min(hudW / 1600, hudH / 900);
  return clamp(Math.sqrt(Math.max(0.35, base)) * 1.42 * hudZoom(), 0.86, 2.15);
}
// DOM 那层（比分条/击杀播报/帮助）跟着同一套系数缩放
function applyUiScale() {
  const k = hudScale();
  document.documentElement.style.setProperty('--uiK', k.toFixed(3));
}

// 等宽数字（仪表读数必须等宽，否则跳动时抖字）
function hudMono(txt, x, y, size, color, align, weight) {
  const c = hudCtx;
  c.font = (weight || 600) + ' ' + size.toFixed(1) + 'px ' + HUD.mono;
  c.textAlign = align || 'left';
  c.textBaseline = 'alphabetic';
  c.shadowColor = 'rgba(0,0,0,0.95)';
  c.shadowBlur = Math.max(4, size * 0.45);
  c.shadowOffsetY = 0.6;
  c.fillStyle = color || HUD.g;
  c.fillText(txt, x, y);
  c.shadowBlur = 0;
  c.shadowOffsetY = 0;
}

// 细线（带一点暗描边，天空/地面背景下都读得清）
function hudStroke(path, color, w, dash) {
  const c = hudCtx;
  c.beginPath();          // 必须重置路径：arc 开头时否则会从上一个路径末端连一条直线过来
  c.strokeStyle = color;
  c.lineWidth = w || 1;
  c.shadowColor = 'rgba(0,0,0,0.8)';
  c.shadowBlur = 2.5;
  if (dash) c.setLineDash(dash);
  path(c);
  c.stroke();
  c.setLineDash([]);
  c.shadowBlur = 0;
}

// 带左右开口括号的读数（HUD 经典样式，不画底框）
// 返回 {left,right,top,bottom} 方便调用方贴标签
function hudValue(txt, x, y, size, color, align) {
  const c = hudCtx;
  c.font = '700 ' + size.toFixed(1) + 'px ' + HUD.mono;
  const tw = c.measureText(txt).width;
  const pad = Math.round(size * 0.36);
  const h = Math.round(size + 5);
  let tx = x;
  if (align === 'right') tx = x - tw;
  else if (align === 'center') tx = x - tw / 2;
  const bx = tx - pad, by = y - size - 1;
  const rx = tx + tw + pad;
  c.strokeStyle = color;
  c.lineWidth = 1.2;
  c.shadowColor = 'rgba(0,0,0,0.9)';
  c.shadowBlur = 3;
  const tick = Math.min(5, pad);
  c.beginPath();
  c.moveTo(bx + tick, by); c.lineTo(bx, by); c.lineTo(bx, by + h); c.lineTo(bx + tick, by + h);
  c.moveTo(rx - tick, by); c.lineTo(rx, by); c.lineTo(rx, by + h); c.lineTo(rx - tick, by + h);
  c.stroke();
  c.shadowBlur = 0;
  c.fillStyle = color;
  c.textAlign = 'left';
  c.shadowColor = 'rgba(0,0,0,0.92)';
  c.shadowBlur = 4;
  c.fillText(txt, tx, y);
  c.shadowBlur = 0;
  return { left: bx, right: rx, top: by, bottom: by + h };
}

function hudWidth(txt, size, weight) {
  hudCtx.font = (weight || 600) + ' ' + size.toFixed(1) + 'px ' + HUD.mono;
  return hudCtx.measureText(txt).width;
}

// ---------------------------------------------------------------------------
// 空速带（贴左边缘）：滚动刻度 + 读数 + 马赫/迎角/G
// ---------------------------------------------------------------------------
function drawSpeedTape(st, cx, cy) {
  const K = HUD.S;
  const kmh = st.speed * 3.6;
  const x = 26 * K + 54 * K;                  // 距左边缘约 80px（1600 宽时）
  const half = 82 * K;
  const pxPer = 0.60 * K;
  const span = half / pxPer;

  hudStroke((k) => { k.moveTo(x, cy - half); k.lineTo(x, cy + half); }, HUD.gFaint, 1);
  for (let v = Math.floor((kmh - span) / 20) * 20; v <= kmh + span; v += 20) {
    if (v < 0) continue;
    const y = cy - (v - kmh) * pxPer;
    if (Math.abs(y - cy) > half) continue;
    const major = v % 100 === 0;
    const len = major ? 9 * K : 4.5 * K;
    hudStroke((k) => { k.moveTo(x - len, y); k.lineTo(x, y); }, major ? HUD.gMid : HUD.gFaint, 1);
    if (major) hudMono(String(v), x - len - 3 * K, y + 3 * K, 8.5 * K, HUD.gDim, 'right', 500);
  }

  const box = hudValue(String(Math.round(kmh)), x + 7 * K, cy + 6 * K, 17 * K, HUD.ink, 'left');
  hudMono('KM/H', box.right + 4 * K, cy + 6 * K, 7.5 * K, HUD.gDim, 'left', 500);

  // 马赫 / 迎角
  const mach = st.speed / soundSpeed(st.pos.y);
  hudMono('M ' + mach.toFixed(2), box.left, cy + 22 * K, 9 * K,
    mach > 1 ? 'rgba(186,238,255,0.9)' : HUD.gMid, 'left', 500);
  hudMono('α' + (st.aoa * 180 / Math.PI).toFixed(1) + '°', box.left, cy + 33 * K, 8 * K, HUD.gDim, 'left', 500);

  // G 值（拉高时警报色）
  const gCol = st.gLoad > 7 ? HUD.d : (st.gLoad > 5 ? HUD.w : HUD.gMid);
  hudMono('G ' + st.gLoad.toFixed(1), box.left, cy - 14 * K, 9.5 * K, gCol, 'left', 600);
  if (st.stalled) hudMono('STALL', box.left, cy - 25 * K, 9 * K, HUD.d, 'left', 700);
}

// ---------------------------------------------------------------------------
// 高度带（贴右边缘）
// ---------------------------------------------------------------------------
function drawAltTape(st, cx, cy) {
  const K = HUD.S;
  const alt = st.pos.y;
  const x = hudW - 26 * K - 54 * K;
  const half = 82 * K;
  const pxPer = 0.098 * K;                    // ±840m 视野
  const span = half / pxPer;

  hudStroke((k) => { k.moveTo(x, cy - half); k.lineTo(x, cy + half); }, HUD.gFaint, 1);
  for (let v = Math.floor((alt - span) / 100) * 100; v <= alt + span; v += 100) {
    const y = cy - (v - alt) * pxPer;
    if (Math.abs(y - cy) > half) continue;
    const major = v % 500 === 0;
    const len = major ? 9 * K : 4.5 * K;
    hudStroke((k) => { k.moveTo(x, y); k.lineTo(x + len, y); }, major ? HUD.gMid : HUD.gFaint, 1);
    if (major) hudMono(String(v), x + len + 3 * K, y + 3 * K, 8.5 * K, HUD.gDim, 'left', 500);
  }

  const box = hudValue(String(Math.round(alt)), x - 7 * K, cy + 6 * K, 17 * K, HUD.ink, 'right');
  hudMono('ALT m', box.left - 4 * K, cy + 6 * K, 7.5 * K, HUD.gDim, 'right', 500);

  // 无线电高度（贴地时才亮）
  const agl = Math.max(0, alt - Math.max(0, FP.terrainHeight(st.pos.x, st.pos.z)));
  if (agl < 900) {
    const raCol = agl < 150 ? HUD.d : (agl < 400 ? HUD.w : HUD.gDim);
    hudMono('RA ' + Math.round(agl) + 'm', box.right, cy + 22 * K, 9 * K, raCol, 'right', 500);
  }
  // 升降速度
  const vs = st.vel.y;
  hudMono((vs >= 0 ? '↑' : '↓') + Math.abs(vs).toFixed(1), box.right, cy + (agl < 900 ? 33 : 22) * K,
    8 * K, vs < -6 && agl < 600 ? HUD.w : HUD.gDim, 'right', 500);
}

// ---------------------------------------------------------------------------
// 航向带（顶部中央，薄）：滚动罗盘 + 本场方位
// ---------------------------------------------------------------------------
function drawHeadingTape(st, ypr, cx) {
  const K = HUD.S;
  const y = 74 * K, half = 112 * K, degPx = 2.0 * K;
  // 世界系里机头方向是 (-sin yaw, -cos yaw)，罗盘按“北 = -Z、东 = +X”读数，
  // 所以航向角要取 yaw 的相反数（早先直接用 yaw，导致东西读反）
  const hdg = (((-ypr.yaw * 180 / Math.PI) % 360) + 360) % 360;

  hudStroke((k) => { k.moveTo(cx - half, y); k.lineTo(cx + half, y); }, HUD.gFaint, 1);
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = Math.floor((hdg - half / degPx) / 5) * 5; d <= hdg + half / degPx; d += 5) {
    const dd = ((d % 360) + 360) % 360;
    const x = cx + (d - hdg) * degPx;
    if (Math.abs(x - cx) > half) continue;
    const major = dd % 30 === 0;
    hudStroke((k) => { k.moveTo(x, y); k.lineTo(x, y - (major ? 6 * K : 3 * K)); },
      major ? HUD.gMid : HUD.gFaint, 1);
    if (major) {
      const lbl = names[dd] || String(dd / 10).padStart(2, '0');
      hudMono(lbl, x, y - 9 * K, (dd % 90 === 0 ? 9.5 : 8.5) * K,
        dd % 90 === 0 ? HUD.g : HUD.gDim, 'center', 600);
    }
  }
  // 当前航向指针 + 读数
  hudStroke((k) => { k.moveTo(cx - 4 * K, y + 8 * K); k.lineTo(cx, y + 2 * K); k.lineTo(cx + 4 * K, y + 8 * K); },
    HUD.g, 1.3);
  hudMono(String(Math.round(hdg)).padStart(3, '0'), cx, y + 20 * K, 9.5 * K, HUD.gMid, 'center', 600);

  // ---- 本场方位：航向带上的青色菱形，转头对正就能回场 ----
  if (st && st.pos) {
    const ap = FP.teamAirport(game.myTeam);
    const bdx = ap.x - st.pos.x, bdz = ap.z - st.pos.z;
    if (Math.hypot(bdx, bdz) > 300) {
      const bdeg = ((Math.atan2(bdx, -bdz) * 180 / Math.PI) % 360 + 360) % 360;
      let rel = bdeg - hdg;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      const bx = cx + clamp(rel, -half / degPx, half / degPx) * degPx;
      const bcol = 'rgba(120,220,255,0.95)';
      hudStroke((k) => { k.moveTo(bx, y - 4 * K); k.lineTo(bx, y - 13 * K); }, bcol, 1);
      hudMono('本场', bx, y - 15 * K, 7.5 * K, bcol, 'center', 700);
      hudStroke((k) => {
        k.moveTo(bx, y - 3.6 * K); k.lineTo(bx + 3.6 * K, y);
        k.lineTo(bx, y + 3.6 * K); k.lineTo(bx - 3.6 * K, y); k.closePath();
      }, bcol, 1.3);
    }
  }

  // 滚转/水平仪：一条 36px 的基线 + 随滚转滑动的小指针（替代原来绕准星一整圈刻度）
  const by = y + 30 * K;
  hudStroke((k) => {
    k.moveTo(cx - 18 * K, by); k.lineTo(cx - 5 * K, by);
    k.moveTo(cx + 5 * K, by); k.lineTo(cx + 18 * K, by);
  }, HUD.gFaint, 1);
  hudStroke((k) => { k.moveTo(cx, by - 3 * K); k.lineTo(cx, by + 3 * K); }, HUD.gMid, 1.2);
  const rollDeg = ypr.roll * 180 / Math.PI;
  const px = cx + clamp(rollDeg / 50, -1, 1) * 16 * K;
  const level = Math.abs(rollDeg) < 6;
  hudStroke((k) => {
    k.moveTo(px, by - 6 * K); k.lineTo(px + 3.4 * K, by - 1 * K); k.lineTo(px - 3.4 * K, by - 1 * K); k.closePath();
  }, level ? HUD.g : HUD.w, 1.2);

  // 本场方位（细三角 + 距离，不写字）
  const ap = FP.teamAirport(game.myTeam);
  const brg = (Math.atan2(ap.x - st.pos.x, -(ap.z - st.pos.z)) * 180 / Math.PI + 360) % 360;
  let delta = brg - hdg;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  if (Math.abs(delta) < half / degPx) {
    const bx = cx + delta * degPx;
    hudStroke((k) => { k.moveTo(bx, y + 2 * K); k.lineTo(bx, y + 7 * K); k.lineTo(bx + 4.5 * K, y + 4.5 * K); k.closePath(); },
      HUD.w, 1.1);
  }
}

// ---------------------------------------------------------------------------
// 姿态：地平线 + 短俯仰梯 + 小滚转刻度
// ---------------------------------------------------------------------------
function drawAttitude(st, ypr, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  const pxPerDeg = CONFIG.hud.pitchPxPerDeg * K;
  c.save();
  c.translate(cx, cy);
  c.rotate(-ypr.roll);
  const pitchPx = ypr.pitch * (180 / Math.PI) * pxPerDeg;

  // 地平线（中间留大缺口，别挡目标）
  hudStroke((k) => {
    k.moveTo(-168 * K, pitchPx); k.lineTo(-46 * K, pitchPx);
    k.moveTo(46 * K, pitchPx); k.lineTo(168 * K, pitchPx);
  }, HUD.gMid, 1.3);

  // 追尾视角只留地平线：梯度线画在自机身上会变成“糊在飞机上的白十字”
  const fullLadder = game.view === 'cockpit';
  if (fullLadder) for (let d = -20; d <= 20; d += 5) {
    if (d === 0) continue;
    const y = pitchPx - d * pxPerDeg;
    if (Math.abs(y) > 120 * K) continue;
    const major = d % 10 === 0;
    const w = (major ? 28 : 15) * K;
    if (d < 0) {
      hudStroke((k) => { for (let sx = -w; sx < w; sx += 7 * K) { k.moveTo(sx, y); k.lineTo(sx + 3.5 * K, y); } },
        HUD.gFaint, 1);
    } else {
      hudStroke((k) => { k.moveTo(-w, y); k.lineTo(w, y); }, HUD.gFaint, 1);
    }
    if (major) {
      const hook = d > 0 ? 3 * K : -3 * K;
      hudStroke((k) => {
        k.moveTo(-w, y); k.lineTo(-w, y + hook);
        k.moveTo(w, y); k.lineTo(w, y + hook);
      }, HUD.gMid, 1);
      hudMono(String(Math.abs(d)), -w - 3 * K, y + 2.5 * K, 7.5 * K, HUD.gDim, 'right', 500);
      hudMono(String(Math.abs(d)), w + 3 * K, y + 2.5 * K, 7.5 * K, HUD.gDim, 'left', 500);
    }
  }
  c.restore();

}

// ---------------------------------------------------------------------------
// 准星 + 速度矢量（FPM）
// ---------------------------------------------------------------------------
const _retFwd = new THREE.Vector3();
const _retVel = new THREE.Vector3();

function drawReticle(st, cx, cy) {
  const K = HUD.S;
  const fixed = game.view === 'cockpit';
  let gx = cx, gy = cy;
  if (!fixed) {
    const fwd = _retFwd.set(0, 0, -1).applyQuaternion(game.renderQuat);
    const rp = game.renderPose;
    const p = project(rp.x + fwd.x * 1200, rp.y + fwd.y * 1200, rp.z + fwd.z * 1200);
    if (p) { gx = p.x; gy = p.y; }
  }
  // 机炮准星：四段短线 + 中心点
  hudStroke((k) => {
    k.moveTo(gx - 12 * K, gy); k.lineTo(gx - 5 * K, gy);
    k.moveTo(gx + 5 * K, gy); k.lineTo(gx + 12 * K, gy);
    k.moveTo(gx, gy - 12 * K); k.lineTo(gx, gy - 5 * K);
    k.moveTo(gx, gy + 5 * K); k.lineTo(gx, gy + 12 * K);
  }, HUD.g, 1.25);
  hudStroke((k) => { k.arc(gx, gy, 1.6 * K, 0, Math.PI * 2); }, HUD.g, 1.2);

  // 速度矢量（FPM）
  if (st.speed > 25) {
    const vd = _retVel.set(st.vel.x, st.vel.y, st.vel.z).normalize();
    const fp = project(st.pos.x + vd.x * 900, st.pos.y + vd.y * 900, st.pos.z + vd.z * 900);
    if (fp && fp.x > 0 && fp.x < hudW && fp.y > 0 && fp.y < hudH) {
      hudStroke((k) => {
        k.arc(fp.x, fp.y, 5 * K, 0, Math.PI * 2);
        k.moveTo(fp.x - 5 * K, fp.y); k.lineTo(fp.x - 12 * K, fp.y);
        k.moveTo(fp.x + 5 * K, fp.y); k.lineTo(fp.x + 12 * K, fp.y);
        k.moveTo(fp.x, fp.y - 5 * K); k.lineTo(fp.x, fp.y - 9 * K);
      }, 'rgba(190,255,215,0.78)', 1.2);
    }
  }
}

// ---------------------------------------------------------------------------
// 目标：锁定框 + 提前量 + 极简数据（无底框）+ 敌机菱形
// ---------------------------------------------------------------------------
function drawTargets(st, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  // 锁不上也要画框：地形遮挡 / 贴地杂波时用“候选目标”（mc）继续提示，
  // 否则玩家按了发射键却完全没有反馈，不知道是被山挡住还是敌人贴地了。
  const ltid = st.lockTargetId || st.lockCandId || 0;
  const tv = ltid && game.views.get(ltid);
  const mr = st.lockReason | 0;      // 0 无 / 1 地形遮挡 / 2 目标贴地杂波

  // ---- 机炮提前量 ----
  if (tv && tv.e.al) {
    const d = Math.hypot(tv.pos.x - st.pos.x, tv.pos.y - st.pos.y, tv.pos.z - st.pos.z);
    if (d < 1900) {
      const tof = d / SIM.weapons.gun.speed;
      const fp = project(tv.pos.x + (tv.e.v ? tv.e.v[0] : 0) * tof,
        tv.pos.y + (tv.e.v ? tv.e.v[1] : 0) * tof,
        tv.pos.z + (tv.e.v ? tv.e.v[2] : 0) * tof);
      const cp = project(tv.pos.x, tv.pos.y, tv.pos.z);
      if (fp && cp) {
        hudStroke((k) => { k.moveTo(cp.x, cp.y); k.lineTo(fp.x, fp.y); }, 'rgba(255,198,96,0.4)', 1, [3, 4]);
        hudStroke((k) => { k.arc(fp.x, fp.y, 4.5 * K, 0, Math.PI * 2); }, 'rgba(255,198,96,0.9)', 1.3);
      }
    }
  }

  // ---- 锁定框 ----
  if (tv) {
    const p = project(tv.pos.x, tv.pos.y, tv.pos.z);
    if (p) {
      const locked = st.lockProgress >= 1 && st.lockTargetId === ltid;
      const masked = !locked && mr > 0;
      const sz = (44 - 20 * st.lockProgress) * K;
      const col = locked ? HUD.d : (masked ? 'rgba(255,178,96,0.92)' : HUD.w);
      const s = sz / 2, arm = 9 * K;
      hudStroke((k) => {
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          k.moveTo(p.x + dx * s, p.y + dy * (s - arm));
          k.lineTo(p.x + dx * s, p.y + dy * s);
          k.lineTo(p.x + dx * (s - arm), p.y + dy * s);
        }
      }, col, 1.4);
      if (!locked) {
        hudStroke((k) => { k.arc(p.x, p.y, sz / 2 + 8 * K + (1 - st.lockProgress) * 20 * K, 0, Math.PI * 2); },
          'rgba(255,198,96,0.28)', 1, [3, 5]);
      }

      // 极简数据块：右侧三行，无背景；贴边时翻到左侧
      const dx = tv.pos.x - st.pos.x, dy2 = tv.pos.y - st.pos.y, dz = tv.pos.z - st.pos.z;
      const d = Math.hypot(dx, dy2, dz) || 1;
      const losx = dx / d, losy = dy2 / d, losz = dz / d;
      const tvx = tv.e.v ? tv.e.v[0] : 0, tvy = tv.e.v ? tv.e.v[1] : 0, tvz = tv.e.v ? tv.e.v[2] : 0;
      const closure = ((st.vel.x - tvx) * losx + (st.vel.y - tvy) * losy + (st.vel.z - tvz) * losz);
      const tf = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(tv.e.q[0], tv.e.q[1], tv.e.q[2], tv.e.q[3]));
      const aspect = Math.acos(clamp(-(tf.x * losx + tf.y * losy + tf.z * losz), -1, 1)) * 180 / Math.PI;

      const bw = 82 * K;
      const right = p.x + sz / 2 + 12 * K + bw < hudW - 24 * K;
      const tx = right ? p.x + sz / 2 + 12 * K : p.x - sz / 2 - 12 * K;
      const al = right ? 'left' : 'right';
      // 竖直夹紧：目标贴屏幕下缘时数据块不能糊到仪表盘/武器条上
      const tyMax = hudH - (game.view === 'cockpit' ? 300 : 120) * K;
      const ty0 = clamp(p.y - 16 * K, 76 * K, tyMax);
      // 引线
      hudStroke((k) => {
        k.moveTo(p.x + (right ? sz / 2 : -sz / 2), p.y - sz / 2);
        k.lineTo(tx + (right ? -4 * K : 4 * K), ty0 - 9 * K);
      }, 'rgba(255,198,96,0.35)', 1);
      hudMono(locked ? 'LOCK'
        : (mr === 1 ? 'NO LOS' : (mr === 2 ? 'CLUTTER' : 'TRK ' + Math.round(st.lockProgress * 100) + '%')),
        tx, ty0, 9 * K, col, al, 700);
      hudMono(fmtDist(d), tx, ty0 + 12 * K, 9.5 * K, HUD.ink, al, 600);
      hudMono('Vc ' + (closure >= 0 ? '+' : '') + Math.round(closure), tx, ty0 + 23 * K, 8.5 * K, HUD.gMid, al, 500);
      hudMono('AA ' + String(Math.round(aspect)).padStart(3, '0') + '  ' + Math.round(tv.pos.y) + 'm',
        tx, ty0 + 34 * K, 8.5 * K, HUD.gDim, al, 500);
      // 注意：配置里没有 missile.range，以前这里取到 undefined，判断恒为 false，
      // 于是永远显示 OUT。正确字段是 lockRange。
      const maxR = SIM.weapons.missile.lockRange;
      const inRange = d < maxR && locked;
      const rTxt = inRange ? 'IN RNG'
        : (mr === 1 ? 'TERRAIN' : (mr === 2 ? 'CLUTTER' : (d < maxR ? 'WAIT' : 'OUT')));
      hudMono(rTxt, tx, ty0 - 12 * K, 8 * K,
        inRange ? HUD.g : (mr ? 'rgba(255,178,96,0.95)' : HUD.gDim), al, 600);
    }
  }

  // ---- 敌机菱形（只标位置，不抢视线）----
  for (const [id, v] of game.views) {
    if (v.e.tm === game.myTeam || !v.e.al) continue;
    if (tv && game.views.get(ltid) === v) continue;   // 锁定的用大框
    const p = project(v.pos.x, v.pos.y, v.pos.z);
    if (!p) continue;
    const d = Math.hypot(v.pos.x - st.pos.x, v.pos.y - st.pos.y, v.pos.z - st.pos.z);
    if (d > 9000) continue;
    const s = clamp(280 / Math.max(300, d), 2.2, 6.5) * K;
    hudStroke((k) => {
      k.moveTo(p.x, p.y - s); k.lineTo(p.x + s * 0.7, p.y);
      k.lineTo(p.x, p.y + s); k.lineTo(p.x - s * 0.7, p.y);
      k.closePath();
    }, 'rgba(255,120,100,0.6)', 1);
    if (d < 4000) hudMono(fmtDist(d), p.x + s + 3 * K, p.y + 2.5 * K, 7.5 * K, 'rgba(255,160,140,0.7)', 'left', 500);
  }
}

// ---------------------------------------------------------------------------
// 雷达：右下角小圆（无底框）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 全向敌情：队友发现的敌机（数据链共享）在主视野里的标记 + 屏幕外方位箭头
// ---------------------------------------------------------------------------
// 之前只有「锁定目标」会被画出来，其余队友发现的敌机虽然数据已经到了
// （服务端 sp 掩码下发、views 里也有），HUD 上却完全看不到 —— 玩家体感就是
// 「队友发现了敌机但没告诉我位置」。这里补齐：
//   · 视锥内：画菱形框 + 距离 + 高度差
//   · 视锥外：屏幕边缘画箭头指向目标方位，箭头贴边且带距离
const ENEMY_COL = 'rgba(255,120,96,0.95)';
const _awDir = new THREE.Vector3();
const _awInv = new THREE.Quaternion();
function drawEnemyAwareness(st, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  if (!st || !st.alive) return;
  const own = st;
  const margin = 26 * K;
  const topSafe = 88 * K, botSafe = hudH - 86 * K;
  const list = [];

  for (const [id, v] of game.views) {
    if (!v.e.al || v.e.tm === game.myTeam || id === game.myId) continue;
    const dx = v.pos.x - own.pos.x, dy = v.pos.y - own.pos.y, dz = v.pos.z - own.pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 16000) continue;                  // 数据链最远提示距离
    list.push({ id, v, d, dy, dx, dz, p: project(v.pos.x, v.pos.y, v.pos.z) });
  }
  list.sort((a, b) => a.d - b.d);

  const lockedId = st.lockTargetId || st.lockCandId || 0;
  for (const it of list) {
    const isLocked = it.id === lockedId;
    const dist = it.d < 1000 ? Math.round(it.d) + 'm' : (it.d / 1000).toFixed(1) + 'km';
    const dyTxt = (it.dy >= 0 ? '+' : '') + Math.round(it.dy / 10) * 10;
    // 已被锁定目标由 drawTargets 画更详细的信息，这里只补一个小三角避免重复
    if (isLocked) continue;

    if (it.p) {
      // ---- 视锥内：菱形 + 距离 ----
      const s = 7 * K;
      hudStroke((k) => {
        k.moveTo(it.p.x, it.p.y - s); k.lineTo(it.p.x + s, it.p.y);
        k.lineTo(it.p.x, it.p.y + s); k.lineTo(it.p.x - s, it.p.y);
        k.closePath();
      }, ENEMY_COL, 1.4);
      hudMono(dist, it.p.x, it.p.y + s + 9 * K, 6.4 * K, 'rgba(255,168,148,0.92)', 'center', 600);
      hudMono(dyTxt, it.p.x, it.p.y + s + 18 * K, 5.8 * K, 'rgba(255,168,148,0.62)', 'center', 500);
    } else {
      // ---- 视锥外：屏幕边缘方位箭头 ----
      // 把世界方向转进机体坐标系，再投影到屏幕平面。
      _awDir.set(it.dx, it.dy, it.dz).applyQuaternion(_awInv.copy(own.quat).invert());
      const bx = _awDir.x, by = _awDir.y, bz = _awDir.z;
      // 屏幕方向：前向 -Z，右 +X，上 +Y
      const ang = Math.atan2(bx, -bz);        // 水平方位（右为正）
      const elev = Math.atan2(by, Math.hypot(bx, bz));
      const rad = Math.min(hudW, hudH) * 0.42;
      // 把方位压到矩形边缘（椭圆投影近似，够用且不抖）
      const ex = Math.cos(ang), ey = -Math.sin(elev) * 1.35;
      const len = Math.max(Math.abs(ex), Math.abs(ey)) || 1;
      let ax = cx + (ex / len) * rad * 1.02;
      let ay = cy + (ey / len) * rad * 0.72;
      ax = clamp(ax, margin, hudW - margin);
      ay = clamp(ay, topSafe, botSafe);

      // 箭头指向目标（沿从屏幕中心到边缘的方向）
      const dirx = ax - cx, diry = ay - cy;
      const dl = Math.hypot(dirx, diry) || 1;
      const ux = dirx / dl, uy = diry / dl;
      const px2 = -uy, py2 = ux;              // 垂直方向
      const a1 = 11 * K;
      hudStroke((k) => {
        k.moveTo(ax + ux * a1, ay + uy * a1);
        k.lineTo(ax - ux * a1 * 0.55 + px2 * a1 * 0.85, ay - uy * a1 * 0.55 + py2 * a1 * 0.85);
        k.lineTo(ax - ux * a1 * 0.55 - px2 * a1 * 0.85, ay - uy * a1 * 0.55 - py2 * a1 * 0.85);
        k.closePath();
      }, ENEMY_COL, 1.3);
      hudMono(dist, ax - ux * 15 * K, ay - uy * 15 * K, 6.2 * K, 'rgba(255,168,148,0.9)',
        Math.abs(ux) > 0.5 ? 'center' : (ux > 0 ? 'left' : 'right'), 600);
    }
  }
}

// 友军识别（IFF）：友机常显菱形标记 + 机号 + 距离，和敌机（锁定框）区分开
// ---------------------------------------------------------------------------
const FRIEND_COL = 'rgba(160,230,255,0.95)';
function drawFriendlies(cx, cy) {
  const K = HUD.S;
  const own = game.own && game.own.state;
  if (!own) return;
  const c = hudCtx;
  // 先收集，按距离排序：近的优先占位，远的避让（否则两架友机重叠时字会糊成一团）
  const list = [];
  for (const [id, v] of game.views) {
    if (id === game.myId || !v.e.al || v.e.tm !== game.myTeam) continue;
    const d = Math.hypot(v.pos.x - own.pos.x, v.pos.y - own.pos.y, v.pos.z - own.pos.z);
    if (d > 14000) continue;
    const p = project(v.pos.x, v.pos.y, v.pos.z);
    if (!p) continue;
    if (p.x < 10 * K || p.x > hudW - 10 * K || p.y < 10 * K || p.y > hudH - 10 * K) continue;
    const dist = d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'km';
    list.push({ p, d, n: v.e.n || ('#' + id), dist });
  }
  list.sort((a, b) => a.d - b.d);

  // 单行小字：名字和距离挤一行，比原来两行块省一半高度（原来看起来像两块黑标签，挡视野）
  const sz = 6.9 * K;
  const gap = 5 * K;
  // 让开顶部比分/罗盘带与底部数据块，别把字压到仪表上
  const topSafe = 92 * K, botSafe = hudH - 84 * K;
  // 用真实字形宽度排版（等宽字体下中英文宽度差很多，估长度会错位）
  const textW = (t, s, wt) => {
    c.font = (wt || 600) + ' ' + s.toFixed(1) + 'px ' + HUD.mono;
    return c.measureText(t).width;
  };
  const placed = [];
  for (const it of list) {
    const s = 4.7 * K;
    hudStroke((k) => {
      k.moveTo(it.p.x, it.p.y - s); k.lineTo(it.p.x + s, it.p.y);
      k.lineTo(it.p.x, it.p.y + s); k.lineTo(it.p.x - s, it.p.y); k.closePath();
      k.moveTo(it.p.x - s * 1.9, it.p.y); k.lineTo(it.p.x - s * 1.3, it.p.y);
      k.moveTo(it.p.x + s * 1.3, it.p.y); k.lineTo(it.p.x + s * 1.9, it.p.y);
    }, FRIEND_COL, 1.05);

    const wN = textW(it.n, sz, 600), wD = textW(it.dist, sz, 700);
    const bw = wN + gap + wD, bh = sz + 2.4 * K;
    // 候选位置：先贴着菱形往下，排不下再翻到上方（都不行就只留菱形）
    const fits = (x, base) => base - bh >= topSafe && base <= botSafe
      && !placed.some((q) => Math.abs(q.x - x) < (q.w + bw) * 0.5 + 6 * K
        && Math.abs(q.base - base) < bh + 5 * K);
    let by = -1;
    for (let i = 0; i < 5 && by < 0; i++) {
      const b = Math.max(it.p.y + s + sz * 0.92, topSafe + bh) + i * (bh + 3 * K);
      if (fits(it.p.x, b)) by = b;
    }
    for (let i = 0; i < 5 && by < 0; i++) {
      const b = it.p.y - s - 3.5 * K - i * (bh + 3 * K);
      if (fits(it.p.x, b)) by = b;
    }
    if (by < 0) continue;              // 实在放不下就只留菱形，别糊成一团
    placed.push({ x: it.p.x, base: by, w: bw });

    // 被推远时补一条细引线，指回真正的目标点（上下都给）
    const top = by - bh;
    if (top - (it.p.y + s) > 5 * K) {
      hudStroke((k) => { k.moveTo(it.p.x, it.p.y + s); k.lineTo(it.p.x, top - 1.5 * K); },
        'rgba(160,230,255,0.40)', 0.8);
    } else if (it.p.y - s - by > 5 * K) {
      hudStroke((k) => { k.moveTo(it.p.x, it.p.y - s); k.lineTo(it.p.x, by + 1.5 * K); },
        'rgba(160,230,255,0.40)', 0.8);
    }
    // 纯色无框：字号很小时描边/模糊都会把字糊成一团，靠亮度和字重保证可读
    const x0 = it.p.x - bw * 0.5;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(2,12,20,0.38)';
    c.shadowBlur = 1.5 * K;
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 0;
    c.font = '600 ' + sz.toFixed(1) + 'px ' + HUD.mono;
    c.fillStyle = 'rgba(212,246,255,0.90)';
    c.fillText(it.n, x0, by);
    c.font = '700 ' + sz.toFixed(1) + 'px ' + HUD.mono;
    c.fillStyle = 'rgba(240,252,255,0.99)';
    c.fillText(it.dist, x0 + wN + gap, by);
    c.shadowBlur = 0;
  }
}

// ---------------------------------------------------------------------------
// 航母标记：主视野里的舰位菱形 + 着舰引导（下滑道 / 对准提示）
// 两艘舰都画：本队舰用绿色（主用），敌队舰用暗橙（可用但不推荐）
// ---------------------------------------------------------------------------
const _cvVec = new THREE.Vector3();
const _cvQuatInv = new THREE.Quaternion();
function drawCarrierHud(st, cx, cy) {
  const c = hudCtx;
  const K = HUD.S;
  const list = FP.CARRIERS || [FP.CARRIER];
  let nearest = null;      // 用于着舰引导（最近的一艘）
  let nearestD = 1e9;

  for (let team = 0; team < list.length; team++) {
    const C = list[team];
    const d3 = Math.hypot(C.x - st.pos.x, C.y - st.pos.y, C.z - st.pos.z);
    if (d3 > 26000) continue;
    const own = (team === game.myTeam);
    // 本队舰：绿色；敌队舰：暗橙（能落但不算返场）
    const col = own ? 'rgba(150,255,196,0.95)' : 'rgba(255,178,120,0.85)';
    const tag = own ? 'CVN' : 'CVN-敌';
    const p = project(C.x, C.y + 26, C.z);

    if (d3 < nearestD) { nearestD = d3; nearest = { C, team, own }; }

    // ---- 视锥内：舰位菱形 + 距离 ----
    if (p && p.x > 8 * K && p.x < hudW - 8 * K && p.y > 8 * K && p.y < hudH - 8 * K) {
      const s = 5.6 * K;
      hudStroke((k) => {
        k.moveTo(p.x, p.y - s); k.lineTo(p.x + s, p.y);
        k.lineTo(p.x, p.y + s); k.lineTo(p.x - s, p.y);
        k.closePath();
        // 舰船形状的小标记（横杠 = 甲板）
        k.moveTo(p.x - s * 0.42, p.y); k.lineTo(p.x + s * 0.42, p.y);
      }, col, 1.15);
      hudMono(tag, p.x, p.y + s + 10 * K, 7.2 * K, col, 'center', 700);
      hudMono(fmtDist(d3), p.x, p.y + s + 20 * K, 7.2 * K,
        own ? 'rgba(196,255,222,0.92)' : 'rgba(255,210,170,0.88)', 'center', 600);
    } else {
      // ---- 视锥外：屏幕边缘方位箭头 ----
      _cvVec.set(C.x - st.pos.x, C.y + 26 - st.pos.y, C.z - st.pos.z)
        .applyQuaternion(_cvQuatInv.copy(st.quat).invert());
      const bx = _cvVec.x, by = _cvVec.y, bz = _cvVec.z;
      const ang = Math.atan2(bx, -bz);
      const elev = Math.atan2(by, Math.hypot(bx, bz));
      const ex = Math.min(hudW, hudH) * 0.5 - 30 * K;
      const ey = ex * 0.66;
      const exx = cx + Math.sin(ang) * ex;
      const eyy = cy - elev * ey * 0.9 - Math.cos(ang) * ey * 0.10;
      const cxx = clamp(exx, 26 * K, hudW - 26 * K);
      const cyy = clamp(eyy, 96 * K, hudH - 92 * K);
      const dirA = Math.atan2(cyy - cy, cxx - cx);
      c.save();
      c.translate(cxx, cyy);
      c.rotate(dirA);
      hudStroke((k) => {
        k.moveTo(7 * K, 0); k.lineTo(-4 * K, -5 * K); k.lineTo(-4 * K, 5 * K);
        k.closePath();
      }, col, 1.15);
      c.restore();
      hudMono(tag + ' ' + fmtDist(d3), cxx, cyy + 13 * K, 7 * K, col, 'center', 600);
    }
  }

  // ---- 着舰引导：对最近的一艘，距舰 < 6km 且起落架放下时显示 ----
  if (!nearest || nearestD > 6000 || !st.gear) return;
  const C = nearest.C;
  // 甲板坐标（按该舰的轴线换算，不能再用固定的 z 轴）
  const l = FP.carrierLocal(st.pos.x, st.pos.z, C);
  const rangeToStern = l.along + C.len * 0.5;   // along 为正是舰艉侧
  // 下滑道：从舰尾 3.5° 下滑，理想高度 = 甲板高 + 距舰尾水平距离 * tan(3.5°)
  const idealAlt = C.y + Math.max(0, rangeToStern) * Math.tan(3.5 * Math.PI / 180);
  const altErr = st.pos.y - idealAlt;
  const latErr = l.lat - (-C.wid * 0.14);   // 斜角甲板中线偏左
  const okH = Math.abs(altErr) < 45, okL = Math.abs(latErr) < 22;
  const gy = hudH * 0.5 + 92 * K;
  const guide = (okH && okL) ? 'rgba(150,255,196,0.95)' : 'rgba(255,196,110,0.95)';
  const warn = 'rgba(255,196,110,0.95)';
  hudMono('GLIDE  ' + (altErr >= 0 ? '+' : '') + Math.round(altErr) + 'm',
    cx - 78 * K, gy, 7.6 * K, okH ? guide : warn, 'left', 700);
  hudMono('LINE   ' + (latErr >= 0 ? '+' : '') + Math.round(latErr) + 'm',
    cx + 18 * K, gy, 7.6 * K, okL ? guide : warn, 'left', 700);
  if (okH && okL) {
    hudMono('CALL THE BALL', cx + 128 * K, gy, 7.6 * K, 'rgba(150,255,196,0.98)', 'left', 700);
  } else if (!nearest.own) {
    // 敌队舰：提醒不能算返场
    hudMono('ENEMY DECK', cx + 128 * K, gy, 7.6 * K, 'rgba(255,178,120,0.90)', 'left', 700);
  }
}

function drawRadar(st, ypr) {
  const c = hudCtx;
  const K = HUD.S;
  const r = 50 * K;
  const rx = hudW - 28 * K - r;
  const ry = hudH - 26 * K - r;
  const R = CONFIG.hud.radarRange;

  hudStroke((k) => { k.arc(rx, ry, r, 0, Math.PI * 2); }, HUD.gFaint, 1);
  hudStroke((k) => { k.arc(rx, ry, r * 0.5, 0, Math.PI * 2); }, 'rgba(162,222,192,0.10)', 1);
  hudStroke((k) => {
    k.moveTo(rx - r, ry); k.lineTo(rx + r, ry);
    k.moveTo(rx, ry - r); k.lineTo(rx, ry + r);
  }, 'rgba(162,222,192,0.10)', 1);
  for (let a = 0; a < 360; a += 45) {
    const ar = a * Math.PI / 180;
    hudStroke((k) => {
      k.moveTo(rx + Math.sin(ar) * r, ry - Math.cos(ar) * r);
      k.lineTo(rx + Math.sin(ar) * (r + 4 * K), ry - Math.cos(ar) * (r + 4 * K));
    }, HUD.gFaint, 1);
  }

  // 扫描扇
  const sw = (performance.now() * 0.0016) % (Math.PI * 2);
  const grad = c.createRadialGradient(rx, ry, 0, rx, ry, r);
  grad.addColorStop(0, 'rgba(150,255,196,0.13)');
  grad.addColorStop(1, 'rgba(150,255,196,0)');
  c.save();
  c.beginPath(); c.arc(rx, ry, r, 0, Math.PI * 2); c.clip();
  c.fillStyle = grad;
  c.beginPath(); c.moveTo(rx, ry);
  c.arc(rx, ry, r, sw - 0.55, sw);
  c.closePath(); c.fill();
  c.restore();

  const cosY = Math.cos(ypr.yaw), sinY = Math.sin(ypr.yaw);
  for (const [id, v] of game.views) {
    if (!v.e.al) continue;
    const dx = v.pos.x - st.pos.x, dz = v.pos.z - st.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > R) continue;
    const rx2 = dx * cosY - dz * sinY;
    const rz2 = dx * sinY + dz * cosY;
    const px2 = rx + (rx2 / R) * r, py2 = ry + (rz2 / R) * r;
    const mine = id === game.myId;
    const friendly = v.e.tm === game.myTeam;
    const col = mine ? 'rgba(255,255,255,0.9)' : (friendly ? COL.teamHud0 : COL.teamHud1);
    if (mine) {
      hudStroke((k) => { k.moveTo(px2, py2 - 3.5 * K); k.lineTo(px2 + 2.5 * K, py2 + 3 * K); k.lineTo(px2 - 2.5 * K, py2 + 3 * K); k.closePath(); },
        col, 1);
      continue;
    }
    if (friendly) {
      // 友军：空心方块（与 HUD 里的友军菱形同一套识别语义）
      c.strokeStyle = 'rgba(150,224,255,0.88)';
      c.lineWidth = 1.2;
      c.strokeRect(px2 - 2.3 * K, py2 - 2.3 * K, 4.6 * K, 4.6 * K);
      continue;
    }
    // 敌机（仅本队已发现的目标会出现在 views 里）：实心三角 + 高度差竖线
    c.fillStyle = col;
    c.globalAlpha = 0.95;
    c.beginPath();
    c.moveTo(px2, py2 - 2.8 * K); c.lineTo(px2 + 2.4 * K, py2 + 2.1 * K); c.lineTo(px2 - 2.4 * K, py2 + 2.1 * K);
    c.closePath(); c.fill();
    c.globalAlpha = 1;
    const dh = clamp((v.pos.y - st.pos.y) / 2000, -1, 1);
    if (Math.abs(dh) > 0.05) {
      hudStroke((k) => { k.moveTo(px2, py2); k.lineTo(px2, py2 - dh * 7 * K); }, col, 1);
    }
    if (id === st.lockTargetId) hudStroke((k) => { k.arc(px2, py2, 5 * K, 0, Math.PI * 2); }, HUD.d, 1.2);
  }

  // 航母 ×2：船形轮廓（本队绿 / 敌队橙），朝向按各自甲板轴线
  for (let team = 0; team < (FP.CARRIERS || []).length; team++) {
    const C = FP.CARRIERS[team];
    const dx = C.x - st.pos.x, dz = C.z - st.pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= R) continue;
    const cx2 = dx * cosY - dz * sinY;
    const cz2 = dx * sinY + dz * cosY;
    const px2 = rx + (cx2 / R) * r, py2 = ry + (cz2 / R) * r;
    const hl = 4.6 * K, hw = 1.5 * K;
    // 舰体朝向：甲板轴线 (hx,hz) 在雷达坐标系里的角度。
    // 雷达把世界 (dx,dz) 旋转成 (cx2,cz2)，同样地旋转轴向向量。
    const axx = C.hx * cosY - C.hz * sinY;
    const axz = C.hx * sinY + C.hz * cosY;
    // 舰艏 = -h 方向；画布 y 轴向下（对应世界 +z 侧），所以角度取 atan2(axx, axz)
    const rot = Math.atan2(axx, axz);
    const own = (team === game.myTeam);
    c.save();
    c.translate(px2, py2);
    c.rotate(rot);
    c.strokeStyle = own ? 'rgba(150,255,196,0.92)' : 'rgba(255,178,120,0.85)';
    c.lineWidth = 1.3;
    c.beginPath();
    // 舰艏朝 -local-y（旋转后即 -h 方向）
    c.moveTo(0, -hl);
    c.lineTo(hw, -hl * 0.62);
    c.lineTo(hw, hl * 0.86);
    c.lineTo(-hw, hl * 0.86);
    c.lineTo(-hw, -hl * 0.62);
    c.closePath();
    c.stroke();
    // 甲板中线
    c.beginPath(); c.moveTo(0, -hl * 0.85); c.lineTo(0, hl * 0.8); c.stroke();
    c.restore();
  }

  // 标题 / 摘要（一条线，压在雷达上方）
  const tv = st.lockTargetId && game.views.get(st.lockTargetId);
  const label = tv
    ? 'TGT ' + fmtDist(Math.hypot(tv.pos.x - st.pos.x, tv.pos.y - st.pos.y, tv.pos.z - st.pos.z))
    : ('RDR ' + (R / 1000).toFixed(0) + 'km');
  hudMono(label, rx + r, ry - r - 6 * K, 8 * K, tv ? HUD.d : HUD.gDim, 'right', 600);
  const foes = Array.from(game.views.values()).filter((v) => v.e.al && v.e.tm !== game.myTeam).length;
  if (!tv) hudMono('BANDITS ' + foes, rx + r, ry + r + 11 * K, 8 * K, HUD.gDim, 'right', 500);
}

// === 战舰操控：油门档位 / 舵 / 主炮瞄准 / 鱼雷 / 损管 ==========================
// 键位：W/S 油门档（0~3，S 到底为倒车）、A/D 舵、
//       鼠标控制准星（射线与海面求交 = 主炮瞄准点）、左键齐射、
//       F 鱼雷（朝准星方向）、R 损管、C 切视角
function updateShipControls() {
  const v = shipViews.get(game.myShipId);
  const e = v ? v.e : null;
  const st = {
    throttle: game.shipThr === undefined ? 2 : game.shipThr,
    rudder: 0, fireMain: false,
    targetX: game.shipAim.x, targetZ: game.shipAim.z,
    fireTorp: false, torpDir: 0, dc: false
  };
  if (!e) return st;
  if (keys['KeyA']) st.rudder -= 1;
  if (keys['KeyD']) st.rudder += 1;
  // 鱼雷：一次性意图，由 sendInput 上行成功后清零（不在读取阶段清，
  // 否则被 30Hz 节流吞掉的那一帧会把意图弄丢）
  if (pending.torp > 0) { st.fireTorp = true; st.torpDir = game.torpDir || 0; }
  st.dc = !!keys['KeyR'];
  st.fireMain = !!keys['Space'] || game.mouseDown;
  game.lastRudder = st.rudder;
  return st;
}

// ---------------------------------------------------------------------------
// 系统：左下角三行小字（无底框）
// ---------------------------------------------------------------------------
function drawSystems(st) {
  const c = hudCtx;
  const K = HUD.S;
  const x = 26 * K;
  const y = hudH - 30 * K;

  // 油门
  const ab = st.throttle > CONFIG.fx.afterburner;
  hudMono('THR', x, y - 26 * K, 7.5 * K, HUD.gDim, 'left', 600);
  const tw = 52 * K, th = 4 * K;
  const tx = x + 22 * K, ty = y - 29 * K;
  c.strokeStyle = 'rgba(162,222,192,0.22)'; c.lineWidth = 1;
  c.strokeRect(tx + 0.5, ty + 0.5, tw, th);
  c.fillStyle = ab ? 'rgba(255,168,86,0.85)' : 'rgba(150,250,196,0.5)';
  c.fillRect(tx + 1, ty + 1, (tw - 1) * clamp(st.throttle, 0, 1), th - 1);
  if (ab) {
    c.strokeStyle = 'rgba(255,190,110,0.45)';
    c.beginPath();
    const mx = tx + (tw) * CONFIG.fx.afterburner;
    c.moveTo(mx, ty - 1); c.lineTo(mx, ty + th + 1);
    c.stroke();
  }
  hudMono(Math.round(st.throttle * 100) + '%', tx + tw + 5 * K, y - 26 * K, 8 * K,
    ab ? 'rgba(255,180,100,0.95)' : HUD.gMid, 'left', 600);

  // 状态灯（只亮有意义的）
  const lamps = [];
  if (st.gear) lamps.push(['GEAR', 'rgba(255,198,96,0.95)']);
  if (input.brake) lamps.push(['BRK', 'rgba(255,140,110,0.95)']);
  if (!st.gear) lamps.push(['FLAP', 'rgba(150,220,255,0.55)']);
  if (input.ab && !st.onGround) lamps.push(['ABRK', 'rgba(120,220,255,0.95)']);
  if (ab) lamps.push(['A/B', 'rgba(255,168,86,0.95)']);
  let lx = x;
  for (const [label, col] of lamps) {
    hudMono(label, lx, y - 10 * K, 8 * K, col, 'left', 700);
    lx += (label.length * 6.2 + 6) * K;
  }

  // 机体完整度
  const hp = clamp(st.health / 100, 0, 1);
  const hcol = hp > 0.6 ? 'rgba(150,250,196,0.7)' : (hp > 0.3 ? HUD.w : HUD.d);
  hudMono('HULL', x, y, 7.5 * K, HUD.gDim, 'left', 600);
  const hw = 52 * K, hx = x + 22 * K, hy = y - 5 * K;
  c.fillStyle = 'rgba(162,222,192,0.16)';
  c.fillRect(hx, hy, hw, 2.5 * K);
  c.fillStyle = hcol;
  c.fillRect(hx, hy, hw * hp, 2.5 * K);
  hudMono(Math.round(st.health) + '%', hx + hw + 5 * K, y, 8 * K, hcol, 'left', 600);
}

// ---------------------------------------------------------------------------
// 武器：底部中央一行（无底框）
// ---------------------------------------------------------------------------
function drawWeapons(st, cx) {
  const c = hudCtx;
  const K = HUD.S;
  const y = hudH - 26 * K;
  const gap = 20 * K;
  const wGun = 74 * K, wMsl = 66 * K, wCm = 44 * K;
  let x = cx - (wGun + wMsl + wCm + gap * 2) / 2;

  // 机炮
  hudMono('GUN', x, y - 13 * K, 7.5 * K, st.overheated ? HUD.d : HUD.gDim, 'left', 700);
  const gunCol = st.ammo > 0 ? HUD.ink : HUD.d;
  const gb = hudValue(String(st.ammo), x, y, 11 * K, gunCol, 'left');
  hudMono('/' + SIM.weapons.gun.ammoMax, gb.right + 3 * K, y, 7 * K, HUD.gDim, 'left', 500);
  // 热量条
  c.fillStyle = 'rgba(162,222,192,0.14)';
  c.fillRect(gb.left, y + 4 * K, 34 * K, 2 * K);
  c.fillStyle = st.overheated ? HUD.d : (st.heat > 0.75 ? HUD.w : 'rgba(255,178,96,0.65)');
  c.fillRect(gb.left, y + 4 * K, 34 * K * clamp(st.heat, 0, 1), 2 * K);

  x += wGun + gap;
  const bomber = st.atype === 'bomber';
  if (bomber) {
    // 轰炸机：鱼雷 / 航弹，各自带键位标签（不写键位玩家永远记不住 B 和 F 谁是谁）
    hudMono('TORP', x, y - 13 * K, 7.5 * K, st.torps > 0 ? HUD.gDim : HUD.d, 'left', 700);
    hudMono(String(st.torps | 0), x, y, 11 * K, st.torps > 0 ? HUD.ink : HUD.d, 'left', 700);
    hudMono('F', x + 12 * K, y + 1 * K, 7 * K, 'rgba(255,206,120,0.85)', 'left', 700);
    x += wMsl + gap;
    hudMono('BOMB', x, y - 13 * K, 7.5 * K, st.bombs > 0 ? HUD.gDim : HUD.d, 'left', 700);
    hudMono(String(st.bombs | 0), x, y, 11 * K, st.bombs > 0 ? HUD.ink : HUD.d, 'left', 700);
    hudMono('B', x + 12 * K, y + 1 * K, 7 * K, 'rgba(255,206,120,0.85)', 'left', 700);
    return;
  }
  // 导弹
  hudMono('AAM', x, y - 13 * K, 7.5 * K, st.lockProgress >= 1 ? HUD.d : HUD.gDim, 'left', 700);
  hudMono(String(st.missiles), x, y, 11 * K, st.missiles > 0 ? HUD.ink : HUD.d, 'left', 700);
  for (let i = 0; i < SIM.weapons.missile.count; i++) {
    const bx = x + 12 * K + i * 7 * K;
    const on = i < st.missiles;
    c.strokeStyle = on ? 'rgba(255,206,120,0.85)' : 'rgba(162,222,192,0.22)';
    c.lineWidth = 1;
    c.strokeRect(bx + 0.5, y - 10 * K + 0.5, 4 * K, 11 * K);
    if (on) { c.fillStyle = 'rgba(255,206,120,0.5)'; c.fillRect(bx + 1.5, y - 8.5 * K, 2.4 * K, 3 * K); }
  }
  if (st.lockProgress >= 1) hudMono('LOCK', x, y + 7 * K, 7 * K, HUD.d, 'left', 700);
  else if (st.lockReason === 1) hudMono('NO LOS', x, y + 7 * K, 7 * K, 'rgba(255,178,96,0.95)', 'left', 700);
  else if (st.lockReason === 2) hudMono('CLUTTER', x, y + 7 * K, 7 * K, 'rgba(255,178,96,0.95)', 'left', 700);

  x += wMsl + gap;
  // 干扰弹
  hudMono('CM', x, y - 13 * K, 7.5 * K, HUD.gDim, 'left', 700);
  hudMono(String(st.flares), x, y, 11 * K, st.flares > 0 ? HUD.ink : HUD.d, 'left', 700);
}

// ---------------------------------------------------------------------------
// 座舱视角：底部是仪表盘/遮光罩，信息压成左上角两行小字
// ---------------------------------------------------------------------------
function drawCockpitStrip(st) {
  const K = HUD.S;
  const x = 26 * K;
  const ab = st.throttle > CONFIG.fx.afterburner;
  const items = st.atype === 'bomber' ? [
    ['GUN ' + st.ammo, st.ammo > 0 ? HUD.ink : HUD.d],
    ['TORP·F ' + (st.torps | 0), st.torps > 0 ? HUD.ink : HUD.d],
    ['BOMB·B ' + (st.bombs | 0), st.bombs > 0 ? HUD.ink : HUD.d],
    ['THR ' + Math.round(st.throttle * 100) + '%', ab ? 'rgba(255,180,100,0.95)' : HUD.gMid]
  ] : [
    ['GUN ' + st.ammo, st.ammo > 0 ? HUD.ink : HUD.d],
    ['AAM ' + st.missiles, st.missiles > 0 ? HUD.ink : HUD.d],
    ['CM ' + st.flares, st.flares > 0 ? HUD.ink : HUD.d],
    ['THR ' + Math.round(st.throttle * 100) + '%', ab ? 'rgba(255,180,100,0.95)' : HUD.gMid]
  ];
  let lx = x;
  for (const [t, col] of items) {
    hudMono(t, lx, 76 * K, 8.5 * K, col, 'left', 600);
    lx += hudWidth(t, 8.5 * K) + 11 * K;
  }
  // 第二行：起落架/刹车/结构
  let mx = x;
  const flags = [];
  if (st.gear) flags.push(['GEAR', HUD.w]);
  if (input.brake) flags.push(['BRK', 'rgba(255,140,110,0.95)']);
  if (input.ab && !st.onGround) flags.push(['ABRK', 'rgba(120,220,255,0.95)']);
  for (const [t, col] of flags) {
    hudMono(t, mx, 88 * K, 8 * K, col, 'left', 700);
    mx += hudWidth(t, 8 * K) + 10 * K;
  }
  const hp = clamp(st.health / 100, 0, 1);
  const hcol = hp > 0.6 ? HUD.gDim : (hp > 0.3 ? HUD.w : HUD.d);
  hudMono('HULL ' + Math.round(st.health) + '%', mx, 88 * K, 8 * K, hcol, 'left', 600);
  if (st.lockProgress >= 1) hudMono('LOCK', mx + hudWidth('HULL 100%', 8 * K) + 10 * K, 88 * K, 8 * K, HUD.d, 'left', 700);
}

// ---------------------------------------------------------------------------
// 告警：中心上方，细边框 + 左侧竖条（不铺底色）
// ---------------------------------------------------------------------------
function drawWarnings(st) {
  const K = HUD.S;
  const cx = hudW / 2, cy = hudH / 2;
  let y = cy - 158 * K;
  const now = nowSec();
  const blink = Math.sin(now * 16) > -0.1;
  const box = (txt, col, filled) => {
    const c = hudCtx;
    c.font = '700 ' + (11.5 * K).toFixed(1) + 'px ' + HUD.mono;
    const w = c.measureText(txt).width + 16 * K;
    const h = 17 * K;
    c.strokeStyle = col; c.lineWidth = 1.1;
    c.globalAlpha *= filled ? 0.95 : 0.7;
    c.strokeRect(cx - w / 2, y - 12 * K, w, h);
    c.globalAlpha = 1;
    if (filled) {
      c.fillStyle = col;
      c.fillRect(cx - w / 2, y - 12 * K, 2 * K, h);
      c.fillRect(cx + w / 2 - 2 * K, y - 12 * K, 2 * K, h);
    }
    hudMono(txt, cx, y, 11.5 * K, col, 'center', 700);
    y -= (h + 6 * K);
  };
  if (st.lockedBy) box('MISSILE LOCK — F 干扰', HUD.d, true);
  if (st.stalled && blink) box('STALL', HUD.w, true);
  const agl = st.pos.y - Math.max(0, FP.terrainHeight(st.pos.x, st.pos.z));
  if (st.alive && !st.onGround && agl < 150 && st.vel.y < -6) {
    if (blink) box('PULL UP', HUD.d, true);
  }
  if (st.gear && st.speed > SIM.aircraft.maxGearSpeed) box('GEAR OVERSPEED', HUD.w, false);
  if (st.overheated) box('GUN OVERHEAT', HUD.w, false);
  if (st.health < 30) box('AIRFRAME ' + Math.round(st.health) + '%', HUD.d, true);
  if (st.out > 0.5 || Math.abs(st.pos.x) > SIM.world.half - SIM.world.softMargin
    || Math.abs(st.pos.z) > SIM.world.half - SIM.world.softMargin) {
    box('LEAVING AREA', HUD.w, true);
  }
}

// ---------------------------------------------------------------------------
// 左上：呼号 / 战绩（小、暗，不挡视线）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 无线电字幕（与语音包同步；语音没加载出来也能看）
// ---------------------------------------------------------------------------
function drawRadio() {
  const m = game.radioMsg;
  if (!m || m.t <= 0) return;
  const K = HUD.S;
  const c = hudCtx;
  const a = clamp(m.t / 0.45, 0, 1);
  c.save();
  c.globalAlpha = HUD.op * a;
  const size = 15 * K;
  c.font = '600 ' + size.toFixed(1) + 'px ' + HUD.ui;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  const tw = c.measureText(m.text).width;
  // 座舱视角：贴着仪表板上沿（约屏高 62%）播放，别飘到地平线上挡视野
  const cx0 = hudW / 2;
  const y0 = game.view === 'cockpit' ? hudH * 0.625 : hudH - 72 * K;
  const urg = m.pri >= 2;
  // 细括号 + 顶部扫描线，保持“无面板”风格
  const half = tw / 2 + 16 * K;
  hudStroke((k) => {
    k.moveTo(cx0 - half, y0 + 6 * K); k.lineTo(cx0 - half, y0 - 5 * K); k.lineTo(cx0 - half + 7 * K, y0 - 5 * K);
    k.moveTo(cx0 + half, y0 + 6 * K); k.lineTo(cx0 + half, y0 - 5 * K); k.lineTo(cx0 + half - 7 * K, y0 - 5 * K);
  }, urg ? HUD.d : HUD.gMid, 1.2);
  // 小小的“无线电波”记号
  hudStroke((k) => {
    const bx = cx0 - half - 12 * K;
    k.moveTo(bx, y0 - 4 * K); k.lineTo(bx, y0 + 4 * K);
    k.moveTo(bx + 3 * K, y0 - 7 * K); k.lineTo(bx + 3 * K, y0 + 7 * K);
    k.moveTo(bx + 6 * K, y0 - 3 * K); k.lineTo(bx + 6 * K, y0 + 3 * K);
  }, urg ? HUD.d : HUD.gDim, 1.4);
  c.fillStyle = urg ? HUD.w : HUD.ink;
  // 描边：字幕经常压在地面/跑道上，纯填充色读不清
  c.lineJoin = 'round';
  c.lineWidth = 3.4 * K;
  c.strokeStyle = 'rgba(2,8,14,0.78)';
  c.strokeText(m.text, cx0, y0);
  c.fillText(m.text, cx0, y0);
  c.restore();
}

function drawTopStatus(st) {
  const K = HUD.S;
  const x = 26 * K, y = 24 * K;
  const teamCol = game.myTeam === 0 ? COL.teamHud0 : COL.teamHud1;
  hudMono((game.myTeam === 0 ? 'BLUE' : 'RED') + ' · ' + game.myName, x, y, 10 * K, teamCol, 'left', 700);
  let me = null;
  for (const r of game.roster) if (r.i === game.myId) { me = r; break; }
  if (me) {
    hudMono(me.s + ' PTS', x, y + 13 * K, 9 * K, HUD.ink, 'left', 600);
    hudMono(me.k + 'K / ' + me.d + 'D', x, y + 24 * K, 8 * K, HUD.gDim, 'left', 500);
  }
  const fps = Math.round(game.fpsAvg || 0);
  hudMono(fps + ' FPS · ' + Math.round(game.rtt) + 'ms', x, y + 35 * K, 7.5 * K,
    fps < 45 ? HUD.w : HUD.gFaint, 'left', 500);
}

// =============================================================================
// === 主 HUD 绘制 =============================================================
// =============================================================================
// === 战舰 HUD：航速/航向/血量/炮塔装填/瞄准环/敌舰框/鱼雷扇面 ==================
// =============================================================================
// === 炮弹视角画中画（本舰主炮发射后，右上角小视窗跟弹飞行到落水）=============
// =============================================================================
// 触发：shipfire 事件（本舰大口径）武装 → 从快照 sh 里认领最新一颗本舰弹，
// 相机挂在弹道后上方跟随飞行，落水后停留在弹着点看 1.5s 水柱再关闭。
// 快照 20Hz，帧间用"最后位置 + 估计速度"外推，相机再加低通，看起来是连续飞行。
// sh 每项 { i: 弹id, f: 开火舰id, p, b }：只追本舰（f === myShipId）≥200mm 的弹。
const _pipCam = new THREE.PerspectiveCamera(55, 320 / 200, 2, 30000);
const _pipState = {
  armed: false,            // shipfire 触发的认领武装
  armedAt: 0,
  shellId: 0,              // 正在跟的弹
  phase: '',               // '' | 'fly'
  px: 0, py: 0, pz: 0,     // 最后快照位置
  vx: 0, vy: 0, vz: 0,     // 快照差分速度
  prevY: null,             // 上一快照 y（差分用）
  lastSeen: 0              // 最后一次在快照里见到该弹的时刻
};
const PIP_W = 320, PIP_H = 200;
// 视窗只在落水前这么多秒出现（弹飞 15~20s，只看最后俯冲段）
const PIP_SHOW_TTA = 3.0;

function updateSplashPiP(dt, t) {
  // 只在舰上且活着显示；死亡/切到飞机直接复位
  const myV = shipViews.get(game.myShipId);
  if (!game.myShipId || !myV) {
    if (_pipState.phase) { _pipState.phase = ''; _pipState.shellId = 0; }
    _pipState.armed = false;
    game.pipRect = null;
    return;
  }
  // BB/CA/DD 全开：弹上第一人称（相机贴弹），一次只跟一发
  const myT = SHIP_TYPES_CL && SHIP_TYPES_CL[myV.e.t];
  if (!(myT && myT.mainGuns)) return;

  const latest = game.snaps.length ? game.snaps[game.snaps.length - 1] : null;
  const now = t;

  // ---- 1. 武装中：认领最新的一颗本舰弹（id 最大 = 刚出膛）----
  // 认领后到落水前不再换弹（DD 连射也不会打断当前视角）
  // ⚠️ 只认"刚出膛"的弹：上一轮齐射的后续弹可能还在飞（甚至已在下降段），
  //    若不筛，新一次开火会立刻认领那颗老弹 → 视窗瞬间出现在半空。
  if (_pipState.armed && latest && latest.sh) {
    let newest = 0;
    for (const s of latest.sh) {
      if (s.f !== game.myShipId) continue;
      if (s.p[1] < 120) continue;          // 已在低空/接近落水的旧弹，不要
      if (s.i > newest) newest = s.i;
    }
    if (newest > 0 && newest !== _pipState.shellId) {
      _pipState.shellId = newest;
      _pipState.phase = 'fly';
      _pipState.prevY = null;
      _pipState.armed = false;
    } else if (now - _pipState.armedAt > 2) {
      _pipState.armed = false;             // 2s 内没等到弹进快照（全打空了？）放弃
    }
  }

  // ---- 2. 弹位置：快照里找这颗弹，差分估速 ----
  if (_pipState.phase === 'fly') {
    let found = null;
    if (latest && latest.sh) {
      for (const s of latest.sh) if (s.i === _pipState.shellId) { found = s; break; }
    }
    if (found) {
      if (_pipState.prevY !== null) {
        const iv = 1 / 0.05;               // 快照 20Hz
        _pipState.vx = (found.p[0] - _pipState.px) * iv;
        _pipState.vy = (found.p[1] - _pipState.py) * iv;
        _pipState.vz = (found.p[2] - _pipState.pz) * iv;
      }
      _pipState.px = found.p[0]; _pipState.py = found.p[1]; _pipState.pz = found.p[2];
      _pipState.prevY = found.p[1];
      _pipState.lastSeen = now;
    } else if (now - _pipState.lastSeen > 0.25) {
      // 连续多帧不在快照里 → 已落水，视窗直接关闭（不要落地停留视角）
      _pipState.phase = '';
      _pipState.shellId = 0;
      game.pipRect = null;
      return;
    }
  }
  if (!_pipState.phase) { game.pipRect = null; return; }

  // ---- 3. 只在落水前 PIP_SHOW_TTA 秒才开视窗 ----
  // 战列舰弹飞 15~20s，全程跟拍大半时间在看天，没有信息量。
  // 只保留"俯冲扑向海面"这最后几秒：能看到水柱升起、命中敌舰的爆闪。
  // tta = 剩余落水秒数（下降段用线性近似；爬升段/过顶点前直接算作"还早"）
  const seaY = 0;
  let tta = Infinity;
  if (_pipState.vy < -1) {
    tta = (_pipState.py - seaY) / -_pipState.vy;
  }
  if (tta > PIP_SHOW_TTA) {
    if (game.pipRect) game.pipRect = null;   // 还早：视窗不显示（继续跟踪位置）
    return;
  }

  // ---- 4. 弹上相机：贴着弹，朝速度方向看出去（第一人称，无跟拍）----
  // 帧间外推：快照间隔 50ms，外推 + 低通后视觉连续
  const eAge = clamp(now - _pipState.lastSeen, 0, 0.25);
  const ex = _pipState.px + _pipState.vx * eAge;
  const ey = Math.max(1, _pipState.py + _pipState.vy * eAge);
  const ez = _pipState.pz + _pipState.vz * eAge;
  const spd = Math.hypot(_pipState.vx, _pipState.vy, _pipState.vz) || 1;
  const dx = _pipState.vx / spd, dy = _pipState.vy / spd, dz = _pipState.vz / spd;
  // 相机位置 = 弹位回拉 6m（刚出膛时不被炮口烟糊脸），随弹一路到落水
  const camX = ex - dx * 6, camY = Math.max(2, ey - dy * 6), camZ = ez - dz * 6;
  // 看点 = 弹前方 800m：下落段自然看到海面逼近，命中舰船时直接看到爆闪
  const lx = ex + dx * 800, ly = ey + dy * 800, lz = ez + dz * 800;
  const dpr = renderer.getPixelRatio();
  const cw = Math.floor(PIP_W * dpr), ch = Math.floor(PIP_H * dpr);
  const hudTop = 88 + 12;
  const px = Math.floor((window.innerWidth - PIP_W - 18) * dpr);
  // ⚠️ WebGL scissor 的 y 从底部算起，HUD 的 y 从顶部算起，必须换算
  const py = Math.floor((window.innerHeight - hudTop - PIP_H) * dpr);
  _pipCam.aspect = PIP_W / PIP_H;
  _pipCam.updateProjectionMatrix();
  _pipCam.position.set(camX, camY, camZ);
  _pipCam.up.set(0, 1, 0);
  _pipCam.lookAt(lx, ly, lz);
  renderer.setScissorTest(true);
  renderer.setScissor(px, py, cw, ch);
  renderer.setViewport(px, py, cw, ch);
  renderer.render(scene, _pipCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));
  // 边框画在 HUD 上（drawShipHUD 里按 pipRect 画）
  game.pipRect = { x: window.innerWidth - PIP_W - 18, y: hudTop, w: PIP_W, h: PIP_H };
}

function drawShipHUD(dt) {
  const c = hudCtx;
  const K = HUD.S = hudScale();
  const cx = hudW / 2, cy = hudH / 2;
  const v = shipViews.get(game.myShipId);
  if (!v) return;
  const e = v.e;
  const T = (SHIP_TYPES_CL && SHIP_TYPES_CL[e.t]) || null;
  const own = e.ow === game.myId;

  // ---------- 本舰已沉：只显示战损通报 + 重生倒计时 ----------
  if (!e.al) {
    const bw = 250 * K, bh = 74 * K;
    c.save();
    c.globalAlpha = 0.85;
    c.fillStyle = 'rgba(12,16,20,0.72)';
    c.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
    c.restore();
    hudMono('本舰已击沉', cx, cy - 14 * K, 15 * K, 'rgba(255,140,110,0.98)', 'center', 800);
    hudMono('正在重新出击…', cx, cy + 10 * K, 8.5 * K, 'rgba(230,235,240,0.85)', 'center', 600);
    hudMono((T ? T.name : '') + ' · ' + (e.n || ''), cx, cy + 24 * K, 7.2 * K,
      'rgba(190,200,210,0.7)', 'center', 500);
    return;
  }

  // ---------- 搁浅警告（离岸太近，停车拖底）----------
  if (e.ag) {
    hudMono('搁浅警告 — 前方水深不足，立即倒车', cx, cy + 44 * K, 9 * K,
      (Math.sin(nowSec() * 6) > 0 ? 'rgba(255,120,90,0.98)' : 'rgba(255,190,120,0.95)'), 'center', 700);
  }

  // ---------- 炮弹视角画中画边框（3D 视窗已由渲染层画好，这里画框+标签）----------
  if (game.pipRect) {
    const r = game.pipRect;
    const rx = r.x, ry = r.y, rw = r.w, rh = r.h;
    hudStroke((k) => { k.rect(rx + 0.5, ry + 0.5, rw, rh); }, 'rgba(150,220,200,0.55)', 1.2);
    hudStroke((k) => {                    // 四角短刻线（观察窗观感）
      const L = 10 * K;
      k.moveTo(rx, ry + L); k.lineTo(rx, ry); k.lineTo(rx + L, ry);
      k.moveTo(rx + rw - L, ry); k.lineTo(rx + rw, ry); k.lineTo(rx + rw, ry + L);
      k.moveTo(rx + rw, ry + rh - L); k.lineTo(rx + rw, ry + rh); k.lineTo(rx + rw - L, ry + rh);
      k.moveTo(rx + L, ry + rh); k.lineTo(rx, ry + rh); k.lineTo(rx, ry + rh - L);
    }, 'rgba(170,255,225,0.85)', 1.6);
    hudMono('弹着观察', rx + 6 * K, ry + 12 * K, 8 * K, 'rgba(170,255,225,0.9)', 'left', 700);
  }

  // ---------- 主炮准星：画在「指令点的屏幕投影」上 ----------
  // 这是唯一自洽的做法。之前准星用鼠标位移映射屏幕坐标、落点用世界坐标投影，
  // 是两套坐标系：鼠标推到底时准星在屏幕 78% 处，而真正的瞄准点（方位偏 60°）
  // 早就出画面了，玩家永远对不上。
  const ip = project(game.shipAim.x, 0.6, game.shipAim.z);
  const rp = project(game.shipAimReal.x, 0.6, game.shipAimReal.z);
  const PADX = 30 * K, PADT = 96 * K, PADB = 78 * K;
  const ax = ip ? clamp(ip.x, PADX, hudW - PADX) : cx;
  const ay = ip ? clamp(ip.y, PADT, hudH - PADB) : cy;
  const offX = ip ? Math.abs(ip.x - ax) : 0;
  const offY = ip ? Math.abs(ip.y - ay) : 0;
  const offScreen = !ip || offX > 2 || offY > 2;
  const aligned = (rp && rp.x === rp.x) ? Math.hypot(rp.x - ax, rp.y - ay) < 13 * K : false;

  // ---------- 我方落点标记：上一发主炮打哪了（水面 X 记号，2.5s 渐隐）----------
  // 炮术的核心反馈：不需要记性，看一眼就知道上一发落点和目标的相对位置
  {
    const now2 = nowSec();
    for (let si = game.mySplashes.length - 1; si >= 0; si--) {
      const sp = game.mySplashes[si];
      const age = now2 - sp.t;
      if (age > 2.5) { game.mySplashes.splice(si, 1); continue; }
      const sp2 = project(sp.x, 1.2, sp.z);
      if (!sp2 || sp2.x < 0 || sp2.x > hudW || sp2.y < 0 || sp2.y > hudH) continue;
      const al = clamp(1 - age / 2.5, 0, 1);
      const r0 = (sp.big ? 15 : 10) * K;
      c.save();
      c.globalAlpha = al;
      // 深色衬底：海面亮背景上也看得清
      hudStroke((k) => {
        k.moveTo(sp2.x - r0, sp2.y - r0); k.lineTo(sp2.x + r0, sp2.y + r0);
        k.moveTo(sp2.x + r0, sp2.y - r0); k.lineTo(sp2.x - r0, sp2.y + r0);
      }, 'rgba(0,0,0,0.5)', 3.4);
      hudStroke((k) => {
        k.moveTo(sp2.x - r0, sp2.y - r0); k.lineTo(sp2.x + r0, sp2.y + r0);
        k.moveTo(sp2.x + r0, sp2.y - r0); k.lineTo(sp2.x - r0, sp2.y + r0);
      }, 'rgba(255,214,140,0.95)', 1.6);
      c.restore();
    }
  }

  // ---------- 弹道预览：从炮口到落点的弧 ----------
  // 有了它，玩家能直观看出"这一炮飞多久、弧线多高"，
  // 而不是盯着一个孤立的准星猜炮弹会去哪。
  const mg = T && T.mainGuns;
  if (mg && ip) {
    const d = game.aimRange;
    const vv = mg.shellSpeed;
    const s2 = clamp(9.81 * d / (vv * vv), 0, 0.92);
    const th = 0.5 * Math.asin(s2);
    const vx = vv * Math.cos(th), vy = vv * Math.sin(th);
    const tf = d / Math.max(1, vx);
    game.aimFlight = tf;
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const tt = tf * (k / 16);
      const prj = project(
        game.aimMuzX + game.aimDirX * vx * tt,
        game.aimMuzY + vy * tt - 4.905 * tt * tt,
        game.aimMuzZ + game.aimDirZ * vx * tt);
      if (prj) pts.push(prj);
    }
    if (pts.length > 1) {
      c.save();
      c.setLineDash([5 * K, 5 * K]);
      c.strokeStyle = 'rgba(0,0,0,0.28)';
      c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.stroke();
      c.strokeStyle = 'rgba(180,255,225,0.55)';
      c.lineWidth = 1.3;
      c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.stroke();
      c.restore();
      // 落点小刻度：抛物线与海面交点处画一条短横线（不含在准星里，避免混淆）
    }
  }

  // ---------- 炮塔实际落点：四段缺口圆 ----------
  // 对齐了变绿、没对齐是琥珀色，并用虚线牵到准星 ——
  // 这是玩家判断"炮塔转没转到位"的唯一依据。
  // 落点在屏幕外时贴边画箭头（炮塔还在转的那几秒最容易出现）。
  // project() 只在相机背后返回 null，屏幕外的点仍有坐标 —— 所以要显式判边界
  const rpIn = !!rp && rp.x > PADX && rp.x < hudW - PADX && rp.y > PADT && rp.y < hudH - PADB;
  if (rpIn) {
    const rr = 20 * K;
    const colR = aligned ? 'rgba(150,255,200,0.95)' : 'rgba(255,196,110,0.92)';
    hudStroke((k) => {
      for (let q = 0; q < 4; q++) {
        const a0 = q * Math.PI / 2 + 0.24, a1 = (q + 1) * Math.PI / 2 - 0.24;
        k.moveTo(rp.x + Math.cos(a0) * rr, rp.y + Math.sin(a0) * rr);
        k.arc(rp.x, rp.y, rr, a0, a1);
      }
    }, colR, 1.5);
    if (!aligned) {
      c.save();
      c.setLineDash([4 * K, 4 * K]);
      c.strokeStyle = 'rgba(255,196,110,0.42)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(rp.x, rp.y); c.lineTo(ax, ay); c.stroke();
      c.restore();
    }
  }

  // 炮塔落点出屏：贴边画一个带朝向的箭头，否则玩家会以为炮塔"没动"
  if (rp && !rpIn) {
    const ang = Math.atan2(rp.y - cy, rp.x - cx);
    const ex = clamp(rp.x, PADX, hudW - PADX);
    const ey = clamp(rp.y, PADT, hudH - PADB);
    c.save();
    c.translate(ex, ey);
    c.rotate(ang);
    hudStroke((k) => { k.moveTo(12 * K, 0); k.lineTo(1 * K, -7 * K); k.lineTo(1 * K, 7 * K); k.closePath(); },
      'rgba(255,196,110,0.92)', 1.5);
    c.restore();
    hudMono('炮塔', ex + Math.cos(ang) * 20 * K, ey + Math.sin(ang) * 20 * K + 3 * K, 6.8 * K,
      'rgba(255,196,110,0.8)', 'center', 600);
  }

  // ---------- 准星本体（黑色描边 + 青色细线）----------
  const crossPath = (k, len, gap) => {
    k.moveTo(ax - len, ay); k.lineTo(ax - gap, ay);
    k.moveTo(ax + gap, ay); k.lineTo(ax + len, ay);
    k.moveTo(ax, ay - len); k.lineTo(ax, ay - gap);
    k.moveTo(ax, ay + gap); k.lineTo(ax, ay + len);
  };
  hudStroke((k) => crossPath(k, 17 * K, 5 * K), 'rgba(0,0,0,0.45)', 3.2);
  hudStroke((k) => crossPath(k, 17 * K, 5 * K), aligned ? 'rgba(170,255,215,0.96)' : 'rgba(255,225,175,0.96)', 1.5);
  c.save();
  c.beginPath(); c.arc(ax, ay, 2.8 * K, 0, Math.PI * 2);
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fill();
  c.beginPath(); c.arc(ax, ay, 2.1 * K, 0, Math.PI * 2);
  c.fillStyle = aligned ? 'rgba(170,255,215,0.98)' : 'rgba(255,225,175,0.98)'; c.fill();
  c.restore();

  // 距离 + 飞行时间（贴在准星下方，炮术最需要的两个数）
  hudMono((game.aimRange / 1000).toFixed(1) + 'km', ax, ay + 28 * K, 8.4 * K,
    'rgba(190,255,225,0.92)', 'center', 700);
  if (game.aimFlight) {
    hudMono('TOF ' + game.aimFlight.toFixed(1) + 's', ax, ay + 39 * K, 7.4 * K,
      'rgba(160,215,200,0.75)', 'center', 600);
  }
  // 出屏指示：指令点在画面外时贴边画箭头（否则玩家会以为准星消失了）
  if (offScreen) {
    const dir = Math.atan2((ip ? ip.y : cy) - ay, (ip ? ip.x : cx) - ax);
    c.save();
    c.translate(ax, ay);
    c.rotate(dir);
    hudStroke((k) => { k.moveTo(-10 * K, 0); k.lineTo(2 * K, -6 * K); k.lineTo(2 * K, 6 * K); k.closePath(); },
      'rgba(255,196,110,0.9)', 1.4);
    c.restore();
  }

  // ---------- 自动提前量：炮塔直接瞄提前点，不用玩家手动套 ----------
  // 海战瞄准真正难的是提前量：10km 外炮弹要飞 11 秒，18 节的目标会跑出 100m。
  // 以前给一个"提前量环"让玩家手动套——条件苛刻、还要心算，几乎没人用得起来。
  // 现在直接改瞄准指令：玩家锁定某艘敌舰后，shipAim 自动外推到"弹丸到达时目标的位置"，
  // 玩家只需要把准星放在敌舰附近，剩下的交给火控。锁定 = 瞄准方向 ±20° 内最近的敌舰。
  // 简单易懂：看到敌舰 → 准星压上去 → 空格 → 命中。
  game.aimLead = null;
  if (game.aimFlight > 0.3) {
    const tf = game.aimFlight;
    let best = null, bestScore = 1e9;
    for (const [, sv] of shipViews) {
      if (sv.e.tm === game.myTeam || !sv.e.al || sv.e.wn) continue;
      const dx = sv.p.x - v.p.x, dz = sv.p.z - v.p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 24000 || dist < 300) continue;
      // 锁定窗口：瞄准方向 ±20°（0.935）内最近的目标，锁定后写进 aimLead
      const dot = (dx * game.aimDirX + dz * game.aimDirZ) / Math.max(1, dist);
      if (dot < 0.935) continue;
      const score = dist + (1 - dot) * 20000;
      if (score < bestScore) { bestScore = score; best = { sv, dist, dx, dz }; }
    }
    if (best) {
      const sv = best.sv;
      const spd = sv.e.v || 0;
      // 迭代 2 次：飞行时间随提前点距离变化，一次外推会略欠
      let lx = sv.p.x, lz = sv.p.z, t2 = tf;
      for (let it = 0; it < 2; it++) {
        const hx = -Math.sin(sv.h), hz = -Math.cos(sv.h);
        lx = sv.p.x + hx * spd * t2;
        lz = sv.p.z + hz * spd * t2;
        const d2 = Math.hypot(lx - v.p.x, lz - v.p.z);
        // 飞行时间按新距离重算（对数射程不变——玩家控制的是射程档，不是目标距离）
        t2 = tf * clamp(d2 / Math.max(1, best.dist), 0.5, 1.5);
      }
      game.aimLead = { x: lx, z: lz, dist: best.dist, spd, id: sv.e.i };
      // 把提前量直接并进瞄准指令：shipAim = 准星方向 × 射程 与 提前点的合成
      // 做法简单粗暴：把指令点沿目标航向平移到提前点方位上，保持玩家设定的射程不变
      // （aimMuzX/Z 是 0 号炮塔炮口世界坐标，updateShipCamera 每帧写入）
      const leadYaw = Math.atan2(-(lx - game.aimMuzX), -(lz - game.aimMuzZ));
      game.aimYawLead = leadYaw;
      game.shipAim.x = game.aimMuzX + (-Math.sin(leadYaw)) * game.aimRange;
      game.shipAim.z = game.aimMuzZ + (-Math.cos(leadYaw)) * game.aimRange;
    } else {
      game.aimYawLead = 0;
    }
  } else {
    game.aimYawLead = 0;
  }

  // ---------- 提前量可视化：锁定目标时画一个连到准星的引导框 ----------
  if (game.aimLead) {
    const lp = project(game.aimLead.x, 0.6, game.aimLead.z);
    if (lp && lp.x > 0 && lp.x < hudW && lp.y > 0 && lp.y < hudH) {
      const rr = 15 * K;
      // 提前点：实线菱形框（这是炮弹会落的地方）
      hudStroke((k) => {
        k.moveTo(lp.x, lp.y - rr); k.lineTo(lp.x + rr * 0.8, lp.y);
        k.lineTo(lp.x, lp.y + rr); k.lineTo(lp.x - rr * 0.8, lp.y); k.closePath();
      }, 'rgba(120,220,255,0.9)', 1.5);
      // 从准星到提前点的引导线（淡）
      c.save();
      c.setLineDash([3 * K, 4 * K]);
      c.strokeStyle = 'rgba(120,220,255,0.4)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(lp.x, lp.y); c.stroke();
      c.restore();
      hudMono('自动提前', lp.x, lp.y + rr + 12 * K, 6.8 * K, 'rgba(120,220,255,0.8)', 'center', 600);
    }
  }

  // ---------- 射程刻度尺（右侧竖排，对数刻度）----------
  {
    const rx2 = hudW - 56 * K;
    const ry0 = hudH * 0.26, ry1 = hudH * 0.74;
    const AR0 = 1500, AR1 = 22000;
    c.strokeStyle = 'rgba(150,200,230,0.20)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(rx2, ry0); c.lineTo(rx2, ry1); c.stroke();
    const yOf = (r) => ry1 - (Math.log(clamp(r, AR0, AR1) / AR0) / Math.log(AR1 / AR0)) * (ry1 - ry0);
    for (const mk of [2000, 5000, 10000, 15000, 22000]) {
      const yy = yOf(mk);
      c.beginPath(); c.moveTo(rx2 - 5 * K, yy); c.lineTo(rx2, yy); c.stroke();
      hudMono((mk / 1000) + '', rx2 - 8 * K, yy + 3.2 * K, 6.8 * K, 'rgba(160,200,230,0.5)', 'right', 600);
    }
    const yy = yOf(game.aimRange);
    c.fillStyle = 'rgba(150,255,200,0.95)';
    c.beginPath();
    c.moveTo(rx2 + 2 * K, yy); c.lineTo(rx2 + 9 * K, yy - 4.5 * K); c.lineTo(rx2 + 9 * K, yy + 4.5 * K);
    c.closePath(); c.fill();
    hudMono((game.aimRange / 1000).toFixed(1), rx2 + 13 * K, yy + 3.2 * K, 7.2 * K, 'rgba(150,255,200,0.9)', 'left', 700);
    hudMono('km', rx2 + 13 * K, yy + 11 * K, 5.6 * K, 'rgba(150,255,200,0.5)', 'left', 500);
  }

  // 炮塔方位条：船是活的，炮塔转到哪一侧必须一眼看出（尤其转视角看别处时）
  if (e.gy && e.gy.length) {
    const bx = cx, by = hudH - 42 * K, halfW = 74 * K;
    hudMono('主炮方位', bx - halfW - 10 * K, by, 7.0 * K, 'rgba(170,200,225,0.55)', 'right', 600);
    c.strokeStyle = 'rgba(140,190,230,0.22)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(bx - halfW, by); c.lineTo(bx + halfW, by); c.stroke();
    for (let i = -2; i <= 2; i++) {
      const tx2 = bx + i * halfW / 2;
      c.beginPath(); c.moveTo(tx2, by - 3 * K); c.lineTo(tx2, by + 3 * K); c.stroke();
    }
    for (const gyy of e.gy) {
      const px2 = bx + clamp(gyy / 1.6, -1, 1) * halfW;   // ±1.6rad 满量程
      c.fillStyle = 'rgba(150,255,200,0.9)';
      c.beginPath();
      c.moveTo(px2, by - 4 * K); c.lineTo(px2 + 3 * K, by); c.lineTo(px2, by + 4 * K); c.lineTo(px2 - 3 * K, by);
      c.closePath(); c.fill();
    }
    // 指令位置
    const px3 = bx + clamp((game.shipAimYaw - v.h) * -1 / 1.6, -1, 1) * halfW;
    c.strokeStyle = 'rgba(255,196,110,0.85)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(px3, by - 6 * K); c.lineTo(px3, by + 6 * K); c.stroke();
  }

  // ---------- 敌舰标记：可视舰船画框 + 距离 ----------
  // 视距规则：12km 内正常显示（超雾距后舰影不可辨）。
  // 例外：**开火暴露** —— 主炮/鱼雷开火、命中我舰的敌舰自动暴露 8~12s
  // （炮口闪光定位，真实海战规则），超视距也完整显示，否则 AI 16km 外
  // 开炮玩家却连敌人在哪都不知道。过期条目顺手清掉。
  const SHIP_VIS_RANGE = 12000;
  for (const [sid, until] of game.shipSpotted) {
    if (until < nowSec()) game.shipSpotted.delete(sid);
  }
  for (const [id, sv] of shipViews) {
    if (sv.e.tm === game.myTeam) continue;   // 只框敌舰（友舰不挡视线）
    const d = Math.hypot(sv.p.x - v.p.x, sv.p.z - v.p.z);
    const spotted = game.shipSpotted.has(id);
    if (d > SHIP_VIS_RANGE && !spotted) continue;   // 超视距且未暴露：不显示
    const p = project(sv.p.x, sv.p.y + 14, sv.p.z);
    if (!p) continue;
    // 暴露中的敌舰不随距离淡出（全信息显示）；平时 8km 起渐隐与雾同步
    const fade = spotted ? 1 : d < 8000 ? 1 : 1 - clamp((d - 8000) / (SHIP_VIS_RANGE - 8000), 0, 1);
    const s = 16 * K;
    const col0 = sv.e.wn ? '180,190,200' : '255,170,120';
    const col = 'rgba(' + col0 + ',' + (0.9 * fade).toFixed(2) + ')';
    hudStroke((k) => {
      k.moveTo(p.x - s, p.y - s * 0.62); k.lineTo(p.x - s, p.y + s * 0.62);
      k.moveTo(p.x + s, p.y - s * 0.62); k.lineTo(p.x + s, p.y + s * 0.62);
      k.moveTo(p.x - s, p.y + s * 0.9); k.lineTo(p.x + s, p.y + s * 0.9);
    }, col, 1.3);
    // 超视距暴露的敌舰：框外加三角警示 + 距离加粗提示"它看得到你，你看不到它"
    if (d > SHIP_VIS_RANGE) {
      c.save();
      c.globalAlpha = fade;
      c.fillStyle = 'rgba(255,120,80,0.95)';
      c.beginPath();
      c.moveTo(p.x, p.y - s * 0.62 - 22 * K);
      c.lineTo(p.x - 5 * K, p.y - s * 0.62 - 31 * K);
      c.lineTo(p.x + 5 * K, p.y - s * 0.62 - 31 * K);
      c.closePath();
      c.fill();
      c.restore();
    }
    // 名字标签：6 字以上截断（扎堆时一排大字互相糊脸）；暴露舰在超视距也显示名字，
    // 你得知道是谁在打你；平时 3km 内才显示名字（远处舰种+距离够用）
    const nm = (sv.e.n || '');
    const near = d < 3000 || spotted;
    const label = (SHIP_TYPES_CL && SHIP_TYPES_CL[sv.e.t] ? SHIP_TYPES_CL[sv.e.t].short : '') +
      ' ' + (near ? (nm.length > 6 ? nm.slice(0, 6) : nm) : '') + (near ? ' ' : '') +
      (d / 1000).toFixed(1) + 'km';
    hudMono(label, p.x, p.y - s * 0.62 - 6 * K, 6.5 * K, col, 'center', 600);
    // 血条：随标签一起缩小
    const hpF = clamp(sv.e.hp / Math.max(1, sv.e.mx), 0, 1);
    const bw = 40 * K;
    c.fillStyle = 'rgba(20,26,32,' + (0.6 * fade).toFixed(2) + ')';
    c.fillRect(p.x - bw / 2, p.y - s * 0.62 - 4 * K, bw, 2.8 * K);
    c.fillStyle = hpF > 0.5 ? 'rgba(120,255,190,' + (0.9 * fade).toFixed(2) + ')'
      : hpF > 0.22 ? 'rgba(255,196,110,' + (0.95 * fade).toFixed(2) + ')'
      : 'rgba(255,110,90,' + (0.95 * fade).toFixed(2) + ')';
    c.fillRect(p.x - bw / 2, p.y - s * 0.62 - 4 * K, bw * hpF, 2.8 * K);
  }

  // ---------- 主炮装填：每座炮塔一个格，填充 = 装填进度 ----------
  // 装填进度来自服务端快照 rl（0..1）。这不是装饰：齐射时机完全取决于它，
  // 玩家必须能一眼看出"还差多久能打"。
  if (e.gy) {
    const bw = 30 * K, gap = 5 * K;
    const totalW = e.gy.length * bw + (e.gy.length - 1) * gap;
    const x0 = cx - totalW / 2, y0 = hudH - 84 * K;
    let ready = 0;
    for (let i = 0; i < e.gy.length; i++) {
      const bx = x0 + i * (bw + gap);
      const hp = e.gh ? e.gh[i] : 1;
      const rl = e.rl ? clamp(e.rl[i] === undefined ? 1 : e.rl[i], 0, 1) : 1;
      if (rl >= 0.999) ready++;
      // 底槽
      c.fillStyle = 'rgba(16,24,32,0.62)';
      c.fillRect(bx, y0, bw, 8 * K);
      // 装填填充
      if (hp > 0.05) {
        c.fillStyle = rl >= 0.999 ? 'rgba(130,255,200,0.95)' : 'rgba(110,185,255,0.80)';
        c.fillRect(bx + 0.8, y0 + 0.8, (bw - 1.6) * rl, 8 * K - 1.6);
      } else {
        c.fillStyle = 'rgba(150,70,60,0.75)';        // 炮塔被毁
        c.fillRect(bx + 0.8, y0 + 0.8, bw - 1.6, 8 * K - 1.6);
      }
      c.strokeStyle = rl >= 0.999 ? 'rgba(150,255,210,0.75)' : 'rgba(120,180,240,0.45)';
      c.lineWidth = 1;
      c.strokeRect(bx + 0.5, y0 + 0.5, bw - 1, 8 * K - 1);
    }
    hudMono('主炮', x0 - 6 * K, y0 + 7 * K, 7.2 * K, 'rgba(160,220,255,0.65)', 'right', 600);
    if (ready === e.gy.length) {
      hudMono('齐射就绪', x0 + totalW + 7 * K, y0 + 7 * K, 7.2 * K,
        (Math.sin(nowSec() * 5) > 0 ? 'rgba(150,255,200,0.95)' : 'rgba(120,220,180,0.7)'), 'left', 700);
    }
  }

  // ---------- 左下：航速 / 航向 / 血量 / 进水火势 ----------
  const spd = (e.v * 1.944).toFixed(0);       // 节
  const hdg = ((Math.round((-v.h * 180 / Math.PI) % 360) + 360) % 360);
  hudMono(T ? T.name : '', 26 * K, hudH - 132 * K, 11 * K, 'rgba(160,255,220,0.95)', 'left', 700);
  hudMono('SPD ' + spd + ' kn', 26 * K, hudH - 116 * K, 9.5 * K, 'rgba(200,240,255,0.9)', 'left', 600);
  hudMono('HDG ' + String(hdg).padStart(3, '0') + '°', 26 * K, hudH - 103 * K, 9.5 * K, 'rgba(200,240,255,0.9)', 'left', 600);
  // 血条（大）
  const hpF = clamp(e.hp / Math.max(1, e.mx), 0, 1);
  hudMono('HULL ' + Math.round(hpF * 100) + '%', 26 * K, hudH - 88 * K, 9.5 * K,
    hpF > 0.4 ? 'rgba(150,255,200,0.95)' : 'rgba(255,140,110,0.95)', 'left', 700);
  const bw = 150 * K;
  c.fillStyle = 'rgba(20,26,32,0.65)';
  c.fillRect(26 * K, hudH - 83 * K, bw, 6 * K);
  c.fillStyle = hpF > 0.5 ? 'rgba(120,255,190,0.9)' : hpF > 0.22 ? 'rgba(255,196,110,0.95)' : 'rgba(255,110,90,0.95)';
  c.fillRect(26 * K, hudH - 83 * K, bw * hpF, 6 * K);
  // 进水 / 火势 / 损管（三条状态行，按需上移，避免和油门档重叠）
  let sy = hudH - 66 * K;
  if ((e.fl || 0) > 0.03) { hudMono('进水 ' + Math.round((e.fl || 0) * 100) + '%', 26 * K, sy, 9 * K, 'rgba(140,200,255,0.9)', 'left', 700); sy -= 12 * K; }
  if ((e.fi || 0) > 0.03) { hudMono('起火 ' + Math.round((e.fi || 0) * 100) + '%', 26 * K, sy, 9 * K, 'rgba(255,150,90,0.95)', 'left', 700); sy -= 12 * K; }
  {
    const dcF = clamp(e.dc === undefined ? 1 : e.dc, 0, 1);
    const dcol = dcF >= 1 ? 'rgba(150,255,200,0.9)' : 'rgba(255,200,120,0.85)';
    hudMono('损管 ' + (dcF >= 1 ? '就绪 (R)' : Math.round(dcF * 100) + '%'), 26 * K, sy, 9 * K, dcol, 'left', 600);
  }
  // 油门档
  hudMono('油门 ' + ['倒车', '停', '慢', '中', '全'][(game.shipThr === undefined ? 2 : game.shipThr) + 1],
    26 * K, hudH - 26 * K, 9 * K, 'rgba(200,240,255,0.75)', 'left', 600);

  // ---------- 右下：鱼雷状态（余雷 / 装填进度）----------
  if (T && T.torpedo) {
    const tr = clamp(e.tr === undefined ? 1 : e.tr, 0, 1);
    const ammo = e.ty === undefined ? 0 : e.ty;
    const ready = tr >= 1 && ammo > 0;
    const bx2 = hudW - 26 * K, by2 = hudH - 62 * K;
    hudMono('鱼雷 ' + ammo + ' 发', bx2, by2, 9 * K, 'rgba(200,240,255,0.85)', 'right', 600);
    hudMono(ready ? '就绪 (F)' : (ammo <= 0 ? '无雷' : '装填 ' + Math.round(tr * 100) + '%'),
      bx2, by2 + 13 * K, 9 * K,
      ready ? 'rgba(180,255,220,0.95)' : 'rgba(255,200,120,0.9)', 'right', 700);
    // 装填进度条
    const w2 = 96 * K;
    c.fillStyle = 'rgba(20,26,32,0.6)';
    c.fillRect(bx2 - w2, by2 + 19 * K, w2, 4 * K);
    c.fillStyle = ready ? 'rgba(150,255,210,0.85)' : 'rgba(255,190,110,0.85)';
    c.fillRect(bx2 - w2, by2 + 19 * K, w2 * (ammo > 0 ? tr : 0), 4 * K);
  }

  // ---------- 键位提示（上舰前 12 秒）----------
  if (game.hudTip > 0) {
    game.hudTip -= dt;
    hudMono('W/S 油门档 · A/D 舵 · 鼠标瞄准 · 左键齐射 · F 鱼雷 · R 损管 · C 视角',
      cx, 64 * K, 8.5 * K, 'rgba(170,220,255,0.75)', 'center', 600);
  }
}

// === 飞机 HUD ================================================================
function drawHUD(dt) {
  const c = hudCtx;
  c.clearRect(0, 0, hudW, hudH);
  // ---- 舰上：战舰 HUD（与飞机 HUD 完全分离）----
  if (game.myShipId) { drawShipHUD(dt); return; }
  const st = game.own && game.own.state;
  if (!st) return;
  const cx = hudW / 2, cy = hudH / 2;
  const ypr = FP.yprFromQuat(st.quat);

  HUD.S = hudScale();
  const mode = game.hudMode || 0;
  HUD.detail = 2 - mode;                       // 2 完整 / 1 简洁 / 0 关闭
  const targetOp = mode >= 2 ? 0 : 1;
  game.hudOp = game.hudOp == null ? targetOp : game.hudOp + (targetOp - game.hudOp) * Math.min(1, dt * 10);
  if (game.hudOp < 0.02) return;
  HUD.op = game.hudOp;

  const K = HUD.S;
  const compact = HUD.detail <= 1;

  // ---------- 高速速度线（极弱，只做“风”的感觉）----------
  const sp = clamp((st.speed - 220) / 300, 0, 1);
  if (sp > 0.02) {
    c.save();
    c.globalAlpha = HUD.op * (0.2 + sp * 0.8);
    c.translate(cx, cy);
    c.strokeStyle = 'rgba(255,255,255,' + (0.02 + sp * 0.05).toFixed(3) + ')';
    c.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const seed = i * 2.399;
      const a = (i / 14) * Math.PI * 2 + performance.now() * 0.00016;
      const r0 = Math.min(hudW, hudH) * (0.40 + 0.05 * (0.5 + 0.5 * Math.sin(seed * 3.7)));
      const r1 = r0 + 40 + sp * 130 + 26 * Math.sin(seed * 5.1);
      c.beginPath();
      c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      c.stroke();
    }
    c.restore();
  }

  // ---------- HUD 主体（统一透明度）----------
  c.save();
  c.globalAlpha = HUD.op;

  // 姿态仪只在第一人称画：追尾视角里地平线正好横穿机体，像给飞机穿了根钢丝
  if (game.view === 'cockpit') drawAttitude(st, ypr, cx, cy);
  if (!compact) {
    drawSpeedTape(st, cx, cy);
    drawAltTape(st, cx, cy);
    drawHeadingTape(st, ypr, cx);
  } else {
    // 简洁模式：只留数字
    hudMono(String(Math.round(st.speed * 3.6)), 26 * K, cy + 8 * K, 15 * K, HUD.ink, 'left', 700);
    hudMono('KM/H', 26 * K, cy + 21 * K, 7 * K, HUD.gDim, 'left', 500);
    hudMono(String(Math.round(st.pos.y)), hudW - 26 * K, cy + 8 * K, 15 * K, HUD.ink, 'right', 700);
    hudMono('ALT m', hudW - 26 * K, cy + 21 * K, 7 * K, HUD.gDim, 'right', 500);
  }
  drawReticle(st, cx, cy);
  drawFriendlies(cx, cy);
  drawTargets(st, cx, cy);
  drawEnemyAwareness(st, cx, cy);      // 全向敌情：视野内菱形 + 屏外方位箭头
  drawCarrierHud(st, cx, cy);          // 航母标记 + 着舰引导（下滑道/对中）
  if (st.atype === 'bomber') drawBomberHud(st, cx, cy);   // 轰炸瞄准 + 投雷包线
  if (game.view === 'cockpit') {
    drawCockpitStrip(st);                     // 座舱视角：底部留给仪表盘
  } else {
    if (!compact) {
      drawRadar(st, ypr);
      drawSystems(st);
    }
    drawWeapons(st, cx);
  }
  drawRadio();
  drawTopStatus(st);
  drawWarnings(st);
  drawHomeBase(st, ypr, cx, cy);
  c.restore();

  // ---------- 命中反馈 ----------
  if (game.hitMarker > 0) {
    game.hitMarker -= dt;
    const s2 = 12 * K;
    c.save();
    c.globalAlpha = HUD.op;
    hudStroke((k) => {
      k.moveTo(cx - s2, cy - s2); k.lineTo(cx - s2 * 0.4, cy - s2 * 0.4);
      k.moveTo(cx + s2, cy - s2); k.lineTo(cx + s2 * 0.4, cy - s2 * 0.4);
      k.moveTo(cx - s2, cy + s2); k.lineTo(cx - s2 * 0.4, cy + s2 * 0.4);
      k.moveTo(cx + s2, cy + s2); k.lineTo(cx + s2 * 0.4, cy + s2 * 0.4);
    }, 'rgba(255,255,255,0.9)', 1.8);
    c.restore();
  }
  if (game.hitFlash > 0) {
    game.hitFlash -= dt * 1.6;
    const a = clamp(game.hitFlash, 0, 1) * 0.32;
    const g = c.createRadialGradient(cx, cy, Math.min(hudW, hudH) * 0.25, cx, cy, Math.min(hudW, hudH) * 0.72);
    g.addColorStop(0, 'rgba(255,40,30,0)');
    g.addColorStop(1, 'rgba(255,40,30,' + a + ')');
    c.fillStyle = g;
    c.fillRect(0, 0, hudW, hudH);
  }
  if (game.killFlash > 0) {
    game.killFlash -= dt * 1.2;
    c.save();
    c.globalAlpha = clamp(game.killFlash, 0, 1);
    hudMono('KILL', cx, cy - 140 * K, 20 * K, 'rgba(160,255,196,0.95)', 'center', 700);
    c.restore();
  }

  // ---------- 导弹无锁定蓄力条（准星下方短横条）----------
  // 未锁定按住发射键 = 蓄力哑弹；进度满自动发射（服务端 holdMissile 阈值）。
  // 蓄力中松手 = 取消。锁定状态不画（锁定走按下即发，无需蓄力）。
  if (input.missile && st.alive && !(st.lockProgress >= 1 && st.lockTargetId)) {
    const HOLD_T = (SIM.weapons.missile && SIM.weapons.missile.holdFireTime) || 1.2;
    game.mslHold = (game.mslHold || 0) + dt;
    const pr = clamp(game.mslHold / HOLD_T, 0, 1);
    const bw2 = 86 * K, bh2 = 5 * K, bx2 = cx - bw2 / 2, by2 = cy + 46 * K;
    c.save();
    c.globalAlpha = HUD.op;
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 3.2;
    c.strokeRect(bx2, by2, bw2, bh2);
    c.strokeStyle = pr >= 1 ? 'rgba(160,255,196,0.95)' : 'rgba(255,206,120,0.9)';
    c.lineWidth = 1.6;
    c.strokeRect(bx2, by2, bw2, bh2);
    c.fillStyle = pr >= 1 ? 'rgba(160,255,196,0.85)' : 'rgba(255,206,120,0.75)';
    c.fillRect(bx2 + 1, by2 + 1, (bw2 - 2) * pr, bh2 - 2);
    hudMono(pr >= 1 ? 'DUMB-FIRE' : '蓄力 ' + Math.round(pr * 100) + '%',
      cx, by2 + 15 * K, 7.2 * K,
      pr >= 1 ? 'rgba(160,255,196,0.9)' : 'rgba(255,206,120,0.85)', 'center', 600);
    c.restore();
  } else {
    game.mslHold = 0;
  }

  // ---------- 受击方向指示 ----------
  // 被打时在准星周围画一道指向攻击者方位的橙红弧（0=机头方向，右为正）。
  // 弧只在远半径出现一小段，不遮挡中心；快消失时缩回+变淡。
  if (game.hitDir && game.hitDir.t > 0) {
    game.hitDir.t -= dt;
    const hd = game.hitDir;
    const a = clamp(hd.t / 1.25, 0, 1);
    const R = Math.min(hudW, hudH) * (0.24 + 0.05 * a);
    const th = hd.ang;
    const span = 0.42;                                   // 弧半宽（rad，约 ±24°）
    c.save();
    c.globalAlpha = 0.25 + 0.65 * a;
    c.strokeStyle = 'rgba(255,118,66,0.95)';
    c.lineWidth = 3.4 * K;
    c.lineCap = 'round';
    c.beginPath();
    // 屏幕：正前=上。x = cx + R*sin(th)，y = cy - R*cos(th)
    c.arc(cx, cy, R, th - Math.PI / 2 - span, th - Math.PI / 2 + span);
    c.stroke();
    // 弧心一个小三角，指向更明确
    const tx = cx + R * Math.sin(th), ty = cy - R * Math.cos(th);
    const px2 = Math.cos(th), py2 = Math.sin(th);
    c.beginPath();
    c.moveTo(tx + px2 * 9 * K, ty + py2 * 9 * K);
    c.lineTo(tx - px2 * 5 * K + py2 * 5 * K, ty - py2 * 5 * K - px2 * 5 * K);
    c.lineTo(tx - px2 * 5 * K - py2 * 5 * K, ty - py2 * 5 * K + px2 * 5 * K);
    c.closePath();
    c.fillStyle = 'rgba(255,118,66,0.95)';
    c.fill();
    c.restore();
  }

  // ---------- 座舱暗角（压暗四周，不挡中心）----------
  if (game.view === 'cockpit') {
    const vg = c.createRadialGradient(cx, cy, Math.min(hudW, hudH) * 0.40, cx, cy, Math.max(hudW, hudH) * 0.74);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,8,14,0.30)');
    c.fillStyle = vg;
    c.fillRect(0, 0, hudW, hudH);
  }

  // ---------- 高 G 隧道视野 ----------
  // 用平滑后的 gVis，且门限抬到 6G：以前 5G 就开始收窄，稍微盘一下就黑一圈。
  const gTunnel = clamp((game.gVis - 6.2) / 4.6, 0, 1);
  if (gTunnel > 0.01) {
    const r = Math.min(hudW, hudH) * (0.42 + 0.28 * gTunnel);
    const vg = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(24,0,0,' + (0.58 * gTunnel).toFixed(3) + ')');
    c.fillStyle = vg;
    c.fillRect(0, 0, hudW, hudH);
  }

  // ---------- 穿云白罩：已移除（整屏发白会让人看不清姿态，改成只保留声音发闷）----------

  // ---------- 重生倒计时 ----------
  if (!st.alive) {
    const v = game.views.get(game.myId);
    const rsp = (v && v.e.rsp) || 0;
    hudMono('重新出击', cx, cy + 66 * K, 10 * K, HUD.w, 'center', 600);
    hudMono(rsp.toFixed(1) + 's', cx, cy + 84 * K, 14 * K, HUD.ink, 'center', 700);
  }

  // ---------- 鼠标未锁定提示 ----------
  if (!game.touchMode && document.pointerLockElement !== canvas) {
    hudMono('点击画面接管操控', cx, cy + (game.view === 'cockpit' ? -132 : 130) * K, 11 * K, HUD.w, 'center', 600);
  }

  // ---------- HUD 模式提示 ----------
  if (game.hudTip > 0) {
    game.hudTip -= dt;
    hudMono(mode === 0 ? 'HUD 完整' : (mode === 1 ? 'HUD 简洁' : 'HUD 关闭'),
      cx, hudH - 52 * K, 9 * K, 'rgba(200,235,255,0.7)', 'center', 500);
  }
}

// =============================================================================
// === 界面：击杀信息 / 排行榜 / 结算 ==========================================
// =============================================================================
function addKill(html, team, sys, ico, mine) {
  const d = document.createElement('div');
  d.className = 'row' + (sys ? ' sys' : '') + (mine ? ' mine' : '');
  if (team === 0) html = '<span class="n0">' + html + '</span>';
  else if (team === 1) html = '<span class="n1">' + html + '</span>';
  d.innerHTML = (ico ? '<span class="ico">' + ico + '</span>' : '') + html;
  domKill.appendChild(d);
  while (domKill.children.length > 7) domKill.removeChild(domKill.firstChild);
  setTimeout(() => { d.classList.add('fade'); }, 6000);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
}

let centerTimer = null;
function pushCenter(txt, sec) {
  game.centerMsg = txt;
  domCenter.textContent = txt;
  domCenter.classList.add('show');
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => domCenter.classList.remove('show'), (sec || 2) * 1000);
}

function updateBoard() {
  if (!game.showBoard) { domBoard.classList.remove('show'); domBoard.innerHTML = ''; return; }
  domBoard.classList.add('show');
  let h = '<h3>战 场 态 势　蓝 ' + game.teamScore[0] + ' : ' + game.teamScore[1] + ' 红</h3>';
  h += '<table><thead><tr><th class="l">呼号</th><th>击杀</th><th>阵亡</th><th>得分</th></tr></thead><tbody>';
  for (const tm of [0, 1]) {
    const rows = game.roster.filter((r) => r.t === tm).sort((a, b) => b.s - a.s);
    h += '<tr class="teamHead t' + tm + '"><td colspan="4">' + (tm === 0 ? '蓝队' : '红队')
      + '<span>' + game.teamScore[tm] + ' 分 · ' + rows.length + ' 人</span></td></tr>';
    for (const r of rows) {
      h += '<tr class="row t' + tm + (r.i === game.myId ? ' me' : '') + '">'
        + '<td class="name">' + r.n + '</td>'
        + '<td class="num">' + r.k + '</td>'
        + '<td class="num">' + r.d + '</td>'
        + '<td class="num">' + r.s + '</td></tr>';
    }
  }
  h += '</tbody></table>';
  domBoard.innerHTML = h;
}

function showEnd(e) {
  domEnd.classList.remove('hidden');
  const title = e.w < 0 ? '平局' : ((e.w === 0 ? '蓝队' : '红队') + ' 获胜');
  el('endTitle').textContent = title;
  // 无线电：给自己这边一个结局呼号
  if (e.w === game.myTeam) Radio.say('win', { gap: 0, hold: 3.4, pri: 3 });
  else if (e.w >= 0) Radio.say('lose', { gap: 0, hold: 3.4, pri: 3 });
  el('endTitle').style.color = e.w === 0 ? COL.teamHud0 : (e.w === 1 ? COL.teamHud1 : '#eaf6ff');
  let h = '<div class="score"><b class="s0">' + e.s[0] + '</b><span class="sep">:</span><b class="s1">' + e.s[1] + '</b></div>';
  const top = (e.r || []).slice(0, 6);
  h += '<table>';
  for (const r of top) {
    h += '<tr class="t' + r.t + '"><td class="name">' + r.n + '</td>'
      + '<td class="num">' + r.k + ' 杀 / ' + r.d + ' 死</td>'
      + '<td class="num">' + r.s + ' 分</td></tr>';
  }
  h += '</table>';
  el('endBody').innerHTML = h;
  el('endTip').textContent = '即将开始新一局…';
  const bar = document.getElementById('endBar');
  if (bar) {
    bar.style.setProperty('--reset', (SIM.match.resetDelaySec || 12) + 's');
    bar.firstElementChild.style.animation = 'none';
    void bar.offsetWidth;
    bar.firstElementChild.style.animation = '';
  }
  setTimeout(() => domEnd.classList.add('hidden'), (SIM.match.resetDelaySec - 1) * 1000);
}

function updateScorebar() {
  domScore0.textContent = game.teamScore[0];
  domScore1.textContent = game.teamScore[1];
  const t = Math.max(0, game.timeLeft);
  domClock.textContent = Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  domClock.classList.toggle('low', t < 60);
  // 距目标分还差多少：进度条按领先队伍/目标分推进
  const tgt = Math.max(1, SIM.match.targetScore);
  const lead = Math.max(game.teamScore[0], game.teamScore[1]);
  domObjFill.style.width = Math.min(100, (lead / tgt) * 100).toFixed(1) + '%';
}

// =============================================================================
// === 主循环 ==================================================================
// =============================================================================
let lastT = performance.now() * 0.001;
let seaT = 0;

// 穿云判定：进入云团 → 白罩渐满 + 颠簸 + 声音发闷
// ---------------------------------------------------------------------------
// 语音播报：把飞行状态/敌情翻译成无线电呼号
// ---------------------------------------------------------------------------
const _c6 = new THREE.Vector3();
function updateCallouts(dt, st) {
  // 字幕计时
  if (game.radioMsg) {
    game.radioMsg.t -= dt;
    if (game.radioMsg.t <= 0) game.radioMsg = null;
  }
  if (!st || !st.alive) return;

  // ---- 锁定完成 / 被锁定 ----
  const locking = st.lockTargetId && st.lockProgress >= 1;
  if (locking && game.lastLockSaid !== st.lockTargetId) {
    game.lastLockSaid = st.lockTargetId;
    Radio.say('lock', { gap: 1.2 });
  }
  if (!locking) game.lastLockSaid = 0;
  if (st.lockedBy) Radio.say('missile', { gap: 7, pri: 2, hold: 2.2 });

  // ---- 六点方向敌机（1.6km 内、在我后方锥内）----
  const fwd = _retFwd.set(0, 0, -1).applyQuaternion(game.renderQuat);
  let sixDist = 1e9;
  for (const [id, v] of game.views) {
    if (id === game.myId || !v.e.al || v.e.tm === game.myTeam) continue;
    const dx = v.pos.x - st.pos.x, dy = v.pos.y - st.pos.y, dz = v.pos.z - st.pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1600) continue;
    const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / (d || 1);
    if (dot < -0.45) sixDist = Math.min(sixDist, d);
  }
  if (sixDist < 1600) Radio.say('six', { gap: 11, pri: 2 });

  // ---- 失速 / 近地 ----
  if (st.stalled) Radio.say('stall', { gap: 6, pri: 2 });
  if (!st.onGround) {
    const agl = st.pos.y - Math.max(0, FP.terrainHeight(st.pos.x, st.pos.z));
    if (agl < 85 && st.vel.y < -14) Radio.say('pullup', { gap: 5, pri: 2 });
  }

  // ---- 弹药 ----
  if (st.ammo > 0 && st.ammo <= 60) Radio.say('lowammo', { gap: 30, hold: 2.2 });

  // ---- 起落架：进近但没放轮 ----
  if (!st.onGround && st.gear === false && !st.crashDone) {
    const agl = st.pos.y - Math.max(0, FP.terrainHeight(st.pos.x, st.pos.z));
    if (agl < 700 && st.vel.y < -1) Radio.say('checkgear', { gap: 14, pri: 2, hold: 2.2 });
  }

  // ---- 短五边：对准跑道、低空、轮子已放 → 报进近 ----
  if (!st.onGround && st.gear !== false && !st.crashDone) {
    const ap = FP.teamAirport(game.myTeam);
    const ax = ap.x - st.pos.x, az = ap.z - st.pos.z;
    const dAp = Math.hypot(ax, az);
    if (dAp > 520 && dAp < 3200) {
      const loc = FP.airportLocal(ap, st.pos.x, st.pos.z);
      const fromFar = loc.along > 0;                  // 与 drawHomeBase 的进近方向一致
      const hx = fromFar ? -ap.hx : ap.hx;
      const hz = fromFar ? -ap.hz : ap.hz;
      const spd = Math.hypot(st.vel.x, st.vel.z);
      const agl = st.pos.y - Math.max(0, FP.terrainHeight(st.pos.x, st.pos.z));
      if (spd > 35 && agl < 460 && agl > 5 && st.vel.y < 0.5) {
        const align = (st.vel.x * hx + st.vel.z * hz) / spd;
        // 必须是“朝机场飞”而不是刚起飞离场（离场时速度方向背离机场）
        const closing = (st.vel.x * ax + st.vel.z * az) / (spd * dAp);
        if (align > 0.88 && closing > 0.6) Radio.say('approach', { gap: 22, hold: 2.4 });
      }
    }
  }

  // ---- 新发现的敌机（数据链上出现的新目标）----
  const seen = game.seenEnemies || (game.seenEnemies = new Set());
  let fresh = 0;
  for (const [id, v] of game.views) {
    if (id === game.myId) continue;
    if (v.e.tm === game.myTeam) continue;
    if (!seen.has(id)) { seen.add(id); fresh++; }
  }
  // 目标长时间不在视野里就清掉，重新出现时再报一次
  for (const id of seen) if (!game.views.has(id)) seen.delete(id);
  if (fresh > 0 && !game.radioMsg) Radio.say('contact', { gap: 6, hold: 2.0 });
  // ---- 空域安全：之前数据链上有目标，现在全清 ----
  if ((game.prevContacts | 0) > 0 && seen.size === 0) Radio.say('cleared', { gap: 16, hold: 2.2 });
  game.prevContacts = seen.size;
}

function updateCloudImmersion(dt) {
  const own = game.own && game.own.state;
  if (!own || !own.alive) { game.inCloud += (0 - game.inCloud) * Math.min(1, dt * 4); return; }
  let inside = 0;
  for (const cl of game.clouds) {
    const dx = own.pos.x - cl.x, dz = own.pos.z - cl.z;
    if (dx * dx + dz * dz < cl.r * cl.r && Math.abs(own.pos.y - cl.y) < cl.h) { inside = 1; break; }
  }
  game.inCloud += (inside - game.inCloud) * Math.min(1, dt * 6);
  // 云中乱流抖屏已移除：整屏抖动会让人无法瞄准，穿云只保留声音发闷
}

function frame() {
  requestAnimationFrame(frame);
  const t = performance.now() * 0.001;
  let dt = t - lastT;
  lastT = t;
  if (!(dt > 0)) dt = 0.016;
  // rawDt 用于帧率统计与画质计时：如果也用 clamp 后的 dt，
  // 真实 10fps 会被算成 16.7fps，自适应降级永远等不到 2 秒。
  const rawDt = dt;
  dt = Math.min(dt, 0.06);
  // 诊断用：本帧实际积分用的 dt。抖动探针必须用这个口径算速度，
  // 用它自己的 rAF 间隔会和这里差 1~2ms，除以小 dt 会把正常帧放大成 1.7 倍“跳变”。
  game.lastDt = dt;

  if (game.playing) {
    updateInput(dt);
    predict(dt);
    sendInput();
    interpolate();
    syncMeshes(dt);
    updateCamera(dt);

    const own = game.own && game.own.state;
    // ---- 穿云沉浸：白罩 / 颠簸 / 声音发闷 ----
    updateCloudImmersion(dt);
    Sound.update(own ? own.speed : 0, own ? own.throttle : 0, !!(own && own.alive), dt, game.inCloud);

    // 告警音
    if (own && own.alive) {
      if (own.lockedBy) {
        if (t - Sound.lastWarn > 0.35) { Sound.lastWarn = t; Sound.beep(980, 0.15, 0.09); }
      }
      if (own.stalled && t - Sound.lastStall > 0.5) { Sound.lastStall = t; Sound.beep(320, 0.12, 0.1); }
      // 锁定音：进度越高，滴答越急
      if (own.lockTargetId) {
        const gap = own.lockProgress >= 1 ? 0.55 : Math.max(0.09, 0.46 - own.lockProgress * 0.32);
        if (t - Sound.lastLock > gap) {
          Sound.lastLock = t;
          Sound.beep(620 + own.lockProgress * 460, own.lockProgress >= 1 ? 0.10 : 0.07, 0.055);
        }
      }
      // 手感反馈：开炮/失速轻微抖屏
      if (input.fire && own.ammo > 0 && !own.overheated) game.shake = Math.max(game.shake, 0.055);
      if (own.stalled) game.shake = Math.max(game.shake, 0.10);
      // 无线电高度告警（类 GPWS）：越低、下沉越快，提示音越急
      if (!own.onGround) {
        const aglW = own.pos.y - Math.max(0, FP.terrainHeight(own.pos.x, own.pos.z));
        const sink = -own.vel.y;
        if (aglW < 320) {
          let gap = 0;
          if (aglW < 60) gap = 0.18;
          else if (aglW < 120) gap = sink > 3 ? 0.3 : 0.6;
          else if (aglW < 200) gap = sink > 3 ? 0.8 : 0;
          else if (aglW < 320 && sink > 6) gap = 1.2;
          if (gap && t - (Sound.lastPull || 0) > gap) {
            Sound.lastPull = t;
            Sound.beep(420, 0.18, 0.12);
          }
        }
      }
      updateCallouts(dt, own);
      // 跑道滑跑颠簸：地面震动用低频正弦，不起白噪声
      if (own.onGround && own.speed > 8) {
        game.shake = Math.max(game.shake, 0.012 + clamp(own.speed / 90, 0, 1) * 0.035);
      }
    }

    // 死亡镜头：缓慢环绕坠毁点
    if (own && !own.alive) {
      game.deathTimer += dt;
      const a = game.deathTimer * 0.35;
      const r = 60;
      camera.position.lerp(_v3.set(
        own.pos.x + Math.cos(a) * r, own.pos.y + 25, own.pos.z + Math.sin(a) * r
      ), 1 - Math.exp(-dt * 2));
      camera.lookAt(own.pos.x, own.pos.y, own.pos.z);
    }
  }

  adaptQuality(rawDt);

  // 平滑偏移衰减（服务器修正的视觉吸收）。
  // 衰减速率要和回包频率(20Hz)错开：太快会在两次回包之间留下锯齿，太慢会拖尾。
  // 3.2/s 时 50ms 内衰减 15%，肉眼不可辨。
  if (game.renderOffset.lengthSq() > 1e-6) {
    game.renderOffset.multiplyScalar(Math.exp(-dt * 3.2));
  }
  // 姿态残差同样缓慢归零（slerp 到单位四元数）
  if (Math.abs(game.quatErr.w) < 0.9999999) {
    game.quatErr.slerp(_qId, 1 - Math.exp(-dt * 4.5));
    if (Math.abs(game.quatErr.w) > 0.9999999) game.quatErr.identity();
  }

  // 特效
  pFire.update(dt);
  pSmoke.update(dt);
  updateShocks(dt);
  updateFlash(dt);
  updateBoomLights(dt);
  updateCarrier(dt, t);
  syncShipMeshes(dt, t);
  updateShellTracers(dt);
  // 塔顶障碍灯：0.8Hz 慢闪，远远就能看出机场位置
  if (game.beacons.length) {
    const blink = (Math.sin(t * 5.0) > 0.1) ? 1 : 0.12;
    for (const bc of game.beacons) bc.material.color.setRGB(1.0 * blink, 0.20 * blink, 0.14 * blink);
  }
  if (game.postFlash > 0) game.postFlash = Math.max(0, game.postFlash - dt * 3.4);
  // 海面/云/天空全部走 GPU，这里只推时间与相机参数（CPU 成本≈0）
  updateSea(t);
  CLOUDS.update(camera, t);
  SKY.update(t);

  // 树木窗口跟随：飞出 1500m 才重铺一次。铺一次要 1.6 万棵 × 采样+矩阵，
  // 十几毫秒的卡顿；900m 一铺在 200m/s 下每 4.5 秒就顿一下。
  const tdx = camera.position.x - treeAnchorX;
  const tdz = camera.position.z - treeAnchorZ;
  if (tdx * tdx + tdz * tdz > 1500 * 1500) fillTrees(camera.position.x, camera.position.z);

  // 快照频率统计
  game.snapTimer += dt;
  if (game.snapTimer >= 1) {
    game.snapsPerSec = game.snapCount / game.snapTimer;
    game.snapCount = 0; game.snapTimer = 0;
  }

  if (!game.playing) updateMenuCamera(t);

  updateScorebar();
  updateBoard();

  // ---- 渲染：场景 → HDR → 后处理 → 屏幕 ----
  const pv = game.own && game.own.state;
  // G 视觉滞后：瞬时 gLoad 在 20Hz 快照里是跳变的，直接喂给后处理会“啪一下灰屏”。
  // 真实高过载也是有生理延迟的（血液下沉约 0.5~1 秒），所以这里做非对称平滑：
  // 上过载慢一点（约 0.55s 时间常数），恢复更快（约 0.9s），不会一拉杆就白/灰一片。
  const gRaw = pv ? Math.min(12.5, Math.abs(pv.gLoad || 1)) : 1;
  game.gVis += (gRaw - game.gVis) * Math.min(1, dt * (gRaw > game.gVis ? 1.8 : 1.1));
  const cockpit = inCockpitView();
  // 座舱场景按机种切换：轰炸机用玻璃机鼻那套，别再把战斗机仪表台塞给轰炸机
  const cpBomber = !!(pv && pv.atype === 'bomber');
  COCKPIT.visible = !cpBomber;
  BOMBER_COCKPIT.visible = cpBomber;
  if (cockpit) updateCockpitCam(dt);
  const qp = QUALITY_PRESETS[game.qualityLevel] || QUALITY_PRESETS.high;
  POSTFX.render({
    scene, camera,
    cpScene: cockpit ? cpScene : null,
    cpCamera: cockpit ? cpCamera : null,
    time: t,
    sunDir: SUN_DIR,
    speed: pv ? clamp((pv.speed - 130) / 300, 0, 1) : 0,
    g: game.gVis,
    hurt: pv ? clamp(1 - pv.health / 45, 0, 1) : 0,
    flash: game.postFlash,
    exposure: qp.exposure
  });
  // ---- 炮弹视角画中画：本舰主炮发射后，右上角跟弹飞行直到落水 ----
  updateSplashPiP(dt, t);
  if (game.playing) drawHUD(dt);
  else hudCtx.clearRect(0, 0, hudW, hudH);
}

// =============================================================================
// === 启动 ====================================================================
// =============================================================================
// ---- 画质：读取上次选择并绑定菜单 ----
(function initQuality() {
  let saved = 'auto';
  try { saved = localStorage.getItem('sky.quality') || 'auto'; } catch (e) { /* 忽略 */ }
  if (saved !== 'auto' && QUALITY_ORDER.indexOf(saved) < 0) saved = 'auto';
  setQualityMode(saved, false);
  const sel = document.getElementById('qualitySel');
  if (sel) sel.addEventListener('change', () => setQualityMode(sel.value, true));
})();

setupTouch();
// 兵种选择：默认战斗机。卡片点击切换，加入时随握手上报
game.vehicle = 'plane';
document.querySelectorAll('.vcard').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.vcard').forEach((b) => b.classList.remove('sel'));
    btn.classList.add('sel');
    game.vehicle = btn.dataset.v;
  });
});

domJoin.addEventListener('click', () => {
  Sound.init();
  Sound.resume();
  Radio.init();
  game.vehicle = (document.querySelector('.vcard.sel') || {}).dataset ? document.querySelector('.vcard.sel').dataset.v : 'plane';
  connect();
  domJoin.disabled = true;
  domJoin.textContent = '连接中…';
  setTimeout(() => { domJoin.disabled = false; domJoin.textContent = '加入战斗'; }, 4000);
});
domName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') domJoin.click();
});
requestAnimationFrame(frame);

// 调试用
window.__sky = {
  game, CONFIG, SIM, FP, THREE, scene, camera, renderer, pFire, pSmoke, Radio, Sound,
  POSTFX, SKY, CLOUDS, OCEAN,
  // 美术校准：把相机放到任意机位（仅菜单状态下生效）
  setCam(p, l) {
    game.camOverride = {
      p: new THREE.Vector3(p[0], p[1], p[2]),
      l: new THREE.Vector3(l[0], l[1], l[2])
    };
  },
  clearCam() { game.camOverride = null; },
  setQuality(m) { setQualityMode(m, false); },
  adapt: (dt) => adaptQuality(dt),
  // ---- 自动化测试接口（仅本地/调试用，不参与游戏逻辑）----
  // 传送：走服务端 dev 通道（需 SKY_DEV=1），客户端不做任何本地改写
  teleport(x, y, z, yaw, pitch, roll, speed, dir, onGround) {
    if (!sock) return;
    sock.emit('dev', {
      k: 'place', x: x, y: y, z: z, yaw: yaw || 0, pitch: pitch || 0,
      roll: roll || 0, speed: speed || 0, dir: dir || null,
      onGround: onGround, throttle: 0.55
    });
  },
  ownState() {
    const s = game.own && game.own.state;
    if (!s) return null;
    return {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: s.vel ? { x: s.vel.x, y: s.vel.y, z: s.vel.z } : { x: 0, y: 0, z: 0 },
      speed: s.speed || 0, quat: s.quat, alive: s.alive,
      onGround: !!s.onGround, gear: !!s.gear, health: s.health,
      onDeck: !!s.onDeck, catActive: !!s.catActive, deckStopped: !!s.deckStopped,
      wireCaught: !!s.wireCaught, wireIdx: s.wireIdx
    };
  },
  // 杆量直接写鼠标虚拟杆（与真实操作同一条路径）
  setStick(x, y) { game.mouse.x = x; game.mouse.y = y; },
  setThrottle(v) { game.devThrottle = v; game.throttleValue = v; },
  setGear(g) { input.gear = !!g; },
  setKey(code, down) { keys[code] = !!down; },
  // 地形高度（自动化测试选投放点/航线用；与物理层同一个函数）
  terrain: (x, z) => FP.terrainHeight(x, z),
  requestCatapult() { input.cat = true; pending.cat++; },
  // 特效调试：手动触发爆炸 / 查看粒子池占用（美术校准用）
  boom: (x, y, z, s) => spawnExplosion(x, y, z, s === undefined ? 1 : s),
  // 舰体几何自检：读前三组顶点的位置/法线/顶点色 + 材质参数字
  hullDbg: () => {
    const m = shipMeshes.get(game.myShipId);
    if (!m) return null;
    const out = [];
    for (const ch of m.group.children) {
      if (!ch.isMesh || !ch.geometry || !ch.geometry.attributes || !ch.geometry.attributes.position) continue;
      const at = ch.geometry.attributes;
      const n = Math.min(3, at.position.count);
      const samp = [];
      for (let i = 0; i < n; i++) {
        samp.push({
          p: [+at.position.getX(i).toFixed(1), +at.position.getY(i).toFixed(1), +at.position.getZ(i).toFixed(1)],
          nr: at.normal ? [+at.normal.getX(i).toFixed(2), +at.normal.getY(i).toFixed(2), +at.normal.getZ(i).toFixed(2)] : null,
          c: at.color ? [+at.color.getX(i).toFixed(3), +at.color.getY(i).toFixed(3), +at.color.getZ(i).toFixed(3)] : null
        });
      }
      out.push({
        verts: at.position.count, hasColor: !!at.color, hasUv: !!at.uv, hasNormal: !!at.normal,
        matColor: ch.material.color ? ch.material.color.getHexString() : null,
        vc: !!ch.material.vertexColors, side: ch.material.side,
        metal: ch.material.metalness, rough: ch.material.roughness,
        map: !!ch.material.map, samp
      });
    }
    return out.slice(0, 3);
  },
  // 舰船调试态（轻量，不算包围盒）：方向一致性测试专用
  shipDbg: () => {
    const v = shipViews.get(game.myShipId);
    if (!v) return null;
    const l = game.snaps.length ? game.snaps[game.snaps.length - 1] : null;
    const mine = l && l.sp ? l.sp.find((x) => x.i === game.myShipId) : null;
    const m = shipMeshes.get(game.myShipId);
    return {
      h: v.h, t: v.e.t, p: [+v.p.x.toFixed(1), +v.p.y.toFixed(1), +v.p.z.toFixed(1)],
      len: (SHIP_TYPES_CL && SHIP_TYPES_CL[v.e.t]) ? SHIP_TYPES_CL[v.e.t].len : 180,
      beam: (SHIP_TYPES_CL && SHIP_TYPES_CL[v.e.t]) ? SHIP_TYPES_CL[v.e.t].beam : 20,
      fb: (SHIP_TYPES_CL && SHIP_TYPES_CL[v.e.t]) ? SHIP_TYPES_CL[v.e.t].freeboard : 10,
      cam: [+camera.position.x.toFixed(1), +camera.position.y.toFixed(1), +camera.position.z.toFixed(1)],
      aimYaw: game.shipAimYaw, aimRange: game.aimRange,
      aimMx: game.aimMx, aimMy: game.aimMy,
      gy: mine && mine.gy ? mine.gy : null,
      rl: mine && mine.rl ? mine.rl : null,
      // 瞄准自检：指令点的屏幕投影 / 相机朝向 / 弹道时间
      aimProj: (() => { const pr = project(game.shipAim.x, 0.6, game.shipAim.z); return pr ? [+pr.x.toFixed(1), +pr.y.toFixed(1)] : null; })(),
      aimWorld: [+game.shipAim.x.toFixed(1), +game.shipAim.z.toFixed(1)],
      aimRange2: +game.aimRange.toFixed(0),
      aimYaw: +game.shipAimYaw.toFixed(4),
      flight: +(game.aimFlight || 0).toFixed(2),
      camDir: (() => { const dv = new THREE.Vector3(); camera.getWorldDirection(dv); return [+dv.x.toFixed(3), +dv.z.toFixed(3)]; })(),
      camYaw: +(game.camYaw || 0).toFixed(4),
      camOff: +(((game.camYaw || 0) - (shipViews.get(game.myShipId) || { h: 0 }).h)).toFixed(4),
      view: game.shipView,
      speed: mine ? mine.v : null, ag: mine ? mine.ag : null,
      thr: game.shipThr, rud: game.lastRudder,
      onGroundAim: null,
      yawVis: m && m.turrets ? m.turrets.map((t) => +(t.yawVis === undefined ? 0 : t.yawVis).toFixed(3)) : null
    };
  },
  // 海战调试：舰队视图/网格计数（自动化测试用）
  navalStat: () => ({
    shipViews: shipViews.size,
    shipMeshes: shipMeshes.size,
    boxes: Array.from(shipMeshes.entries()).map(([id, m]) => {
      const bb = new THREE.Box3().setFromObject(m.group);
      return {
        id, pos: m.group.position.toArray().map((x) => +x.toFixed(1)),
        rotY: +m.group.rotation.y.toFixed(2),
        size: [+(bb.max.x - bb.min.x).toFixed(1), +(bb.max.y - bb.min.y).toFixed(1), +(bb.max.z - bb.min.z).toFixed(1)],
        vis: m.group.visible, kids: m.group.children.length,
        rot: [+m.group.rotation.x.toFixed(3), +m.group.rotation.y.toFixed(3), +m.group.rotation.z.toFixed(3)],
        scl: [+m.group.scale.x.toFixed(2), +m.group.scale.y.toFixed(2), +m.group.scale.z.toFixed(2)]
      };
    }),
    latest: (() => {
      const l = game.snaps.length ? game.snaps[game.snaps.length - 1] : null;
      return l ? { ships: (l.sp || []).length, shells: (l.sh || []).length, torps: (l.tp || []).length } : null;
    })(),
    cam: [camera.position.x, camera.position.y, camera.position.z].map((x) => +x.toFixed(1)),
    // 模型结构自检：炮塔/炮管的世界坐标与可见性
    turretDbg: (() => {
      const m = shipMeshes.get(game.myShipId);
      if (!m || !m.turrets) return null;
      return m.turrets.map((tu) => {
        const wp = new THREE.Vector3(); tu.grp.getWorldPosition(wp);
        const bw = new THREE.Vector3(); tu.barrels.getWorldPosition(bw);
        const bb = new THREE.Box3().setFromObject(tu.grp);
        return {
          along: +tu.along.toFixed(1), vis: tu.grp.visible,
          wp: wp.toArray().map((x) => +x.toFixed(1)),
          bw: bw.toArray().map((x) => +x.toFixed(1)),
          kids: tu.barrels.children.length,
          bbox: [+(bb.max.x - bb.min.x).toFixed(1), +(bb.max.y - bb.min.y).toFixed(1), +(bb.max.z - bb.min.z).toFixed(1)],
          rotY: +tu.grp.rotation.y.toFixed(2), rotX: +tu.grp.rotation.x.toFixed(2),
          bz: +tu.barrels.position.z.toFixed(2)
        };
      });
    })(),
    fov: camera.fov,
    myShip: (() => {
      const v = shipViews.get(game.myShipId);
      return v ? { p: [+v.p.x.toFixed(1), +v.p.y.toFixed(1), +v.p.z.toFixed(1)], h: +v.h.toFixed(3), t: v.e.t } : null;
    })()
  }),
  fxStat: () => ({ fire: pFire.n, smoke: pSmoke.n, maxFire: pFire.max, maxSmoke: pSmoke.max }),
  __drawHUD: (dt) => drawHUD(dt),
  // 让相机立刻吸附到目标位姿（截图/自动化用；正常游戏中由平滑跟随处理）
  snapCam() {
    game.camSnap = true; game.snapChase = true; game.camSmoothInit = false;
    const own = game.own && game.own.state;
    if (!own) return;
    const q = own.quat;
    const base = new THREE.Vector3(own.pos.x, own.pos.y, own.pos.z).add(game.renderOffset);
    game.smoothQuat.set(q.x, q.y, q.z, q.w);
    if (game.view === 'cockpit') {
      const vOff = own.atype === 'bomber' ? CONFIG.view.bomberCockpitOffset : CONFIG.view.cockpitOffset;
      const off = new THREE.Vector3(
        vOff.x, vOff.y, vOff.z
      ).applyQuaternion(game.smoothQuat);
      camera.position.copy(base).add(off);
      camera.quaternion.copy(game.smoothQuat);
    } else {
      const sizeK = own.atype === 'bomber' ? CONFIG.view.bomberChaseScale : 1;
      const back = new THREE.Vector3(0, CONFIG.view.chaseUp * sizeK, CONFIG.view.chaseBack * sizeK).applyQuaternion(game.smoothQuat);
      if (!game.camSmooth) game.camSmooth = new THREE.Vector3();
      game.camSmooth.set(own.pos.x, own.pos.y, own.pos.z).add(back);
      camera.position.copy(base).add(back);
      camera.quaternion.copy(game.smoothQuat);
    }
    sky.position.copy(camera.position);
    seaMesh.position.x = Math.round(camera.position.x / 2000) * 2000;
    seaMesh.position.z = Math.round(camera.position.z / 2000) * 2000;
  },
};
