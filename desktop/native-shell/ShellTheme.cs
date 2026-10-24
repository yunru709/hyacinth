using System.Diagnostics;
using System.Runtime.InteropServices;

namespace native_shell;

/// <summary>
/// 窗口 chrome 染色：把**系统标题栏**染成页面顶栏同色，标题文字染同色隐形
/// （窗口图标仍显示，正好当品牌位），窗口边框染同色只剩阴影勾边，并按页面
/// 明暗切换系统三颗 caption 按钮的深浅。
///
/// 为什么走这条路而不是自绘无边框（2026-10-24 换方案）：上一版用
/// <c>FormBorderStyle.None</c> + WM_NCCALCSIZE 清零 + 自绘标题栏 + 4px 缩放
/// 热区带，换来两类反复出现的问题——某些路径下 DWM 重算非客户区时浮出一条
/// 系统蓝标题栏，以及客户区四周永远有一条深色热区带。现在窗口保持**完全
/// 标准的系统边框**（一行窗口结构代码不碰），外观全部交给 DWM 染色：三颗
/// 系统按钮 / 拖拽 / 缩放 / 圆角 / 阴影都是原生机制，不存在状态分叉。
/// 颜色由页面在主题应用时经 WebMessage 报上来（webui 的 notifyShellTheme）。
///
/// ⚠️ 这些 DWM 属性是 Win11 22000+ 的（20 号暗色属性更早）；Win10 上返回
/// E_INVALIDARG ⇒ 静默保持系统默认标题栏，功能不受影响。
/// </summary>
internal static class ShellTheme
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_CAPTION_COLOR = 35;
    private const int DWMWA_TEXT_COLOR = 36;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /// <summary>页面还没报色前的默认 chrome 色：与 WebUI 默认主题「夜园」底色一致。</summary>
    public static readonly Color Default = Color.FromArgb(0x0A, 0x0B, 0x14);

    /// <summary>把标题栏 / 文字 / 边框染成 color；dark 决定系统按钮画深色还是浅色。</summary>
    public static void Apply(IntPtr hwnd, Color color, bool dark)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            var caption = ColorRef(color);
            var text = ColorRef(color);
            var border = ColorRef(color);
            var darkFlag = dark ? 1 : 0;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkFlag, sizeof(int));
            DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
            DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, ref text, sizeof(int));
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
        }
        catch
        {
            // dwmapi 异常的极端环境：保持系统默认标题栏，功能不受影响
        }
    }

    /// <summary>Win11 用户可选区域圆角；Win10 返回 E_INVALIDARG ⇒ 静默直角，绝不抛。</summary>
    public static void TryApplyRoundedCorners(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
            var pref = 2 /* DWMWCP_ROUND */;
            var hr = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
            if (hr != 0) Debug.WriteLine($"[shell] 圆角不可用（Win10 正常现象），hr=0x{hr:X8}");
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[shell] 圆角调用失败，降级为直角：{ex.Message}");
        }
    }

    /// <summary>COLORREF 是 0x00BBGGRR（与 #RRGGBB 字节序相反）。</summary>
    private static int ColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);
}
