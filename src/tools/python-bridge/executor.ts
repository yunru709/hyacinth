import { spawn } from 'node:child_process';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('python-executor');

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
const DEFAULT_TIMEOUT_MS = 60_000;   // 60s

/**
 * 执行 Python 脚本，传入 JSON 参数，返回 stdout。
 * 超时或非零退出码时返回错误。
 */
export function executePython(filePath: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const python = findPython();
    const child = spawn(python, [filePath], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const input = JSON.stringify(args);
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      resolve(`Error: Python tool timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`);
    }, DEFAULT_TIMEOUT_MS);

    child.stdin!.write(input);
    child.stdin!.end();

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) {
        killed = true;
        child.kill();
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        if (stdout.length > MAX_OUTPUT_BYTES) {
          resolve(`Error: Python tool output exceeded ${MAX_OUTPUT_BYTES / 1024}KB limit`);
        }
        return;
      }
      if (code !== 0) {
        logger.warn(`Python tool ${filePath} exited with code ${code}: ${stderr.slice(0, 500)}`);
        resolve(`Error (exit ${code}): ${stderr.slice(0, 1000) || 'Unknown error'}`);
        return;
      }
      resolve(stdout.trimEnd());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Error: Cannot execute python: ${err.message}`);
    });
  });
}

function findPython(): string {
  // 优先虚拟环境 → python3 → python
  if (process.platform === 'win32') {
    const venv = process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX;
    if (venv) return `${venv}/Scripts/python.exe`;
    return 'python';
  }
  return 'python3';
}
