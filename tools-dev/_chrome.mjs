// tools-dev/_chrome.mjs —— 探针共用的「找浏览器」小工具
//
// 为什么不写死路径：写死只在我这台机器上跑得通 ✗。
// 解析顺序：环境变量 CHROME_PATH → 常见安装位置（Chrome 优先，Edge 兜底）→ 报错退出 ✓
import fs from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => typeof p === 'string' && p.length > 0);

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const found = CANDIDATES.find(exists);

if (!found) {
  console.error('✗ 找不到 Chrome / Edge。请设置环境变量 CHROME_PATH 指向浏览器可执行文件后重试。');
  process.exit(1);
}

export const CHROME = found;
