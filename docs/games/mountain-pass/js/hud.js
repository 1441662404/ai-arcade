/**
 * HUD：極速快感式儀表（轉速表 / 時速表 / 檔位 / 增壓 / 水溫）、小地圖、計時
 */
import { ROAD } from './trackPath.js';

const FONT = '"Rajdhani","DIN Alternate","Microsoft JhengHei",system-ui,sans-serif';
const MONO = '"Consolas","SF Mono","Menlo",monospace';

export class HUD {
  constructor(root) {
    this.root = root;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 儀表畫布
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gauge-canvas';
    this.ctx = this.canvas.getContext('2d');
    root.appendChild(this.canvas);

    // 小地圖
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.className = 'minimap-canvas';
    this.mapCtx = this.mapCanvas.getContext('2d');
    root.appendChild(this.mapCanvas);

    this.buildDom();
    this.needleSmooth = { rpm: 0, speed: 0, boost: 0, temp: 0 };
    this.flash = 0;
    this.shiftLight = 0;
    this.mapPath = null;
    this.resize();
  }

  buildDom() {
    const d = document.createElement('div');
    d.className = 'hud-overlay';
    d.innerHTML = `
      <div class="hud-tl">
        <div class="hud-driver"><span id="hud-driver-name">夜風</span><span class="hud-car" id="hud-car-name">FR-86</span></div>
        <div class="hud-sub" id="hud-team">霧見山速度之星</div>
      </div>
      <div class="hud-top">
        <div class="hud-timer-wrap">
          <div class="hud-timer" id="hud-timer">00:00.00</div>
          <div class="hud-best" id="hud-best">最佳 00:00.00</div>
        </div>
        <div class="hud-drift" id="hud-drift">
          <div class="hud-drift-score"><span id="hud-drift-score">0</span></div>
          <div class="hud-drift-label" id="hud-drift-label">漂移</div>
        </div>
      </div>
      <div class="hud-center" id="hud-center"></div>
      <div class="hud-pos" id="hud-pos"></div>
      <div class="hud-hint" id="hud-hint"></div>
      <div class="hud-msg" id="hud-msg"></div>
    `;
    this.root.appendChild(d);
    this.dom = {
      overlay: d,
      name: d.querySelector('#hud-driver-name'),
      car: d.querySelector('#hud-car-name'),
      team: d.querySelector('#hud-team'),
      timer: d.querySelector('#hud-timer'),
      best: d.querySelector('#hud-best'),
      drift: d.querySelector('#hud-drift'),
      driftScore: d.querySelector('#hud-drift-score'),
      driftLabel: d.querySelector('#hud-drift-label'),
      center: d.querySelector('#hud-center'),
      pos: d.querySelector('#hud-pos'),
      hint: d.querySelector('#hud-hint'),
      msg: d.querySelector('#hud-msg'),
    };
  }

  setDriver(name, carName, team) {
    this.dom.name.textContent = name;
    this.dom.car.textContent = carName;
    this.dom.team.textContent = team || '';
  }

  resize() {
    const w = Math.min(560, window.innerWidth * 0.44);
    const h = w * 0.42;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.gw = w; this.gh = h;

    const mw = Math.min(260, window.innerWidth * 0.2);
    this.mapCanvas.style.width = mw + 'px';
    this.mapCanvas.style.height = mw * 1.18 + 'px';
    this.mapCanvas.width = Math.round(mw * this.dpr);
    this.mapCanvas.height = Math.round(mw * 1.18 * this.dpr);
    this.mw = mw; this.mh = mw * 1.18;
  }

  setTrack(track) {
    this.track = track;
    const b = track.bounds;
    const pad = 12;
    const w = this.mw - pad * 2, h = this.mh - pad * 2;
    const sc = Math.min(w / (b.maxX - b.minX), h / (b.maxZ - b.minZ));
    const ox = pad + (w - (b.maxX - b.minX) * sc) / 2;
    const oz = pad + (h - (b.maxZ - b.minZ) * sc) / 2;
    this.mapTransform = {
      x: (x) => (x - b.minX) * sc + ox,
      z: (z) => (z - b.minZ) * sc + oz,
      sc,
    };
    // 預先算好路徑
    const pts = [];
    for (let i = 0; i < track.count; i += 3) pts.push([this.mapTransform.x(track.samples[i].x), this.mapTransform.z(track.samples[i].z)]);
    this.mapPath = pts;
  }

  update(dt, s) {
    const g = this.ctx;
    const dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.gw, this.gh);

    const rpm = s.rpm || 0;
    const redline = s.redline || 7500;
    const speed = s.speed || 0;
    const maxSpeed = s.maxSpeed || 300;

    // 平滑指針
    const k = Math.min(1, dt * 12);
    this.needleSmooth.rpm += (rpm - this.needleSmooth.rpm) * k;
    this.needleSmooth.speed += (speed - this.needleSmooth.speed) * Math.min(1, dt * 14);
    this.needleSmooth.boost += ((s.boost || 0) - this.needleSmooth.boost) * k;
    this.needleSmooth.temp += ((s.temp || 82) - this.needleSmooth.temp) * Math.min(1, dt * 2);

    const cx1 = this.gw * 0.235, cy1 = this.gh * 0.58, r1 = Math.min(this.gw * 0.2, this.gh * 0.42);
    const cx2 = this.gw * 0.66, cy2 = this.gh * 0.55, r2 = Math.min(this.gw * 0.185, this.gh * 0.4);

    this.drawTach(g, cx1, cy1, r1, this.needleSmooth.rpm, redline);
    this.drawSpeedo(g, cx2, cy2, r2, this.needleSmooth.speed, maxSpeed);
    this.drawGear(g, this.gw * 0.455, this.gh * 0.34, s.gear || 1);
    this.drawMiniGauge(g, this.gw * 0.055, this.gh * 0.2, Math.min(this.gw * 0.062, this.gh * 0.13), this.needleSmooth.boost, '增壓', 'bar', -1, 1.6, (v) => v.toFixed(1));
    this.drawMiniGauge(g, this.gw * 0.055, this.gh * 0.72, Math.min(this.gw * 0.062, this.gh * 0.13), this.needleSmooth.temp, '水溫', '°C', 40, 130, (v) => v.toFixed(0));

    // 文字資訊
    this.dom.timer.textContent = formatTime(s.time || 0);
    if (s.best) this.dom.best.textContent = '最佳 ' + formatTime(s.best);
    const ds = Math.round(s.driftScore || 0);
    this.dom.driftScore.textContent = ds.toLocaleString('en-US');
    this.dom.drift.classList.toggle('active', !!s.isDrifting);
    if (s.isDrifting) {
      this.dom.driftLabel.textContent = `漂移 x${(s.driftCombo || 1).toFixed(1)}`;
    } else {
      this.dom.driftLabel.textContent = '漂移';
    }
    if (s.position) {
      this.dom.pos.textContent = s.position;
      this.dom.pos.classList.add('show');
    } else {
      this.dom.pos.classList.remove('show');
    }

    this.drawMinimap(s);
  }

  /* ---------- 轉速表 ---------- */
  drawTach(g, cx, cy, r, rpm, redline) {
    const a0 = Math.PI * 0.76, a1 = Math.PI * 2.26;
    const maxRpm = 10000;
    const ang = (v) => a0 + (a1 - a0) * Math.min(1, v / maxRpm);

    // 底盤
    this.dialBase(g, cx, cy, r, 0.055);

    // 紅線區
    g.beginPath();
    g.arc(cx, cy, r * 0.865, ang(redline), ang(maxRpm));
    g.strokeStyle = 'rgba(255,42,26,0.92)';
    g.lineWidth = r * 0.085;
    g.stroke();

    // 刻度
    for (let i = 0; i <= 10; i++) {
      const v = i * 1000;
      const a = ang(v);
      const big = true;
      const r0 = r * 0.78, r1 = r * 0.88;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.strokeStyle = v >= redline ? '#ff4632' : 'rgba(226,235,245,0.92)';
      g.lineWidth = r * 0.028;
      g.stroke();
      // 小刻度
      if (i < 10) {
        for (let j = 1; j < 5; j++) {
          const av = ang(v + j * 200);
          g.beginPath();
          g.moveTo(cx + Math.cos(av) * r * 0.82, cy + Math.sin(av) * r * 0.82);
          g.lineTo(cx + Math.cos(av) * r * 0.87, cy + Math.sin(av) * r * 0.87);
          g.strokeStyle = 'rgba(190,205,220,0.5)';
          g.lineWidth = r * 0.012;
          g.stroke();
        }
      }
      // 數字
      g.save();
      g.fillStyle = v >= redline ? '#ff5b47' : 'rgba(232,240,250,0.95)';
      g.font = `600 ${r * 0.2}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i), cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
      g.restore();
    }

    // 標題
    g.save();
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.font = `600 ${r * 0.115}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('RPM x1000', cx, cy + r * 0.46);
    g.restore();

    // 指針
    const na = ang(rpm);
    this.needle(g, cx, cy, na, r * 0.82, r * 0.13, '#ff2d1a', r * 0.035);

    // 數位轉速
    g.save();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = `700 ${r * 0.16}px ${MONO}`;
    g.textAlign = 'center';
    g.fillText(Math.round(rpm).toString(), cx, cy + r * 0.24);
    g.restore();

    // 換檔燈
    const shiftT = (rpm - redline * 0.9) / (redline * 0.1);
    if (shiftT > 0) {
      const on = Math.sin(performance.now() * 0.02) > 0;
      g.save();
      g.globalAlpha = on ? 1 : 0.35;
      for (let i = 0; i < 5; i++) {
        const a = ang(redline * 0.9 + i * (10000 - redline * 0.9) / 5);
        g.beginPath();
        g.arc(cx + Math.cos(a) * r * 0.99, cy + Math.sin(a) * r * 0.99, r * 0.035, 0, Math.PI * 2);
        g.fillStyle = i < shiftT * 5 ? '#ff2a1a' : '#3a1410';
        g.fill();
      }
      g.restore();
    }
  }

  /* ---------- 時速表 ---------- */
  drawSpeedo(g, cx, cy, r, speed, maxSpeed) {
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.24;
    const ang = (v) => a0 + (a1 - a0) * Math.min(1.02, v / maxSpeed);
    this.dialBase(g, cx, cy, r, 0.05);

    for (let i = 0; i <= 12; i++) {
      const v = (maxSpeed / 12) * i;
      const a = ang(v);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r * 0.79, cy + Math.sin(a) * r * 0.79);
      g.lineTo(cx + Math.cos(a) * r * 0.885, cy + Math.sin(a) * r * 0.885);
      g.strokeStyle = 'rgba(226,235,245,0.9)';
      g.lineWidth = r * 0.026;
      g.stroke();
      g.save();
      g.fillStyle = 'rgba(232,240,250,0.9)';
      g.font = `600 ${r * 0.165}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(Math.round(v)), cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
      g.restore();
      for (let j = 1; j < 4; j++) {
        const av = ang(v + (maxSpeed / 12 / 4) * j);
        g.beginPath();
        g.moveTo(cx + Math.cos(av) * r * 0.83, cy + Math.sin(av) * r * 0.83);
        g.lineTo(cx + Math.cos(av) * r * 0.875, cy + Math.sin(av) * r * 0.875);
        g.strokeStyle = 'rgba(190,205,220,0.45)';
        g.lineWidth = r * 0.011;
        g.stroke();
      }
    }

    this.needle(g, cx, cy, ang(speed), r * 0.8, r * 0.12, '#ff8a3c', r * 0.028);

    // 數位時速
    g.save();
    g.textAlign = 'center';
    g.fillStyle = 'rgba(180,225,255,0.95)';
    g.shadowColor = 'rgba(90,200,255,0.85)';
    g.shadowBlur = r * 0.22;
    g.font = `700 ${r * 0.46}px ${MONO}`;
    g.fillText(String(Math.round(speed)), cx, cy + r * 0.24);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(160,200,230,0.65)';
    g.font = `600 ${r * 0.12}px ${FONT}`;
    g.fillText('KM/H', cx, cy + r * 0.46);
    g.restore();
  }

  drawGear(g, cx, cy, gear) {
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.arc(cx, cy, this.gh * 0.105, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,120,60,0.5)';
    g.lineWidth = 1.4;
    g.stroke();
    g.fillStyle = '#ffd7a8';
    g.shadowColor = 'rgba(255,140,50,0.9)';
    g.shadowBlur = this.gh * 0.06;
    g.font = `700 ${this.gh * 0.14}px ${MONO}`;
    g.fillText(gear > 0 ? String(gear) : 'R', cx, cy + this.gh * 0.005);
    g.restore();
  }

  drawMiniGauge(g, cx, cy, r, value, label, unit, min, max, fmt) {
    const a0 = Math.PI * 0.62, a1 = Math.PI * 2.38;
    const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(6,10,16,0.55)';
    g.fill();
    g.strokeStyle = 'rgba(160,180,200,0.35)';
    g.lineWidth = 1.2;
    g.stroke();
    // 弧
    g.beginPath();
    g.arc(cx, cy, r * 0.78, a0, a1);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = r * 0.16;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r * 0.78, a0, a0 + (a1 - a0) * t);
    g.strokeStyle = t > 0.86 ? '#ff3b26' : '#59c8ff';
    g.lineWidth = r * 0.16;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `700 ${r * 0.34}px ${MONO}`;
    g.textAlign = 'center';
    g.fillText(fmt(value), cx, cy + r * 0.1);
    g.fillStyle = 'rgba(200,215,230,0.55)';
    g.font = `600 ${r * 0.2}px ${FONT}`;
    g.fillText(label, cx, cy + r * 0.5);
    g.restore();
  }

  dialBase(g, cx, cy, r, rimW) {
    const grd = g.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r * 1.05);
    grd.addColorStop(0, 'rgba(18,26,38,0.78)');
    grd.addColorStop(0.72, 'rgba(6,9,14,0.86)');
    grd.addColorStop(1, 'rgba(0,0,0,0.42)');
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = grd;
    g.fill();
    g.strokeStyle = 'rgba(190,215,240,0.30)';
    g.lineWidth = r * rimW;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    g.stroke();
  }

  needle(g, cx, cy, ang, len, tail, color, width) {
    g.save();
    g.translate(cx, cy);
    g.rotate(ang);
    g.shadowColor = color;
    g.shadowBlur = 16;
    g.beginPath();
    g.moveTo(-tail, 0);
    g.lineTo(len, -width * 0.35);
    g.lineTo(len * 1.03, 0);
    g.lineTo(len, width * 0.35);
    g.closePath();
    const grd = g.createLinearGradient(-tail, 0, len, 0);
    grd.addColorStop(0, color);
    grd.addColorStop(0.75, color);
    grd.addColorStop(1, '#ffffff');
    g.fillStyle = grd;
    g.fill();
    g.restore();
    // 中心蓋
    g.beginPath();
    g.arc(cx, cy, tail * 0.85, 0, Math.PI * 2);
    g.fillStyle = 'rgba(20,26,34,0.95)';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1;
    g.stroke();
  }

  /* ---------- 小地圖 ---------- */
  drawMinimap(s) {
    if (!this.mapPath) return;
    const g = this.mapCtx;
    const dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.mw, this.mh);

    // 背板
    g.save();
    const grd = g.createLinearGradient(0, 0, this.mw, this.mh);
    grd.addColorStop(0, 'rgba(6,12,20,0.62)');
    grd.addColorStop(1, 'rgba(4,8,14,0.34)');
    g.fillStyle = grd;
    roundRect(g, 0.5, 0.5, this.mw - 1, this.mh - 1, 10);
    g.fill();
    g.strokeStyle = 'rgba(120,170,210,0.22)';
    g.lineWidth = 1;
    g.stroke();
    g.restore();

    // 路徑
    g.save();
    g.beginPath();
    this.mapPath.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = 'rgba(120,190,240,0.28)';
    g.lineWidth = 4.5;
    g.lineJoin = 'round';
    g.stroke();
    g.strokeStyle = 'rgba(190,230,255,0.85)';
    g.lineWidth = 1.6;
    g.stroke();
    g.restore();

    // 起終點
    const t = this.track;
    if (t) {
      const s0 = this.mapTransform, p0 = t.samples[0], p1 = t.samples[t.count - 1];
      g.beginPath(); g.arc(s0.x(p0.x), s0.z(p0.z), 3.2, 0, 7); g.fillStyle = '#6bff9a'; g.fill();
      g.beginPath(); g.arc(s0.x(p1.x), s0.z(p1.z), 3.2, 0, 7); g.fillStyle = '#ff5a4a'; g.fill();
    }

    // 對手
    if (s.others) {
      for (const o of s.others) {
        const mx = this.mapTransform.x(o.x), mz = this.mapTransform.z(o.z);
        g.beginPath(); g.arc(mx, mz, 2.6, 0, 7);
        g.fillStyle = o.color || '#ffcc66';
        g.fill();
      }
    }

    // 玩家
    if (s.x !== undefined) {
      const mx = this.mapTransform.x(s.x), mz = this.mapTransform.z(s.z);
      g.save();
      g.translate(mx, mz);
      g.rotate(-(s.heading || 0));
      g.beginPath();
      g.moveTo(0, -6.5);
      g.lineTo(4.4, 5);
      g.lineTo(0, 2.4);
      g.lineTo(-4.4, 5);
      g.closePath();
      g.fillStyle = '#4fd2ff';
      g.shadowColor = '#4fd2ff';
      g.shadowBlur = 8;
      g.fill();
      g.restore();
    }
  }

  showCenter(html, cls = '') {
    this.dom.center.innerHTML = html;
    this.dom.center.className = 'hud-center show ' + cls;
  }
  hideCenter() {
    this.dom.center.className = 'hud-center';
  }
  showMsg(text, ms = 1600, cls = '') {
    const el = this.dom.msg;
    el.textContent = text;
    el.className = 'hud-msg show ' + cls;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { el.className = 'hud-msg'; }, ms);
  }
  setHint(text) { this.dom.hint.textContent = text; }
  setVisible(v) {
    this.root.classList.toggle('hud-off', !v);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
