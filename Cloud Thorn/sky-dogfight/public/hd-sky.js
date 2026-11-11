/* =============================================================================
 * hd-sky.js —— 大气天空穹顶
 *   · 天顶→地平线的大气渐变（近地平线更白，符合真实散射）
 *   · 太阳盘 + 双层米氏辉光（HDR 亮度，交给后处理泛光吃出眩光）
 *   · 程序化卷云：周期 fbm 贴图，两层不同尺度反向漂移，太阳侧前向散射提亮
 *   · 地平线以下用灰蓝兜底，避免海面边缘露底
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';

// ---- 周期 value noise（可无缝平铺）----
function hash2(ix, iy, seed) {
  let h = ix * 374761393 + iy * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, period, seed) {
  const fx = x * period, fy = y * period;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const wx0 = ((x0 % period) + period) % period;
  const wy0 = ((y0 % period) + period) % period;
  const wx1 = (wx0 + 1) % period;
  const wy1 = (wy0 + 1) % period;
  const a = hash2(wx0, wy0, seed);
  const b = hash2(wx1, wy0, seed);
  const c = hash2(wx0, wy1, seed);
  const d = hash2(wx1, wy1, seed);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}
function fbm(u, v, basePeriod, octaves, seed, gain) {
  let amp = 1, sum = 0, norm = 0, period = basePeriod;
  for (let i = 0; i < octaves; i++) {
    // 每层旋转一点，避免层与层对齐出现网格感
    const ang = 0.37 * i;
    const ru = u * Math.cos(ang) - v * Math.sin(ang);
    const rv = u * Math.sin(ang) + v * Math.cos(ang);
    sum += valueNoise(ru, rv, period, seed + i * 71) * amp;
    norm += amp;
    amp *= gain === undefined ? 0.5 : gain;
    period *= 2;
  }
  return sum / norm;
}

function makeCirrusTexture(size) {
  const S = size || 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // 拉长的丝缕：x 方向低频、y 方向高频 → 卷云被高空风拉成条带
      let n = fbm(u, v, 4, 5, 13, 0.52);
      const streak = fbm(u * 0.35 + 0.2, v * 2.4, 6, 3, 97, 0.55);
      n = n * 0.65 + streak * 0.55;
      const val = Math.max(0, Math.min(255, Math.pow(n, 1.35) * 255));
      const i = (y * S + x) * 4;
      img.data[i] = val;
      img.data[i + 1] = val;
      img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  if ('colorSpace' in tex) tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export function createSky(sunDir, options) {
  const O = options || {};
  const uniforms = {
    uSunDir: { value: sunDir.clone() },
    uSunCol: { value: new THREE.Color(O.sunColor || 0xfff0cf) },
    uZenith: { value: new THREE.Color(O.zenith || 0x2b6cb6) },
    uHorizon: { value: new THREE.Color(O.horizon || 0xa9c7dd) },
    uGround: { value: new THREE.Color(O.ground || 0x53636b) },
    uTime: { value: 0 },
    uCirrus: { value: makeCirrusTexture(O.cirrusSize || 256) },
    uCirrusAmount: { value: O.cirrus !== undefined ? O.cirrus : 0.85 }
  };

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uSunCol;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform sampler2D uCirrus;
      uniform float uTime;
      uniform float uCirrusAmount;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float mu = max(dot(d, normalize(uSunDir)), 0.0);

        // ---- 基础大气：地平线白 → 天顶深蓝，指数更接近真实散射 ----
        float t = clamp(y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(t, 0.44));

        // 太阳对侧略深（大气多次散射的方位不对称）
        float back = clamp(-dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0, 1.0);
        col *= 1.0 - back * 0.06 * (1.0 - t);

        // 地平线雾霾带：越贴近地面越白，和场景 fog 无缝衔接
        float haze = exp(-max(y, 0.0) * 9.5);
        col = mix(col, uHorizon * 1.02, haze * 0.62);

        // ---- 太阳周围的米氏散射 ----
        col += uSunCol * pow(mu, 6.0) * 0.085;
        col += uSunCol * pow(mu, 160.0) * 0.20;

        // ---- 卷云 ----
        if (y > 0.005) {
          vec2 cuv = d.xz / max(y, 0.028) * 0.085;
          vec2 drift = vec2(uTime * 0.0016, uTime * 0.0009);
          float c1 = texture2D(uCirrus, cuv * 0.55 + drift).r;
          float c2 = texture2D(uCirrus, cuv * 1.65 - drift * 1.7 + vec2(0.31, 0.77)).r;
          float c3 = texture2D(uCirrus, cuv * 3.4 + drift * 2.4).r;
          float cir = smoothstep(0.34, 0.72, c1 * 0.66 + c2 * 0.42 + c3 * 0.16);
          // 天顶附近更薄，靠近地平线被压缩得更密（透视）
          float band = smoothstep(0.004, 0.10, y) * (0.55 + 0.45 * smoothstep(0.9, 0.25, y));
          cir *= band * uCirrusAmount;
          // 前向散射：太阳附近云丝发亮镶边
          vec3 cirCol = mix(vec3(0.72, 0.76, 0.82), vec3(1.0, 0.98, 0.94), pow(mu, 3.0) * 0.8 + 0.18);
          cirCol += uSunCol * pow(mu, 22.0) * 1.15;
          col = mix(col, cirCol, cir * 0.72);
        }

        // ---- 太阳盘（HDR：留给泛光去晕开）----
        float disc = smoothstep(0.999955, 0.999985, mu);
        col += uSunCol * disc * 8.0;
        col += uSunCol * pow(mu, 2400.0) * 1.2;

        // ---- 地平线以下：海雾/地面兜底色 ----
        if (y < 0.0) {
          float k = smoothstep(0.0, -0.16, y);
          col = mix(col, uGround, k);
        }

        gl_FragColor = vec4(col, 1.0);
      }`
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 28), mat);
  mesh.scale.setScalar(42000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'skyDome';

  return {
    mesh,
    uniforms,
    update(t) { uniforms.uTime.value = t; }
  };
}
