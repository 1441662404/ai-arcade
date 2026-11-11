/* =============================================================================
 * hd-postfx.js —— 轻量 HDR 后处理管线（零外部依赖，只吃 Three.js 核心）
 *
 *  场景 ──► HDR HalfFloat RT（可选 4x MSAA）
 *            │
 *            ├─► 亮度提取 + 13-tap 降采样 ×5（1/2 … 1/32）
 *            ├─► tent 升采样逐级叠加（加性混合）
 *            ▼
 *        合成：径向速度模糊 → 泛光 → 太阳眩光/ghost → ACES → 曝光
 *              → G 力灰视/红视 → 穿云白罩 → 速度线 → 色差
 *              → 暗角 → 胶片颗粒 → sRGB 输出
 *
 *  设计目标：
 *   · 一次只做必要的全屏 pass，泛光链用最小 RT（1/2 起步）避免带宽爆炸
 *   · 所有后处理参数由外部 uniform 驱动，不重建材质
 *   · 分辨率缩放独立于 canvas：3D 可以降分辨率，HUD 仍然全清晰
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';

const FS_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 13-tap 降采样（Call of Duty 方案）：比 4-tap 盒式稳定得多，
// 高光点在移动时不会一帧一闪（“萤火虫”）。
const DOWN_FS = `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uPrefilter;
varying vec2 vUv;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = max(uKnee, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * max(contrib, 0.0);
}

void main() {
  vec2 t = uTexel;
  vec3 A = texture2D(tSrc, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 B = texture2D(tSrc, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 C = texture2D(tSrc, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 D = texture2D(tSrc, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 E = texture2D(tSrc, vUv).rgb;
  vec3 F = texture2D(tSrc, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 G = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 H = texture2D(tSrc, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 I = texture2D(tSrc, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 J = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 K = texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 L = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 M = texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb;

  vec3 r = (A + B + D + E) * 0.03125
         + (B + C + E + F) * 0.03125
         + (D + E + G + H) * 0.03125
         + (E + F + H + I) * 0.03125
         + (J + K + L + M) * 0.125;

  if (uPrefilter > 0.5) r = prefilter(r / 1.0);
  gl_FragColor = vec4(r, 1.0);
}`;

// 3x3 tent 升采样：配合加性混合，逐级把粗层光晕叠回细层
const UP_FS = `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-t.x, 0.0)).rgb
      + texture2D(tSrc, vUv + vec2( t.x, 0.0)).rgb
      + texture2D(tSrc, vUv + vec2(0.0, -t.y)).rgb
      + texture2D(tSrc, vUv + vec2(0.0,  t.y)).rgb) * 2.0;
  c += (texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb
      + texture2D(tSrc, vUv + vec2( t.x, -t.y)).rgb
      + texture2D(tSrc, vUv + vec2(-t.x,  t.y)).rgb
      + texture2D(tSrc, vUv + vec2( t.x,  t.y)).rgb);
  gl_FragColor = vec4(c / 16.0, 1.0);
}`;

const COMP_FS = `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uSpeed;       // 0..1 高速气流感
uniform float uG;           // 过载（+-）
uniform float uCloud;       // 0..1 穿云
uniform float uHurt;        // 0..1 受伤
uniform float uFlash;       // 受击闪白
uniform vec2 uSunUV;        // 太阳屏幕坐标
uniform float uSunVis;
uniform vec3 uSunCol;
uniform float uVignette;
uniform float uGrain;
uniform float uAberr;
uniform float uWarp;        // 速度径向模糊强度
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ACES Filmic（Narkowicz 近似）——高光滚降，金属不会直接烧成白块
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 lin2srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 cent = uv - 0.5;
  float r = length(cent * vec2(uAspect, 1.0));

  // ---- 1. 径向速度模糊（只糊边缘，中心保持清晰，否则准星和仪表会糊）----
  vec3 col;
  float edge = smoothstep(0.22, 0.95, r);
  float warp = uWarp * edge;
  if (warp > 0.0015) {
    // 采样点从“当前位置”朝屏幕中心收缩：模拟高速气流拖影
    col = vec3(0.0);
    float jitter = hash12(uv * uRes + uTime) * 0.35;
    for (int i = 0; i < 6; i++) {
      float k = (float(i) + jitter) / 6.0;
      vec2 suv = uv - cent * warp * k;
      col += texture2D(tScene, suv).rgb;
    }
    col /= 6.0;
  } else {
    col = texture2D(tScene, uv).rgb;
  }

  // ---- 2. 泛光 ----
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom;

  // ---- 3. 太阳眩光 / 镜头 ghost ----
  if (uSunVis > 0.001) {
    vec2 sd = (uv - uSunUV) * vec2(uAspect, 1.0);
    float sr = length(sd);
    float vis = uSunVis;
    // 核心热晕 + 大范围柔光（范围收紧，否则整片天空被洗白）
    // 大范围那项从 0.085 收到 0.045：原来它把太阳周围 1/4 个屏幕都提亮了，
    // 对比度全被吃掉，山体和海面看着发灰。
    col += uSunCol * vis * (0.62 * exp(-sr * sr * 1500.0) + 0.045 * exp(-sr * sr * 70.0));
    // 横向拉丝（变形镜头感）
    float streak = exp(-abs(sd.y) * 420.0) * exp(-abs(sd.x) * 3.4);
    col += uSunCol * vis * streak * 0.10;
    // 多边形光斑（沿太阳—画面中心连线分布）
    vec3 ghostCol[4];
    ghostCol[0] = vec3(0.34, 0.52, 0.86);
    ghostCol[1] = vec3(0.90, 0.64, 0.36);
    ghostCol[2] = vec3(0.62, 0.66, 0.74);
    ghostCol[3] = vec3(0.72, 0.46, 0.62);
    for (int i = 0; i < 4; i++) {
      float f = float(i) + 1.0;
      vec2 gp = uSunUV + (vec2(0.5) - uSunUV) * (1.10 + f * 0.42);
      float gr = 0.050 + f * 0.018;
      vec2 gd = (uv - gp) * vec2(uAspect, 1.0);
      float d = length(gd);
      float disc = smoothstep(gr, gr * 0.62, d);
      // 让光斑带一点镜片纹理（六边形轮廓 + 中心亮环）
      float ang = atan(gd.y, gd.x);
      float hex = 0.82 + 0.18 * cos(ang * 6.0);
      col += ghostCol[i] * vis * disc * hex * (0.022 / (0.5 + f * 0.55));
    }
  }

  // ---- 4. 曝光 + ACES ----
  col *= uExposure;
  col = aces(col);

  // ---- 4b. 鲜度找回 + 轻对比（放在 ACES 之后、G 力效果之前）----
  // ACES 在中高亮度区间天然去饱和；地形反照率抬亮后整帧被推进该区间，
  // 实测画面饱和度 0.306 -> 0.243（发灰发白）。这里补回：
  //   · vibrance：按「欠饱和度」加权提升，欠饱和的地面/山体增益大，
  //     本来就饱和的天空/海面几乎不动（直接全局乘系数会把天空顶到塑料色）。
  //   · 轻 S 曲线（smoothstep 混 0.20）：找回被映射压平的明暗对比。
  {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
    float w = 1.0 - smoothstep(0.0, 0.38, sat);
    col = mix(col, mix(vec3(lum), col, 1.45), 0.55 * w + 0.14);
    col = clamp(col, 0.0, 1.0);
    col = mix(col, col * col * (3.0 - 2.0 * col), 0.20);
  }

  // ---- 5. G 力：正过载灰视（周边失去色彩并压暗），负过载红视 ----
  // 起始门限抬高到 5G、满值推到 11G：以前 3.6G 就开始灰屏，稍微拉一下就“白/灰一片”，
  // 现在只有真正的大过载才压暗，且过渡更缓（配合客户端 gVis 平滑，见 game.js）。
  if (uG > 5.0) {
    float g = smoothstep(5.0, 11.0, uG) * smoothstep(0.18, 0.95, r);
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum) * 0.46, g * 0.78);
    col *= 1.0 - g * 0.30;
  } else if (uG < -1.6) {
    float g = smoothstep(-1.6, -4.6, uG) * smoothstep(0.15, 0.95, r);
    col = mix(col, vec3(0.52, 0.045, 0.035), g * 0.50);
  }

  // ---- 7. 高速气流线：极坐标噪声拉丝，只在边缘明显 ----
  if (uSpeed > 0.01) {
    float a = atan(cent.y, cent.x);
    float line = vnoise(vec2(a * 26.0, r * 7.0 - uTime * 4.2));
    line = pow(line, 7.0);
    float mask = smoothstep(0.26, 0.92, r) * uSpeed;
    col += vec3(0.62, 0.78, 0.95) * line * mask * 0.30;
  }

  // ---- 8. 受伤：暗角里渗血 + 受击闪白 ----
  if (uHurt > 0.001) {
    float h = smoothstep(0.30, 1.0, r) * uHurt;
    float pulse = 0.72 + 0.28 * sin(uTime * 3.4);
    col = mix(col, vec3(0.42, 0.03, 0.02), h * 0.45 * pulse);
  }
  col += vec3(1.0, 0.92, 0.86) * uFlash;

  // ---- 9. 色差（边缘 R/B 分离，非常轻）----
  if (uAberr > 0.0001) {
    float k = uAberr * r * r;
    vec2 dir = normalize(cent + 1e-5);
    // 已在上面采样过，这里用极轻的通道位移近似（采样泛光图避免二次读场景）
    col.r += bloom.r * k * 0.10;
    col.b += bloom.b * k * 0.16;
    col *= 1.0 - k * 0.12;
  }

  // ---- 10. 暗角 ----
  float vig = smoothstep(0.98, 0.28, r * (1.05 + uVignette * 0.25));
  col *= mix(1.0, vig, uVignette);

  // ---- 11. 胶片颗粒（暗部更明显，避免纯色天空出现“塑料感”）----
  if (uGrain > 0.0001) {
    float n = hash12(uv * uRes + fract(uTime) * 91.7) - 0.5;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col += n * uGrain * (1.0 - lum * 0.75);
  }

  col = lin2srgb(max(col, vec3(0.0)));
  gl_FragColor = vec4(col, 1.0);
}`;

export function createPostFX(renderer, opts) {
  const O = opts || {};
  const maxBloomLevels = 5;
  const state = {
    w: 2, h: 2, dpr: 1, scale: 1,
    samples: renderer.capabilities.isWebGL2 ? 2 : 0,
    bloomOn: true,
    levels: maxBloomLevels
  };

  // --- 全屏三角形（比 quad 少一条对角线，且不需要索引） ---
  const triGeo = new THREE.BufferGeometry();
  triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  triGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(triGeo, new THREE.MeshBasicMaterial());
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const fsMat = (fs, uniforms, extra) => new THREE.ShaderMaterial(Object.assign({
    vertexShader: FS_VS,
    fragmentShader: fs,
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent: false
  }, extra || {}));

  const downMat = fsMat(DOWN_FS, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uThreshold: { value: 1.0 },
    uKnee: { value: 0.6 },
    uPrefilter: { value: 0 }
  });
  const upMat = fsMat(UP_FS, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) }
  }, {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false
  });

  const compUniforms = {
    tScene: { value: null },
    tBloom: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 1 },
    uTime: { value: 0 },
    uExposure: { value: O.exposure || 1.0 },
    uBloom: { value: 0.62 },
    uSpeed: { value: 0 },
    uG: { value: 1 },
    uCloud: { value: 0 },
    uHurt: { value: 0 },
    uFlash: { value: 0 },
    uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
    uSunVis: { value: 0 },
    uSunCol: { value: new THREE.Color(1.0, 0.94, 0.82) },
    uVignette: { value: 0.55 },
    uGrain: { value: 0.0095 },
    uAberr: { value: 0.10 },
    uWarp: { value: 0.05 }
  };
  const compMat = fsMat(COMP_FS, compUniforms);

  // --- 渲染目标 ---
  const rtOpts = {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false
  };
  let rtScene = null;
  const bloomRT = [];

  function makeRT(w, h, samples) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({}, rtOpts));
    if (renderer.capabilities.isWebGL2 && samples > 0) rt.samples = samples;
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  function disposeChain() {
    if (rtScene) { rtScene.dispose(); rtScene = null; }
    for (const rt of bloomRT) rt.dispose();
    bloomRT.length = 0;
  }

  function rebuild(w, h) {
    state.w = Math.max(2, Math.floor(w));
    state.h = Math.max(2, Math.floor(h));
    disposeChain();
    rtScene = makeRT(state.w, state.h, state.samples);
    // 泛光链：从 1/2 开始，逐级减半，直到 1/32 或小于 8px
    let bw = state.w, bh = state.h;
    for (let i = 0; i < state.levels; i++) {
      bw = Math.max(2, Math.floor(bw * 0.5));
      bh = Math.max(2, Math.floor(bh * 0.5));
      if (bh < 4) break;
      bloomRT.push(makeRT(bw, bh, 0));
    }
    compUniforms.uRes.value.set(state.w, state.h);
  }

  function setSize(w, h, dpr) {
    state.dpr = dpr || 1;
    lastCss.w = w; lastCss.h = h;
    const sw = Math.max(2, Math.floor(w * state.dpr * state.scale));
    const sh = Math.max(2, Math.floor(h * state.dpr * state.scale));
    if (sw !== state.w || sh !== state.h) rebuild(sw, sh);
  }

  function setScale(s) {
    const ns = Math.max(0.45, Math.min(1.35, s));
    if (Math.abs(ns - state.scale) < 0.005) return;
    state.scale = ns;
    setSize(lastCss.w, lastCss.h, state.dpr);
  }

  function setSamples(n) {
    const s = renderer.capabilities.isWebGL2 ? n : 0;
    if (s === state.samples) return;
    state.samples = s;
    rebuild(state.w, state.h);
  }

  function setLevels(n) {
    const lv = Math.max(2, Math.min(maxBloomLevels, n));
    if (lv === state.levels) return;
    state.levels = lv;
    rebuild(state.w, state.h);
  }

  let lastCss = { w: 2, h: 2 };
  setSize(window.innerWidth || 2, window.innerHeight || 2, Math.min(window.devicePixelRatio || 1, 2));

  const _sunPos = new THREE.Vector3();
  const _camDir = new THREE.Vector3();

  /**
   * 渲染一帧。
   * p: { scene, camera, cpScene, cpCamera, dt, time, sunDir,
   *      speed, g, cloud, hurt, flash, exposure, bloom, shadowEnabled }
   */
  function render(p) {
    const { scene, camera } = p;
    renderer.info.reset();
    lastCss.w = window.innerWidth;
    lastCss.h = window.innerHeight;

    // ---- 主场景 → HDR RT ----
    renderer.autoClear = false;
    renderer.setRenderTarget(rtScene);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    if (p.cpScene && p.cpCamera) {
      renderer.clearDepth();
      renderer.render(p.cpScene, p.cpCamera);
    }

    // ---- 泛光链 ----
    if (state.bloomOn && bloomRT.length >= 2) {
      let src = rtScene.texture;
      let srcW = state.w, srcH = state.h;
      for (let i = 0; i < bloomRT.length; i++) {
        const rt = bloomRT[i];
        downMat.uniforms.tSrc.value = src;
        downMat.uniforms.uTexel.value.set(1 / srcW, 1 / srcH);
        downMat.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
        downMat.uniforms.uThreshold.value = O.threshold !== undefined ? O.threshold : 1.06;
        downMat.uniforms.uKnee.value = O.knee !== undefined ? O.knee : 0.62;
        quad.material = downMat;
        renderer.setRenderTarget(rt);
        renderer.clear(true, false, false);
        renderer.render(quadScene, quadCam);
        src = rt.texture;
        srcW = rt.width; srcH = rt.height;
      }
      // 从最小层往上叠
      for (let i = bloomRT.length - 1; i > 0; i--) {
        const from = bloomRT[i];
        const to = bloomRT[i - 1];
        upMat.uniforms.tSrc.value = from.texture;
        upMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
        quad.material = upMat;
        renderer.setRenderTarget(to);
        renderer.render(quadScene, quadCam);   // 加性混合，不清屏
      }
      compUniforms.tBloom.value = bloomRT[0].texture;
      compUniforms.uBloom.value = state.bloomOn ? (O.bloomStrength || 0.62) : 0;
    } else {
      compUniforms.tBloom.value = rtScene.texture;
      compUniforms.uBloom.value = 0;
    }

    // ---- 太阳屏幕位置 ----
    if (p.sunDir) {
      _sunPos.copy(camera.position).addScaledVector(p.sunDir, 10000);
      _sunPos.project(camera);
      compUniforms.uSunUV.value.set(_sunPos.x * 0.5 + 0.5, _sunPos.y * 0.5 + 0.5);
      camera.getWorldDirection(_camDir);
      const facing = _camDir.dot(p.sunDir);
      const onScreen = Math.max(0, 1.25 - Math.max(Math.abs(_sunPos.x), Math.abs(_sunPos.y)) * 0.55);
      compUniforms.uSunVis.value = Math.max(0, Math.min(1, (facing - 0.06) * 2.2)) * onScreen;
    } else {
      compUniforms.uSunVis.value = 0;
    }

    compUniforms.tScene.value = rtScene.texture;
    compUniforms.uAspect.value = camera.aspect || 1;
    compUniforms.uTime.value = p.time || 0;
    compUniforms.uExposure.value = p.exposure !== undefined ? p.exposure : (O.exposure || 1.0);
    compUniforms.uSpeed.value = p.speed || 0;
    compUniforms.uG.value = p.g !== undefined ? p.g : 1;
    compUniforms.uCloud.value = p.cloud || 0;
    compUniforms.uHurt.value = p.hurt || 0;
    compUniforms.uFlash.value = p.flash || 0;
    compUniforms.uWarp.value = 0.055 * (p.speed || 0);

    // ---- 合成 → 屏幕 ----
    quad.material = compMat;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  }

  return {
    render,
    setSize,
    setScale,
    setSamples,
    setLevels,
    setBloom(on) { state.bloomOn = !!on; },
    get state() { return state; },
    compUniforms,
    dispose: disposeChain
  };
}
