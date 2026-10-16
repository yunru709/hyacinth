using System.Diagnostics;
using System.Net.Http;
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

    private readonly WebView2 _web = new();
    private Process? _backend;
    private bool _spawnedBackend;

    public MainForm()
    {
        Text = "Hyacinth";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1080, 680);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(12, 17, 19);
        _web.Dock = DockStyle.Fill;
        Controls.Add(_web);
        // ⚠️ 必须在窗口**已显示**之后再初始化 WebView2。
        // 在 Load 阶段，窗口句柄虽已创建但尚未真正显示 ⇒
        // CreateCoreWebView2ControllerAsync 会直接返回 E_UNEXPECTED（0x8000FFFF「灾难性故障」）。
        Shown += async (_, _) =>
        {
            await Task.Delay(150);   // 让首次呈现完成，避免抢在窗口就绪之前
            await BootAsync();
        };
        FormClosed += (_, _) => StopBackend();
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
