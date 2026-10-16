'use strict';
// ============================================================
// Hyacinth Desktop — Electron 主进程（自包含打包版）
// ============================================================
// 与开发版 main.js 的关键差异（为什么这么写）：
//
//  1. **后端用包内自带的 node.exe**，不用 `ELECTRON_RUN_AS_NODE`。
//     实测（2026-10-16）：`ELECTRON_RUN_AS_NODE=1 electron.exe dist/index.js webui --port N`
//     会被 commander 拒为 `error: unknown option '--port'`，而**同一条命令换真 node 就正常**
//     ⇒ Electron-as-node 与 commander 的 argv/选项处理有兼容问题（argv 已核对过一致，
//     不是 argv 的事）。既然修不动，就绕开：包内带一份真 node，Electron 只当窗口宿主。
//     附带好处：后端与 Electron 的 Node 版本/ABI 彻底解耦。
//
//  2. **所有路径相对 `process.resourcesPath` 解析**，不写死盘符 ——
//     这是"拷到任何盘/机器都能跑"的前提。打包后 resourcesPath = <包根>\resources。
//
//  3. **userData 保持 Electron 默认（%APPDATA%）**，绝不改到 %TEMP% ——
//     火绒会限制"新出现的未知 exe"访问 %TEMP%（加壳 exe 连解包目录都建不出来，
//     error code: 5）。%APPDATA% 是安全区。
//
//  4. **端口被占用就复用**，不拉第二个后端（避免撞单实例守卫、堆积 MCP 子进程）。

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// ── 路径解析（全部落在包内）────────────────────────────────────
// 打包后：__dirname = <包根>\resources\app.asar
//          resourcesPath = <包根>\resources
const RES = process.resourcesPath;                       // <包根>\resources
const APP_DIR = path.join(RES, 'app');                   // 后端代码 + node_modules
const NODE_BIN = path.join(RES, 'runtime', 'node.exe');  // 自带 node
const BACKEND_ENTRY = path.join(APP_DIR, 'dist', 'index.js');
const LOG_DIR = path.join(RES, '..', 'logs');            // <包根>\logs

// 开发兜底：若上面的布局不存在（比如直接在仓库里 `electron .`），回落到环境变量/仓库
const DEV_ROOT = process.env.HYACINTH_ROOT;

const PORT = Number(process.env.HYACINTH_PORT || 3130);
const APP_URL = `http://127.0.0.1:${PORT}`;
const PROVIDER = process.env.HYACINTH_PROVIDER || 'deepseek';

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null;
/** @type {BrowserWindow | null} */
let win = null;
let backendSpawned = false;
let lastBackendErr = '';

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), line);
  } catch { /* 日志失败不影响主流程 */ }
  process.stdout.write(msg + '\n');
}

// ── 就绪探测 ────────────────────────────────────────────────
function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probeHealth()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ── 启动后端 ────────────────────────────────────────────────
async function ensureBackend() {
  // 解析实际要用的入口与 node
  let nodeBin = NODE_BIN;
  let entry = BACKEND_ENTRY;
  let cwd = APP_DIR;

  if (!fs.existsSync(nodeBin) || !fs.existsSync(entry)) {
    // 开发态回落
    if (DEV_ROOT) {
      nodeBin = process.env.HYACINTH_NODE || 'node';
      entry = path.join(DEV_ROOT, 'dist', 'index.js');
      cwd = DEV_ROOT;
    } else if (fs.existsSync(entry)) {
      nodeBin = 'node';
    } else {
      throw new Error(
        `包内布局不完整：\n  node: ${nodeBin} (${fs.existsSync(nodeBin) ? '有' : '缺'})\n` +
        `  entry: ${entry} (${fs.existsSync(entry) ? '有' : '缺'})`
      );
    }
  }

  if (await probeHealth()) {
    logLine(`端口 ${PORT} 已有服务，直接复用`);
    return true;
  }

  logLine(`启动后端：${nodeBin} ${entry} webui --port ${PORT} --provider ${PROVIDER} --no-auth`);
  backend = spawn(
    nodeBin,
    [entry, 'webui', '--port', String(PORT), '--provider', PROVIDER, '--no-auth'],
    {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        // 关键：不弹系统浏览器（webui 子命令默认每次都会弹）
        HYACINTH_NO_OPEN_BROWSER: '1',
      },
    },
  );
  backendSpawned = true;

  backend.stdout.on('data', (d) => { process.stdout.write('[backend] ' + d); });
  backend.stderr.on('data', (d) => {
    lastBackendErr += d.toString();
    if (lastBackendErr.length > 8000) lastBackendErr = lastBackendErr.slice(-8000);
    process.stderr.write('[backend] ' + d);
  });
  backend.on('error', (e) => {
    lastBackendErr += `\nspawn error: ${e && e.message}`;
    logLine(`后端 spawn 失败：${e && e.message}`);
  });
  backend.on('exit', (code, sig) => {
    logLine(`后端退出 code=${code} sig=${sig}`);
    backend = null;
  });

  const ok = await waitForServer(60000);
  if (!ok) {
    const tail = lastBackendErr.slice(-1500) || '(无 stderr 输出)';
    throw new Error(`后端 60 秒内未就绪。stderr 尾部：\n${tail}`);
  }
  logLine('后端就绪');
  return true;
}

// ── 窗口 ────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0c1113',
    title: 'Hyacinth',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(path.join(RES, 'icon.png')) ? path.join(RES, 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(APP_URL);
  win.on('closed', () => { win = null; });
}

// ── 测试钩子（GUI_SHOT_AFTER 毫秒后截图；GUI_SHOT_EXIT=1 则退出）──
function installShotHook() {
  const after = Number(process.env.GUI_SHOT_AFTER || 0);
  if (!after || !win) return;
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      const out = process.env.GUI_SHOT_PATH || path.join(LOG_DIR, 'shot.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, img.toPNG());
      logLine('截图已保存 -> ' + out);
    } catch (e) {
      logLine('截图失败：' + (e && e.message));
    }
    if (process.env.GUI_SHOT_EXIT) app.quit();
  }, after);
}

// ── 生命周期 ────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    logLine(`resourcesPath = ${RES}`);
    logLine(`node.exe = ${NODE_BIN} (${fs.existsSync(NODE_BIN) ? '有' : '缺'})`);
    logLine(`backend  = ${BACKEND_ENTRY} (${fs.existsSync(BACKEND_ENTRY) ? '有' : '缺'})`);
    try {
      await ensureBackend();
    } catch (e) {
      logLine('后端启动失败：' + (e && e.message));
      dialog.showErrorBox('Hyacinth 启动失败', String(e && e.message));
      app.quit();
      return;
    }
    createWindow();
    installShotHook();
  });

  app.on('window-all-closed', () => {
    if (backendSpawned && backend) {
      try { backend.kill(); } catch { /* noop */ }
    }
    app.quit();
  });
}
