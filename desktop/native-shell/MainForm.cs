using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace native_shell;

/// <summary>
/// Hyacinth 原生桌面外壳（.NET 10 + WinForms + WebView2）。
///
/// 设计取舍（写给以后维护的人 / agent）：
///  1) **前端直接复用现有 WebUI**：它本来只吃 ui-protocol over WebSocket，所以本窗口
///     只是一个 WebView2 宿主 —— 前后端能力完全同源，不会出现"桌面版另有一套 UI"的分叉。
///  2) **后端以子进程启动**（不是把 hyacinth 塞进宿主进程）：它依赖真实 Node 运行时
///     （native 模块 / security-kernel / 自带子进程），跑在 .NET 宿主里既无必要也难排查。
///  3) **端口已有服务就复用**：本地开发常年有个 webui 在跑，重复拉会撞单实例守卫。
///  4) 不用 Electron：本机实测 Electron 的 GUI 模式在 native 初始化期就崩（0xC0000005），
///     .NET 宿主则验证可跑。详见 ~/.agent/prompts/persona/scratchpad.md 的环境事实。
///  5) **两种部署形态都支持**（2026-10-16 加，为的是能交出一个"绿色版"文件夹）：
///       A) 绿色包：exe 旁边有 `runtime\node.exe` + `app\`（含 dist/node_modules/plugins）
///          ⇒ 完全自包含，换台机器（无需装 .NET / Node / pnpm）也能双击运行；
///       B) 开发形态：仓库里构建出来的 exe ⇒ 回退到仓库根。
///     **判据一律以 exe 自身所在目录为准，绝不写死某台机器的路径。**
///  6) **托盘常驻是默认行为**（2026-10-24 用户裁定：桌面壳定位为后台常驻程序）：
///     关窗 = 收进托盘（窗口隐藏、后端继续跑），**托盘菜单「退出」才是真正结束进程**。
///     要回到"关窗即退出"的老行为，设 `HYACINTH_TRAY=0`。
///  7) **开关用环境变量而不是设置项**：壳没有自己的设置界面（也就没有"设置"这个概念），
///     要做设置项就得先引入一层配置持久化（文件格式 / 读写 / 迁移 / 并发写 / 损坏回退），
///     成本与"一个布尔开关"的收益完全不匹配。环境变量与既有的 `HYACINTH_PORT`、
///     `HYACINTH_WEBVIEW2_USER_DATA` 同一风格，改一次、用完即弃，不污染用户目录。
///  8) **标准窗口 + DWM 染色**（2026-10-24 换方案，替代 10-23 的自绘无边框）：
///     自绘路线（FormBorderStyle.None + WM_NCCALCSIZE 清零 + 自绘标题栏 + 4px 热区带）
///     两类问题反复出现——外部 ShowWindow 路径下 DWM 重算 NC 浮出系统蓝标题栏、
///     客户区四周的深色热区带去不掉。现在窗口是**完全标准的系统窗口**，外观交给
///     DWM 染色（标题栏/文字/边框染页面顶栏同色，系统按钮深浅随页面主题，见
///     ShellTheme），页面在 applyTheme 时经 WebMessage 报色。对照参考：DeepSeek
///     Harness / ZCode（Electron）用 titleBarStyle hidden + titleBarOverlay 达成
///     同一效果 —— 共同点是"不碰窗口非客户区结构"。
/// </summary>
public sealed class MainForm : Form
{
    /// <summary>
    /// exe 自身所在目录。
    /// ⚠️ **不能用 `AppContext.BaseDirectory`**：单文件（PublishSingleFile）发布时它指向
    /// 运行期的临时解包目录，而不是 exe 真正所在的位置 ⇒ 找不到旁边的 runtime\app。
    /// </summary>
    private static readonly string ExeDir =
        Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;

    /// <summary>
    /// 桌面壳用端口。默认 3130（避开 WebUI 的 3100，两者可并存）；
    /// 可用环境变量 <c>HYACINTH_PORT</c> 覆盖 —— 调试时用来复用一个已在跑的后端。
    /// </summary>
    private static readonly int Port =
        int.TryParse(Environment.GetEnvironmentVariable("HYACINTH_PORT"), out var p) && p > 0 && p < 65536
            ? p
            : 3130;

    private static readonly string BaseUrl = $"http://127.0.0.1:{Port}";

    /// <summary>
    /// 托盘常驻开关：默认**开**（关窗收进托盘，托盘「退出」才结束进程）。
    /// 设 <c>HYACINTH_TRAY=0</c>（或 <c>false</c>）退回"关窗即退出"的老行为。
    /// 除显式的 0/false 之外一律当开 —— 默认语义就是常驻，拼错值不该悄悄改变它。
    /// </summary>
    private static readonly bool TrayEnabled = !IsSwitchOff(Environment.GetEnvironmentVariable("HYACINTH_TRAY"));

    private static bool IsSwitchOff(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var v = raw.Trim();
        return v == "0" || v.Equals("false", StringComparison.OrdinalIgnoreCase);
    }

    private readonly WebView2 _web = new();

    private Process? _backend;
    private bool _spawnedBackend;

    // ── 托盘常驻（TrayEnabled 默认开；HYACINTH_TRAY=0 关闭时不创建）────────
    private NotifyIcon? _tray;
    private ContextMenuStrip? _trayMenu;
    private Icon? _trayIcon;          // LoadAppIcon 返回的是我们**自己拥有**的图标句柄，必须单独释放
    private Icon? _formIcon;          // 窗体/任务栏图标（取 256 大图，Alt-Tab 不糊），同样自持有
    private bool _balloonShown;       // 气泡只弹一次：每次关窗都弹会让人关不掉提示
    private bool _exiting;            // 托盘「退出」已发起 ⇒ FormClosing 不得再拦截

    /// <summary>
    /// 单实例"唤回"消息（RegisterWindowMessage）。第二实例 EnumWindows 找到本窗口后
    /// PostMessage 过来，本实例在 UI 线程的 WndProc 里走 ShowMainWindow() —— 跨实例
    /// 只传消息、不传状态（理由见 Program.TryActivateExisting 的注释）。
    /// </summary>
    internal static readonly uint WmShowMe = RegisterWindowMessage("Hyacinth.ShowMe");

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessage(string name);

    public MainForm()
    {
        Text = "Hyacinth";
        // 应用图标（gen-desktop-icon.cjs 画的紫风信子）：窗体、任务栏、Alt-Tab 都用它。
        // 用 EmbeddedResource 里的 256 大图而不是 Icon 属性缺省值 —— 缺省只吃 exe 的 32px，
        // Alt-Tab / 大任务栏上会被拉糊。caption 左侧的 16px 小图标也来自它（品牌位）。
        _formIcon = LoadAppIcon(256);
        if (_formIcon is not null) Icon = _formIcon;
        // ⚠️ **窗口保持完全标准的系统边框**（2026-10-24 换方案）：不再 FormBorderStyle.None、
        // 不碰 WM_NCCALCSIZE、不留缩放热区带 —— 标题栏外观由 DWM 染色（ShellTheme）实现，
        // 拖拽/缩放/三颗系统按钮/圆角/阴影全部是原生机制。上一版自绘无边框的
        // "蓝标题栏浮出 / 深色热区带"两类问题就出在手工重造 NC 区上，全部退役。
        // BackColor 只在 WebView2 就绪前的一瞬可见，取页面默认主题底色避免白闪。
        BackColor = ShellTheme.Default;
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1080, 680);
        StartPosition = FormStartPosition.CenterScreen;
        // 还原上次的窗口位置/大小（首次启动或状态文件损坏 ⇒ 保持上面的居中默认值）
        RestoreWindowState();

        _web.Dock = DockStyle.Fill;
        Controls.Add(_web);

        // 托盘图标在构造期就挂上（而不是等第一次关窗才建）：这样"开启托盘常驻"这件事
        // 在启动后就可见，用户不会因为看不到图标而怀疑开关没生效。
        if (TrayEnabled) SetupTray();
        // ⚠️ 必须在窗口**已显示**之后再初始化 WebView2。
        // 在 Load 阶段，窗口句柄虽已创建但尚未真正显示 ⇒
        // CreateCoreWebView2ControllerAsync 会直接返回 E_UNEXPECTED（0x8000FFFF「灾难性故障」）。
        Shown += async (_, _) =>
        {
            await Task.Delay(150);   // 让首次呈现完成，避免抢在窗口就绪之前
            await BootAsync();
        };
        FormClosing += OnFormClosing;
        FormClosed += (_, _) => StopBackend();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // 页面还没报色前先用默认主题色（夜园深色）；页面 applyTheme 后由
        // WebMessageReceived 实时校正（含明暗切换）。Win10 上这些 DWM 属性
        // 不存在 ⇒ 静默保持系统默认标题栏（见 ShellTheme）。
        ShellTheme.Apply(Handle, ShellTheme.Default, dark: true);
        // Win11: 圆角；Win10: E_INVALIDARG 静默直角（标准窗口 + DWM 染色下同样适用）
        ShellTheme.TryApplyRoundedCorners(Handle);
    }

    protected override void WndProc(ref Message m)
    {
        if (WmShowMe != 0 && unchecked((uint)m.Msg) == WmShowMe)
        {
            ShowMainWindow();
            return;
        }
        base.WndProc(ref m);
    }

    // ── 托盘常驻（HYACINTH_TRAY=1）──────────────────────────────────────

    /// <summary>
    /// 建托盘图标 + 右键菜单。只有 <see cref="TrayEnabled"/> 为真时才会走到这里。
    /// 菜单按"常驻程序"的常规形态组织：打开主窗口（默认项，加粗）→ 常用动作 → 退出。
    /// </summary>
    private void SetupTray()
    {
        _trayIcon = LoadAppIcon(32);

        _trayMenu = new ContextMenuStrip();
        var showItem = new ToolStripMenuItem("打开主窗口")
        {
            // 默认项：加粗显示，Enter 键触发 —— Windows 托盘菜单的常规约定
            Font = new Font(_trayMenu.Font, FontStyle.Bold),
        };
        showItem.Click += (_, _) => ShowMainWindow();

        var browserItem = new ToolStripMenuItem("在浏览器中打开");
        browserItem.Click += (_, _) =>
        {
            // WebView2 万一被安全软件拦崩（历史实测过），这条是独立于壳窗口的救生通道
            try { Process.Start(new ProcessStartInfo(BaseUrl) { UseShellExecute = true }); }
            catch { /* 打不开就算了，别让异常炸掉托盘线程 */ }
        };

        var logItem = new ToolStripMenuItem("打开日志文件夹");
        logItem.Click += (_, _) =>
        {
            try
            {
                var dir = LogDir();
                Directory.CreateDirectory(dir);   // 首次使用可能还没这个目录
                Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
            }
            catch { /* 同上 */ }
        };

        var exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => ExitFromTray();

        _trayMenu.Items.Add(showItem);
        _trayMenu.Items.Add(browserItem);
        _trayMenu.Items.Add(logItem);
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(exitItem);

        _tray = new NotifyIcon
        {
            Icon = _trayIcon,
            // ⚠️ 托盘悬浮提示有 63 字符上限（NotifyIcon.Text），超长会抛 ArgumentException，
            // 而这个异常发生在构造函数里 ⇒ 壳根本起不来。这里就写死短名字。
            Text = "Hyacinth",
            ContextMenuStrip = _trayMenu,
            Visible = true,
        };
        // 单击 = 还原窗口（Telegram/微信等常驻程序的主流行为）；DoubleClick 保留兜底
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ShowMainWindow();
        };
        _tray.DoubleClick += (_, _) => ShowMainWindow();
    }

    /// <summary>
    /// 取应用图标（优先 EmbeddedResource 里的多尺寸 .ico —— 能按需取到 256 大图；
    /// 取不到退回 exe 自身图标；再不行用系统默认）。宁可图标丑一点，
    /// 也不要因为图标问题让托盘功能整个失效。
    /// </summary>
    private static Icon? LoadAppIcon(int size)
    {
        try
        {
            using var stream = typeof(Program).Assembly.GetManifestResourceStream("app.ico");
            if (stream is not null)
            {
                // Icon(Stream, Size) 会挑 ≤size 的最佳档并按需缩放；
                // 请求尺寸正好对应 ico 里内嵌的一档（32/256），通常无损取用。
                return new Icon(stream, new Size(size, size));
            }
        }
        catch
        {
            // 落到下面的回退
        }
        try
        {
            var exe = Environment.ProcessPath;
            // ProcessPath 在个别宿主/受限环境下可能为 null，直接传给 ExtractAssociatedIcon 会抛
            if (!string.IsNullOrEmpty(exe))
            {
                var icon = Icon.ExtractAssociatedIcon(exe);
                if (icon is not null) return icon;
            }
        }
        catch
        {
            // 忽略：退回默认图标
        }
        // 用拷贝而不是直接返回 SystemIcons.Application —— 后者是**共享实例**，
        // 我们在 Dispose 里会释放图标，释放共享实例会连累同进程其他用到它的地方。
        return new Icon(SystemIcons.Application, SystemIcons.Application.Size);
    }

    /// <summary>显示并激活主窗口（托盘双击 / 菜单「显示主窗口」/ 都走这里）。</summary>
    private void ShowMainWindow()
    {
        // 最小化时必须先还原：直接 Show()+Activate() 的话窗口仍是 Minimized 状态，
        // 用户看到的是"点了没反应，只是任务栏多了一条"。
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        // Hide() 之后 Visible=false，必须显式 Show() 才会重新出现（Activate 不会把隐藏窗口显示出来）
        Show();
        Activate();
    }

    /// <summary>
    /// 托盘菜单「退出」：真正退出并停后端。
    /// 先置 <see cref="_exiting"/> 再 Application.Exit()：Exit 会走 FormClosing，
    /// 那个钩子负责"收进托盘"，不先置位就会被自己的拦截逻辑取消掉 ⇒ 点了「退出」窗口只是
    /// 又一次被藏进托盘，进程永远退不掉（用户只能去任务管理器结束进程树）。
    /// </summary>
    private void ExitFromTray()
    {
        _exiting = true;
        // 显式停一次，不把"停后端"完全押在 FormClosed 上：即使后续关闭流程被外部取消，
        // 也不能留下一个没人管的 node 子进程占着 3130 端口。
        StopBackend();
        Application.Exit();
    }

    /// <summary>
    /// 关窗拦截。
    /// 只有 **用户点窗口那个 ×**（<see cref="CloseReason.UserClosing"/>）且开了托盘常驻时才拦。
    /// 其他原因一律放行，否则会出真实事故：
    ///  - <see cref="CloseReason.WindowsShutDown"/>：关机/注销时拒绝关闭 ⇒ 系统卡在"正在关机"，
    ///    最后被强制杀掉，后端子进程变孤儿继续占端口。
    ///  - <see cref="CloseReason.TaskManagerClosing"/>：任务管理器"结束任务"被无视 ⇒
    ///    用户以为杀不掉，只能去结束进程树（体验更差，且同样留孤儿后端）。
    ///  - <see cref="CloseReason.ApplicationExitCall"/>：我们自己调 Application.Exit()，
    ///    拦它等于托盘「退出」永远无效。
    ///  - 其余（MdiFormClosing / None 等）：都不是"用户在关窗"，不该转成隐藏。
    /// </summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // 状态照旧保存：无论这次是隐藏还是真退出，当前尺寸都不该丢
        SaveWindowState();

        // 诊断日志（托盘拦截没生效时第一时间看这里）：reason 是否 UserClosing、
        // TrayEnabled 是否为真、托盘图标是否已创建。定位完成后保留 —— 它是
        // "关窗行为分叉"的唯一直接证据，后续排查同类问题省一次重建。
        try
        {
            File.AppendAllText(Path.Combine(LogDir(), "shell-close.log"),
                $"[{DateTime.Now:O}] close reason={e.CloseReason} cancel={e.Cancel} trayEnabled={TrayEnabled} exiting={_exiting} trayIcon={_tray is not null}\n");
        }
        catch { /* 诊断日志写不进去不阻断关闭 */ }

        if (!TrayEnabled || _exiting) return;
        if (e.CloseReason != CloseReason.UserClosing) return;

        e.Cancel = true;   // 取消真正的关闭
        Hide();            // 窗口消失，任务栏条目一并消失；后端/WebView2 保持存活
        ShowFirstTrayBalloon();
    }

    /// <summary>
    /// 首次收进托盘时提示一次。只在第一次弹：每次关窗都弹气泡等于噪音，
    /// 用户会想"怎么才能不让它弹"，而不是"原来它还在跑"。
    /// </summary>
    private void ShowFirstTrayBalloon()
    {
        if (_tray is null || _balloonShown) return;
        _balloonShown = true;
        _tray.BalloonTipTitle = "Hyacinth 仍在后台运行";
        _tray.BalloonTipText = "单击托盘图标可重新打开窗口；右键菜单 → 退出 才会真正结束进程。";
        _tray.BalloonTipIcon = ToolTipIcon.Info;
        _tray.ShowBalloonTip(4000);
    }

    /// <summary>
    /// ⚠️ **WinForms 托盘第一大坑**：NotifyIcon 不是窗体控件、不在 Controls 集合里，
    /// Form.Dispose 不会顺手收掉它。少写 Visible=false + Dispose() ⇒ 进程已经退出，
    /// 托盘区却还留着一个**死图标**：鼠标划过才消失，点它毫无反应，用户只能重启 explorer.exe。
    /// 这里必须自己收，顺序也是固定的：先 Visible=false 让它从托盘区摘掉，再 Dispose 释放句柄。
    /// </summary>
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (_tray is not null)
            {
                _tray.Visible = false;
                _tray.Dispose();
                _tray = null;
            }
            // NotifyIcon.Dispose 不会连带释放菜单，菜单也得自己收
            _trayMenu?.Dispose();
            _trayMenu = null;
            _trayIcon?.Dispose();
            _trayIcon = null;
            _formIcon?.Dispose();
            _formIcon = null;
        }
        base.Dispose(disposing);
    }

    // ── 窗口状态持久化 ─────────────────────────────────────────────────

    /// <summary>
    /// 窗口状态文件。放 LocalAppData 而不是 exe 旁边：绿色包可能落在只读目录（U 盘 / Program Files）。
    /// </summary>
    private static string WindowStateFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Hyacinth",
        "window.json");

    private sealed class WindowStateDto
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Maximized { get; set; }
    }

    private void RestoreWindowState()
    {
        try
        {
            if (!File.Exists(WindowStateFile)) return;
            var s = JsonSerializer.Deserialize<WindowStateDto>(File.ReadAllText(WindowStateFile));
            if (s is null) return;

            var w = Math.Max(MinimumSize.Width, s.Width);
            var h = Math.Max(MinimumSize.Height, s.Height);
            var rect = new Rectangle(s.X, s.Y, w, h);

            // ⚠️ 必须做可见性校验：拔掉外接显示器 / 改了分辨率之后，旧坐标可能整块在屏幕外，
            // 直接套用会让窗口"启动后看不见"（任务栏有、点不出来）——这是最常见的还原事故。
            var visible = Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(rect));
            if (!visible) return;

            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (s.Maximized) WindowState = FormWindowState.Maximized;
        }
        catch
        {
            // 状态文件损坏/半截写入 ⇒ 用默认值启动，绝不因为"记不住窗口大小"而打不开
        }
    }

    private void SaveWindowState()
    {
        try
        {
            // 最大化时 Bounds 是屏幕尺寸；下次还原要先还原成普通尺寸再最大化，否则会丢掉原尺寸
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var dir = Path.GetDirectoryName(WindowStateFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(WindowStateFile, JsonSerializer.Serialize(new WindowStateDto
            {
                X = b.X,
                Y = b.Y,
                Width = b.Width,
                Height = b.Height,
                Maximized = WindowState == FormWindowState.Maximized,
            }));
        }
        catch
        {
            // 写不进去（权限/磁盘满）不影响退出
        }
    }

    // ── 形态解析（绿色包 / 开发形态）────────────────────────────────────

    /// <summary>绿色包形态：exe 同级的 <c>app\</c>（内含 dist / node_modules / plugins）</summary>
    private static string? BundledAppRoot()
    {
        var p = Path.Combine(ExeDir, "app");
        return File.Exists(Path.Combine(p, "dist", "index.js")) ? p : null;
    }

    /// <summary>
    /// 开发形态：仓库根（后端 dist 所在）。
    /// 优先级：<c>HYACINTH_ROOT</c> → 从 exe 目录往上找含 <c>dist\index.js</c> 的祖先
    /// （壳构建在 <c>desktop/native-shell/{out,bin/…}</c> 下面，故最多上溯 6 层）→ 当前目录。
    /// </summary>
    private static string ResolveRepoRoot()
    {
        var fromEnv = Environment.GetEnvironmentVariable("HYACINTH_ROOT");
        if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv)) return fromEnv;

        var dir = new DirectoryInfo(ExeDir);
        for (var i = 0; i < 6 && dir is not null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "dist", "index.js"))) return dir.FullName;
        }
        return Directory.GetCurrentDirectory();
    }

    /// <summary>后端应用根（绿色包优先）</summary>
    private static string AppRoot => BundledAppRoot() ?? ResolveRepoRoot();

    /// <summary>
    /// 日志目录：绿色包写 exe 同级 <c>logs\</c>；开发形态写仓库 <c>outputs\gui-probe\</c>；
    /// 都不可写时退到 <c>%TEMP%\hyacinth-shell-logs</c>。
    /// （2026-10-16 教训：日志路径原先写死在仓库里 ⇒ 绿色包里必然写失败、且弹窗也读不到详情。）
    /// </summary>
    private static string LogDir()
    {
        var prefer = BundledAppRoot() is not null
            ? Path.Combine(ExeDir, "logs")
            : Path.Combine(ResolveRepoRoot(), "outputs", "gui-probe");
        try
        {
            Directory.CreateDirectory(prefer);
            return prefer;
        }
        catch
        {
            var fallback = Path.Combine(Path.GetTempPath(), "hyacinth-shell-logs");
            try { Directory.CreateDirectory(fallback); } catch { /* 尽力而为 */ }
            return fallback;
        }
    }

    /// <summary>后端是否已在监听（避免重复拉起）</summary>
    private static async Task<bool> HealthAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            var r = await http.GetAsync($"{BaseUrl}/api/health");
            return r.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 解析 node 可执行文件。
    /// ⚠️ **不能只依赖 PATH**：桌面壳是 GUI 进程，其 PATH 未必包含 node
    /// （本机 node 装在 F:\Node，而 GUI 进程拿到的环境可能与登录 shell 不同）。
    /// 优先级：**绿色包自带的 runtime\node.exe** → HYACINTH_NODE 环境变量 →
    /// 常见安装路径 → 退回 "node"（交给 PATH）。
    /// </summary>
    private static string ResolveNode()
    {
        var bundled = Path.Combine(ExeDir, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;

        var fromEnv = Environment.GetEnvironmentVariable("HYACINTH_NODE");
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv)) return fromEnv;

        foreach (var candidate in new[] { @"F:\Node\node.exe", @"C:\Program Files\nodejs\node.exe" })
        {
            if (File.Exists(candidate)) return candidate;
        }
        return "node";
    }

    /// <summary>
    /// 选择 WebView2 运行时目录。
    /// 本机同时存在 154.0.4258.62 与 155.0.4283.45 两份，而 **155 的浏览器进程会崩在
    /// msedge_elf.dll**（WER: APPCRASH，2026-10-16 实测），导致控制器创建失败。
    /// 故按版本**升序**取（先 154），并允许用 HYACINTH_WEBVIEW2_RUNTIME 显式覆盖；
    /// 取不到则回 null（交给系统默认解析）。
    /// </summary>
    private static string? ResolveBrowserRuntime()
    {
        var fromEnv = Environment.GetEnvironmentVariable("HYACINTH_WEBVIEW2_RUNTIME");
        if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv)) return fromEnv;

        var root = @"C:\Program Files (x86)\Microsoft\EdgeWebView\Application";
        if (!Directory.Exists(root)) return null;

        var byVersion = Directory.GetDirectories(root)
            .Select(d => new { Path = d, Name = System.IO.Path.GetFileName(d) })
            .Where(x => Version.TryParse(x.Name, out _))
            .OrderBy(x => Version.Parse(x.Name))
            .ToList();

        foreach (var cand in byVersion)
        {
            if (File.Exists(System.IO.Path.Combine(cand.Path, "msedgewebview2.exe"))) return cand.Path;
        }
        return null;
    }

    /// <summary>
    /// 传给 WebView2 内嵌浏览器进程的开关。
    /// 关键的一条是 **`--remote-debugging-port`**：否则壳内部是一片黑盒 ——
    /// 页面 console 报错、WS 为什么连不上，从外面（后端日志 / 进程状态 / 截屏）全都看不出来
    /// （2026-10-16 排查"离线"时踩到）。端口可用 HYACINTH_WEBVIEW2_DEBUG_PORT 覆盖，
    /// 设 0 则不开（默认 9222，只监听本机回环）。
    /// </summary>
    private static string BuildBrowserArgs()
    {
        var args = "--no-sandbox --disable-breakpad --disable-crash-reporter";
        var raw = Environment.GetEnvironmentVariable("HYACINTH_WEBVIEW2_DEBUG_PORT");
        var port = int.TryParse(raw, out var p) ? p : 9222;
        if (port > 0) args += $" --remote-debugging-port={port}";
        return args;
    }

    private async Task<bool> EnsureBackendAsync()
    {
        if (await HealthAsync())
        {
            Debug.WriteLine($"[shell] 端口 {Port} 已有服务，直接复用");
            return true;
        }

        var root = AppRoot;
        var entry = Path.Combine(root, "dist", "index.js");
        if (!File.Exists(entry))
            throw new FileNotFoundException(
                $"找不到后端入口：{entry}\n" +
                "绿色包请确认 exe 旁边有 app\\dist\\index.js；开发形态请先在仓库里执行 pnpm run build。");

        var nodePath = ResolveNode();
        Debug.WriteLine($"[shell] appRoot={root}  node={nodePath}");
        var psi = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // 抑制后端"自动打开系统浏览器"：桌面壳本身已经是那个 UI，
        // 再弹一个浏览器只会打扰用户（2026-10-16 用户实报："每次启动额外打开一个浏览器"）。
        psi.Environment["HYACINTH_NO_OPEN_BROWSER"] = "1";

        // provider 可用 HYACINTH_PROVIDER 覆盖（默认 deepseek）：
        // 不带 --provider 时后端会落回 config 里的 anthropic，而环境没配 key ⇒ 启动即崩。
        var provider = Environment.GetEnvironmentVariable("HYACINTH_PROVIDER");
        if (string.IsNullOrWhiteSpace(provider)) provider = "deepseek";

        foreach (var a in new[] { entry, "webui", "--port", Port.ToString(), "--provider", provider, "--no-auth" })
            psi.ArgumentList.Add(a);

        _backend = Process.Start(psi);
        _spawnedBackend = true;

        // 必须**主动排空**子进程输出（RedirectStandardOutput=true 却不读，管道缓冲区写满后
        // 子进程会阻塞在写日志上 ⇒ 永远进不了监听态）。同时**落盘**，否则排空=丢弃，
        // 后端起不来时完全没有可诊断信息（2026-10-16 踩过）。
        var backendLog = Path.Combine(LogDir(), "shell-backend.log");
        void AppendBackendLine(string? line)
        {
            if (line is null) return;
            try { File.AppendAllText(backendLog, line + Environment.NewLine); } catch { /* 忽略 */ }
        }
        _backend.OutputDataReceived += (_, e) => AppendBackendLine(e.Data);
        _backend.ErrorDataReceived += (_, e) => AppendBackendLine(e.Data);
        _backend.BeginOutputReadLine();
        _backend.BeginErrorReadLine();
        Debug.WriteLine($"[shell] 已拉起后端 pid={_backend?.Id}");

        var deadline = DateTime.UtcNow.AddSeconds(45);
        while (DateTime.UtcNow < deadline)
        {
            if (await HealthAsync()) return true;
            await Task.Delay(400);
        }
        throw new TimeoutException(
            $"后端 45 秒内未就绪（检查 app\\dist 是否已构建、provider「{provider}」是否可用；" +
            $"后端日志：{backendLog}）");
    }

    /// <summary>
    /// WebView2 用户数据目录（存 localStorage / 缓存 / 权限）。
    ///
    /// ⚠️ **绝不要用 `%TEMP%`**（2026-10-16 实测，代价是三轮排查）：
    ///   本机**火绒**会限制"新出现的未知 exe"访问 `%TEMP%`，表现为 WebView2 控制器创建
    ///   直接报 `0x800700AA`（ERROR_BUSY）—— 而**同一个 exe 只把 profile 换个目录就正常**。
    ///   佐证：同一天这个 exe 在 `%TEMP%` 里连 `Application.EnableVisualStyles()` 的清单文件
    ///   都被拒（`UnauthorizedAccessException` / `Failed to create ... error code: 5`）。
    ///   附带好处：profile 不再躺在 temp 里被磁盘清理顺手删掉（主题/登录态会丢）。
    ///
    /// 优先级：`HYACINTH_WEBVIEW2_USER_DATA` → `%LOCALAPPDATA%\Hyacinth\WebView2`（持久）
    ///   → exe 同级 `webview2\`（绿色包自带）→ 最后才退回 `%TEMP%`。
    /// </summary>
    private static string ResolveUserDataDir()
    {
        var fromEnv = Environment.GetEnvironmentVariable("HYACINTH_WEBVIEW2_USER_DATA");
        if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv;

        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hyacinth", "WebView2"),
            Path.Combine(ExeDir, "webview2"),
            Path.Combine(Path.GetTempPath(), "hyacinth-webview2"),
        };
        foreach (var c in candidates)
        {
            try { Directory.CreateDirectory(c); return c; }
            catch { /* 换下一个可用目录 */ }
        }
        return Path.Combine(Path.GetTempPath(), "hyacinth-webview2");
    }

    private async Task BootAsync()
    {
        try
        {
            var userData = ResolveUserDataDir();

            // 诊断用开关：本机 Electron 与 WebView2 同属"嵌入式 Chromium"、两者都起不来，
            // 而**系统 Chrome 正常** ⇒ 优先怀疑沙箱 / 崩溃上报器（crashpad）被安全软件拦截。
            // 先关掉这两者验证（Electron 侧的日志同样只有 crashpad "not connected"）。
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = BuildBrowserArgs(),
            };
            var env = await CoreWebView2Environment.CreateAsync(ResolveBrowserRuntime(), userData, options);
            await _web.EnsureCoreWebView2Async(env);

            // 外链交给系统浏览器，别把应用窗口当浏览器使
            _web.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { /* 忽略 */ }
            };
            // 页面在 applyTheme 时把顶栏底色与明暗报上来（webui 的 notifyShellTheme），
            // 壳把系统标题栏染成同一颜色 —— caption 与页面顶栏融为一体，系统按钮
            // 深浅跟随主题。⚠️ 页面 postMessage 的是**字符串**（JSON.stringify 过的
            // 消息），取 TryGetWebMessageAsString 拿原文再 Parse；WebMessageAsJson 是
            // 给字符串再包一层引号的形态，直接当对象解析拿不到字段（实测踩过）。
            _web.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                try
                {
                    var raw = e.TryGetWebMessageAsString();
                    using var doc = JsonDocument.Parse(raw);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("type", out var t) && t.GetString() == "hyacinth-theme"
                        && root.TryGetProperty("background", out var bg)
                        && bg.GetString() is { } css
                        && TryParseCssColor(css, out var color))
                    {
                        var dark = !root.TryGetProperty("dark", out var d) || d.ValueKind != JsonValueKind.False;
                        ShellTheme.Apply(Handle, color, dark);
                    }
                }
                catch { /* 页面消息异常 / 非字符串消息：不影响壳 */ }
            };
            _web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            // 悬停链接时左下角出现的地址预览条（"127.0.0.1:3130/#/model" 之类）：
            // 那是浏览器状态栏 UI，桌面壳里页面导航全是站内 hash 路由，这条预览
            // 只会暴露内部地址、没有半点用处（2026-10-24 用户要求去掉）。
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;

            // 麦克风权限（语音输入，stt 契约域）：WebView2 默认对所有权限请求弹
            // 系统级对话框或直接拒绝；这里放行 **仅限本机 origin** 的 AudioCapture
            // —— 语音只在内存转写（本地模型），不落盘不上传，自动同意没有泄密面。
            // 其余权限种类维持默认行为（不拦截不加白）。
            _web.CoreWebView2.PermissionRequested += (_, e) =>
            {
                if (e.Kind != CoreWebView2PermissionKind.AudioCapture) return;
                try
                {
                    var origin = new Uri(e.Uri);
                    var host = origin.Host;
                    if (host is "127.0.0.1" or "localhost" or "::1")
                    {
                        e.Handled = true;
                        e.State = CoreWebView2PermissionState.Allow;
                    }
                }
                catch { /* origin 解析失败：维持默认行为 */ }
            };

            await EnsureBackendAsync();
            _web.Source = new Uri(BaseUrl);
        }
        catch (Exception ex)
        {
            // 关键：把**完整异常**落盘 —— 只弹 MessageBox 会把诊断信息丢在屏幕上。
            // 日志目录按形态解析（绿色包 → exe 同级 logs\；见 LogDir），绝不写死本机路径。
            var logPath = Path.Combine(LogDir(), "shell-error.log");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                File.AppendAllText(logPath, $"[{DateTime.Now:O}] {ex}\n\n");
            }
            catch { /* 写日志失败也要继续弹窗 */ }
            MessageBox.Show("启动失败：" + ex.Message + "\n\n详情已写入：\n" + logPath,
                "Hyacinth", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>css 颜色（rgb()/rgba()/color(srgb …) 形式）→ Color。解析失败 / 全透明返回 false。</summary>
    private static bool TryParseCssColor(string css, out Color color)
    {
        color = default;
        if (string.IsNullOrWhiteSpace(css)) return false;
        // #rgb / #rrggbb（页面如果直接发主题变量值）
        if (css[0] == '#')
        {
            var hex = css.Substring(1);
            if (hex.Length == 3) hex = string.Concat(hex.Select(c => $"{c}{c}"));
            if (hex.Length == 6
                && byte.TryParse(hex.AsSpan(0, 2), System.Globalization.NumberStyles.HexNumber, null, out var hr_)
                && byte.TryParse(hex.AsSpan(2, 2), System.Globalization.NumberStyles.HexNumber, null, out var hg_)
                && byte.TryParse(hex.AsSpan(4, 2), System.Globalization.NumberStyles.HexNumber, null, out var hb_))
            {
                color = Color.FromArgb(hr_, hg_, hb_);
                return true;
            }
            return false;
        }
        // Chromium 对 color-mix()/相对色语法的 computed 值可能是 color(srgb r g b)（0~1 浮点）
        if (css.StartsWith("color(srgb", StringComparison.OrdinalIgnoreCase))
        {
            var nums = css.Split('(', ')', ',', ' ').Where(s => double.TryParse(s, out _)).ToArray();
            if (nums.Length >= 3)
            {
                color = Color.FromArgb(
                    (int)Math.Clamp(double.Parse(nums[0]) * 255, 0, 255),
                    (int)Math.Clamp(double.Parse(nums[1]) * 255, 0, 255),
                    (int)Math.Clamp(double.Parse(nums[2]) * 255, 0, 255));
                return true;
            }
            return false;
        }
        var rgb = css.Split('(', ')', ',');
        if (rgb.Length < 5 || !css.StartsWith("rgb", StringComparison.OrdinalIgnoreCase)) return false;
        if (!byte.TryParse(rgb[1].Trim(), out var r)) return false;
        if (!byte.TryParse(rgb[2].Trim(), out var g)) return false;
        if (!byte.TryParse(rgb[3].Trim(), out var b)) return false;
        if (css.StartsWith("rgba", StringComparison.OrdinalIgnoreCase)
            && float.TryParse(rgb[4].Trim(), out var a) && a < 0.05f)
        {
            return false;   // 全透明（元素无背景时）不采纳
        }
        color = Color.FromArgb(r, g, b);
        return true;
    }

    private void StopBackend()
    {
        if (!_spawnedBackend || _backend is null) return;
        try
        {
            if (!_backend.HasExited) _backend.Kill(entireProcessTree: true);
        }
        catch { /* 关窗时尽力而为 */ }
    }
}
