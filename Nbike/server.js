/* =============================================================================
 * Nbike · server.js
 * 权威服务器 + Socket.IO 实时同步（架构参照《战狗服务器接口文档》）
 *
 * 保留的核心模式：
 *   · 服务端是唯一真相，客户端只上报"意图"
 *   · 客户端预测 + 服务端校正（两端常量/物理逐项一致，见 shared/）
 *   · 30Hz state 广播；静态世界数据 init 一次性下发
 *   · "拒绝必回话"——任何 silent return 都会让客户端永久卡在等待态
 *   · 墙钟性能计时用 performance.now()，物理用固定步长 accumulator
 *
 * 面向骑行竞速新增：
 *   · 跟风风阻系统（尾流锥形区域 → CdA 下降）
 *   · 分级传输（近场 30Hz 全量 / 远场 2Hz 排名）解决带宽
 *   · 位置排行 + 前后车差距
 *   · 比赛流程 waiting → countdown → racing → finished → reset
 *
 * 赛道几何由 shared/track.js 在两端各自生成（同一份代码 → 零漂移、零传输）
 * ========================================================================== */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const C = require('./public/shared/constants.js');
const Track = require('./public/shared/track.js');
const Physics = require('./public/shared/physics.js');

/* 监听端口：PORT 为主端口。可用 EXTRA_PORTS（逗号分隔）追加监听端口，
 * 便于同时服务「旧 :8080 链接」和「标准 :80 链接」，避免用户旧书签失效。 */
const PORT = Number(process.env.PORT) || 3000;
const EXTRA_PORTS = String(process.env.EXTRA_PORTS || '')
  .split(',').map(s => Number(s.trim())).filter(p => Number.isInteger(p) && p > 0 && p < 65536);

const TICK_HZ = C.NET.TICK_HZ;
const TICK_MS = 1000 / TICK_HZ;
const MAX_PLAYERS = C.NET.MAX_PLAYERS;

/* 传输分级：这个距离内的对手按 30Hz 全量下发（含关节动画数据） */
const NEAR_WINDOW = 520;      // 米（沿赛道弧长）
const BOARD_HZ = 2;           // 排行榜下发频率
const MAX_NEAR_FULL = 14;     // 近场全量最多带多少人

/* ============================================================================
 * 1. Express 静态托管
 * ========================================================================== */
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    // 共享物理/赛道文件与主程序禁止缓存，避免"改了没生效"
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/health', (req, res) => {
  res.json({
    ok: true, phase: world.phase, players: players.size,
    track: { perim: +Track.PERIM.toFixed(1), climbs: Track.CLIMBS.length, corners: Track.CORNERS.length },
    uptime: +process.uptime().toFixed(1)
  });
});

/* Socket.IO 配置：照搬文档 §1，别改回默认（公网弱网会陷入重连死循环） */
const io = new Server(server, {
  pingInterval: C.NET.PING_INTERVAL,
  pingTimeout: C.NET.PING_TIMEOUT,
  connectTimeout: C.NET.CONNECT_TIMEOUT,
  maxHttpBufferSize: C.NET.MAX_HTTP_BUFFER,
  cors: { origin: '*' }
});

/* ============================================================================
 * 2. 世界状态
 * ========================================================================== */
let colorCursor = 0;

/** 世界（单房间）
 *  ★ 默认是「自由训练房」：任何人进来立刻就能骑，无需就绪、无需等别人。
 *    比赛（countdown→racing→finished）是可选模式，由房间内任意车手主动发起，
 *    结束后自动回到 free，继续自由骑行。 */
const world = {
  phase: 'free',         // free（自由训练）| countdown | racing | finished
  laps: C.RACE.DEFAULT_LAPS,
  phaseUntil: 0,         // 墙钟时间戳(ms)，到点执行 phase 切换
  countdown: 0,          // 剩余倒计时秒（下发给客户端）
  raceStartAt: 0,
  round: 1,
  results: [],           // [{ id, name, time, rank, avgPower, quality }]
  readySet: new Set(),
  waitSince: 0,          // 进入 waiting 且有人在线的时间戳，用于宽限放行
  lastBoardSent: 0
};

/** 玩家表 id → player */
const players = new Map();

function makePlayer(socket, name) {
  const id = socket.id;
  const p = {
    id,
    name: (name || '').toString().slice(0, 14) || ('Rider-' + id.slice(0, 4)),
    color: C.RIDER_COLORS[colorCursor++ % C.RIDER_COLORS.length],
    st: null,
    lap: 0,
    prevS: 0,
    crossings: 0,
    input: { a: 0, d: 0, steer: 0, brake: 0, throttle: 0, gearDelta: 0 },
    gearDeltaQueue: 0,
    rtt: 0,
    lastInputAt: 0,
    finished: false,
    finishTime: null,
    startOffset: 0,
    dnf: false,
    directGear: null
  };
  p.st = Physics.newRiderState(0, 0, C.BIKE.GEAR_DEFAULT);
  return p;
}

/** 编队出发：横向铺开 + 极小弧长错位（保持公平） */
function assignGrid() {
  const list = [...players.values()];
  const n = list.length;
  const half = C.WORLD.LANE_HALF * 0.86;
  list.forEach((p, i) => {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    const lateral = -half + 2 * half * t;
    // 左右交替，避免同侧扎堆
    const stagger = i * 0.45;
    p.startOffset = stagger;
    p.st = Physics.newRiderState(Track.normS(-stagger), lateral, C.BIKE.GEAR_DEFAULT);
    p.st.crank = C.PEDAL.START_CRANK;
    p.lap = 0; p.crossings = 0; p.prevS = p.st.s;
    p.finished = false; p.finishTime = null; p.dnf = false;
    p.gearDeltaQueue = 0;
  });
}

/* ============================================================================
 * 3. 比赛流程
 * ========================================================================== */
function setPhase(phase, delayMs) {
  world.phase = phase;
  world.phaseUntil = delayMs > 0 ? Date.now() + delayMs : 0;
  io.emit('phase', { phase, laps: world.laps, round: world.round, until: world.phaseUntil });
}

function startCountdown() {
  if (players.size === 0) return;
  assignGrid();                 // 比赛才重排发车格；自由骑行不打断在骑的人
  world.results = [];
  world.readySet.clear();
  for (const p of players.values()) {
    p.finished = false; p.finishTime = null; p.dnf = false;
    p.st.raceTime = null;       // 自由骑行时不计时，开赛才起表
    p.lastLapTime = 0;
  }
  setPhase('countdown', C.RACE.COUNTDOWN * 1000);
  world.countdown = C.RACE.COUNTDOWN;
  io.emit('countdown', { seconds: C.RACE.COUNTDOWN, laps: world.laps });
  console.log(`[race] 倒计时开始 · ${players.size} 名车手 · ${world.laps} 圈`);
}

function startRace() {
  setPhase('racing');
  world.raceStartAt = Date.now();
  for (const p of players.values()) {
    p.raceStartAt = world.raceStartAt;
    p.st.raceTime = 0;
  }
  io.emit('raceStart', { at: world.raceStartAt, laps: world.laps });
  console.log('[race] 出发！');
}

function endRace(reason) {
  // 结算：已完赛的按成绩，未完赛的按进度排
  const list = [...players.values()].map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    time: p.finishTime,
    progress: p.st.dist,
    avgPower: p.st.avgPower,
    quality: p.st.pressCycles > 0 ? p.st.qualitySum / p.st.pressCycles : 0,
    goodHits: p.st.goodHits,
    badHits: p.st.badHits,
    maxSpeed: p.st.maxSpeed
  })).sort((a, b) => {
    if (a.time != null && b.time != null) return a.time - b.time;
    if (a.time != null) return -1;
    if (b.time != null) return 1;
    return b.progress - a.progress;
  });
  list.forEach((r, i) => { r.rank = i + 1; });
  world.results = list;
  io.emit('matchEnd', {
    reason,
    laps: world.laps,
    round: world.round,
    results: list.map(r => ({
      id: r.id, name: r.name, color: r.color, rank: r.rank,
      time: r.time == null ? null : +r.time.toFixed(3),
      avgPower: +r.avgPower.toFixed(0),
      quality: +(r.quality * 100).toFixed(0),
      goodHits: r.goodHits, badHits: r.badHits,
      maxSpeed: +(r.maxSpeed * 3.6).toFixed(1)
    }))
  });

  /* ★ finish 只作为"结算展示"的中转态：先广播成绩，再回落。
   *   手动结束 → 立刻回自由训练（玩家不想等）
   *   正常完赛 → 停留 RESET_DELAY 秒供观看成绩，再回自由训练 */
  if (reason === 'manual') {
    resetToFree();
  } else {
    setPhase('finished', C.RACE.RESET_DELAY * 1000);
  }
  console.log(`[race] 结束（${reason}）· 冠军 ${list[0] ? list[0].name : '-'}`);
}

function resetToFree() {
  world.round++;
  world.results = [];
  world.readySet.clear();
  world.waitSince = 0;
  world.laps = world.nextLaps || world.laps;
  world.nextLaps = null;
  for (const p of players.values()) {
    p.lap = 0; p.crossings = 0; p.finished = false; p.finishTime = null; p.dnf = false;
    p.st.raceTime = null;       // 回到自由训练：不计时
  }
  setPhase('free');             // ★ 回到自由训练，而不是"等待开赛"
  io.emit('matchReset', { round: world.round, laps: world.laps });
  console.log('[race] 比赛结束，回到自由训练');
}

/* ============================================================================
 * 4. 跟风风阻系统
 *    B 在前车 A 的尾流锥内 → B 的 CdA 下降（最多降到 MIN_CDA）
 *    ★ 纵向差距一律用 st.dist（物理累积的单调净距离），
 *      不能用 lap*PERIM+s —— 出发时车手排在起终点线【后方】(s 接近 PERIM)，
 *      那样算出来的 "领先量" 会虚高近一整圈（实测 8095m）。
 * ========================================================================== */
function computeDraft() {
  const list = [...players.values()].filter(p => !p.dnf);
  for (const p of list) {
    p.st.draft = 0;
    p.st.cdaFactor = 1;
  }
  if (list.length < 2) return;

  const D = C.DRAFT;
  for (const b of list) {
    let bestFactor = 1, bestStrength = 0;
    const bProg = b.st.dist;
    for (const a of list) {
      if (a === b) continue;
      const gap = bProg - a.st.dist;
      if (gap <= D.GAP0 || gap > D.MAX_DIST) continue;

      /* 横向：真实尾流只比车身宽一点（±1.1m），偏出去就几乎没效果 */
      const latDiff = Math.abs(b.st.lateral - a.st.lateral);
      if (latDiff > D.LAT_MAX) continue;
      const latFactor = 1 - Math.pow(latDiff / D.LAT_MAX, 1.7);

      // 前车速度：太慢的车手尾流无意义（跟风要有实际气流）
      if (a.st.speed < 4) continue;

      /* ★ 纵向：按风洞数据做指数衰减
       *   k(gap) = MAX_SAVE * exp(-(gap - GAP0) / LAMBDA)
       *   gap=0.1m→42% / 0.5m→31% / 1.0m→21% / 3.0m→10% / 10m→0.2%
       *   （与 Blocken 实测表逐点吻合；原来是线性拉到 48m，严重高估远处效果） */
      const decay = Math.exp(-(gap - D.GAP0) / D.LAMBDA);
      const strength = latFactor * decay;
      if (strength <= bestStrength) continue;

      bestStrength = strength;
      /* strength=1（贴满正后方）时 CdA 降到 MIN_CDA */
      bestFactor = C.lerp(1, D.MIN_CDA, Math.min(1, strength));
    }
    b.st.cdaFactor = bestFactor;
    b.st.draft = bestStrength;
  }
}

/* ============================================================================
 * 5. 位置排行 + 差距
 *    progress 用 st.dist（单调净距离），理由见 computeDraft 注释。
 * ========================================================================== */
function computeRanking() {
  const list = [...players.values()].filter(p => !p.dnf);
  list.forEach(p => { p.progress = p.st.dist; });
  list.sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  list.forEach((p, i) => {
    p.rank = i + 1;
    p.progressFromLeader = p.progress - (list[0] ? list[0].progress : p.progress);
  });
  return list;
}

/* ============================================================================
 * 6. 主循环 30Hz
 * ========================================================================== */
let loopLagWarn = 0;

function tick() {
  const now = Date.now();
  const dtRaw = Math.min((now - tick.last) / 1000, C.NET.MAX_DT);   // ★ dt 上限 0.1s
  tick.last = now;

  /* ---- 阶段推进 ----
   * ★ free 是常态：没人按"开始比赛"就一直自由骑行，不做任何等待/门槛。
   *   只有显式发起比赛后，才走 countdown → racing → finished → 回到 free。 */
  if (world.phase === 'countdown') {
    const remain = Math.max(0, (world.phaseUntil - now) / 1000);
    world.countdown = remain;
    if (remain <= 0) startRace();
  } else if (world.phase === 'finished') {
    if (world.phaseUntil && now >= world.phaseUntil) resetToFree();
  }

  /* 自由训练 / 比赛 / 结算等待都推进物理，避免任何阶段"车不动" */
  const racing = world.phase === 'racing';
  const running = world.phase === 'free' || racing || world.phase === 'finished';

  /* ---- 物理推进（服务端权威） ---- */
  if (running) {
    computeDraft();
    for (const p of players.values()) {
      if (p.dnf || p.finished) {
        // 完赛后滑行减速，仍接受转向输入（自由骑行）
        p.input.a = 0; p.input.d = 0; p.input.brake = 0;
      }
      const ctx = {
        slope: Track.slopeAt(p.st.s),
        curv: Track.curvatureAt(p.st.s),
        onRoad: Math.abs(p.st.lateral) <= C.WORLD.LANE_HALF,
        cdaFactor: p.st.cdaFactor,
        headwind: 0
      };

      // 折入换挡意图（客户端 20Hz 上报，累积到 tick 处理，避免丢按键）
      const input = {
        a: p.input.a, d: p.input.d,
        steer: p.input.steer, brake: p.input.brake, throttle: p.input.throttle,
        gearDelta: p.gearDeltaQueue
      };
      p.gearDeltaQueue = 0;

      const prevS = p.st.s;
      Physics.step(p.st, input, ctx, dtRaw);
      if (p.st.raceTime != null) p.st.raceTime += dtRaw;

      // 终点线判定：s 从大跳到小 = 越过起终点线
      if (prevS > p.st.s && (prevS - p.st.s) > Track.PERIM * 0.5) {
        p.crossings++;
        p.lap = p.crossings;

        /* ★ 自由训练：只累计圈数用于显示，不判完赛、不判 DNF */
        if (racing) {
          // 每过一圈（非终点）给一次圈报
          if (p.crossings < world.laps) {
            io.to(p.id).emit('lap', {
              lap: p.crossings, laps: world.laps,
              lapTime: p.st.raceTime - (p.lastLapTime || 0),
              rank: p.rank
            });
            p.lastLapTime = p.st.raceTime;
          }
          if (p.crossings >= world.laps && !p.finished) {
            p.finished = true;
            p.finishTime = p.st.raceTime;
            io.emit('finish', { id: p.id, name: p.name, time: +p.finishTime.toFixed(3), rank: 0 });
            io.to(p.id).emit('youFinished', {
              time: +p.finishTime.toFixed(3),
              laps: world.laps,
              avgPower: +p.st.avgPower.toFixed(0),
              quality: p.st.pressCycles > 0 ? +(p.st.qualitySum / p.st.pressCycles * 100).toFixed(0) : 0,
              goodHits: p.st.goodHits, badHits: p.st.badHits,
              maxSpeed: +(p.st.maxSpeed * 3.6).toFixed(1)
            });
          }
        }
      }

      // 超时保护：仅比赛阶段生效（自由训练不该被 DNF）
      if (racing && !p.finished && p.st.raceTime > C.RACE.DNF_TIMEOUT) {
        p.dnf = true;
        io.to(p.id).emit('dnf', { reason: 'timeout' });
      }
    }

    // 全部完赛/退赛 → 结束（仅比赛阶段）
    if (racing) {
      const active = [...players.values()].filter(p => !p.dnf);
      if (active.length > 0 && active.every(p => p.finished)) endRace('all-finished');
    }
  }

  /* ---- 排行 ---- */
  const ranked = computeRanking();

  /* ---- 下发 state（自由训练与比赛都全量；无人在线时省流量） ---- */
  const sendFull = running || world.phase === 'countdown' || world.phase === 'finished';
  if (sendFull || players.size > 0) {
    for (const p of players.values()) {
      const myProg = p.st.dist;
      const near = [];
      for (const q of ranked) {
        if (q === p) continue;
        const gap = q.st.dist - myProg;
        if (Math.abs(gap) <= NEAR_WINDOW) near.push({ q, gap });
      }
      near.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
      const chosen = near.slice(0, MAX_NEAR_FULL);

      io.to(p.id).emit('state', {
        t: now,
        you: packSelf(p),
        near: chosen.map(x => packNear(x.q, x.gap)),
        // 近场之外的人数（客户端据此显示"视线外还有 N 人"）
        far: Math.max(0, ranked.length - 1 - chosen.length),
        rank: p.rank || 0,
        total: ranked.length,
        laps: world.laps,
        phase: world.phase,
        countdown: +world.countdown.toFixed(2)
      });
    }
  }

  /* ---- 排行榜（2Hz，含全体差距） ---- */
  if (now - world.lastBoardSent > 1000 / BOARD_HZ) {
    world.lastBoardSent = now;
    if (players.size > 0) {
      const rows = ranked.map(q => ({
        id: q.id, name: q.name, color: q.color,
        rank: q.rank,
        lap: q.lap, laps: world.laps,
        s: +q.st.s.toFixed(1),
        progress: +q.st.dist.toFixed(1),
        gapToLeader: +(q.progress - (ranked[0] ? ranked[0].progress : q.progress)).toFixed(2),
        speed: +(q.st.speed * 3.6).toFixed(1),
        power: +q.st.power.toFixed(0),
        finished: q.finished, dnf: q.dnf,
        time: q.finishTime == null ? null : +q.finishTime.toFixed(3),
        draft: +q.st.draft.toFixed(2)
      }));
      for (const p of players.values()) {
        const myIdx = rows.findIndex(r => r.id === p.id);
        // 附带"前后车差距"（相对自己）
        const ahead = myIdx > 0 ? rows[myIdx - 1] : null;
        const behind = myIdx >= 0 && myIdx < rows.length - 1 ? rows[myIdx + 1] : null;
        io.to(p.id).emit('board', {
          rows,
          me: p.id,
          aheadGap: ahead ? +(p.st.dist - (ahead.progress)).toFixed(2) : null,
          aheadName: ahead ? ahead.name : null,
          behindGap: behind ? +((behind.progress) - (p.st.dist)).toFixed(2) : null,
          behindName: behind ? behind.name : null,
          toLeader: +(p.st.dist - (rows[0] ? rows[0].progress : 0)).toFixed(2)
        });
      }
    }
  }

  /* ---- 倒计时逐秒广播 ---- */
  if (world.phase === 'countdown') {
    const sec = Math.ceil(world.countdown);
    if (sec !== world.lastCountdownSec) {
      world.lastCountdownSec = sec;
      if (sec > 0 && sec <= 5) io.emit('countdownTick', { seconds: sec });
    }
  }

  /* ---- 主循环耗时监控（低帧率下 dt 会被钳，导致物理变慢） ---- */
  const cost = Date.now() - now;
  if (cost > TICK_MS * 1.6 && now - loopLagWarn > 5000) {
    loopLagWarn = now;
    console.warn(`[loop] tick 耗时 ${cost}ms 超过预算 ${TICK_MS.toFixed(1)}ms，物理步进可能被 dt 上限截断`);
  }
}
tick.last = Date.now();

/* ============================================================================
 * 7. 序列化（紧凑 key，降低带宽）
 * ========================================================================== */
function packSelf(p) {
  const st = p.st;
  const l = Physics.footUI(st, 0), r = Physics.footUI(st, 1);
  return {
    i: p.id, n: p.name, c: p.color,
    s: +st.s.toFixed(2), l: +st.lateral.toFixed(2), v: +st.speed.toFixed(2),
    /* ★ 里程必须用 dist（物理累积的单调净距离）。前端若自行用 lap*PERIM+s 计算，
     *   起步位置在起终点线【后方】(s≈PERIM) 会让里程虚高近一整圈（显示 8.10km）。 */
    di: +st.dist.toFixed(2),
    cr: +st.crank.toFixed(1),
    lf: +st.leftForce.toFixed(3), rf: +st.rightForce.toFixed(3),
    pw: +st.power.toFixed(0), cd: +st.cadence.toFixed(1),
    g: st.gear, gc: +st.gearCd.toFixed(2), sf: +st.shiftFlash.toFixed(2),
    cb: +st.combo.toFixed(3), st: +st.stamina.toFixed(1),
    ln: +st.lean.toFixed(3),
    /* 曲柄/力矩/提示分档：客户端 HUD 直接消费 */
    lg: +l.gain.toFixed(3), rg: +r.gain.toFixed(3),
    lb: l.band, rb: r.band,
    /* 有效力矩（可负）与反向标记，用于 HUD 提示"踩反了" */
    dg: +st.driveGain.toFixed(3), rv: st.reverse ? 1 : 0,
    la: l.active ? 1 : 0, ra: r.active ? 1 : 0,
    lgood: l.good ? 1 : 0, rgood: r.good ? 1 : 0,
    lbad: l.bad ? 1 : 0, rbad: r.bad ? 1 : 0,
    lap: p.lap, dft: +st.draft.toFixed(2), cda: +st.cdaFactor.toFixed(3),
    fin: p.finished ? 1 : 0, dnf: p.dnf ? 1 : 0,
    rt: st.raceTime == null ? null : +st.raceTime.toFixed(2),
    or: st.onRoad ? 1 : 0, br: st.braking ? 1 : 0,
    gh: st.goodHits, bh: st.badHits, pc: st.pressCycles,
    grade: +Track.gradeAt(st.s).toFixed(2),
    elev: +Track.elevationAt(st.s).toFixed(1)
  };
}

function packNear(q, gap) {
  const st = q.st;
  return {
    i: q.id, n: q.name, c: q.color,
    s: +st.s.toFixed(2), l: +st.lateral.toFixed(2), v: +st.speed.toFixed(2),
    cr: +st.crank.toFixed(1), g: st.gear, ln: +st.lean.toFixed(3),
    pw: +st.power.toFixed(0), cd: +st.cadence.toFixed(1),
    lap: q.lap, gap: +gap.toFixed(2), dft: +st.draft.toFixed(2),
    fin: q.finished ? 1 : 0, dnf: q.dnf ? 1 : 0
  };
}

/* ============================================================================
 * 8. Socket 事件
 * ========================================================================== */
io.on('connection', (socket) => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit('serverFull', { max: MAX_PLAYERS });
    socket.disconnect(true);
    return;
  }

  const name = socket.handshake.query?.name;
  const p = makePlayer(socket, name);
  players.set(socket.id, p);

  /* ★ 入场落位：
   *   · 自由训练 → 直接给他在赛道上的可用状态（立刻能骑），不打断别人、不重排发车格
   *   · 比赛中   → 排到大部队后方，跟骑（不重排、不打断） */
  if (world.phase === 'free') {
    const others = [...players.values()].filter(q => q !== p);
    const lateral = others.length
      ? C.clamp(others[others.length - 1].st.lateral + 0.6, -C.WORLD.LANE_HALF * 0.86, C.WORLD.LANE_HALF * 0.86)
      : 0;
    const s0 = others.length ? Track.normS(others[others.length - 1].st.s - 8) : Track.normS(-2);
    p.st = Physics.newRiderState(s0, lateral, C.BIKE.GEAR_DEFAULT);
    p.st.crank = C.PEDAL.START_CRANK;
    p.st.raceTime = null;       // 自由骑行不计时
  } else if (world.phase === 'racing' || world.phase === 'countdown') {
    const others = [...players.values()].filter(q => q !== p);
    const back = others.length ? Math.max(...others.map(q => q.st.dist)) - 25 : 0;
    const s0 = Track.normS(Track.PERIM + back);   // 起点线后方
    p.st = Physics.newRiderState(s0, 0, C.BIKE.GEAR_DEFAULT);
    p.st.crank = C.PEDAL.START_CRANK;
    if (world.phase === 'racing') {
      p.st.raceTime = 0;
      p.raceStartAt = world.raceStartAt;
    }
  }
  p.lap = 0; p.crossings = 0; p.prevS = p.st.s;
  p.finished = false; p.finishTime = null; p.dnf = false;

  console.log(`[join] ${p.name} (${socket.id.slice(0, 6)}) · 在线 ${players.size} · ${world.phase}`);

  /* ---- 一次性下发静态世界数据 ---- */
  socket.emit('init', {
    id: p.id,
    name: p.name,
    color: p.color,
    phase: world.phase,
    round: world.round,
    laps: world.laps,
    lapOptions: C.RACE.LAP_OPTIONS,
    /* 赛道由客户端加载同一份 shared/track.js 生成，此处只给摘要用于 HUD */
    track: {
      perim: +Track.PERIM.toFixed(2),
      climbs: Track.CLIMBS.map(c => ({
        cat: c.category, s0: +c.s0.toFixed(0), s1: +c.s1.toFixed(0),
        length: +c.length.toFixed(0), avgGrade: +c.avgGrade.toFixed(2), gain: +c.gain.toFixed(0)
      })),
      corners: Track.CORNERS.map(c => ({
        s0: +c.s0.toFixed(0), s1: +c.s1.toFixed(0), R: +c.R.toFixed(1), right: c.right
      })),
      bounds: Track.BOUNDS,
      maxElev: +Track.BOUNDS.maxY.toFixed(0),
      minElev: +Track.BOUNDS.minY.toFixed(0)
    },
    bike: {
      cassette: C.BIKE.CASSETTE,
      chainring: C.BIKE.CHAINRING,
      gearMin: C.BIKE.GEAR_MIN, gearMax: C.BIKE.GEAR_MAX,
      gearDefault: C.BIKE.GEAR_DEFAULT
    },
    players: [...players.values()].map(q => ({ id: q.id, name: q.name, color: q.color }))
  });

  io.emit('roster', {
    players: [...players.values()].map(q => ({ id: q.id, name: q.name, color: q.color }))
  });

  /* ---- 输入心跳（20Hz，文档建议 20Hz 足够，30Hz 浪费上行带宽） ---- */
  socket.on('input', (d) => {
    if (!d || typeof d !== 'object') return;
    const inp = p.input;
    inp.a = d.a ? 1 : 0;
    inp.d = d.d ? 1 : 0;
    inp.steer = C.clamp(d.steer | 0, -1, 1);
    inp.brake = d.brake ? 1 : 0;
    inp.throttle = d.throttle ? 1 : 0;
    if (d.gearDelta) p.gearDeltaQueue += C.clamp(d.gearDelta | 0, -2, 2);
    p.lastInputAt = Date.now();
  });

  /* ---- 发起比赛（可选模式；自由训练是常态，不进这里） ----
   *   任意车手都可发起；比赛进行中不允许重复发起。 */
  socket.on('startRace', (n) => {
    if (world.phase === 'countdown' || world.phase === 'racing') {
      socket.emit('denied', { action: 'startRace', why: '比赛已在进行中' });
      return;
    }
    const v = parseInt(n, 10);
    if (C.RACE.LAP_OPTIONS.includes(v)) world.laps = v;
    if (players.size < 1) { socket.emit('denied', { action: 'startRace', why: '还没有车手在线' }); return; }
    io.emit('raceInvite', { by: p.name, laps: world.laps });
    startCountdown();
  });

  /* ---- 兼容旧前端：ready 视作发起比赛 ---- */
  socket.on('ready', (v) => {
    if (v === false) { world.readySet.delete(p.id); return; }
    if (world.phase === 'countdown' || world.phase === 'racing') {
      socket.emit('denied', { action: 'ready', why: '比赛进行中' });
      return;
    }
    startCountdown();
  });

  /* ---- 圈数设置（自由训练可改；比赛中记到下一轮） ---- */
  socket.on('setLaps', (n) => {
    const v = parseInt(n, 10);
    if (!C.RACE.LAP_OPTIONS.includes(v)) {
      socket.emit('denied', { action: 'setLaps', why: '圈数只能是 ' + C.RACE.LAP_OPTIONS.join('/') });
      return;
    }
    if (world.phase === 'racing' || world.phase === 'countdown') {
      // 比赛进行中 → 记到下一轮
      world.nextLaps = v;
      io.emit('lapsSet', { laps: v, next: true });
      return;
    }
    world.laps = v;
    io.emit('lapsSet', { laps: v, next: false });
  });

  /* ---- 重开：回到自由训练（若正在比赛则重新发车） ---- */
  socket.on('restart', () => {
    if (world.phase === 'racing' && world.raceStartAt && Date.now() - world.raceStartAt < 8000) {
      socket.emit('denied', { action: 'restart', why: '比赛刚开始，稍候再重开' });
      return;
    }
    resetToFree();
  });

  /* ---- 显式退出比赛，回到自由训练 ---- */
  socket.on('endRace', () => {
    if (world.phase === 'racing' || world.phase === 'countdown') endRace('manual');
    else socket.emit('denied', { action: 'endRace', why: '当前不在比赛中' });
  });

  /* ---- 聊天 / 快捷语（白名单，防注入） ---- */
  const QUICK = ['加油！', '跟上我', '我先走了', '坡顶见', '腿要断了', 'GG'];
  socket.on('emote', (txt) => {
    const t = typeof txt === 'string' ? txt.slice(0, 24) : '';
    const safe = QUICK.includes(t) ? t : (t ? t.replace(/[<>]/g, '') : null);
    if (safe) io.emit('chat', { name: p.name, color: p.color, text: safe });
  });

  /* ---- 延迟采样（测真实 RTT 只能用它，别读前端自算的） ---- */
  socket.on('pingCheck', (t, ack) => {
    if (typeof ack === 'function') ack(t);
    const rtt = Date.now() - (typeof t === 'number' ? t : Date.now());
    p.rtt = rtt;
  });

  socket.on('disconnect', (reason) => {
    players.delete(socket.id);
    world.readySet.delete(socket.id);
    io.emit('playerLeft', { id: socket.id, name: p.name });
    io.emit('roster', {
      players: [...players.values()].map(q => ({ id: q.id, name: q.name, color: q.color }))
    });
    console.log(`[left] ${p.name} (${reason}) · 在线 ${players.size}`);

    // 全员离开 → 回到自由训练
    if (players.size === 0) {
      world.phase = 'free';
      world.round = 1;
      world.results = [];
      world.readySet.clear();
      world.waitSince = 0;
    } else if (world.phase === 'racing') {
      const active = [...players.values()].filter(q => !q.dnf);
      if (active.length > 0 && active.every(q => q.finished)) endRace('all-finished');
    }
  });
});

/* ============================================================================
 * 9. 启动
 * ========================================================================== */
assignGrid();
setInterval(tick, TICK_MS);

function printBanner() {
  console.log('');
  console.log('  ███ Nbike · 山道自行车竞速 ███');
  console.log(`  本地:  http://localhost:${PORT}`);
  console.log(`  赛道:  ${(Track.PERIM / 1000).toFixed(2)} km · ${Track.CLIMBS.length} 个爬坡 · ${Track.CORNERS.length} 个弯`);
  console.log(`  最高点: ${Track.BOUNDS.maxY.toFixed(0)} m · 最大爬坡 ${Track.CLIMBS.map(c => c.category + '级 ' + (c.length / 1000).toFixed(1) + 'km@' + c.avgGrade.toFixed(1) + '%').join(', ')}`);
  console.log(`  物理:  ${TICK_HZ}Hz tick · 固定步长 ${(Physics.FIXED_DT * 1000).toFixed(1)}ms · dt 上限 ${C.NET.MAX_DT}s`);
  console.log('');
  console.log('  操作: A/D 节奏踩踏 · 上箭头 慢骑 · 下箭头 刹车 · ←/→ 拐弯 · Q/E 换挡 · R 重开 · C 视角');
  console.log('');
}

server.on('error', (err) => {
  console.error(`  [listen] 主端口 ${PORT} 启动失败：${err.code || ''} ${err.message}`);
  console.error('  提示：80 端口需要 root 权限，或改用 PORT=3000 并配反代。');
});

server.listen(PORT, '0.0.0.0', printBanner);

/* 追加端口：与主端口共用同一个 Socket.IO 实例，
 * 因此从任意端口连入的玩家都在同一场比赛里，不会分裂成两个房间。 */
for (const p of EXTRA_PORTS) {
  if (p === PORT) continue;
  const extra = http.createServer(app);
  io.attach(extra);
  extra.on('error', (err) => {
    console.error(`  [listen] 追加端口 ${p} 监听失败：${err.code || ''} ${err.message}（不影响主端口 ${PORT}）`);
  });
  extra.listen(p, '0.0.0.0', () => {
    console.log(`  追加:  http://localhost:${p}`);
  });
}
