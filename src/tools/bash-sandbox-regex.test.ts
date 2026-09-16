/**
 * 沙箱词边界黑名单的回归守卫。
 *
 * 背景：旧模式 `\bformat\b(?!-)` 把 `-` / `.` / `/` 都当词边界，导致**任何含该词的
 * 文件名、路径或普通参数**都被误杀（`dist/gateway/tui-format.js`、`npm run format`、
 * `--grep format`），正常检索与构建被反复阻断。收窄为「命令起始位置 + 盘符目标」后：
 * 真正的磁盘格式化仍被拦截，而上述正常用法放行。
 *
 * 这里只对模式做纯断言（不调用 BashTool.execute），避免测试万一回归时真的执行破坏性命令。
 */
import { describe, it, expect } from 'vitest';
import { BLOCKED_COMMAND_REGEX } from './bash.js';

/** 命中任一黑名单模式则返回其 label，否则 null */
function hit(cmd: string): string | null {
  for (const { pattern, label } of BLOCKED_COMMAND_REGEX) {
    if (pattern.test(cmd)) return label;
  }
  return null;
}

describe('bash 沙箱：format 危险命令黑名单', () => {
  it('拦截真正的磁盘格式化用法（命令起始处 + 盘符目标）', () => {
    expect(hit('format C:')).toBe('format');
    expect(hit('format /q D:')).toBe('format');
    expect(hit('FORMAT E:')).toBe('format');
    expect(hit('format.com F:')).toBe('format');
    expect(hit('cd somewhere; format C:')).toBe('format');
    expect(hit('echo hi && format C:')).toBe('format');
    expect(hit('dir | format C:')).toBe('format');
  });

  it('**不再误杀含该词的路径/文件名**（回归守卫：曾阻断正常检索与构建）', () => {
    expect(hit('Select-String -Path dist\\gateway\\tui-format.js')).toBeNull();
    expect(hit('npx vitest run src/gateway/tui-format.test.ts')).toBeNull();
    expect(hit('Get-Item dist/gateway/tui-format.js')).toBeNull();
  });

  it('不误杀 PowerShell 的 Format-* cmdlet', () => {
    expect(hit('$disks | Format-Table Drive, TotalGB -AutoSize')).toBeNull();
    expect(hit('Get-Command Format-Hex')).toBeNull();
  });

  it('不误杀把该词当普通参数的命令', () => {
    expect(hit('npm run format')).toBeNull();
    expect(hit('git log --grep format')).toBeNull();
    expect(hit('echo format')).toBeNull();
  });
});
