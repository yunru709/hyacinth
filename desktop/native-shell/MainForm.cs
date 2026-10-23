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
///  6) **托盘常驻是可选能力，默认关闭**（2026-10-23 加）：未设置 `HYACINTH_TRAY=1` 时，
///     关窗 = 退出进程 + 停后端，与加托盘之前**完全一致**；只有显式开启才变成"关窗收进托盘、
///     后端继续跑"。默认值必须保守 —— 托盘常驻会让用户在"以为已经退出"的情况下继续被
///     后端占用端口/内存，这个语义变更不能悄悄发生。
///  7) **开关用环境变量而不是设置项**：壳没有自己的设置界面（也就没有"设置"这个概念），
///     要做设置项就得先引入一层配置持久化（文件格式 / 读写 / 迁移 / 并发写 / 损坏回退），
///     成本与"一个布尔开关"的收益完全不匹配。环境变量与既有的 `HYACINTH_PORT`、
///     `HYACINTH_WEBVIEW2_USER_DATA` 同一风格，改一次、用完即弃，不污染用户目录。
///  8) **窗口是自绘的无边框窗体**（2026-10-23 改）：系统标题栏在深色页面上是一条浅灰带，
///     颜色还由用户的 DWM 主题决定、盖不住，所以关掉它、自己画一条 44 逻辑像素的
///     （品牌 + 三个按钮，见 TitleBar.cs）。
///     ⚠️ **别把 `CreateParams` 里那三个样式位当成冗余删掉**：光 `None` 会把 DWM 阴影和
///     系统级边缘热区一起丢掉，窗口退化成一块没阴影的硬边方块 —— 这是这类改造最常见的翻车点。
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
    /// 托盘常驻开关：<c>HYACINTH_TRAY=1</c>（也接受 <c>true</c>）。
    /// **默认 false** ⇒ 关窗即退出 + 停后端，行为与加托盘之前逐字一致（见类注释第 6 条）。
    /// 只认显式开启：拼错/写成 "yes" 一律当关闭 —— 宁可用户发现"没生效"，
    /// 也不要因为一个手滑的值让进程在后台常驻。
    /// </summary>
    private static readonly bool TrayEnabled = IsSwitchOn(Environment.GetEnvironmentVariable("HYACINTH_TRAY"));

    private static bool IsSwitchOn(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var v = raw.Trim();
        return v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    private readonly WebView2 _web = new();

    /// <summary>自绘标题栏（无系统标题栏，见 <see cref="CreateParams"/> 与 TitleBar.cs）</summary>
    private readonly TitleBar _titleBar;

    /// <summary>内容容器：唯一职责是给四周让出缩放热区（见 ShellFrame.ResizeBorderLogical）</summary>
    private readonly FrameAwarePanel _content;

    private Process? _backend;
    private bool _spawnedBackend;

    // ── 托盘常驻（仅 TrayEnabled 时创建，其余时候保持 null）────────────────
    private NotifyIcon? _tray;
    private ContextMenuStrip? _trayMenu;
    private Icon? _trayIcon;          // ExtractAssociatedIcon 返回的是我们**自己拥有**的图标句柄，必须单独释放
    private bool _balloonShown;       // 气泡只弹一次：每次关窗都弹会让人关不掉提示
    private bool _exiting;            // 托盘「退出」已发起 ⇒ FormClosing 不得再拦截

    public MainForm()
    {
        Text = "Hyacinth";
        // 自绘标题栏 ⇒ 不要系统标题栏。但**不能只写这一行**：None 会连窗口的
        // 尺寸边框和阴影一起拿掉（见 CreateParams 里的三个样式位）。
        FormBorderStyle = FormBorderStyle.None;
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1080, 680);
        StartPosition = FormStartPosition.CenterScreen;
        // 与 WebUI 的 --neutral-0 同色：标题栏、缩放热区、页面三者之间不会出现灰边
        BackColor = Color.FromArgb(0x0A, 0x0B, 0x14);
        // 还原上次的窗口位置/大小（首次启动或状态文件损坏 ⇒ 保持上面的居中默认值）
        RestoreWindowState();

        // 内容层比窗口小一圈（左右下各 4 逻辑像素）：那一圈是**窗体自己的表面**，
        // 边缘拉伸的 WM_NCHITTEST 才收得到 —— WebView2 的浏览器子窗口会把边缘的
        // 鼠标消息直接吞进 Chromium，铺满就拉不动。上沿不让，标题栏紧贴页面。
        _content = new FrameAwarePanel
        {
            Dock = DockStyle.Fill,
            BackColor = BackColor,
            ResizeBandLogical = ShellFrame.ResizeBorderLogical,
        };
        _web.Dock = DockStyle.Fill;
        _content.Controls.Add(_web);

        _titleBar = new TitleBar(this) { Dock = DockStyle.Top };

        // ⚠️ 加的顺序不能反。WinForms 的 Dock 排布是**从 z-order 末尾往前**做的
        // （最后加入的那个先占边），所以 Fill 必须先加、Top 后加；反过来 Fill 会把
        // 标题栏整条盖住（探针实测 800×600 的窗体：fill 拿到 {0,0,784,561}，标题栏被压住）。
        Controls.Add(_content);
        Controls.Add(_titleBar);

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

    // ── 无边框窗口（自绘标题栏 / 阴影 / 圆角 / 边缘拉伸）─────────────────

    /// <summary>
    /// 无边框窗口的样式位。
    ///
    /// ⚠️ **只设 <c>FormBorderStyle.None</c> 是一块硬边方块**：窗口既没有 DWM 阴影，
    /// 也没有系统级边缘拖拽热区（只能靠自己在 MouseMove 里算，拖出屏幕就抖）。
    /// 关键在把下面这三个位补回去：
    ///  - <c>WS_THICKFRAME</c>(0x00040000)：告诉 DWM「这是个有尺寸边框的窗口」⇒ 阴影和
    ///    圆角/贴边动画都回来了；同时它也是 DefWindowProc 认定「窗口可缩放」的依据；
    ///  - <c>WS_MINIMIZEBOX</c>(0x00020000) / <c>WS_MAXIMIZEBOX</c>(0x00010000)：
    ///    系统是按样式位判断「这个窗口能不能最小化/最大化」的（任务栏右键菜单、
    ///    Win+↑、贴边分屏都走这套判断）。缺了它们，程序里设 WindowState 仍然有效，
    ///    但系统提供的那几个入口会变成灰的/点了没反应。
    ///
    /// 不加 <c>WS_CAPTION</c>：那会把系统标题栏画回来，等于白改；
    /// 也不加 <c>WS_SYSMENU</c>：它带来的系统菜单（Alt+Space）里"移动/大小"在
    /// 无 NC 区的窗口上行为很怪，而"关闭"我们已经自己画了。
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_THICKFRAME = 0x00040000;
            const int WS_MINIMIZEBOX = 0x00020000;
            const int WS_MAXIMIZEBOX = 0x00010000;

            var cp = base.CreateParams;
            cp.Style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Win11: 圆角；Win10: 调用返回 E_INVALIDARG，静默降级成直角（不会抛，见 ShellFrame）
        ShellFrame.TryApplyRoundedCorners(Handle);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case ShellFrame.WM_NCCALCSIZE when m.WParam != IntPtr.Zero:
                // 把客户区强行撑成整个窗口矩形：不这么做的话，WS_THICKFRAME 会让
                // DefWindowProc 在窗口里留一圈非客户区（约 8px 的尺寸边框）。
                // 那一圈既没人绘制（我们没有标题栏可画），又会把内容整体往里挤 ——
                // 表现就是"页面四周有一圈黑边、点不到真正的窗口边缘"。
                // wParam=TRUE 时 lParam 里 rgrc[0] 已经是新的窗口矩形，原样留着就是
                // 「客户区 = 窗口」，返回 0 表示这块区域需要全部重画。
                m.Result = IntPtr.Zero;
                return;

            case ShellFrame.WM_NCHITTEST:
                // 客户区被标题栏/内容控件盖着，正常收不到这个位置的消息；
                // 这里兜住「窗体自己露出来的像素」（理论上不应有，但别指望布局永远完美）。
                var hit = ShellFrame.HitTest(this, ShellFrame.ScreenPointFromLParam(m.LParam));
                if (hit != ShellFrame.HTCLIENT)
                {
                    m.Result = (IntPtr)hit;
                    return;
                }
                break;

            case ShellFrame.WM_GETMINMAXINFO:
                // 先让 WinForms 填好（它会把 MinimumSize 写进 ptMinTrackSize），
                // 再只纠正最大化的尺寸/位置 —— 否则最大化后内容会顶出屏幕、盖住任务栏。
                base.WndProc(ref m);
                ShellFrame.ClampMaximizedBounds(Handle, m.LParam);
                return;
        }
        base.WndProc(ref m);
    }

    // ── 托盘常驻（HYACINTH_TRAY=1）──────────────────────────────────────

    /// <summary>
    /// 建托盘图标 + 右键菜单。只有 <see cref="TrayEnabled"/> 为真时才会走到这里。
    /// 图标复用 exe 自身图标：绿色包被用户换了图标/放在 U 盘上也认得出是同一个程序，
    /// 不用再塞一份 .ico 进产物（少一个"忘了带资源文件"的失败点）。
    /// </summary>
    private void SetupTray()
    {
        _trayIcon = LoadTrayIcon();

        _trayMenu = new ContextMenuStrip();
        var showItem = new ToolStripMenuItem("显示主窗口");
        showItem.Click += (_, _) => ShowMainWindow();
        var exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => ExitFromTray();
        _trayMenu.Items.Add(showItem);
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
        // 双击 = 还原窗口，这是 Windows 托盘图标的默认期待行为，不做会被当成卡死
        _tray.DoubleClick += (_, _) => ShowMainWindow();
    }

    /// <summary>
    /// 取 exe 自带图标。取不到（exe 无图标资源 / 路径被裁掉）就退回系统默认图标：
    /// 宁可图标丑一点，也不要因为图标问题让托盘功能整个失效。
    /// </summary>
    private static Icon LoadTrayIcon()
    {
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
        _tray.BalloonTipText = "双击托盘图标可重新打开窗口；右键 → 退出 才会真正结束进程。";
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
            _web.CoreWebView2.Settings.AreDevToolsEnabled = true;

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
