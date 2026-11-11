/**
 * 後期處理：泛光 + 電影調色（青藍暗部 / 暖橘高光）+ 暗角 + 顆粒 + 色差 + FXAA
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.92 },
    uGrain: { value: 0.055 },
    uAberration: { value: 0.0016 },
    uSat: { value: 1.12 },
    uContrast: { value: 1.07 },
    uLift: { value: new THREE.Vector3(0.008, 0.014, 0.028) },
    uWarm: { value: 0.16 },
    uFlash: { value: 0 },
    uSpeed: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uSat, uContrast, uWarm, uFlash, uSpeed;
    uniform vec2 uRes;
    uniform vec3 uLift;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c,c);

      // 邊緣色差
      float ab = uAberration * (0.4 + r2 * 2.6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      // 暗角
      float vig = smoothstep(0.92, 0.18, r2 * uVignette * 1.35);
      col *= mix(0.42, 1.0, vig);

      // 對比與飽和
      col = (col - 0.5) * uContrast + 0.5;
      float lum = dot(col, vec3(0.299,0.587,0.114));
      col = mix(vec3(lum), col, uSat);

      // 冷暗部 / 暖高光
      col += uLift * (1.0 - smoothstep(0.0, 0.45, lum));
      col = mix(col, col * vec3(1.06, 1.0, 0.94), uWarm * smoothstep(0.35, 1.0, lum));

      // 速度感（邊緣輕微拉伸模糊感）
      float edge = smoothstep(0.12, 0.62, r2) * uSpeed;
      col = mix(col, col * 0.82, edge * 0.35);

      // 膠片顆粒
      float g = hash(uv * uRes + uTime * 37.0) - 0.5;
      col += g * uGrain;

      // 撞擊閃光
      col = mix(col, vec3(1.0, 0.82, 0.55), uFlash);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export function createPostFX(renderer, scene, camera, opts = {}) {
  const size = renderer.getSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 0,
  });
  const composer = new EffectComposer(renderer, rt);
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 0.88);
  bloom.enabled = opts.bloom !== false;
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const output = new OutputPass();
  composer.addPass(output);

  const fxaa = new ShaderPass(FXAAShader);
  fxaa.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
  composer.addPass(fxaa);

  return {
    composer,
    bloom,
    grade,
    fxaa,
    output,
    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
      fxaa.material.uniforms.resolution.value.set(1 / w, 1 / h);
      grade.uniforms.uRes.value.set(w, h);
    },
    setQuality(q) {
      if (q === 'low') {
        bloom.enabled = false;
        fxaa.enabled = true;
        grade.uniforms.uGrain.value = 0.02;
      } else if (q === 'mid') {
        bloom.enabled = true;
        bloom.strength = 0.4;
        grade.uniforms.uGrain.value = 0.04;
      } else {
        bloom.enabled = true;
        bloom.strength = 0.55;
        grade.uniforms.uGrain.value = 0.055;
      }
    },
    render(dt) {
      grade.uniforms.uTime.value += dt;
      composer.render(dt);
    },
  };
}
