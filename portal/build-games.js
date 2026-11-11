/**
 * 把一个游戏项目里「运行时真正需要」的文件抽到 portal/games/<slug>/
 * 桌面上的原始项目保持不动（截图、测试脚本、node_modules、浏览器 profile 都不带）。
 *
 * 用法：node build-games.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'games');
const games = require('./games.config.js');

let total = 0;

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let bytes = 0;
    for (const name of fs.readdirSync(src)) {
      bytes += copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return bytes;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return st.size;
}

fs.mkdirSync(OUT, { recursive: true });

for (const g of games) {
  const srcRoot = path.join(ROOT, g.src);
  const destRoot = path.join(OUT, g.slug);
  if (!fs.existsSync(srcRoot)) {
    console.error(`[跳过] 源目录不存在: ${srcRoot}`);
    continue;
  }
  fs.mkdirSync(destRoot, { recursive: true });

  let bytes = 0;
  for (const item of g.include) {
    const s = path.join(srcRoot, item);
    if (!fs.existsSync(s)) {
      console.warn(`  [警告] 缺少 ${g.slug}/${item}`);
      continue;
    }
    bytes += copyRecursive(s, path.join(destRoot, item));
  }
  applyPatches(g.slug, destRoot);
  total += bytes;
  console.log(`[完成] ${g.slug.padEnd(14)} ${(bytes / 1048576).toFixed(1)} MB  ← ${g.src}`);
}

/**
 * 少量必要的适配：把「依赖必须放在自己目录」改成「向上查找 node_modules」，
 * 这样所有游戏共用门户根目录的一份依赖。
 */
function applyPatches(slug, destRoot) {
  if (slug === 'soccer') {
    const file = path.join(destRoot, 'server.js');
    if (!fs.existsSync(file)) return;
    let src = fs.readFileSync(file, 'utf8');
    const before = "const NM = path.join(ROOT, 'node_modules');";
    if (src.includes(before)) {
      const after = `const NM = (function () {
  let dir = ROOT;
  for (;;) {
    const cand = path.join(dir, 'node_modules', 'three');
    if (fs.existsSync(cand)) return path.join(dir, 'node_modules');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(ROOT, 'node_modules');
})();`;
      src = src.replace(before, after);
      fs.writeFileSync(file, src);
      console.log('  [适配] soccer: node_modules 向上查找');
    }
  }
}

console.log(`\n合计 ${(total / 1048576).toFixed(1)} MB`);
