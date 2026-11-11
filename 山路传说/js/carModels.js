/**
 * 車輛模型：載入、正規化、輪胎骨架、車燈
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

const GLASS_RE = /glass|window/i;
const TIRE_RE = /tire|tyre|wheel|rim|rotor/i;
const BODY_RE = /basic|body|paint|exterior_mm_ext/i;
const TAIL_RE = /taillight|tail_light|light_rear|rear_light|brake.*light/i;
const HEAD_RE = /headlight|head_light|light_head|fog_light/i;
const JUNK_RE = /^(floor|ground|plane|shadow|base|backdrop)$/i;
const JUNK_MESH_RE = /^(floor|ground|plane|shadow|backdrop)[_ ]|_floor_|floor_material/i;

function loadGLB(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve, reject) => {
    loader.load(url, (g) => resolve(g), undefined, (e) => reject(e));
  });
  cache.set(url, p);
  return p;
}

/**
 * 建立一台可駕駛的車
 * @returns {Promise<{root:THREE.Group, wheels:Array, brakeMeshes:Array, size:object}>}
 */
export async function createCar(spec, opts = {}) {
  const gltf = await loadGLB(spec.model);
  // 每次建立獨立副本（幾何共用快取，材質各自複製），避免切換車輛時互相污染
  const src = gltf.scene.clone(true);
  src.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    }
  });

  // 有些模型（FC3S）是 KHR_materials_unlit：顏色塞在 emissiveFactor、baseColor 為純黑，
  // GLTFLoader 會給出全黑的 MeshBasicMaterial。轉成受光材質，夜裡才有明暗。
  const srcMats = gltf.parser?.json?.materials || [];
  if (srcMats.length) {
    src.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.isMeshBasicMaterial) return;
      const m = o.material;
      if (m.map) return; // 有貼圖的基本材質不動
      const jm = srcMats.find((x) => x.name === m.name);
      const ef = jm?.emissiveFactor;
      if (!ef) return;
      const col = new THREE.Color().setRGB(ef[0], ef[1], ef[2], THREE.LinearSRGBColorSpace);
      const nm = new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.44,
        metalness: 0.30,
        side: m.side,
        transparent: m.transparent,
        opacity: m.opacity,
      });
      nm.name = m.name;
      o.material = nm;
      m.dispose();
    });
  }

  // --- 清理與材質調整 ---
  const removeList = [];
  src.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
      const m = o.material;
      if (m) {
        const name = (m.name || '') + '|' + (o.name || '');
        if (GLASS_RE.test(name)) {
          m.transparent = true;
          m.opacity = 0.62;
          m.roughness = 0.08;
          m.metalness = 0.35;
          m.color = new THREE.Color(0x0b1014);
          m.envMapIntensity = 1.6;
          m.depthWrite = false;
        } else if (TIRE_RE.test(m.name || '')) {
          m.roughness = Math.min(1, (m.roughness ?? 0.9) * 1.05);
          m.metalness = 0.05;
          m.color = new THREE.Color(0x141416);
        } else {
          m.envMapIntensity = 1.15;
          if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.75);
          if (m.roughness !== undefined) m.roughness = Math.max(0.12, Math.min(0.92, m.roughness));
        }
        if (m.map) m.map.anisotropy = 8;
        m.shadowSide = THREE.FrontSide;
        // 夜間反射：車漆、玻璃、輪框都吃環境貼圖
        if (opts.envMap) {
          m.envMap = opts.envMap;
          m.envMapIntensity = GLASS_RE.test(name) ? 1.7 : 1.25;
          m.needsUpdate = true;
        }
      }
      // 展台地板 / 陰影板等雜物
      if (JUNK_MESH_RE.test((o.name || '').trim())) removeList.push(o);
    }
  });
  // 具名為 Floor / Ground 的整個節點群組
  const junkGroups = [];
  src.traverse((o) => {
    if (!o.isMesh && JUNK_RE.test((o.name || '').trim())) junkGroups.push(o);
  });
  removeList.push(...junkGroups);
  for (const o of removeList) o.parent && o.parent.remove(o);

  // --- 正規化：旋轉、縮放、落地 ---
  const fix = new THREE.Group();
  fix.add(src);
  if (spec.modelRot) {
    fix.rotation.set(spec.modelRot[0], spec.modelRot[1], spec.modelRot[2], 'YXZ');
  } else {
    fix.rotation.y = spec.modelRotY || 0;
  }
  fix.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(fix);
  let size = box.getSize(new THREE.Vector3());
  const lengthAxis = Math.max(size.x, size.z);
  const scale = spec.bodyLength / Math.max(0.001, lengthAxis);
  fix.scale.setScalar(scale);
  fix.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(fix);
  size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 讓車體中心落在原點、輪底貼地。
  // 偏移量是世界座標，需先轉回 src 的區域座標（模型可能已被旋轉）。
  const invQ = fix.quaternion.clone().invert();
  const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z)
    .applyQuaternion(invQ)
    .divideScalar(scale);
  src.position.add(offset);
  fix.updateMatrixWorld(true);

  const root = new THREE.Group();
  root.add(fix);
  root.updateMatrixWorld(true);

  // --- 輪胎骨架 ---
  const rig = rigWheels(src, fix, spec);
  fix.updateMatrixWorld(true);

  // --- 車燈錨點 ---
  const halfLen = spec.bodyLength / 2;
  const headY = 0.62;
  const headZ = halfLen - 0.16;
  const headX = Math.min(0.78, spec.track / 2 - 0.02);

  const headlights = [
    new THREE.Vector3(-headX, headY, headZ),
    new THREE.Vector3(headX, headY, headZ),
  ];
  const taillights = [
    new THREE.Vector3(-headX, 0.66, -halfLen + 0.08),
    new THREE.Vector3(headX, 0.66, -halfLen + 0.08),
  ];

  // --- 煞車燈材質收集 ---
  const brakeMeshes = [];
  const headMeshes = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    // 名稱可能掛在父層群組（LOD_A_TAILLIGHT_LENS_LEFT_mm_windows_4 → Object_21），
    // 所以要把祖先鏈一起拼進來判斷。
    const path = nodePath(o) + '|' + (o.material?.name || '');
    if (TAIL_RE.test(path)) {
      if (o.material) {
        o.material = o.material.clone();
        o.material.emissive = new THREE.Color(0xff1a08);
        o.material.emissiveIntensity = 0.55;
        o.material.toneMapped = true;
        brakeMeshes.push(o);
      }
    }
    if (HEAD_RE.test(path)) {
      if (o.material) {
        o.material = o.material.clone();
        o.material.emissive = new THREE.Color(0xffe9c0);
        o.material.emissiveIntensity = 0.9;
        headMeshes.push(o);
      }
    }
  });

  return { root, wheels: rig.wheels, brakeMeshes, headMeshes, size, scale, fix, src, headlights, taillights };
}

/** 把節點與祖先的名稱串起來，最多上溯 8 層 */
function nodePath(o) {
  let s = '';
  let n = o;
  let guard = 0;
  while (n && guard++ < 8) {
    s += (n.name || '') + '|';
    n = n.parent;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/*  輪胎骨架                                                          */
/* ------------------------------------------------------------------ */
function rigWheels(src, fix, spec) {
  const wheels = [];

  // 策略 A：具名節點（FL / FR / RL / RR）
  const named = [];
  src.traverse((o) => {
    const n = (o.name || '').trim();
    if (/^(FL|FR|RL|RR)$/.test(n)) named.push(o);
  });

  if (named.length >= 4) {
    for (const corner of named) {
      let spinNode = null;
      corner.traverse((o) => {
        const n = (o.name || '').trim();
        if (!spinNode && /^wheel(_\d+)?$/i.test(n)) spinNode = o;
      });
      if (!spinNode) continue;
      const w = makeWheel(spinNode, fix, spec);
      if (w) wheels.push(w);
    }
  }

  // 策略 A2：wheel / wheel_1 / wheel_2 / wheel_3（FR-86 這種骨架命名）
  if (wheels.length < 4) {
    const wnodes = [];
    src.traverse((o) => {
      if (/^wheel(_\d+)?$/i.test((o.name || '').trim())) wnodes.push(o);
    });
    if (wnodes.length >= 4) {
      const cand = [];
      for (const wn of wnodes.slice(0, 4)) {
        const w = makeWheel(wn, fix, spec);
        if (w) cand.push(w);
      }
      if (cand.length >= 4) { wheels.length = 0; wheels.push(...cand); }
    }
  }

  // 策略 B：依材質拆分（輪胎/輪框為獨立材質，但四輪合併在同一網格）
  if (wheels.length < 4) {
    const split = splitWheelsByMaterial(src, fix);
    if (split.length >= 4) {
      wheels.length = 0;
      wheels.push(...split);
    }
  }

  // 策略 C：依幾何位置拆分（FC3S 這種輪子烘進車身、材質名也看不出來的模型）
  if (wheels.length < 4) {
    const split = splitWheelsByGeometry(src, fix, spec);
    if (split.length >= 4) {
      wheels.length = 0;
      wheels.push(...split);
    }
  }

  // ---- 車體軸向（fix 局部系）----
  // FC 是 Z-up 匯出、帶 modelRot，它的「車長方向」在 fix 局部系是 X 而不是 Z。
  // 一律換算，不能用寫死的 z 判斷前後輪。
  fix.updateMatrixWorld(true);
  const qFix = fix.quaternion.clone().invert();
  const axFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qFix);
  const axUp = new THREE.Vector3(0, 1, 0).applyQuaternion(qFix);

  // 統一量測輪胎半徑 + 偵測輪軸
  for (const w of wheels) {
    fix.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(w.spin);
    const s = box.getSize(new THREE.Vector3());
    // 世界系最小的那根軸就是輪軸（輪胎是扁的）
    const axWorld = new THREE.Vector3(1, 0, 0);
    if (s.y < s.x && s.y <= s.z) axWorld.set(0, 1, 0);
    else if (s.z < s.x && s.z <= s.y) axWorld.set(0, 0, 1);
    w.axle = axWorld.applyQuaternion(qFix).normalize();
    w.up = axUp.clone();
    const r = Math.max(s.y, s.z) / 2;
    // 模型比例差異很大（R33 的整體縮放是 3.9），量到的值太離譜時用規格值兜底
    w.radius = (r > spec.wheelRadius * 0.45 && r < spec.wheelRadius * 2.2) ? r : spec.wheelRadius;
  }

  // 分前後 + 補轉向軸
  for (const w of wheels) {
    const back = w.localCenter.dot(axFwd) < 0;
    w.isFront = !back;
    if (!w.steer) {
      w.steer = back ? null : makeSteerPivot(w);
    }
  }

  return { wheels };
}

/**
 * 量測輪子的真實幾何中心，在那裡插一層純位移 pivot，再把輪子節點掛進去。
 *
 * 為什麼不能直接用節點自身的 origin：FR-86 的 wheel / wheel_1 節點原點偏離輪心
 * 0.36m，繞著它旋轉輪子會整個甩出去。FD 的節點剛好在輪心，所以看不出問題。
 * 一律重算軸心，兩種模型就都對了。
 */
function makeWheel(node, fix, spec) {
  fix.updateMatrixWorld(true);

  // 一律在 fix 的區域座標系量測（fix 可能帶 modelRot 旋轉，世界座標不是車體座標系）
  const toLocal = fix.matrixWorld.clone().invert();
  const box = boxInSpace(node, toLocal);
  if (!box || box.isEmpty()) return null;
  const localCenter = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const spin = new THREE.Group();
  spin.name = 'wheelPivot_' + (node.name || '');
  spin.position.copy(localCenter);
  fix.add(spin);
  fix.updateMatrixWorld(true);

  // attach 保留世界變換，輪子在視覺上原地不動，只是換了個旋轉中心
  spin.attach(node);

  // 車體軸向（在 fix 區域座標裡）
  const q = fix.quaternion.clone().invert();
  const axUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const axFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);

  // 車輪是扁的：三個軸向中尺寸最小的那根就是輪軸
  const arr = [size.x, size.y, size.z];
  let axle = 0;
  if (arr[1] < arr[axle]) axle = 1;
  if (arr[2] < arr[axle]) axle = 2;

  return {
    spin, steer: null, node,
    localCenter, size,
    axle: new THREE.Vector3(axle === 0 ? 1 : 0, axle === 1 ? 1 : 0, axle === 2 ? 1 : 0),
    up: axUp.clone(),
    forward: axFwd.clone(),
    angle: 0,
  };
}

/** 對任意 node 求「指定空間」下的軸對齊包圍盒 */
function boxInSpace(node, toSpace) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let n = 0;
  node.updateWorldMatrix(true, true);
  node.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;
    const m = new THREE.Matrix4().multiplyMatrices(toSpace, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      box.expandByPoint(v);
    }
    n++;
  });
  return n ? box : null;
}

/** 在既有 spin pivot 外再套一層轉向 pivot（同一個輪心，繞 Y 轉） */
function makeSteerPivot(w) {
  const parent = w.spin.parent;
  if (!parent) return null;
  const g = new THREE.Group();
  g.name = 'steerPivot_' + (w.node?.name || '');
  g.position.copy(w.spin.position);
  parent.add(g);
  w.spin.position.set(0, 0, 0);
  g.add(w.spin);
  return g;
}

/** 在節點位置插入一個純位移的 pivot，讓旋轉不受原節點旋轉影響 */
function wrapPivot(node) {
  const parent = node.parent;
  if (!parent) return node;
  const g = new THREE.Group();
  g.name = 'pivot_' + (node.name || '');
  g.position.copy(node.position);
  parent.add(g);
  node.position.set(0, 0, 0);
  g.add(node);
  return g;
}


/* ------------------------------------------------------------------ */
/*  策略 C：依幾何位置拆分輪胎                                          */
/*  用於 FC3S 這類「輪子烘進車身、材質名也看不出來」的模型。              */
/*  以推定的輪心為球心收集三角形，只取輪胎本體，避開翼子板與側裙。        */
/* ------------------------------------------------------------------ */
function splitWheelsByGeometry(src, fix, spec) {
  fix.updateMatrixWorld(true);
  const toLocal = fix.matrixWorld.clone().invert();
  const v = new THREE.Vector3();

  // 收集所有三角形（fix 局部系），並記住來源網格
  const tris = [];
  const meshes = [];
  fix.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const pos = g.attributes.position;
    const m = toLocal.clone().multiply(o.matrixWorld);
    const base = tris.length;
    for (let i = 0; i < pos.count; i += 3) {
      const t = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, i + k).applyMatrix4(m);
        t.push(v.clone());
      }
      tris.push({ v: t, mat: o.material, mesh: o });
    }
    meshes.push({ mesh: o, base, count: pos.count / 3, geo: o.geometry });
    g.dispose();
  });
  if (tris.length < 40) return [];

  // 全車包圍盒
  const all = new THREE.Box3();
  for (const t of tris) for (const p of t.v) all.expandByPoint(p);
  const c = all.getCenter(new THREE.Vector3());
  const size = all.getSize(new THREE.Vector3());

  // 車體軸向（fix 局部系）
  const q = fix.quaternion.clone().invert();
  const axFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const axLat = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const L = Math.abs(size.x * axFwd.x) + Math.abs(size.y * axFwd.y) + Math.abs(size.z * axFwd.z);
  const W = Math.abs(size.x * axLat.x) + Math.abs(size.y * axLat.y) + Math.abs(size.z * axLat.z);

  const U = 1 / Math.max(1e-6, fix.scale.x);   // 每米對應多少模型單位
  const R = spec.wheelRadius * U;
  const frontOff = Math.max(0.5 * U, L / 2 - 0.95 * U);
  const latOff = Math.max(0.3 * U, W / 2 - 0.12 * U);

  // 四個推定輪心
  const centers = [];
  for (const fs of [1, -1]) for (const ls of [1, -1]) {
    const p = c.clone().addScaledVector(axFwd, fs * frontOff).addScaledVector(axLat, ls * latOff);
    p.y = all.min.y + R;
    centers.push(p);
  }

  // 球形判定：重心落進某個輪心球的三角形屬於該輪
  const buckets = centers.map(() => []);
  const pickR2 = (R * 1.05) ** 2;
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    const cx = (t.v[0].x + t.v[1].x + t.v[2].x) / 3;
    const cy = (t.v[0].y + t.v[1].y + t.v[2].y) / 3;
    const cz = (t.v[0].z + t.v[1].z + t.v[2].z) / 3;
    let best = -1, bd = pickR2;
    for (let i = 0; i < centers.length; i++) {
      const p = centers[i];
      const d = (cx - p.x) ** 2 + (cy - p.y) ** 2 + (cz - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) buckets[best].push(ti);
  }

  const out = [];
  for (let i = 0; i < buckets.length; i++) {
    const list = buckets[i];
    if (list.length < 12) continue;
    const box = new THREE.Box3();
    for (const ti of list) for (const p of tris[ti].v) box.expandByPoint(p);
    const center = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.name = 'wheelPivot_geo' + i;
    pivot.position.copy(center);
    fix.add(pivot);

    // 依材質分組重建
    const byMat = new Map();
    for (const ti of list) {
      const m = tris[ti].mat;
      if (!byMat.has(m)) byMat.set(m, []);
      byMat.get(m).push(tris[ti]);
    }
    for (const [mat, arr] of byMat) {
      const verts = new Float32Array(arr.length * 9);
      let o = 0;
      for (const t of arr) for (let k = 0; k < 3; k++) {
        verts[o++] = t.v[k].x - center.x;
        verts[o++] = t.v[k].y - center.y;
        verts[o++] = t.v[k].z - center.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
    }
    out.push({
      spin: pivot, steer: null, node: pivot,
      localCenter: center.clone(),
      radius: Math.max(sz.x, sz.y, sz.z) / 2,
      size: sz,
    });
  }
  if (out.length < 4) return [];

  // ---- 把拆走的三角形從原網格中剔除（車身其餘部分要留著）----
  const drop = new Set();
  for (const list of buckets) for (const ti of list) drop.add(ti);
  for (const rec of meshes) {
    const keep = [];
    for (let i = 0; i < rec.count; i++) if (!drop.has(rec.base + i)) keep.push(i);
    if (keep.length === rec.count) continue;         // 這個網格沒被拆到
    const srcGeo = rec.geo;
    const flat = srcGeo.index ? srcGeo.toNonIndexed() : srcGeo;
    const pos = flat.attributes.position;
    const nrm = flat.attributes.normal;
    const uv = flat.attributes.uv;
    const verts = new Float32Array(keep.length * 9);
    const norms = nrm ? new Float32Array(keep.length * 9) : null;
    const uvs = uv ? new Float32Array(keep.length * 6) : null;
    let o = 0, o2 = 0, o3 = 0;
    for (const i of keep) {
      for (let k = 0; k < 3; k++) {
        verts[o++] = pos.getX(i * 3 + k);
        verts[o++] = pos.getY(i * 3 + k);
        verts[o++] = pos.getZ(i * 3 + k);
      }
      if (norms) for (let k = 0; k < 3; k++) {
        norms[o2++] = nrm.getX(i * 3 + k);
        norms[o2++] = nrm.getY(i * 3 + k);
        norms[o2++] = nrm.getZ(i * 3 + k);
      }
      if (uv) for (let k = 0; k < 3; k++) {
        uvs[o3++] = uv.getX(i * 3 + k);
        uvs[o3++] = uv.getY(i * 3 + k);
      }
    }
    if (flat !== srcGeo) flat.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    if (norms) geo.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (!norms) geo.computeVertexNormals();
    geo.computeBoundingSphere();
    rec.mesh.geometry = geo;
  }
  return out;
}

/** 把輪胎材質的網格依象限拆成四份，各自掛到輪心 pivot */
function splitWheelsByMaterial(src, fix) {
  const meshes = [];
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mname = (o.material?.name || '') + '|' + (o.name || '');
    if (/tire|tyre|wheel|rim/i.test(mname) && !/steering_wheel|steer/i.test(mname)) meshes.push(o);
  });
  if (!meshes.length) return [];

  // 全部換算到 fix 的區域座標系（fix 帶旋轉與縮放，不能用世界座標直接當局部座標）
  fix.updateMatrixWorld(true);
  const toLocal = fix.matrixWorld.clone().invert();
  const tris = [];
  for (const o of meshes) {
    o.updateWorldMatrix(true, false);
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const pos = g.attributes.position;
    const mat = o.material;
    const m = new THREE.Matrix4().multiplyMatrices(toLocal, o.matrixWorld);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, i + k).applyMatrix4(m);
        tri.push(v.clone());
      }
      tris.push({ v: tri, mat });
    }
    g.dispose();
  }
  if (!tris.length) return [];

  // 以整車包圍盒中心為原點分象限
  const allBox = new THREE.Box3();
  for (const t of tris) for (const p of t.v) allBox.expandByPoint(p);
  const c = allBox.getCenter(new THREE.Vector3());

  const buckets = [[], [], [], []];
  for (const t of tris) {
    const cx = (t.v[0].x + t.v[1].x + t.v[2].x) / 3;
    const cz = (t.v[0].z + t.v[1].z + t.v[2].z) / 3;
    const ix = cx > c.x ? 1 : 0;
    const iz = cz > c.z ? 1 : 0;
    buckets[iz * 2 + ix].push(t);
  }

  const out = [];
  for (let bi = 0; bi < 4; bi++) {
    const list = buckets[bi];
    if (list.length < 4) continue;
    // 依材質分組建立幾何
    const byMat = new Map();
    for (const t of list) {
      if (!byMat.has(t.mat)) byMat.set(t.mat, []);
      byMat.get(t.mat).push(t);
    }
    // 輪心（區域座標）
    const box = new THREE.Box3();
    for (const t of list) for (const p of t.v) box.expandByPoint(p);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.name = 'wheelPivot_split' + bi;
    pivot.position.copy(center);
    fix.add(pivot);

    for (const [mat, arr] of byMat) {
      const verts = new Float32Array(arr.length * 9);
      let o = 0;
      for (const t of arr) {
        for (let k = 0; k < 3; k++) {
          verts[o++] = t.v[k].x - center.x;
          verts[o++] = t.v[k].y - center.y;
          verts[o++] = t.v[k].z - center.z;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
    }
    out.push({
      spin: pivot, steer: null, node: pivot,
      radius: Math.max(size.y, size.z) / 2 || 0.32,
      localCenter: center,
      size,
    });
  }

  // 移除原輪胎網格
  for (const o of meshes) if (o.parent) o.parent.remove(o);

  // 依 x/z 排序成 FL FR RL RR（模型座標：+Z 前、+X 左）
  out.sort((a, b) => (b.spin.position.z - a.spin.position.z) || (b.spin.position.x - a.spin.position.x));
  return out;
}

/* ------------------------------------------------------------------ */
/*  車燈                                                              */
/* ------------------------------------------------------------------ */
export function attachHeadlights(car, opts = {}) {
  const group = new THREE.Group();
  const spots = [];
  const intensity = opts.intensity ?? 380;
  for (const p of car.headlights) {
    const s = new THREE.SpotLight(0xfff0d0, intensity, 85, 0.48, 0.8, 1.9);
    s.position.copy(p);
    s.target.position.set(p.x * 1.5, 0.1, p.z + 26);
    s.castShadow = false;
    group.add(s, s.target);
    spots.push(s);
  }
  // 燈罩光暈
  const glowTex = makeGlow();
  for (const p of car.headlights) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffeccb, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sp.position.copy(p);
    sp.scale.setScalar(0.55);
    group.add(sp);
  }
  car.root.add(group);
  car.headlightSpots = spots;
  car.headlightGroup = group;
  car.headlightBase = intensity;
  return group;
}

export function attachTaillights(car) {
  const glowTex = makeGlow();
  const g = new THREE.Group();
  for (const p of car.taillights) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff2a10, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sp.position.copy(p);
    sp.scale.setScalar(0.6);
    g.add(sp);
  }
  car.root.add(g);
  car.tailGlow = g;
  return g;
}

let _glow = null;
function makeGlow() {
  if (_glow) return _glow;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, S, S);
  _glow = new THREE.CanvasTexture(c);
  _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

/** 每幀更新輪胎轉動與轉向 */
export function updateWheels(car, spinDelta, steerAngle) {
  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i];
    if (w.spin) {
      // 繞檢測出的輪軸轉（spinDelta 為正 = 向前滾）
      const ax = w.axle || new THREE.Vector3(1, 0, 0);
      w.spin.rotateOnAxis(ax, spinDelta[i] || 0);
    }
    if (w.steer) w.steer.rotation.y = steerAngle;
  }
}
