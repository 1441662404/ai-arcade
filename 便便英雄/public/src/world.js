/**
 * 场景 / 地图 / 灯光
 * 地图盒子由服务器下发（服务器与客户端使用同一份数据，保证命中判定一致）
 * 场地尺寸从 cfg.arenaHalf 读取，支持大地图。
 */
import * as THREE from 'three';

const rand = (a, b) => a + Math.random() * (b - a);

// ============================ 程序化贴图 ============================
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#5d7a3c';
  g.fillRect(0, 0, 512, 512);

  // 大块深浅草地
  for (let i = 0; i < 42; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, r = 40 + Math.random() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    grd.addColorStop(0, dark ? 'rgba(72,96,44,.5)' : 'rgba(126,158,78,.42)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // 泥土斑
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, r = 22 + Math.random() * 46;
    g.fillStyle = `rgba(${120 + Math.random() * 25 | 0},${96 + Math.random() * 20 | 0},${54 + Math.random() * 16 | 0},.28)`;
    g.beginPath();
    for (let j = 0; j < 12; j++) {
      const a = (j / 12) * Math.PI * 2;
      const rr = r * (0.7 + Math.random() * 0.6);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (j === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
  }
  // 草叶笔触
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const s = Math.random();
    g.strokeStyle = s > 0.66 ? 'rgba(146,181,92,.5)' : s > 0.33 ? 'rgba(68,94,42,.55)' : 'rgba(112,145,70,.42)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 5, y - 2 - Math.random() * 5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function brickTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6b6157';
  g.fillRect(0, 0, 256, 256);
  const bw = 64, bh = 32;
  for (let row = 0; row < 8; row++) {
    for (let col = -1; col < 5; col++) {
      const x = col * bw + (row % 2 ? bw / 2 : 0);
      const y = row * bh;
      const v = 88 + Math.random() * 34;
      g.fillStyle = `rgb(${v | 0},${v * 0.92 | 0},${v * 0.82 | 0})`;
      g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
      // 砖面颗粒
      for (let i = 0; i < 24; i++) {
        g.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.06)';
        g.fillRect(x + 2 + Math.random() * (bw - 6), y + 2 + Math.random() * (bh - 6), 2, 2);
      }
    }
  }
  // 青苔
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 256, y = 180 + Math.random() * 76;
    g.fillStyle = `rgba(72,108,52,${0.12 + Math.random() * 0.25})`;
    g.beginPath(); g.ellipse(x, y, 8 + Math.random() * 18, 4 + Math.random() * 8, 0, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stoneTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9c9c92';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  // 裂纹
  g.strokeStyle = 'rgba(50,50,46,.22)';
  for (let i = 0; i < 14; i++) {
    g.lineWidth = 0.6 + Math.random() * 1.4;
    g.beginPath();
    let x = Math.random() * 256, y = Math.random() * 256;
    g.moveTo(x, y);
    for (let j = 0; j < 5; j++) {
      x += (Math.random() - 0.5) * 54;
      y += (Math.random() - 0.5) * 54;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function crateTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#b07f47';
  g.fillRect(0, 0, 256, 256);
  // 木板
  for (let i = 0; i < 4; i++) {
    const y = i * 64;
    g.fillStyle = i % 2 ? '#a8763f' : '#b88750';
    g.fillRect(0, y + 2, 256, 60);
    g.strokeStyle = 'rgba(90,58,26,.5)';
    g.lineWidth = 2;
    g.strokeRect(0, y + 2, 256, 60);
    // 木纹
    for (let j = 0; j < 10; j++) {
      g.strokeStyle = 'rgba(120,80,36,.25)';
      g.lineWidth = 1;
      g.beginPath();
      const yy = y + 8 + Math.random() * 48;
      g.moveTo(0, yy);
      g.bezierCurveTo(80, yy + rand(-4, 4), 170, yy + rand(-4, 4), 256, yy);
      g.stroke();
    }
  }
  // 铁边 + 钉子
  g.strokeStyle = '#6d6a63'; g.lineWidth = 10;
  g.strokeRect(5, 5, 246, 246);
  g.strokeStyle = 'rgba(40,40,38,.7)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(8, 8); g.lineTo(248, 248); g.moveTo(248, 8); g.lineTo(8, 248); g.stroke();
  for (const [x, y] of [[18, 18], [238, 18], [18, 238], [238, 238]]) {
    g.fillStyle = '#8b8880';
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 天空渐变球 */
function makeSky() {
  const geo = new THREE.SphereGeometry(420, 32, 18);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      cTop: { value: new THREE.Color(0x2f7cd0) },
      cMid: { value: new THREE.Color(0xa8dcff) },
      cBot: { value: new THREE.Color(0xe9f7ff) },
    },
    vertexShader: 'varying vec3 vW; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vW; uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cBot;
      void main(){
        float h = normalize(vW).y;
        vec3 c = h > 0.0 ? mix(cMid, cTop, pow(h, 0.75)) : mix(cMid, cBot, pow(-h, 0.55));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -10;
  return sky;
}

function glowSpriteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,240,1)');
  grd.addColorStop(0.2, 'rgba(255,246,200,.9)');
  grd.addColorStop(0.55, 'rgba(255,220,140,.25)');
  grd.addColorStop(1, 'rgba(255,210,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ============================ 世界 ============================
export function createWorld(mapData, cfg = {}) {
  const S = cfg.arenaHalf || 56;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfe2f7, S * 1.35, S * 6.2);

  scene.add(makeSky());

  // ---- 灯光 ----
  const hemi = new THREE.HemisphereLight(0xdff2ff, 0x4a5a30, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.9);
  sun.position.set(S * 0.7, S * 1.1, S * 0.45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const d = S * 1.45;
  sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
  sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
  sun.shadow.camera.far = S * 4;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.24));

  // 太阳光晕
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSpriteTexture(), blending: THREE.AdditiveBlending,
    transparent: true, opacity: 0.85, depthWrite: false, fog: false,
  }));
  sunSprite.scale.setScalar(70);
  sunSprite.position.set(S * 0.75, S * 1.25, -S * 0.9);
  scene.add(sunSprite);

  // ---- 地面 ----
  const gTex = groundTexture();
  gTex.repeat.set(S / 3.2, S / 3.2);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(S * 2, S * 2),
    new THREE.MeshStandardMaterial({ map: gTex, roughness: 0.98 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // 场外大地
  const outerTex = groundTexture();
  outerTex.repeat.set(S / 2.2, S / 2.2);
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(S * 8, S * 8),
    new THREE.MeshStandardMaterial({ map: outerTex, color: 0xd8e6c8, roughness: 1 })
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.08;
  outer.receiveShadow = true;
  scene.add(outer);

  // 场地边界线（白色虚线环）
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(S - 0.5, S - 0.15, 96),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  scene.add(ring);

  // 中央圆圈 + 十字线
  const centerRing = new THREE.Mesh(
    new THREE.RingGeometry(9.8, 10.2, 64),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
  );
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.y = 0.012;
  scene.add(centerRing);

  // ---- 地图盒子 ----
  const brick = brickTexture();
  const stone = stoneTexture();
  const crate = crateTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.92 });
  const stoneMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.88 });
  const crateMat = new THREE.MeshStandardMaterial({ map: crate, roughness: 0.86 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x8f8a7c, roughness: 0.8 });

  const wallTops = [];
  for (const b of mapData) {
    const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2);
    const m = b.kind === 'wall' ? wallMat : b.kind === 'stone' ? stoneMat : crateMat;
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(b.cx, b.cy, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (b.kind === 'wall') wallTops.push(b);
  }
  // 围墙压顶（纯装饰）
  for (const b of wallTops) {
    const capGeo = new THREE.BoxGeometry(b.hx * 2 + 0.24, 0.24, b.hz * 2 + 0.24);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(b.cx, b.cy + b.hy + 0.12, b.cz);
    cap.castShadow = true;
    cap.receiveShadow = true;
    scene.add(cap);
  }

  // ---- 装饰道具（不参与碰撞）----
  const occupied = (x, z, pad = 1) => mapData.some(b =>
    Math.abs(x - b.cx) < b.hx + pad && Math.abs(z - b.cz) < b.hz + pad);
  const freeSpot = (minR, maxR, pad = 1.5) => {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(minR, maxR);
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (!occupied(x, z, pad)) return { x, z };
    }
    return null;
  };

  // 粪堆
  const poopMat = new THREE.MeshStandardMaterial({ color: 0x5b3a1a, roughness: 1 });
  const poopMat2 = new THREE.MeshStandardMaterial({ color: 0x704722, roughness: 1 });
  for (let i = 0; i < 16; i++) {
    const sp = freeSpot(12, S - 4, 2);
    if (!sp) continue;
    const pile = new THREE.Group();
    const levels = 2 + (Math.random() * 2 | 0);
    for (let j = 0; j < levels; j++) {
      const r = 0.45 - j * 0.1;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), j % 2 ? poopMat : poopMat2);
      m.scale.y = 0.7;
      m.position.y = 0.12 + j * 0.22;
      m.castShadow = true;
      pile.add(m);
    }
    pile.position.set(sp.x, 0, sp.z);
    pile.rotation.y = Math.random() * 6.28;
    scene.add(pile);
  }

  // 木桶
  const barrelMat = new THREE.MeshStandardMaterial({ map: crate, roughness: 0.8 });
  const barrelTop = new THREE.MeshStandardMaterial({ color: 0x7a5a34, roughness: 0.8 });
  for (let i = 0; i < 22; i++) {
    const sp = freeSpot(10, S - 6, 2.2);
    if (!sp) continue;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.0, 14), barrelMat);
    body.position.y = 0.5; body.castShadow = true; body.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 14), barrelTop);
    top.position.y = 1.02;
    g.add(body, top);
    g.position.set(sp.x, 0, sp.z);
    scene.add(g);
  }

  // 草丛（InstancedMesh）
  const grassGeo = new THREE.ConeGeometry(0.12, 0.55, 4);
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x6f9b3f, roughness: 1, flatShading: true });
  const grassCount = 420;
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < grassCount; i++) {
    const sp = freeSpot(9, S * 1.9, 0.5) || { x: rand(-S, S), z: rand(-S, S) };
    dummy.position.set(sp.x, 0.26, sp.z);
    dummy.rotation.set(rand(-0.18, 0.18), Math.random() * 6.28, rand(-0.18, 0.18));
    dummy.scale.setScalar(rand(0.6, 1.6));
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }
  grass.instanceMatrix.needsUpdate = true;
  scene.add(grass);

  // 石头
  const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b8b82, roughness: 1, flatShading: true });
  const rockCount = 70;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  for (let i = 0; i < rockCount; i++) {
    const sp = freeSpot(10, S * 2, 0.8) || { x: rand(-S, S), z: rand(-S, S) };
    dummy.position.set(sp.x, rand(0.08, 0.22), sp.z);
    dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    dummy.scale.set(rand(0.5, 1.7), rand(0.35, 0.9), rand(0.5, 1.7));
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  // 围墙外的树
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
  const leafMats = [
    new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 1, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x619c45, roughness: 1, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x3f7430, roughness: 1, flatShading: true }),
  ];
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = S + 6 + Math.random() * S * 1.35;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    const tree = new THREE.Group();
    const hgt = rand(3.2, 6.2);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, hgt, 7), trunkMat);
    trunk.position.y = hgt / 2;
    trunk.castShadow = true;
    tree.add(trunk);
    const leafMat = leafMats[(Math.random() * leafMats.length) | 0];
    for (let j = 0; j < 3; j++) {
      const r2 = rand(1.3, 2.1) * (1 - j * 0.18);
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r2, 0), leafMat);
      leaf.position.set(rand(-0.5, 0.5), hgt + j * 1.15 - 0.3, rand(-0.5, 0.5));
      leaf.castShadow = true;
      tree.add(leaf);
    }
    tree.position.set(x, 0, z);
    tree.rotation.y = Math.random() * 6.28;
    scene.add(tree);
  }

  // 远山
  const hillMats = [];
  for (let i = 0; i < 5; i++) {
    hillMats.push(new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.28, 0.18, 0.42 - i * 0.03), roughness: 1, flatShading: true,
    }));
  }
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand(-0.05, 0.05);
    const r = 210 + Math.random() * 120;
    const h = rand(18, 46);
    const hill = new THREE.Mesh(new THREE.ConeGeometry(rand(35, 70), h, 7), hillMats[(Math.random() * hillMats.length) | 0]);
    hill.position.set(Math.sin(a) * r, h / 2 - 1, Math.cos(a) * r);
    hill.rotation.y = Math.random() * 6.28;
    scene.add(hill);
  }

  // ---- 云 ----
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.92 });
  const clouds = [];
  for (let i = 0; i < 18; i++) {
    const cl = new THREE.Group();
    const n = 3 + (Math.random() * 3 | 0);
    for (let j = 0; j < n; j++) {
      const s = 2.4 + Math.random() * 3.0;
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 8), cloudMat);
      m.position.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 5);
      m.scale.y = 0.5;
      cl.add(m);
    }
    const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 150;
    cl.position.set(Math.sin(a) * r, 26 + Math.random() * 20, Math.cos(a) * r);
    cl.userData.speed = rand(0.5, 1.4);
    scene.add(cl);
    clouds.push(cl);
  }

  // ---- 空中尘埃 ----
  const moteCount = 320;
  const motePos = new Float32Array(moteCount * 3);
  const moteSeed = new Float32Array(moteCount);
  for (let i = 0; i < moteCount; i++) {
    motePos[i * 3] = rand(-S, S);
    motePos[i * 3 + 1] = rand(0.4, 14);
    motePos[i * 3 + 2] = rand(-S, S);
    moteSeed[i] = Math.random() * 6.28;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({
    color: 0xcdb98f, size: 0.1, transparent: true, opacity: 0.38,
    depthWrite: false, sizeAttenuation: true,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  scene.add(motes);

  // ---- 飞鸟群（远处盘旋，增加生气）----
  const birdGroup = new THREE.Group();
  const birds = [];
  const birdMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2e, side: THREE.DoubleSide });
  const birdGeo = new THREE.PlaneGeometry(0.5, 0.18);
  const makeBird = () => {
    const b = new THREE.Group();
    const wingL = new THREE.Mesh(birdGeo, birdMat);
    const wingR = new THREE.Mesh(birdGeo, birdMat);
    wingL.position.x = -0.16; wingL.rotation.y = 0.5;
    wingR.position.x = 0.16; wingR.rotation.y = -0.5;
    b.add(wingL, wingR);
    const ang = Math.random() * Math.PI * 2;
    const rad = 70 + Math.random() * 80;
    const h = 24 + Math.random() * 18;
    b.position.set(Math.sin(ang) * rad, h, Math.cos(ang) * rad);
    b.userData = { ang, rad, h, spd: 0.2 + Math.random() * 0.4, flap: Math.random() * 6.28 };
    birdGroup.add(b);
    birds.push(b);
  };
  for (let i = 0; i < 14; i++) makeBird();
  scene.add(birdGroup);

  let time = 0;
  function update(dt) {
    time += dt;
    // 云层漂移
    for (const cl of clouds) {
      cl.position.x += cl.userData.speed * dt;
      if (cl.position.x > 230) cl.position.x = -230;
    }
    // 尘埃缓慢飘动
    const arr = moteGeo.attributes.position.array;
    for (let i = 0; i < moteCount; i++) {
      arr[i * 3] += Math.sin(time * 0.35 + moteSeed[i]) * dt * 0.28;
      arr[i * 3 + 1] += Math.sin(time * 0.5 + moteSeed[i] * 1.7) * dt * 0.12;
      arr[i * 3 + 2] += Math.cos(time * 0.3 + moteSeed[i]) * dt * 0.24;
      if (arr[i * 3 + 1] < 0.2) arr[i * 3 + 1] = 14;
    }
    moteGeo.attributes.position.needsUpdate = true;
    // 飞鸟盘旋 + 扇翅
    for (const b of birds) {
      b.userData.ang += b.userData.spd * dt * 0.5;
      b.userData.flap += dt * 7;
      const a = b.userData.ang;
      b.position.x = Math.sin(a) * b.userData.rad;
      b.position.z = Math.cos(a) * b.userData.rad;
      b.position.y = b.userData.h + Math.sin(b.userData.flap) * 0.8;
      b.rotation.y = -a;
      const flap = Math.sin(b.userData.flap) * 0.7;
      b.children[0].rotation.z = flap;
      b.children[1].rotation.z = -flap;
    }
    // 太阳光晕呼吸
    sunSprite.material.opacity = 0.78 + Math.sin(time * 0.8) * 0.06;
  }

  return { scene, ground, update, sun };
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}
