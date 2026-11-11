/**
 * 横版寻路 —— 预计算「落脚点导航图」+ BFS。
 *
 * 为什么需要它：
 *   单纯靠「朝目标方向走 + 撞墙就跳」的 AI，在多层地图上会长期卡在掩体后面，
 *   两队隔着中央障碍对视却打不到一起（实测 72 对敌人视线畅通率 0%）。
 *   横版场景的正确做法是先把地图离散成「可站立节点」，
 *   节点之间按跳跃包络连边，然后 A* / BFS 找一条能真正走过去的路线。
 *
 * 节点 = 一段连续可站立的水平面（按 24px 采样合并），记 {x, y, w}。
 * 边 = 从 A 能跳/走到 B（上升 ≤ MAX_RISE，水平 ≤ MAX_RUN，且路径不被墙挡）。
 */

const SAMPLE = 24;
const NODE_GAP = 30;      // 同一平面合并的容差

/* 跳跃包络（由 PHYS 实测推导，改动常量时必须重算）：
 *   最大上升 130px，满速滞空 0.658s，水平 198px
 *   上升 100px 时水平只剩 51px；上升 40px 时只剩 17px
 *   → 上跳必须「几乎原地」，下跳才能横向拉远
 */
const RISE_MAX = 118;       // 能上跳的最大落差
const RUN_DOWN = 210;       // 下跳/平跳的水平可达
const RUN_SAME = 150;       // 同层水平移动
function runForRise(rise) {
  if (rise <= 0) return RUN_DOWN;                 // 下落：最远
  if (rise >= RISE_MAX) return 0;
  // 由抛物包络反推：rise 越大，可用水平越短
  const t = (790 - Math.sqrt(Math.max(0, 790 * 790 - 2 * 2400 * rise))) / 2400;
  return Math.min(RUN_DOWN, 300 * t + 24);        // +24 容差（可以边起跳边跑）
}

export class NavMesh {
  constructor(map) {
    this.map = map;
    this.nodes = [];
    this.edges = [];       // edges[i] = [j, ...]
    this.build();
  }

  build() {
    const { map } = this;
    const solids = map.platforms.filter(p => p.type === 'solid');
    const plats = map.platforms.filter(p => p.type === 'plat');
    const surfaces = [...solids, ...plats];

    // ---- 1. 采样所有「可站立点」 ----
    const points = [];
    for (const s of surfaces) {
      const top = s.y;
      if (top < -400 || top > map.height + 100) continue;
      for (let x = s.x + 12; x <= s.x + s.w - 12; x += SAMPLE) {
        if (this.blocked(x, top - 26)) continue;       // 头顶要有空间站人
        points.push({ x, y: top });
      }
    }

    // ---- 2. 合并成平台节点（同一 y、相邻 x）----
    // 容差放宽到 110：地面被木箱/油桶切开的小段必须合并回一条，
    // 否则导航图会碎成一堆宽度不足的孤岛（掩体是可以跨过去的，不该切断路径）
    points.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const nodes = [];
    let cur = null;
    for (const p of points) {
      if (cur && Math.abs(cur.y - p.y) <= 3 && p.x - cur.x2 <= 110) {
        cur.x2 = p.x;
      } else {
        if (cur) nodes.push(cur);
        cur = { x1: p.x, x2: p.x, y: p.y };
      }
    }
    if (cur) nodes.push(cur);

    this.nodes = nodes.map((n, i) => ({
      i,
      x1: n.x1, x2: n.x2, y: n.y,
      cx: (n.x1 + n.x2) / 2,
    }));

    // ---- 3. 连边 ----
    this.edges = this.nodes.map(() => []);
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = 0; j < this.nodes.length; j++) {
        if (i === j) continue;
        if (this.canTraverse(this.nodes[i], this.nodes[j])) {
          this.edges[i].push(j);
        }
      }
    }

    // ---- 4. 剔除孤岛（连边数为 0 且不是出生平台的节点不可用）----
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.edges[i].length === 0) this.nodes[i].dead = true;
    }
  }

  /** 某点是否被实体砖挡住（用于头顶空间检查） */
  blocked(x, y) {
    for (const s of this.map.platforms) {
      if (s.type !== 'solid') continue;
      if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return true;
    }
    return false;
  }

  /**
   * A 能否到达 B（按跳跃包络判定，用两节点的最近端点计算距离）。
   */
  canTraverse(a, b) {
    const rise = a.y - b.y;            // >0 表示 b 更高
    if (rise > RISE_MAX) return false;               // 跳不上去

    // 1) 水平区间重叠的两层：中间没有横向缺口，直接相通
    //    （必须放在距离检查之前——重叠时用中心点算距离会得到 700 这种假远值）
    const overlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    if (overlap > 20) return true;

    // 2) 用「最近端点对」计算水平距离
    let ax, bx;
    if (a.x2 < b.x1) { ax = a.x2; bx = b.x1; }
    else { ax = a.x1; bx = b.x2; }
    const dx = Math.abs(ax - bx);

    const maxRun = rise > 0 ? runForRise(rise) : RUN_DOWN;
    const limit = rise > -20 ? Math.max(maxRun, RUN_SAME) : maxRun;
    if (dx > limit) return false;

    // 下落（rise < 0）几乎总是可行：只需要落点附近有站立空间
    if (rise < 0) {
      return !this.pathBlocked(bx, b.y - 8, bx, b.y - 46);
    }

    // 上跳：需要起跳点上方净空 + 落点上方净空
    if (this.pathBlocked(ax, a.y - 8, ax, a.y - (rise + 30))) return false;
    if (this.pathBlocked(bx, b.y - 8, bx, b.y - 40)) return false;

    // 横跨缺口时，检查缺口正上方有没有墙横在那里（而不是查 A→B 连线）
    if (dx > 30) {
      const gapLo = Math.min(a.x1, b.x1), gapHi = Math.max(a.x2, b.x2);
      void gapLo; void gapHi;
      const midY = Math.min(a.y, b.y) - 34;
      const steps = Math.ceil(dx / 16);
      let walls = 0;
      for (let i = 1; i < steps; i++) {
        const x = ax + (bx - ax) * (i / steps);
        if (this.blocked(x, midY)) walls++;
      }
      // 整段都被墙挡住才算真的过不去
      if (walls >= steps - 1) return false;
    }
    return true;
  }

  /** 粗粒度直线遮挡检查（只看实体，不看单向平台） */
  pathBlocked(x1, y1, x2, y2) {
    const steps = Math.max(4, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 18));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      for (const s of this.map.platforms) {
        if (s.type !== 'solid') continue;
        if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return true;
      }
    }
    return false;
  }

  /** 找离 (x,y) 最近的节点 */
  nearest(x, y, maxDist = 200) {
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if (n.dead) continue;
      const dx = Math.abs(x - Math.max(n.x1, Math.min(x, n.x2)));
      const dy = Math.abs(y - n.y);
      const d = Math.hypot(dx, dy * 1.6);
      if (d < bd) { bd = d; best = n; }
    }
    return bd <= maxDist ? best : null;
  }

  /**
   * BFS 找路，返回节点序列（含起点与终点节点）。
   * 限制搜索规模，避免大地图上每帧爆算。
   */
  findPath(fromX, fromY, toX, toY) {
    const start = this.nearest(fromX, fromY, 260);
    const goal = this.nearest(toX, toY, 260);
    if (!start || !goal) return null;
    if (start.i === goal.i) return [start, goal];

    const n = this.nodes.length;
    const prev = new Int32Array(n).fill(-1);
    const seen = new Uint8Array(n);
    const q = [start.i];
    seen[start.i] = 1;

    while (q.length) {
      const cur = q.shift();
      if (cur === goal.i) break;
      for (const nb of this.edges[cur]) {
        if (seen[nb]) continue;
        seen[nb] = 1;
        prev[nb] = cur;
        q.push(nb);
      }
    }

    if (!seen[goal.i]) return null;

    const path = [];
    let c = goal.i;
    while (c !== -1) { path.push(this.nodes[c]); c = prev[c]; }
    path.reverse();
    return path;
  }

  /** 路径上的下一个「跳点」：给 AI 用的简化接口 */
  nextWaypoint(p, targetX, targetY) {
    const path = this.findPath(p.x + p.w / 2, p.y + p.bh, targetX, targetY);
    if (!path || path.length === 0) return null;
    // 跳过已到达的节点
    for (const node of path) {
      const dx = Math.max(node.x1 - (p.x + p.w / 2), (p.x + p.w / 2) - node.x2, 0);
      const dy = Math.abs((p.y + p.bh) - node.y);
      if (dx < 26 && dy < 30) continue;    // 已在这一层
      return { x: node.cx, y: node.y };
    }
    return null;
  }
}

/* 每张地图一份缓存 */
const cache = new Map();
export function getNavMesh(map) {
  let nm = cache.get(map.id);
  if (!nm) { nm = new NavMesh(map); cache.set(map.id, nm); }
  return nm;
}

export function navStats(map) {
  const nm = getNavMesh(map);
  const live = nm.nodes.filter(n => !n.dead).length;
  let edges = 0;
  for (const e of nm.edges) edges += e.length;
  return { nodes: nm.nodes.length, live, edges, avgDeg: live ? +(edges / live).toFixed(1) : 0 };
}
