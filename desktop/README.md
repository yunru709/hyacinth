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
  MainForm.cs           窗壳：拉后端 / WebView2 宿主 / DPI / 单实例与退出清理 / 无边框窗体
  TitleBar.cs           自绘标题栏（品牌 + 最小化/最大化/关闭）+ 无边框的 Win32 细节
  native-shell.csproj   工程（WinExe / net10.0-windows / RID win-x64 / 框架依赖）
  out/                  构建产物（.gitignore 忽略）
```

## 窗口外观：自绘标题栏（无边框）

窗口没有系统标题栏：顶部是一条 44 逻辑像素的自绘条（左：六边形 + `Hyacinth`，中间留空，
右：最小化 / 最大化 / 关闭），带 DWM 圆角与阴影，四边四角可拉伸。

改这块之前先读这三条，都是踩过的：

1. **`FormBorderStyle.None` 不能单独用**：`MainForm.CreateParams` 必须补回
   `WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX`。少了 `WS_THICKFRAME`，DWM 就不再
   认为这是"有边框"的窗口 ⇒ 阴影、圆角、贴边动画全没，窗口变成一块硬边方块。
2. **客户区被撑成整个窗口**（`WndProc` 里 `WM_NCCALCSIZE` 返回 0）：否则 `WS_THICKFRAME`
   会留一圈约 8px 的非客户区，没人绘制、还把内容整体往里挤。
   代价是最大化时窗口会按"工作区 + 边框"放大 ⇒ 用 `WM_GETMINMAXINFO` 把 `ptMaxSize/
   ptMaxPosition` 订到工作区（`ShellFrame.ClampMaximizedBounds`），不然会盖住任务栏、
   页面右下各被切掉一截。
3. **边缘拉伸的热区必须是窗体自己的像素**：WM_NCHITTEST 只发给「光标下那个窗口」，
   而 WebView2 的 `Chrome_WidgetWin` 子窗口会把鼠标消息直接送进 Chromium、不转发。
   所以内容层四周让出 4px（`ShellFrame.ResizeBorderLogical`，颜色与页面底色同为 `#0a0b14`），
   命中测试由 `FrameAwarePanel.WndProc` 转发给 `ShellFrame.HitTest`。

其它约定：
- 拖动走 `WM_NCLBUTTONDOWN + HTCAPTION`（借系统的移动循环，因此 Aero Snap / 多显示器 DPI
  过渡都是白送的）；双击最大化由标题栏自己按 `SystemInformation.DoubleClickTime` 判，
  不依赖 `WM_NCLBUTTONDBLCLK`（按下即进移动循环，那条消息的到达时机不可靠）。
- 三个按钮全部 `Graphics` 画（不是 ×/□/— 字符），最大化状态画「还原」双框。
- 关闭按钮走 `Form.Close()`，因此仍然受 `OnFormClosing` 的托盘语义约束。
- 圆角用 `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE=33, 2)`；**Win10 上该属性
  不存在**，调用返回 E_INVALIDARG ⇒ 静默降级为直角，绝不能让它抛到 `OnHandleCreated`。

## 相关工具（开发/诊断）

- `tools-dev/gui/cdp-eval.mjs` —— 在壳的页面里执行任意 JS（CDP :9222）
- `tools-dev/gui/probe-startup-mode.mjs` —— 一次拿齐「后端配置 / 后端模式 / 页面 hash+localStorage」
- `tools-dev/gui/shot-window.ps1` —— 截原生窗口（**必须** `SetProcessDPIAware`，否则 150% 缩放下截错位）

## 托盘常驻（可选，默认关闭）

```powershell
$env:HYACINTH_TRAY = "1"    # 只认 "1" / "true"，其余值一律当关闭
```

| | 默认（不设开关） | `HYACINTH_TRAY=1` |
|---|---|---|
| 点窗口 × | 退出进程 + 停后端 | 窗口隐藏（`Hide()`），后端与 WebView2 继续跑 |
| 任务栏 | 消失（进程已退） | 消失（窗口隐藏），只剩托盘图标 |
| 关机 / 任务管理器结束任务 | 正常退出 | 正常退出（只拦 `CloseReason.UserClosing`） |
| 怎么彻底退出 | 就是关窗 | 右键托盘图标 → **退出**（托盘图标随后一起消失） |

- 托盘菜单：**显示主窗口**（还原并激活）、**退出**（`StopBackend()` → `Application.Exit()`）。
- 双击托盘图标 = 显示主窗口（最小化状态会先还原成 Normal）。
- 首次收进托盘会弹一次气泡提示，之后不再弹。
- 开关为什么用环境变量：壳没有自己的设置界面，做设置项就得引入配置持久化，
  成本与收益不匹配。理由写在 `MainForm.cs` 的类注释里。

