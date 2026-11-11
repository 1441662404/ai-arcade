/**
 * 山路傳說 — 主程式
 */
import * as THREE from 'three';
import { buildCenterline, makeLookup, ROAD, clamp } from './trackPath.js';
import { buildTrackScene } from './trackMesh.js';
import { Vehicle, CAR_SPECS } from './car.js';
import { createCar, attachHeadlights, attachTaillights } from './carModels.js';
import { HUD, formatTime } from './hud.js';
import { AudioEngine } from './audio.js';
import { NetClient } from './net.js';
import { createPostFX } from './postfx.js';
import { SmokeSystem, SparkSystem, SkidMarks } from './fx.js';

/* ================================================================== */
/*  設定                                                              */
/* ================================================================== */
const SETTINGS = {
  quality: localStorage.getItem('akina_q') || 'high',
  bloom: localStorage.getItem('akina_bloom') !== '0',
  music: Number(localStorage.getItem('akina_music') ?? 70),
  sfx: Number(localStorage.getItem('akina_sfx') ?? 80),
  sens: Number(localStorage.getItem('akina_sens') ?? 100),
  carId: localStorage.getItem('akina_car') || 'fr86',
  name: localStorage.getItem('akina_name') || '霧見山車手',
};
const CAR_ORDER = ['fr86', 'fc', 'fd', 'r32', 'r33', 'altezza'];

const CAR_DESC = {
  fr86: '輕量化的後驅老車，4A-GE 高轉自然進氣引擎。馬力不大，但車身輕、轉向直接，靠技術取勝的山路之王。',
  fc: '轉子引擎單渦輪增壓，前後配重極佳。車身比 FD 更沉穩，適合用油門控制車尾角度的老派跑法。',
  fd: '雙轉子雙渦輪，280 匹。低重心、高極限，出彎補油瞬間車尾就會滑開，需要細膩的反打。',
  r32: 'RB26DETT 直六雙渦輪 + ATTESA E-TS 四驅。起步與出彎極快，但車重讓它在連續髮夾彎略顯笨重。',
  r33: '更大的車體與扭力，四驅系統讓它在濕滑夜路上最穩定，直線加速是全部車種之最。',
  altezza: '前置後驅四門房車，3S-GE 高轉引擎。均衡、好上手，適合剛接觸山路的新手。',
};

/* ================================================================== */
/*  全域狀態                                                          */
/* ================================================================== */
const app = {
  mode: 'loading',
  scene: null,
  camera: null,
  renderer: null,
  post: null,
  track: null,
  lookup: null,
  world: null,
  hud: null,
  audio: null,
  net: null,
  player: null,
  remotes: new Map(),
  smoke: null,
  sparks: null,
  skids: null,
  clock: new THREE.Clock(),
  time: 0,
  raceTime: 0,
  countdown: 0,
  best: Number(localStorage.getItem('akina_best') || 0),
  camMode: 0,
  shake: 0,
  flash: 0,
  sunLight: null,
  started: false,
  opponents: [],
  room: null,
  myId: null,
  finishOrder: [],
  lastSend: 0,
  speedLines: 0,
  skidPrev: { L: null, R: null },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ================================================================== */
/*  啟動                                                              */
/* ================================================================== */
init();

async function init() {
  const canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.renderer = renderer;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070c14, 0.0042);
  app.scene = scene;

  const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.25, 4200);
  camera.position.set(0, 6, -10);
  app.camera = camera;

  app.hud = new HUD($('#hud'));
  app.audio = new AudioEngine();
  app.net = new NetClient();

  buildSky(scene);

  // 環境光：夜空散射（偏藍）＋ 地面反彈，讓車身與護欄在黑暗中仍有形體
  const hemi = new THREE.HemisphereLight(0x2a4166, 0x0a0f18, 1.45);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0x121d2c, 0.7);
  scene.add(amb);

  // 夜間反射環境（車漆金屬光澤的來源）
  app.envMap = buildEnvMap(renderer);

  const moon = new THREE.DirectionalLight(0x93b0e0, 1.15);
  moon.position.set(-260, 380, -420);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 600;
  const S = 70;
  moon.shadow.camera.left = -S; moon.shadow.camera.right = S;
  moon.shadow.camera.top = S; moon.shadow.camera.bottom = -S;
  moon.shadow.bias = -0.0012;
  moon.shadow.normalBias = 0.04;
  scene.add(moon);
  scene.add(moon.target);
  app.sunLight = moon;

  // 進度
  const setProgress = (p, text) => {
    $('#load-bar').style.width = p + '%';
    if (text) $('#load-text').textContent = text;
  };

  await nextFrame();
  setProgress(8, '正在量測霧見山的地形…');

  // 賽道
  const track = buildCenterline(2.0);
  const lookup = makeLookup(track);
  app.track = track;
  app.lookup = lookup;

  await nextFrame();
  setProgress(26, '鋪設柏油、護欄與貓眼…');

  const world = buildTrackScene(track, lookup, { terrainCell: SETTINGS.quality === 'low' ? 9 : 6 });
  scene.add(world.group);
  app.world = world;

  await nextFrame();
  setProgress(62, '架設路燈與防雪棚…');

  // 特效
  app.smoke = new SmokeSystem(scene);
  app.sparks = new SparkSystem(scene);
  app.skids = new SkidMarks(scene);

  // 後期
  app.post = createPostFX(renderer, scene, camera, { bloom: SETTINGS.bloom });
  app.post.setQuality(SETTINGS.quality);
  app.post.grade.uniforms.uRes.value.set(window.innerWidth, window.innerHeight);

  app.hud.setTrack(track);

  await nextFrame();
  setProgress(74, '調校引擎與變速箱…');

  // 玩家車
  await ensureCar(SETTINGS.carId);
  setProgress(92, '暖胎中…');

  // 起點相機
  const p0 = track.samples[8];
  camera.position.set(p0.x - p0.tx * 8, p0.y + 2.4, p0.z - p0.tz * 8);
  camera.lookAt(p0.x, p0.y + 1, p0.z);

  setProgress(100, '準備完成');
  await sleep(280);

  $('#loading').classList.remove('show');
  showScreen('menu');
  app.mode = 'menu';
  bindUI();
  window.addEventListener('resize', onResize);
  requestAnimationFrame(loop);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================================================================== */
/*  天空                                                              */
/* ================================================================== */
function buildSky(scene) {
  const geo = new THREE.SphereGeometry(3200, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x03060e) },
      uMid: { value: new THREE.Color(0x0a1526) },
      uHorizon: { value: new THREE.Color(0x1b2a40) },
      uGlow: { value: new THREE.Color(0x3a2418) },
      uGlowDir: { value: new THREE.Vector3(0.35, 0.05, 0.93).normalize() },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uMid, uHorizon, uGlow, uGlowDir;
      varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y * 1.15 + 0.06, 0.0, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.32, h));
        col = mix(col, uTop, smoothstep(0.28, 0.95, h));
        // 谷地遠方城鎮的暖光
        float g = pow(max(0.0, dot(normalize(vec3(vDir.x, 0.0, vDir.z)), uGlowDir)), 8.0)
                * (1.0 - smoothstep(0.0, 0.26, h));
        col += uGlow * g * 0.9;
        // 地平線霧帶
        col += vec3(0.02, 0.035, 0.05) * (1.0 - smoothstep(0.0, 0.12, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);

  // 星星
  const N = 1800;
  const pos = new Float32Array(N * 3);
  const sizes = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 0.96 + 0.04);
    const r = 2800;
    pos[i * 3] = Math.sin(ph) * Math.cos(th) * r;
    pos[i * 3 + 1] = Math.cos(ph) * r * 0.9 + 60;
    pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
    sizes[i] = 0.6 + Math.random() * 2.2;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const sm = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSize;
      uniform float uTime;
      varying float vTw;
      void main(){
        vTw = 0.6 + 0.4 * sin(uTime * 2.0 + position.x * 0.01);
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = aSize * 1.6;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vTw;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float d = 1.0 - smoothstep(0.0, 0.5, length(c));
        gl_FragColor = vec4(vec3(0.85,0.92,1.0), d * vTw * 0.9);
      }
    `,
  });
  const stars = new THREE.Points(sg, sm);
  stars.frustumCulled = false;
  scene.add(stars);
  app.stars = stars;

  // 月亮
  const moonTex = (() => {
    const S2 = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S2;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S2 / 2, S2 / 2, 0, S2 / 2, S2 / 2, S2 / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.16, 'rgba(240,246,255,0.98)');
    grd.addColorStop(0.24, 'rgba(200,220,255,0.35)');
    grd.addColorStop(0.55, 'rgba(150,190,255,0.10)');
    grd.addColorStop(1, 'rgba(120,170,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S2, S2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const moonSpr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  moonSpr.position.set(-620, 760, -1100);
  moonSpr.scale.setScalar(420);
  scene.add(moonSpr);
}

/**
 * 夜間反射環境貼圖：天空漸層 + 少量路燈暖光斑。
 * 車漆/玻璃/輪框靠它才有金屬反光，否則夜裡只是一團黑。
 */
let _glowTex = null;
function makeGlowTex() {
  if (_glowTex) return _glowTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

function buildEnvMap(renderer) {
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(60, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 ground = vec3(0.014, 0.016, 0.020);
        vec3 horizon = vec3(0.075, 0.105, 0.175);
        vec3 zenith = vec3(0.010, 0.018, 0.042);
        vec3 c = mix(ground, horizon, smoothstep(0.30, 0.52, h));
        c = mix(c, zenith, smoothstep(0.52, 0.95, h));
        // 地平線一圈微亮（城市光害）
        c += vec3(0.055, 0.040, 0.028) * pow(1.0 - abs(vDir.y), 9.0);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // 幾盞暖白燈，讓車漆上有高光帶
  const lampGeo = new THREE.PlaneGeometry(6, 3);
  const lamps = [
    [-34, 12, -20], [30, 15, 26], [0, 22, 40], [-26, 9, 32], [38, 10, -30],
  ];
  for (const [x, y, z] of lamps) {
    const m = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffd9a0).multiplyScalar(3.2),
      side: THREE.DoubleSide,
    }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    envScene.add(m);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader?.();
  const rt = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  pmrem.dispose();
  skyGeo.dispose(); skyMat.dispose(); lampGeo.dispose();
  envScene.traverse((o) => { if (o.isMesh && o.material?.dispose) o.material.dispose(); });
  return rt.texture;
}

/* ================================================================== */
/*  車輛管理                                                          */
/* ================================================================== */
async function ensureCar(carId) {
  const spec = CAR_SPECS[carId] || CAR_SPECS.fr86;
  const car = await createCar(spec, { envMap: app.envMap });
  const vehicle = new Vehicle(spec);
  const p = app.track.samples[8];
  vehicle.reset(p.x, p.z, p.y, Math.atan2(p.tx, p.tz), 8);

  car.root.position.set(p.x, p.y, p.z);
  car.root.rotation.y = vehicle.heading;
  app.scene.add(car.root);

  attachHeadlights(car);
  attachTaillights(car);
  updateCarLights(car);

  // 車底柔光：點光源貼著路面會在地面拉出一條刺眼的鏡面光帶，這裡不用點光，
  // 改用一個很淡的加色面片假裝底盤反光。
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 5.6),
    new THREE.MeshBasicMaterial({
      map: makeGlowTex(), color: 0x6f8dc4, transparent: true, opacity: 0.20,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.set(0, 0.03, 0);
  halo.renderOrder = 1;
  car.root.add(halo);

  // 主體光：車頂上方的柔和冷光，模擬夜色中的環境反射
  const keyLight = new THREE.PointLight(0xa9c4ff, 16, 14, 2.0);
  keyLight.position.set(0.6, 4.0, -0.2);
  car.root.add(keyLight);
  // 輪廓光：車尾後方的暖色補光，把車從背景中切出來
  const rimLight = new THREE.PointLight(0xffc98f, 7, 10, 2.0);
  rimLight.position.set(-0.4, 1.5, -4.2);
  car.root.add(rimLight);

  app.player = { car, vehicle, spec, halo, keyLight, rimLight };
  app.hud.setDriver(SETTINGS.name, spec.name, spec.team);
  app.hud.setHint('W 油門 · S 煞車（停住再按 = 倒車）· A/D 轉向 · 空白手煞車 · C 視角');
  return app.player;
}

async function switchCar(carId) {
  if (app.player) {
    app.scene.remove(app.player.car.root);
    // 幾何體與 GLB 快取共用，這裡只釋放材質，避免二次載入時模型消失
    app.player.car.root.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose) m.dispose();
      }
    });
  }
  SETTINGS.carId = carId;
  localStorage.setItem('akina_car', carId);
  await ensureCar(carId);
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
}

/* 遠端玩家 */
async function ensureRemote(id, carId, name) {
  if (app.remotes.has(id)) return app.remotes.get(id);
  const spec = CAR_SPECS[carId] || CAR_SPECS.fr86;
  let entry = { spec, name, mesh: null, halo: null };
  app.remotes.set(id, entry);
  try {
    const car = await createCar(spec);
    car.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
    });
    // 假車燈光錐
    const coneGeo = new THREE.ConeGeometry(2.4, 16, 12, 1, true);
    coneGeo.rotateX(Math.PI / 2);
    coneGeo.translate(0, 0, 8);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffe8bb, transparent: true, opacity: 0.055, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(0, 0.55, spec.bodyLength / 2 - 0.3);
    car.root.add(cone);
    const halo = new THREE.PointLight(0xffcc88, 3, 6, 2.4);
    halo.position.set(0, 0.5, 0);
    car.root.add(halo);
    app.scene.add(car.root);
    entry.car = car;
    entry.cone = cone;
    entry.halo = halo;
  } catch (e) {
    console.warn('remote car load failed', e);
  }
  return entry;
}

/* ================================================================== */
/*  輸入                                                              */
/* ================================================================== */
const keys = Object.create(null);
const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (keys[e.code]) return;
  keys[e.code] = true;
  if (e.code === 'Escape') togglePause();
  if (e.code === 'KeyC' && app.mode === 'race') cycleCamera();
  if (e.code === 'KeyR' && (app.mode === 'race' || app.mode === 'countdown')) resetToTrack();
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyN') nextTrack();
  if (e.code === 'KeyF') toggleFullscreen();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function pollInput(dt) {
  if (app.scripted) return input;
  let th = 0, br = 0, st = 0, hb = 0;
  if (keys['KeyW'] || keys['ArrowUp']) th = 1;
  if (keys['KeyS'] || keys['ArrowDown']) br = 1;
  if (keys['KeyA'] || keys['ArrowLeft']) st += 1;
  if (keys['KeyD'] || keys['ArrowRight']) st -= 1;
  if (keys['Space']) hb = 1;
  // 手把
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.12) st = -ax;
    th = Math.max(th, gp.buttons[7]?.value || 0);
    br = Math.max(br, gp.buttons[6]?.value || 0);
    if (gp.buttons[0]?.pressed) hb = 1;
    break;
  }

  const sens = SETTINGS.sens / 100;
  input.throttle = th;
  input.brake = br;
  input.steer = clamp(st * sens, -1, 1);
  input.handbrake = hb;
  return input;
}

/* ================================================================== */
/*  賽事流程                                                          */
/* ================================================================== */
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('show'));
  if (id) $('#' + id).classList.add('show');
  if (app.hud) app.hud.setVisible(!id);
}

function startRace(mode = 'solo', gridInfo = null) {
  app.mode = 'countdown';
  app.raceTime = 0;
  app.countdown = 4.2;
  app.finishOrder = [];
  app.flash = 0;
  showScreen(null);
  app.hud.setVisible(true);
  if (!app.audio.started) app.audio.init();
  app.audio.startMusic(Math.floor(Math.random() * 4));
  app.audio.musicBus.gain.value = (SETTINGS.music / 100) * 0.42;

  const track = app.track;
  const startIdx = 8;
  const p = track.samples[startIdx];
  const head = Math.atan2(p.tx, p.tz);

  const v = app.player.vehicle;
  v.reset(p.x, p.z, p.y, head, startIdx);
  app.player.car.root.visible = true;

  // 對手（離線時生成 AI 幽靈車，僅供視覺參考）
  for (const r of app.remotes.values()) {
    if (r.car) r.car.root.visible = false;
  }
  app.opponents = [];

  app.hud.showCenter('3', '');
  app.camMode = 0;
  app.raceMode = mode;
  app.raceStartAt = performance.now();
}

function beginGo() {
  app.mode = 'race';
  app.raceTime = 0;
  app.hud.showCenter('GO!', 'go');
  app.audio.beep(880, 0.3, 0.3, 'square');
  setTimeout(() => app.hud.hideCenter(), 700);
}

function finishRace() {
  if (app.mode === 'finish') return;
  app.mode = 'finish';
  const t = app.raceTime;
  const isBest = !app.best || t < app.best;
  if (isBest) {
    app.best = t;
    localStorage.setItem('akina_best', String(t));
  }
  app.net.send({ t: 'finish', time: t, best: app.best });

  const drift = Math.round(app.player.vehicle.driftScore);
  $('#res-title').innerHTML = isBest
    ? '新紀錄！ <small>NEW RECORD</small>'
    : '完成 <small>FINISH</small>';
  $('#res-grid').innerHTML = `
    <div class="res-big">${formatTime(t)}</div>
    <div class="res-row"><span>最佳紀錄</span><b>${formatTime(app.best)}</b></div>
    <div class="res-row"><span>漂移總分</span><b>${drift.toLocaleString('en-US')}</b></div>
    <div class="res-row"><span>車輛</span><b>${app.player.spec.name}</b></div>
    <div class="res-row"><span>賽道</span><b>霧見山下坡 ${(app.track.length / 1000).toFixed(2)}KM</b></div>
  `;
  showScreen('results');
  app.audio.setTire(0, 0);
  app.hud.setVisible(false);
}

function resetToTrack() {
  const v = app.player.vehicle;
  const p = app.track.samples[clamp(v.trackIndex, 0, app.track.count - 1)];
  v.reset(p.x, p.z, p.y, Math.atan2(p.tx, p.tz), v.trackIndex);
  app.hud.showMsg('回到賽道', 900);
}

function togglePause() {
  if (app.mode === 'race' || app.mode === 'countdown') {
    app.prevMode = app.mode;
    app.mode = 'paused';
    showScreen('pause');
  } else if (app.mode === 'paused') {
    app.mode = app.prevMode || 'race';
    showScreen(null);
  }
}

function cycleCamera() {
  app.camMode = (app.camMode + 1) % 4;
  const names = ['追尾視角', '近距離', '車頭視角', '引擎蓋'];
  app.hud.showMsg(names[app.camMode], 900);
}

function toggleMusic() {
  app.audio.toggleMusic(!app.audio.musicOn);
  app.hud.showMsg(app.audio.musicOn ? '音樂開' : '音樂關', 800);
}
function nextTrack() {
  const n = app.audio.nextTrack();
  app.hud.showMsg('♪ ' + n, 1400);
}
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

/* ================================================================== */
/*  主迴圈                                                            */
/* ================================================================== */
let fpsAcc = 0, fpsCount = 0, fpsTimer = 0;

function loop() {
  requestAnimationFrame(loop);
  const dtRaw = app.clock.getDelta();
  const dt = Math.min(dtRaw, 0.05);
  app.time += dt;

  if (app.stars) app.stars.material.uniforms.uTime.value = app.time;

  if (app.mode === 'race' || app.mode === 'countdown' || app.mode === 'finish') {
    updateRace(dt);
  }

  updateCamera(dt);
  updateEnvironment(dt);

  app.post.grade.uniforms.uFlash.value += (app.flash - app.post.grade.uniforms.uFlash.value) * Math.min(1, dt * 8);
  app.flash = Math.max(0, app.flash - dt * 2.6);
  app.post.grade.uniforms.uSpeed.value = app.player
    ? clamp((app.player.vehicle.speedKmh - 90) / 160, 0, 1) : 0;

  app.post.render(dt);
  app.hud.update(dt, hudState());

  // FPS
  fpsAcc += dt; fpsCount++; fpsTimer += dt;
  if (fpsTimer > 0.5) {
    $('#fps').textContent = Math.round(fpsCount / fpsAcc) + ' FPS';
    fpsAcc = 0; fpsCount = 0; fpsTimer = 0;
  }
}

function hudState() {
  const v = app.player?.vehicle;
  const others = [];
  for (const [id, r] of app.remotes) {
    if (!r.car) continue;
    others.push({ x: r.car.root.position.x, z: r.car.root.position.z, color: '#ff9a3c' });
  }
  return {
    rpm: v ? v.rpm : 0,
    redline: v ? v.spec.redline : 7600,
    speed: v ? v.speedKmh : 0,
    maxSpeed: v ? Math.max(200, v.spec.redline * 0.06) : 300,
    gear: v ? v.gear : 1,
    boost: v ? clamp((v.throttle * 0.9 + v.rpm / 9000 * 0.6) * (v.spec.id === 'fr86' ? 0 : 1), -1, 1.6) : 0,
    temp: v ? 78 + clamp(v.rpm / 8000, 0, 1) * 22 : 80,
    time: app.raceTime,
    best: app.best,
    driftScore: v ? v.driftScore : 0,
    driftCombo: v ? v.driftCombo : 1,
    isDrifting: v ? v.isDrifting : false,
    x: v?.x, z: v?.z, heading: v?.heading,
    others,
    position: app.mode === 'race' && app.remotes.size > 0 ? positionText() : '',
  };
}

function positionText() {
  const v = app.player.vehicle;
  const myS = v.trackIndex;
  let ahead = 0;
  for (const [id, r] of app.remotes) {
    if (!r.car) continue;
    const idx = app.lookup.nearest(r.car.root.position.x, r.car.root.position.z).i;
    if (idx > myS) ahead++;
  }
  return `第 ${ahead + 1} / ${app.remotes.size + 1}`;
}

/* ---------------- 每幀賽事更新 ---------------- */
function updateRace(dt) {
  const v = app.player.vehicle;

  if (app.mode === 'countdown') {
    app.countdown -= dt;
    const n = Math.ceil(app.countdown - 0.2);
    if (n !== app._lastCount && n >= 0) {
      app._lastCount = n;
      if (n === 0) beginGo();
      else {
        app.hud.showCenter(String(n), '');
        app.audio.beep(520, 0.12, 0.22);
      }
    }
    pollInput(dt);
    input.throttle = 0; input.brake = 0; input.handbrake = 0;
    v.step(1 / 120, input, app.track);
  } else if (app.mode === 'race') {
    app.raceTime += dt;
    pollInput(dt);
    physicsStep(dt);
    updateFx(dt);
    if (v.trackIndex >= app.track.count - 10) finishRace();
    sendState();
  } else if (app.mode === 'finish') {
    input.throttle = 0; input.brake = 0.3; input.steer = 0;
    physicsStep(dt);
    updateFx(dt);
  }

  syncPlayerMesh(dt);
  updateRemotes(dt);
}

/* ---------------- 固定步長物理 ---------------- */
// 物理絕不能直接吃渲染幀間隔：60fps 和 144fps 的手感會完全不一樣，
// 掉幀時還會一步跳過整個彎。用累加器把所有物理鎖在 1/120 秒。
const PHYS_DT = 1 / 120;
const PHYS_MAX_STEPS = 8;   // 最多補 8 步（約 66ms），防止卡頓時死亡螺旋
let physAcc = 0;

function physicsStep(dt) {
  physAcc += dt;
  let n = 0;
  while (physAcc >= PHYS_DT && n < PHYS_MAX_STEPS) {
    app.player.vehicle.step(PHYS_DT, input, app.track);
    physAcc -= PHYS_DT;
    n++;
  }
  if (n >= PHYS_MAX_STEPS) physAcc = 0;   // 落後太多就丟掉，別越積越多
}

/** 大燈只在比賽中打開；選單／車庫保持熄燈，讓車漆吃展示光 */
function updateCarLights(car) {
  if (!car.headlightSpots) return;
  const on = app.mode === 'race' || app.mode === 'countdown' || app.mode === 'finish';
  const base = car.headlightBase || 380;
  for (const s of car.headlightSpots) s.intensity = on ? base : 0;
}

function syncPlayerMesh(dt) {
  const { car, vehicle: v } = app.player;
  const root = car.root;
  // 側傾角已壓在 4° 以內，輪胎最多只會陷進路面約 3cm —— 比浮空自然得多
  root.position.set(v.x, v.y, v.z);
  const e = new THREE.Euler(v.pitchAngle, v.heading, v.rollAngle, 'YXZ');
  root.quaternion.setFromEuler(e);

  // 輪胎：一律繞「檢測出來的輪軸」轉，不是硬轉 rotation.x。
  // FC 是 Z-up 匯出的，輪軸不在世界 X 上，硬轉會變成陀螺自轉。
  const spinDelta = (v.u / (v.spec.wheelRadius || 0.32)) * dt;
  const steerVis = v.steer * 0.9;
  const _ax = new THREE.Vector3();
  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i];
    if (w.spin) {
      const ax = w.axle || _ax.set(1, 0, 0);
      w.spin.rotateOnAxis(ax, -spinDelta);
    }
    if (w.steer) w.steer.rotation.y = steerVis;
  }

  // 煞車燈
  const braking = v.brake > 0.15 || v.handbrake > 0.2;
  for (const m of car.brakeMeshes) {
    if (m.material) m.material.emissiveIntensity = braking ? 4.2 : 0.55;
  }
  if (car.tailGlow) {
    car.tailGlow.children.forEach((s) => {
      s.material.opacity = braking ? 0.95 : 0.45;
      s.scale.setScalar(braking ? 0.85 : 0.55);
    });
  }

  // 車燈
  updateCarLights(car);

  // 影子跟隨
  const m = app.sunLight;
  m.position.set(v.x - 90, v.y + 130, v.z - 150);
  m.target.position.set(v.x, v.y, v.z);
  m.target.updateMatrixWorld();
}

function updateFx(dt) {
  const v = app.player.vehicle;
  const car = app.player.car;
  const speed = v.speedMs;
  const slip = Math.abs(v.driftAngle);

  // 煙
  if (v.isDrifting && speed > 6) {
    const rate = Math.min(4, slip * 10);
    for (let i = 0; i < rate; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const wx = v.x + Math.cos(v.heading) * (v.spec.track / 2) * side - Math.sin(v.heading) * 1.4;
      const wz = v.z - Math.sin(v.heading) * (v.spec.track / 2) * side - Math.cos(v.heading) * 1.4;
      app.smoke.spawn(
        wx, v.y + 0.18, wz,
        (Math.random() - 0.5) * 1.6 - Math.sin(v.heading) * 2,
        0.6 + Math.random() * 0.8,
        (Math.random() - 0.5) * 1.6 - Math.cos(v.heading) * 2,
        0.55 + Math.random() * 0.5,
        1.1 + Math.random() * 0.7
      );
    }
  }
  // 撞牆火花
  if (v.wallHit > 0.05) {
    const side = v.lastWallSide;
    const wx = v.x + Math.cos(v.heading) * 1.2 * side;
    const wz = v.z - Math.sin(v.heading) * 1.2 * side;
    app.sparks.burst(wx, v.y + 0.5, wz, Math.round(v.wallHit * 8), 5);
    app.shake = Math.max(app.shake, v.wallHit * 0.9);
    app.flash = Math.max(app.flash, v.wallHit * 0.25);
    if (v.wallHit > 0.3) app.audio.impact(v.wallHit);
  }

  // 胎痕
  if (v.isDrifting && speed > 5) {
    for (const side of [-1, 1]) {
      const wx = v.x + Math.cos(v.heading) * (v.spec.track / 2) * side - Math.sin(v.heading) * 1.35;
      const wz = v.z - Math.sin(v.heading) * (v.spec.track / 2) * side - Math.cos(v.heading) * 1.35;
      const key = side < 0 ? 'L' : 'R';
      const prev = app.skidPrev[key];
      if (prev) {
        const d = Math.hypot(wx - prev.x, wz - prev.z);
        if (d > 0.3 && d < 4) app.skids.addSegment(prev.x, prev.y, prev.z, wx, v.y, wz, 0.18, Math.min(1, slip * 2.2));
      }
      app.skidPrev[key] = { x: wx, y: v.y, z: wz };
    }
  } else {
    app.skidPrev.L = null;
    app.skidPrev.R = null;
  }

  app.smoke.update(dt);
  app.sparks.update(dt);
  app.skids.fade(dt);

  // 音效
  app.audio.setEngine(v.rpm, v.throttle, 1, v.spec.drive !== 'FR' || v.spec.id === 'fd');
  app.audio.setTire(slip * 1.4 + (v.handbrake > 0.3 ? 0.5 : 0), speed);
  app.audio.setWind(speed);
}

/* ---------------- 相機 ---------------- */
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camInit = false;

function updateCamera(dt) {
  if (!app.player) return;
  if (app.freezeCam) return;
  const v = app.player.vehicle;
  const cam = app.camera;

  if (app.mode === 'menu' || app.mode === 'garage' || app.mode === 'lobby') {
    updateMenuCamera(dt);
    return;
  }

  const speed = v.speedMs;
  // 追蹤方向：車頭與速度方向混合（漂移時看得到車側）
  let lookHeading = v.heading;
  if (speed > 3) {
    const velHeading = Math.atan2(
      v.u * Math.sin(v.heading) + v.v * Math.cos(v.heading),
      v.u * Math.cos(v.heading) - v.v * Math.sin(v.heading)
    );
    lookHeading = v.heading + angleDiff(v.heading, velHeading) * 0.55;
  }

  let dist = 6.4, height = 2.25, lookAhead = 9, fov = 62;
  if (app.camMode === 1) { dist = 4.6; height = 1.75; lookAhead = 7; fov = 66; }
  if (app.camMode === 2) { dist = 0.1; height = 1.15; lookAhead = 14; fov = 70; }
  if (app.camMode === 3) { dist = 1.2; height = 1.35; lookAhead = 12; fov = 68; }

  dist += clamp(speed / 90, 0, 1) * 1.9;
  height += clamp(speed / 120, 0, 1) * 0.35;
  fov += clamp(speed / 70, 0, 1) * 13;

  const bx = v.x - Math.sin(lookHeading) * dist;
  const bz = v.z - Math.cos(lookHeading) * dist;
  const groundY = app.world.terrain.heightAt(bx, bz);
  const targetY = Math.max(v.y + height, groundY + 1.1);

  camPos.set(bx, targetY, bz);
  if (!camInit) { cam.position.copy(camPos); camInit = true; }

  // 鏡頭跟得太慢也會被解讀成「車很黏」。6 → 9 讓視角幾乎貼著車走。
  const lerpK = app.camMode >= 2 ? 1 : clamp(dt * (9 + speed * 0.16), 0, 1);
  cam.position.lerp(camPos, lerpK);

  // 震動
  if (app.shake > 0.001) {
    cam.position.x += (Math.random() - 0.5) * app.shake * 0.55;
    cam.position.y += (Math.random() - 0.5) * app.shake * 0.4;
    app.shake *= Math.pow(0.02, dt);
  }
  const speedShake = clamp((speed - 30) / 60, 0, 1) * 0.02;
  cam.position.y += (Math.random() - 0.5) * speedShake;

  camLook.set(
    v.x + Math.sin(lookHeading) * lookAhead * 0.5,
    v.y + 1.0,
    v.z + Math.cos(lookHeading) * lookAhead * 0.5
  );
  cam.lookAt(camLook);

  // 車身側傾帶動鏡頭
  cam.rotateZ(-v.rollAngle * 0.35);

  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov += (fov - cam.fov) * clamp(dt * 3, 0, 1);
    cam.updateProjectionMatrix();
  }
}

function updateMenuCamera(dt) {
  if (app.freezeCam) return;
  const cam = app.camera;
  const v = app.player?.vehicle;
  const p0 = app.track.samples[8];
  const cx = v ? v.x : p0.x;
  const cy = v ? v.y : p0.y;
  const cz = v ? v.z : p0.z;

  // 慢速環繞，車放在畫面右側，左邊留給選單
  const t = app.time * 0.13;
  const r = 6.2 + Math.sin(t * 0.7) * 1.3;
  const h = 1.15 + Math.sin(t * 0.9) * 0.5;
  cam.position.set(cx + Math.sin(t) * r, cy + h, cz + Math.cos(t) * r);
  cam.lookAt(cx, cy + 0.72, cz);
  // 相機左移、朝向不變 → 車輛落在畫面右側
  cam.translateX(-2.6);
  if (Math.abs(cam.fov - 46) > 0.05) {
    cam.fov += (46 - cam.fov) * clamp(dt * 2, 0, 1);
    cam.updateProjectionMatrix();
  }
}

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ---------------- 環境（路燈光池、霧） ---------------- */
let lightPool = null;
function updateEnvironment(dt) {
  const v = app.player?.vehicle;
  if (!v) return;

  // 霧隨高度變化
  app.scene.fog.density = 0.0038 + clamp((320 - v.y) / 320, 0, 1) * 0.0016;

  // 路燈光池（跟著玩家，只保留最近的幾盞）
  if (!lightPool) { lightPool = createLightPools(app.scene, app.world.lampPositions); app.lightPool = lightPool; }
  updateLightPools(lightPool, v);
}

function createLightPools(scene, lamps) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const tex = (() => {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,225,170,0.85)');
    grd.addColorStop(0.35, 'rgba(255,205,140,0.32)');
    grd.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.85, fog: true,
  });
  const POOL = 16;
  const meshes = [];
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.Mesh(geo, mat.clone());
    m.visible = false;
    m.renderOrder = 2;
    scene.add(m);
    meshes.push(m);
  }
  return { lamps, meshes, tex };
}

function updateLightPools(pool, v) {
  const RANGE = 130;
  const near = [];
  for (const p of pool.lamps) {
    const dx = p.x - v.x, dz = p.z - v.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < RANGE) near.push({ p, d });
  }
  near.sort((a, b) => a.d - b.d);
  for (let i = 0; i < pool.meshes.length; i++) {
    const m = pool.meshes[i];
    const item = near[i];
    if (!item) { m.visible = false; continue; }
    const g = app.world.terrain.heightAt(item.p.x, item.p.z);
    m.position.set(item.p.x, Math.max(g, item.p.y - 7.2) + 0.06, item.p.z);
    const s = 9.0 + (i % 4) * 0.25;
    m.scale.set(s, 1, s);
    m.visible = true;
    // 距離越遠越淡，避免遠景出現突兀的亮斑
    const t = 1 - item.d / RANGE;
    m.material.opacity = 0.30 * t * t;
  }
}

/* ================================================================== */
/*  聯機                                                              */
/* ================================================================== */
function sendState() {
  const now = performance.now();
  if (now - app.lastSend < 50) return;
  app.lastSend = now;
  const v = app.player.vehicle;
  app.net.send({
    t: 'state',
    p: [v.x, v.y, v.z],
    q: v.heading,
    v: v.speedKmh,
    s: v.steer,
    g: v.gear,
    r: v.rpm,
    d: v.driftScore,
  });
}

function updateRemotes(dt) {
  for (const [id, r] of app.remotes) {
    if (!r.car) continue;
    const s = app.net.sample(id);
    if (!s) continue;
    r.car.root.visible = true;
    r.car.root.position.set(s.x, s.y, s.z);
    r.car.root.rotation.y = s.q;
    if (r.cone) r.cone.visible = app.mode === 'race' || app.mode === 'countdown';
  }
}

/* ================================================================== */
/*  UI                                                                */
/* ================================================================== */
function bindUI() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    onAction(act, btn);
  });

  // 車庫列表
  const list = $('#car-list');
  list.innerHTML = '';
  for (const id of CAR_ORDER) {
    const sp = CAR_SPECS[id];
    const el = document.createElement('div');
    el.className = 'car-item' + (id === SETTINGS.carId ? ' active' : '');
    el.dataset.car = id;
    el.innerHTML = `<div><div class="cn">${sp.name}</div><div class="ct">${sp.team}</div></div>
      <div class="cp">${sp.power}PS</div>`;
    el.onclick = () => selectCarInGarage(id);
    list.appendChild(el);
  }
  selectCarInGarage(SETTINGS.carId, false);

  // 設定
  const setSeg = (id, key, cb) => {
    const box = $('#' + id);
    [...box.children].forEach((b) => {
      b.classList.toggle('on', String(SETTINGS[key]) === b.dataset.v || (key === 'bloom' && SETTINGS.bloom && b.dataset.v === '1') || (key === 'bloom' && !SETTINGS.bloom && b.dataset.v === '0'));
      b.onclick = () => {
        [...box.children].forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        cb(b.dataset.v);
      };
    });
  };
  setSeg('set-quality', 'quality', (v) => {
    SETTINGS.quality = v;
    localStorage.setItem('akina_q', v);
    app.post.setQuality(v);
    app.renderer.setPixelRatio(v === 'low' ? 1 : Math.min(window.devicePixelRatio, 1.75));
  });
  setSeg('set-bloom', 'bloom', (v) => {
    SETTINGS.bloom = v === '1';
    localStorage.setItem('akina_bloom', SETTINGS.bloom ? '1' : '0');
    app.post.bloom.enabled = SETTINGS.bloom;
  });

  $('#set-music').value = SETTINGS.music;
  $('#set-sfx').value = SETTINGS.sfx;
  $('#set-sens').value = SETTINGS.sens;
  $('#set-music').oninput = (e) => {
    SETTINGS.music = Number(e.target.value);
    localStorage.setItem('akina_music', SETTINGS.music);
    if (app.audio.musicBus) app.audio.musicBus.gain.value = (SETTINGS.music / 100) * 0.42;
  };
  $('#set-sfx').oninput = (e) => {
    SETTINGS.sfx = Number(e.target.value);
    localStorage.setItem('akina_sfx', SETTINGS.sfx);
    if (app.audio.sfxBus) app.audio.sfxBus.gain.value = SETTINGS.sfx / 100;
  };
  $('#set-sens').oninput = (e) => {
    SETTINGS.sens = Number(e.target.value);
    localStorage.setItem('akina_sens', SETTINGS.sens);
  };

  $('#in-name').value = SETTINGS.name;
  $('#in-name').oninput = (e) => {
    SETTINGS.name = e.target.value || '車手';
    localStorage.setItem('akina_name', SETTINGS.name);
  };

  // 聯機事件
  app.net.on('welcome', (m) => {
    app.myId = m.id;
    $('#net-status').textContent = '已連線 · 延遲 ' + app.net.latency + 'ms';
    $('#net-status').classList.add('ok');
    // 注意：這裡絕不能再回 hello —— 伺服器對 hello 也會回 welcome，
    // 兩邊會互相觸發、以每秒數百則的頻率刷爆頻道，把 20Hz 的狀態快照淹掉。
  });
  app.net.on('rooms', (m) => renderRooms(m.rooms));
  app.net.on('room', (m) => { app.room = m.room; renderRoom(m.room); });
  app.net.on('start', (m) => onNetStart(m));
  app.net.on('leave', () => { });
  app.net.on('close', () => {
    $('#net-status').textContent = '連線中斷';
    $('#net-status').classList.remove('ok');
  });
  app.net.on('chat', (m) => app.hud.showMsg(`${m.name}：${m.msg}`, 2200));
  app.net.on('finish', (m) => {
    if (m.id !== app.myId) app.hud.showMsg(`${m.name} 完成 ${formatTime(m.time)}`, 2200);
  });
  app.net.on('error', (m) => { $('#net-status').textContent = m.msg; });
}

function selectCarInGarage(id, doSwitch = true) {
  const sp = CAR_SPECS[id];
  $$('.car-item').forEach((el) => el.classList.toggle('active', el.dataset.car === id));
  $('#gd-name').textContent = sp.name;
  $('#gd-team').textContent = sp.team;
  $('#gd-desc').textContent = CAR_DESC[id] || '';
  const stats = [
    ['馬力', sp.power, 320, sp.power + ' PS'],
    ['扭力', sp.peakTorque, 420, sp.peakTorque + ' Nm'],
    ['重量', 1700 - sp.mass, 800, sp.mass + ' kg'],
    ['抓地', sp.grip * 100, 120, (sp.grip * 100).toFixed(0)],
    ['驅動', sp.drive === 'AWD' ? 90 : 55, 100, sp.drive],
  ];
  $('#gd-stats').innerHTML = stats.map(([n, v, max, label]) =>
    `<div class="stat"><span>${n}</span><div class="bar2"><i style="width:${clamp(v / max * 100, 6, 100)}%"></i></div><span class="val">${label}</span></div>`
  ).join('');
  if (doSwitch) switchCar(id);
}

async function onAction(act) {
  switch (act) {
    case 'solo':
      if (!app.audio.started) app.audio.init();
      startRace('solo');
      break;
    case 'multi':
      showScreen('lobby');
      app.mode = 'lobby';
      connectNet();
      break;
    case 'garage':
      showScreen('garage');
      app.mode = 'garage';
      break;
    case 'help':
      showScreen('help');
      break;
    case 'settings':
      showScreen('settings');
      break;
    case 'back':
      if (app.mode === 'lobby') { app.net.send({ t: 'leave' }); app.room = null; }
      showScreen('menu');
      app.mode = 'menu';
      break;
    case 'confirm-car':
      showScreen('menu');
      app.mode = 'menu';
      break;
    case 'resume':
      togglePause();
      break;
    case 'restart':
      showScreen(null);
      startRace(app.raceMode || 'solo');
      break;
    case 'quit':
      showScreen('menu');
      app.mode = 'menu';
      app.hud.setVisible(false);
      app.net.send({ t: 'leave' });
      break;
    case 'create-room': {
      app.net.send({ t: 'hello', name: SETTINGS.name, carId: SETTINGS.carId });
      app.net.send({ t: 'create', name: $('#in-room').value || '霧見山夜戰' });
      break;
    }
    case 'refresh-rooms':
      app.net.send({ t: 'list' });
      break;
    case 'ready': {
      const me = app.room?.players.find((p) => p.id === app.myId);
      app.net.send({ t: 'ready', v: !me?.ready });
      break;
    }
    case 'start-race':
      app.net.send({ t: 'start' });
      break;
  }
}

async function connectNet() {
  if (app.net.connected) {
    app.net.send({ t: 'hello', name: SETTINGS.name, carId: SETTINGS.carId });
    return;
  }
  $('#net-status').textContent = '連線中…';
  try {
    await app.net.connect();
    // 握手：告訴伺服器自己的名字與車輛（只送這一次，之後由伺服器回 welcome）
    app.net.send({ t: 'hello', name: SETTINGS.name, carId: SETTINGS.carId });
    $('#net-status').textContent = '已連線';
    $('#net-status').classList.add('ok');
  } catch (e) {
    $('#net-status').textContent = '無法連線（請確認伺服器已啟動）';
    $('#net-status').classList.remove('ok');
  }
}

function renderRooms(rooms) {
  const box = $('#room-list');
  if (!rooms || !rooms.length) {
    box.innerHTML = '<div class="empty">尚無房間，建立一個吧</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of rooms) {
    const el = document.createElement('div');
    el.className = 'room-row';
    el.innerHTML = `<span>${r.name}</span><span class="cnt">${r.count}/${r.max}</span>`;
    el.onclick = () => app.net.send({ t: 'join', id: r.id });
    box.appendChild(el);
  }
}

function renderRoom(room) {
  const isHost = room.host === app.myId;
  $('#btn-ready').style.display = isHost ? 'none' : 'inline-block';
  $('#btn-start').style.display = isHost ? 'inline-block' : 'none';
  const me = room.players.find((p) => p.id === app.myId);
  $('#btn-ready').textContent = me?.ready ? '取消準備' : '準備';
  $('#btn-start').textContent = room.players.every((p) => p.ready || p.id === room.host) ? '開始比賽' : '等待準備';

  $('#room-detail').innerHTML =
    `<div style="color:#fff;font-weight:700;margin-bottom:6px">房間 ${room.id} · ${room.name}</div>` +
    room.players.map((p) => {
      const sp = CAR_SPECS[p.carId] || CAR_SPECS.fr86;
      return `<div class="pl"><b>${p.name}${p.id === room.host ? ' 👑' : ''}</b>
        <span>${sp.name} · ${p.ready ? '<span style="color:#6bff9a">已準備</span>' : '等待中'}</span></div>`;
    }).join('');
}

/**
 * 依房內排位算出起跑格：奇偶交錯左右、每兩台往後退一格，
 * 避免所有人疊在同一個點上出發。
 */
function gridSlot(index) {
  const lateral = (index % 2 === 0 ? -1 : 1) * 1.55;
  const back = Math.floor(index / 2) * 4; // 樣本間距約 2m，一格 = 8m
  return { lateral, back };
}

function resetToGrid(index) {
  const track = app.track;
  const S = track.samples;
  const { lateral, back } = gridSlot(index);
  const idx = Math.max(2, Math.min(S.length - 1, 8 - back));
  const p = S[idx];
  const head = Math.atan2(p.tx, p.tz);
  // 右向量 n = (tz, -tx)，lateral 往左為負
  const x = p.x + p.nx * lateral;
  const z = p.z + p.nz * lateral;
  const v = app.player.vehicle;
  v.reset(x, z, p.y + lateral * Math.tan(p.bank), head, idx);
  return { idx, lateral };
}

async function onNetStart(m) {
  if (!app.audio.started) app.audio.init();
  showScreen(null);
  app.mode = 'countdown';
  app.countdown = Math.max(0.1, (m.startAt - (Date.now() + app.net.serverOffset)) / 1000);
  app.raceTime = 0;
  app.hud.setVisible(true);
  app.audio.startMusic(Math.floor(Math.random() * 4));

  // 建立遠端車輛
  if (app.room) {
    for (const p of app.room.players) {
      if (p.id === app.myId) continue;
      await ensureRemote(p.id, p.carId, p.name);
    }
    // 自己在房內的排位 → 起跑格
    const order = app.room.players.map((p) => p.id);
    const myIdx = Math.max(0, order.indexOf(app.myId));
    resetToGrid(myIdx);
  } else {
    const p0 = app.track.samples[8];
    app.player.vehicle.reset(p0.x, p0.z, p0.y, Math.atan2(p0.tx, p0.tz), 8);
  }
  app.raceMode = 'multi';
}

/* ================================================================== */
/*  resize                                                            */
/* ================================================================== */
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  app.camera.aspect = w / h;
  app.camera.updateProjectionMatrix();
  app.renderer.setSize(w, h);
  app.post.setSize(w, h);
  app.hud.resize();
}

// 除錯用
window.__app = app;
window.__debug = {
  input,
  startRace,
  switchCar,
  /** 以固定步長推進賽事模擬（繞過 rAF，方便自動化測試） */
  step(n = 60, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      app.time += dt;
      if (app.mode === 'countdown' || app.mode === 'race' || app.mode === 'finish') updateRace(dt);
    }
  },
  setMode(m) { app.mode = m; },
};
