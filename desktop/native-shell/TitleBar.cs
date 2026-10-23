using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace native_shell;

/// <summary>
/// 无边框窗口里的「窗体表面」基类。存在的唯一理由：**边缘拉伸的热区必须是窗体自己的像素**。
///
/// 踩过的坑（别把这些消息搬走）：
///  - 命中测试（WM_NCHITTEST）是发给「光标底下那个窗口」的，而 WinForms 里我们的客户区
///    被一组子控件盖住了：标题栏 Panel、内容 Panel、以及 WebView2 内部那个
///    <c>Chrome_WidgetWin</c> 子窗口。子控件自己回 HTCLIENT ⇒ 窗体**永远收不到**边缘上的
///    WM_NCHITTEST ⇒ 四边/四角拉不动（最大化后更明显：连还原都只能靠按钮）。
///    所以派生类在这里把 WM_NCHITTEST 转给 <see cref="ShellFrame.HitTest"/>，命中边缘就
///    直接把 HTLEFT/HTTOP… 当结果返回 —— 消息本该由窗体处理，返回码同样有效。
///  - WebView2 的浏览器子窗口根本不吃我们这一套（消息直接进 Chromium 输入管线，连
///    DefWindowProc 都轮不到），所以内容区四周还要靠 <see cref="DisplayRectangle"/> 让出一条
///    热区，见 <see cref="ShellFrame.ResizeBorderLogical"/> 的注释。
/// </summary>
internal class FrameAwarePanel : Panel
{
    /// <summary>
    /// 四周给缩放热区让出的宽度（逻辑像素），0 = 铺满。
    /// 用字段而不是属性：WinForms 分析器（WFO1000）会要求每个自定义属性声明设计器序列化方式，
    /// 而这个值纯运行期决定、从不进 .designer.cs，没必要为它引入特性。
    /// </summary>
    internal int ResizeBandLogical;

    /// <summary>
    /// 让 Dock=Fill 的子控件避开四周热区。
    /// 用 DisplayRectangle 而不是 Padding：Padding 存的是**设备像素**且不会跟着 DPI 变化，
    /// 换显示器（100% ↔ 150%）后要么热区变窄、要么多切一刀内容；DisplayRectangle 每次布局
    /// 都按当前 DeviceDpi 现算，不用监听 DPI 事件。
    /// </summary>
    public override Rectangle DisplayRectangle
    {
        get
        {
            var r = base.DisplayRectangle;
            if (ResizeBandLogical <= 0) return r;
            var band = LogicalToDeviceUnits(ResizeBandLogical);
            // 上沿不让：缩放热区只影响左右下三边，避免和上面那条自绘标题栏抢像素
            return Rectangle.FromLTRB(r.Left + band, r.Top, r.Right - band, r.Bottom - band);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == ShellFrame.WM_NCHITTEST)
        {
            var code = ShellFrame.HitTest(FindForm(), ShellFrame.ScreenPointFromLParam(m.LParam));
            if (code != ShellFrame.HTCLIENT)
            {
                m.Result = (IntPtr)code;
                return;
            }
        }
        base.WndProc(ref m);
    }
}

/// <summary>
/// 自绘标题栏：左侧品牌（六边形 + Hyacinth），中间整条是拖拽区，右侧最小化/最大化/关闭。
///
/// 为什么整条都自己画：
///  - 系统标题栏在深色页面上是一条突兀的浅灰带，且 Win11/Win10 的主题色由用户决定，
///    和 WebUI「夜园」配色永远对不上；
///  - 图标全用 <see cref="Graphics"/> 画而不是字符：×/□ 这类字符的基线取决于字体回退，
///    换个 DPI 档位（125% / 150%）或换台机器就可能偏一两像素，细笔画还会被 ClearType
///    染上彩色边。矢量画法在任何 DPI 下都是同一个形状。
/// </summary>
internal sealed class TitleBar : FrameAwarePanel
{
    /// <summary>标题栏高度（逻辑像素）。和 Win11 原生标题栏一致，视觉上不会突然变厚。</summary>
    internal const int LogicalHeight = 44;

    private const int ButtonWidthLogical = 40;   // 40×44，和系统 caption 按钮同量级
    private const int BrandLeftLogical = 14;
    private const int BrandIconLogical = 18;
    private const int BrandGapLogical = 9;
    private const int BrandFontLogical = 13;     // 以**像素**为单位，避免 pt→px 受 DC DPI 影响
    private const int GlyphLogical = 10;         // 按钮图标的绘制画布

    private const int BtnMin = 0;
    private const int BtnMax = 1;
    private const int BtnClose = 2;

    // 配色取自 WebUI 的 theme.css（--neutral-0 / --neutral-900 / --primary-500），
    // 保证窗口边框、标题栏、页面三者是同一套色，不会出现"灰边"。
    private static readonly Color Backdrop = Color.FromArgb(0x0A, 0x0B, 0x14);
    private static readonly Color BrandText = Color.FromArgb(0xEC, 0xEE, 0xFA);
    private static readonly Color BrandAccent = Color.FromArgb(0xA7, 0x8B, 0xFA);
    private static readonly Color GlyphIdle = Color.FromArgb(0xC9, 0xCB, 0xD3);
    private static readonly Color GlyphHot = Color.FromArgb(0xFF, 0xFF, 0xFF);
    private static readonly Color ButtonHover = Color.FromArgb(0x20, 0x24, 0x38);
    private static readonly Color ButtonPressed = Color.FromArgb(0x2C, 0x31, 0x4A);
    private static readonly Color CloseHover = Color.FromArgb(0xC4, 0x2B, 0x1C);    // Windows 11 关闭键红
    private static readonly Color ClosePressed = Color.FromArgb(0xA8, 0x25, 0x18);

    private readonly Form _owner;
    private int _hover = -1;
    private int _pressed = -1;
    private Font? _brandFont;
    private int _brandFontDpi;

    // 自己判双击（阈值直接取系统设置里的 DoubleClickTime / DoubleClickSize，体感一致）：
    // 不能指望 WM_NCLBUTTONDBLCLK —— 我们按下时是往 DefWindowProc 灌 WM_NCLBUTTONDOWN
    // 让系统跑移动循环，第一次按下/抬起会被那个循环整个吃掉，第二次按下落在哪条路径上
    // 取决于时序（可能变成 WinForms 的 MouseDoubleClick、也可能根本没到），于是
    // "双击没反应"和"双击被当成两次单击 = 最大化又立刻还原"都会随机出现。
    // 自己记时间戳最稳：第一次按下就走「记录 + 拖动」，第二次按下落在阈值内就只切换状态。
    private long _lastCaptionTick = -1;
    private Point _lastCaptionScreen;

    internal TitleBar(Form owner)
    {
        _owner = owner;
        // UserPaint + 全部在 WM_PAINT 里完成 ⇒ 不经过 Panel 的默认背景填充，
        // 拖动改尺寸时不会先刷一层底色再画内容（深色页面上那一层就是闪一下的白边）
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Backdrop;
        Height = LogicalToDeviceUnits(LogicalHeight);
        ResizeBandLogical = 0;   // 标题栏自己就是窗体表面（没有会吃消息的子窗口），不需要让
        // 最大化/还原会改宽度 ⇒ 触发 Resize ⇒ 重画按钮图标（还原图形）
        _owner.Resize += (_, _) => Invalidate();
    }

    // ── 度量 / 布局 ────────────────────────────────────────────────────

    /// <summary>逻辑像素 → 设备像素。所有尺寸都不写死像素，全走这里（DeviceDpi 换算）。</summary>
    private int L(int logical) => LogicalToDeviceUnits(logical);

    /// <summary>同上，给画笔宽度这类小数用（LogicalToDeviceUnits 只收 int）。</summary>
    private float LS(float logical) => logical * DeviceDpi / 96f;

    private Rectangle ButtonBounds(int index)
    {
        var w = L(ButtonWidthLogical);
        // index 0/1/2 从右往左排：关闭永远贴最右
        return new Rectangle(Width - (BtnClose - index + 1) * w, 0, w, Height);
    }

    private int HitButton(Point p)
    {
        for (var i = BtnMin; i <= BtnClose; i++)
        {
            if (ButtonBounds(i).Contains(p)) return i;
        }
        return -1;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // 构造期 DeviceDpi 还是 96（句柄没建），高 DPI 机器上高度会少算 ⇒ 建句柄时补一次
        Height = L(LogicalHeight);
    }

    protected override void OnDpiChangedAfterParent(EventArgs e)
    {
        base.OnDpiChangedAfterParent(e);
        Height = L(LogicalHeight);
        _brandFont?.Dispose();   // 字号按像素算，DPI 变了必须重建
        _brandFont = null;
        Invalidate();
    }

    // ── 绘制 ───────────────────────────────────────────────────────────

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var bg = new SolidBrush(Backdrop))
        {
            g.FillRectangle(bg, ClientRectangle);
        }

        DrawBrand(g);
        for (var i = BtnMin; i <= BtnClose; i++)
        {
            DrawButton(g, i);
        }
    }

    private void DrawBrand(Graphics g)
    {
        var icon = L(BrandIconLogical);
        var box = new RectangleF(L(BrandLeftLogical), (Height - icon) / 2f, icon, icon);

        // 六边形：直接照搬 WebUI 头部 lucide "hexagon" 的六个顶点（左右是竖边、上下是尖角），
        // 这样壳和页面上的品牌标记是同一个形状，而不是"另画一个看起来差不多的"。
        var pts = new[]
        {
            new PointF(0.875f, 0.333f), new PointF(0.875f, 0.667f), new PointF(0.5f, 0.917f),
            new PointF(0.125f, 0.667f), new PointF(0.125f, 0.333f), new PointF(0.5f, 0.083f),
        };
        for (var i = 0; i < pts.Length; i++)
        {
            pts[i] = new PointF(box.X + pts[i].X * box.Width, box.Y + pts[i].Y * box.Height);
        }
        using (var pen = new Pen(BrandAccent, Math.Max(1f, LS(1.6f))) { LineJoin = LineJoin.Round })
        {
            g.DrawPolygon(pen, pts);
        }

        var textLeft = L(BrandLeftLogical) + icon + L(BrandGapLogical);
        var rect = new Rectangle(textLeft, 0, Math.Max(0, Width - textLeft), Height);
        TextRenderer.DrawText(g, "Hyacinth", BrandFont(), rect, BrandText,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
            TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }

    /// <summary>
    /// 品牌字体：字号用**像素**而不是 pt。pt 在 TextRenderer（GDI）下会按屏幕 DC 的 96dpi
    /// 再换算一次，PMv2 高 DPI 窗口里就变成"字号不跟着涨"；这里干脆先 LogicalToDeviceUnits
    /// 成设备像素，交给 GDI 原样使用。
    /// </summary>
    private Font BrandFont()
    {
        var dpi = DeviceDpi;
        if (_brandFont is null || _brandFontDpi != dpi)
        {
            _brandFont?.Dispose();
            _brandFontDpi = dpi;
            // Segoe UI Semibold 在 Win8+ 都有；万一缺字体会自动回退，不会抛异常
            _brandFont = new Font("Segoe UI Semibold", L(BrandFontLogical), FontStyle.Regular, GraphicsUnit.Pixel);
        }
        return _brandFont;
    }

    private void DrawButton(Graphics g, int index)
    {
        var rect = ButtonBounds(index);
        var hot = index == _hover;
        var down = index == _pressed;

        if (hot || down)
        {
            var bg = index == BtnClose
                ? (down ? ClosePressed : CloseHover)
                : (down ? ButtonPressed : ButtonHover);
            using var brush = new SolidBrush(bg);
            g.FillRectangle(brush, rect);
        }

        var color = index == BtnClose && (hot || down) ? GlyphHot : GlyphIdle;
        var thickness = Math.Max(1f, LS(1f));      // 1 逻辑像素；150% 下 1.5px，仍是一条细线
        using var pen = new Pen(color, thickness);

        var s = L(GlyphLogical);
        var x = rect.X + (rect.Width - s) / 2f;
        var y = rect.Y + (rect.Height - s) / 2f;

        switch (index)
        {
            case BtnMin:
                // 减号落在像素缝上会糊成 2px，抬半像素让它落在整格
                g.DrawLine(pen, x, y + s / 2f + thickness / 2f, x + s, y + s / 2f + thickness / 2f);
                break;

            case BtnMax:
                if (_owner.WindowState == FormWindowState.Maximized)
                {
                    // 还原：两个叠放方框。后框只画上边和右边，否则和前框重叠处会出现"加粗"的边
                    var d = s * 0.78f;
                    var off = s - d;
                    g.DrawRectangle(pen, x, y + off, d, d);
                    g.DrawLine(pen, x + off, y, x + s, y);
                    g.DrawLine(pen, x + s, y, x + s, y + d);
                }
                else
                {
                    g.DrawRectangle(pen, x, y, s, s);
                }
                break;

            case BtnClose:
                g.DrawLine(pen, x, y, x + s, y + s);
                g.DrawLine(pen, x + s, y, x, y + s);
                break;
        }
    }

    // ── 交互 ───────────────────────────────────────────────────────────

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var next = HitButton(e.Location);
        if (next == _hover) return;
        var prev = _hover;
        _hover = next;
        if (prev >= 0) Invalidate(ButtonBounds(prev));
        if (next >= 0) Invalidate(ButtonBounds(next));
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (_hover < 0) return;
        var prev = _hover;
        _hover = -1;
        Invalidate(ButtonBounds(prev));
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;

        var btn = HitButton(e.Location);
        if (btn >= 0)
        {
            _pressed = btn;
            Invalidate(ButtonBounds(btn));
            return;
        }

        var screen = PointToScreen(e.Location);
        var now = Environment.TickCount64;
        var dbl = e.Clicks >= 2 || IsDoubleClick(now, screen);
        if (dbl)
        {
            _lastCaptionTick = -1;   // 清掉，避免三连击再翻一次
            ToggleMaximize();
            return;
        }
        _lastCaptionTick = now;
        _lastCaptionScreen = screen;
        BeginCaptionDrag();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (_pressed < 0) return;
        var btn = _pressed;
        _pressed = -1;
        Invalidate(ButtonBounds(btn));
        if (HitButton(e.Location) == btn) Activate(btn);
        _lastCaptionTick = -1;   // 在按钮上点过 ⇒ 别把下一次标题栏按下算成双击
    }

    private bool IsDoubleClick(long now, Point screen)
    {
        if (_lastCaptionTick < 0) return false;
        if (now - _lastCaptionTick > SystemInformation.DoubleClickTime) return false;
        var size = SystemInformation.DoubleClickSize;
        return Math.Abs(screen.X - _lastCaptionScreen.X) <= size.Width
            && Math.Abs(screen.Y - _lastCaptionScreen.Y) <= size.Height;
    }

    /// <summary>
    /// 拖动：给**窗体**发 WM_NCLBUTTONDOWN + HTCAPTION，让系统自己跑移动循环。
    ///
    /// 为什么不用 MouseMove 手动算位移（很多"无边框教程"那么写）：那样窗口跟不上光标
    /// （每次 WM_MOUSEMOVE 只挪一格）、拖到屏幕边缘会抖，而且拿不到 Aero Snap
    /// （拖到顶部最大化 / 拖到左右半屏），滚轮切换、多显示器 DPI 过渡也全丢。
    /// 走 NC 消息则以上全部是系统行为，等于"借用了原生标题栏的拖拽内核"。
    /// </summary>
    private void BeginCaptionDrag()
    {
        // 先松掉 WinForms 的鼠标捕获：不松手的话移动循环抢不到消息，窗口一动不动
        Capture = false;
        ShellFrame.ReleaseCapture();
        ShellFrame.SendMessage(_owner.Handle, ShellFrame.WM_NCLBUTTONDOWN, ShellFrame.HTCAPTION, IntPtr.Zero);
    }

    private void Activate(int button)
    {
        switch (button)
        {
            case BtnMin:
                _owner.WindowState = FormWindowState.Minimized;
                break;
            case BtnMax:
                ToggleMaximize();
                break;
            case BtnClose:
                // ⚠️ 必须走 Form.Close()：托盘常驻的"收进托盘"逻辑在 MainForm.OnFormClosing 里，
                // 直接 Application.Exit() 会绕过它（托盘模式下用户就再也叫不回窗口了）。
                _owner.Close();
                break;
        }
    }

    private void ToggleMaximize()
    {
        _owner.WindowState = _owner.WindowState == FormWindowState.Maximized
            ? FormWindowState.Normal
            : FormWindowState.Maximized;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _brandFont?.Dispose();
            _brandFont = null;
        }
        base.Dispose(disposing);
    }
}

/// <summary>
/// 无边框窗体的 Win32 细节集中在这里：命中测试、圆角、最大化边界、拖拽消息。
/// 拆出来的原因：MainForm 里这些都是同一个「自定义窗体」主题，散着放会淹没业务代码。
/// </summary>
internal static class ShellFrame
{
    /// <summary>
    /// 边缘缩放热区宽度（逻辑像素）。4 ≈ 系统 <c>SM_CXSIZEFRAME + SM_CXPADDEDBORDER</c>（100% 下 4px）。
    ///
    /// 为什么要**让出**这块像素、而不是让 WebView2 直接铺满：WebView2 的浏览器子窗口
    /// （Chrome_WidgetWin）把鼠标消息直接送进 Chromium，既不回 WM_NCHITTEST 也不转发，
    /// 铺满时四边和四角根本拉不动。让出的这一圈由窗体自己（FrameAwarePanel）绘制，
    /// 颜色和页面底色同为 #0a0b14，看起来就是一条很细的深色描边。
    /// </summary>
    internal const int ResizeBorderLogical = 4;

    internal const int WM_NCCALCSIZE = 0x0083;
    internal const int WM_NCHITTEST = 0x0084;
    internal const int WM_GETMINMAXINFO = 0x0024;
    internal const int WM_NCLBUTTONDOWN = 0x00A1;

    internal const int HTCLIENT = 1;
    internal const int HTCAPTION = 2;
    private const int HTLEFT = 10;
    private const int HTRIGHT = 11;
    private const int HTTOP = 12;
    private const int HTTOPLEFT = 13;
    private const int HTTOPRIGHT = 14;
    private const int HTBOTTOM = 15;
    private const int HTBOTTOMLEFT = 16;
    private const int HTBOTTOMRIGHT = 17;

    /// <summary>WM_NCHITTEST 的 lParam 是「屏幕坐标」打包成两个 16 位有符号数（负坐标要多显示器才行）。</summary>
    internal static Point ScreenPointFromLParam(IntPtr lParam)
    {
        var v = lParam.ToInt64();
        return new Point((short)(v & 0xFFFF), (short)((v >> 16) & 0xFFFF));
    }

    /// <summary>
    /// 把屏幕坐标翻译成 HT* 码。命中返回 HTCLIENT。
    /// **最大化/最小化时一律 HTCLIENT**：最大化后窗口贴着屏幕边，如果还认边缘，
    /// 拖动边缘会把一个"屏幕大小"的窗口拽变形（用户看到的是窗口突然缩小一截）。
    /// </summary>
    internal static int HitTest(Form? form, Point screen)
    {
        if (form is null || !form.IsHandleCreated) return HTCLIENT;
        if (form.WindowState != FormWindowState.Normal) return HTCLIENT;

        var band = Math.Max(3, form.LogicalToDeviceUnits(ResizeBorderLogical));
        var p = form.PointToClient(screen);
        var w = form.ClientSize.Width;
        var h = form.ClientSize.Height;
        if (p.X < 0 || p.Y < 0 || p.X >= w || p.Y >= h) return HTCLIENT;

        var left = p.X < band;
        var right = p.X >= w - band;
        var top = p.Y < band;
        var bottom = p.Y >= h - band;

        if (top && left) return HTTOPLEFT;
        if (top && right) return HTTOPRIGHT;
        if (bottom && left) return HTBOTTOMLEFT;
        if (bottom && right) return HTBOTTOMRIGHT;
        if (left) return HTLEFT;
        if (right) return HTRIGHT;
        if (top) return HTTOP;
        if (bottom) return HTBOTTOM;
        return HTCLIENT;
    }

    /// <summary>
    /// 用户可选区域四角圆角。
    ///
    /// ⚠️ `DWMWA_WINDOW_CORNER_PREFERENCE`(33) 是 **Win11 22000+** 才有的属性：
    ///  - Win10 上 DwmSetWindowAttribute 返回 E_INVALIDARG（0x80070057），**不会抛异常**，
    ///    所以只需要看返回值、静默放过；
    ///  - 但更老/被裁剪的 dwmapi 还可能是 EntryPointNotFound / DllNotFound —— 那会抛，
    ///    而这段代码跑在 OnHandleCreated 里，异常会直接把"窗口建出来"这一步炸掉
    ///    （用户看到的是双击没反应，或进程一闪而过）。所以整个调用套 try/catch，失败 = 直角窗口。
    /// </summary>
    internal static void TryApplyRoundedCorners(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            var pref = DWMWCP_ROUND;
            var hr = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
            if (hr != 0) Debug.WriteLine($"[shell] 圆角不可用（Win10 正常现象），hr=0x{hr:X8}");
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[shell] 圆角调用失败，降级为直角：{ex.Message}");
        }
    }

    /// <summary>
    /// 修正最大化时的窗户尺寸。
    ///
    /// ⚠️ 这是"无边框 + WS_THICKFRAME"必踩的坑：系统给最大化窗口的默认矩形是
    /// **工作区外扩一圈边框厚度**（普通窗口靠客户区被 NC 区吃掉一圈来对齐工作区），
    /// 而我们把非客户区清零了（见 MainForm 的 WM_NCCALCSIZE）⇒ 客户区 = 窗口矩形
    /// ⇒ 最大化后页面右下各被切掉 ~8px、还会盖住任务栏。
    /// 这里把 ptMaxSize/ptMaxPosition 直接订到工作区，顺便让多显示器（任务栏在左/上）也对齐。
    ///
    /// 只改这两个字段：ptMinTrackSize 是 WinForms 按 MinimumSize 填的，动它会失去最小尺寸约束。
    /// </summary>
    internal static void ClampMaximizedBounds(IntPtr hwnd, IntPtr mmiPtr)
    {
        if (hwnd == IntPtr.Zero || mmiPtr == IntPtr.Zero) return;
        try
        {
            var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return;
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (!GetMonitorInfo(monitor, ref mi)) return;

            var mmi = Marshal.PtrToStructure<MINMAXINFO>(mmiPtr);
            mmi.ptMaxPosition.X = mi.rcWork.Left - mi.rcMonitor.Left;
            mmi.ptMaxPosition.Y = mi.rcWork.Top - mi.rcMonitor.Top;
            mmi.ptMaxSize.X = mi.rcWork.Right - mi.rcWork.Left;
            mmi.ptMaxSize.Y = mi.rcWork.Bottom - mi.rcWork.Top;
            Marshal.StructureToPtr(mmi, mmiPtr, false);
        }
        catch
        {
            // 拿不到显示器信息 ⇒ 用系统默认值，最多是最大化时多一点过扫，不影响可用性
        }
    }

    internal static void ReleaseCapture() => _ = NativeMethods.ReleaseCapture();

    internal static void SendMessage(IntPtr hwnd, int msg, int wParam, IntPtr lParam) =>
        _ = NativeMethods.SendMessage(hwnd, msg, (IntPtr)wParam, lParam);

    // ── Win32 ─────────────────────────────────────────────────────────

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const int MONITOR_DEFAULTTONEAREST = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    private static class NativeMethods
    {
        [DllImport("user32.dll")]
        internal static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
    }
}
