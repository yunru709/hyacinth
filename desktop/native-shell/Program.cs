using System.Runtime.InteropServices;

namespace native_shell;

internal static class Program
{
    /// <summary>
    /// 单实例互斥体名。用 <c>Local\</c> 前缀 = 按登录会话隔离（多用户机器上各开各的），
    /// GUID 固定即"这一个应用"。
    ///
    /// 为什么必须有：壳每次启动都会拉一个后端子进程，双击两次 ⇒ 两个壳、两个后端抢同一端口，
    /// 第二个后端的失败信息只落在日志里，用户看到的是"窗口白屏"。
    /// </summary>
    private const string InstanceMutex = @"Local\Hyacinth-NativeShell-{9C4B2A61-7E3D-4F58-9A10-5D2E8B7C3A44}";

    [STAThread]
    private static void Main()
    {
        // initiallyOwned: true ⇒ 首个实例直接持有；后续实例拿到 isFirst=false
        using var mutex = new Mutex(true, InstanceMutex, out var isFirst);
        if (!isFirst)
        {
            if (!TryActivateExisting())
            {
                MessageBox.Show(
                    "Hyacinth 已在运行（可能被最小化或藏在其他桌面）。",
                    "Hyacinth",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    /// <summary>把已在运行的窗口提到前台；找不到就返回 false（调用方退化为提示框）。
    ///
    /// 两个坑（都实测过）：
    ///  1. **FindWindow 搜不到 Hide() 后的窗口**：托盘常驻时窗口处于隐藏状态，
    ///     FindWindow 返回 0 ⇒ 第二实例误判"没在运行"弹出提示框，托盘里的窗口
    ///     纹丝不动。所以用 EnumWindows 枚举**全部**顶层窗口（含隐藏的）按标题匹配。
    ///  2. **不直接 ShowWindow/SetForegroundWindow，发自定义消息让第一实例自己唤回**：
    ///     跨进程操纵窗口状态会绕过 WinForms 的 Visible 跟踪；现在是标准系统窗口
    ///     不再有 NC 绘制分叉，但让第一实例的 UI 线程走 ShowMainWindow()（还原 +
    ///     Show + Activate）仍然是唯一能保证 WinForms 状态与 Win32 一致的做法。</summary>
    private static bool TryActivateExisting()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, _) =>
        {
            var sb = new System.Text.StringBuilder(64);
            if (GetWindowText(h, sb, sb.Capacity) > 0 && sb.ToString() == "Hyacinth")
            {
                found = h;
                return false;   // 找到即停
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        PostMessage(found, MainForm.WmShowMe, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
