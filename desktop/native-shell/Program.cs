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

    /// <summary>把已在运行的窗口提到前台；找不到就返回 false（调用方退化为提示框）。</summary>
    private static bool TryActivateExisting()
    {
        var hwnd = FindWindow(null, "Hyacinth");
        if (hwnd == IntPtr.Zero) return false;
        ShowWindow(hwnd, SW_RESTORE);      // 最小化状态下先还原，否则 SetForegroundWindow 无效
        return SetForegroundWindow(hwnd);
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
