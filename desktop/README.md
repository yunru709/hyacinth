# Hyacinth 桌面版（.NET 10 + WinForms + WebView2）

把现有 WebUI 装进一个**原生窗口**。壳只做两件事：拉起后端（`node dist/index.js webui`）、
用 WebView2 打开 `http://127.0.0.1:3130`。**不产生第二套 UI** —— 页面仍是 `src/webui/`，
经同一套 ui-protocol 走 WS，与 TUI 共用后端。

## 怎么跑

```powershell
pnpm run build            # 至少跑一次：壳拉的后端就是 dist/index.js
pnpm run desktop:build    # 构建 + 部署 + 建/刷新桌面快捷方式
pnpm run desktop          # 启动（已构建过）
```

不想用 pnpm：**双击仓库根目录的 `hyacinth-desktop.cmd`** —— 它先检查 exe 在不在，
缺了自动构建，然后启动。

也可直接调脚本（有开关）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/desktop-build.ps1 -Launch
# -SkipBuild   只部署（不重新构建）
# -NoShortcut  不动桌面快捷方式
```

产物落点：`%LOCALAPPDATA%\Programs\hyacinth-shell\native-shell.exe`（+ WebView2 运行库，共约 2 MB）
桌面快捷方式：`Hyacinth.lnk`

## 依赖

- **.NET 10**（本机 SDK 10.0.102 ✓）。工程是 `SelfContained=false` ⇒ 框架依赖部署，exe 仅 158 KB。
- **WebView2 Runtime**（Win10/11 一般自带）。⚠️ 本机 154 与 155 并存，见下面坑 1。
- **后端构建产物** `dist/index.js`（`pnpm run build`）。缺了壳会白屏、后端立刻退出。

## 两个已踩过的坑（别重犯）

1. **必须显式指定 WebView2 运行时目录**：本机 154.0.4258.62 与 155.0.4283.45 并存，而
   **155 的浏览器进程崩在 `msedge_elf.dll`**（WER: APPCRASH）⇒ 控制器创建报 E_UNEXPECTED。
   代码取**升序最低版**（154）规避。见 `MainForm.ResolveBrowserRuntime`。
2. **必须指定 `RuntimeIdentifier=win-x64`**：AnyCPU 下 `WebView2Loader.dll` 只落在
   `runtimes/win-x64/native/`、**不在 exe 同目录** ⇒ `CoreWebView2Environment` 初始化抛
   0x8000FFFF「灾难性故障」。见 `native-shell.csproj` 里的注释。

另外两条运行期纪律（都在 `MainForm.cs` 里写明了原因）：
- 拉后端要带 **`HYACINTH_NO_OPEN_BROWSER=1`**，否则 `webui` 子命令会额外弹一个系统浏览器。
- **必须读走子进程的 stdout/stderr**（否则管道写满会把 node 卡死），并落盘到
  `outputs/gui-probe/shell-backend.log` 便于事后排查。

## 做一个「免 .NET 运行时」的独立 exe（可选）

```powershell
dotnet publish desktop/native-shell/native-shell.csproj -c Release -r win-x64 `
  --self-contained true -p:PublishSingleFile=true -o desktop/native-shell/out-standalone
```

体积约 150–200 MB（内含 .NET 运行时），适合拷给别人；本机自用没必要。

## 目录

```
desktop/native-shell/
  Program.cs            入口（ApplicationConfiguration + 全局异常落盘）
  MainForm.cs           窗壳：拉后端 / WebView2 宿主 / DPI / 单实例与退出清理
  native-shell.csproj   工程（WinExe / net10.0-windows / RID win-x64 / 框架依赖）
  out/                  构建产物（.gitignore 忽略）
```

## 相关工具（开发/诊断）

- `tools-dev/gui/cdp-eval.mjs` —— 在壳的页面里执行任意 JS（CDP :9222）
- `tools-dev/gui/probe-startup-mode.mjs` —— 一次拿齐「后端配置 / 后端模式 / 页面 hash+localStorage」
- `tools-dev/gui/shot-window.ps1` —— 截原生窗口（**必须** `SetProcessDPIAware`，否则 150% 缩放下截错位）
