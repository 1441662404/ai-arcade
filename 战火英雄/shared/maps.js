/**
 * 地图数据 —— 纯静态平台，服务端与客户端共用同一份砖块。
 *
 * 设计约束（很重要，AI 与玩家都依赖）：
 *   跳跃最大高度 ≈ 130px（v=790, g=2400）→ 垂直落差一律 ≤ 118px
 *   单跳水平距离 ≈ 195px              → 水平缺口一律 ≤ 160px
 *   地面连续贯通，不做无底深坑（避免掉出地图）
 *
 * 所有地图写完后由 validateMaps() 做连通性校验，确保不会出现把人困住的死角。
 */

const W = 3400;
const H = 900;
const GY = 820;          // 地面顶面
const RISE = 116;        // 相邻平台标准落差
const RUN = 168;         // 相邻平台标准水平步距

/* ---------------- 便捷构造 ---------------- */
const wall = (x, y, w, h) => ({ x, y, w, h, type: 'solid', skin: 'wall' });
const ground = (x, y, w, h) => ({ x, y, w, h, type: 'solid', skin: 'ground' });
const ledge = (x, y, w, h = 26) => ({ x, y, w, h, type: 'solid', skin: 'walk' });
const plank = (x, y, w) => ({ x, y, w, h: 16, type: 'plat', skin: 'plat' });
const crate = (x, y, s = 48) => ({ x, y, w: s, h: s, type: 'solid', skin: 'crate' });
const barrel = (x, y) => ({ x, y, w: 34, h: 52, type: 'solid', skin: 'barrel' });
const hull = (x, y, w, h) => ({ x, y, w, h, type: 'solid', skin: 'hull' });

/**
 * 一段「楼梯」：从 (x,y) 出发，向右/向左交替抬升，保证每一步都可跳上去。
 */
function stairs(x, y, dir, n, step = RUN, rise = RISE, pw = 150) {
  const out = [];
  let cx = x;
  for (let i = 0; i < n; i++) {
    out.push(plank(cx, y - rise * (i + 1), pw));
    cx += dir * step;
  }
  return out;
}

/* ================================================================== */
/*  地图 1 · 深海研究所                                                */
/* ================================================================== */
const labs = {
  id: 'labs',
  name: '深海研究所',
  en: 'Deep Sea Labs',
  desc: '坐落于海洋深处的研究室。金属走廊与通风管道交织，中距离交火密集，中央塔是必争之地。',
  width: W, height: H, groundY: GY,
  theme: {
    sky: ['#0a1524', '#132a42', '#1d4260'],
    ground: '#2a3f56', groundTop: '#4a6b8a',
    accent: '#4dd0e1', glow: 'rgba(77,208,225,0.34)',
    fog: 'rgba(10,26,44,0.8)', parallax: 'tank',
  },
  platforms: [
    /* --- 地面：贯通全长，中央做成三级缓坡（保证 AI 与玩家都能顺畅通行） --- */
    ground(-40, GY, W + 80, H - GY + 200),
    ground(1520, GY - 40, 120, 40),            // 中央缓坡·左段
    ground(1640, GY - 80, 120, 80),            // 中央缓坡·中段（最高点）
    ground(1760, GY - 40, 120, 40),            // 中央缓坡·右段

    /* --- 左出生区：开阔 + 三级阶梯 --- */
    ...stairs(120, GY, 1, 3, 150, 116, 160),
    ledge(60, GY - 460, 240, 26),

    /* --- 右出生区 --- */
    ...stairs(W - 120, GY, -1, 3, 150, 116, 160),
    ledge(W - 300, GY - 460, 240, 26),

    /* --- 中央：缓坡上方的矮掩体（不再封路） --- */
    wall(1670, GY - 120, 60, 40),              // 矮塔柱，站在缓坡中段可跳上
    ledge(1620, GY - 146, 160, 26),            // 矮塔顶小甲板
    // 缓坡两侧的中层平台（高低交叉火力）
    plank(1380, GY - 130, 170),
    plank(1880, GY - 130, 170),
    plank(1600, GY - 300, 200),

    /* --- 中高层平台（左右对称，交错方便跳） --- */
    plank(520, GY - 150, 190),
    plank(840, GY - 266, 190),
    plank(1180, GY - 150, 190),

    plank(2040, GY - 150, 190),
    plank(2380, GY - 266, 190),
    plank(2700, GY - 150, 190),

    /* --- 顶层通道 --- */
    ledge(700, GY - 430, 200, 26),
    ledge(2500, GY - 430, 200, 26),
    plank(1000, GY - 470, 190),
    plank(2210, GY - 470, 190),

    /* --- 掩体 --- */
    crate(360, GY - 48), crate(408, GY - 48), crate(384, GY - 96),
    crate(2900, GY - 48), crate(2948, GY - 48), crate(2924, GY - 96),
    barrel(900, GY - 52), barrel(934, GY - 52),
    barrel(2460, GY - 52), barrel(2494, GY - 52),
    crate(1200, GY - 48), crate(2160, GY - 48),
    barrel(1690, GY - 122),

    /* --- 边界 --- */
    wall(-40, -400, 40, H + 600),
    wall(W, -400, 40, H + 600),
    wall(-40, -460, W + 80, 60),
  ],
  spawn: {
    blue: [{ x: 120, y: GY - 60 }, { x: 200, y: GY - 60 }, { x: 175, y: GY - 130 }, { x: 80, y: GY - 520 }],
    red: [{ x: W - 120, y: GY - 60 }, { x: W - 200, y: GY - 60 }, { x: W - 175, y: GY - 130 }, { x: W - 80, y: GY - 520 }],
    ffa: [{ x: 120, y: GY - 60 }, { x: W - 120, y: GY - 60 }, { x: 1750, y: GY - 250 }, { x: 1050, y: GY - 520 }],
  },
  pickups: [
    { x: 1180, y: GY - 190, type: 'health' }, { x: 2220, y: GY - 190, type: 'health' },
    { x: 1700, y: GY - 460, type: 'health' },
    { x: 610, y: GY - 190, type: 'ammo' }, { x: 2790, y: GY - 190, type: 'ammo' },
    { x: 1700, y: GY - 340, type: 'ammo' },
  ],
  points: [
    { id: 'A', x: 620, y: GY, r: 130 },
    { id: 'B', x: 1700, y: GY, r: 150 },
    { id: 'C', x: 2780, y: GY, r: 130 },
  ],
};

/* ================================================================== */
/*  地图 2 · 密林前哨                                                  */
/* ================================================================== */
const jungle = {
  id: 'jungle',
  name: '密林前哨',
  en: 'Jungle Outpost',
  desc: '丛林里的废弃前哨，树冠与吊桥构成多层立体战场。伏击与反伏击的天堂。',
  width: W, height: H, groundY: GY,
  theme: {
    sky: ['#0d1a14', '#173224', '#245232'],
    ground: '#2f4530', groundTop: '#4d7042',
    accent: '#8bc34a', glow: 'rgba(139,195,74,0.32)',
    fog: 'rgba(12,28,18,0.8)', parallax: 'trees',
  },
  platforms: [
    ground(-40, GY, W + 80, H - GY + 200),
    ground(1580, GY - 60, 260, 60),

    /* 左出生区 */
    ...stairs(130, GY, 1, 3, 150, 116, 160),
    ledge(60, GY - 460, 230, 26),
    /* 右出生区 */
    ...stairs(W - 130, GY, -1, 3, 150, 116, 160),
    ledge(W - 290, GY - 460, 230, 26),

    /* 树干立柱（矮桩掩体，高 110 可直接跳过，不封地面通路） */
    wall(760, GY - 110, 34, 110),
    wall(2560, GY - 110, 34, 110),

    /* 吊桥层 */
    plank(340, GY - 232, 300),
    plank(900, GY - 348, 420),
    plank(2080, GY - 348, 420),
    plank(2760, GY - 232, 300),

    /* 中层交错 */
    plank(560, GY - 150, 180),
    plank(1020, GY - 232, 170),
    plank(1420, GY - 150, 200),
    plank(1780, GY - 232, 170),
    plank(2180, GY - 150, 200),
    plank(2620, GY - 290, 170),

    /* 树冠层 */
    ledge(1080, GY - 460, 210, 26),
    ledge(2110, GY - 460, 210, 26),
    plank(1520, GY - 430, 220),
    plank(1700, GY - 545, 200),

    /* 掩体 */
    crate(320, GY - 48, 52), crate(372, GY - 48, 52),
    crate(2980, GY - 48, 52), crate(3032, GY - 48, 52),
    barrel(900, GY - 52), barrel(934, GY - 52),
    barrel(2460, GY - 52), barrel(2494, GY - 52),
    crate(1200, GY - 48), crate(2160, GY - 48),
    barrel(1720, GY - 96),

    /* 边界 */
    wall(-40, -400, 40, H + 600),
    wall(W, -400, 40, H + 600),
    wall(-40, -650, W + 80, 60),
  ],
  spawn: {
    blue: [{ x: 130, y: GY - 60 }, { x: 210, y: GY - 60 }, { x: 185, y: GY - 130 }, { x: 80, y: GY - 520 }],
    red: [{ x: W - 130, y: GY - 60 }, { x: W - 210, y: GY - 60 }, { x: W - 185, y: GY - 130 }, { x: W - 80, y: GY - 520 }],
    ffa: [{ x: 130, y: GY - 60 }, { x: W - 130, y: GY - 60 }, { x: 1620, y: GY - 490 }, { x: 1100, y: GY - 520 }],
  },
  pickups: [
    { x: 1060, y: GY - 272, type: 'health' }, { x: 2340, y: GY - 272, type: 'health' },
    { x: 1700, y: GY - 600, type: 'health' },
    { x: 640, y: GY - 190, type: 'ammo' }, { x: 2760, y: GY - 272, type: 'ammo' },
    { x: 1700, y: GY - 300, type: 'ammo' },
  ],
  points: [
    { id: 'A', x: 620, y: GY, r: 130 },
    { id: 'B', x: 1700, y: GY, r: 150 },
    { id: 'C', x: 2780, y: GY, r: 130 },
  ],
};

/* ================================================================== */
/*  地图 3 · 坠毁运输机                                                */
/* ================================================================== */
const wreck = {
  id: 'wreck',
  name: '坠毁运输机',
  en: 'Crash Site',
  desc: '一架运输机坠毁在山谷。机翼残骸构成天然掩体，狭窄通道里全是硬碰硬。',
  width: W, height: H, groundY: GY,
  theme: {
    sky: ['#1c1216', '#2e1a20', '#4a2a30'],
    ground: '#3a2c25', groundTop: '#654838',
    accent: '#ff8a5c', glow: 'rgba(255,138,92,0.32)',
    fog: 'rgba(34,18,16,0.8)', parallax: 'ruins',
  },
  platforms: [
    ground(-40, GY, W + 80, H - GY + 200),

    /* 左出生区 */
    ...stairs(140, GY, 1, 3, 150, 116, 160),
    ledge(70, GY - 460, 230, 26),
    /* 右出生区 */
    ...stairs(W - 140, GY, -1, 3, 150, 116, 160),
    ledge(W - 300, GY - 460, 230, 26),

    /* 机身：悬空的残骸甲板，下方地面完全贯通（这是中场的主交火走廊） */
    hull(1420, GY - 210, 460, 70),
    ledge(1420, GY - 236, 460, 26),          // 机身甲板（上方可行走）

    /* 折断机翼：只做矮掩体（高 48，可直接跳过，不封路） */
    hull(1080, GY - 48, 120, 48),
    hull(2100, GY - 48, 120, 48),
    hull(820, GY - 110, 110, 110),
    hull(2380, GY - 110, 110, 110),

    /* 机身之上的高位 */
    plank(1560, GY - 350, 220),
    ledge(700, GY - 500, 200, 26),
    ledge(2500, GY - 500, 200, 26),
    plank(1180, GY - 400, 180),
    plank(2040, GY - 400, 180),

    /* 中层 */
    plank(300, GY - 190, 180),
    plank(2900, GY - 190, 180),

    /* 掩体 */
    crate(520, GY - 48), crate(568, GY - 48),
    crate(2800, GY - 48), crate(2848, GY - 48),
    barrel(1300, GY - 52),
    barrel(2000, GY - 52),
    crate(900, GY - 48), crate(2460, GY - 48),
    barrel(1700, GY - 300),

    /* 边界 */
    wall(-40, -400, 40, H + 600),
    wall(W, -400, 40, H + 600),
    wall(-40, -600, W + 80, 60),
  ],
  spawn: {
    blue: [{ x: 140, y: GY - 60 }, { x: 220, y: GY - 60 }, { x: 195, y: GY - 130 }, { x: 90, y: GY - 520 }],
    red: [{ x: W - 140, y: GY - 60 }, { x: W - 220, y: GY - 60 }, { x: W - 195, y: GY - 130 }, { x: W - 90, y: GY - 520 }],
    ffa: [{ x: 140, y: GY - 60 }, { x: W - 140, y: GY - 60 }, { x: 1700, y: GY - 560 }, { x: 400, y: GY - 560 }],
  },
  pickups: [
    { x: 1290, y: GY - 440, type: 'health' }, { x: 2130, y: GY - 440, type: 'health' },
    { x: 1700, y: GY - 560, type: 'health' },
    { x: 560, y: GY - 340, type: 'ammo' }, { x: 2850, y: GY - 340, type: 'ammo' },
    { x: 1700, y: GY - 200, type: 'ammo' },
  ],
  points: [
    { id: 'A', x: 620, y: GY, r: 130 },
    { id: 'B', x: 1700, y: GY, r: 150 },
    { id: 'C', x: 2800, y: GY, r: 130 },
  ],
};

export const MAPS = { labs, jungle, wreck };
export const MAP_LIST = ['labs', 'jungle', 'wreck'];

export function getMap(id) { return MAPS[id] || MAPS.labs; }

/* ------------------------------------------------------------------ */
/*  判定工具                                                            */
/* ------------------------------------------------------------------ */

export function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

export function pointInRect(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ------------------------------------------------------------------ */
/*  连通性校验 —— 防止出现把人/机器人困住的死角                          */
/* ------------------------------------------------------------------ */
const MAX_RISE = 118;     // 单跳可上升
const MAX_RUN = 175;      // 单跳可横移
const CELL = 20;

function passable(map, x, y) {
  if (x < 4 || x > map.width - 4) return false;
  if (y < -520) return false;
  for (const s of map.platforms) {
    if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return false;
  }
  return true;
}

/** 该点是否「站得住」（下方 12px 内有支撑，且自身不在砖里） */
function standable(map, x, y) {
  if (!passable(map, x, y)) return false;
  for (const s of map.platforms) {
    if (x > s.x && x < s.x + s.w && y + 6 >= s.y && y <= s.y + 4) return true;
  }
  return false;
}

/**
 * 以网格洪泛的方式检查：从蓝方出生点出发，能否到达所有出生点、补给点、据点。
 * 移动约束近似跳跃包络（上升 ≤ MAX_RISE，横移 ≤ MAX_RUN）。
 */
export function validateMaps() {
  const report = [];
  for (const id of MAP_LIST) {
    const map = getMap(id);
    const cols = Math.ceil(map.width / CELL);
    const rows = Math.ceil((map.height + 560) / CELL);
    const idx = (c, r) => r * cols + c;
    const cx = (c) => c * CELL + CELL / 2;
    const cy = (r) => r * CELL + CELL / 2 - 520;

    const ok = new Uint8Array(cols * rows);
    const seen = new Uint8Array(cols * rows);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (passable(map, cx(c), cy(r))) ok[idx(c, r)] = 1;
      }
    }

    // 起点：任意一个蓝方出生点所在的空格
    const start = map.spawn.blue[0];
    let sc = Math.round((start.x - CELL / 2) / CELL);
    let sr = Math.round((start.y - CELL / 2 + 520) / CELL);
    if (!ok[idx(sc, sr)]) {
      // 就近找空格
      let found = false;
      for (let dr = -6; dr <= 6 && !found; dr++) {
        for (let dc = -6; dc <= 6 && !found; dc++) {
          const c = sc + dc, r = sr + dr;
          if (c >= 0 && r >= 0 && c < cols && r < rows && ok[idx(c, r)]) { sc = c; sr = r; found = true; }
        }
      }
      if (!found) { report.push(`${id}: 找不到有效起点`); continue; }
    }

    // BFS
    const q = [idx(sc, sr)];
    seen[q[0]] = 1;
    while (q.length) {
      const cur = q.pop();
      const c = cur % cols;
      const r = (cur - c) / cols;
      for (let dv = -Math.round(MAX_RISE / CELL); dv <= 2; dv++) {
        for (let dh = -Math.round(MAX_RUN / CELL); dh <= Math.round(MAX_RUN / CELL); dh++) {
          if (dv === 0 && dh === 0) continue;
          const nc = c + dh, nr = r + dv;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const ni = idx(nc, nr);
          if (!ok[ni] || seen[ni]) continue;
          seen[ni] = 1;
          q.push(ni);
        }
      }
    }

    // 检查关键点位
    const bad = [];
    const check = (label, x, y) => {
      const c = Math.round((x - CELL / 2) / CELL);
      const r = Math.round((y - CELL / 2 + 520) / CELL);
      let reach = false;
      for (let dr = -3; dr <= 3 && !reach; dr++) {
        for (let dc = -3; dc <= 3 && !reach; dc++) {
          const cc = c + dc, rr = r + dr;
          if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && seen[idx(cc, rr)]) reach = true;
        }
      }
      if (!reach) bad.push(`${label}(${x},${y})`);
    };

    for (const [i, s] of [...map.spawn.blue, ...map.spawn.red, ...map.spawn.ffa].entries()) check('spawn' + i, s.x, s.y);
    for (const pk of map.pickups) check('pickup:' + pk.type, pk.x, pk.y - 10);
    for (const pt of map.points) check('point' + pt.id, pt.x, pt.y - 40);

    // 统计地面连通覆盖率
    let groundCells = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const gy = cy(r);
        if (gy > map.groundY - 30 && gy < map.groundY + 40 && ok[idx(c, r)] && seen[idx(c, r)]) groundCells++;
      }
    }
    report.push(bad.length
      ? `✗ ${id}: ${bad.length} 处不可达 → ${bad.slice(0, 6).join(', ')}`
      : `✓ ${id}: 全部关键点位可达（地面连通格 ${groundCells}）`);
  }
  return report;
}
