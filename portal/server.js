/**
 * 5199 游戏厅 —— 单端口统一网关
 * ------------------------------------------------------------------
 * 对外只暴露一个端口：
 *   /                     门户（选游戏）
 *   /play/<slug>/...      该游戏的全部资源与实时连接（内部反向代理到独立端口）
 *   /api/games            大厅状态（运行状态 / 在线人数）
 *
 * 各游戏仍以独立进程运行（互不干扰，崩溃不影响大厅），首次进入时按需启动，
 * 长时间无人访问自动休眠，节省内存。
 */
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const games = require('./games.config.js');

const PORT = Number(process.env.PORT || 5199);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(__dirname, 'games');
const LOG_DIR = path.join(__dirname, 'logs');
const SHIM_PATH = path.join(PUBLIC_DIR, 'shim.js');

/* 空闲休眠：无人连接超过该时长后停掉游戏进程，释放内存。
   保持 25 分钟（之前确认过的值），想改就设 IDLE_MS（毫秒）。 */
const IDLE_STOP_MS = Math.max(10 * 1000, Number(process.env.IDLE_MS || 25 * 60 * 1000));
const BOOT_TIMEOUT = 40000;
/* 全部常驻：启动后预热所有游戏，且永不因空闲休眠（默认关闭；KEEP_ALL=1 可开启） */
const KEEP_ALL = process.env.KEEP_ALL === '1';

/* ------------------------------------------------------------------ */
/*  资源诊断                                                            */
/* ------------------------------------------------------------------ */
function readFileTrim(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; }
}
function bytesFromCgroup(raw) {
  if (!raw || raw === 'max') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1e15 ? n : null;
}
function memInfo() {
  const info = {};
  const raw = readFileTrim('/proc/meminfo');
  if (raw) {
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m) info[m[1]] = Number(m[2]) * 1024;
    }
  }
  return info;
}
function cgroupInfo() {
  /* v2 */
  let limit = bytesFromCgroup(readFileTrim('/sys/fs/cgroup/memory.max'));
  let used = bytesFromCgroup(readFileTrim('/sys/fs/cgroup/memory.current'));
  let path = '/sys/fs/cgroup';
  if (limit == null) {
    /* v1 */
    limit = bytesFromCgroup(readFileTrim('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    used = bytesFromCgroup(readFileTrim('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
    path = '/sys/fs/cgroup/memory';
  }
  return { limitBytes: limit, usedBytes: used, path };
}
function procRssMB(pid) {
  if (!pid) return null;
  const raw = readFileTrim(`/proc/${pid}/status`);
  if (!raw) return null;
  const m = raw.match(/VmRSS:\s+(\d+)\s*kB/);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}
const MB = (b) => (b == null ? null : Math.round(b / 1048576));


try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* 只读环境忽略 */ }
/* ------------------------------------------------------------------ */
/*  注册表                                                             */
/* ------------------------------------------------------------------ */
const registry = new Map();
games.forEach((cfg, i) => {
  registry.set(cfg.slug, {
    cfg,
    port: 4310 + i,
    state: 'stopped', // stopped | starting | running | failed
    reason: '',
    child: null,
    conns: 0,
    lastActive: 0,
    lastTraffic: 0,   // 最近一次收到实时数据的时间（用于识别假连接）
    bootedAt: 0,
    waiters: []
  });
});

function log(slug, line) {
  // 日志只是辅助：任何写盘失败（只读文件系统等）都不能影响大厅与游戏
  try {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(path.join(LOG_DIR, `${slug}.log`), `[${stamp}] ${line}\n`);
  } catch (_) { /* ignore */ }
}

function waitForPort(port, timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.setTimeout(1200);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      const fail = () => {
        sock.destroy();
        if (Date.now() - started > timeout) return reject(new Error('启动超时'));
        setTimeout(attempt, 220);
      };
      sock.once('error', fail);
      sock.once('timeout', fail);
    };
    attempt();
  });
}

function settleWaiters(entry, err) {
  const list = entry.waiters.splice(0);
  for (const w of list) err ? w.reject(err) : w.resolve();
}

/* 健康探测：进程还在不代表能用。
   注意：只探 "/" 不够——某些游戏（如足球）首页走缓存秒回，
   但子路径资源（js/模型）会卡住，表现就是「能打开但一直正在载入」。
   所以探一个真实资源路径，确认进程真的在处理请求。 */
function probeHealth(port, timeout, path) {
  const target = path || '/';
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, path: target, method: 'GET', timeout },
      res => {
        /* 读到第一块数据才算真的活着（只看响应头不够） */
        let got = false;
        res.on('data', () => { if (!got) { got = true; res.destroy(); resolve(res.statusCode > 0 && res.statusCode < 500); } });
        res.on('end', () => { if (!got) resolve(res.statusCode > 0 && res.statusCode < 500); });
        res.on('error', () => resolve(false));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/* 找一个能代表「进程真的在干活」的探测路径。
   要选小文件：探测只关心「进程有没有在处理请求」，不是下载速度。
   注意不能用 "/"——某些游戏首页走缓存秒回，但子路径资源卡死。
   路径按各游戏自己的静态根来写（有的挂 public/，有的直接是 public 内容）。 */
const PROBE_PATH = {
  soccer: '/js/rt-const.js',       // public/js/rt-const.js，约 4KB
  sfh: '/js/net.js',
  'mountain-pass': '/js/main.js',
  nbike: '/index.html',
  'poop-hero': '/index.html',
  'sky-dogfight': '/index.html'
};

function probePathFor(slug) {
  return PROBE_PATH[slug] || '/';
}

/* 强制重启：杀掉卡死的进程再拉起来 */
async function restartGame(slug) {
  const entry = registry.get(slug);
  if (!entry) return null;
  if (entry.child) {
    try { entry.child.kill('SIGKILL'); } catch (_) {}
    entry.child = null;
  }
  entry.state = 'stopped';
  entry.conns = 0;
  log(slug, '健康检查失败，强制重启');
  await new Promise(r => setTimeout(r, 300));
  return ensureGame(slug);
}

function ensureGame(slug) {
  const entry = registry.get(slug);
  if (!entry) return Promise.reject(new Error('未知游戏'));
  if (entry.state === 'running') {
    entry.lastActive = Date.now();
    return Promise.resolve(entry);
  }
  if (entry.state === 'starting') {
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
  }

  /* 记录谁把它拉起来的，方便排查「刚释放就重启」 */
  const why = new Error().stack.split('\n').slice(2, 6).map(s => s.trim().slice(0, 80)).join(' <- ');
  log(slug, '启动原因: ' + why);
  entry.state = 'starting';
  entry.reason = '';
  entry.lastActive = Date.now();
  entry.lastTraffic = Date.now();

  const dir = path.join(GAMES_DIR, slug);
  const isStatic = entry.cfg.run === 'static';
  const script = isStatic ? path.join(__dirname, 'scripts', 'static-server.js') : path.join(dir, 'server.js');
  if (!fs.existsSync(script)) {
    entry.state = 'failed';
    entry.reason = '缺少入口文件';
    return Promise.reject(new Error(entry.reason));
  }

  const args = isStatic ? [dir, String(entry.port)] : [];
  const child = spawn(process.execPath, [script, ...args], {
    cwd: dir,
    env: { ...process.env, PORT: String(entry.port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  entry.child = child;

  child.stdout.on('data', d => log(slug, String(d).trim().slice(0, 2000)));
  child.stderr.on('data', d => log(slug, '[err] ' + String(d).trim().slice(0, 2000)));

  child.on('exit', (code, signal) => {
    log(slug, `进程退出 code=${code} signal=${signal}`);
    if (entry.child === child) {
      entry.child = null;
      entry.state = 'stopped';
      entry.conns = 0;
      if (entry.waiters.length) {
        entry.state = 'failed';
        entry.reason = '进程启动后立即退出，详见日志';
        settleWaiters(entry, new Error(entry.reason));
      }
    }
  });

  return waitForPort(entry.port, BOOT_TIMEOUT).then(() => {
    if (entry.child !== child) throw new Error('进程已退出');
    entry.state = 'running';
    entry.bootedAt = Date.now();
    settleWaiters(entry, null);
    log(slug, `就绪 http://127.0.0.1:${entry.port}`);
    return entry;
  }).catch(err => {
    entry.state = 'failed';
    entry.reason = err.message;
    if (entry.child) { try { entry.child.kill(); } catch (_) {} }
    settleWaiters(entry, err);
    throw err;
  });
}

function stopGame(slug) {
  const entry = registry.get(slug);
  if (!entry || !entry.child) return;
  const pid = entry.child.pid;
  try { entry.child.kill(); } catch (_) {}
  /* Windows 上 kill() 只杀父进程，子进程（如足球的 HTTPS 代理）会残留占端口，
     导致「释放」后端口仍被占、下次启动失败。用 taskkill 杀整棵树。 */
  if (process.platform === 'win32' && pid) {
    try {
      require('child_process').execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true }, () => {});
    } catch (_) {}
  }
  entry.child = null;
  entry.state = 'stopped';
  entry.conns = 0;
  entry.checkedAt = 0;
  entry.lastTraffic = 0;
  entry.lastActive = 0;
  /* 冷却期：刚释放的进程不让立刻重启，否则释放后马上又被拉起 */
  entry.releasedAt = Date.now();
  log(slug, '空闲休眠');
}

setInterval(() => {
  if (KEEP_ALL) return;   // 常驻模式不休眠
  const now = Date.now();
  for (const [slug, entry] of registry) {
    if (entry.state !== 'running') continue;
    const idleFor = now - entry.lastActive;
    const silentFor = now - entry.lastTraffic;
    // 没人连接且长时间无请求 → 休眠
    if (entry.conns <= 0 && idleFor > IDLE_STOP_MS) { stopGame(slug); continue; }
    // 连接还在但长期收不到任何实时数据 → 多半是断线残留的假连接，放宽 3 倍阈值再收
    if (entry.conns > 0 && silentFor > IDLE_STOP_MS * 3) stopGame(slug);
  }
}, 60 * 1000).unref();

/* 健康巡检：只在长时间彻底无响应时才回收。
   实测发现频繁探测会误伤（大文件加载期间判死 → 重启 → 全站 502），
   所以门槛放高：连续 6 分钟完全无响应才回收。 */
setInterval(async () => {
  if (KEEP_ALL) return;
  const now = Date.now();
  for (const [slug, entry] of registry) {
    if (entry.state !== 'running') continue;
    /* 只要 6 分钟内有过任何流量，就不算卡死 */
    if (now - (entry.lastTraffic || 0) < 6 * 60 * 1000) continue;
    if (entry.conns > 0) continue;
    const ok = await probeHealth(entry.port, 8000, probePathFor(slug));
    if (!ok) {
      console.log(`[巡检] ${slug} 长时间无响应，回收进程`);
      log(slug, '健康巡检无响应，回收');
      stopGame(slug);
    }
  }
}, 5 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/*  路径 / 内容改写                                                     */
/* ------------------------------------------------------------------ */
function withPrefix(prefix, url) {
  if (typeof url !== 'string' || !url) return url;
  if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(url)) return url;
  if (url.startsWith(prefix + '/') || url === prefix) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return prefix + url;
  return url;
}

function rewriteHtml(html, prefix) {
  let out = html;

  // 先把页面里原有的根路径改写掉，最后再注入 <base> 与补丁，
  // 否则注入内容会被自己的规则二次加前缀。
  out = out.replace(/\b(src|href|action|poster|data-src)=("|')([^"']*)\2/gi,
    (m, key, q, val) => {
      if (!val.startsWith('/') || val.startsWith('//')) return m;
      return `${key}=${q}${withPrefix(prefix, val)}${q}`;
    });
  // srcset
  out = out.replace(/\bsrcset=("|')([^"']*)\1/gi, (m, q, val) => {
    const fixed = val.replace(/(^|,\s*)\/(?!\/)/g, (mm, lead) => `${lead}${prefix}/`);
    return `srcset=${q}${fixed}${q}`;
  });
  // 内联样式里的 url(/...)
  out = out.replace(/url\(\s*(['"]?)\/(?!\/)/g, (m, q) => `url(${q}${prefix}/`);
  // importmap / 内联 JSON 里的值："three": "/vendor/three.module.js"
  // 只匹配「冒号 + 引号 + 根路径」，避免把已经写好的 href="..." 二次加前缀
  out = out.replace(/(:\s*)"\/(?!\/)([^"\\]*)"/g, (m, sep, rest) => {
    return `${sep}"${withPrefix(prefix, '/' + rest)}"`;
  });

  const inject =
    `<base href="${prefix}/">` +
    `<script>window.__PORTAL_BASE__=${JSON.stringify(prefix)};</script>` +
    `<script src="${prefix}/__portal-shim.js"></script>`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${inject}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (m, attrs) => `<html${attrs}><head>${inject}</head>`);
  } else {
    out = inject + out;
  }
  return out;
}

function rewriteCss(css, prefix) {
  return css
    .replace(/url\(\s*(['"]?)\/(?!\/)/g, (m, q) => `url(${q}${prefix}/`)
    .replace(/@import\s+(['"])\/(?!\/)/g, (m, q) => `@import ${q}${prefix}/`);
}

function rewriteJs(js, prefix) {
  return js
    .replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimportScripts\s*\(\s*)(["'])(\/[^"'\\]*)\2/g,
      (m, head, q, url) => `${head}${q}${withPrefix(prefix, url)}${q}`)
    .replace(/(\bnew\s+URL\s*\(\s*)(["'])(\/[^"'\\]*)\2/g,
      (m, head, q, url) => `${head}${q}${withPrefix(prefix, url)}${q}`);
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-security-policy',
  'content-security-policy-report-only'
]);

function cleanHeaders(headers, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function isTextual(ctype) {
  return /text\/html|text\/css|javascript|application\/json|text\/plain/i.test(ctype || '');
}

/* 大文件不走文本改写：把 600KB+ 的 three.module.js 全读进内存再做正则替换，
   既慢又占 CPU，浏览器往往等不及直接 ERR_ABORTED。
   这类第三方库本来也不需要改写（里面是相对路径）。 */
const REWRITE_MAX_BYTES = 300 * 1024;

/* ------------------------------------------------------------------ */
/*  静态资源缓存：游戏加载几十个模块，云端转发一次要 10s+               */
/*  网关自己缓存起来，第二次进入直接命中，不再走转发。                    */
/* ------------------------------------------------------------------ */
const assetCache = new Map();       // `${slug}|${path}` -> { body, ctype, at }
const ASSET_CACHE_MAX = 260;        // 最多缓存多少个文件
const ASSET_CACHE_TTL = 30 * 60 * 1000;

function cacheGet(slug, path) {
  const k = slug + '|' + path;
  const e = assetCache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > ASSET_CACHE_TTL) { assetCache.delete(k); return null; }
  return e;
}

function cachePut(slug, path, body, ctype) {
  if (assetCache.size >= ASSET_CACHE_MAX) {
    /* 简单 FIFO：删最早的几个 */
    let i = 0;
    for (const k of assetCache.keys()) {
      assetCache.delete(k);
      if (++i >= 20) break;
    }
  }
  assetCache.set(slug + '|' + path, { body, ctype, at: Date.now() });
}

/* 游戏静态资源直供：某些游戏（足球）模块多、模型大，
   全部经转发会慢到超时。这类资源直接从磁盘读，零转发开销。 */
const DIRECT_ASSET = {
  soccer: {
    root: path.join(GAMES_DIR, 'soccer', 'public'),
    prefixes: ['/js/', '/css/', '/char/', '/audio/', '/models/'],
    /* /lib/ 走 node_modules 映射（库里没有 public/lib 目录） */
    libRoot: (function () {
      /* 依赖在门户根目录的 node_modules（soccer 自己没装） */
      let dir = __dirname;
      for (;;) {
        const cand = path.join(dir, 'node_modules', 'three');
        if (fs.existsSync(cand)) return path.join(dir, 'node_modules');
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      return path.join(__dirname, 'node_modules');
    })(),
    libMap: {
      '/lib/three.module.js': 'three/build/three.module.js',
      '/lib/three.core.js': 'three/build/three.core.js',
      '/lib/socket.io.js': 'socket.io/client-dist/socket.io.min.js',
      '/lib/fflate/esm/browser.js': 'fflate/esm/browser.js'
    },
    /* three 内部的 jsm 模块：/lib/jsm/... -> three/examples/jsm/... */
    jsmPrefix: '/lib/jsm/',
    jsmTarget: 'three/examples/jsm/',
    /* /models/ 指向游戏目录下的 glb/ 与 救护车包/（不在 public 里） */
    modelRoots: [
      path.join(GAMES_DIR, 'soccer', 'glb'),
      path.join(GAMES_DIR, 'soccer', '救护车包')
    ]
  }
};

const DIRECT_MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};

/* 从磁盘直接吐文件，带内存缓存 + gzip */
function serveDirect(req, res, slug, cfg, restPath) {
  /* 先把 /lib/ 映射到 node_modules */
  let full = null;
  if (restPath.startsWith('/lib/')) {
    if (!cfg.libRoot) return proxyToGame(req, res, slug, registry.get(slug));
    const mapped = cfg.libMap && cfg.libMap[restPath];
    if (mapped) {
      full = path.join(cfg.libRoot, path.normalize(mapped));
    } else if (cfg.jsmPrefix && restPath.startsWith(cfg.jsmPrefix)) {
      const rel = restPath.slice(cfg.jsmPrefix.length);
      full = path.join(cfg.libRoot, path.normalize(cfg.jsmTarget + rel));
    }
    if (!full || !fs.existsSync(full)) {
      return proxyToGame(req, res, slug, registry.get(slug));
    }
  } else if (restPath.startsWith('/models/')) {
    /* 模型散在 glb/ 与 救护车包/ 两个目录，挨个找 */
    const name = path.basename(restPath);
    const roots = cfg.modelRoots || [];
    for (const r of roots) {
      const cand = path.join(r, name);
      if (fs.existsSync(cand)) { full = cand; break; }
    }
    if (!full) return proxyToGame(req, res, slug, registry.get(slug));
  } else {
    const rel = restPath.replace(/^\/+/, '');
    full = path.join(cfg.root, path.normalize(rel));
    if (!full.startsWith(cfg.root)) { res.writeHead(403); return res.end('403'); }
  }

  const hit = cacheGet(slug, '/direct' + restPath);
  if (hit) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': hit.ctype,
        'content-length': hit.body.length,
        'cache-control': 'public, max-age=300'
      });
    }
    return res.end(hit.body);
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      /* 文件不在 → 交回转发（可能是动态路由） */
      return proxyToGame(req, res, slug, registry.get(slug));
    }
    const ext = path.extname(full).toLowerCase();
    const ctype = DIRECT_MIME[ext] || 'application/octet-stream';

    /* 只压文本类，二进制直接发 */
    const compressible = /javascript|css|json|svg|text\/html/.test(ctype);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size < 2 * 1024 * 1024) {
      fs.readFile(full, (e2, raw) => {
        if (e2) { res.writeHead(500); return res.end('500'); }
        zlib.gzip(raw, { level: 6 }, (e3, gz) => {
          if (e3) { res.writeHead(500); return res.end('500'); }
          cachePut(slug, '/direct' + restPath, gz, ctype);
          if (!res.headersSent) {
            res.writeHead(200, {
              'content-type': ctype,
              'content-encoding': 'gzip',
              'content-length': gz.length,
              'cache-control': 'public, max-age=300',
              'vary': 'Accept-Encoding'
            });
          }
          res.end(gz);
        });
      });
      return;
    }

    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': ctype, 'content-length': st.size, 'cache-control': 'public, max-age=300' });
    }
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/*  转发限流：游戏进程同时处理太多请求会卡死（尤其首次加载几十个模块）     */
/*  这里按游戏排队，最多 N 个并发，其余稍等再转发。                       */
/* ------------------------------------------------------------------ */
const MAX_CONCURRENT = 8;
const lanes = new Map();   // slug -> { running, queue: [] }

function acquireSlot(slug) {
  let s = lanes.get(slug);
  if (!s) { s = { running: 0, queue: [] }; lanes.set(slug, s); }
  if (s.running < MAX_CONCURRENT) { s.running++; return Promise.resolve(); }
  return new Promise(resolve => s.queue.push(resolve));
}

function releaseSlot(slug) {
  const s = lanes.get(slug);
  if (!s) return;
  const next = s.queue.shift();
  if (next) next();                       // 名额直接交给排队者
  else s.running = Math.max(0, s.running - 1);
}

/* ------------------------------------------------------------------ */
/*  反向代理                                                           */
/* ------------------------------------------------------------------ */
function proxyToGame(req, res, slug, entry, prefixOverride) {
  entry.lastActive = Date.now();
  const prefix = prefixOverride || `/play/${slug}`;
  const rest = req.url && req.url !== '/' ? req.url : '/';
  const targetPath = rest.startsWith('/') ? rest : '/' + rest;

  /* 排队拿转发名额：直接转发会让进程并发过载，全站一起 502 */
  acquireSlot(slug).then(() => {
    let freed = false;
    const free = () => { if (!freed) { freed = true; releaseSlot(slug); } };
    res.on('finish', free);
    res.on('close', free);
    doProxy(req, res, slug, entry, prefix, targetPath, free);
  });
}

function doProxy(req, res, slug, entry, prefix, targetPath, free) {
  /* 任何转发都算「有流量」，健康巡检据此判断进程是否真的卡死 */
  entry.lastTraffic = Date.now();

  /* 命中本地缓存直接返回：游戏首次加载完，后续进房间不再受云端转发拖累 */
  if (req.method === 'GET') {
    const hit = cacheGet(slug, targetPath);
    if (hit) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': hit.ctype || 'application/octet-stream',
          'content-length': hit.body.length,
          'cache-control': 'no-cache'
        });
      }
      res.end(hit.body);
      return;
    }
  }

  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${entry.port}`;
  /* 保留客户端支持的压缩协商：某些游戏（如足球）只有在能压缩时
     才走内存缓存分支，否则会用 sendFile 逐个读 5MB+ 模型，慢到 16 秒。
     二进制响应不经过文本改写，压缩流直接透传即可。 */
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
  delete headers['if-none-match'];
  delete headers['if-modified-since'];

  const upstream = http.request(
    { host: '127.0.0.1', port: entry.port, path: targetPath, method: req.method, headers },
    upRes => {
      const ctype = upRes.headers['content-type'] || '';
      const clen = Number(upRes.headers['content-length'] || 0);
      const tooBig = clen > REWRITE_MAX_BYTES;
      if (!isTextual(ctype) || req.method === 'HEAD' || tooBig) {
        /* 二进制/大文件也缓存起来，下次直接命中 */
        if (req.method === 'GET' && !tooBig) {
          const buf = [];
          upRes.on('data', c => buf.push(c));
          upRes.on('end', () => {
            const body = Buffer.concat(buf);
            if (upRes.statusCode === 200 && body.length < 8 * 1024 * 1024) {
              cachePut(slug, targetPath, body, ctype);
            }
            if (!res.headersSent) {
              const h = cleanHeaders(upRes.headers, prefix);
              res.writeHead(upRes.statusCode || 200, h);
            }
            res.end(body);
          });
          upRes.on('error', () => {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('资源读取失败');
          });
          return;
        }
        res.writeHead(upRes.statusCode || 200, cleanHeaders(upRes.headers, prefix));
        upRes.pipe(res);
        return;
      }
      const enc = String(upRes.headers['content-encoding'] || '').toLowerCase();
      let stream = upRes;
      if (enc === 'gzip') stream = upRes.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = upRes.pipe(zlib.createInflate());
      else if (enc === 'br') stream = upRes.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('资源解析失败');
      });
      stream.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        try {
          if (/text\/html/i.test(ctype)) body = rewriteHtml(body, prefix);
          else if (/text\/css/i.test(ctype)) body = rewriteCss(body, prefix);
          else if (/javascript/i.test(ctype)) {
            /* 只有真的引用了根路径才改写；纯库（three.module.js 等）直接透传，
               省掉一次全文件正则扫描，避免大文件卡住 */
            if (/['"]\/(?!\/)/.test(body)) body = rewriteJs(body, prefix);
          }
          else if (/json/i.test(ctype)) body = rewriteJs(body, prefix);
        } catch (e) {
          log(slug, '改写失败: ' + e.message);
        }
        const buf = Buffer.from(body, 'utf8');
        const h = cleanHeaders(upRes.headers, prefix);
        delete h['content-encoding'];
        h['content-length'] = buf.length;
        if (/html|css|javascript/i.test(ctype)) h['cache-control'] = 'no-store';
        /* 文本资源也缓存（存的是改写后的最终内容，直接可发） */
        if (req.method === 'GET' && upRes.statusCode === 200 && buf.length < 8 * 1024 * 1024) {
          cachePut(slug, targetPath, buf, h['content-type'] || ctype);
        }
        res.writeHead(upRes.statusCode || 200, h);
        res.end(buf);
      });
    }
  );

  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`游戏服务未就绪：${err.message}\n请返回大厅后重试。`);
  });

  /* 转发超时：游戏进程卡住时不能无限等，及时返回让浏览器重试 */
  upstream.setTimeout(25000, () => {
    upstream.destroy(new Error('转发超时'));
  });

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

/* ------------------------------------------------------------------ */
/*  HTTP 服务                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ */
/*  访客记录与封禁                                                      */
/*  目的：查清「谁在反复拉起游戏」，确认后能一键封掉。                     */
/* ------------------------------------------------------------------ */
const VISIT_MAX = 400;                 // 最多记 400 条访问样本
const visits = [];                     // 最近的访问记录（内存，重启清空）
const banList = new Set();             // 已封禁的 IP 或网段（支持 1.2.3.4 / 1.2.3.0/24 / 1.2.3.*）
const BAN_FILE = path.join(__dirname, 'logs', 'bans.json');

/* 只允许浏览器进游戏：脚本的 UA 是 node/python/curl，全部挡掉。
   自己测试脚本要放行时，设环境变量 ALLOW_SCRIPTS=1，或用 ?_dev=你的口令。 */
const BLOCK_SCRIPTS = process.env.ALLOW_SCRIPTS !== '1';
const DEV_KEY = process.env.DEV_KEY || '';

function isBrowserUA(ua) {
  return /Mozilla|Chrome|Safari|Firefox|Edg|Opera|MicroMessenger/i.test(ua || '');
}

/* 封禁列表落盘：发布重启后依然有效 */
function loadBans() {
  try {
    const arr = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    if (Array.isArray(arr)) arr.forEach(x => { if (typeof x === 'string' && x) banList.add(x); });
  } catch (_) {}
}
function saveBans() {
  try {
    fs.mkdirSync(path.dirname(BAN_FILE), { recursive: true });
    fs.writeFileSync(BAN_FILE, JSON.stringify([...banList], null, 2));
  } catch (_) {}
}

/* 封禁匹配：支持精确 IP、CIDR 网段、以及 1.2.3.* 通配 */
function ipBanned(ip) {
  if (!ip) return false;
  if (banList.has(ip)) return true;
  for (const rule of banList) {
    if (rule.endsWith('*')) {                       // 1.2.3.* → 前缀匹配
      if (ip.startsWith(rule.slice(0, -1))) return true;
      continue;
    }
    if (rule.includes('/')) {                       // 1.2.3.0/24 → 网段匹配
      const [base, bitsRaw] = rule.split('/');
      const bits = Number(bitsRaw);
      if (!Number.isFinite(bits) || bits < 0 || bits > 32) continue;
      const toInt = s => s.split('.').reduce((n, x) => (n * 256) + (Number(x) || 0), 0);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if (((toInt(base) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0)) return true;
    }
  }
  return false;
}

/* 从请求里取真实来源 IP：云端在前面有代理，必须看 x-forwarded-for */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}

/* ------------------------------------------------------------------ */
/*  管理后台登录                                                        */
/*  监控台能看到所有访客 IP，还能封人 —— 必须只有管理员能进。            */
/* ------------------------------------------------------------------ */
const crypto = require('crypto');

/* 管理员密码：优先环境变量 ADMIN_PASSWORD，其次 portal/admin.json，最后内置默认值 */
function loadAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return { pwd: String(process.env.ADMIN_PASSWORD), from: 'env' };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'admin.json'), 'utf8'));
    if (cfg && typeof cfg.password === 'string' && cfg.password.length >= 6) {
      return { pwd: cfg.password, from: 'file' };
    }
  } catch (_) {}
  /* 未配置时不使用固定默认密码：每次启动随机生成一个，打印到控制台。
     这样即使忘记设置 ADMIN_PASSWORD，后台也不会被公开的默认口令登入。 */
  const generated = crypto.randomBytes(9).toString('base64url');
  console.log('[安全] 未检测到 ADMIN_PASSWORD / admin.json，已生成临时管理员密码：' + generated);
  console.log('[安全] 该密码仅在本次进程有效，正式部署请设置 ADMIN_PASSWORD 环境变量。');
  return { pwd: generated, from: 'generated' };
}

const ADMIN_CFG = loadAdminPassword();
const ADMIN_PASSWORD = ADMIN_CFG.pwd;
const PASSWORD_IS_DEFAULT = ADMIN_CFG.from === 'default';

/* token 签名密钥：每次启动随机生成，重启后旧 token 自动失效（更安全） */
const TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = 8 * 60 * 60 * 1000;         // 登录有效期 8 小时

/* 登录失败限流：同一 IP 连续失败 5 次，锁 15 分钟 */
const LOGIN_FAIL = new Map();                  // ip -> { count, until }
const LOGIN_MAX_FAIL = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  /* 恒定时间比较，避免时序侧信道 */
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}

/* 从 cookie 或 Authorization 头取 token */
function reqToken(req) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;)\s*pz_admin=([^;]+)/.exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  const auth = String(req.headers.authorization || '');
  const am = /^Bearer\s+(.+)$/i.exec(auth);
  return am ? am[1] : null;
}

/* 是否已登录管理员 */
function isAdmin(req) {
  const p = verifyToken(reqToken(req));
  return !!(p && p.role === 'admin');
}

/* 登录态中间件：未登录一律 401 */
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.set('cache-control', 'no-store');
  return res.status(401).json({ ok: false, error: '未登录', needLogin: true });
}

/* 登录：校验密码 → 发签名 token（写 httpOnly cookie） */
app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();

  /* 限流检查 */
  const f = LOGIN_FAIL.get(ip);
  if (f && f.until && now < f.until) {
    const wait = Math.ceil((f.until - now) / 1000);
    return res.status(429).json({ ok: false, error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`, waitSec: wait });
  }

  const pwd = String((req.body && req.body.password) || '');
  /* 恒定时间比较密码 */
  const ok = (() => {
    const a = Buffer.from(pwd);
    const b = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  })();

  if (!ok) {
    const cur = LOGIN_FAIL.get(ip) || { count: 0, until: 0 };
    cur.count++;
    if (cur.count >= LOGIN_MAX_FAIL) {
      cur.until = now + LOGIN_LOCK_MS;
      cur.count = 0;
      LOGIN_FAIL.set(ip, cur);
      console.log(`[登录] ${ip} 连续失败，锁定 ${LOGIN_LOCK_MS / 60000} 分钟`);
      return res.status(429).json({
        ok: false,
        error: `尝试次数过多，已锁定 ${LOGIN_LOCK_MS / 60000} 分钟`,
        waitSec: LOGIN_LOCK_MS / 1000
      });
    }
    LOGIN_FAIL.set(ip, cur);
    return res.status(401).json({
      ok: false,
      error: '密码错误',
      left: LOGIN_MAX_FAIL - cur.count
    });
  }

  LOGIN_FAIL.delete(ip);
  const token = signToken({ role: 'admin', exp: now + TOKEN_TTL, ip });
  res.cookie('pz_admin', token, {
    maxAge: TOKEN_TTL,
    httpOnly: true,       // JS 读不到，防 XSS 窃取
    sameSite: 'lax',
    path: '/'
  });
  console.log(`[登录] ${ip} 登录成功`);
  res.set('cache-control', 'no-store');
  res.json({ ok: true, expiresIn: TOKEN_TTL / 1000, passwordIsDefault: PASSWORD_IS_DEFAULT });
});

/* 登出 */
app.post('/api/logout', (req, res) => {
  res.clearCookie('pz_admin', { path: '/' });
  res.set('cache-control', 'no-store');
  res.json({ ok: true });
});

/* 当前登录状态 */
app.get('/api/auth', (req, res) => {
  res.set('cache-control', 'no-store');
  const p = verifyToken(reqToken(req));
  res.json({
    ok: true,
    loggedIn: !!(p && p.role === 'admin'),
    expiresIn: p ? Math.max(0, Math.round((p.exp - Date.now()) / 1000)) : 0,
    passwordIsDefault: PASSWORD_IS_DEFAULT
  });
});

/* 诊断用：把请求里所有可能标识来源的头部打出来 */
function debugHeaders(req) {
  return {
    xff: String(req.headers['x-forwarded-for'] || ''),
    xri: String(req.headers['x-real-ip'] || ''),
    cf: String(req.headers['cf-connecting-ip'] || ''),
    fwd: String(req.headers['forwarded'] || ''),
    sock: (req.socket && req.socket.remoteAddress) || '',
    ua: String(req.headers['user-agent'] || '').slice(0, 40)
  };
}

/* 记录一条访问样本：谁、什么 UA、连了哪个游戏、是不是脚本 */
function recordVisit(req, slug, pathname) {
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '');
  /* node / python / curl 这类不是浏览器 → 判为脚本 */
  const isScript = !/Mozilla|Chrome|Safari|Firefox|Edg/i.test(ua);
  const rec = {
    t: Date.now(),
    ip,
    slug,
    path: pathname,
    /* 完整 query：用来看清 socket.io 连接带了什么参数（EIO/sid/name/spectate…） */
    query: String(req.url.split('?')[1] || '').slice(0, 160),
    ua: ua.slice(0, 90),
    ref: String(req.headers['referer'] || '').slice(0, 80),
    script: isScript,
    banned: ipBanned(ip)
  };
  visits.push(rec);
  if (visits.length > VISIT_MAX) visits.splice(0, visits.length - VISIT_MAX);
  return rec;
}

/* 聚合视图：按 IP 汇总，方便一眼看出「是谁在刷」 */
function visitSummary() {
  const map = new Map();
  for (const v of visits) {
    let e = map.get(v.ip);
    if (!e) {
      e = { ip: v.ip, count: 0, slugs: new Set(), scripts: 0, browsers: 0, lastAt: 0, lastPath: '', ua: '', banned: false };
      map.set(v.ip, e);
    }
    e.count++;
    e.slugs.add(v.slug);
    v.script ? e.scripts++ : e.browsers++;
    if (v.t > e.lastAt) { e.lastAt = v.t; e.lastPath = v.path; e.ua = v.ua; }
    e.banned = ipBanned(v.ip);
  }
  return [...map.values()]
    .map(e => ({ ...e, slugs: [...e.slugs] }))
    .sort((a, b) => b.count - a.count);
}

/* 诊断用：看某个游戏的最近日志（含「启动原因」） */
app.get('/api/log', requireAdmin, (req, res) => {
  const slug = String(req.query.slug || '');
  if (!/^[a-z0-9-]+$/i.test(slug)) return res.status(400).json({ error: 'bad slug' });
  const file = path.join(LOG_DIR, `${slug}.log`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = '(无日志)'; }
  res.set('cache-control', 'no-store').type('text/plain').send(text.slice(-6000));
});

/* 诊断：看看云端到底传了什么头部，用来确认 clientIp 取得对不对 */
app.get('/api/whoami', (req, res) => {
  res.set('cache-control', 'no-store').json({
    ok: true,
    ip: clientIp(req),
    banned: ipBanned(clientIp(req)),
    browser: isBrowserUA(req.headers['user-agent']),
    banRules: [...banList],
    headers: debugHeaders(req)
  });
});

/* ------------------------------------------------------------------ */
/*  实时会话追踪：谁在大厅、谁在玩游戏、待了多久                          */
/*  每个浏览器分配一个 sid（cookie），心跳上报「现在在哪」。               */
/* ------------------------------------------------------------------ */
const SESSIONS = new Map();            // sid -> 会话对象
const SESSION_TTL = 45 * 1000;         // 超过 45 秒没心跳 → 视为离线

/* 取或建会话 ID。
   关键：云端转发会换掉出口 IP，同一浏览器的请求 IP 一直在变，
   所以绝不能用 IP 派生会话 —— 必须由前端自己生成一个稳定 ID 上报。 */
function sessionId(req, body) {
  /* 1. 前端上报的 sid 最可靠 */
  const fromBody = body && String(body.sid || '').trim();
  if (fromBody && /^[a-z0-9_-]{8,40}$/i.test(fromBody)) return fromBody;
  /* 2. 其次是 cookie */
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;)\s*pz_sid=([a-z0-9_-]{8,40})/i.exec(cookie);
  if (m) return m[1];
  /* 3. 兜底：请求头里带（部分游戏客户端会带） */
  const hdr = String(req.headers['x-session-id'] || '').trim();
  if (hdr && /^[a-z0-9_-]{8,40}$/i.test(hdr)) return hdr;
  return null;                                   // 没有稳定 ID → 不建会话
}

/* 更新会话状态：where 是 'lobby' 或游戏 slug */
function touchSession(req, where, extra) {
  const sid = sessionId(req, extra && extra.body);
  if (!sid) return null;                          // 无稳定 ID 的请求不计入在线
  const now = Date.now();
  let s = SESSIONS.get(sid);
  if (!s) {
    s = {
      sid,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 90),
      browser: isBrowserUA(req.headers['user-agent']),
      firstAt: now,
      where: 'lobby',
      slug: null,
      pageCount: 0,
      reqCount: 0,
      ips: new Set()                              // 这个会话出现过的所有 IP
    };
    SESSIONS.set(sid, s);
  }
  const ip = clientIp(req);
  s.ip = ip;                                      // 以最新为准
  s.ips.add(ip);
  s.lastAt = now;
  s.reqCount++;
  if (where) {
    if (where !== s.where || (extra && extra.slug && extra.slug !== s.slug)) s.pageCount++;
    s.where = where;
    s.slug = (extra && extra.slug) || (where === 'lobby' ? null : where);
  }
  return s;
}

/* 清理超时会话，返回在线列表 */
function liveSessions() {
  const now = Date.now();
  const out = [];
  for (const [sid, s] of SESSIONS) {
    if (now - (s.lastAt || 0) > SESSION_TTL) { SESSIONS.delete(sid); continue; }
    out.push({
      sid,
      ip: s.ip,
      ips: [...(s.ips || new Set())],           // 这个会话出现过的所有 IP
      ipCount: (s.ips || new Set()).size,
      ua: s.ua,
      browser: s.browser,
      where: s.where,
      slug: s.slug,
      onlineSec: Math.round((now - s.firstAt) / 1000),
      idleSec: Math.round((now - s.lastAt) / 1000),
      pageCount: s.pageCount,
      reqCount: s.reqCount,
      banned: ipBanned(s.ip)
    });
  }
  return out.sort((a, b) => b.onlineSec - a.onlineSec);
}

/* 心跳接口：页面每隔几秒报一次「我在哪」+ 自己的稳定 sid */
app.post('/api/heartbeat', (req, res) => {
  const body = req.body || {};
  const where = String(body.where || 'lobby');
  const s = touchSession(req, where === 'lobby' ? 'lobby' : 'game', { slug: where, body });
  res.set('cache-control', 'no-store');
  if (!s) return res.json({ ok: false, reason: 'no-sid' });
  res.json({ ok: true, sid: s.sid, banned: ipBanned(s.ip) });
});

/* 监控数据：当前所有在线会话 + 封禁名单 */
app.get('/api/monitor', requireAdmin, (req, res) => {
  const list = liveSessions();
  const byIp = new Map();
  for (const s of list) {
    let e = byIp.get(s.ip);
    if (!e) { e = { ip: s.ip, count: 0, lobby: 0, playing: 0, slugs: new Set(), browsers: 0, scripts: 0, banned: ipBanned(s.ip) }; byIp.set(s.ip, e); }
    e.count++;
    s.where === 'lobby' ? e.lobby++ : e.playing++;
    if (s.slug) e.slugs.add(s.slug);
    s.browser ? e.browsers++ : e.scripts++;
  }
  res.set('cache-control', 'no-store');
  res.json({
    ok: true,
    now: Date.now(),
    ttlSec: SESSION_TTL / 1000,
    total: list.length,
    lobby: list.filter(s => s.where === 'lobby').length,
    playing: list.filter(s => s.where !== 'lobby').length,
    sessions: list,
    ips: [...byIp.values()].map(e => ({ ...e, slugs: [...e.slugs] })).sort((a, b) => b.count - a.count),
    bans: [...banList],
    visits: visits.slice(-30).reverse()
  });
});

/* 查看访问来源：谁在连、连的哪个游戏、是不是脚本 */
app.get('/api/visits', requireAdmin, (req, res) => {
  res.set('cache-control', 'no-store');
  res.json({
    ok: true,
    total: visits.length,
    ips: visitSummary(),
    recent: visits.slice(-40).reverse()
  });
});

/* 封禁 / 解封 IP
   POST /api/ban   { ip } 或 ?ip=x.x.x.x
   POST /api/unban { ip } 或 ?ip=x.x.x.x */
app.post('/api/ban', requireAdmin, (req, res) => {
  const ip = String((req.body && req.body.ip) || req.query.ip || '').trim();
  if (!ip) return res.status(400).json({ ok: false, error: '缺少 ip' });
  banList.add(ip);
  saveBans();
  console.log(`[封禁] ${ip}`);
  res.set('cache-control', 'no-store');
  res.json({ ok: true, banned: [...banList] });
});

app.post('/api/unban', requireAdmin, (req, res) => {
  const ip = String((req.body && req.body.ip) || req.query.ip || '').trim();
  banList.delete(ip);
  saveBans();
  res.set('cache-control', 'no-store');
  res.json({ ok: true, banned: [...banList] });
});

app.get('/api/bans', requireAdmin, (req, res) => {
  res.set('cache-control', 'no-store').json({ ok: true, banned: [...banList] });
});

/* 手动释放：停掉当前没人玩的游戏进程，只留大厅。
   ?all=1 连有人的也停（会打断正在玩的玩家）。
   ?idle=秒  自定义「多久算空闲」，默认 60 秒。
   ?pause=秒 释放后暂停多久（默认 600 秒），期间拒绝自动拉起，
              用于挡住外部脚本反复重连。 */
app.post('/api/release', requireAdmin, (req, res) => {
  const forceAll = req.query.all === '1';
  const idleSec = Number(req.query.idle);
  const idleLimit = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 60) * 1000;
  const pauseSec = Number(req.query.pause);
  const pauseMs = (Number.isFinite(pauseSec) && pauseSec >= 0 ? pauseSec : 600) * 1000;
  const now = Date.now();
  const stopped = [], busy = [];
  for (const [slug, entry] of registry) {
    if (entry.state !== 'running') continue;
    const active = entry.conns > 0 && (now - (entry.lastTraffic || 0)) < idleLimit;
    if (active && !forceAll) { busy.push(slug); continue; }
    stopGame(slug);
    entry.pausedUntil = now + pauseMs;
    stopped.push(slug);
  }
  console.log(`[释放] 停 ${stopped.length} 个：${stopped.join(', ') || '无'}；保留 ${busy.join(', ') || '无'}`);
  res.set('cache-control', 'no-store');
  res.json({
    ok: true, stopped, busy, pausedSec: pauseMs / 1000,
    running: Array.from(registry.values()).filter(e => e.state === 'running').map(e => e.cfg.slug)
  });
});

app.get('/api/games', (req, res) => {
  const now = Date.now();
  const list = games.map(g => {
    const e = registry.get(g.slug);
    /* 只有「进程在跑 + 连接还在 + 最近真的有过数据」才算有人，
       避免进程卡死留下假连接，大厅却一直显示有人在线 */
    const alive = e.state === 'running'
      && e.conns > 0
      && (now - e.lastTraffic) < 3 * 60 * 1000;
    return {
      slug: g.slug, name: g.name, en: g.en, tag: g.tag, desc: g.desc,
      players: g.players, keys: g.keys, color: g.color, color2: g.color2, icon: g.icon,
      cover: `/covers/${g.slug}.jpg`,
      online: alive ? e.conns : 0,
      state: e.state,
      onlineCapable: g.players !== '单机'
    };
  });
  res.set('cache-control', 'no-store');
  res.json({ games: list, total: list.reduce((n, g) => n + g.online, 0) });
});

/* 主机资源诊断：容器内存上限、已用、各游戏进程占用 */
app.get('/api/sys', requireAdmin, (req, res) => {
  const cg = cgroupInfo();
  const mi = memInfo();
  const gamesInfo = games.map(g => {
    const e = registry.get(g.slug);
    return {
      slug: g.slug,
      state: e.state,
      online: e.conns,
      pid: e.child ? e.child.pid : null,
      rssMB: procRssMB(e.child ? e.child.pid : null),
      pausedSec: e.pausedUntil && e.pausedUntil > Date.now()
        ? Math.round((e.pausedUntil - Date.now()) / 1000) : 0
    };
  });
  const perGame = gamesInfo.reduce((n, g) => n + (g.rssMB || 0), 0);
  res.set('cache-control', 'no-store');
  res.json({
    keepAll: KEEP_ALL,
    host: {
      cpus: (require('os').cpus() || []).length,
      load1: Number((require('os').loadavg()[0] || 0).toFixed(2)),
      uptimeMin: Math.round(require('os').uptime() / 60),
      memTotalMB: MB(require('os').totalmem()),
      memFreeMB: MB(require('os').freemem()),
      memAvailableMB: MB(mi.MemAvailable),
      swapTotalMB: MB(mi.SwapTotal)
    },
    cgroup: {
      limitMB: MB(cg.limitBytes),
      usedMB: MB(cg.usedBytes),
      freeMB: cg.limitBytes && cg.usedBytes != null ? MB(cg.limitBytes - cg.usedBytes) : null,
      source: cg.path
    },
    portal: {
      rssMB: MB(process.memoryUsage().rss),
      heapUsedMB: MB(process.memoryUsage().heapUsed),
      uptimeMin: Math.round(process.uptime() / 60)
    },
    gamesRssTotalMB: perGame,
    games: gamesInfo
  });
});

/* 大厅首页：封禁拦截（会话由前端心跳自己上报，不依赖 cookie —— 云端会覆盖 cookie） */
app.get(['/', '/index.html'], (req, res, next) => {
  if (ipBanned(clientIp(req))) {
    return res.status(403).type('html').send(
      '<meta charset="utf-8"><body style="background:#0b0f16;color:#e5e7eb;font-family:system-ui;padding:48px">' +
      '<h1 style="font-size:20px">访问受限</h1>' +
      '<p style="color:#9aa4b2">此设备已被限制访问。</p></body>'
    );
  }
  recordVisit(req, 'lobby', '/');
  next();
});

/* 监控台页面：未登录直接跳登录页，不给看任何数据 */
app.get(['/monitor.html', '/monitor'], (req, res) => {
  if (!isAdmin(req)) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'monitor.html'));
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

/* 独立直达挂载点：某些游戏可以在自己的路径下直接打开（不经过大厅） */
const STANDALONE_MOUNTS = {};

/* 注入到游戏页面的运行时补丁 */
app.get('/play/:slug/__portal-shim.js', (req, res) => {
  res.type('application/javascript').set('cache-control', 'public, max-age=300');
  fs.createReadStream(SHIM_PATH).pipe(res);
});

for (const mount of Object.values(STANDALONE_MOUNTS)) {
  app.get(mount + '/__portal-shim.js', (req, res) => {
    res.type('application/javascript').set('cache-control', 'public, max-age=300');
    fs.createReadStream(SHIM_PATH).pipe(res);
  });
}

/* 统一的「确保可用」：进程在跑就直接放行。
   探测曾用来修「进程卡死」，但实测发现：探测本身在云端会误伤——
   大文件加载期间进程响应慢，探测判死 → 重启 → 页面所有请求 502。
   现在只保证进程起来，卡死交给空闲休眠 + 手动重进处理。 */
async function ensureUsable(slug) {
  const entry = registry.get(slug);
  if (!entry) throw new Error('未知游戏');
  if (entry.state === 'running') return entry;

  /* 暂停期内拒绝启动：手动释放后，外部的自动重连脚本会立刻把进程拉起来。
     暂停期内直接拒绝，让这类连接自己退，而不是白占内存。 */
  const until = entry.pausedUntil || 0;
  if (Date.now() < until) {
    throw new Error('该游戏已暂停服务，请稍后再试');
  }

  return ensureGame(slug);
}

/* 转发结束要减计数 */
function releaseInflight(slug) {
  const entry = registry.get(slug);
  if (entry) entry.inflight = Math.max(0, (entry.inflight || 1) - 1);
}

app.use('/play/:slug', async (req, res) => {
  const slug = req.params.slug;
  const entry = registry.get(slug);
  if (!entry) return res.status(404).type('html').send('<h1>404</h1><p>没有这个游戏</p>');

  /* 封禁拦截：静态资源除外（被封的人连页面都打不开就够了） */
  const ip = clientIp(req);
  if (ipBanned(ip)) {
    console.log(`[拦截] 已封禁 IP ${ip} 请求 ${req.method} /play/${slug}${req.url} | xff=${String(req.headers['x-forwarded-for'] || '').slice(0, 60)}`);
    return res.status(403).type('html').send(
      '<meta charset="utf-8"><body style="background:#0b0f16;color:#e5e7eb;font-family:system-ui;padding:48px">' +
      '<h1 style="font-size:20px">访问受限</h1>' +
      '<p style="color:#9aa4b2">此设备已被限制访问该游戏。</p></body>'
    );
  }

  /* 只允许浏览器：脚本（node/curl/python）的 UA 没有 Mozilla 字样，一律挡掉。
     放行方式：ALLOW_SCRIPTS=1 全局放行，或请求带 ?_dev=DEV_KEY。 */
  if (BLOCK_SCRIPTS && !isBrowserUA(req.headers['user-agent'])) {
    const key = String(req.query._dev || '');
    if (!(DEV_KEY && key === DEV_KEY)) {
      console.log(`[拦截] 非浏览器请求 ${ip} UA=${String(req.headers['user-agent'] || '').slice(0, 40)}`);
      return res.status(403).type('text/plain; charset=utf-8').send('仅支持浏览器访问');
    }
  }

  req.url = req.url || '/';
  if (req.url === '') req.url = '/';

  /* 静态资源直供：绕开转发，直接从磁盘读 */
  const direct = DIRECT_ASSET[slug];
  if (direct && req.method === 'GET'
      && direct.prefixes.concat(['/lib/', '/models/']).some(p => req.url.startsWith(p))) {
    return serveDirect(req, res, slug, direct, req.url.split('?')[0]);
  }

  /* 只记录「页面级请求」，静态资源和 shim 不记，避免刷屏。
     会话在线状态由页面心跳上报（云端会换 IP，服务端无法靠请求自己串起来）。 */
  if (!/\.(js|css|glb|png|jpg|webp|mp3|ogg|wav|json)$/i.test(req.url.split('?')[0])) {
    recordVisit(req, slug, req.url.split('?')[0]);
  }

  /* shim 永远由网关自己给，绝不下发给游戏进程 */
  if (req.url.startsWith('/__portal-shim.js')) {
    res.type('application/javascript').set('cache-control', 'public, max-age=300');
    return fs.createReadStream(SHIM_PATH).pipe(res);
  }

  try {
    await ensureUsable(slug);
  } catch (err) {
    releaseInflight(slug);    return res.status(503).type('html').send(
      `<meta charset="utf-8"><body style="background:#0b0f16;color:#e5e7eb;font-family:system-ui;padding:48px">
       <h1 style="font-size:20px">「${entry.cfg.name}」启动失败</h1>
       <p style="color:#9aa4b2">${err.message}</p>
       <p><a style="color:#7dd3fc" href="/">← 返回游戏大厅</a></p></body>`
    );
  }
  entry.lastActive = Date.now();
  res.on('finish', () => releaseInflight(slug));
  res.on('close', () => releaseInflight(slug));
  proxyToGame(req, res, slug, entry);
});

/* ------------------------------------------------------------------ */
/*  独立直达：某些游戏可以在自己的路径下直接打开（不经过大厅）           */
/*  例：/pvz/  →  直接进入「玩家大战僵尸」                              */
/* ------------------------------------------------------------------ */
for (const [slug, mount] of Object.entries(STANDALONE_MOUNTS)) {
  app.use(mount, async (req, res) => {
    const entry = registry.get(slug);
    if (!entry) return res.status(404).type('html').send('<h1>404</h1>');

    req.url = req.url || '/';
    if (req.url === '') req.url = '/';
    try {
      await ensureUsable(slug);
    } catch (err) {
      releaseInflight(slug);
      return res.status(503).type('html').send(
        `<meta charset="utf-8"><body style="background:#0b0f16;color:#e5e7eb;font-family:system-ui;padding:48px">
         <h1 style="font-size:20px">「${entry.cfg.name}」启动失败</h1>
         <p style="color:#9aa4b2">${err.message}</p>
         <p><a style="color:#7dd3fc" href="/">← 返回游戏大厅</a></p></body>`
      );
    }
    res.on('finish', () => releaseInflight(slug));
    res.on('close', () => releaseInflight(slug));
    proxyToGame(req, res, slug, entry, '/play/' + slug);
  });
}

app.use((req, res) => res.status(404).type('html').send(
  '<meta charset="utf-8"><body style="background:#0b0f16;color:#e5e7eb;font-family:system-ui;padding:48px">' +
  '<h1 style="font-size:20px">404</h1><p><a style="color:#7dd3fc" href="/">返回游戏大厅</a></p></body>'
));

const server = http.createServer(app);

/* ---------------------- WebSocket 升级代理 ---------------------- */
server.on('upgrade', (req, socket, head) => {
  /* 封禁拦截：被封的 IP 直接断掉，不转发 */
  const ip = clientIp(req);
  if (ipBanned(ip)) {
    console.log(`[拦截] 已封禁 IP ${ip} 尝试 WebSocket 连接`);
    try { socket.destroy(); } catch (_) {}
    return;
  }

  /* 脚本拦截：socket.io 的轮询/升级请求同样要求浏览器 UA */
  if (BLOCK_SCRIPTS && !isBrowserUA(req.headers['user-agent'])) {
    console.log(`[拦截] 非浏览器 WebSocket ${ip} UA=${String(req.headers['user-agent'] || '').slice(0, 40)}`);
    try { socket.destroy(); } catch (_) {}
    return;
  }

  const m = /^\/play\/([^/]+)(\/.*)?$/.exec(req.url || '');
  let slug = null, rest = '/';
  if (m) {
    slug = decodeURIComponent(m[1]);
    rest = m[2] || '/';
  } else {
    /* 独立直达挂载点 */
    for (const [s, mount] of Object.entries(STANDALONE_MOUNTS)) {
      if (req.url === mount || req.url.indexOf(mount + '/') === 0) {
        slug = s;
        rest = req.url.slice(mount.length) || '/';
        break;
      }
    }
  }
  if (!slug) return socket.destroy();
  recordVisit(req, slug, rest);
  const entry = registry.get(slug);
  if (!entry || entry.state !== 'running') return socket.destroy();

  const upstream = net.connect(entry.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${rest} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  entry.conns++;
  entry.lastActive = Date.now();
  entry.lastTraffic = Date.now();

  // 实时数据心跳：用来识别「连接还在但人已经走了」的假连接
  socket.on('data', () => { entry.lastTraffic = Date.now(); });
  upstream.on('data', () => { entry.lastTraffic = Date.now(); });

  let closed = false;
  const upAt = Date.now();
  const done = (why) => {
    if (closed) return;
    closed = true;
    entry.conns = Math.max(0, entry.conns - 1);
    entry.lastActive = Date.now();
    /* 记录 WS 断开原因与存活时长：排查「开局后自动失去连接」用 */
    const life = ((Date.now() - upAt) / 1000).toFixed(1);
    log(slug, `WS 断开(${why}) 存活 ${life}s 剩余连接 ${entry.conns}`);
  };
  socket.on('close', () => { done('client-close'); upstream.destroy(); });
  socket.on('error', (e) => { done('client-error:' + (e && e.code)); upstream.destroy(); });
  upstream.on('close', () => { done('upstream-close'); socket.destroy(); });
  upstream.on('error', (e) => { done('upstream-error:' + (e && e.code)); socket.destroy(); });
  socket.setTimeout(0);
  socket.setNoDelay(true);
  upstream.setNoDelay(true);
});

server.listen(PORT, HOST, () => {
  loadBans();
  console.log('');
  console.log('  5199 游戏厅已启动');
  console.log(`  本机：  http://localhost:${PORT}`);
  if (banList.size) console.log(`  封禁：  ${[...banList].join(', ')}`);
  console.log(`  游戏：  ${games.length} 款（${KEEP_ALL ? '全部常驻' : `按需启动 · 空闲 ${Math.round(IDLE_STOP_MS / 60000)} 分钟自动休眠`}）`);
  console.log('');

  /* 预热：逐款拉起，避免同时启动抢 CPU/内存；失败不影响大厅 */
  if (KEEP_ALL) {
    (async () => {
      for (const g of games) {
        const entry = registry.get(g.slug);
        if (entry.state === 'running' || entry.state === 'starting') continue;
        try {
          await ensureGame(g.slug);
          log(g.slug, '预热完成');
        } catch (err) {
          log(g.slug, '预热失败 ' + err.message);
        }
        await new Promise(r => setTimeout(r, 1200));
      }
      console.log('  [预热] 全部游戏已就绪');
    })();
  }
});

process.on('SIGTERM', () => {
  for (const [slug] of registry) stopGame(slug);
  process.exit(0);
});
