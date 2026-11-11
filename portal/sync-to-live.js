/**
 * 把 portal/ 的源码同步到线上应用目录（Desktop\5199游戏厅）。
 *
 * 背景：托管平台按「本地目录」识别应用，游戏厅的线上应用绑定的是
 * C:\Users\Administrator\Desktop\5199游戏厅，所以改完 portal/ 后
 * 必须先跑这个脚本，再发布一次，线上才会更新。
 *
 * 用法：node sync-to-live.js
 */
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
/* 发布目录：旧的 5199游戏厅 已下线，现在统一同步到 5199游戏厅（v3 已改名） */
const DEST = 'C:\\Users\\Administrator\\Desktop\\5199游戏厅';
const SKIP = new Set(['node_modules', 'logs', '.git', 'sync-to-live.js']);

if (!fs.existsSync(DEST)) {
  console.error('[错误] 线上目录不存在: ' + DEST);
  process.exit(1);
}

let files = 0;
let bytes = 0;

function walk(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      walk(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      files++;
      bytes += fs.statSync(dst).size;
    }
  }
}

walk(SRC, DEST);
console.log(`[已同步] ${files} 个文件, ${(bytes / 1048576).toFixed(1)} MB -> ${DEST}`);
console.log('下一步：在对话里说「同步到线上」，再发布一次即可。');
