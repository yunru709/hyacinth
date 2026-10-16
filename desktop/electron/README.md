# Hyacinth 桌面版（Electron 自包含包）

产物形态对齐 `F:\DSH\DeepSeek Harness.exe`：**一个文件夹，双击 exe 就跑** ——
不依赖源码树 / pnpm / .NET / 已装 Node，因为 Chromium 与 Node 都塞在包内。

实测产物：`F:\Hyacinth-Electron\`（779 MB / 14845 文件，跨盘验收通过）。

## 目录

```
desktop/electron/
  shell/             Electron 壳源码（main.js / preload.js / package.json，electron 44.7.2）
  materialize.mjs    ① 物化依赖树：从仓库 .pnpm **解引用 + hoisted 展平**（13.4s，断链 0）
  build-package.ps1  ③ 组装 DSH 样式包（调用 make-asar.cjs）
  make-asar.cjs      把壳打进 resources\app.asar
  scan-reparse.ps1   ② 跨盘可搬性判据：包内 reparse point 必须为 0
  accept.ps1         ④⑤⑥ 跨盘验收（进程归属 / health / CDP 页面 / 截图）
  start-backend.ps1  开发期辅助：不起 Electron，只把后端拉起来
  BUILD-NOTES.md     ★ 完整配方、可复现命令、踩坑与原始读数 —— **先读这份**
```

## 一键（幂等，可重复跑）

```powershell
node desktop\electron\materialize.mjs                                   # ① 物化依赖
powershell -File desktop\electron\scan-reparse.ps1 -Root <包目录>        # ② 链接数必须 0
powershell -File desktop\electron\build-package.ps1 -OutDir F:\Hyacinth-Electron   # ③ 组装
powershell -File desktop\electron\accept.ps1 -Root F:\Hyacinth-Electron            # ④ 验收
```

## 三个必须知道的坑（详见 BUILD-NOTES.md）

1. **别用 `pnpm deploy`** —— `--filter` 版实测卡满 600s 被 kill 且不装依赖 ⇒ 用
   `materialize.mjs`（自写：解引用 + 展平）。
2. **别用 `ELECTRON_RUN_AS_NODE` 跑后端** —— 与 commander 不兼容（`--port` 被判
   `unknown option`，而真 node 同命令正常；argv 已逐字核对，不是 argv 的事）⇒
   包内自带一份真 `node.exe`，Electron 只当窗口宿主。附带好处：后端与 Electron 的
   Node 版本/ABI 彻底解耦。
3. **pnpm 的 `node_modules` 是绝对路径符号链接农场**（`node_modules/@x/y -> C:\...\repo\node_modules\.pnpm\...`）
   ⇒ 直接拷包跨盘必断链（实测 `ERR_MODULE_NOT_FOUND '@clack/core'`；放在仓库同盘时
   "看着能跑"是**假绿**）⇒ 必须先物化，再用 `scan-reparse.ps1` 断言链接数为 0。

## 与 .NET 壳的关系

`desktop/native-shell/` 那份 .NET 10 + WebView2 壳仍在，体积小、启动快，**但要求目标机装了
.NET 10 与 Node**；这份 Electron 包是**换台机器就能跑**的交付形态。二者都占 3130 ⇒ 同时只能跑一个。

## 已知问题

- `security-kernel: audit append failed — EPERM`：火绒拦"新 exe 写用户目录"，仅审计日志不落盘，
  非致命。要消掉就把 `Hyacinth.exe` 与 `resources\runtime\node.exe` 加进火绒信任区。
- 包体积未裁剪（`node_modules` 含 devDeps 传递闭包，约 314 MB）。
- 本机 `api.github.com` 被拦 ⇒ 未用 `electron-builder`，改为**手工组装**（复用本机
  electron 44.7.2 二进制）。
