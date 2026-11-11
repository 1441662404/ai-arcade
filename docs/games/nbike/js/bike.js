/* =============================================================================
 * Nbike · js/bike.js
 * 写实风单车 + 车手（程序化构建，Three.js）
 *
 * 尺寸按真实公路车（700c / 单盘 50T / 11 速飞轮 11-32T / 曲柄 172.5mm）：
 *   轮外径 0.68m · 轴距 0.99m · 五通高 0.272m
 *   牙盘节圆半径 = 50 × 12.7 / 2π ≈ 101mm（真实链条节距 12.7mm）
 *
 * 旋转手性约定（本文件全部遵守，改动请先看这段）：
 *   Object3D.rotation.x = θ 会把局部 (0, L, 0) 映射到 (0, L·cosθ, L·sinθ)
 *   → 骨骼沿 +Y 生长时，θ = atan2(Δz, Δy) 即指向目标
 *   → 车轮前进方向 +Z，故 wheel.rotation.x 必须为 +ωt（不能取负）
 *
 * 动画架构：肢体做成【运动链】，每帧用两骨 IK 解关节角
 *   rider → hip(绕X摆动) → knee(相对大腿) → ankle → shoe
 *   踝关节锁在踏板位置；曲柄角来自服务端权威状态
 *   → "踏频快慢"是物理结果，不是预设动画
 * ========================================================================== */
import * as THREE from '../lib/three.module.js';
/* 共享常量：用于按真实发力曲线驱动腿部动作（推压/提拉表现） */
const NB = window.NB || {};
const footGainOf = (NB.C && NB.C.footGain) ? NB.C.footGain : (() => 0);

/* ---------------------------------------------------------------------------
 * 几何常量（米；局部坐标系：+Z 车头，+X 车右，Y 上，原点 = 后轮接地点）
 *
 * ★ 全部按真实 56 码公路车标定（Stack 570 / Reach 395 / 头管角 73.5° / 座管角 73°）：
 *     BB(五通)      y=0.272  z=0.395   ← 后轴到五通水平距离 0.395
 *     头管上端       y=0.845  z=0.790   ← BB + Stack 0.570 / Reach 0.395
 *     头管下端       y=0.714  z=0.831   ← 头管长 0.13，向下前倾
 *     前叉冠         y=0.700  z=0.836
 *     弯把中心       y=0.905  z=1.005   ← 把立长 0.10
 *     手变握点       y=0.892  z=1.062
 *     坐垫面         y=0.930  z=0.228
 *     座管顶         y=0.769  z=0.243   ← 座管长 0.52
 *     髋关节         y=1.000  z=0.195   ← 坐垫面上方 ~0.07（坐骨压缩）
 *   有效上管长 = 0.790 - 0.243 = 0.547 ✓（真实约 0.565）
 * ------------------------------------------------------------------------ */
export const BIKE_GEO = {
  wheelR: 0.34,
  tireTube: 0.027,
  rimR: 0.300,
  axleZ: { rear: 0.0, front: 0.99 },
  bb: { y: 0.272, z: 0.395 },
  crankLen: 0.1725,
  chainringR: 0.101,
  cassetteTeeth: [11, 12, 13, 14, 15, 17, 19, 21, 24, 28, 32],
  cassetteX0: -0.007, cassetteDX: 0.0042, cassetteX: 0.024,
  seat: { y: 0.936, z: 0.232 },
  seatTop: { y: 0.769, z: 0.243 },
  headTop: { y: 0.845, z: 0.790 },
  headBottom: { y: 0.714, z: 0.831 },
  crown: { y: 0.700, z: 0.836 },
  bar: { y: 0.868, z: 1.005 },
  hood: { y: 0.855, z: 1.062 },
  pedalX: 0.068,
  chainX: 0.020
};
BIKE_GEO.cassetteRadii = BIKE_GEO.cassetteTeeth.map(t => t * 0.0127 / (2 * Math.PI));

const TUBE_R = {
  down: 0.0195, top: 0.0145, seat: 0.0155, head: 0.021,
  chain: 0.0115, seatstay: 0.0088, seatpost: 0.0135
};

/* 车手比例（身高约 1.80m · 竞速姿势：背角与水平 25.3°）
 * ★ 已用 tools/check-rider.js 验证：
 *   腿：曲柄全周髋踝距 0.531~0.867 < 腿长 0.904，膝内角 72~147°（真实范围）
 *   臂：肩到握点 0.515 < 臂长 0.570，肘角 129°
 *   姿：坐垫落差 0.068m · 髋在五通上方 0.734m · 头部前倾 17.8°
 */
export const RIDER = {
  hipH: 1.006,
  hipZ: 0.226,
  hipWidth: 0.216,
  torsoLean: 1.13,        // rad ≈ 64.7°
  torsoLen: 0.545,        // 髋 → 肩
  thigh: 0.462,
  shin: 0.442,
  upperArm: 0.298,
  foreArm: 0.272,
  ankleLift: 0.055,
  shoulderHalfW: 0.152,
  handOffset: { y: 0, z: 0 },   // 手正好握在手变头上
  headTilt: -0.82               // 相对躯干抬头
};

/* 骨骼网格半径（capsule 总长 = 骨长，使骨骼首尾正好落在关节上） */
const BONE_R = { thigh: 0.084, shin: 0.056, upperArm: 0.048, foreArm: 0.042 };

/* ---------------------------------------------------------------------------
 * 几何缓存（多车手同屏共用）
 * ------------------------------------------------------------------------ */
const geoCache = new Map();
function cg(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = build(); geoCache.set(key, g); }
  return g;
}

function tubeGeo(key, a, b, radius, radSeg = 10) {
  const k = 'T|' + key + '|' + radius + '|' + radSeg;
  let g = geoCache.get(k);
  if (!g) {
    const c = new THREE.LineCurve3(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2]));
    g = new THREE.TubeGeometry(c, 1, radius, radSeg, false);
    geoCache.set(k, g);
  }
  return g;
}

function curveGeo(key, pts, radius, radSeg = 10, seg = 16) {
  const k = 'C|' + key + '|' + radius + '|' + seg + '|' + radSeg;
  let g = geoCache.get(k);
  if (!g) {
    const c = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    g = new THREE.TubeGeometry(c, seg, radius, radSeg, false);
    geoCache.set(k, g);
  }
  return g;
}

/* ---------------------------------------------------------------------------
 * 材质
 * ------------------------------------------------------------------------ */
export function makeMaterials(frameColor = 0xd42a2a, jerseyColor = 0x1f77d4, helmetColor = 0xf7f8fa) {
  const M = THREE.MeshStandardMaterial;
  return {
    frame: new M({ color: frameColor, metalness: 0.40, roughness: 0.26 }),
    carbon: new M({ color: 0x191b20, metalness: 0.40, roughness: 0.45 }),
    tire: new M({ color: 0x131316, roughness: 0.95, metalness: 0.02 }),
    rim: new M({ color: 0xb9bec7, metalness: 0.88, roughness: 0.26 }),
    chrome: new M({ color: 0xd8dce2, metalness: 0.94, roughness: 0.15 }),
    steel: new M({ color: 0x4a4f57, metalness: 0.86, roughness: 0.36 }),
    saddle: new M({ color: 0x0e0e12, roughness: 0.68, metalness: 0.03 }),
    bar: new M({ color: 0x15161a, metalness: 0.28, roughness: 0.62 }),
    skin: new M({ color: 0xdda98a, roughness: 0.55, metalness: 0.0 }),
    /* 骑行服：莱卡面料有一点方向性光泽（sheen 感），比纯无光的塑料布更有质感。
     * roughness 0.62 + 极低 metalness：既保留布料哑光，又能吃到侧面高光。 */
    jersey: new M({ color: jerseyColor, roughness: 0.62, metalness: 0.06 }),
    jerseyTrim: new M({ color: 0xf2f4f7, roughness: 0.60, metalness: 0.06 }),
    shorts: new M({ color: 0x13141a, roughness: 0.66, metalness: 0.08 }),
    shoe: new M({ color: 0xf5f6f8, roughness: 0.38, metalness: 0.14 }),
    helmet: new M({ color: helmetColor, roughness: 0.24, metalness: 0.18 }),
    glass: new M({ color: 0x18202c, metalness: 0.55, roughness: 0.08, transparent: true, opacity: 0.88 }),
    dark: new M({ color: 0x24262c, roughness: 0.82 })
  };
}

/* ---------------------------------------------------------------------------
 * 车轮
 * ------------------------------------------------------------------------ */
function buildWheel(mats, spokeCount = 24) {
  const g = new THREE.Group();
  const R = BIKE_GEO;

  const tire = new THREE.Mesh(cg('tire', () =>
    new THREE.TorusGeometry(R.rimR + R.tireTube * 0.42, R.tireTube, 10, 44)), mats.tire);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);

  const rim = new THREE.Mesh(cg('rim', () =>
    new THREE.TorusGeometry(R.rimR - 0.004, 0.018, 4, 44)), mats.rim);
  rim.rotation.y = Math.PI / 2;
  g.add(rim);

  const hub = new THREE.Mesh(cg('hub', () =>
    new THREE.CylinderGeometry(0.024, 0.024, 0.098, 14)), mats.chrome);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);

  const hubEnd = new THREE.Mesh(cg('hubEnd', () =>
    new THREE.CylinderGeometry(0.013, 0.013, 0.110, 10)), mats.steel);
  hubEnd.rotation.z = Math.PI / 2;
  g.add(hubEnd);

  const spokeLen = R.rimR - 0.028;
  const spokes = new THREE.InstancedMesh(cg('spoke', () => {
    const c = new THREE.CylinderGeometry(0.00085, 0.00085, spokeLen, 4);
    c.translate(0, 0.028 + spokeLen / 2, 0);
    return c;
  }), mats.rim, spokeCount);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i < spokeCount; i++) {
      e.set((i / spokeCount) * Math.PI * 2 + (i % 2 ? 0.30 : -0.30), 0, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(0, 0, 0), q, new THREE.Vector3(1, 1, 1));
      spokes.setMatrixAt(i, m);
    }
  }
  g.add(spokes);

  const valve = new THREE.Mesh(cg('valve', () =>
    new THREE.CylinderGeometry(0.004, 0.004, 0.038, 6)), mats.steel);
  valve.position.y = R.rimR - 0.014;
  g.add(valve);

  return g;
}

/* ---------------------------------------------------------------------------
 * 传动系统：牙盘 + 曲柄 + 踏板 + 飞轮 + 后拨 + 链条
 * ------------------------------------------------------------------------ */
function buildDrivetrain(mats) {
  const g = new THREE.Group();
  const R = BIKE_GEO;

  /* ---- 牙盘 50T（YZ 平面内的齿环，绕 X 旋转） ---- */
  const ring = new THREE.Group();
  ring.add(new THREE.Mesh(cg('ringBody', () =>
    new THREE.TorusGeometry(R.chainringR - 0.007, 0.0058, 6, 56)), mats.chrome));
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2;
    const arm = new THREE.Mesh(cg('ringArm', () =>
      new THREE.BoxGeometry(0.009, R.chainringR * 0.64, 0.013)), mats.chrome);
    arm.position.set(0, Math.cos(a) * R.chainringR * 0.33, Math.sin(a) * R.chainringR * 0.33);
    arm.rotation.x = -a;
    ring.add(arm);
  }
  const teeth = new THREE.InstancedMesh(cg('tooth', () =>
    new THREE.BoxGeometry(0.0042, 0.010, 0.0065)), mats.chrome, 50);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i < 50; i++) {
      const a = i / 50 * Math.PI * 2;
      e.set(a, 0, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(0,
        Math.cos(a) * (R.chainringR + 0.005),
        Math.sin(a) * (R.chainringR + 0.005)), q, new THREE.Vector3(1, 1, 1));
      teeth.setMatrixAt(i, m);
    }
  }
  ring.add(teeth);
  ring.position.set(R.pedalX - 0.016, R.bb.y, R.bb.z);
  g.add(ring);

  /* ---- 曲柄 + 踏板 ---- */
  const cranks = [], pedals = [];
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? 1 : -1;
    const crank = new THREE.Group();
    crank.position.set(sx * R.pedalX, R.bb.y, R.bb.z);

    const arm = new THREE.Mesh(cg('crankArm', () =>
      new THREE.BoxGeometry(0.014, R.crankLen, 0.026)), mats.carbon);
    arm.position.y = R.crankLen / 2;
    arm.castShadow = true;
    crank.add(arm);

    // 踏板挂在曲柄末端，用一个反向旋转的 holder 保持水平
    const holder = new THREE.Group();
    holder.position.y = R.crankLen;
    crank.add(holder);

    const body = new THREE.Mesh(cg('pedalBody', () =>
      new THREE.BoxGeometry(0.086, 0.014, 0.058)), mats.steel);
    body.position.x = sx * 0.050;
    holder.add(body);
    const axle = new THREE.Mesh(cg('pedalAxle', () =>
      new THREE.CylinderGeometry(0.007, 0.007, 0.048, 8)), mats.chrome);
    axle.rotation.z = Math.PI / 2;
    axle.position.x = sx * 0.030;
    holder.add(axle);

    g.add(crank);
    cranks.push(crank);
    pedals.push({ crank, holder, sx, offset: side === 1 ? Math.PI : 0 });
  }
  g.userData.cranks = cranks;
  g.userData.pedals = pedals;
  g.userData.ring = ring;

  /* ---- 飞轮 11 速（沿 X 排列，11T 最靠外侧） ---- */
  const cassette = new THREE.Group();
  const cogs = [];
  for (let i = 0; i < R.cassetteRadii.length; i++) {
    const r = R.cassetteRadii[i];
    const cog = new THREE.Mesh(cg('cog' + i, () =>
      new THREE.CylinderGeometry(r, r, 0.0034, 26)), mats.steel);
    cog.rotation.z = Math.PI / 2;
    cog.position.x = R.cassetteX0 + i * R.cassetteDX;
    cassette.add(cog);
    cogs.push(cog);
  }
  cassette.position.set(R.cassetteX, R.wheelR, 0.012);
  g.add(cassette);
  g.userData.cassette = cassette;
  g.userData.cogs = cogs;

  /* ---- 后拨 ---- */
  const rd = new THREE.Group();
  rd.add(new THREE.Mesh(cg('rdBody', () =>
    new THREE.BoxGeometry(0.028, 0.058, 0.020)), mats.steel));
  const rdCage = new THREE.Mesh(cg('rdCage', () =>
    new THREE.BoxGeometry(0.010, 0.082, 0.030)), mats.steel);
  rdCage.position.set(0.008, -0.060, 0.004);
  rd.add(rdCage);
  for (const y of [-0.030, -0.092]) {
    const j = new THREE.Mesh(cg('jockey', () =>
      new THREE.CylinderGeometry(0.011, 0.011, 0.008, 10)), mats.chrome);
    j.rotation.z = Math.PI / 2;
    j.position.set(0.012, y, 0);
    rd.add(j);
  }
  rd.position.set(R.cassetteX + 0.032, R.wheelR - 0.060, 0.014);
  g.add(rd);
  g.userData.rd = rd;

  /* ---- 链条（上/下两段，按当前齿比实时贴合） ---- */
  const chainTop = new THREE.Mesh(cg('chainSeg', () =>
    new THREE.BoxGeometry(0.007, 0.007, 1)), mats.steel);
  const chainBot = chainTop.clone();
  g.add(chainTop, chainBot);
  g.userData.chain = { top: chainTop, bot: chainBot };

  return g;
}

/* ---------------------------------------------------------------------------
 * 车架
 * ------------------------------------------------------------------------ */
function buildFrame(mats) {
  const g = new THREE.Group();
  const R = BIKE_GEO;

  const bb = [0, R.bb.y, R.bb.z];
  const st = [0, R.seatTop.y, R.seatTop.z];
  const ht = [0, R.headTop.y, R.headTop.z];
  const hb = [0, R.headBottom.y, R.headBottom.z];
  const cr = [0, R.crown.y, R.crown.z];

  const addTube = (key, a, b, r, seg) => {
    const mesh = new THREE.Mesh(tubeGeo(key, a, b, r, seg), mats.frame);
    mesh.castShadow = true;
    g.add(mesh);
  };

  // 主三角（下管从五通到头管下端，上管从座管顶到头管上端）
  addTube('down', bb, hb, TUBE_R.down, 16);
  addTube('seat', bb, st, TUBE_R.seat, 14);
  addTube('top', st, ht, TUBE_R.top, 14);
  addTube('head', [0, hb[1] - 0.012, hb[2] - 0.010], [0, ht[1] + 0.032, ht[2] + 0.010], TUBE_R.head, 16);
  addTube('seatpost', st, [0, R.seat.y + 0.006, R.seat.z - 0.012], TUBE_R.seatpost, 12);
  addTube('seatTubeUp', [0, st[1] - 0.34, st[2] + 0.02], st, TUBE_R.seat, 14);

  // 五通壳
  const bbShell = new THREE.Mesh(cg('bbShell', () =>
    new THREE.CylinderGeometry(0.032, 0.032, 0.092, 18)), mats.frame);
  bbShell.rotation.z = Math.PI / 2;
  bbShell.position.set(0, R.bb.y, R.bb.z);
  g.add(bbShell);

  // 座管夹
  const clamp = new THREE.Mesh(cg('clamp', () =>
    new THREE.TorusGeometry(0.017, 0.005, 5, 12)), mats.steel);
  clamp.position.set(0, st[1] + 0.014, st[2] - 0.003);
  clamp.rotation.x = Math.PI / 2;
  g.add(clamp);

  for (const s of [1, -1]) {
    // 后下叉 / 后上叉
    addTube('chain' + s, [s * 0.045, R.bb.y, R.bb.z], [s * 0.058, R.wheelR, 0.014], TUBE_R.chain, 10);
    addTube('ss' + s, [s * 0.040, st[1] - 0.048, st[2] - 0.014],
      [s * 0.054, R.wheelR, 0.014], TUBE_R.seatstay, 9);

    // 后爪
    const drop = new THREE.Mesh(cg('dropout', () =>
      new THREE.BoxGeometry(0.009, 0.052, 0.030)), mats.frame);
    drop.position.set(s * 0.058, R.wheelR, 0.012);
    g.add(drop);

    // 前叉：从头管下端起，沿 73.5° 头管角的延伸方向向前下
    const fx0 = s * 0.049, fy0 = cr[1] + 0.020, fz0 = cr[2] - 0.006;
    const fx1 = s * 0.049, fy1 = R.wheelR, fz1 = R.axleZ.front + 0.008;
    const dy = fy1 - fy0, dz = fz1 - fz0;
    const len = Math.hypot(dy, dz);
    const blade = new THREE.Mesh(cg('forkBlade', () =>
      new THREE.CylinderGeometry(0.0115, 0.0060, 1, 12)), mats.carbon);
    blade.scale.set(1, len, 1);
    blade.position.set(fx0, (fy0 + fy1) / 2, (fz0 + fz1) / 2);
    blade.rotation.x = -Math.atan2(dz, dy);
    blade.castShadow = true;
    g.add(blade);

    const fdrop = new THREE.Mesh(cg('forkDrop', () =>
      new THREE.BoxGeometry(0.010, 0.030, 0.020)), mats.carbon);
    fdrop.position.set(s * 0.049, R.wheelR, R.axleZ.front + 0.006);
    g.add(fdrop);
  }

  // 前叉冠
  const crown = new THREE.Mesh(cg('crown', () =>
    new THREE.BoxGeometry(0.100, 0.032, 0.030)), mats.carbon);
  crown.position.set(0, R.crown.y + 0.006, R.crown.z - 0.004);
  g.add(crown);

  // 坐垫
  const saddle = new THREE.Group();
  const sBody = new THREE.Mesh(cg('saddleBody', () =>
    new THREE.CapsuleGeometry(0.046, 0.150, 4, 12)), mats.saddle);
  sBody.rotation.x = Math.PI / 2;
  sBody.scale.set(1.44, 1, 0.40);
  saddle.add(sBody);
  const sNose = new THREE.Mesh(cg('saddleNose', () =>
    new THREE.CapsuleGeometry(0.023, 0.095, 4, 10)), mats.saddle);
  sNose.rotation.x = Math.PI / 2;
  sNose.scale.set(1, 1, 0.40);
  sNose.position.set(0, 0.001, 0.132);
  saddle.add(sNose);
  const rail = new THREE.Mesh(cg('saddleRail', () =>
    new THREE.BoxGeometry(0.072, 0.008, 0.010)), mats.chrome);
  rail.position.set(0, -0.024, -0.022);
  saddle.add(rail);
  saddle.position.set(0, R.seat.y, R.seat.z);
  g.add(saddle);

  // 水壶架 + 水壶（下管上）
  const cage = new THREE.Mesh(cg('cage', () =>
    new THREE.TorusGeometry(0.036, 0.0055, 5, 16)), mats.steel);
  cage.position.set(0, 0.455, 0.60);
  cage.rotation.y = Math.PI / 2;
  cage.rotation.x = 0.50;
  g.add(cage);
  const bottle = new THREE.Mesh(cg('bottle', () =>
    new THREE.CylinderGeometry(0.032, 0.033, 0.185, 14)), mats.jersey);
  bottle.position.set(0, 0.450, 0.608);
  bottle.rotation.x = 0.50;
  g.add(bottle);

  // 码表（把立前）
  const garmin = new THREE.Mesh(cg('garmin', () =>
    new THREE.BoxGeometry(0.040, 0.016, 0.058)), mats.steel);
  garmin.position.set(0.020, R.bar.y + 0.012, R.bar.z + 0.048);
  garmin.rotation.x = -0.34;
  g.add(garmin);
  const gScreen = new THREE.Mesh(cg('garminScreen', () =>
    new THREE.BoxGeometry(0.031, 0.002, 0.044)), new THREE.MeshBasicMaterial({ color: 0x2c5068 }));
  gScreen.position.set(0.020, R.bar.y + 0.021, R.bar.z + 0.048);
  gScreen.rotation.x = -0.34;
  g.add(gScreen);

  return g;
}

/* ---------------------------------------------------------------------------
 * 弯把
 * ------------------------------------------------------------------------ */
function buildHandlebar(mats) {
  const g = new THREE.Group();
  const R = BIKE_GEO;

  // 把立：从头管上端伸出
  const stem = new THREE.Mesh(cg('stem', () =>
    new THREE.BoxGeometry(0.042, 0.030, 0.215)), mats.carbon);
  stem.position.set(0, R.bar.y + 0.012, (R.headTop.z + R.bar.z) / 2 + 0.01);
  stem.rotation.x = -0.10;
  g.add(stem);

  const top = new THREE.Mesh(cg('barTop', () =>
    new THREE.CylinderGeometry(0.0128, 0.0128, 0.400, 14)), mats.bar);
  top.rotation.z = Math.PI / 2;
  top.position.set(0, R.bar.y, R.bar.z);
  top.castShadow = true;
  g.add(top);

  for (const s of [1, -1]) {
    // 弯钩（下弯把）
    const hookPts = [
      [s * 0.198, R.bar.y, R.bar.z],
      [s * 0.199, R.bar.y - 0.036, R.bar.z + 0.036],
      [s * 0.197, R.bar.y - 0.088, R.bar.z + 0.028],
      [s * 0.195, R.bar.y - 0.120, R.bar.z - 0.030],
      [s * 0.193, R.bar.y - 0.108, R.bar.z - 0.082]
    ];
    const hook = new THREE.Mesh(curveGeo('hook' + s, hookPts, 0.0128, 10, 18), mats.bar);
    hook.castShadow = true;
    g.add(hook);

    // 手变头（握点位置 = R.hood）
    const hood = new THREE.Mesh(cg('hood', () =>
      new THREE.CapsuleGeometry(0.0178, 0.078, 4, 12)), mats.bar);
    hood.rotation.x = Math.PI / 2 - 0.24;
    hood.position.set(s * 0.198, R.hood.y + 0.004, R.hood.z - 0.028);
    g.add(hood);

    const lever = new THREE.Mesh(cg('lever', () =>
      new THREE.BoxGeometry(0.011, 0.074, 0.014)), mats.chrome);
    lever.position.set(s * 0.198, R.hood.y - 0.044, R.hood.z - 0.014);
    lever.rotation.x = 0.18;
    g.add(lever);

    // 把带
    const tape = new THREE.Mesh(cg('tape', () =>
      new THREE.CylinderGeometry(0.0158, 0.0158, 0.316, 12)), mats.jersey);
    tape.rotation.z = Math.PI / 2;
    tape.position.set(s * 0.112, R.bar.y, R.bar.z);
    g.add(tape);
  }

  return g;
}

/* ===========================================================================
 * 两骨 IK：在 (z, y) 平面内，从 A 到 B，求中间关节
 *   forward = true  → 中间关节偏向 +Z（膝盖朝前）
 *   forward = false → 中间关节偏向 -Z（肘部朝后）
 * 旋转约定：θ = atan2(Δz, Δy) 使沿 +Y 的骨骼指向 (Δy, Δz)
 * ========================================================================= */
export function solveMid(az, ay, bz, by, l1, l2, forward) {
  let dz = bz - az, dy = by - ay;
  let d = Math.hypot(dz, dy);
  d = Math.min(d, (l1 + l2) * 0.9995);
  d = Math.max(d, Math.abs(l1 - l2) + 1e-4);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const uz = dz / d, uy = dy / d;
  const pz = forward ? -uy : uy;
  const py = forward ? uz : -uz;
  return { z: az + uz * a + pz * h, y: ay + uy * a + py * h };
}

/* ===========================================================================
 * 车手
 *   rider
 *     └ torso (绕 X 俯身，位置 = 髋)
 *         ├ 骨盆/腰/胸/肩
 *         ├ head (含头盔/眼镜)
 *         └ armL/armR → shoulder → elbow → hand
 *     └ legL/legR → hip → knee → ankle → shoe
 * ========================================================================= */
function buildRider(mats) {
  const root = new THREE.Group();
  const Rd = RIDER;
  const cosL = Math.cos(Rd.torsoLean), sinL = Math.sin(Rd.torsoLean);

  /* ---------- 躯干 ---------- */
  const torso = new THREE.Group();
  torso.position.set(0, Rd.hipH, Rd.hipZ);
  torso.rotation.x = Rd.torsoLean;

  const pelvis = new THREE.Mesh(cg('pelvis', () =>
    new THREE.CapsuleGeometry(0.108, 0.185, 6, 14)), mats.shorts);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.scale.set(1, 1, 0.80);
  pelvis.position.set(0, 0.012, -0.014);
  torso.add(pelvis);

  const waist = new THREE.Mesh(cg('waist', () =>
    new THREE.CapsuleGeometry(0.126, 0.16, 6, 14)), mats.jersey);
  waist.scale.set(1.0, 1, 0.74);
  waist.position.set(0, 0.19, 0.004);
  torso.add(waist);

  const chest = new THREE.Mesh(cg('chest', () =>
    new THREE.CapsuleGeometry(0.146, 0.15, 6, 14)), mats.jersey);
  chest.scale.set(1.04, 1, 0.76);
  chest.position.set(0, 0.40, 0.002);
  torso.add(chest);

  for (const s of [1, -1]) {
    const sh = new THREE.Mesh(cg('shoulderCap', () =>
      new THREE.SphereGeometry(0.072, 12, 10)), mats.jersey);
    sh.scale.set(1, 0.94, 0.92);
    sh.position.set(s * Rd.shoulderHalfW, Rd.torsoLen - 0.026, 0.008);
    torso.add(sh);
  }

  // 号码布
  const bib = new THREE.Mesh(cg('bib', () =>
    new THREE.BoxGeometry(0.162, 0.135, 0.008)), mats.jerseyTrim);
  bib.position.set(0, 0.295, 0.142);
  bib.rotation.x = 0.42;
  torso.add(bib);
  const bibNum = new THREE.Mesh(cg('bibNum', () =>
    new THREE.BoxGeometry(0.092, 0.050, 0.005)), new THREE.MeshBasicMaterial({ color: 0x111318 }));
  bibNum.position.set(0, 0.295, 0.149);
  bibNum.rotation.x = 0.42;
  torso.add(bibNum);

  root.add(torso);

  /* ---------- 头（torso 的子节点，随俯身一起走） ---------- */
  const head = new THREE.Group();
  head.position.set(0, Rd.torsoLen, 0.006);
  head.rotation.x = Rd.headTilt;      // 相对躯干抬头，净前倾约 18°（目视前方）

  const neck = new THREE.Mesh(cg('neck', () =>
    new THREE.CylinderGeometry(0.053, 0.064, 0.085, 12)), mats.skin);
  neck.position.y = 0.020;
  head.add(neck);

  const skull = new THREE.Mesh(cg('skull', () =>
    new THREE.SphereGeometry(0.099, 18, 16)), mats.skin);
  skull.scale.set(0.94, 1.07, 0.99);
  skull.position.y = 0.116;
  head.add(skull);

  const face = new THREE.Mesh(cg('face', () =>
    new THREE.SphereGeometry(0.073, 14, 12)), mats.skin);
  face.scale.set(1, 1.04, 1.14);
  face.position.set(0, 0.100, 0.052);
  head.add(face);

  const jaw = new THREE.Mesh(cg('jaw', () =>
    new THREE.CapsuleGeometry(0.046, 0.052, 4, 10)), mats.skin);
  jaw.rotation.x = Math.PI / 2;
  jaw.scale.set(1.12, 1, 0.86);
  jaw.position.set(0, 0.056, 0.050);
  head.add(jaw);

  const helmet = new THREE.Mesh(cg('helmet', () =>
    new THREE.SphereGeometry(0.114, 22, 16, 0, Math.PI * 2, 0, Math.PI * 0.575)), mats.helmet);
  helmet.scale.set(0.99, 1.03, 1.18);
  helmet.position.set(0, 0.132, 0.002);
  helmet.castShadow = true;
  head.add(helmet);

  const helmTail = new THREE.Mesh(cg('helmTail', () =>
    new THREE.CapsuleGeometry(0.034, 0.072, 4, 12)), mats.helmet);
  helmTail.rotation.x = Math.PI / 2 - 0.18;
  helmTail.scale.set(1, 1, 0.55);
  helmTail.position.set(0, 0.124, -0.096);
  head.add(helmTail);

  for (let i = 0; i < 3; i++) {
    const vent = new THREE.Mesh(cg('vent', () =>
      new THREE.BoxGeometry(0.021, 0.011, 0.135)), mats.dark);
    vent.position.set((i - 1) * 0.046, 0.174 - Math.abs(i - 1) * 0.009, 0.008);
    vent.rotation.x = -0.13;
    head.add(vent);
  }
  for (const s of [1, -1]) {
    const strap = new THREE.Mesh(cg('strap', () =>
      new THREE.BoxGeometry(0.006, 0.105, 0.006)), mats.dark);
    strap.position.set(s * 0.083, 0.068, 0.016);
    strap.rotation.z = s * 0.13;
    head.add(strap);
  }
  const lens = new THREE.Mesh(cg('lens', () =>
    new THREE.BoxGeometry(0.150, 0.042, 0.014)), mats.glass);
  lens.position.set(0, 0.102, 0.090);
  lens.rotation.x = 0.16;
  head.add(lens);
  const bridge = new THREE.Mesh(cg('bridge', () =>
    new THREE.BoxGeometry(0.024, 0.009, 0.010)), mats.dark);
  bridge.position.set(0, 0.104, 0.090);
  head.add(bridge);

  torso.add(head);

  /* ---------- 手臂（torso 子节点，IK 在 torso 局部坐标解算） ---------- */
  const arms = [];
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? 1 : -1;
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * Rd.shoulderHalfW, Rd.torsoLen - 0.030, 0.010);
    torso.add(shoulder);

    const upper = new THREE.Mesh(cg('upperArm', () =>
      new THREE.CapsuleGeometry(BONE_R.upperArm, Rd.upperArm - 2 * BONE_R.upperArm, 6, 12)), mats.jersey);
    upper.position.y = Rd.upperArm / 2;
    upper.castShadow = true;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = Rd.upperArm;
    shoulder.add(elbow);

    const fore = new THREE.Mesh(cg('foreArm', () =>
      new THREE.CapsuleGeometry(BONE_R.foreArm, Rd.foreArm - 2 * BONE_R.foreArm, 6, 12)), mats.skin);
    fore.position.y = Rd.foreArm / 2;
    elbow.add(fore);

    const hand = new THREE.Group();
    hand.position.y = Rd.foreArm;
    elbow.add(hand);
    const glove = new THREE.Mesh(cg('glove', () =>
      new THREE.CapsuleGeometry(0.041, 0.056, 4, 10)), mats.shorts);
    glove.position.y = 0.028;
    hand.add(glove);

    arms.push({ side, sx, shoulder, elbow, hand, upper, fore });
  }

  /* ---------- 腿（root 子节点，踝锁踏板） ---------- */
  const legs = [];
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? 1 : -1;
    const hip = new THREE.Group();
    // 髋关节：严格使用验证过的坐标，IK 可达性才成立
    hip.position.set(sx * (Rd.hipWidth / 2), Rd.hipH, Rd.hipZ);
    root.add(hip);

    // 大腿：capsule 总长 = 2r + length，令其 = 骨长，使骨骼首尾正好落在关节上
    const thighLen = Rd.thigh - 2 * BONE_R.thigh;
    const thigh = new THREE.Mesh(cg('thigh', () =>
      new THREE.CapsuleGeometry(BONE_R.thigh, thighLen, 6, 12)), mats.shorts);
    thigh.position.y = Rd.thigh / 2;
    thigh.castShadow = true;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = Rd.thigh;
    hip.add(knee);

    const kneeCap = new THREE.Mesh(cg('kneeCap', () =>
      new THREE.SphereGeometry(0.066, 12, 10)), mats.skin);
    kneeCap.scale.set(1, 1, 0.96);
    knee.add(kneeCap);

    const shin = new THREE.Mesh(cg('shin', () =>
      new THREE.CapsuleGeometry(BONE_R.shin, Rd.shin - 2 * BONE_R.shin, 6, 12)), mats.skin);
    shin.position.y = Rd.shin / 2;
    knee.add(shin);

    const sock = new THREE.Mesh(cg('sock', () =>
      new THREE.CylinderGeometry(0.052, 0.047, 0.090, 10)), mats.jerseyTrim);
    sock.position.y = Rd.shin - 0.046;
    knee.add(sock);
    /* 袜口色带：真实骑行袜在袜口有一圈队色，远看能"读"出是车手 */
    const sockBand = new THREE.Mesh(cg('sockBand', () =>
      new THREE.CylinderGeometry(0.0535, 0.0535, 0.014, 10)), mats.jersey);
    sockBand.position.y = Rd.shin - 0.006;
    knee.add(sockBand);

    const ankle = new THREE.Group();
    ankle.position.y = Rd.shin;
    knee.add(ankle);

    const shoe = new THREE.Group();
    const shoeBody = new THREE.Mesh(cg('shoeBody', () =>
      new THREE.CapsuleGeometry(0.044, 0.145, 4, 12)), mats.shoe);
    shoeBody.rotation.x = Math.PI / 2;
    shoeBody.scale.set(1.02, 1, 0.74);
    shoe.add(shoeBody);
    const sole = new THREE.Mesh(cg('sole', () =>
      new THREE.BoxGeometry(0.080, 0.012, 0.222)), mats.carbon);
    sole.position.set(0, -0.034, 0.012);
    shoe.add(sole);
    const cleat = new THREE.Mesh(cg('cleat', () =>
      new THREE.BoxGeometry(0.052, 0.006, 0.062)), mats.steel);
    cleat.position.set(0, -0.041, -0.012);
    shoe.add(cleat);
    ankle.add(shoe);

    legs.push({ side, sx, hip, knee, ankle, shoe, thigh, shin, kneeCap, sock });
  }

  /* 手把握点（车体坐标，= 手变头位置），手臂 IK 会转换到 torso 局部 */
  const handTargets = [
    new THREE.Vector3(0.198, BIKE_GEO.hood.y + Rd.handOffset.y, BIKE_GEO.hood.z + Rd.handOffset.z),
    new THREE.Vector3(-0.198, BIKE_GEO.hood.y + Rd.handOffset.y, BIKE_GEO.hood.z + Rd.handOffset.z)
  ];

  return { root, torso, head, legs, arms, handTargets, cosL, sinL };
}

/* ---------------------------------------------------------------------------
 * 整车装配
 * ------------------------------------------------------------------------ */
export function createBike(opts = {}) {
  const mats = makeMaterials(
    opts.frameColor !== undefined ? opts.frameColor : 0xd42a2a,
    opts.jerseyColor !== undefined ? opts.jerseyColor : 0x1f77d4,
    opts.helmetColor !== undefined ? opts.helmetColor : 0xf7f8fa);

  const root = new THREE.Group();
  // 外倾组：过弯压弯绕地面接触线旋转
  const leanPivot = new THREE.Group();
  root.add(leanPivot);

  const frame = buildFrame(mats);
  const drivetrain = buildDrivetrain(mats);
  const bar = buildHandlebar(mats);

  const wheelFront = buildWheel(mats);
  wheelFront.position.set(0, BIKE_GEO.wheelR, BIKE_GEO.axleZ.front);
  const wheelRear = buildWheel(mats);
  wheelRear.position.set(0, BIKE_GEO.wheelR, BIKE_GEO.axleZ.rear);

  const rider = buildRider(mats);

  leanPivot.add(frame, drivetrain, bar, wheelFront, wheelRear, rider.root);

  /* 状态（由外部每帧写入） */
  const state = {
    crankRad: Math.PI / 2,
    gear: 6,
    lean: 0,
    steer: 0,
    wheelAngle: 0,
    speed: 0,
    draft: 0,
    braking: false,
    leftActive: false, rightActive: false,
    leftBad: false, rightBad: false
  };

  const R = BIKE_GEO;

  function update(dt, s) {
    if (s) {
      if (s.crankRad !== undefined) state.crankRad = s.crankRad;
      if (s.gear !== undefined) state.gear = s.gear;
      if (s.lean !== undefined) state.lean = s.lean;
      if (s.steer !== undefined) state.steer = s.steer;
      if (s.speed !== undefined) state.speed = s.speed;
      if (s.draft !== undefined) state.draft = s.draft;
      if (s.braking !== undefined) state.braking = s.braking;
    }
    state.wheelAngle += (state.speed / R.wheelR) * dt;

    const cogR = R.cassetteRadii[state.gear] || 0.03;

    /* ---- 曲柄 + 踏板 + 牙盘 ---- */
    const pedals = drivetrain.userData.pedals;
    for (let i = 0; i < 2; i++) {
      const a = state.crankRad + pedals[i].offset;
      pedals[i].crank.rotation.x = a;        // 曲柄跟着相位转
      pedals[i].holder.rotation.x = -a;      // 踏板保持水平
    }
    drivetrain.userData.ring.rotation.x = state.crankRad;

    /* ---- 飞轮：按齿比放大转速 ---- */
    const ratio = R.chainringR / Math.max(0.02, cogR);
    drivetrain.userData.cassette.rotation.x = -state.wheelAngle * ratio;

    /* ---- 后拨跟随挡位横移 + 随飞轮上下浮动 ---- */
    const rd = drivetrain.userData.rd;
    const targetX = R.cassetteX + (R.cassetteX0 + state.gear * R.cassetteDX) * 0.82 + 0.032;
    rd.position.x += (targetX - rd.position.x) * Math.min(1, dt / 0.09);
    rd.position.y = R.wheelR + cogR + 0.062;

    /* ---- 链条两段贴合当前齿比 ---- */
    const ch = drivetrain.userData.chain;
    const z0 = R.bb.z, z1 = 0.012, xOff = R.chainX;
    const topA = { y: R.bb.y + R.chainringR, z: z0 }, topB = { y: R.wheelR + cogR, z: z1 };
    const botA = { y: R.bb.y - R.chainringR, z: z0 }, botB = { y: R.wheelR - cogR, z: z1 };
    const placeSeg = (seg, A, B) => {
      const dy = B.y - A.y, dz = B.z - A.z;
      const len = Math.hypot(dy, dz);
      seg.position.set(xOff, (A.y + B.y) / 2, (A.z + B.z) / 2);
      seg.rotation.x = Math.atan2(dy, dz) - Math.PI / 2;
      seg.scale.set(1, 1, len);
    };
    // BoxGeometry 的 Z 轴为长度方向 → rotation.x 需将 +Z 转到 (dz, dy) 方向
    placeSeg(ch.top, topA, topB);
    placeSeg(ch.bot, botA, botB);

    /* ---- 车轮（前进 +Z → rotation.x 必须为正） ---- */
    wheelFront.rotation.x = state.wheelAngle;
    wheelRear.rotation.x = state.wheelAngle;

    /* ---- 转向 / 压弯 ---- */
    bar.rotation.y = state.steer * 0.22;
    wheelFront.rotation.y = state.steer * 0.28;
    /* ---- 转向 / 压弯 ----
     * ★ 倾斜方向（已数值推导确认，别改符号）：
     *   root.rotation.y = atan2(tx,tz) → 局部 +X 轴指向【前进方向左侧】
     *   （因为 Ry 把局部(1,0,0)映射到 (cos ry, 0, -sin ry)，与 track 的右向量同向）。
     *   而 rotation.z = +φ 会把车顶推向局部 -X，即【右侧】。
     *   物理里 lean = -curv·v²/g，左弯(curv>0)时 lean 为负。
     *   ⇒ 若写 `rotation.z = -lean`，左弯得到正的 rotation.z → 车顶向右倒【错】。
     *   ⇒ 正确写法是 `rotation.z = lean`：左弯 lean<0 → 车顶向左倒 = 压向弯内。
     *   （曾写成 -lean，导致"转弯时倾斜方向反了"。） */
    leanPivot.rotation.z = state.lean;

    /* ===== 腿部 IK：踝关节锁在踏板 =====
     * ★ 发力区间表现（与 constants 里的 STROKE_TABLE 严格对应）：
     *   推压段（约 20°~160°，gain 正、峰值 90°）→ 脚踝下沉一点、鞋尖下压，
     *     做出"踩实、把力压下去"的样子；
     *   提拉段（约 200°~340°，gain 负）→ 脚踝上翻、脚尖上抬，
     *     做出"收腿卸重"的样子（真实骑手在这里就是卸重，不是继续压）。
     *   死点（0°/180°）两者过渡，动作最中性。 */
    for (let i = 0; i < 2; i++) {
      const leg = rider.legs[i];
      const a = state.crankRad + pedals[i].offset;
      const pz = R.bb.z + R.crankLen * Math.sin(a);
      const py = R.bb.y + R.crankLen * Math.cos(a);

      /* 该侧当前的发力系数（正面 = 推压，负面 = 提拉） */
      const deg = ((a * 180 / Math.PI) % 360 + 360) % 360;
      const gain = footGainOf(deg, 0);           // 相位已含 offset，用 0 侧查表即可
      const drive = Math.max(0, gain);           // 0~1：推压强度
      const lift = Math.max(0, -gain);           // 0~1：提拉强度

      const hipY = leg.hip.position.y;
      const hipZ = leg.hip.position.z;
      const ankleZ = pz - 0.008;
      /* 发力下压时踝关节略微下沉，提拉时略微抬起 */
      const ankleY = py + RIDER.ankleLift - drive * 0.012 + lift * 0.020;

      const mid = solveMid(hipZ, hipY, ankleZ, ankleY, RIDER.thigh, RIDER.shin, true);

      const hipAngle = Math.atan2(mid.z - hipZ, mid.y - hipY);
      const shinWorld = Math.atan2(ankleZ - mid.z, ankleY - mid.y);
      leg.hip.rotation.x = hipAngle;
      leg.knee.rotation.x = shinWorld - hipAngle;

      /* 鞋姿态：随相位摆动 + 推压段下压、提拉段上翻（"刮泥"动作） */
      leg.shoe.rotation.x = -0.18 + 0.46 * Math.cos(a + 0.7)
        + drive * 0.10 - lift * 0.16;
    }

    /* ===== 手臂 IK：手固定在车把（转到 torso 局部坐标解算） ===== */
    const tPos = rider.torso.position;
    for (let i = 0; i < 2; i++) {
      const arm = rider.arms[i];
      const t = rider.handTargets[i];
      // 世界(车体) → torso 局部：绕 X 逆旋转
      const relY = t.y - tPos.y, relZ = t.z - tPos.z;
      const lz = -relY * rider.sinL + relZ * rider.cosL;
      const ly = relY * rider.cosL + relZ * rider.sinL;

      const sh = arm.shoulder.position;
      const mid = solveMid(sh.z, sh.y, lz, ly, RIDER.upperArm, RIDER.foreArm, false);

      const upAngle = Math.atan2(mid.z - sh.z, mid.y - sh.y);
      const foreWorld = Math.atan2(lz - mid.z, ly - mid.y);
      arm.shoulder.rotation.x = upAngle;
      arm.elbow.rotation.x = foreWorld - upAngle;
    }
  }

  /* 供外部标记"错误发力"（用于车手身上的红闪提示） */
  function setFootFlags(lActive, rActive, lBad, rBad) {
    state.leftActive = lActive; state.rightActive = rActive;
    state.leftBad = lBad; state.rightBad = rBad;
  }

  /* ===== 尾流可视化：车后两条"真空带"线 =====
   * 真实尾流是车后一块低压扰动区，宽度约等于车身，长度随速度增长
   * （风洞数据：3m 内风阻降低 8~12%，10m 外 <2%）。
   * 这里用两条从后轮向后延伸的细线表示"被推开的气流边界"：
   *   · 长度随速度线性增长（低速几乎看不见，高速拉出长带）
   *   · 越往末端越淡（顶点 alpha 沿长度衰减），符合尾流强度的指数衰减
   *   · 放在 root 局部坐标里，天然跟随车身朝向
   * ⚠️ 用 LineSegments 必须【两两成对】给顶点（一段 = 起点+终点），
   *   不能像 Line 那样连续给点 —— 之前按连续点填，导致连线错乱、几乎看不见。 */
  const WAKE_SEG = 14;                       // 每条线分成多少段
  const WAKE_VPS = WAKE_SEG * 2;             // 每条线需要的顶点数（每段 2 个）
  const wakeGeo = new THREE.BufferGeometry();
  const wakePos = new Float32Array(2 * WAKE_VPS * 3);
  const wakeAlpha = new Float32Array(2 * WAKE_VPS);
  wakeGeo.setAttribute('position', new THREE.BufferAttribute(wakePos, 3));
  wakeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(wakeAlpha, 1));

  /* 用 ShaderMaterial 才能做"沿线渐变透明"（LineBasicMaterial 不支持顶点 alpha） */
  const wakeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0xcfeeff) }, uOpacity: { value: 0 } },
    vertexShader: `
      attribute float aAlpha;
      varying float vA;
      void main() {
        vA = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying float vA;
      void main() {
        float a = vA * uOpacity;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`
  });
  const wakeLine = new THREE.LineSegments(wakeGeo, wakeMat);
  wakeLine.frustumCulled = false;
  root.add(wakeLine);

  /**
   * 更新尾流带
   * @param {number} speed 车速 m/s
   * @param {number} draft 自己吃到的尾流强度 0~1
   */
  function updateWake(speed, draft) {
    const kmh = Math.max(0, speed * 3.6);
    /* 长度：12km/h 起约 2m，70km/h 拉到 ~16m
     * （真实尾流 3m 内有效、10m 外几乎为零，这里略拉长是为了"看得见"） */
    const len = Math.max(0, Math.min(18, (kmh - 12) * 0.30));
    const op = Math.max(0, Math.min(1, (kmh - 15) / 45));
    wakeMat.uniforms.uOpacity.value = op * 1.1;

    if (len < 0.5 || op < 0.02) { wakeLine.visible = false; return; }
    wakeLine.visible = true;

    const z0 = BIKE_GEO.wheelR + 0.02;      // 后轮之后
    const halfW = 0.22;                      // 起点半宽（≈ 车身宽）
    const spread = 0.06;                     // 末端外扩比例（尾流扩散角）

    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? 1 : -1;
      const base = side * WAKE_VPS;          // 该条线在数组中的起始顶点
      for (let seg = 0; seg < WAKE_SEG; seg++) {
        const t0 = seg / WAKE_SEG;
        const t1 = (seg + 1) / WAKE_SEG;
        const zA = z0 - t0 * len, zB = z0 - t1 * len;
        const xA = sx * (halfW + t0 * len * spread);
        const xB = sx * (halfW + t1 * len * spread);
        const kA = (base + seg * 2) * 3;
        const kB = (base + seg * 2 + 1) * 3;
        wakePos[kA] = xA; wakePos[kA + 1] = 0.32; wakePos[kA + 2] = zA;
        wakePos[kB] = xB; wakePos[kB + 1] = 0.32; wakePos[kB + 2] = zB;
        /* alpha 沿长度衰减：起点亮（近车处尾流最强）、末端淡
         * (1-t)^1.7 与"3m 外迅速失效"的指数衰减趋势一致；
         * 自己吃到尾流时整体更亮（说明身处别人尾流里，气压更低） */
        const boost = 0.75 + draft * 0.9;
        wakeAlpha[base + seg * 2] = Math.pow(1 - t0, 1.7) * boost;
        wakeAlpha[base + seg * 2 + 1] = Math.pow(1 - t1, 1.7) * boost;
      }
    }
    wakeGeo.attributes.position.needsUpdate = true;
    wakeGeo.attributes.aAlpha.needsUpdate = true;
  }

  return {
    root, update, state, materials: mats, rider, setFootFlags, updateWake,
    parts: { frame, drivetrain, bar, wheelFront, wheelRear, leanPivot }
  };
}
