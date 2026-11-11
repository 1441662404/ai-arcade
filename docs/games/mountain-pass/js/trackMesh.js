/**
 * 場景幾何：地形、路面、路肩、護欄、路燈、貓眼、防雪棚、樹林
 * 目標：夜間山路、車燈打光、絕不出現穿模
 */
import * as THREE from 'three';
import { ROAD, clamp } from './trackPath.js';

/* ------------------------------------------------------------------ */
/*  雜訊                                                              */
/* ------------------------------------------------------------------ */
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0x7fffffff) / 0x7fffffff;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/*  程序化貼圖                                                        */
/* ------------------------------------------------------------------ */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function asphaltTexture() {
  const S = 1024;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#2a2b2e';
  g.fillRect(0, 0, S, S);
  // 骨材顆粒
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    const grain = Math.random() < 0.06 ? 26 : 0;
    d[i] = clamp(d[i] + n + grain, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n + grain, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n * 1.1 + grain, 0, 255);
  }
  g.putImageData(img, 0, 0);
  // 補丁與油漬
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 18 + Math.random() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    grd.addColorStop(0, dark ? 'rgba(12,12,14,0.34)' : 'rgba(70,70,74,0.20)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // 輪跡（兩道較亮的拋光帶）
  for (const cx of [S * 0.22, S * 0.78]) {
    const grd = g.createLinearGradient(cx - 60, 0, cx + 60, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(150,150,160,0.055)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(cx - 60, 0, 120, S);
  }
  // 中央雙黃線
  const cx = S / 2;
  g.fillStyle = '#c8a52a';
  g.globalAlpha = 0.92;
  g.fillRect(cx - 11, 0, 6, S);
  g.fillRect(cx + 5, 0, 6, S);
  // 邊線
  g.fillStyle = '#cfd2d6';
  g.globalAlpha = 0.85;
  g.fillRect(S * 0.035, 0, 5, S);
  g.fillRect(S * 0.955, 0, 5, S);
  g.globalAlpha = 1;
  // 標線磨損
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    g.globalAlpha = Math.random() * 0.35;
    g.fillRect(x, y, 2 + Math.random() * 5, 2 + Math.random() * 10);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function concreteTexture(tint = '#6d6f72', lines = true) {
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = tint;
  g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] = clamp(d[i] + n, 0, 255); d[i + 1] = clamp(d[i + 1] + n, 0, 255); d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 6 + Math.random() * 40;
    g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.06})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  if (lines) {
    g.strokeStyle = 'rgba(0,0,0,0.28)';
    g.lineWidth = 2;
    for (let y = 0; y < S; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function rockTexture() {
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#3a3833';
  g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x * 0.06, y * 0.06, 5);
    const i = (y * S + x) * 4;
    const v = 26 + n * 74;
    d[i] = v * 1.02; d[i + 1] = v * 0.98; d[i + 2] = v * 0.88;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function grassTexture() {
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x * 0.05, y * 0.05, 4);
    const m = fbm(x * 0.3 + 30, y * 0.3 + 12, 3);
    const i = (y * S + x) * 4;
    d[i] = 18 + n * 26 + m * 10;
    d[i + 1] = 30 + n * 40 + m * 14;
    d[i + 2] = 16 + n * 20 + m * 8;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* 車燈光池（加算貼圖） */
function glowTexture(inner = 'rgba(255,240,205,1)', outer = 'rgba(255,200,120,0)') {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.45, 'rgba(255,225,170,0.42)');
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ */
/*  地形                                                              */
/* ------------------------------------------------------------------ */
function buildTerrain(track, lookup, opts) {
  const b = track.bounds;
  const margin = 420;
  const cell = opts.terrainCell || 6;
  const x0 = b.minX - margin, x1 = b.maxX + margin;
  const z0 = b.minZ - margin, z1 = b.maxZ + margin;
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;

  // 遠場參考點（稀疏取樣）
  const coarse = [];
  for (let i = 0; i < track.count; i += 12) coarse.push(track.samples[i]);

  const H = new Float32Array(nx * nz);
  const S = track.samples;

  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const near = lookup.samplesWithin(x, z, 60);
      let wsum = 0, ysum = 0, dmin = 1e9, yNear = 0;
      for (const s of near) {
        const p = S[s.i];
        const w = 1 / (s.d * s.d + 2.2);
        wsum += w; ysum += w * p.y;
        if (s.d < dmin) { dmin = s.d; yNear = p.y; }
      }
      let y;
      if (wsum > 0) {
        y = ysum / wsum;
      } else {
        // 遠場：大尺度包絡
        let w2 = 0, y2 = 0;
        for (const p of coarse) {
          const d = Math.hypot(p.x - x, p.z - z);
          const w = 1 / (d * d + 900);
          w2 += w; y2 += w * p.y;
        }
        y = y2 / w2;
      }
      // 遠近混合
      let w2 = 0, y2 = 0;
      for (const p of coarse) {
        const d = Math.hypot(p.x - x, p.z - z);
        const w = 1 / (d * d + 2200);
        w2 += w; y2 += w * p.y;
      }
      const farY = y2 / w2;
      const k = smoothstep(45, 150, dmin);
      y = y * (1 - k) + farY * k;

      // 山體起伏
      const amp = smoothstep(10, 120, dmin) * (14 + 26 * fbm(x * 0.0016, z * 0.0016, 3));
      y += (fbm(x * 0.008, z * 0.008, 5) - 0.5) * 2 * amp;
      y += (fbm(x * 0.045, z * 0.045, 3) - 0.5) * 2 * smoothstep(14, 60, dmin) * 1.6;

      // 貼近路面的走廊整平（確保不穿模）
      if (dmin < 7.0) {
        y = yNear - 0.16;
      } else if (dmin < 22) {
        const t = smoothstep(7.0, 22, dmin);
        y = (yNear - 0.16) * (1 - t) + y * t;
      }
      // 硬性夾制：任何接近路面的地形不得高於路面
      if (dmin < 11) y = Math.min(y, yNear - 0.22);
      H[j * nx + i] = y;
    }
  }

  const geo = new THREE.PlaneGeometry((nx - 1) * cell, (nz - 1) * cell, nx - 1, nz - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cRock = new THREE.Color('#4a4740');
  const cGrass = new THREE.Color('#2b3a24');
  const cDirt = new THREE.Color('#3a3226');
  const tmp = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const vx = x0 + i * cell, vz = z0 + j * cell;
      pos.setXYZ(idx, vx - (x0 + (nx - 1) * cell / 2), H[idx], vz - (z0 + (nz - 1) * cell / 2));
    }
  }
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  for (let idx = 0; idx < pos.count; idx++) {
    const slope = 1 - nrm.getY(idx);
    const t = clamp(slope * 2.4, 0, 1);
    tmp.copy(cGrass).lerp(cRock, t);
    if (slope < 0.12) tmp.lerp(cDirt, 0.25 * (1 - slope / 0.12));
    const v = 0.82 + 0.36 * fbm(pos.getX(idx) * 0.02, pos.getZ(idx) * 0.02, 2);
    colors[idx * 3] = tmp.r * v;
    colors[idx * 3 + 1] = tmp.g * v;
    colors[idx * 3 + 2] = tmp.b * v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const tex = grassTexture();
  tex.repeat.set(90, 90);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x0 + (nx - 1) * cell / 2, 0, z0 + (nz - 1) * cell / 2);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // 取樣函式
  function heightAt(x, z) {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    const i = clamp(Math.floor(fx), 0, nx - 2), j = clamp(Math.floor(fz), 0, nz - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const h00 = H[j * nx + i], h10 = H[j * nx + i + 1];
    const h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  function slopeAt(x, z) {
    const d = 4;
    const hx = heightAt(x + d, z) - heightAt(x - d, z);
    const hz = heightAt(x, z + d) - heightAt(x, z - d);
    return Math.hypot(hx, hz) / (2 * d);
  }
  return { mesh, heightAt, slopeAt, bounds: { x0, x1, z0, z1 }, nx, nz, cell };
}

/* ------------------------------------------------------------------ */
/*  路面                                                              */
/* ------------------------------------------------------------------ */
function buildRoad(track) {
  const S = track.samples;
  const n = S.length;
  const group = new THREE.Group();

  const cols = [
    { u: -ROAD.edge, y: 0.02, uv: 0.0 },
    { u: -ROAD.halfWidth, y: 0.055, uv: 0.045 },
    { u: -ROAD.halfWidth * 0.5, y: 0.0, uv: 0.27 },
    { u: 0, y: 0.0, uv: 0.5 },
    { u: ROAD.halfWidth * 0.5, y: 0.0, uv: 0.73 },
    { u: ROAD.halfWidth, y: 0.055, uv: 0.955 },
    { u: ROAD.edge, y: 0.02, uv: 1.0 },
  ];

  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < n; i++) {
    const p = S[i];
    const bankTan = Math.tan(p.bank);
    for (const c of cols) {
      const lat = c.u;
      const x = p.x + p.nx * lat;
      const z = p.z + p.nz * lat;
      const y = p.y + lat * bankTan + c.y;
      positions.push(x, y, z);
      uvs.push(c.uv, p.s / 9.0);
    }
  }
  const w = cols.length;
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < w - 1; c++) {
      const a = i * w + c, b = a + 1, d = (i + 1) * w + c, e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const asphalt = asphaltTexture();
  const mat = new THREE.MeshStandardMaterial({
    map: asphalt,
    // 夜裡的山路帶點濕氣：粗糙度壓低，路燈會在路上拉出長長的鏡面反光
    roughness: 0.30,
    metalness: 0.16,
    color: 0xffffff,
    envMapIntensity: 0.85,
  });
  const road = new THREE.Mesh(geo, mat);
  road.receiveShadow = true;
  road.name = 'road';
  group.add(road);

  return { group, road, cols };
}

/* 路肩 / 排水溝 */
function buildShoulders(track) {
  const S = track.samples;
  const n = S.length;
  const tex = concreteTexture('#5e6165');
  tex.repeat.set(1, 1);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.03, color: 0xb9bcc0 });
  const group = new THREE.Group();

  for (const side of [-1, 1]) {
    const positions = [], uvs = [], indices = [];
    const cols = side < 0
      ? [{ u: -ROAD.edge - 0.55, y: 0.02 }, { u: -ROAD.edge - 0.18, y: 0.13 }, { u: -ROAD.halfWidth, y: 0.055 }]
      : [{ u: ROAD.halfWidth, y: 0.055 }, { u: ROAD.edge + 0.18, y: 0.13 }, { u: ROAD.edge + 0.55, y: 0.02 }];
    for (let i = 0; i < n; i++) {
      const p = S[i];
      const bankTan = Math.tan(p.bank);
      for (const c of cols) {
        positions.push(p.x + p.nx * c.u, p.y + c.u * bankTan + c.y, p.z + p.nz * c.u);
        uvs.push((c.u + 6) * 0.4, p.s * 0.5);
      }
    }
    const w = 3;
    for (let i = 0; i < n - 1; i++) {
      for (let c = 0; c < w - 1; c++) {
        const a = i * w + c, b = a + 1, d = (i + 1) * w + c, e = d + 1;
        if (side > 0) indices.push(a, d, b, b, d, e);
        else indices.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

/* ------------------------------------------------------------------ */
/*  護欄 / 擋土牆 / 路燈 / 貓眼                                        */
/* ------------------------------------------------------------------ */
function buildRoadside(track, terrain, lookup) {
  const S = track.samples;
  const n = S.length;
  const group = new THREE.Group();

  // 判定每一側是「谷側（需護欄）」還是「山側（需擋土牆）」
  const sideInfo = S.map((p) => {
    const probe = 11;
    const hl = terrain.heightAt(p.x + p.nx * probe, p.z + p.nz * probe);
    const hr = terrain.heightAt(p.x - p.nx * probe, p.z - p.nz * probe);
    const dl = hl - p.y, dr = hr - p.y;
    return {
      left: dl < -1.6 ? 'guard' : dl > 1.4 ? 'wall' : 'none',
      right: dr < -1.6 ? 'guard' : dr > 1.4 ? 'wall' : 'none',
      dl, dr,
    };
  });

  /* ---- 護欄（W 型鋼板 + 立柱） ---- */
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.42, metalness: 0.72 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5c6064, roughness: 0.6, metalness: 0.5 });
  const railGeos = [];
  for (const side of [-1, 1]) {
    let run = [];
    const flush = () => {
      if (run.length < 3) { run = []; return; }
      // 兩條水平帶
      for (const band of [{ y0: 0.52, y1: 0.72, off: 0.0 }, { y0: 0.74, y1: 0.92, off: 0.02 }]) {
        const positions = [], indices = [], uvs = [];
        run.forEach((p, k) => {
          const lat = side * (ROAD.edge + 0.22);
          const bankTan = Math.tan(p.bank);
          const bx = p.x + p.nx * lat, bz = p.z + p.nz * lat;
          const by = p.y + lat * bankTan;
          const ox = p.nx * side * band.off, oz = p.nz * side * band.off;
          positions.push(bx + ox, by + band.y0, bz + oz);
          positions.push(bx + ox + p.nx * side * 0.06, by + (band.y0 + band.y1) / 2 + 0.03, bz + oz + p.nz * side * 0.06);
          positions.push(bx + ox, by + band.y1, bz + oz);
          uvs.push(0, p.s * 0.3, 0.5, p.s * 0.3, 1, p.s * 0.3);
        });
        for (let k = 0; k < run.length - 1; k++) {
          const a = k * 3, b = (k + 1) * 3;
          if (side > 0) { indices.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); }
          else { indices.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.setIndex(indices);
        g.computeVertexNormals();
        railGeos.push(g);
      }
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const kind = side < 0 ? sideInfo[i].left : sideInfo[i].right;
      if (kind === 'guard') run.push(S[i]);
      else flush();
    }
    flush();
  }
  for (const g of railGeos) {
    const m = new THREE.Mesh(g, railMat);
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
  }

  /* ---- 立柱 ---- */
  const postGeo = new THREE.BoxGeometry(0.12, 0.95, 0.12);
  postGeo.translate(0, 0.475, 0);
  const postCount = Math.ceil(n / 2) * 2;
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
  const dummy = new THREE.Object3D();
  let pi = 0;
  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      const kind = side < 0 ? sideInfo[i].left : sideInfo[i].right;
      if (kind !== 'guard') continue;
      const p = S[i];
      const lat = side * (ROAD.edge + 0.22);
      dummy.position.set(p.x + p.nx * lat, p.y + lat * Math.tan(p.bank), p.z + p.nz * lat);
      dummy.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
      dummy.updateMatrix();
      if (pi < postCount) posts.setMatrixAt(pi++, dummy.matrix);
    }
  }
  posts.count = pi;
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  /* ---- 擋土牆（山側） ---- */
  const wallMat = new THREE.MeshStandardMaterial({ map: concreteTexture('#585a5c', false), roughness: 0.9, metalness: 0.02, color: 0x8d9094 });
  wallMat.map.repeat.set(1, 1);
  const wallGeos = [];
  for (const side of [-1, 1]) {
    let run = [];
    const flush = () => {
      if (run.length < 3) { run = []; return; }
      const positions = [], indices = [], uvs = [];
      run.forEach((p) => {
        const lat = side * (ROAD.edge + 0.15);
        const bankTan = Math.tan(p.bank);
        const bx = p.x + p.nx * lat, bz = p.z + p.nz * lat;
        const by = p.y + lat * bankTan;
        const h = 1.15;
        positions.push(bx, by - 0.1, bz);
        positions.push(bx, by + h, bz);
        positions.push(bx - p.nx * side * 0.35, by + h + 0.05, bz - p.nz * side * 0.35);
        uvs.push(p.s * 0.25, 0, p.s * 0.25, h * 0.6, p.s * 0.25, h * 0.6 + 0.3);
      });
      for (let k = 0; k < run.length - 1; k++) {
        const a = k * 3, b = (k + 1) * 3;
        if (side < 0) { indices.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); }
        else { indices.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(indices);
      g.computeVertexNormals();
      wallGeos.push(g);
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const kind = side < 0 ? sideInfo[i].left : sideInfo[i].right;
      if (kind === 'wall') run.push(S[i]);
      else flush();
    }
    flush();
  }
  for (const g of wallGeos) {
    const m = new THREE.Mesh(g, wallMat);
    m.receiveShadow = true;
    group.add(m);
  }

  /* ---- 路燈 ---- */
  const lampGroup = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.075, 0.11, 7.6, 6);
  poleGeo.translate(0, 3.8, 0);
  const armGeo = new THREE.CylinderGeometry(0.055, 0.055, 1.9, 5);
  armGeo.rotateZ(Math.PI / 2);
  const headGeo = new THREE.BoxGeometry(0.62, 0.13, 0.3);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3c4044, roughness: 0.7, metalness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffe6b0, emissive: 0xffd489, emissiveIntensity: 6.5, roughness: 0.4, metalness: 0,
  });

  const lampSpacing = 62;
  const lampEvery = Math.round(lampSpacing / track.step);
  const lampPositions = [];
  for (let i = 12; i < n - 12; i += lampEvery) {
    const p = S[i];
    // 選谷側或山側：優先谷側
    let side = sideInfo[i].left === 'guard' ? -1 : sideInfo[i].right === 'guard' ? 1 : (sideInfo[i].left === 'wall' ? 1 : -1);
    const lat = side * (ROAD.edge + 0.9);
    const bx = p.x + p.nx * lat, bz = p.z + p.nz * lat;
    const by = p.y + lat * Math.tan(p.bank);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(bx, by - 0.05, bz);
    pole.castShadow = false;
    lampGroup.add(pole);
    const arm = new THREE.Mesh(armGeo, poleMat);
    arm.position.set(bx - p.nx * side * 0.95, by + 7.55, bz - p.nz * side * 0.95);
    arm.rotation.y = Math.atan2(p.nx, p.nz) + Math.PI / 2;
    lampGroup.add(arm);
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(bx - p.nx * side * 1.8, by + 7.42, bz - p.nz * side * 1.8);
    head.rotation.y = Math.atan2(p.tx, p.tz);
    lampGroup.add(head);
    lampPositions.push(new THREE.Vector3(head.position.x, head.position.y, head.position.z));
  }
  group.add(lampGroup);

  /* ---- 貓眼反光標 ---- */
  const eyeGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.78, 5);
  eyeGeo.translate(0, 0.39, 0);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5, metalness: 0.2 });
  const capGeo = new THREE.SphereGeometry(0.075, 6, 5);
  const capMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff8a1e, emissiveIntensity: 3.2, roughness: 0.3 });
  const eyeStep = Math.round(11 / track.step);
  const maxEye = Math.ceil(n / eyeStep) * 2 + 4;
  const eyes = new THREE.InstancedMesh(eyeGeo, eyeMat, maxEye);
  const caps = new THREE.InstancedMesh(capGeo, capMat, maxEye);
  let ei = 0;
  for (let i = 0; i < n; i += eyeStep) {
    const p = S[i];
    for (const side of [-1, 1]) {
      const lat = side * (ROAD.edge + 0.42);
      dummy.position.set(p.x + p.nx * lat, p.y + lat * Math.tan(p.bank) - 0.02, p.z + p.nz * lat);
      dummy.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      if (ei < maxEye) {
        eyes.setMatrixAt(ei, dummy.matrix);
        dummy.position.y += 0.8;
        dummy.updateMatrix();
        caps.setMatrixAt(ei, dummy.matrix);
        ei++;
      }
    }
  }
  eyes.count = ei; caps.count = ei;
  eyes.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  group.add(eyes, caps);

  return { group, sideInfo, lampPositions };
}

/* ------------------------------------------------------------------ */
/*  防雪棚（隧道）                                                     */
/* ------------------------------------------------------------------ */
function buildGallery(track, range) {
  const S = track.samples;
  const from = range.from, to = range.to;
  const group = new THREE.Group();
  const inner = 5.4;      // 內淨半寬
  const height = 4.3;     // 側牆高
  const archR = inner;    // 拱半徑

  // 剖面：左牆底 → 左牆頂 → 拱 → 右牆頂 → 右牆底
  const profile = [];
  profile.push({ u: -inner, y: 0 });
  profile.push({ u: -inner, y: height });
  const SEG = 14;
  for (let k = 1; k < SEG; k++) {
    const a = Math.PI - (Math.PI * k) / SEG;
    profile.push({ u: Math.cos(a) * archR, y: height + Math.sin(a) * archR * 0.92 });
  }
  profile.push({ u: inner, y: height });
  profile.push({ u: inner, y: 0 });

  const positions = [], uvs = [], indices = [];
  let row = 0;
  for (let i = from; i <= to; i++) {
    const p = S[i];
    for (const c of profile) {
      positions.push(p.x + p.nx * c.u, p.y + c.u * Math.tan(p.bank) + c.y, p.z + p.nz * c.u);
      uvs.push((c.u + inner) / (inner * 2), p.s * 0.12);
    }
    row++;
  }
  const w = profile.length;
  for (let i = 0; i < row - 1; i++) {
    for (let c = 0; c < w - 1; c++) {
      const a = i * w + c, b = a + 1, d = (i + 1) * w + c, e = d + 1;
      indices.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const tex = concreteTexture('#4e5052', true);
  tex.repeat.set(1, 1);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: 0x8b8f93, roughness: 0.88, metalness: 0.05, side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.receiveShadow = true;
  group.add(shell);

  // 入口框
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x35383b, roughness: 0.8, metalness: 0.3 });
  for (const idx of [from, to]) {
    const p = S[idx];
    const ring = [];
    for (const c of profile) ring.push(new THREE.Vector3(p.x + p.nx * (c.u * 1.06), p.y + c.y, p.z + p.nz * (c.u * 1.06)));
    const curve = new THREE.CatmullRomCurve3(ring);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.22, 6, false), frameMat);
    group.add(tube);
  }

  // 內部燈帶
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  const lampSpacing = Math.round(9 / track.step);
  for (let i = from + 4; i < to - 2; i += lampSpacing) {
    const p = S[i];
    for (const side of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.16), lightMat);
      bar.position.set(p.x + p.nx * side * (inner - 0.5), p.y + height - 0.15, p.z + p.nz * side * (inner - 0.5));
      bar.rotation.y = Math.atan2(p.tx, p.tz);
      group.add(bar);
    }
  }

  return group;
}

/* ------------------------------------------------------------------ */
/*  樹林                                                              */
/* ------------------------------------------------------------------ */
function buildTrees(track, terrain, lookup) {
  const treeGeo = (() => {
    const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 5);
    trunk.translate(0, 1.2, 0);
    const parts = [trunk];
    for (let k = 0; k < 3; k++) {
      const r = 2.1 - k * 0.55;
      const h = 3.2 - k * 0.4;
      const cone = new THREE.ConeGeometry(r, h, 7);
      cone.translate(0, 2.6 + k * 2.0 + h / 2 - 0.6, 0);
      parts.push(cone);
    }
    const merged = mergeGeometries(parts);
    return merged;
  })();

  const mat = new THREE.MeshStandardMaterial({ color: 0x22301c, roughness: 0.95, metalness: 0, flatShading: true });
  const b = track.bounds;
  const COUNT = 2600;
  const inst = new THREE.InstancedMesh(treeGeo, mat, COUNT);
  const dummy = new THREE.Object3D();
  let placed = 0, tries = 0;
  const margin = 260;
  while (placed < COUNT && tries < COUNT * 30) {
    tries++;
    const x = b.minX - margin + Math.random() * (b.maxX - b.minX + margin * 2);
    const z = b.minZ - margin + Math.random() * (b.maxZ - b.minZ + margin * 2);
    const near = lookup.samplesWithin(x, z, 26);
    if (near.length) continue; // 太靠近路面
    const far = lookup.samplesWithin(x, z, 190);
    if (!far.length && Math.random() > 0.25) continue;
    const h = terrain.heightAt(x, z);
    if (h > 300 || h < -20) continue;
    const slope = terrain.slopeAt(x, z);
    if (slope > 0.95) continue;
    if (fbm(x * 0.004, z * 0.004, 3) < 0.34) continue;
    dummy.position.set(x, h - 0.3, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    const s = 0.7 + Math.random() * 0.9;
    dummy.scale.set(s * (0.85 + Math.random() * 0.3), s * (0.9 + Math.random() * 0.5), s * (0.85 + Math.random() * 0.3));
    dummy.updateMatrix();
    inst.setMatrixAt(placed++, dummy.matrix);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = false;
  inst.receiveShadow = false;
  return inst;
}

/* 簡易幾何合併（避免額外依賴） */
function mergeGeometries(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const nAttr = g.attributes.normal ? g.attributes.normal.array : null;
    pos.set(p, vo * 3);
    if (nAttr) nor.set(nAttr, vo * 3);
    const gi = g.index ? g.index.array : null;
    if (gi) { for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo; io += gi.length; }
    else { for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = i + vo; io += g.attributes.position.count; }
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* ------------------------------------------------------------------ */
/*  主入口                                                            */
/* ------------------------------------------------------------------ */
export function buildTrackScene(track, lookup, opts = {}) {
  const group = new THREE.Group();
  group.name = 'track';

  const terrain = buildTerrain(track, lookup, opts);
  group.add(terrain.mesh);

  const road = buildRoad(track);
  group.add(road.group);

  const shoulders = buildShoulders(track);
  group.add(shoulders);

  const roadside = buildRoadside(track, terrain, lookup);
  group.add(roadside.group);

  for (const g of track.galleries) {
    group.add(buildGallery(track, g));
  }

  const trees = buildTrees(track, terrain, lookup);
  group.add(trees);

  return {
    group,
    terrain,
    lampPositions: roadside.lampPositions,
    sideInfo: roadside.sideInfo,
    glow: glowTexture(),
  };
}

export { glowTexture, asphaltTexture, concreteTexture, rockTexture };
