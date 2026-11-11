/* =============================================================================
 * hd-ocean.js —— GPU 海面
 *   · 顶点：3 组长波正弦叠加 + 解析法线（CPU 每帧零开销，纯 GPU 位移）
 *   · 片元：4 组高频细浪扰动法线（按距离淡出，避免远处摩尔纹）
 *   · 菲涅尔天空反射 + 太阳镜面高光 + 波峰 glitter + 泡沫
 *   · 与场景线性雾严格一致，远处自然溶进地平线
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';

export function createOcean(options) {
  const O = options || {};
  const size = O.size || 36000;
  const seg = O.segments || 200;

  const uniforms = {
    uTime: { value: 0 },
    uOffset: { value: new THREE.Vector2(0, 0) },
    uSunDir: { value: (O.sunDir || new THREE.Vector3(0.4, 0.5, 0.7)).clone() },
    uSunCol: { value: new THREE.Color(0xfff0cf) },
    uDeep: { value: new THREE.Color(O.deep || 0x05141d) },
    uShallow: { value: new THREE.Color(O.shallow || 0x0d3543) },
    uSkyZenith: { value: new THREE.Color(O.zenith || 0x2b6cb6) },
    uSkyHorizon: { value: new THREE.Color(O.horizon || 0xa9c7dd) },
    uFogColor: { value: new THREE.Color(O.fog || 0xa9c7dd) },
    uFogNear: { value: O.fogNear !== undefined ? O.fogNear : 3000 },
    uFogFar: { value: O.fogFar !== undefined ? O.fogFar : 26000 },
    uCamPos: { value: new THREE.Vector3() }
  };

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: false,
    fog: false,
    vertexShader: `
      uniform float uTime;
      uniform vec2 uOffset;
      varying vec3 vWPos;
      varying vec3 vNrm;
      varying float vH;
      varying float vViewZ;

      // 单组正弦波：返回高度，并把 dH/dx、dH/dz 累加到 grad
      float wave(vec2 p, vec2 dir, float wl, float amp, float speed, float t, inout vec2 grad) {
        float k = 6.2831853 / wl;
        float ph = dot(p, dir) * k + t * speed;
        float s = sin(ph);
        float c = cos(ph);
        grad += dir * (k * amp * c);
        return s * amp;
      }

      void main() {
        vec2 wp = position.xz + uOffset;
        vec2 grad = vec2(0.0);
        float h = 0.0;

        // 顶点只做超长涌浪：网格一格 ~180m，波长短于 4 格必走样（水面出现摩尔纹）。
        // 中高频细节全部交给片元法线，那里没有采样率问题。
        h += wave(wp, normalize(vec2( 0.86,  0.51)), 2600.0, 2.35, 0.42, uTime, grad);
        h += wave(wp, normalize(vec2(-0.42,  0.91)), 1500.0, 0.80, 0.62, uTime, grad);
        // 第三列短波：专门用来打散前两列正弦在低视角下形成的规则横向条带
        h += wave(wp, normalize(vec2( 0.28, -0.96)), 620.0, 0.34, 0.46, uTime, grad);

        // 把法线从“高度场”还原：n = normalize(-dh/dx, 1, -dh/dz)
        vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));

        // vWPos 用世界坐标（供片元算细节/高光），但顶点本身必须留在局部空间：
        // mesh.position 由 modelViewMatrix 处理，若这里再传世界坐标就会偏移两次。
        vWPos = vec3(wp.x, h, wp.y);
        vNrm = n;
        vH = h;

        vec4 mv = modelViewMatrix * vec4(position.x, h, position.z, 1.0);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunCol;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec3 uCamPos;
      varying vec3 vWPos;
      varying vec3 vNrm;
      varying float vH;
      varying float vViewZ;

      // 高频细浪：解析正弦叠加到法线。
      // 分两档衰减：低频（120/65m）能撑到 3km 外，高频（34/18m）只在近处，
      // 否则远处像素采样不足会闪成噪点。原来一刀切 exp(-d/1600)，
      // 结果 1km 外的海面法线被抹平，看起来就是一块蓝色塑料。
      vec3 detailNormal(vec3 n, vec2 p, float aLo, float aHi) {
        vec2 g = vec2(0.0);
        float t = uTime;
        vec2 d0 = normalize(vec2( 0.80,  0.60));
        vec2 d1 = normalize(vec2(-0.50,  0.87));
        vec2 d2 = normalize(vec2( 0.96, -0.28));
        vec2 d3 = normalize(vec2(-0.86, -0.50));
        // ⚠️ 相位扰动是必须的。
        // 纯平面波在 40m 高的舰桥相机下，等相位线经透视投影会变成一圈圈
        // 同心弧（截图里水面上一环套一环的"涟漪"就是这么来的，真实海面
        // 有无穷多方向的波，永远不会出现这种规整干涉）。
        // 给每组波的相位叠一层低频正弦，等相位线被拉弯、断开，图案立刻散掉。
        float w0 = sin(p.x * 0.0115 + p.y * 0.0092) * 4.2 + sin(p.y * 0.021 - p.x * 0.014) * 1.8;
        float w1 = sin(p.x * 0.0260 - p.y * 0.0195) * 3.4 + sin(p.x * 0.041 + p.y * 0.033) * 1.4;
        float w2 = sin(p.x * 0.0450 + p.y * 0.0380) * 2.6;
        float w3 = sin(p.x * 0.0730 - p.y * 0.0610) * 1.9;
        g += d0 * (6.2831853 / 120.0) * 0.30 * cos(dot(p, d0) * (6.2831853 / 120.0) + w0 + t * 1.5) * aLo;
        g += d1 * (6.2831853 /  65.0) * 0.19 * cos(dot(p, d1) * (6.2831853 / 65.0) + w1 - t * 2.1) * aLo;
        g += d2 * (6.2831853 /  34.0) * 0.046 * cos(dot(p, d2) * (6.2831853 / 34.0) + w2 + t * 2.8) * aHi;
        g += d3 * (6.2831853 /  18.0) * 0.020 * cos(dot(p, d3) * (6.2831853 / 18.0) + w3 - t * 3.7) * aHi;
        n = normalize(n + vec3(-g.x, 0.0, -g.y));
        return n;
      }

      void main() {
        vec3 V = normalize(uCamPos - vWPos);
        float dist = length(uCamPos - vWPos);
        float aLo = exp(-dist / 3200.0);
        float aHi = exp(-dist / 330.0);
        vec3 N = detailNormal(normalize(vNrm), vWPos.xz, aLo, aHi);
        // 远处把细浪法线收回到大涌浪法线：4 组平面波在近乎水平的视角下
        // 会互相干涉出一圈圈同心环（摩尔纹），是水面上最假的东西。
        N = normalize(mix(N, normalize(vNrm), smoothstep(900.0, 4800.0, dist)));

        float ndv = max(dot(N, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        fres = clamp(fres, 0.02, 0.98);

        // 天空反射：越贴地平线越白（和天空穹顶同一套颜色）
        vec3 R = reflect(-V, N);
        vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, clamp(R.y * 1.6, 0.0, 1.0));
        skyRefl = mix(skyRefl, uSkyHorizon * 1.04, 0.42);

        // 水体颜色：波峰略亮（次表面透光的近似）
        vec3 water = mix(uDeep, uShallow, clamp(0.44 + vH * 0.10, 0.0, 1.0));
        vec3 col = mix(water, skyRefl, fres);

        // ---- 太阳镜面：宽瓣撑起整条“太阳路”，窄瓣出高光 ----
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(V + L);
        float nh = max(dot(N, H), 0.0);
        float broad = pow(nh, 55.0) * 0.14;      // 大范围柔光：太阳在水面拖出的那条路
        float tight = pow(nh, 620.0) * 0.50;
        col += uSunCol * (broad + tight);
        // ---- 波光鳞片：不做 ----
        // 试过两种做法，都会在海面上留下规律图案：
        //   1) hash 网格（floor(pos*0.85)）→ 方格纸；
        //   2) 以视线方向为基底的拉伸条纹（dot(pos, viewDir)）→ 等值线是
        //      以相机为圆心的同心圆（因为视向逐像素变化）。
        // 在 40m 高的舰桥相机下，1m 级的鳞片本来就应该糊成一片光晕，
        // 所以这里交给上面的 broad/tight 两瓣连续镜面 —— 它们只依赖法线，
        // 不会有任何网格或极坐标印迹。

        // ---- 波纹明暗：让近处水面有“水在动”的层次，而不是一块蓝塑料 ----
        // 幅度必须小：三组正弦直接乘在颜色上，稍大就会出现规则的同心弧线，
        // 一眼看出是“程序化条纹”而不是水。
        vec2 q = vWPos.xz;
        float b1 = sin(q.x * 0.29 + uTime * 1.5 + sin(q.y * 0.075) * 2.2) * sin(q.y * 0.26 - uTime * 1.2 + sin(q.x * 0.061) * 2.0);
        float b2 = sin(q.x * 0.77 - uTime * 2.3 + 1.7 + sin(q.y * 0.13) * 1.5) * sin(q.y * 0.69 + uTime * 1.9);
        float b3 = sin((q.x + q.y) * 0.13 + uTime * 0.7 + sin(q.x * 0.037 - q.y * 0.043) * 3.0) * 0.6;
        col *= 1.0 + (b1 * 0.030 + b2 * 0.010 + b3 * 0.020) * aLo;

        // ---- 泡沫：只在尖峰处少量出现，近距离更明显 ----
        float foam = smoothstep(2.6, 4.0, vH) * (0.30 + 0.70 * aHi);
        // 泡沫纹理也不要用 floor 网格（同样是方形边界）
        float fn1 = sin(q.x * 3.1 + sin(q.y * 2.3) * 1.7 + uTime * 1.1);
        float fn2 = sin(q.y * 4.7 - q.x * 1.9 + uTime * 1.6);
        float foamN = smoothstep(0.35, 0.92, max(0.0, fn1 * fn2));
        col = mix(col, vec3(0.62, 0.70, 0.76), foam * foamN * 0.42);

        // ---- 距离雾（与场景 THREE.Fog 线性一致）----
        float f = smoothstep(uFogNear, uFogFar, vViewZ);
        col = mix(col, uFogColor, f);

        gl_FragColor = vec4(col, 1.0);
      }`
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;

  return {
    mesh,
    uniforms,
    update(t, camera, offsetX, offsetZ) {
      uniforms.uTime.value = t;
      uniforms.uCamPos.value.copy(camera.position);
      if (offsetX !== undefined) uniforms.uOffset.value.set(offsetX, offsetZ);
    }
  };
}
