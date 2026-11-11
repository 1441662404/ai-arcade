/* =============================================================================
 * hd-clouds.js —— 体积感云团
 *   · 每朵云由 6~10 个朝向相机的 puff 组成，整体呈扁椭球（积云形态）
 *   · InstancedBufferGeometry：全部云 1 个 draw call
 *   · 每个 puff 按球面法线与太阳夹角着色（向光面亮、背光面冷灰），底部压暗
 *   · 每 0.35s 按距离重排一次，保证半透明混合顺序正确，并优先保留近处云
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function makeCloudTexture(size) {
  const S = size || 128;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);

  // 主团 + 数个偏移小球：边缘不规则，避免“完美圆”的假感。
  // 注意不能开内部孔洞——半透明 puff 重叠时孔洞会变成硬边色块。
  const blobs = [
    [0.50, 0.50, 0.46, 0.92],
    [0.35, 0.44, 0.31, 0.52],
    [0.65, 0.46, 0.32, 0.50],
    [0.46, 0.33, 0.28, 0.46],
    [0.56, 0.65, 0.27, 0.40],
    [0.29, 0.63, 0.23, 0.34]
  ];
  for (const [bx, by, br, ba] of blobs) {
    const x = bx * S, y = by * S, r = br * S;
    const rg = g.createRadialGradient(x, y, r * 0.02, x, y, r);
    rg.addColorStop(0.00, 'rgba(255,255,255,' + ba + ')');
    rg.addColorStop(0.62, 'rgba(255,255,255,' + (ba * 0.90) + ')');
    rg.addColorStop(0.86, 'rgba(255,255,255,' + (ba * 0.46) + ')');
    rg.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
  }

  const tex = new THREE.CanvasTexture(cv);
  if ('colorSpace' in tex) tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

export function createClouds(options) {
  const O = options || {};
  const count = O.count || 220;
  const puffsPer = O.puffsPer || 7;
  const MAX_PUFFS_PER_CLOUD = 34;
  // 缓冲区必须按“每朵云最多可能生成多少个 puff”来分配：
  // 否则写到数组末尾会静默丢弃，而 instanceCount 仍然按 nPuffs 提交，
  // GPU 就会读到越界的垃圾数据——表现是天上飘着巨大的白色三角纸片。
  const maxPuffs = count * MAX_PUFFS_PER_CLOUD;
  const worldHalf = O.worldHalf || 9000;

  const offsets = new Float32Array(maxPuffs * 3);
  const scales = new Float32Array(maxPuffs * 2);
  const alphas = new Float32Array(maxPuffs);
  const tints = new Float32Array(maxPuffs * 3);
  const relY = new Float32Array(maxPuffs);
  const occA = new Float32Array(maxPuffs);

  // 云的元数据（穿云判定 + 重排）
  const puffs = [];
  const clusters = [];

  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const cx = (rnd() * 2 - 1) * worldHalf;
    const cz = (rnd() * 2 - 1) * worldHalf;
    // 云底 1250m，云顶 3100m：狗斗高度带里能穿云
    const cy = 1250 + rnd() * 1850;
    // 真实积云直径 1~3km：太小会变成天上的棉花球，完全没有体积感
    const R = 620 + rnd() * 980;
    const puffN = Math.min(MAX_PUFFS_PER_CLOUD, Math.max(14, Math.round(puffsPer * (0.8 + rnd() * 0.45))));
    clusters.push({ x: cx, y: cy, z: cz, r: R * 0.92, h: R * 0.34 });

    for (let j = 0; j < puffN; j++) {
      // 椭球内均匀分布（cube root 保证体密度均匀），顶部略多 → 积云塔状
      const u = rnd(), v = rnd(), w = rnd();
      // 往中心偏置（而不是均匀填满椭球）：puff 越集中，云越“实”，
      // 均匀分布会露出一个个独立的球，变成天上的泡泡串。
      const rr = Math.pow(u, 0.62);
      const th = v * Math.PI * 2;
      const ph = Math.acos(2 * w - 1);
      let ox = rr * Math.sin(ph) * Math.cos(th) * R * 0.62;
      let oz = rr * Math.sin(ph) * Math.sin(th) * R * 0.48;
      let oy = rr * Math.cos(ph) * R * 0.23 + R * 0.02;
      if (oy < -R * 0.06) oy = -R * 0.06 + (oy + R * 0.06) * 0.25;   // 云底压平
      // 大小分层：主体用大块堆体积，外缘用小块做毛边（花椰菜结构）。
      // 全部同尺寸会得到一串均匀的泡泡，一眼假。
      const core = j < puffN * 0.42;
      const sc = R * (core ? 0.34 + rnd() * 0.16 : 0.14 + rnd() * 0.12);
      // 内部遮蔽：越靠近云心，越被外层 puff 挡光，只吃得到环境光。
      // 归一化到 0..1（表面=1）。没有这一项，云心和外缘一样亮，看着就是个空心壳。
      const rn = Math.min(1, Math.sqrt(
        (ox / (R * 0.62)) ** 2 + (oz / (R * 0.48)) ** 2 + (oy / (R * 0.30)) ** 2));
      const occ = clamp01(0.22 + 0.78 * Math.pow(rn, 0.85));
      puffs.push({
        x: cx + ox, y: cy + oy, z: cz + oz,
        sx: sc * (1.0 + rnd() * 0.42), sy: sc * (0.74 + rnd() * 0.24),
        a: core ? 0.34 + rnd() * 0.16 : 0.14 + rnd() * 0.10,
        tint: 0.90 + rnd() * 0.14,
        rel: clamp01((oy / (R * 0.23) + 1) * 0.5),
        occ
      });
    }
  }

  const nPuffs = puffs.length;

  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 2));
  geo.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  geo.setAttribute('iTint', new THREE.InstancedBufferAttribute(tints, 3));
  geo.setAttribute('iRel', new THREE.InstancedBufferAttribute(relY, 1));
  geo.setAttribute('iOcc', new THREE.InstancedBufferAttribute(occA, 1));
  geo.instanceCount = nPuffs;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40000);

  const uniforms = {
    uMap: { value: makeCloudTexture(O.textureSize || 256) },
    uSunDir: { value: (O.sunDir || new THREE.Vector3(0.4, 0.5, 0.7)).clone() },
    uSunCol: { value: new THREE.Color(0xfff0d2) },
    // 受光面/背光面的动态范围必须拉够：原来 light 1.62 / shadow 0.43~0.59，
    // 中间调全部落在 ACES 的高光肩上，整朵云被压成一片纯白 —— 就是“棉花糖”。
    // 真实积云：受光顶接近纯白，云底是明显的蓝灰，跨度接近 4:1。
    uLight: { value: new THREE.Color(2.05, 2.06, 2.10) },
    uShadow: { value: new THREE.Color(0x2f3d50) },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uFogColor: { value: new THREE.Color(O.fog || 0xa9c7dd) },
    uFogNear: { value: O.fogNear !== undefined ? O.fogNear : 3000 },
    uFogFar: { value: O.fogFar !== undefined ? O.fogFar : 26000 },
    uOpacity: { value: 1 },
    uDetail: { value: 1 }        // 低画质档关掉 fbm，省 ALU
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: `
      attribute vec3 iOffset;
      attribute vec2 iScale;
      attribute float iAlpha;
      attribute vec3 iTint;
      attribute float iRel;
      attribute float iOcc;
      uniform vec3 uCamRight;
      uniform vec3 uCamUp;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vAlpha;
      varying float vRel;
      varying float vOcc;
      varying float vDist;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vTint = iTint;
        vAlpha = iAlpha;
        vRel = iRel;
        vOcc = iOcc;
        vec3 world = iOffset + uCamRight * position.x * iScale.x + uCamUp * position.y * iScale.y;
        vWorld = world;
        vec4 mv = viewMatrix * vec4(world, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uSunDir;
      uniform vec3 uSunCol;
      uniform vec3 uLight;
      uniform vec3 uShadow;
      uniform vec3 uCamRight;
      uniform vec3 uCamUp;
      uniform vec3 uCamFwd;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform float uOpacity;
      uniform float uDetail;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vAlpha;
      varying float vRel;
      varying float vOcc;
      varying float vDist;
      varying vec3 vWorld;

      // ---- 三维值噪声：云表面的花椰菜结构靠它 ----
      float cHash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }
      float cNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = mix(mix(cHash(i), cHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                      mix(cHash(i + vec3(0.0, 1.0, 0.0)), cHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
        float b = mix(mix(cHash(i + vec3(0.0, 0.0, 1.0)), cHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                      mix(cHash(i + vec3(0.0, 1.0, 1.0)), cHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
        return mix(a, b, f.z);
      }
      float cFbm(vec3 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 3; i++) { s += a * cNoise(p); p *= 2.07; a *= 0.5; }
        return s / 0.875;
      }

      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.004) discard;

        // 球面法线（相机空间基向量 → 世界空间），让 puff 有“受光/背光”两面
        vec2 c = vUv * 2.0 - 1.0;
        float r2 = dot(c, c);
        if (r2 > 1.0) discard;
        float nz = sqrt(max(0.0, 1.0 - r2));

        // ---- 表面分形：三个尺度 ----
        // 450m 云塔起伏 / 130m 花椰菜团 / 33m 毛边。
        // 没有这一层，每个 puff 都是一颗光滑的径向渐变球，叠起来就是棉花糖。
        vec3 wp = vWorld;
        float f1 = 0.5, f2 = 0.5, f3 = 0.5;
        if (uDetail > 0.5) {
          f1 = cFbm(wp * 0.0022);
          f2 = cFbm(wp * 0.0078 + 31.7);
          f3 = cNoise(wp * 0.031 + 7.3);
        }

        // 法线扰动：把噪声当高度场，横向梯度当作凹凸 —— 明暗出现“团块”而不是均匀球
        vec3 n = normalize(uCamRight * c.x * 0.92 + uCamUp * c.y * 0.92 + uCamFwd * (nz * 0.75 + 0.25));
        n = normalize(n + (uCamRight * (f2 - 0.5) + uCamUp * (f1 - 0.5)) * 2.3
                        + uCamRight * (f3 - 0.5) * 0.9);

        float ndl = dot(n, normalize(uSunDir));
        float sphereLit = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);

        // 云团自阴影：底暗顶亮。权重从 0.50 提到 0.62，并把底部压得更狠 ——
        // 积云最抓眼的特征就是“平底 + 亮顶”，压不出来就还是一团白棉花。
        float heightLit = clamp(vRel, 0.0, 1.0);
        float lit = mix(sphereLit, heightLit, 0.62);
        lit *= 0.26 + 0.74 * smoothstep(0.02, 0.72, heightLit);
        // 内部 puff 被外层挡住，只吃到环境光 → 暗。这是“体积感”的来源。
        lit *= 0.52 + 0.48 * clamp(vOcc, 0.0, 1.0);
        // 花椰菜明暗
        lit *= 0.70 + 0.58 * f2;
        lit *= 0.84 + 0.30 * f1;
        lit = clamp(lit, 0.0, 1.0);

        vec3 col = mix(uShadow, uLight, lit);
        // 银边：只在真正朝太阳的局部朝向上出现，pow 收得比原来紧
        col += uSunCol * pow(max(ndl, 0.0), 6.0) * 0.26 * (0.5 + 0.5 * f2);
        col *= vTint;

        float fog = smoothstep(uFogNear, uFogFar, vDist);
        col = mix(col, uFogColor, fog * 0.85);

        // 表面斑驳：让 alpha 也跟着噪声起伏，边缘不再是完美圆弧
        float mott = 1.0;
        if (uDetail > 0.5) mott = 0.80 + 0.42 * (f2 * 0.62 + f3 * 0.38);
        float a = tex.a * vAlpha * uOpacity * mott * (1.0 - fog * 0.55);
        gl_FragColor = vec4(col, a);
      }`
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  let order = null;
  let lastSort = -1;
  let lastCam = new THREE.Vector3(1e9, 0, 0);
  let limit = maxPuffs;

  function sortPuffs(camPos, time) {
    if (time - lastSort < 0.32 && camPos.distanceToSquared(lastCam) < 16000) return;
    lastSort = time;
    lastCam.copy(camPos);

    if (!order) order = new Array(nPuffs);
    order.length = 0;
    const dist = new Float32Array(nPuffs);
    for (let i = 0; i < nPuffs; i++) {
      const p = puffs[i];
      const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
      dist[i] = dx * dx + dy * dy + dz * dz;
      order.push(i);
    }
    // 近 → 远，截断保留最近 limit 个
    order.sort((a, b) => dist[a] - dist[b]);
    const keep = Math.min(limit, nPuffs);
    order.length = keep;
    // 写入顺序：远 → 近（半透明从后往前画）
    for (let k = 0; k < keep; k++) {
      const i = order[keep - 1 - k];
      const p = puffs[i];
      offsets[k * 3] = p.x; offsets[k * 3 + 1] = p.y; offsets[k * 3 + 2] = p.z;
      scales[k * 2] = p.sx; scales[k * 2 + 1] = p.sy;
      alphas[k] = p.a;
      tints[k * 3] = p.tint; tints[k * 3 + 1] = p.tint * 0.99; tints[k * 3 + 2] = p.tint * 1.01;
      relY[k] = p.rel;
      occA[k] = p.occ;
    }
    geo.instanceCount = keep;
    geo.attributes.iOffset.needsUpdate = true;
    geo.attributes.iScale.needsUpdate = true;
    geo.attributes.iAlpha.needsUpdate = true;
    geo.attributes.iTint.needsUpdate = true;
    geo.attributes.iRel.needsUpdate = true;
    geo.attributes.iOcc.needsUpdate = true;
  }

  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  return {
    mesh,
    clusters,
    uniforms,
    setDensity(d) {
      limit = Math.min(maxPuffs, Math.round(maxPuffs * Math.max(0.15, Math.min(1, d))));
      lastSort = -1;
    },
    // fbm 表面细节要 24 次 hash，低画质档关掉（云会退回“光滑团”，但能省下 ALU）
    setDetail(on) { uniforms.uDetail.value = on ? 1 : 0; },
    update(camera, time) {
      // 相机基向量（世界空间）——billboard 与球面法线都用它
      camera.matrixWorld.extractBasis(_right, _up, _fwd);
      uniforms.uCamRight.value.copy(_right);
      uniforms.uCamUp.value.copy(_up);
      uniforms.uCamFwd.value.copy(_fwd).negate();
      sortPuffs(camera.position, time);
    }
  };
}
