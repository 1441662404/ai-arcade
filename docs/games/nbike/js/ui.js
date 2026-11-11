/* =============================================================================
 * Nbike · js/ui.js
 * HUD：速度/功率/踏频/心率/坡度 · 排行榜与差距 · 单盘+飞轮换挡 UI ·
 *      双脚绿黄橙红节奏环（本作核心玩法的可视化）· 小地图 · 结果页
 * ========================================================================== */
const C = window.NB.C;
const Track = window.NB.Track;

const $ = (id) => document.getElementById(id);

/* 分档 → 颜色（与服务端 gainBand 完全一致：绿/黄/橙/红） */
const BAND_HEX = { green: '#30d158', yellow: '#ffd60a', orange: '#ff9f0a', red: '#ff3b30' };
const BAND_CN = { green: '绿', yellow: '黄', orange: '橙', red: '红' };

/* ---------------------------------------------------------------------------
 * 双脚节奏环：把曲柄一整圈画成环形，扇区按 gain 着色
 *  · 外圈 12 点 = 0°（左腿上死点），顺时针推进
 *  · 扇区宽 6°，颜色 = 该相位下的 gainBand
 *  · 指针 = 当前曲柄相位；力量条 = 玩家实际施加的力度
 * ------------------------------------------------------------------------ */
/* 单盘节奏环（两条腿合并在一个盘上）
 *
 * 盘上有【两个对称的绿区】：上方绿区对应左脚（按 A），下方绿区对应右脚（按 D）。
 * 指针转一圈 = 曲柄转一圈，扫到哪一格就按住哪一格标注的键：
 *   绿区 → 该侧最佳效率；黄/橙区 → 打折的力；红区 → 反向拖拽。
 * 着色方式：每个扇区取 max(footGain(θ,0), footGain(θ,1)) ——
 *   这样上方绿区显示左脚状态、下方绿区显示右脚状态，与两条腿的真实最佳区间严格对齐。
 *
 * ★ 相位 → 位置映射（a0 = -π）：phase 0°=9点、90°=12点、180°=3点、270°=6点
 *   左脚峰值在 90°→12点，右脚峰值在 270°→6点，正好上下对称。
 * ------------------------------------------------------------------------ */
function makeFootRing(canvas, layoutSide) {
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const CSS = 176;
  canvas.width = CSS * DPR; canvas.height = CSS * DPR;
  canvas.style.width = CSS + 'px'; canvas.style.height = CSS + 'px';
  ctx.scale(DPR, DPR);
  const cx = CSS / 2, cy = CSS / 2;
  const R_OUT = 78, R_IN = 54;
  const SECTORS = 72;                 // 72 × 5° = 360°

  /* 扇区颜色：取两脚中较优的一侧 → 盘上出现上下两个对称绿区（上=A、下=D） */
  const sectorFill360 = [];
  for (let i = 0; i < SECTORS; i++) {
    const deg = i * (360 / SECTORS) + 360 / SECTORS / 2;
    const gl = C.footGain(deg, 0), gr = C.footGain(deg, 1);
    sectorFill360.push(BAND_HEX[C.gainBand(Math.max(gl, gr))]);
  }

  const TAU = Math.PI * 2;
  const a0 = -Math.PI;                 // -π = 9 点 → 90° 落在 12 点
  const phaseToAngle = (deg) => a0 + (deg / 360) * TAU;

  function draw(gain, force, deg, bad, good) {
    ctx.clearRect(0, 0, CSS, CSS);
    /* 归一化到 [0,360)，用于判断指针在上半圈还是下半圈（决定高亮 A 还是 D） */
    const crNow = ((deg % 360) + 360) % 360;

    /* --- 扇区环 --- */
    const sw = TAU / SECTORS;
    for (let i = 0; i < SECTORS; i++) {
      const s = a0 + i * sw, e = s + sw + 0.006;
      ctx.beginPath();
      ctx.arc(cx, cy, R_OUT, s, e);
      ctx.arc(cx, cy, R_IN, e, s, true);
      ctx.closePath();
      ctx.fillStyle = sectorFill360[i];
      ctx.globalAlpha = 0.88;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* --- 环内暗底 --- */
    ctx.beginPath();
    ctx.arc(cx, cy, R_IN - 1.5, 0, TAU);
    ctx.fillStyle = 'rgba(8,11,16,0.86)';
    ctx.fill();

    /* --- 力量条：沿环内侧 */
    if (force > 0.02) {
      const pw = force * (R_IN - 8);
      ctx.beginPath();
      ctx.arc(cx, cy, R_IN - 2, a0, a0 + TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 6; ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R_IN - 2, a0, a0 + TAU * force);
      ctx.strokeStyle = BAND_HEX[good ? 'green' : (bad ? 'red' : 'yellow')];
      ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();
      ctx.lineCap = 'butt';
      void pw;
    }

    /* --- 指针：当前曲柄相位 --- */
    const ang = a0 + (deg / 360) * TAU;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(R_IN - 3, 0);
    ctx.lineTo(R_OUT + 5, 0);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.0;
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();

    /* --- 两个峰值标记：上 12 点 = 左脚(A)，下 6 点 = 右脚(D) ---
     * ★ 画在 canvas 内（环内侧）：既不会被聊天快捷语栏遮挡，
     *   也不会像 HTML 标签那样在窄屏/底部溢出视口。
     *   同时标出当前该按哪个键：轮到哪只脚，对应徽章就高亮。 */
    for (const [pdeg, label] of [[90, 'A'], [270, 'D']]) {
      const pa = phaseToAngle(pdeg);
      const mx = cx + Math.cos(pa) * (R_IN - 14);
      const my = cy + Math.sin(pa) * (R_IN - 14);
      /* 指针在上半圈 = 左脚 A 的相位；下半圈 = 右脚 D（用于高亮） */
      const isActive = (pdeg === 90) === (crNow < 180);
      ctx.beginPath();
      ctx.arc(mx, my, 10, 0, TAU);
      ctx.fillStyle = isActive ? 'rgba(48,209,88,.92)' : 'rgba(10,13,18,.88)';
      ctx.fill();
      ctx.strokeStyle = BAND_HEX.green; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = isActive ? '#06240f' : '#fff';
      ctx.font = '800 12px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my + 0.5);
    }

    /* --- 外发光：颜色 = 指针当前所在格的分档（摁对/摁错一眼可辨） --- */
    const col = BAND_HEX[C.gainBand(gain)];
    ctx.beginPath();
    ctx.arc(cx, cy, R_OUT + 2.5, 0, TAU);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.4;
    ctx.globalAlpha = force > 0.4 ? 0.95 : 0.36;
    ctx.stroke();
    ctx.globalAlpha = 1;
    void bad; void good;
  }
  return { draw, R_OUT, R_IN, CSS, phaseToAngle };
}

/* ---------------------------------------------------------------------------
 * 单盘 + 飞轮 换挡 UI
 * ------------------------------------------------------------------------ */
function buildDrivetrainUI() {
  const ringSvg = $('ring');
  const casSvg = $('cassette');
  const NS = 'http://www.w3.org/2000/svg';

  /* --- 牙盘（50T 单盘）：圆 + 齿 --- */
  ringSvg.innerHTML = '';
  const rc = 50, RING_R = 32;
  const mk = (t, attrs) => { const e = document.createElementNS(NS, t); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  ringSvg.appendChild(mk('circle', { cx: rc, cy: rc, r: RING_R, fill: 'none', stroke: '#8d949c', 'stroke-width': 5 }));
  const teeth = 50;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const x1 = rc + Math.cos(a) * (RING_R + 2.4), y1 = rc + Math.sin(a) * (RING_R + 2.4);
    const x2 = rc + Math.cos(a) * (RING_R + 5.0), y2 = rc + Math.sin(a) * (RING_R + 5.0);
    ringSvg.appendChild(mk('line', { x1, y1, x2, y2, stroke: '#b9c0c8', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
  }
  ringSvg.appendChild(mk('circle', { cx: rc, cy: rc, r: RING_R - 3, fill: 'rgba(20,25,32,.9)', stroke: 'rgba(255,255,255,.14)', 'stroke-width': 1 }));
  // 曲柄 + 踏板
  const crankG = mk('g', {});
  ringSvg.appendChild(crankG);
  const cL = mk('line', { x1: rc, y1: rc, x2: rc, y2: rc - (RING_R - 6), stroke: '#cfd6de', 'stroke-width': 5, 'stroke-linecap': 'round' });
  const cR = mk('line', { x1: rc, y1: rc, x2: rc, y2: rc + (RING_R - 6), stroke: '#9aa2ab', 'stroke-width': 5, 'stroke-linecap': 'round' });
  crankG.appendChild(cL); crankG.appendChild(cR);
  const hub = mk('circle', { cx: rc, cy: rc, r: 6, fill: '#3a414a', stroke: '#6d757e', 'stroke-width': 1.5 });
  ringSvg.appendChild(hub);

  /* --- 飞轮（11T → 32T），横排显示，越左越重（小齿＝重）×
   * ★ 半径必须按真实齿数映射：齿越多，盘越大（真实飞轮就是这样）。
   *   原来写成 r = 24 - (cog-11)/21*13 → 11T 画成大圆、32T 画成小圆，
   *   与真实物理完全相反（用户一眼看出"小齿的 UI 反而小"）。
   *   现在：r 与齿数成正比（带一点下限避免 11T 太小看不清）。
   *   排列方向：左边 = 小齿（重挡），右边 = 大齿（轻挡），
   *   与"往右越轻"的直觉一致，也和 Q/E 的换挡方向对齐。 */
  casSvg.innerHTML = '';
  const N = C.BIKE.CASSETTE.length;
  const W = 300, H = 78;
  const cogEls = [];
  const GX0 = 18, GX1 = W - 18;
  const COG_MIN = C.BIKE.CASSETTE[0], COG_MAX = C.BIKE.CASSETTE[N - 1];
  const R_MIN = 9, R_MAX = 27;                 // 32T 的圆是 11T 的 3 倍
  for (let i = 0; i < N; i++) {
    const t = N > 1 ? i / (N - 1) : 0;
    const x = GX0 + (GX1 - GX0) * t;
    const cog = C.BIKE.CASSETTE[i];
    /* 半径 ∝ 齿数 */
    const r = R_MIN + (cog - COG_MIN) / (COG_MAX - COG_MIN) * (R_MAX - R_MIN);
    const cy = H / 2 - 4;
    const g = mk('g', {});
    g.appendChild(mk('circle', { cx: x, cy, r, fill: 'rgba(24,29,36,.92)', stroke: '#79818a', 'stroke-width': 2 }));
    /* 内圈齿形示意（只在大盘上画，小盘画了会糊） */
    if (r >= 15) {
      g.appendChild(mk('circle', { cx: x, cy, r: r - 5, fill: 'none', stroke: 'rgba(255,255,255,.12)', 'stroke-width': 1 }));
    }
    const lb = mk('text', {
      x, y: H - 2, 'text-anchor': 'middle', 'font-size': 9,
      fill: '#7f8894', 'font-family': 'inherit'
    });
    lb.textContent = cog;
    g.appendChild(lb);
    casSvg.appendChild(g);
    cogEls.push({ g, x, r, cog, cy });
  }
  /* 链条指示：一条斜线跨过当前啮合齿 */
  const chainHi = mk('path', { d: '', fill: 'none', stroke: '#ffd200', 'stroke-width': 2.4, 'stroke-linecap': 'round' });
  casSvg.appendChild(chainHi);

  /* --- 推荐挡位标记：蓝色三角 + 文字，明确"这是建议挡位"，不是可点按钮 --- */
  const recMk = mk('polygon', { points: '', fill: '#0a84ff' });
  casSvg.appendChild(recMk);
  const recTx = mk('text', {
    x: 0, y: 0, 'text-anchor': 'middle', 'font-size': 9,
    fill: '#0a84ff', 'font-family': 'inherit', 'font-weight': '700'
  });
  recTx.textContent = '建议';
  casSvg.appendChild(recTx);

  function update(gear, recommend, shiftFlash) {
    for (let i = 0; i < N; i++) {
      const e = cogEls[i];
      const on = i === gear;
      e.g.querySelector('circle').setAttribute('stroke', on ? '#ffd200' : '#79818a');
      e.g.querySelector('circle').setAttribute('stroke-width', on ? 3.2 : 2);
      e.g.querySelector('circle').setAttribute('fill', on ? 'rgba(255,210,0,.20)' : 'rgba(24,29,36,.92)');
      e.g.querySelector('text').setAttribute('fill', on ? '#ffd200' : '#7f8894');
      e.g.querySelector('text').setAttribute('font-weight', on ? '700' : '400');
    }
    const cur = cogEls[gear] || cogEls[0];
    chainHi.setAttribute('d', `M ${cur.x - cur.r - 3} ${cur.cy - 6} L ${cur.x + cur.r + 3} ${cur.cy + 6}`);
    chainHi.setAttribute('opacity', shiftFlash > 0.05 ? String(0.35 + 0.65 * (1 - shiftFlash)) : '0.92');

    const rec = cogEls[Math.max(0, Math.min(N - 1, recommend))];
    /* 只在"建议挡位 ≠ 当前挡位"时显示蓝色标记，避免与黄色当前挡位混淆。
     * 三角形朝下指向该齿片，上方标「建议」二字说明含义。 */
    const showRec = rec && recommend !== gear;
    recMk.setAttribute('opacity', showRec ? '1' : '0');
    recTx.setAttribute('opacity', showRec ? '1' : '0');
    if (showRec) {
      recMk.setAttribute('points',
        `${rec.x},${rec.cy - rec.r - 8} ${rec.x - 4.5},${rec.cy - rec.r - 1} ${rec.x + 4.5},${rec.cy - rec.r - 1}`);
      recTx.setAttribute('x', rec.x);
      recTx.setAttribute('y', rec.cy - rec.r - 12);
    }

    /* 曲柄角回转 */
    const crankDeg = (gear * 0 + (arguments[3] || 0)) * (180 / Math.PI);
    crankG.setAttribute('transform', `rotate(${crankDeg} ${rc} ${rc})`);
  }
  return { update, ringCrank: (rad) => crankG.setAttribute('transform', `rotate(${rad * 180 / Math.PI} ${rc} ${rc})`) };
}

/* ---------------------------------------------------------------------------
 * 小地图：赛道轮廓 + 自己与近场车手
 * ------------------------------------------------------------------------ */
function makeMinimap() {
  const cv = $('minimap');
  const ctx = cv.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const CSS = cv.clientWidth || 168;
  cv.width = CSS * DPR; cv.height = CSS * DPR;
  ctx.scale(DPR, DPR);

  /* 预投影赛道轮廓（世界 → 画布） */
  const S = Track.getSamples();
  const B = Track.BOUNDS;
  const pad = 14;
  const spanX = B.maxX - B.minX, spanZ = B.maxZ - B.minZ;
  const sc = (CSS - pad * 2) / Math.max(spanX, spanZ);
  const ox = pad + (CSS - pad * 2 - spanX * sc) / 2;
  const oz = pad + (CSS - pad * 2 - spanZ * sc) / 2;
  const px = (x) => ox + (x - B.minX) * sc;
  const pz = (z) => oz + (z - B.minZ) * sc;

  const path = new Path2D();
  for (let i = 0; i < Track.COUNT; i += 4) {
    const X = px(S.CX[i]), Z = pz(S.CZ[i]);
    if (i === 0) path.moveTo(X, Z); else path.lineTo(X, Z);
  }
  path.closePath();

  /* 爬坡段高亮 */
  const climbPaths = Track.CLIMBS.map(c => {
    const p = new Path2D();
    const len = c.s1 > c.s0 ? c.s1 - c.s0 : (Track.PERIM - c.s0 + c.s1);
    const n = Math.max(8, Math.floor(len / 40));
    for (let i = 0; i <= n; i++) {
      const t = Track.posAt(Track.normS(c.s0 + len * (i / n)), 0);
      const X = px(t.x), Z = pz(t.z);
      if (i === 0) p.moveTo(X, Z); else p.lineTo(X, Z);
    }
    return p;
  });

  function draw(me, near, board) {
    ctx.clearRect(0, 0, CSS, CSS);
    /* 底 */
    ctx.save();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.lineJoin = 'round'; ctx.stroke(path);
    ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(180,195,210,.55)';
    ctx.stroke(path);
    /* 爬坡 */
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(255,159,10,.85)';
    for (const cp of climbPaths) ctx.stroke(cp);
    ctx.restore();

    /* 其它车手（来自排行榜，含全场） */
    if (board) {
      for (const r of board) {
        if (r.isMe) continue;
        const p = Track.posAt(r._s || 0, r._lat || 0);
        ctx.beginPath();
        ctx.arc(px(p.x), pz(p.z), 2.6, 0, 6.2832);
        ctx.fillStyle = r.color || '#9aa4b0';
        ctx.globalAlpha = 0.78;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    /* 近场 */
    if (near) {
      for (const q of near) {
        const p = Track.posAt(q.s, q.l);
        ctx.beginPath();
        ctx.arc(px(p.x), pz(p.z), 3.0, 0, 6.2832);
        ctx.fillStyle = q.c || '#fff';
        ctx.fill();
      }
    }
    /* 自己 */
    if (me) {
      const p = Track.posAt(me.s, me.l);
      const X = px(p.x), Z = pz(p.z);
      ctx.beginPath();
      ctx.arc(X, Z, 5.4, 0, 6.2832);
      ctx.fillStyle = '#ffd200';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(X, Z, 8.4, 0, 6.2832);
      ctx.strokeStyle = 'rgba(255,210,0,.5)'; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }
  return { draw };
}

/* ---------------------------------------------------------------------------
 * 右侧节奏轨道（仿音游谱面）
 *
 * 两条竖轨分别对应 A（左脚）/ D（右脚）。
 * 每只脚的"最佳发力窗口"画成一条从上往下滚落的长条音符：
 *   长条头部滚到判定线的那一刻 = 该按下的时机；尾巴离开判定线 = 该松手。
 *
 * ★ 为什么滚落速度天然等于踏频：
 *   音符的纵向位置由【曲柄角差】映射（不是时间），而曲柄角的推进速率
 *   就是踏频。所以踏频快 → 谱面滚得快，玩家看谱就能感知"该多快踩"，
 *   不需要额外做速度换算，也不会和物理脱节。
 *
 * ★ 窗口边界用共享曲线 `C.footGain` 反查（阈值 = 黄区起点 0.45），
 *   即"什么时候该开始发力"与物理判定完全同源，不会出现谱面和判定不一致。
 * ------------------------------------------------------------------------ */
function makeRhythmUI() {
  const cv = $('rhythm');
  if (!cv) return { draw: () => {} };
  const ctx = cv.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const W = 148, H = 310;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.scale(DPR, DPR);

  const LANE_W = (W - 16) / 2;
  const LANE_HW = 21;                                  // 音符半宽
  const laneX = [8 + LANE_W * 0.5, 8 + LANE_W * 1.5];
  const TOP = 16, JUDGE_Y = 268;                       // 判定线位置
  const SPAN = 300;                                    // 纵向可见 300° 的曲柄行程
  const K = (JUDGE_Y - TOP) / SPAN;                    // 每度像素
  const HEAD_DEG = 16;                                 // 音符"头部"长度（该按下的那一段）

  /* 预计算两条轨的发力窗口（只在启动时算一次，阈值固定） */
  const TH = C.PEDAL.TECH_PRESS;
  function windowOf(side) {
    const ok = [];
    for (let d = 0; d < 360; d++) ok.push(C.footGain(d, side) >= TH);
    let bestLen = 0, bestStart = 0;
    for (let s = 0; s < 360; s++) {
      if (!ok[s] || ok[(s + 359) % 360]) continue;      // 只从区间起点开始数
      let len = 0;
      while (len < 360 && ok[(s + len) % 360]) len++;
      if (len > bestLen) { bestLen = len; bestStart = s; }
    }
    return { a: bestStart, len: bestLen };
  }
  const WIN = [windowOf(0), windowOf(1)];

  /* ---- 动态效果状态 ---- */
  const fx = {
    // 判定线脉动：踩对时冲一下
    pulse: [0, 0],
    // 击打粒子
    parts: [],
    // 上一帧的按键状态（做边沿检测）
    prevPress: [0, 0],
    prevInWin: [false, false],
    // 上一次的曲柄角（用于算速度，驱动拖尾长度）
    lastCr: null,
    crSpeed: 0,
    // 音符头部高亮动画
    headGlow: [0, 0],
    // 轨道持续高亮（按住时整条轨道亮起来，仿音游的 lane highlight）
    laneGlow: [0, 0]
  };

  function spawnParts(x, y, ok) {
    const n = ok ? 11 : 8;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      const sp = 55 + Math.random() * 105;
      fx.parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 22,
        life: 1, max: 0.42 + Math.random() * 0.30,
        r: 1.6 + Math.random() * 2.4,
        ok
      });
    }
    /* 粒子太多时丢老的，避免无限增长 */
    if (fx.parts.length > 160) fx.parts.splice(0, fx.parts.length - 160);
  }

  function stepFx(dt) {
    /* 判定线脉动衰减 */
    for (let i = 0; i < 2; i++) {
      fx.pulse[i] = Math.max(0, fx.pulse[i] - dt * 3.6);
      fx.headGlow[i] = Math.max(0, fx.headGlow[i] - dt * 2.8);
    }
    /* 粒子 */
    for (let i = fx.parts.length - 1; i >= 0; i--) {
      const p = fx.parts[i];
      p.life -= dt / p.max;
      if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt;          // 轻微重力，落下去更自然
      p.vx *= (1 - 2.2 * dt);
      p.vy *= (1 - 1.2 * dt);
    }
  }

  /** 曲柄角差 → [-40, SPAN)：正值表示"还没到"（在上方），负值表示"刚过去" */
  function deltaOf(ang, cr) {
    let d = ((ang - cr) % 360 + 360) % 360;
    if (d > SPAN) d -= 360;
    return d;
  }
  const yOf = (d) => JUDGE_Y - d * K;

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function draw(cr, la, ra, lbad, rbad, dt) {
    ctx.clearRect(0, 0, W, H);
    const crr = ((cr % 360) + 360) % 360;
    stepFx(dt || 0.016);

    /* 曲柄角速度（度/秒）：用于让音符拖尾随踏频变长 */
    if (fx.lastCr === null) fx.lastCr = crr;
    let dcr = crr - fx.lastCr;
    if (dcr > 180) dcr -= 360; else if (dcr < -180) dcr += 360;
    fx.crSpeed = dcr / Math.max(1e-3, dt || 0.016);
    fx.lastCr = crr;

    /* --- 两条轨道底（带内发光，比纯色更有质感）
     * ★ 按住时整条轨道点亮（仿节奏大师的 lane highlight）：
     *   底色渐变提亮 + 上缘一道流向判定线的流光，让"正在这条轨上发力"一眼可见。 */
    for (let i = 0; i < 2; i++) {
      const x = laneX[i];
      const pressed = (i === 0 ? la : ra) === 1;
      const bad = (i === 0 ? lbad : rbad) === 1;
      /* 亮度平滑趋近（不突变，跟着按键走） */
      const target = pressed ? 1 : 0;
      fx.laneGlow[i] += (target - fx.laneGlow[i]) * Math.min(1, (dt || 0.016) / 0.07);
      const lg = fx.laneGlow[i];

      const grd = ctx.createLinearGradient(0, TOP - 8, 0, JUDGE_Y + 16);
      if (bad) {
        grd.addColorStop(0, `rgba(255,70,60,${(0.02 + lg * 0.10).toFixed(3)})`);
        grd.addColorStop(1, `rgba(255,70,60,${(0.07 + lg * 0.30).toFixed(3)})`);
      } else {
        grd.addColorStop(0, `rgba(255,255,255,${(0.015 + lg * 0.05).toFixed(3)})`);
        grd.addColorStop(0.55, `rgba(${Math.round(120 + lg * 90)},255,${Math.round(170 + lg * 70)},${(0.03 + lg * 0.13).toFixed(3)})`);
        grd.addColorStop(1, `rgba(255,255,255,${(0.075 + lg * 0.22).toFixed(3)})`);
      }
      ctx.fillStyle = grd;
      roundRect(x - LANE_HW, TOP - 8, LANE_HW * 2, JUDGE_Y - TOP + 16, 9);
      ctx.fill();

      /* 轨道左右两条边线：按住时描边点亮（音游很常见的 lane border） */
      if (lg > 0.02) {
        ctx.strokeStyle = bad
          ? `rgba(255,110,100,${(lg * 0.75).toFixed(3)})`
          : `rgba(150,255,195,${(lg * 0.8).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        roundRect(x - LANE_HW, TOP - 8, LANE_HW * 2, JUDGE_Y - TOP + 16, 9);
        ctx.stroke();
      }

      /* 向上流动的高光条：按住时从判定线往上游走，强化"正在踩"的动感 */
      if (lg > 0.06 && !bad) {
        const span = JUDGE_Y - TOP;
        const cyc = ((performance.now() / 620) + i * 0.37) % 1;
        const ly = JUDGE_Y - cyc * span;
        const g2 = ctx.createLinearGradient(0, ly - 46, 0, ly + 10);
        g2.addColorStop(0, 'rgba(160,255,200,0)');
        g2.addColorStop(1, `rgba(190,255,220,${(lg * 0.30).toFixed(3)})`);
        ctx.fillStyle = g2;
        roundRect(x - LANE_HW, ly - 46, LANE_HW * 2, 56, 6);
        ctx.fill();
      }
    }

    /* --- 按键边沿检测 → 触发粒子与脉动 --- */
    for (let side = 0; side < 2; side++) {
      const pressed = (side === 0 ? la : ra) === 1;
      const inWin = C.footGain(crr, side) >= TH;
      if (pressed && !fx.prevPress[side]) {
        /* 刚按下：踩对 → 绿色爆散 + 判定线冲一下；踩错 → 红色 */
        const ok = inWin;
        spawnParts(laneX[side], JUDGE_Y + 8, ok);
        fx.pulse[side] = ok ? 1 : 0.68;
        fx.headGlow[side] = 1;
      }
      fx.prevPress[side] = pressed ? 1 : 0;
      fx.prevInWin[side] = inWin;
    }

    /* --- 音符（长条） --- */
    for (let side = 0; side < 2; side++) {
      const win = WIN[side];
      const x = laneX[side];
      const pressed = (side === 0 ? la : ra) === 1;
      const bad = (side === 0 ? lbad : rbad) === 1;
      /* 指针是否正处在该侧的发力窗口内 */
      const inWin = C.footGain(crr, side) >= TH;

      /* 逐小段绘制，天然处理窗口跨 360° 折返的情况 */
      for (let a = win.a; a <= win.a + win.len; a += 4) {
        const d = deltaOf(a, crr);
        if (d < -32 || d > SPAN + 16) continue;
        const y = yOf(d);
        if (y < TOP - 20 || y > JUDGE_Y + 34) continue;

        const isHead = (a - win.a) < HEAD_DEG;          // 头部 = 该按下的那一刻
        const segH = K * 4 + 1.2;                       // 略重叠，避免出现缝隙

        if (isHead) {
          /* 音符头：亮色，按下时更亮；踩错时转红
           * ★ 加发光（shadowBlur）+ 按下瞬间的头颈高亮，音符才有"实体撞击感" */
          const glowOn = pressed && inWin;
          if (glowOn) {
            ctx.shadowColor = 'rgba(120,255,170,.95)';
            ctx.shadowBlur = 12 + fx.headGlow[side] * 12;
          } else if (bad) {
            ctx.shadowColor = 'rgba(255,60,48,.9)';
            ctx.shadowBlur = 9;
          } else {
            ctx.shadowColor = 'rgba(48,209,88,.55)';
            ctx.shadowBlur = 5;
          }
          ctx.fillStyle = bad ? 'rgba(255,59,48,.95)'
            : (glowOn ? 'rgba(190,255,215,1)' : 'rgba(48,209,88,.95)');
        } else {
          /* 尾巴：半透明，表示"保持发力"的区间
           * ★ 拖尾随踏频变长（fx.crSpeed 越大留给尾巴的余韵越明显），
           *   静止时不发光，避免糊成一片 */
          ctx.shadowBlur = 0;
          const trailBoost = Math.min(0.14, Math.abs(fx.crSpeed) / 1400);
          ctx.fillStyle = bad ? 'rgba(255,59,48,.30)'
            : `rgba(48,209,88,${(0.26 + trailBoost).toFixed(3)})`;
        }
        roundRect(x - LANE_HW, y - segH, LANE_HW * 2, segH + 1.4, 4);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    /* --- 判定线（每侧独立脉动，按下的那侧会亮起来） --- */
    for (let side = 0; side < 2; side++) {
      const x = laneX[side];
      const pl = fx.pulse[side];
      ctx.beginPath();
      ctx.moveTo(x - LANE_HW, JUDGE_Y + 8);
      ctx.lineTo(x + LANE_HW, JUDGE_Y + 8);
      ctx.strokeStyle = pl > 0.02
        ? `rgba(140,255,190,${(0.5 + pl * 0.5).toFixed(3)})`
        : 'rgba(255,255,255,.30)';
      ctx.lineWidth = 1.5 + pl * 2.4;
      if (pl > 0.02) { ctx.shadowColor = 'rgba(120,255,180,.9)'; ctx.shadowBlur = 14 * pl; }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    /* --- 当前按键状态指示（判定线上的两个圆点，按下时放大脉动） --- */
    for (let side = 0; side < 2; side++) {
      const x = laneX[side];
      const pressed = (side === 0 ? la : ra) === 1;
      const bad = (side === 0 ? lbad : rbad) === 1;
      const inWin = C.footGain(crr, side) >= TH;
      const pl = fx.pulse[side];
      const rr = 8 + pl * 5;
      if (pl > 0.02) { ctx.shadowColor = 'rgba(140,255,190,.95)'; ctx.shadowBlur = 16 * pl; }
      ctx.beginPath();
      ctx.arc(x, JUDGE_Y + 8, rr, 0, Math.PI * 2);
      ctx.fillStyle = bad ? 'rgba(255,59,48,.9)'
        : (pressed ? (inWin ? 'rgba(48,209,88,.97)' : 'rgba(255,214,10,.9)')
                   : 'rgba(255,255,255,.14)');
      ctx.fill();
      ctx.shadowBlur = 0;
      /* 命中环：按下瞬间扩散一圈 */
      if (pl > 0.03) {
        ctx.beginPath();
        ctx.arc(x, JUDGE_Y + 8, rr + 6 + (1 - pl) * 18, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${(pl * 0.55).toFixed(3)})`;
        ctx.lineWidth = 2 * pl;
        ctx.stroke();
      }
    }

    /* --- 击打粒子 --- */
    for (const p of fx.parts) {
      const a = Math.max(0, p.life);
      ctx.globalAlpha = a * 0.95;
      ctx.fillStyle = p.ok ? 'rgba(150,255,195,1)' : 'rgba(255,110,100,1)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.45 + a * 0.75), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* --- 顶部渐隐：让音符"从上方浮出"而不是硬切 --- */
    const g = ctx.createLinearGradient(0, 0, 0, TOP + 46);
    g.addColorStop(0, 'rgba(10,14,20,.92)');
    g.addColorStop(1, 'rgba(10,14,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, TOP + 46);
  }

  return { draw, WIN };
}

/* ---------------------------------------------------------------------------
 * 主 UI 对象
 * ------------------------------------------------------------------------ */
export function createUI() {
  const el = {
    hud: $('hud'),
    speed: $('hSpeed'), speedBar: $('hSpeedBar'),
    power: $('hPower'), cad: $('hCad'), cad2: $('hCad2'), hr: $('hHr'), grade: $('hGrade'),
    elev: $('hElev'), climb: $('hClimb'), dist: $('hDist'), time: $('hTime'),
    stam: $('hStam'), stamBar: $('hStamBar'), qual: $('hQual'),
    rank: $('hRank'), total: $('hTotal'), boardList: $('hBoardList'),
    ahead: $('hAhead'), aheadN: $('hAheadN'),
    behind: $('hBehind'), behindN: $('hBehindN'), leader: $('hLeader'),
    lap: $('hLap'), draft: $('hDraft'), offroad: $('hOffroad'),
    gearName: $('hGearName'), gearIdx: $('hGearIdx'), gearHint: $('hGearHint'),
    coach: $('hCoach'), center: $('centerMsg'), cmBig: $('cmBig'), cmSub: $('cmSub'),
    cornerWarn: $('cornerWarn'), cwDist: $('cwDist'), cwSpd: $('cwSpd'),
    results: $('results'), rsTitle: $('rsTitle'), rsYou: $('rsYou'), rsTable: $('rsTable'),
    chat: $('chatLog'), chatBar: $('chatBar'), netStat: $('netStat'), netTxt: $('netTxt'),
    fps: $('fpsBox'), help: $('helpPanel'), overlayFeet: $('overlayFeet'),
    footL: $('footL'),
    /* 圆环旁的迷你功率牌 */
    pPow: $('pPow'), ppVal: $('ppVal'), ppBar: $('ppBar'), ppLabel: $('ppLabel'),
    /* 右侧节奏谱 */
    rhCad: $('rhCad'), rhKA: document.querySelector('.rh-kA'), rhKD: document.querySelector('.rh-kD'),
    fPush: $('fPush'),
    /* 顶部速度区（用于按速度切换数字辉光） */
    sbSpd: document.querySelector('.sb-spd'),
    loading: $('loading'), ldBar: $('ldBar'), ldMsg: $('ldMsg'), ldStats: $('ldStats'),
    fatal: $('fatal'), fatalMsg: $('fatalMsg')
  };

  /* 单盘：颜色分布用 layoutSide=0（绿区在正上方＝前半边）。
   * 指针喂左脚相位 me.cr；右脚相位恒为 cr+180，对应环的另一侧绿区。 */
  const ringL = makeFootRing(el.footL.querySelector('canvas'), 0);
  const dtUI = buildDrivetrainUI();
  const map = makeMinimap();
  const rhythm = makeRhythmUI();
  /* 速度感叠加层：真·径向模糊 */
  const fxBox = document.getElementById('speedFx');

  /* ===== 节奏谱：可拖动 + 可锁定位置 =====
   * 交互设计：
   *   · 拖标题栏搬家（pointer 事件，鼠标/触屏通用）
   *   · 双击标题栏切换锁定 —— 锁住后拖不动，防止误碰
   *   · 位置存 localStorage，刷新后还在原处
   *   · 拖到边缘时自动夹住，不让它跑出视口 */
  (function initRhythmDrag() {
    const box = document.getElementById('pRhythm');
    const handle = document.getElementById('rhDrag');
    if (!box || !handle) return;
    const KEY_POS = 'nbike.rhythm.pos';
    const KEY_LOCK = 'nbike.rhythm.lock';
    let locked = false;

    function applyPos(x, y) {
      /* 夹住，保证整块留在视口内 */
      const r = box.getBoundingClientRect();
      const maxX = window.innerWidth - r.width - 4;
      const maxY = window.innerHeight - r.height - 4;
      x = Math.max(4, Math.min(maxX, x));
      y = Math.max(4, Math.min(maxY, y));
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
      box.style.transform = 'none';
      return { x, y };
    }

    function savePos() {
      try {
        const r = box.getBoundingClientRect();
        localStorage.setItem(KEY_POS, JSON.stringify({ x: r.x, y: r.y }));
      } catch (e) { /* 隐私模式忽略 */ }
    }

    function setLocked(v) {
      locked = !!v;
      box.classList.toggle('locked', locked);
      try { localStorage.setItem(KEY_LOCK, locked ? '1' : '0'); } catch (e) {}
    }

    /* 恢复上次位置/锁状态 */
    try {
      if (localStorage.getItem(KEY_LOCK) === '1') setLocked(true);
      const raw = localStorage.getItem(KEY_POS);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && isFinite(p.x) && isFinite(p.y)) applyPos(p.x, p.y);
      }
    } catch (e) {}

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    handle.addEventListener('pointerdown', (ev) => {
      if (locked) return;
      /* 只在标题栏上拖，避免误触画布 */
      dragging = true; moved = false;
      const r = box.getBoundingClientRect();
      sx = ev.clientX; sy = ev.clientY; ox = r.x; oy = r.y;
      handle.classList.add('dragging');
      box.classList.add('dragging');
      try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      applyPos(ox + dx, oy + dy);
    });
    function endDrag(ev) {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      box.classList.remove('dragging');
      if (moved) savePos();
      try { handle.releasePointerCapture(ev.pointerId); } catch (e) {}
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    /* 双击切换锁定 */
    handle.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      setLocked(!locked);
      if (!locked) savePos();
    });
    /* 窗口尺寸变化时重新夹一下，避免拖到小屏外 */
    window.addEventListener('resize', () => {
      const r = box.getBoundingClientRect();
      applyPos(r.x, r.y);
    });
  })();  /* 模型旁的脚部提示点 */
  const ofL = el.overlayFeet.querySelector('.of-l');
  const ofR = el.overlayFeet.querySelector('.of-r');
  ofL.classList.add('s-left'); ofR.classList.add('s-right');
  /* 跟着车手浮动的功率数字 */
  const ofPow = el.overlayFeet.querySelector('.of-pow');
  const ofPowVal = document.getElementById('ofPowVal');

  let fatalShown = false;
  /* UI 帧间隔（节奏谱动效用） */
  let lastUiT = performance.now();
  function fatal(msg) {
    if (fatalShown) return;
    fatalShown = true;
    el.fatal.hidden = false;
    let text;
    if (msg && msg.__friendly) text = msg.message;
    else if (msg && msg.message) text = msg.message + (msg.stack ? '\n\n' + msg.stack : '');
    else text = String(msg);
    el.fatalMsg.textContent = text;
    el.loading.classList.add('done');
  }
  window.addEventListener('error', (e) => fatal(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

  function progress(p, msg, stats) {
    el.ldBar.style.width = Math.round(p * 100) + '%';
    if (msg) el.ldMsg.textContent = msg;
    if (stats) el.ldStats.innerHTML = stats;
  }
  function ready() {
    el.loading.classList.add('done');
    setTimeout(() => { el.loading.style.display = 'none'; }, 620);
    el.hud.hidden = false;
  }

  /* ---- 数据格式化 ---- */
  const fmtTime = (t) => {
    if (t == null || !isFinite(t)) return '—';
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  };
  const fmtGap = (d) => {
    if (d == null) return '—';
    const a = Math.abs(d);
    if (a < 0.01) return '并排';
    // 差距 < 60m 显示米，否则显示秒（按 8 m/s 粗估）
    if (a < 120) return (d > 0 ? '+' : '−') + a.toFixed(0) + 'm';
    return (d > 0 ? '+' : '−') + (a / 8).toFixed(1) + 's';
  };

  let lastBoardSig = '';
  let lastClimbKey = '';
  let chatTimer = 0;

  /* ---- 每帧刷新（高频项） ---- */
  function frame(ctx) {
    const { me, board, near, gearAdvice } = ctx;
    /* 防御：任何一块数据缺失都不该让整页崩掉 */
    const ga = gearAdvice || { recommended: me.g, hint: null };
    /* 速度 / 功率 / 踏频 / 心率 / 坡度 */
    const kmh = me.v * 3.6;
    el.speed.textContent = kmh.toFixed(1);
    el.speedBar.style.width = Math.min(100, kmh / 80 * 100) + '%';
    /* 速度数字随速度换辉光：<40 白 / 40~60 绿 / >60 橙（"在飞"的即时反馈） */
    if (el.sbSpd) {
      el.sbSpd.classList.toggle('fast', kmh >= 40 && kmh < 60);
      el.sbSpd.classList.toggle('max', kmh >= 60);
    }

    /* 速度感（径向模糊）由 speedfx.js 独立驱动，这里不再处理 */
    el.power.textContent = Math.round(me.pw);
    el.cad.textContent = Math.round(me.cd);
    el.cad2.textContent = Math.round(me.cd);
    el.hr.textContent = C.estHeartRate(me.pw, me.cd / 110);

    /* 圆环旁的迷你功率牌：数字 + 横条 + 高功率时变色
     * 上限取 600W（职业车手冲刺量级），超过就顶格 */
    const pw = Math.round(me.pw);
    el.ppVal.textContent = pw;
    const pwPct = Math.min(100, pw / 600 * 100);
    el.ppBar.style.width = pwPct + '%';
    el.ppBar.style.background = pw >= 450 ? '#ff9f0a' : (pw >= 300 ? '#ffd60a' : '#30d158');
    el.pPow.classList.toggle('hot', pw >= 300 && pw < 450);
    el.pPow.classList.toggle('max', pw >= 450);
    const g = me.grade;
    el.grade.textContent = (g > 0 ? '+' : '') + g.toFixed(1);
    el.grade.style.color = g > 3 ? '#ff8f8a' : (g < -3 ? '#7ddc9a' : '#fff');
    el.elev.textContent = Math.round(me.elev);

    /* 里程 / 用时
     * ★ 必须用服务端下发的 di（st.dist，物理累积的单调净距离）。
     *   绝不能用 lap*PERIM + s：起步位置在起终点线【后方】(s≈PERIM)，
     *   那样算出来里程会虚高近一整圈（实测起点就显示 8.10km）。 */
    const prog = (me.di != null) ? me.di : 0;
    el.dist.textContent = (prog / 1000).toFixed(2);
    el.time.textContent = fmtTime(me.rt);

    /* 体力 */
    el.stam.textContent = Math.round(me.st);
    el.stamBar.style.width = me.st + '%';
    el.stamBar.style.background = me.st > 60 ? '#30d158' : (me.st > 30 ? '#ffd60a' : '#ff3b30');

    /* 节奏质量 */
    const cyc = me.pc || 0;
    const q = cyc > 0 ? (me.gh / cyc * 100) : 0;
    el.qual.textContent = cyc > 0 ? q.toFixed(0) + '% (完美' + me.gh + ')' : '—';
    el.qual.style.color = q > 70 ? '#30d158' : (q > 45 ? '#ffd60a' : '#ff3b30');

    /* 圈数 */
    el.lap.textContent = '第 ' + Math.min((me.lap || 0) + 1, ctx.laps) + ' / ' + ctx.laps + ' 圈';

    /* 跟风 / 出界 */
    /* --- 吃到尾流的反馈 ---
     * 风阻降低 = dft × MAX_SAVE（dft 是 0~1 的强度），按实测表换算成百分比。
     * dft>0.55 视为"贴得够近"，给强提示（该项目前是玩家最关心的正反馈之一）。 */
    if (me.dft > 0.03) {
      const pct = Math.round(Math.min(1, me.dft) * C.DRAFT.MAX_SAVE * 100);
      el.draft.hidden = false;
      el.draft.querySelector('b').textContent = '−' + pct + '%';
      el.draft.classList.toggle('strong', me.dft > 0.55);
      /* 速度感层之外，再给画面加一圈青色"低压区"边缘光，强化吃到尾流的体感 */
      if (fxBox) fxBox.style.setProperty('--draft', (me.dft > 0.3 ? me.dft : 0).toFixed(3));
    } else {
      el.draft.hidden = true;
      if (fxBox) fxBox.style.setProperty('--draft', '0');
    }
    el.offroad.hidden = !!me.or;

    /* --- 单盘节奏环 ---
     * 一个盘表示曲柄整圈相位，上面有两个对称绿区（上=A 左腿 / 下=D 右腿）。
     * 指针扫到哪一格，按住那一格标注的键就得到该档的力：
     *   绿=最佳效率 · 黄/橙=打折 · 红=反向拖拽。
     * 外发光颜色取"指针当前格的最优 gain"，与你在盘上看到的一致。
     *
     * ★ "按下了"的反馈 = 圆环放大（而不是在外面盖一个色块）。
     *   放大不会遮挡环上任何颜色，玩家能一直看清该踩哪格。
     *   绿区按压放大最多（奖励对的操作），红区按压反而缩小（提示该松手）。 */
    const bandL = C.gainBand(me.lg), bandR = C.gainBand(me.rg);
    const cr = ((me.cr % 360) + 360) % 360;
    const pointerGain = Math.max(C.footGain(cr, 0), C.footGain(cr, 1));
    const pointerBand = C.gainBand(pointerGain);
    ringL.draw(pointerGain, Math.max(me.lf, me.rf), cr, me.rv, me.rv !== true && pointerBand === 'green');

    /* 按压 → 缩放：绿区 +6% 并轻微发光，红区 −4% 收一下提示"别按" */
    const pressing = (me.la === 1 || me.ra === 1);
    const f = el.footL;
    let scale = 1, glow = '';
    if (pressing) {
      if (me.rv === true || pointerBand === 'red') { scale = 0.96; glow = BAND_HEX.red; }
      else if (pointerBand === 'green') { scale = 1.07; glow = BAND_HEX.green; }
      else { scale = 1.04; glow = BAND_HEX[pointerBand]; }
    }
    f.style.transform = 'scale(' + scale.toFixed(3) + ')';
    f.style.filter = glow ? `drop-shadow(0 0 18px ${glow})` : '';
    f.classList.toggle('hold', pressing);
    f.classList.toggle('bad', me.rv === true);

    /* 中央提示：按指针当前格，明确"现在该按哪个键 / 该松手" */
    const push = el.fPush;
    if (me.rv === true) {
      push.textContent = '踩反了 · 松手';
      push.style.color = BAND_HEX.red;
    } else {
      /* 指针在上半圈 → 左腿 A 的相位；下半圈 → 右腿 D */
      const upper = cr < 180;
      const key = upper ? 'A' : 'D';
      const holding = upper ? me.la === 1 : me.ra === 1;
      if (pointerBand === 'green') {
        push.textContent = holding ? '绿区 · 保持' : '绿区 · 按 ' + key;
        push.style.color = BAND_HEX.green;
      } else if (pointerBand === 'red') {
        push.textContent = '红区 · 松手';
        push.style.color = BAND_HEX.red;
      } else {
        push.textContent = BAND_CN[pointerBand] + '区 · 按 ' + key;
        push.style.color = BAND_HEX[pointerBand];
      }
    }

    /* A / D 的高亮已直接画在圆环内（见 makeFootRing 的峰值徽章），
     * 这里不再维护独立的 HTML 侧标签，避免底部空间不足时溢出视口。 */

    /* --- 换挡 UI --- */
    const cog = C.gearCog(me.g);
    el.gearName.textContent = cog + 'T';
    el.gearIdx.textContent = (me.g + 1) + '/' + C.BIKE.CASSETTE.length;
    dtUI.update(me.g, ga.recommended, me.sf, me.cr * Math.PI / 180);
    if (ga.hint) {
      el.gearHint.textContent = ga.hint.msg;
      el.gearHint.style.color = ga.hint.dir > 0 ? '#ffd60a' : '#69c0ff';
    } else {
      el.gearHint.textContent = '';
    }

    /* --- 排行榜 --- */
    if (board) {
      let sig = '';
      const rows = board.rows.map(r => {
        const me_ = r.id === board.me;
        sig += r.id + r.rank + (r.finished ? 'F' : '') + r.lap + '|';
        const gapTxt = me_ ? '—' : (r.finished && r.time != null ? fmtTime(r.time) : fmtGap(r.gapToLeader));
        return `<div class="bi${me_ ? ' me' : ''}${r.finished ? ' fin' : ''}">
          <span class="rk">${r.rank}</span>
          <span class="dt" style="background:${r.color}"></span>
          <span class="nm">${r.name}</span>
          <span class="gp">${gapTxt}</span>
        </div>`;
      }).join('');
      if (sig !== lastBoardSig) {
        lastBoardSig = sig;
        el.boardList.innerHTML = rows;
      }
      el.rank.textContent = board.myRank || '—';
      el.total.textContent = '/ ' + board.rows.length;
      el.ahead.textContent = fmtGap(board.aheadGap);
      el.aheadN.textContent = board.aheadName || '';
      el.behind.textContent = fmtGap(board.behindGap);
      el.behindN.textContent = board.behindName || '';
      el.leader.textContent = fmtGap(board.toLeader);
    }

    /* --- 小地图 --- */
    map.draw(me, near, board ? board.rows : null);

    /* --- 右侧节奏谱：滚落速度由曲柄角驱动（= 踏频），看谱即知该多快踩 --- */
    /* 节奏谱：自己算 dt（ui.frame 不传时间），用于粒子与脉动衰减 */
    const nowMs = performance.now();
    let uiDt = (nowMs - lastUiT) / 1000;
    lastUiT = nowMs;
    if (!(uiDt > 0) || uiDt > 0.12) uiDt = 1 / 60;
    rhythm.draw(me.cr, me.la, me.ra, me.lbad, me.rbad, uiDt);
    if (el.rhCad) el.rhCad.textContent = Math.round(me.cd);
    if (el.rhKA) {
      el.rhKA.classList.toggle('on', me.la === 1 && me.lbad !== 1);
      el.rhKA.classList.toggle('bad', me.lbad === 1);
      el.rhKD.classList.toggle('on', me.ra === 1 && me.rbad !== 1);
      el.rhKD.classList.toggle('bad', me.rbad === 1);
    }

    /* --- 教练提示 --- */
    coach(ctx);

    /* --- 弯道预警 --- */
    const nc = Track.nextCorner(me.s, 260);
    const vKmh = me.v * 3.6;
    if (nc.dist > 25 && nc.dist < 230 && nc.speed < vKmh - 6) {
      el.cornerWarn.hidden = false;
      el.cwDist.textContent = Math.round(nc.dist);
      el.cwSpd.textContent = (nc.right ? '右' : '左') + '弯 · 建议 ' + nc.speed.toFixed(0) + 'km/h';
      el.cornerWarn.classList.toggle('danger', nc.dist < 110);
    } else el.cornerWarn.hidden = true;

    /* --- 模型旁脚部提示定位（由渲染层回填屏幕坐标） ---
     * ★ 这里只画【细描边小圈】，绝不填充实心色块：
     *   设置里提示点正好压在底部节奏环上，填充会把环上的黄/绿/红盖住，
     *   玩家就看不到"现在该按哪儿"了。按下反馈交给节奏环放大（见下面）。 */
    if (ctx.footScreen) {
      const { l, r, top } = ctx.footScreen;
      el.overlayFeet.hidden = false;
      if (l && r) {
        ofL.hidden = false; ofR.hidden = false;
        ofL.style.left = l.x + 'px'; ofL.style.top = l.y + 'px';
        ofR.style.left = r.x + 'px'; ofR.style.top = r.y + 'px';
        ofL.style.borderColor = BAND_HEX[bandL];
        ofR.style.borderColor = BAND_HEX[bandR];
        ofL.classList.toggle('live', me.la === 1);
        ofR.classList.toggle('live', me.ra === 1);
        ofL.classList.toggle('bad', me.lbad === 1);
        ofR.classList.toggle('bad', me.rbad === 1);
      } else {
        /* 脚出画时只藏提示点，功率浮标照旧显示 */
        ofL.hidden = true; ofR.hidden = true;
      }
      /* 头顶功率浮标：纯白数字，跟着车手走 */
      if (top) {
        ofPow.hidden = false;
        ofPow.style.left = top.x + 'px';
        ofPow.style.top = top.y + 'px';
        ofPowVal.textContent = Math.round(me.pw);
      } else {
        ofPow.hidden = true;
      }
    } else {
      el.overlayFeet.hidden = true;
    }

    /* --- 聊天淡出 --- */
    if (el.chat.children.length && performance.now() - chatTimer > 6000) {
      el.chat.removeChild(el.chat.firstChild);
      chatTimer = performance.now();
    }
  }

  /* ---- 教练提示（每 ~0.2s 才更新，避免抖动） ---- */
  let coachAt = 0, coachCur = '';
  function coach(ctx) {
    const now = performance.now();
    if (now - coachAt < 200) return;
    coachAt = now;
    const me = ctx.me;
    let msg = '', bad = false;
    if (me.lbad === 1 && me.la === 1) { msg = '左脚已过发力区 · 松 A'; bad = true; }
    else if (me.rbad === 1 && me.ra === 1) { msg = '右脚已过发力区 · 松 D'; bad = true; }
    else if (ctx.ui.gainBandOfL === 'green' && me.la !== 1) { msg = '左脚进入绿区 · 按 A'; }
    else if (ctx.ui.gainBandOfR === 'green' && me.ra !== 1) { msg = '右脚进入绿区 · 按 D'; }

    if (msg !== coachCur) {
      coachCur = msg;
      if (!msg) { el.coach.hidden = true; }
      else {
        el.coach.hidden = false;
        el.coach.textContent = msg;
        el.coach.classList.toggle('bad', bad);
      }
    }
  }

  /* ---- 中央提示（倒计时 / 出发 / 完赛） ---- */
  function showCenter(big, sub, isGo) {
    el.center.hidden = false;
    el.cmBig.textContent = big;
    el.cmBig.classList.toggle('go', !!isGo);
    el.cmSub.textContent = sub || '';
  }
  function hideCenter() { el.center.hidden = true; }

  /* ---- 网络状态 ---- */
  function net(ok, txt) {
    el.netStat.classList.toggle('ok', ok === true);
    el.netStat.classList.toggle('bad', ok === false);
    el.netStat.classList.remove('ok', 'bad');
    if (ok === true) el.netStat.classList.add('ok');
    else if (ok === false) el.netStat.classList.add('bad');
    if (txt) el.netTxt.textContent = txt;
  }
  function fps(v) { el.fps.textContent = v.toFixed(0) + ' FPS'; }

  /* ---- 结果页 ---- */
  function showResults(payload) {
    el.results.hidden = false;
    el.rsTitle.textContent = payload.title || '比赛结束';
    const y = payload.you;
    if (y) {
      el.rsYou.innerHTML = `
        <div class="kpi"><label>名次</label><b>${y.rank}</b><u>/ ${payload.results.length}</u></div>
        <div class="kpi"><label>成绩</label><b>${fmtTime(y.time)}</b></div>
        <div class="kpi"><label>平均功率</label><b>${y.avgPower}</b><u>W</u></div>
        <div class="kpi"><label>节奏精度</label><b>${y.quality}</b><u>%</u></div>
        <div class="kpi"><label>最高速</label><b>${y.maxSpeed}</b><u>km/h</u></div>`;
    }
    const rows = payload.results.map(r => `
      <tr class="${y && r.id === y.id ? 'me' : ''}">
        <td class="rk">${r.rank}</td>
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${r.color};margin-right:6px"></span>${r.name}</td>
        <td>${fmtTime(r.time)}</td>
        <td>${r.avgPower} W</td>
        <td>${r.quality}%</td>
        <td>${r.maxSpeed} km/h</td>
      </tr>`).join('');
    el.rsTable.innerHTML =
      `<thead><tr><th>名次</th><th>车手</th><th>成绩</th><th>均功率</th><th>节奏</th><th>最高速</th></tr></thead>
       <tbody>${rows}</tbody>`;
  }
  function hideResults() { el.results.hidden = true; }

  /* ---- 聊天 ---- */
  function pushChat(name, color, text) {
    const d = document.createElement('div');
    d.innerHTML = `<b style="color:${color}">${name}</b>${text}`;
    el.chat.appendChild(d);
    while (el.chat.children.length > 5) el.chat.removeChild(el.chat.firstChild);
    chatTimer = performance.now();
  }
  function onChatButton(fn) {
    el.chatBar.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => fn(b.dataset.t));
    });
  }
  function toggleHelp() { el.help.classList.toggle('hide'); }
  function setChatVisible(v) { el.chatBar.hidden = !v; }

  return {
    el, frame, progress, ready, fatal, showCenter, hideCenter,
    net, fps, showResults, hideResults, pushChat, onChatButton,
    toggleHelp, setChatVisible, fmtTime, fmtGap
  };
}
