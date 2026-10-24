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
  MainForm.cs           窗壳：拉后端 / WebView2 宿主 / DPI / 单实例与退出清理 / 托盘常驻
  ShellTheme.cs         窗口 chrome 染色（系统标题栏染页面顶栏同色）+ Win11 圆角
  native-shell.csproj   工程（WinExe / net10.0-windows / RID win-x64 / 框架依赖）
  app.ico               应用图标（生成产物，勿手改 —— 见「应用图标」节）
  out/                  构建产物（.gitignore 忽略）
```

## 窗口外观：标准窗口 + DWM 染色（2026-10-24 换方案）

窗口是**完全标准的系统窗口**（一行窗口结构代码都不碰），没有自绘标题栏、没有
`FormBorderStyle.None`、没有 `WM_NCCALCSIZE` 清零、没有缩放热区带。外观由
`ShellTheme.cs` 的 DWM 染色实现：

- `DWMWA_CAPTION_COLOR(35)` / `DWMWA_TEXT_COLOR(36)`：系统标题栏与标题文字染成
  **页面顶栏同色**（文字隐形后，caption 左侧只剩窗口图标 = 品牌位）；
- `DWMWA_BORDER_COLOR(34)`：边框同色，外沿只剩阴影勾边；
- `DWMWA_USE_IMMERSIVE_DARK_MODE(20)`：系统三颗 caption 按钮的深浅跟随页面主题。

颜色由页面在 `applyTheme` 时经 `window.chrome.webview.postMessage` 报上来
（webui 的 `notifyShellTheme`，含明暗判定）；壳在 `WebMessageReceived` 里实时应用。
三颗系统按钮 / 拖拽 / 缩放 / 圆角 / 阴影 / Snap 全是系统原生机制。

**为什么换**：上一版自绘无边框（上面那套 `None`+`THICKFRAME`+`NCCALCSIZE`+热区带）
两类问题反复出现——某些外部 ShowWindow 路径下 DWM 重算非客户区时浮出一条系统蓝
标题栏；客户区四周的深色热区带去不掉。对照参考 DeepSeek Harness / ZCode（Electron
`titleBarStyle hidden + titleBarOverlay`）：它们的共同点是**不碰窗口非客户区结构**。
本方案同理，只是 WebView2 的 WCO API（SDK 1.0.4258 尚未暴露 titleBarOverlay）用
DWM 染色替代。**别再走回自绘路线** —— 上面的坑记录就是它的墓志铭。

- 单实例唤回：第二实例 `EnumWindows`（**FindWindow 搜不到 Hide() 后的窗口**，实测
  踩过）按标题找到第一实例，`PostMessage(WM_SHOWME)` 让第一实例自己的 UI 线程走
  `ShowMainWindow()` —— 跨实例只传消息、不传状态。
- 关闭按钮走系统 caption（或托盘菜单），受 `OnFormClosing` 的托盘语义约束。
- 这些 DWM 属性是 Win11 22000+；Win10 返回 E_INVALIDARG ⇒ 静默保持系统默认标题栏。

## 相关工具（开发/诊断）

- `tools-dev/gui/cdp-eval.mjs` —— 在壳的页面里执行任意 JS（CDP :9222）
- `tools-dev/gui/probe-startup-mode.mjs` —— 一次拿齐「后端配置 / 后端模式 / 页面 hash+localStorage」
- `tools-dev/gui/shot-window.ps1` —— 截原生窗口（**必须** `SetProcessDPIAware`，否则 150% 缩放下截错位）

## 应用图标

`app.ico` 不是手画资产，是 **`scripts/gen-desktop-icon.cjs` 用代码画出来的**：参数化 SVG
（一朵紫风信子，配色与 WebUI `--neutral-0` / `--primary-500` 同源）→ sharp 逐尺寸原生
光栅化（16/24/32/48/64/128/256）→ 手工组装多尺寸 .ico。改配色 / 花序布局只改脚本重跑：

```bash
pnpm run gen:desktop-icon
```

csproj 里两处引用：`ApplicationIcon`（exe 文件图标 / 任务栏 / 快捷方式）+
`EmbeddedResource`（运行期取 256 大图，Alt-Tab 不糊）。标题栏品牌标（TitleBar.cs 的
`DrawHyacinthMark`）是同一设计的 GDI+ 矢量版，保持"exe 图标 = 托盘图标 = 标题栏花标"。

## 托盘常驻（默认开启）

2026-10-24 用户裁定：桌面壳定位为**后台常驻程序** —— 关窗只是收进托盘，
后端继续跑；托盘菜单「退出」才是真正结束进程。

```powershell
$env:HYACINTH_TRAY = "0"    # 退回"关窗即退出"的老行为（只认 "0" / "false"，其余值一律当开）
```

| | 默认（不设开关） | `HYACINTH_TRAY=0` |
|---|---|---|
| 点窗口 × | 窗口隐藏（`Hide()`），后端与 WebView2 继续跑 | 退出进程 + 停后端 |
| 任务栏 | 消失（窗口隐藏），只剩托盘图标 | 消失（进程已退） |
| 关机 / 任务管理器结束任务 | 正常退出（只拦 `CloseReason.UserClosing`） | 正常退出 |
| 怎么彻底退出 | 托盘菜单 → **退出**（`StopBackend()` → `Application.Exit()`） | 就是关窗 |

- 托盘菜单（按常驻程序常规形态）：**打开主窗口**（默认项，加粗）、**在浏览器中打开**
  （WebView2 出问题时的救生通道）、**打开日志文件夹**、**退出**。
- 单击托盘图标 = 打开主窗口（Telegram / 微信等的主流行为）；双击同效。
- 首次收进托盘会弹一次气泡提示，之后不再弹。
- 开关为什么用环境变量：壳没有自己的设置界面，做设置项就得引入配置持久化，
  成本与收益不匹配。理由写在 `MainForm.cs` 的类注释里。

