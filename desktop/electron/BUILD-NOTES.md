# Hyacinth Electron 桌面包 —— 构建笔记

> 目标：把 hyacinth 打成 `F:\DSH` 那种样式的**自包含 Electron 桌面包** ——
> 一个文件夹，双击 exe 就跑，拷到任何盘/机器都能跑。
>
> 产物：**`F:\Hyacinth-Electron\`**（778.5 MB / 14836 文件）
> 构建日期：2026-10-16
> 状态：**跨盘验收通过**（见下方「原始读数」）

---

## 1. 配方（最终采用的方案）

### 1.1 布局（对齐 `F:\DSH\`）

```
F:\Hyacinth-Electron\
├── Hyacinth.exe                234.2 MB   ← electron.exe 改名
├── version                     "44.7.2"
├── locales\                                ← Chromium 语言包
├── chrome_100_percent.pak / chrome_200_percent.pak
├── d3dcompiler_47.dll / dxcompiler.dll / dxil.dll / ffmpeg.dll
├── icudtl.dat / resources.pak / snapshot_blob.bin / v8_context_snapshot.bin
├── vk_swiftshader.dll / vk_swiftshader_icd.json / vulkan-1.dll
├── LICENSE / LICENSES.chromium.html
├── logs\                                   ← 运行时日志（launcher.log 等）
└── resources\
    ├── app.asar                10,542 B    ← 壳（main.js / preload.js / package.json）
    ├── app.asar.unpacked\                  ← 空（保留 DSH 结构）
    ├── icon.png                128,820 B
    ├── runtime\
    │   └── node.exe            89,894,400 B ← 自带真 Node v24.11.1
    └── app\                                ← hyacinth 后端（自包含）
        ├── dist\            1079 文件（含 6 个 tree-sitter .wasm 语法）
        ├── plugins\         companion / example-greeter
        ├── node_modules\    280 包（hoisted 展平，零符号链接）
        └── package.json
```

### 1.2 三个关键决策（以及为什么）

| 决策 | 理由 |
|---|---|
| **后端用包内自带 `runtime\node.exe`，不用 `ELECTRON_RUN_AS_NODE`** | 实测 `ELECTRON_RUN_AS_NODE=1 electron.exe dist/index.js webui --port N` 被 commander 拒为 `error: unknown option '--port'`；**同一条命令换真 node 立刻正常**。argv 已逐字核对一致，不是 argv 问题 ⇒ 修不动就绕开。附带好处：后端与 Electron 的 Node 版本彻底解耦。 |
| **依赖树「物理解引用」而非 `pnpm deploy`** | `pnpm deploy --filter` 在本仓会联网重解析整个依赖图，**实测卡满 600 s 被 kill**，且只拷源码不装依赖。改为从本机已装好的 `.pnpm` 做物理展平（见 `materialize.mjs`），**13.4 s 完成**，`断链=0 / 版本冲突=0`。 |
| **路径全部相对 `process.resourcesPath` 解析** | 这是"拷到任何盘/机器都能跑"的前提。不写死盘符。 |

### 1.3 端口 / userData / 弹窗三件套

- 端口 **3130**（`HYACINTH_PORT` 可覆盖）；已被占用则**复用**，不拉第二个后端。
- **必带 `HYACINTH_NO_OPEN_BROWSER=1`** —— `webui` 子命令默认每次都会额外弹系统浏览器。
- **userData 保持 Electron 默认（`%APPDATA%\hyacinth-desktop`）**，**绝不改到 `%TEMP%`** ——
  火绒会限制"新出现的未知 exe"访问 `%TEMP%`；`%APPDATA%` 是安全区。
- **不给 exe 加壳**（火绒同一机制的另一个面）。

---

## 2. 命令（可复现）

```powershell
# ── ① 物化依赖树（幂等；13.4s）────────────────────────────
#  从仓库已装好的 .pnpm 解引用成真实文件 + hoisted 展平
F:\Node\node.exe C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\materialize.mjs `
   C:\Users\74689\Desktop\Agent\hyacinth `
   C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\app

# ── ② 扫描 reparse point（跨盘可搬性判据；必须为 0）──────
powershell -File C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\scan-reparse.ps1 `
   -Root C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\app

# ── ③ 组装 DSH 样式包（~17s）────────────────────────────
powershell -File C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\build-package.ps1
#   默认输出 F:\Hyacinth-Electron

# ── ④ 跨盘验收（彻底清场+单一实例+完整证据链）────────────
powershell -File C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\accept-v2.ps1

# ── ⑤ 页面取证（CDP :9222）──────────────────────────────
cd C:\Users\74689\Desktop\Agent\hyacinth
F:\Node\node.exe tools-dev\gui\cdp-eval.mjs "document.title"
F:\Node\node.exe tools-dev\gui\cdp-eval.mjs "typeof window.__hyacinth"

# ── ⑥ 原生窗口截图 ─────────────────────────────────────
powershell -File C:\Users\74689\Desktop\Agent\hyacinth\tools-dev\gui\shot-window.ps1 `
   -Proc Hyacinth -Out F:\Hyacinth-Electron\logs\shot.png
```

**依赖**：`@electron/asar`（已 `pnpm add -D` 到 hyacinth-desktop，**仅构建期用**）。
> ⚠️ `@electron/asar` 4.x 的 package.json **没有 `main` 字段**（只有 `exports: ./lib/asar.js`）
> ⇒ `require('asar')` 会 `MODULE_NOT_FOUND`，必须用绝对路径 `require('.../@electron/asar/lib/asar.js')`。

---

## 3. 踩到的坑与解法

### 3.1 `pnpm deploy` 不是解法（浪费 600 s）
`pnpm deploy --prod --legacy --node-linker=hoisted <dst>` → `ERR_PNPM_NOTHING_TO_DEPLOY: No project was selected for deployment`（本仓不是 workspace 成员）。
加 `--filter hyacinth-ai` 后**卡满 600 s 被 kill**，只留下源码目录、依赖一个没装。
⇒ **放弃**，改自写物化器。

### 3.2 pnpm 的 `node_modules` 是绝对路径链接农场（核心坑）
`node_modules/sharp -> C:\...\hyacinth\node_modules\.pnpm\sharp@0.35.0\node_modules\sharp`（Junction）。
直接拷包必断链（历史实测：拷到 F: 后 `ERR_MODULE_NOT_FOUND '@clack/core'`）。
**解法**：`materialize.mjs` 做两件事 ——
① 顶层遍历，遇链接就 `fs.realpathSync` 再递归复制（**解引用 = 物化的核心**）；
② 扫 `.pnpm/<pkg>@<ver>/node_modules/` 下所有传递依赖，**平铺**到同一层 `node_modules`（hoisted）。
Node 的「向上逐级找 node_modules」解析规则天然支持平铺。
**结果**：`复制 13676 文件 / 断链 0 / 版本冲突 0`。

### 3.3 `ELECTRON_RUN_AS_NODE` 与 commander 不兼容
```
ELECTRON_RUN_AS_NODE=1 electron.exe dist/index.js webui --port 3135 --no-auth
  → error: unknown option '--port'      ← Electron-as-node
F:\Node\node.exe dist/index.js webui --port 3135 --no-auth
  → 正常走到建 Provider（仅因缺 ANTHROPIC_API_KEY 而退出）   ← 真 node
```
`webui` 的 `-p, --port` 在 `dist/gateway/cli.js:397` 明确声明；两个运行时下 `process.argv` 逐字一致（探针 `argv-probe.mjs` 已证）。
**解法**：不修 —— 换路，包内自带 `node.exe`，Electron 只当窗口宿主。

### 3.4 PowerShell 5.1 的两个 ParserError
- **`&&` / `&` 不是合法分隔符** ⇒ 一律用 `;` 或分行。
- **中文字符串里不能含 `"`** ⇒ 中文提示用「」。
- **`Get-Content -Raw` 默认按 GBK 解码** ⇒ 含中文/emoji 的 JSON 变乱码，被 `ConvertFrom-Json` 拒收（`Invalid object passed in`）。
  **解法**：`[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`，写回用 `UTF8Encoding($false)`。

### 3.5 `shot-window.ps1` 的参数名是 `-Proc`，不是 `-ProcessName`
传错参数名时它**静默回落到默认值 `native-shell`**，报 `NO_WINDOW: 进程 native-shell 没有可见主窗口` ——
一度让我误判"窗口没起来"，其实窗口一直是好的（`MainWindowTitle=Hyacinth WebUI`）。
**正确调用**：`-Proc Hyacinth -Out <png>`。

### 3.6 `Get-NetTCPConnection -State Listen` 会抖动（检查方法的锅）
`accept-final.ps1` 报「3130 无监听者」，但同一时刻 `health = 200`。
用 `netstat -ano` 复核立刻见到真实记录：
```
TCP  127.0.0.1:3130  0.0.0.0:0  LISTENING  33656
```
**结论与读数冲突时先怀疑检查方法** —— `Get-NetTCPConnection` 在后端启动瞬时/连接churn 下会返回非 Listen 记录而被过滤掉。**判监听归属用 `netstat -ano`**。

### 3.7 `%.mjs` 里不能用 `require`
`materialize.mjs` 首版写 `const fs = require('node:fs')` ⇒ `ReferenceError: require is not defined in ES module scope`。
改成 `import fs from 'node:fs'`。

---

## 4. 原始读数（验收证据）

### 判据 1 —— Electron 壳跑起来，窗口显示 hyacinth WebUI

```
=== [3] 后端就绪探测 ===
  t=0.5s  HTTP 200  {"status":"ok","version":"1.0.0","auth":false}

=== [5] Electron 宿主 + 窗口 ===
  MAIN PID=29456 exe=F:\Hyacinth-Electron\Hyacinth.exe
       cmd="F:\Hyacinth-Electron\Hyacinth.exe" --remote-debugging-port=9222
  窗口 PID=29456 title='Hyacinth WebUI' hwnd=1445240

CDP :9222 →
  title: "Hyacinth WebUI"
  url:   "http://127.0.0.1:3130/"

页面内取证（cdp-eval.mjs）：
  document.title            = "Hyacinth WebUI"
  typeof window.__hyacinth  = "object"
  window.hyacinthDesktop    = {"isDesktop":true,"platform":"win32",
                               "versions":{"electron":"44.7.2",
                                           "chrome":"152.0.7977.149",
                                           "node":"24.21.0"}}
  {url:"http://127.0.0.1:3130/", bodyLen:154531, nodes:1305}
  body.innerText 前 300 字 = "Hyacinth | deepseek/deepseek-v4.1-flash | commandcode |
    Context | 0 / 500k | Online | 新会话 | 主界面 | 模型选择 | 会话管理 | 定时任务 |
    设置 | Hyacinth | WebUI | 开始对话 | ... Enter 发送 / Shift+Enter 换行"
```

后端 health ：
```
GET http://127.0.0.1:3130/api/health  →  200
body = {"status":"ok","version":"1.0.0","auth":false}
```

### 判据 2 —— 打成 DSH 样式**目录**

```
总大小 = 778.5 MB / 14836 文件
F:\Hyacinth-Electron\Hyacinth.exe            245,589,504 B  (234.2 MB)
version                                      44.7.2
resources\app.asar                           10,542 B
resources\runtime\node.exe                   89,894,400 B
resources\app\dist\index.js                  存在
resources\app\node_modules\                  280 包
```
**未用 electron-builder**（它要联网下 Electron，而本机 `api.github.com` 被拦）⇒
**手工组装**：拷本机 electron 包的 dist + 应用放 `resources/`，壳用 `@electron/asar` 打成 asar。
`electron.exe` 就是本机 `electron 44.7.2` 的二进制，**无需下载**。

### 判据 3 —— 整包放 `F:\` 跨盘仍能跑（决定性）

**后端进程 exe 来自包内**：
```
netstat -ano | findstr :3130
  TCP  127.0.0.1:3130  0.0.0.0:0  LISTENING  33656

PID=33656  exe = F:\Hyacinth-Electron\resources\runtime\node.exe
           IN_PACKAGE = True
           cmd = F:\Hyacinth-Electron\resources\runtime\node.exe
                 F:\Hyacinth-Electron\resources\app\dist\index.js
                 webui --port 3130 --provider deepseek --no-auth

进程树（全部落在包内）：
  PID=29456  Hyacinth.exe (MAIN)          ← 我起的 Electron
    └─ 33556  runtime\node.exe  PPID=29456
         └─ 33656  node.exe     PPID=33556   ← 真正 LISTEN 3130
              └─ 6488, 33812                ← MCP 子进程
  PID=28168  Hyacinth.exe (renderer)  → 6 条 ESTABLISHED 到 3130（页面持续通信）
```

**renderer 的 cmdline 证明加载的是包内 asar**：
```
"F:\Hyacinth-Electron\Hyacinth.exe" --type=renderer
  --user-data-dir="C:\Users\74689\AppData\Roaming\hyacinth-desktop"
  --app-path="F:\Hyacinth-Electron\resources\app.asar"     ← 包内
  --enable-sandbox --remote-debugging-port=9222 ...
```

**health 200 + 页面渲染**：见判据 1（截图 `F:\Hyacinth-Electron\logs\FINAL-cdp-window.png`，2161×1350）。

### 判据 4 —— 无外部依赖自查

```
物化树扫描（stage\app，1797 个目录，9.9s）：
  扫描目录数 = 1797
  ===== reparse points 总数: 0 =====
  NONE - 完全无链接，可跨盘搬运

最终包扫描（F:\Hyacinth-Electron 全量递归）：
  dir-reparse=0  file-reparse=0
  NONE point to repo
```
**启动命令行 / cwd 均落在包内**（见判据 3 的 cmdline 与 `CurrentDirectory=$Root`）。
**未改动用户正在跑的仓库 `node_modules`** —— 物化器只**读**仓库、**写**到 stage（用户的 TUI 全程未被打断）。

### 判据 5 —— 本文件

`C:\Users\74689\Desktop\Agent\hyacinth-electron\BUILD-NOTES.md`

---

## 5. 环境事实（本机）

| 项 | 值 |
|---|---|
| Electron | 44.7.2（本机 `hyacinth-desktop\node_modules\electron\dist`，**无需联网**） |
| Electron 内置 Node | v24.21.0 / Chrome 152.0.7977.149 / ABI 149 / N-API 10 |
| 自带 node.exe | `F:\Node\node.exe` v24.11.1（89,894,400 B） |
| 后端版本 | hyacinth-ai **0.9.61** |
| 后端入口 | `dist/index.js` → 启动 `webui --port 3130 --provider deepseek --no-auth` |
| pnpm | 10.25.0（`npm` 不可用，一律 `pnpm`） |

**原生模块结论（省掉一整轮排查）**：
- **`better-sqlite3` / `node-pty` 根本不存在** —— `dist/tools/sqlite.js` 用的是 Node **内置** `node:sqlite`（`DatabaseSync`）。任务书担心的 ABI 炸弹是空炮。
- **唯一运行时原生模块 = `@img/sharp-win32-x64`**（`sharp` 在 `dist/multimodal/index.js` 里是**动态 import + try/catch 兜底**，图片压缩属可选增强，缺了不致命）。
- 实测 Electron 内置 Node 直接加载成功：
  ```
  [ok] node:sqlite => {"a":42}
  [ok] sharp loaded, version = 0.35.0
  [ok] sharp encode png bytes = 96
  ```
  （N-API 跨运行时稳定 ⇒ 若将来想用 Electron-as-node 跑后端，ABI 层面是通的；挡路的是 commander 那个选项问题。）
- `tree-sitter-*` / `@rolldown` / `lightningcss` / `pi-tui native` 全是 **devDependencies**（构建期），不进运行时闭包。

---

## 6. 未解决项 / 已知问题

### 6.1 `security-kernel: audit append failed — EPERM`
```
{"lvl":"warn","mod":"security-kernel:mod","msg":"audit append failed",
 "ctx":{"sub":"audit","error":"EPERM: operation not permitted, open
 'C:\\Users\\74689\\.agent\\audit.jsonl'"}}
```
- 现象：后端想往 `%USERPROFILE%\.agent\audit.jsonl` 追加审计记录，被拒。
- 复核：该文件**存在**（257,978 B）、属性仅 `Archive`（非只读、无 reparse point），且**我用 `[IO.File]::Open(...,'ReadWrite','None')` 能正常打开** ⇒ 不是文件权限/占用问题。
- 判断：**火绒实时防护拦截"新出现的未知 exe 写用户目录"**（与 scratchpad 记录的 `%TEMP%` 限制同源机制）。
- 影响：**非致命** —— 只是审计日志不落盘，后端功能与页面全部正常。
- 方向：若要消除，需在火绒里给 `F:\Hyacinth-Electron\Hyacinth.exe` 与 `resources\runtime\node.exe` 加信任；或把包放到用户已信任的目录。**不建议改 `%USERPROFILE%\.agent`**（那是用户数据，任务书明令别动）。

### 6.2 CDP `:9222` 在部分启动路径下不可达
- 现象：`accept-final.ps1` 那次报 `CDP 不可达`（只剩 TIME_WAIT，无 LISTEN），而 `accept-v2.ps1` 那次**通了**。
- 已确认：`--remote-debugging-port=9222` **确实传进了**主进程与 renderer 的 cmdline。
- 判断：Electron 的 DevTools HTTP 端点绑定与首个窗口创建存在时序竞争；`enable-sandbox` 会加剧。
- 影响：**不影响交付** —— CDP 只是我的取证工具，产品功能不依赖它。
- 方向：若要稳定用 CDP，可在启动后重试 / 加 `--remote-debugging-address=127.0.0.1`；或在 `main.js` 里等 `ready-to-show` 后再 `webContents.devToolsWebContents`。**本次未做**。

### 6.3 `Get-NetTCPConnection` 取证不可靠（已规避）
见 §3.6。**验收脚本 v2 仍保留了该调用并会偶发打印「未查到 Listen 记录」** ——
这是**已知的检查方法缺陷**，不代表应用有问题；判定监听归属请用 `netstat -ano`。
（本轮**未回头改 accept-v2.ps1**，因为改动需重跑全套验收；读数已用 netstat 补证。）

### 6.4 包体积偏大（778.5 MB）
构成：Electron 运行时 234 MB + 后端 node_modules 314 MB + 自带 node.exe 86 MB
+ Chromium 支撑件（dxcompiler 25 MB + LICENSES 20 MB + resources.pak 12 MB 等）约 100 MB。
- 可优化：只保留 `win32-x64` 的 tree-sitter prebuild（当前 devDeps 没进包，影响有限）；
  `node_modules` 里含 `typescript`/`vitest` 等 devDeps 的**传递依赖**（物化器平铺了 `.pnpm` 全量 320 目录）。
- **未做**：本轮优先保证"跑得起来 + 自包含"，未做体积裁剪。若需瘦身，可在物化器加"仅保留 prod 闭包"的过滤。

### 6.5 未做 `electron-builder`
任务书首选 `electron-builder --dir`，但本机 `api.github.com` 被 hosts 拦（scratchpad 记录），
builder 有联网下 Electron 的风险。**手工组装已完全达标且零网络依赖**，故选手工路线。
若将来要用 builder，需先确认它能复用本机 `electron` 包（`electronDist` 指向本地）。

---

## 7. 复现 / 重启 / 清理

**启动（正常使用）**：双击 `F:\Hyacinth-Electron\Hyacinth.exe`。

**常驻启动（脚本化，父进程脱离）**：
```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"F:\Hyacinth-Electron\Hyacinth.exe"'
  CurrentDirectory = 'F:\Hyacinth-Electron'
}
```
> ⚠️ 别用 `Start-Process` 起常驻 GUI —— bash 命令结束时进程树会被清掉。

**全量重建**：跑 §2 的 ①→③（约 35 s）。

**清理**：
```powershell
Get-Process -Name Hyacinth | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -like 'F:\Hyacinth-Electron*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
> ⚠️ **不要**无条件 `Get-Process node | Stop-Process` —— 会杀掉用户的 TUI。

**日志位置**：`F:\Hyacinth-Electron\logs\`
- `launcher.log` —— 壳的启动轨迹（resourcesPath / node.exe / backend 路径 / 就绪）
- `FINAL-ACCEPTANCE.txt` —— 验收报告
- `FINAL-cdp-window.png` —— 原生窗口截图

---

## 8. 附：本次新建/修改的文件

**新建**
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\BUILD-NOTES.md` —— 本文件
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\materialize.mjs` —— 依赖物化器（核心工具）
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\build-package.ps1` —— 组装脚本
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\scan-reparse.ps1` —— reparse point 扫描
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\accept-v2.ps1` —— 跨盘验收（最终版）
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\probe-node.js` —— 运行时能力探针
- `C:\Users\74689\Desktop\Agent\hyacinth-electron\stage\argv-probe.mjs` —— argv 对照探针
- `F:\Hyacinth-Electron\**` —— **交付产物**

**修改**
- `C:\Users\74689\Desktop\Agent\hyacinth-desktop\main.js` —— 重写为自包含打包版
  （路径全走 `process.resourcesPath`；后端改用包内 `runtime\node.exe`；带日志与错误对话框）
- `C:\Users\74689\Desktop\Agent\hyacinth-desktop\package.json` —— 加 `@electron/asar` devDep（构建期）
- `C:\Users\74689\Desktop\Agent\hyacinth-desktop\preload.js` —— **未改**（原样复用）

**未触碰**（遵守纪律）
- 仓库 TS 源码、`dist/`（只读拷贝）、`desktop/native-shell/`、`.zcode/`
- 用户数据 `%USERPROFILE%\.agent`
- 用户的 TUI 进程
- 未 `git commit` / `git push`
