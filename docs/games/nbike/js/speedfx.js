/* =============================================================================
 * Nbike · js/speedfx.js
 * 速度感：真·径向模糊（zoom blur）
 *
 * ── 为什么要这么做 ──────────────────────────────────────────────────────────
 *   之前用 CSS repeating-conic-gradient 画"速度线"，本质只是装饰线条，
 *   玩家反馈"只有几根线，不是动态模糊" —— 确实不是。
 *
 *   主流赛车游戏的做法是 **zoom blur**：把画面绕屏幕中心做多次"放大/缩小"
 *   采样再叠加混合，于是所有像素沿半径方向被拉出拖影，越靠边缘拖得越长。
 *   中心几乎不动 → 视线焦点仍然清晰；边缘强烈拉丝 → 速度感极强。
 *
 * ── 性能 ────────────────────────────────────────────────────────────────────
 *   1. 在**降分辨率**的 2D canvas 上算（默认 1/3 尺寸，够用且极便宜）
 *   2. 采样次数随强度变化：弱时 2 次、最强 5 次
 *   3. 速度低于阈值时**完全不画**（opacity=0 且直接 return）
 *   4. 用 globalAlpha 递减叠加，不必逐像素运算
 * ========================================================================== */

const S = {
  cv: null,
  ctx: null,
  scale: 0.34,        // 降分辨率系数
  w: 0, h: 0,
  enabled: true,
  ready: false,
  lastT: 0,
  minKmh: 34,         // 低于此速度完全不模糊
  maxKmh: 78,         // 达到此速度模糊最强
  maxOffset: 0.055    // 最强时最外圈采样偏移（相对半径）
};

/** 初始化（取 #speedFx 元素尺寸） */
export function init() {
  if (S.ready) return;
  const cv = document.getElementById('speedFx');
  if (!cv) return;
  S.cv = cv;
  S.ctx = cv.getContext('2d');
  if (!S.ctx) return;
  S.ready = true;
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  if (!S.cv) return;
  const w = Math.max(2, Math.round(window.innerWidth * S.scale));
  const h = Math.max(2, Math.round(window.innerHeight * S.scale));
  S.w = w; S.h = h;
  S.cv.width = w; S.cv.height = h;
  /* CSS 尺寸铺满整屏（canvas 内部低分辨率，浏览器负责放大 → 天然再糊一层） */
  S.cv.style.width = '100%';
  S.cv.style.height = '100%';
}

/**
 * 每帧调用（必须在 renderer.render 之后）
 * @param {HTMLCanvasElement} src  WebGL 画布
 * @param {number} speed  m/s
 */
export function render(src, speed) {
  if (!S.ready || !S.enabled) return;
  const kmh = speed * 3.6;

  /* 速度不足 → 清空并隐藏（不做任何采样） */
  if (kmh < S.minKmh) {
    if (S.cv.style.opacity !== '0') {
      S.cv.style.opacity = '0';
      S.ctx.clearRect(0, 0, S.w, S.h);
    }
    return;
  }

  const t = Math.max(0, Math.min(1, (kmh - S.minKmh) / (S.maxKmh - S.minKmh)));
  const strength = t * t;                      // 平方：低速几乎不明显，高速迅速增强
  S.cv.style.opacity = String(Math.min(1, 0.32 + strength * 0.68));

  const ctx = S.ctx, W = S.w, H = S.h;
  ctx.clearRect(0, 0, W, H);

  /* 采样次数：2~5 次，按强度递增 */
  const steps = 2 + Math.round(strength * 3);
  const off = strength * S.maxOffset;

  /* 绕中心做多次缩放叠加：每次略微放大一点点，形成向外的拖影 */
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < steps; i++) {
    const f = 1 + off * (i / Math.max(1, steps - 1));   // 1.00 → 1+off
    const dw = W * f, dh = H * f;
    const dx = (W - dw) * 0.5, dy = (H - dh) * 0.5;
    /* 越靠后的层越淡（模拟拖影衰减） */
    ctx.globalAlpha = i === 0 ? 1 : 0.34 / i;
    try {
      ctx.drawImage(src, dx, dy, dw, dh);
    } catch (e) {
      /* 跨域/上下文丢失时静默跳过，不影响游戏 */
      ctx.globalAlpha = 1;
      return;
    }
  }
  ctx.globalAlpha = 1;

  /* 边缘暗角：径向模糊之后补一层暗角，速度感更"沉" */
  if (strength > 0.15) {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.52, Math.min(W, H) * 0.28,
                                       W * 0.5, H * 0.52, Math.max(W, H) * 0.66);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(strength * 0.34).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

export function setEnabled(on) { S.enabled = !!on; if (!on && S.cv) S.cv.style.opacity = '0'; }
