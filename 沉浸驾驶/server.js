/**
 * 沉浸驾驶 · 零依赖静态服务器
 *
 * 这个游戏是纯前端应用（Three.js 单文件），不需要权威服务端。
 * 之所以仍然需要一个本地服务器，是因为 index.html 用了 ES Module，
 * 浏览器在 file:// 协议下会因 CORS 拒绝加载 three.module.js。
 *
 * 启动：node server.js   或   npm start
 * 端口：默认 3000，可用 PORT 覆盖
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (_) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';

  /* 阻止路径穿越 */
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  沉浸驾驶 · Immersive Drive');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
});
