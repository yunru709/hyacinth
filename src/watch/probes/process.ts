/**
 * process probe（2026-10-29）
 *
 * 指纹语义（达成式）：
 *   expect='running'：进程在 → 'met'，不在 → 'pending'（等待它启动）
 *   expect='exit'   ：进程没了 → 'met'，还在 → 'pending'（等待它结束）
 * 于是「变化」= 期望被达成，上层不需要理解具体进程状态。
 *
 * pid 判定用 `process.kill(pid, 0)`：不发送信号，只做存在性探测。
 * EPERM 表示"存在但无权限"，同样算存在。
 *
 * 按名字查找在 Windows 上走 `tasklist`，失败时返回 ok=false 而不是
 * 假装"进程不存在"——后者会让调用方误判为进程已退出。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Probe, ProbeInstance, ProbeSample, ProcessSpec } from '../types.js';

const execFileAsync = promisify(execFile);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function findNameRunning(name: string): Promise<boolean> {
  const wanted = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;

  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${wanted}`, '/NH', '/FO', 'CSV'],
      { timeout: 10_000, windowsHide: true },
    );
    // 无匹配时 tasklist 输出的是本地化提示文字（中文系统为「信息: 没有运行的任务…」），
    // 因此不能用"输出非空"判断，必须找进程名本身。
    return stdout.toLowerCase().includes(wanted.toLowerCase());
  }

  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='], { timeout: 10_000 });
  return stdout
    .split('\n')
    .some((line) => line.trim().toLowerCase() === wanted.toLowerCase() || line.trim().toLowerCase() === name.toLowerCase());
}

class ProcessProbeInstance implements ProbeInstance {
  constructor(private readonly spec: ProcessSpec) {}

  async sample(signal?: AbortSignal): Promise<ProbeSample> {
    if (signal?.aborted) return { ok: false, value: '', error: 'aborted' };

    let alive: boolean;
    try {
      if (typeof this.spec.pid === 'number') {
        alive = isPidAlive(this.spec.pid);
      } else if (this.spec.name) {
        alive = await findNameRunning(this.spec.name);
      } else {
        return { ok: false, value: '', error: 'process probe requires either pid or name' };
      }
    } catch (err) {
      return { ok: false, value: '', error: `lookup failed: ${(err as Error).message}` };
    }

    const met = this.spec.expect === 'exit' ? !alive : alive;
    return { ok: true, value: met ? 'met' : 'pending', raw: { alive } };
  }
}

export const processProbe: Probe = {
  kind: 'process',
  description: '等待进程启动或退出（按 pid 或进程名）',
  create(spec) {
    if (spec.kind !== 'process') throw new Error('processProbe received mismatched spec');
    const hasPid = typeof spec.pid === 'number';
    const hasName = typeof spec.name === 'string' && spec.name.length > 0;
    if (!hasPid && !hasName) throw new Error('process probe requires either pid or name');
    if (hasPid && hasName) throw new Error('process probe: pass only one of pid / name');
    if (spec.expect !== 'running' && spec.expect !== 'exit') {
      throw new Error("process probe: expect must be 'running' or 'exit'");
    }
    return new ProcessProbeInstance(spec);
  },
};
