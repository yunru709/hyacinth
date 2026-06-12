// ============================================================
// TUI 日志拦截器
// ============================================================
//
// TUI 模式下，console.log 输出会污染终端界面（覆盖输入行）。
// 此模块拦截 console.log，将非 TUI 的日志重定向到 stderr
// （TUI 会把 stderr 写入日志文件，避免污染终端界面）。
//
// 拦截规则：
//   - 飞书 SDK 日志：[info]: / [warn]: / [error]: 前缀
//   - TrainingScheduler 日志：[TrainingScheduler] 前缀
//   - 其他框架内部日志：[ClassName] 前缀格式
// ============================================================

/**
 * 安装 TUI 日志拦截器。
 * 持久拦截 console.log，将框架内部日志重定向到 stderr。
 * 调用返回的 restore 函数可恢复原始 console.log。
 */
export function installSDKLogSuppressor(): () => void {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    // 框架内部日志特征：[ClassName] 前缀 或 SDK 特定关键词
    if (
      /^\[(info|warn|error)\]/.test(msg) ||
      /^\[\w+\]/.test(msg) ||  // [TrainingScheduler]、[HeartbeatScheduler] 等
      /event-dispatch|ws client|persistent connection/i.test(msg)
    ) {
      process.stderr.write(`${msg}\n`);
      return;
    }
    origLog(...args);
  };
  return () => { console.log = origLog; };
}
