/**
 * 特效：輪胎煙、火花、胎痕
 */
import * as THREE from 'three';

function smokeTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.45, 'rgba(230,235,245,0.22)');
  grd.addColorStop(1, 'rgba(220,230,245,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
export class SmokeSystem {
  constructor(scene, max = 420) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: smokeTexture() }, uOpacity: { value: 0.26 } },
      vertexShader: /* glsl */`
        attribute float aLife;
        attribute float aSize;
        varying float vLife;
        void main(){
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 230.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex;
        uniform float uOpacity;
        varying float vLife;
        void main(){
          vec4 t = texture2D(uTex, gl_PointCoord);
          float a = t.a * vLife * uOpacity;
          if(a < 0.004) discard;
          // 夜裡的輪胎煙要壓暗，不然會糊成一團白光
          gl_FragColor = vec4(vec3(0.42,0.45,0.52), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, size = 1, life = 1.2) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 1;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt / this.maxLife[i];
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 0.965;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * 0.97 + 0.28 * dt;
      this.vel[i * 3 + 2] *= 0.965;
      this.size[i] += dt * 1.5;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
export class SparkSystem {
  constructor(scene, max = 220) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */`
        attribute float aLife;
        varying float vLife;
        void main(){
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = (2.0 + aLife * 5.0) * 200.0 / max(1.0,-mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying float vLife;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = 1.0 - smoothstep(0.1, 0.5, length(c));
          float a = d * vLife;
          if(a < 0.01) discard;
          gl_FragColor = vec4(mix(vec3(1.0,0.35,0.05), vec3(1.0,0.95,0.7), vLife), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    scene.add(this.points);
  }

  burst(x, y, z, n = 12, power = 4) {
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = (Math.random() - 0.5) * power;
      this.vel[i * 3 + 1] = Math.random() * power * 0.7 + 1;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * power;
      this.life[i] = 1;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt * 2.2;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 9.8 * dt;
      this.vel[i * 3] *= 0.96;
      this.vel[i * 3 + 2] *= 0.96;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
export class SkidMarks {
  constructor(scene, max = 900) {
    this.max = max;
    this.head = 0;
    const verts = max * 6 * 3;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(verts);
    this.alpha = new Float32Array(max * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: /* glsl */`
        varying float vA;
        void main(){
          if(vA <= 0.001) discard;
          gl_FragColor = vec4(0.02, 0.02, 0.025, vA * 0.55);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.geo = geo;
  }

  /** 在兩點之間鋪一段胎痕 */
  addSegment(x0, y0, z0, x1, y1, z1, width = 0.22, strength = 1) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * width, nz = dx / len * width;
    const o = i * 18;
    const p = this.pos;
    // 兩個三角形
    const ax = x0 - nx, az = z0 - nz, bx = x0 + nx, bz = z0 + nz;
    const cx = x1 + nx, cz = z1 + nz, dxx = x1 - nx, dzz = z1 - nz;
    const y = Math.max(y0, y1) + 0.035;
    p[o] = ax; p[o + 1] = y0 + 0.035; p[o + 2] = az;
    p[o + 3] = bx; p[o + 4] = y0 + 0.035; p[o + 5] = bz;
    p[o + 6] = cx; p[o + 7] = y1 + 0.035; p[o + 8] = cz;
    p[o + 9] = ax; p[o + 10] = y0 + 0.035; p[o + 11] = az;
    p[o + 12] = cx; p[o + 13] = y1 + 0.035; p[o + 14] = cz;
    p[o + 15] = dxx; p[o + 16] = y1 + 0.035; p[o + 17] = dzz;
    const ao = i * 6;
    for (let k = 0; k < 6; k++) this.alpha[ao + k] = strength;
    void y;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  fade(dt) {
    let dirty = false;
    for (let i = 0; i < this.alpha.length; i++) {
      if (this.alpha[i] > 0) { this.alpha[i] = Math.max(0, this.alpha[i] - dt * 0.02); dirty = true; }
    }
    if (dirty) this.geo.attributes.aAlpha.needsUpdate = true;
  }
}
