/**
 * 便便英雄角色模型（全程序化生成，无外部素材）
 * 造型对齐参考图：
 *   · 大红蛋形头套 + 黑色描边，额头白色高光
 *   · 两只大白椭圆眼（黑瞳 + 高光），下半张奶油色宽脸
 *   · 咧到耳根的大笑：黑边、白牙、红舌头
 *   · 红色连体紧身衣，胸口白色字母 D
 *   · 细长四肢、张开的手掌（四指 + 拇指）
 *   · 背后半透明青色披风，卷成 C 形，带白色高光边
 *   · 臀部奶油色圆（连体衣开口，不做细节），下方会滴屎
 * 朝向约定：模型面朝 +Z，与服务器 yaw 一致（root.rotation.y = yaw）。
 */
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const MAT_CACHE = new Map();
function mat(key, opts) {
  if (!MAT_CACHE.has(key)) MAT_CACHE.set(key, new THREE.MeshStandardMaterial(opts));
  return MAT_CACHE.get(key);
}

const SUIT_RED = 0xe3261c;   // 连体衣红
const SUIT_DARK = 0xa8160f;  // 靴子/手套
const SKIN = 0xf6d9ae;       // 脸/臀部
const CAPE_CYAN = 0x74dced;  // 披风青
const POOP_BROWN = 0x6b4423; // 粪球棕
const OUTLINE = 0x220d08;    // 卡通黑描边

/** 胸前标志：白色字母 D（透明底） */
let emblemTex = null;
function emblemTexture() {
  if (emblemTex) return emblemTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.font = 'bold 104px Georgia, "Times New Roman", serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f7f4ec';
  g.fillText('D', 64, 70);
  emblemTex = new THREE.CanvasTexture(c);
  emblemTex.colorSpace = THREE.SRGBColorSpace;
  return emblemTex;
}

/** 大笑的嘴：透明底贴图（黑边 + 白牙 + 红舌） */
let mouthTex = null;
function mouthTexture() {
  if (mouthTex) return mouthTex;
  const W = 256, H = 168;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);

  // 外轮廓：上沿几乎平的，下沿大圆弧
  g.beginPath();
  g.moveTo(18, 34);
  g.quadraticCurveTo(128, 8, 238, 34);
  g.quadraticCurveTo(232, 128, 128, 156);
  g.quadraticCurveTo(24, 128, 18, 34);
  g.closePath();
  g.fillStyle = '#2a0b06';
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = '#1a0704';
  g.stroke();

  // 口腔内部
  g.beginPath();
  g.moveTo(34, 52);
  g.quadraticCurveTo(128, 34, 222, 52);
  g.quadraticCurveTo(214, 118, 128, 140);
  g.quadraticCurveTo(42, 118, 34, 52);
  g.closePath();
  g.fillStyle = '#5d120c';
  g.fill();

  // 舌头
  g.beginPath();
  g.ellipse(128, 122, 60, 25, 0, 0, Math.PI * 2);
  g.fillStyle = '#c9534a';
  g.fill();

  // 上排白牙
  g.save();
  g.beginPath();
  g.moveTo(34, 50);
  g.quadraticCurveTo(128, 32, 222, 50);
  g.lineTo(218, 74);
  g.quadraticCurveTo(128, 58, 38, 74);
  g.closePath();
  g.fillStyle = '#fffdf3';
  g.fill();
  g.restore();
  g.strokeStyle = 'rgba(60,20,10,.35)';
  g.lineWidth = 3;
  for (let i = 1; i < 6; i++) {
    const x = 38 + (222 - 38) * (i / 6);
    g.beginPath(); g.moveTo(x, 40); g.lineTo(x - 2, 74); g.stroke();
  }

  mouthTex = new THREE.CanvasTexture(c);
  mouthTex.colorSpace = THREE.SRGBColorSpace;
  return mouthTex;
}

/** 长管机关枪（枪口朝 -Z） */
function makeGun(scale = 1) {
  const g = new THREE.Group();
  const steel = mat('gunSteel', { color: 0xd8dee5, roughness: 0.28, metalness: 0.85 });
  const dark = mat('gunDark', { color: 0x2b3037, roughness: 0.45, metalness: 0.7 });
  const mid = mat('gunMid', { color: 0x7e8a98, roughness: 0.35, metalness: 0.8 });
  const gold = mat('gunGold', { color: 0xd8a848, roughness: 0.3, metalness: 0.85 });

  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.072, 0.5, 14), steel);
  shroud.rotation.x = Math.PI / 2; shroud.position.set(0, 0.035, -0.34);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.2, 10), dark);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.035, -0.66);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.05, 0.1, 12), mid);
  muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.035, -0.77);

  const bodyBox = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.46), mid);
  bodyBox.position.set(0, 0, 0.02);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.2), dark);
  stock.position.set(0, -0.03, 0.34); stock.rotation.x = -0.06;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.2, 0.12), dark);
  mag.position.set(0, -0.15, 0.02); mag.rotation.x = -0.12;
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.19, 0.1), dark);
  grip.position.set(0, -0.16, 0.2); grip.rotation.x = 0.28;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 14), gold);
  drum.rotation.z = Math.PI / 2; drum.position.set(0.1, -0.03, 0.05);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.07), gold);
  sight.position.set(0, 0.115, -0.08);

  g.add(shroud, barrel, muzzle, bodyBox, stock, mag, grip, drum, sight);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(scale);
  g.userData.muzzle = new THREE.Vector3(0, 0.035, -0.83 * scale);
  return g;
}

/** 青色半透明披风：从肩膀垂到膝盖的一块波浪布片 */
function buildCapeGeometry() {
  const NU = 10, NV = 12;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NV; i++) {
    const v = i / NV;
    const halfW = 0.2 + v * 0.21;                 // 上窄下宽
    for (let j = 0; j <= NU; j++) {
      const u = (j / NU) * 2 - 1;
      const x = u * halfW;
      const y = -v * 0.88 + Math.sin(u * 3.2 + v * 4.5) * 0.018 * v;
      const z = -0.03 - Math.sin(v * Math.PI * 0.75) * 0.16 + Math.abs(u) * 0.09 * v;
      pos.push(x, y, z);
      uv.push(j / NU, v);
    }
  }
  for (let i = 0; i < NV; i++) {
    for (let j = 0; j < NU; j++) {
      const a = i * (NU + 1) + j, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 披风两侧的白色高光边 */
function buildCapeRims() {
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xeafcff, transparent: true, opacity: 0.55 });
  const group = new THREE.Group();
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const v = i / 10;
      const halfW = 0.2 + v * 0.21;
      pts.push(new THREE.Vector3(
        side * halfW,
        -v * 0.88 + Math.sin(side * 3.2 + v * 4.5) * 0.018 * v,
        -0.03 - Math.sin(v * Math.PI * 0.75) * 0.16 + 0.09 * v
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.009, 5, false), rimMat));
  }
  return group;
}

/** 一只带手指的手（张开） */
function makeHand(sx) {
  const g = new THREE.Group();
  const glove = mat('handGlove', { color: SUIT_DARK, roughness: 0.6 });
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), glove);
  palm.scale.set(1, 0.95, 0.62);
  palm.castShadow = true;
  g.add(palm);
  // 四根手指
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0125, 0.062, 4, 6), glove);
    const k = i - 1.5;
    f.position.set(k * 0.027, -0.058, 0.004);
    f.rotation.z = k * 0.2;
    f.castShadow = true;
    g.add(f);
  }
  // 拇指
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.05, 4, 6), glove);
  thumb.position.set(sx * 0.052, -0.022, 0.014);
  thumb.rotation.z = sx * 0.95;
  thumb.rotation.x = 0.25;
  g.add(thumb);
  return g;
}

/**
 * 创建一个便便英雄
 * @param {number} _color 保留参数
 */
export function createPoopHero(_color) {
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  const body = new THREE.Group();
  root.add(tilt); tilt.add(body);

  const suit = mat('suit', { color: SUIT_RED, roughness: 0.5, metalness: 0.04 });
  const suitDark = mat('suitD', { color: SUIT_DARK, roughness: 0.55 });
  const skin = mat('skin', { color: SKIN, roughness: 0.7 });
  const dark = mat('darkPart', { color: OUTLINE, roughness: 0.6 });
  const white = mat('eyeWhite', { color: 0xffffff, roughness: 0.2, emissive: 0x6a6a6a });

  // ---------------- 腿 + 靴 ----------------
  const mkLeg = (sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.115, 0.84, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.54, 6, 10), suit);
    leg.position.y = -0.35; leg.castShadow = true;
    const boot = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.2, 6, 10), suitDark);
    boot.rotation.x = Math.PI / 2;
    boot.position.set(0, -0.785, 0.1);
    boot.castShadow = true;
    const toe = new THREE.Mesh(new THREE.SphereGeometry(0.068, 10, 8), suitDark);
    toe.scale.set(0.9, 0.75, 1.1);
    toe.position.set(0, -0.785, 0.235);
    pivot.add(leg, boot, toe);
    return pivot;
  };
  const legL = mkLeg(-1), legR = mkLeg(1);
  body.add(legL, legR);

  // ---------------- 髋 ----------------
  const waist = new THREE.Group();
  waist.position.y = 0.84;
  body.add(waist);

  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), suit);
  pelvis.scale.set(1.02, 0.82, 0.9);
  pelvis.position.y = 0.02;
  pelvis.castShadow = true;
  waist.add(pelvis);

  // 臀部奶油色圆（连体衣开口，不做细节）
  const butt = new THREE.Mesh(new THREE.SphereGeometry(0.076, 16, 12), skin);
  butt.scale.set(1.0, 1.12, 0.5);
  butt.position.set(0, -0.045, -0.145);
  waist.add(butt);

  // ---------------- 腰以上 ----------------
  const spine = new THREE.Group();
  spine.position.y = 0.06;
  waist.add(spine);

  const torsoProfile = [
    new THREE.Vector2(0.001, -0.34),
    new THREE.Vector2(0.142, -0.31),
    new THREE.Vector2(0.172, -0.17),
    new THREE.Vector2(0.162, -0.02),
    new THREE.Vector2(0.19, 0.13),
    new THREE.Vector2(0.172, 0.25),
    new THREE.Vector2(0.1, 0.32),
    new THREE.Vector2(0.001, 0.35),
  ];
  const torsoGeo = new THREE.LatheGeometry(torsoProfile, 22);
  torsoGeo.scale(1, 1, 0.78);
  const torso = new THREE.Mesh(torsoGeo, suit);
  torso.position.y = 0.22;
  torso.castShadow = true;
  spine.add(torso);

  // 胸前白色 D
  const emb = new THREE.Mesh(
    new THREE.PlaneGeometry(0.185, 0.24),
    new THREE.MeshStandardMaterial({ map: emblemTexture(), transparent: true, roughness: 0.6 })
  );
  emb.position.set(0, 0.255, 0.153);
  emb.rotation.x = -0.06;
  spine.add(emb);

  // 脖子 + 领口
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.085, 0.12, 12), suit);
  neck.position.y = 0.39;
  spine.add(neck);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.026, 8, 18), suit);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.36;
  spine.add(collar);

  // 金色腰带（连体衣收腰，突出超人气）
  const beltMat = mat('belt', { color: 0xf0b429, roughness: 0.35, metalness: 0.5 });
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.15, 0.05, 20), beltMat);
  belt.scale.z = 0.8;
  belt.position.y = 0.12;
  spine.add(belt);
  const buckle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.055, 12), mat('buckle', { color: 0xffe08a, roughness: 0.25, metalness: 0.7 }));
  buckle.rotation.x = Math.PI / 2;
  buckle.position.set(0, 0.12, 0.14);
  spine.add(buckle);

  const shoulders = new THREE.Group();
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.082, 12, 10), suit);
    s.scale.set(1, 0.95, 1);
    s.position.set(sx * 0.165, 0.34, 0.02);
    shoulders.add(s);
  }
  spine.add(shoulders);

  // ---------------- 头 ----------------
  const headG = new THREE.Group();
  headG.position.set(0, 0.615, 0.015);
  headG.scale.setScalar(1.14);
  spine.add(headG);

  // 黑色描边（BackSide 只露边缘）
  const outline = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), mat('headOutline', {
    color: OUTLINE, roughness: 0.7, side: THREE.BackSide,
  }));
  outline.position.set(0, 0.02, -0.006);
  outline.scale.set(0.252, 0.368, 0.252);
  headG.add(outline);

  // 蛋形红头套
  const hoodProfile = [
    new THREE.Vector2(0.001, -0.30),
    new THREE.Vector2(0.148, -0.285),
    new THREE.Vector2(0.212, -0.20),
    new THREE.Vector2(0.242, -0.06),
    new THREE.Vector2(0.238, 0.09),
    new THREE.Vector2(0.205, 0.205),
    new THREE.Vector2(0.138, 0.29),
    new THREE.Vector2(0.055, 0.34),
    new THREE.Vector2(0.001, 0.362),
  ];
  const hoodGeo = new THREE.LatheGeometry(hoodProfile, 26);
  hoodGeo.scale(1, 1, 0.92);
  const hood = new THREE.Mesh(hoodGeo, suit);
  hood.castShadow = true;
  headG.add(hood);

  // 额头白色高光
  const gloss = new THREE.Mesh(new THREE.SphereGeometry(0.029, 14, 12), white);
  gloss.scale.set(0.95, 1.45, 0.36);
  gloss.position.set(-0.062, 0.23, 0.19);
  gloss.rotation.z = 0.36;
  headG.add(gloss);

  // 头顶天线（超人触角，一短一长，轻微弹性）
  const antennaMat = mat('antenna', { color: 0xf0b429, roughness: 0.3, metalness: 0.4 });
  const antL = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.16, 8), antennaMat);
  antL.position.set(-0.05, 0.42, 0.02);
  antL.rotation.z = -0.35;
  const antR = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.22, 8), antennaMat);
  antR.position.set(0.05, 0.43, 0.02);
  antR.rotation.z = 0.3;
  const antBallL = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), antennaMat);
  antBallL.position.set(-0.098, 0.475, 0.02);
  const antBallR = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), antennaMat);
  antBallR.position.set(0.1, 0.505, 0.02);
  headG.add(antL, antR, antBallL, antBallR);

  // ---- 大白眼睛（红色面具上"开洞"：黑边洞口 + 洞里的白眼球）----
  const eyeGroup = new THREE.Group();
  headG.add(eyeGroup);
  const eyes = [];
  for (const sx of [-1, 1]) {
    // 面具开洞：黑色洞口（往里凹），白眼球从洞里透出来
    const rim = new THREE.Mesh(new THREE.SphereGeometry(0.088, 16, 12), dark);
    rim.scale.set(1, 1.34, 0.42);
    rim.position.set(sx * 0.086, 0.045, 0.176);
    eyeGroup.add(rim);

    const ew = new THREE.Mesh(new THREE.SphereGeometry(0.079, 18, 14), white);
    ew.scale.set(1, 1.3, 0.42);
    ew.position.set(sx * 0.086, 0.045, 0.19);
    eyeGroup.add(ew);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), dark);
    pupil.position.set(sx * 0.074, 0.058, 0.228);
    pupil.scale.set(0.92, 1.12, 0.6);
    eyeGroup.add(pupil);

    const hilite = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), white);
    hilite.position.set(sx * 0.086, 0.078, 0.244);
    eyeGroup.add(hilite);
    eyes.push(ew);
  }

  // ---- 奶油色宽脸（下半张）：嘴巴这里没有红色面具，是露出来的奶油色皮肤 ----
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.118, 22, 16), skin);
  muzzle.scale.set(1.62, 1.14, 1.0);
  muzzle.position.set(0, -0.145, 0.165);
  muzzle.castShadow = true;
  headG.add(muzzle);

  // 大笑的嘴（贴图，贴在奶油色下巴上，不压红面具）
  const mouth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.16),
    new THREE.MeshBasicMaterial({ map: mouthTexture(), transparent: true, depthWrite: false })
  );
  mouth.position.set(0, -0.135, 0.288);
  mouth.rotation.x = -0.06;
  mouth.renderOrder = 3;
  headG.add(mouth);

  // ---------------- 披风 ----------------
  const cape = new THREE.Group();
  cape.position.set(0, 0.37, -0.06);
  spine.add(cape);

  const capeMat = new THREE.MeshPhysicalMaterial({
    color: 0x5bd8ee, transparent: true, opacity: 0.66,
    roughness: 0.08, metalness: 0.05,
    clearcoat: 1.0, clearcoatRoughness: 0.06,
    emissive: 0x116b7a, emissiveIntensity: 0.7,
    side: THREE.DoubleSide, depthWrite: false,
  });
  cape.add(new THREE.Mesh(buildCapeGeometry(), capeMat));
  cape.add(buildCapeRims());

  // ---------------- 手臂 + 枪 ----------------
  const mkArm = (sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.175, 0.36, 0.02);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.3, 6, 10), suit);
    arm.position.y = -0.19;
    arm.castShadow = true;
    pivot.add(arm);
    const hand = makeHand(sx);
    hand.position.y = -0.39;
    pivot.add(hand);
    return pivot;
  };
  const armL = mkArm(-1), armR = mkArm(1);
  spine.add(armL, armR);

  const gunRig = new THREE.Group();
  gunRig.position.set(0.02, 0.29, 0.21);
  spine.add(gunRig);
  const gun = makeGun(0.78);
  gun.rotation.y = Math.PI;
  gun.position.set(0, 0, 0.04);
  gunRig.add(gun);

  // ---------------- 名字牌 ----------------
  const state = { t: 0, walk: 0, rollSpin: 0 };
  const nameSprite = makeLabel('');
  nameSprite.position.y = 2.15;
  root.add(nameSprite);

  return {
    root, tilt, body, spine, headG, armL, armR, gun, gunRig, legL, legR,
    nameSprite, eyes, cape,
    setLabel(text, color = '#ffd34d') {
      root.remove(nameSprite);
      const s = makeLabel(text, color);
      s.position.y = 2.15;
      root.add(s);
      this.nameSprite = s;
    },
    /** 每帧更新姿态动画 */
    update(dt, st = {}) {
      state.t += dt;
      const t = state.t;
      let pose = st.pose || 'idle';
      if (st.down) pose = 'down';
      if (st.fly) pose = 'fly';

      // ---- 复位 ----
      tilt.rotation.set(0, 0, 0);
      tilt.position.set(0, 0, 0);
      body.position.set(0, 0, 0);
      body.scale.set(1, 1, 1);
      waist.position.set(0, 0.84, 0);
      waist.rotation.set(0, 0, 0);
      spine.rotation.set(0, 0, 0);
      headG.rotation.set(0.04, 0, 0);
      armL.rotation.set(0, 0, 0);
      armR.rotation.set(0, 0, 0);
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      cape.rotation.set(0, 0, 0);
      cape.visible = true;
      gunRig.rotation.set(0, 0, 0);
      gun.visible = true;
      eyeGroup.scale.set(1, 1, 1);

      // ---- 走路摆腿 ----
      const spd = clamp(st.speed || 0, 0, 12);
      const walkAmp = Math.min(1, spd / 3.5) * 0.5;
      state.walk += dt * (2.0 + spd * 1.6);
      legL.rotation.x = Math.sin(state.walk) * walkAmp;
      legR.rotation.x = -Math.sin(state.walk) * walkAmp;

      // 眨眼
      const bp = t % 4.4;
      if (bp > 4.24) {
        const k = 1 - Math.abs((bp - 4.32) / 0.08);
        eyeGroup.scale.y = Math.max(0.1, 1 - clamp(k, 0, 1) * 0.9);
      }

      if (pose === 'idle') {
        body.position.y = Math.sin(t * 2.4) * 0.012;
        spine.rotation.x = 0.05;
        headG.rotation.x = 0.04 + Math.sin(t * 2.4 + 0.6) * 0.035;
        gunRig.rotation.x = 0.5;
        armL.rotation.x = -1.18; armL.rotation.y = 0.12;
        armR.rotation.x = -1.18; armR.rotation.y = -0.12;
        cape.rotation.x = Math.sin(t * 2.1) * 0.05;
        cape.rotation.z = Math.sin(t * 1.4) * 0.03;
      } else if (pose === 'aim') {
        body.position.y = 0.005;
        spine.rotation.x = 0.1;
        headG.rotation.x = -0.06;
        gunRig.rotation.x = 0;
        armL.rotation.x = -1.32; armL.rotation.y = 0.3;
        armR.rotation.x = -1.28; armR.rotation.y = -0.3;
        cape.rotation.x = -0.12 + Math.sin(t * 1.6) * 0.03;
      } else if (pose === 'bent') {
        // 背对前方、撅屁股弯腰放技能
        tilt.rotation.y = Math.PI;
        waist.position.set(0, 0.76, 0.05);
        spine.rotation.x = 1.0 + Math.sin(t * 24) * 0.04;
        headG.rotation.x = -0.62;
        legL.rotation.x = 0; legR.rotation.x = 0;
        armL.rotation.x = 0.5; armL.rotation.z = -0.25;
        armR.rotation.x = 0.45; armR.rotation.z = 0.25;
        cape.visible = false;
        gun.visible = false;
      } else if (pose === 'fly') {
        // 喷射上升：抬头后仰、双臂张开上举，腿并拢微屈
        body.position.y = Math.sin(t * 9) * 0.02;
        tilt.rotation.x = -0.26 + Math.sin(t * 7) * 0.03;   // 后仰抬头，朝上冲
        spine.rotation.x = -0.14;
        headG.rotation.x = -0.34;                            // 看向斜上方
        armL.rotation.z = -2.55;
        armR.rotation.z = 2.55;
        armL.rotation.x = 0.2;
        armR.rotation.x = 0.2;
        legL.rotation.x = 0.26; legL.rotation.z = -0.06;
        legR.rotation.x = -0.08; legR.rotation.z = 0.06;
        cape.rotation.x = 1.25 + Math.sin(t * 12) * 0.09;    // 披风被下压气流吹起
        gun.visible = false;
      } else if (pose === 'down') {
        tilt.rotation.x = -1.42;
        waist.position.y = 0.86;
        spine.rotation.x = -0.18;
        headG.rotation.x = 0.35;
        armL.rotation.set(0.2, 0, 1.25);
        armR.rotation.set(-0.2, 0, -1.25);
        legL.rotation.x = 0.25; legR.rotation.x = -0.1;
        gun.visible = false;
        cape.rotation.x = 0.55;
      }
    },
  };
}

function makeLabel(text, color = '#ffd34d') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px "PingFang SC","Microsoft YaHei",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.75)';
  g.strokeText(text, 128, 34);
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(1.7, 0.42, 1);
  return sp;
}

/** 第一人称手持的机关枪（视口模型） */
export function createViewModel() {
  const g = new THREE.Group();
  const gun = makeGun(1);
  g.add(gun);

  const suit = new THREE.MeshStandardMaterial({ color: SUIT_RED, roughness: 0.55 });
  const glove = new THREE.MeshStandardMaterial({ color: SUIT_DARK, roughness: 0.6 });
  const handR = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.16, 6, 10), glove);
  handR.position.set(0.02, -0.16, 0.24); handR.rotation.x = 0.5;
  const handL = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.14, 6, 10), glove);
  handL.position.set(0.02, -0.13, -0.34); handL.rotation.x = 0.25;
  const armR = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.3, 6, 10), suit);
  armR.position.set(0.1, -0.32, 0.46); armR.rotation.set(0.9, 0, -0.4);
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.34, 6, 10), suit);
  armL.position.set(0.0, -0.28, -0.46); armL.rotation.set(0.7, 0, 0.25);
  g.add(handR, handL, armR, armL);
  g.scale.setScalar(0.5);
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
  return { group: g, muzzleLocal: new THREE.Vector3(0, 0.035, -0.53) };
}

/** 屎榴弹：三坨堆叠的粪球 */
export function createGrenadeMesh() {
  const g = new THREE.Group();
  const mat1 = new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 1 });
  const mat2 = new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 1 });

  const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), mat1);
  s1.scale.set(1.15, 0.6, 1.15); s1.position.y = -0.1;
  const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), mat2);
  s2.scale.set(1.05, 0.72, 1.05); s2.position.y = 0.05;
  const s3 = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), mat1);
  s3.position.y = 0.24;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 8), mat2);
  tip.position.y = 0.38; tip.rotation.x = 0.5;
  g.add(s1, s2, s3, tip);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.position.y = -0.05;
  return g;
}

/** 打滚球技能：一颗向前滚 30 米的大粪球（带旋转子节点） */
export function createRollBallMesh() {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  g.add(spin);

  const poopMat = new THREE.MeshStandardMaterial({ color: POOP_BROWN, roughness: 0.95 });
  const poopDark = new THREE.MeshStandardMaterial({ color: 0x3a2109, roughness: 1 });
  const R = 0.8;

  const core = new THREE.Mesh(new THREE.SphereGeometry(R, 22, 16), poopMat);
  core.scale.set(1, 0.94, 1);
  core.castShadow = true;
  spin.add(core);

  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * (0.94 - i * 0.07), 0.06, 6, 30), poopDark);
    ring.rotation.set(Math.PI / 2 + (i - 1) * 0.5, i * 1.1, i * 0.6);
    spin.add(ring);
  }
  for (let i = 0; i < 9; i++) {
    const a = i * 2.399, b = i * 1.71;
    const lump = new THREE.Mesh(new THREE.SphereGeometry(0.1 + (i % 3) * 0.025, 8, 6), poopMat);
    lump.position.set(
      Math.sin(a) * Math.cos(b) * R * 0.9,
      Math.sin(b) * R * 0.9,
      Math.cos(a) * Math.cos(b) * R * 0.9
    );
    lump.castShadow = true;
    spin.add(lump);
  }
  g.userData.spin = spin;
  return g;
}
