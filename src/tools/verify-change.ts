import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Tool } from './interface.js';

/**
 * VerifyChangeTool — 改完代码后"一次调用"跑完该跑的验证
 *
 * 为什么需要它（真实痛点）：本次会话里我为了确认改动没坏东西，手工重复执行了
 * 8+ 次 `npm run build` + `npx vitest run src/tools` + 人工比对 git status。
 * 每次 20–30 秒，且"该跑哪些测试"全靠我记忆。这个工具把它变成一次调用。
 *
 * 设计要点：
 *   - **只跑固定命令**（git status / tsc --noEmit / vitest run / 项目自带的分层守卫），
 *     不接受任意 shell 字符串 —— 否则它会变成沙箱旁路（`bash` 已存在，不该再开一个口）。
 *   - **不引入 shell**：一律 `spawn(process.execPath, [<bin 的 js 入口>, ...args], { shell: false })`，
 *     从根上消灭参数注入（Windows 上 npx.cmd/tsc.cmd 那套绕不过 shell，故直接调 js 入口）。
 *   - 传入的路径参数**必须落在仓库内**且字符集受限，否则直接拒绝。
 *   - "改动文件 → 关联测试"用**共址命名惯例**（`src/x/y.ts` ↔ `src/x/y.test.ts`）；
 *     没有共址测试时退化为**同目录的测试文件**，并在输出里说明依据（不静默跳过）。
 *
 * 尚未接入：xref 影响面（其索引库需先 `xref_build`，且查询参数形状未核实）。
 *   宁可不做，也不按未核实的假设写。需要时单独加，并先确认 API。
 */
export class VerifyChangeTool implements Tool {
  readonly name = 'verify_change';
  readonly sideEffect = 'exec' as const;
  readonly description =
    '改完代码后一次跑完该跑的验证：类型检查（tsc --noEmit）+ 定向测试（按共址命名推导关联测试文件）+ 可选分层守卫。' +
    '默认对 git 未提交改动生效，也可用 paths 指定。只执行固定命令，不接受任意 shell 字符串。' +
    '用于替代"手工 build + 跑测试 + 比对 git status"的重复劳动。';
  readonly companionDescription = '我改完了，验一下。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files/dirs to verify (relative to the repo root). Omit to use uncommitted git changes.',
      },
      run: {
        type: 'string',
        enum: ['both', 'typecheck', 'tests', 'layers'],
        description: 'What to run. "both" (default) = typecheck + tests. "layers" = project layer guard only.',
      },
      test_targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit test files to run, overriding the automatic derivation from changed sources.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Per-step timeout in ms. Default 180000 (3 min).',
      },
    },
    required: [],
  };

  /**
   * 危险元字符黑名单（shell 元字符 / 引号 / 换行）。
   * 注意：本工具一律 `shell: false` 执行，注入在原理上已不可能，这里只是纵深防御，
   * 因此用**黑名单而不是白名单** —— 白名单会把 `C:\...` 这类绝对路径也一并挡掉，
   * 那是可用性陷阱（路径参数很自然会被写成绝对路径）。
   */
  private static readonly UNSAFE_PATH = /[;&|`$<>"\n\r\0]/;

  private static readonly SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);

  async execute(args: Record<string, unknown>): Promise<string> {
    const root = process.cwd();
    const timeoutMs = Math.min(Math.max((args.timeout_ms as number) ?? 180_000, 5_000), 600_000);
    const run = (args.run as string) ?? 'both';

    // ── 1. 定改动文件 ──
    let changed: string[];
    let source = '';
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      const bad = (args.paths as unknown[]).filter(
        (p): p is string => typeof p !== 'string' || VerifyChangeTool.UNSAFE_PATH.test(p),
      );
      if (bad.length > 0) return `Error: illegal path argument(s): ${JSON.stringify(bad)}`;
      changed = (args.paths as string[]).map((p) => path.relative(root, path.resolve(root, p)));
      source = 'explicit paths';
    } else {
      const g = await runPlain('git', ['status', '--porcelain'], root, 20_000);
      if (g.timedOut) return 'Error: git status timed out (is this a git repo?).';
      if (g.code !== 0) {
        return `Error: not a git repository, or git failed (exit ${g.code}). Pass paths explicitly instead.`;
      }
      changed = parseGitStatus(g.out);
      source = 'uncommitted git changes';
    }

    const sources = changed.filter((p) => VerifyChangeTool.SRC_EXTS.has(path.extname(p).toLowerCase()));
    if (changed.length === 0) {
      return `[verify_change] nothing to verify — no ${source}. (working tree clean)`;
    }

    const header = [
      `[verify_change] root: ${root}`,
      `changed: ${changed.length} path(s) from ${source}`,
      ...changed.slice(0, 20).map((p) => `  ${p}`),
      changed.length > 20 ? `  ... (+${changed.length - 20} more)` : '',
    ].filter(Boolean).join('\n');

    const sections: string[] = [header];
    const verdicts: string[] = [];

    // ── 2. 类型检查 ──
    if (run === 'both' || run === 'typecheck') {
      const tsc = resolveBin(root, ['typescript/bin/tsc', 'typescript/lib/tsc.js']);
      if (!tsc) {
        sections.push('--- typecheck ---\nSKIPPED: cannot resolve typescript (run npm install?)');
        verdicts.push('typecheck: SKIPPED');
      } else {
        const t0 = Date.now();
        const r = await runNode(tsc, ['--noEmit'], root, timeoutMs);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const errLines = r.out.split('\n').filter((l) => /error TS\d+/.test(l));
        if (r.timedOut) {
          sections.push(`--- typecheck ---\nTIMEOUT after ${timeoutMs}ms`);
          verdicts.push('typecheck: TIMEOUT');
        } else if (r.code === 0 && errLines.length === 0) {
          sections.push(`--- typecheck (tsc --noEmit) ---\nPASS (${secs}s)`);
          verdicts.push('typecheck: PASS');
        } else {
          sections.push(
            `--- typecheck (tsc --noEmit) ---\nFAIL (${secs}s, ${errLines.length} error line(s))\n`
            + errLines.slice(0, 20).join('\n')
            + (errLines.length > 20 ? `\n... (+${errLines.length - 20} more)` : ''),
          );
          verdicts.push(`typecheck: FAIL (${errLines.length})`);
        }
      }
    }

    // ── 3. 定向测试 ──
    if (run === 'both' || run === 'tests') {
      // 两个分支必须同形状（否则推成联合类型，下面取 .files 会类型报错）
      const derived = Array.isArray(args.test_targets) && args.test_targets.length > 0
        ? { files: args.test_targets as string[], basis: 'explicit test_targets' }
        : deriveTestTargets(root, sources);
      if (derived.files.length === 0) {
        sections.push(
          '--- tests ---\nNO TARGETS: none of the changed files has a colocated test '
          + '(`<name>.test.ts`) nor a sibling test in the same directory.\n'
          + '  → pass test_targets explicitly if you know which suite covers this change.',
        );
        verdicts.push('tests: NO TARGETS');
      } else {
        const vitest = resolveBin(root, ['vitest/vitest.mjs']);
        if (!vitest) {
          sections.push('--- tests ---\nSKIPPED: cannot resolve vitest (run npm install?)');
          verdicts.push('tests: SKIPPED');
        } else {
          const t0 = Date.now();
          const r = await runNode(vitest, ['run', ...derived.files], root, timeoutMs);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const summary = r.out.split('\n').filter((l) => /Test Files|Tests\s+\d|FAIL\s/.test(l))
            .slice(0, 12).join('\n');
          const failed = /failed/.test(summary) && !/0 failed/.test(summary);
          sections.push(
            `--- tests (${derived.files.length} target(s), by ${derived.basis}) ---\n`
            + derived.files.map((f) => `  ${f}`).join('\n') + '\n'
            + (r.timedOut ? `TIMEOUT after ${timeoutMs}ms` : (summary || `(no summary; exit ${r.code})`))
            + `\n(${secs}s)`,
          );
          verdicts.push(failed || r.code !== 0 ? 'tests: FAIL' : 'tests: PASS');
        }
      }
    }

    // ── 4. 分层守卫（项目自带）──
    if (run === 'layers') {
      const guard = path.join(root, 'scripts', 'verify-layers.mjs');
      if (!fs.existsSync(guard)) {
        sections.push('--- layers ---\nSKIPPED: scripts/verify-layers.mjs not found');
        verdicts.push('layers: SKIPPED');
      } else {
        const r = await runPlain(process.execPath, [guard], root, timeoutMs);
        const tail = r.out.split('\n').filter(Boolean).slice(-12).join('\n');
        sections.push(`--- layers (verify-layers.mjs) ---\n${r.timedOut ? 'TIMEOUT' : tail}`);
        verdicts.push(`layers: ${r.code === 0 ? 'PASS' : 'FAIL'}`);
      }
    }

    sections.push(`--- summary ---\n${verdicts.join('\n')}`);
    return sections.join('\n\n');
  }
}

// ── 辅助 ──────────────────────────────────────────────────────

interface CmdResult { code: number | null; timedOut: boolean; out: string }

const MAX_CAPTURE = 200_000;

function runPlain(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
  return spawnCapture(cmd, args, cwd, timeoutMs);
}

function runNode(script: string, args: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
  return spawnCapture(process.execPath, [script, ...args], cwd, timeoutMs);
}

/** shell: false —— 参数不会被 shell 解释，从根上杜绝注入 */
function spawnCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    const append = (d: Buffer) => { if (out.length < MAX_CAPTURE) out += d.toString('utf8'); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, out }); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, out: `${out}\n[spawn error] ${e.message}` });
    });
  });
}

/** 解析 `git status --porcelain`：`XY path`，处理重命名 `old -> new`
 *  （导出以便单测：这段解析是最容易藏 bug 的地方，而工具层跑真命令太慢） */
export function parseGitStatus(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    if (!p) continue;
    if (p.includes(' -> ')) p = p.split(' -> ').pop()!.trim();
    // 去掉可能的引号（git 对含特殊字符的路径会加引号）
    p = p.replace(/^"(.*)"$/, '$1');
    files.push(p.replace(/\\/g, '/'));
  }
  return files;
}

/**
 * 推导关联测试：
 *   1) 共址命名 `<dir>/<stem>.test.ts`（项目惯例）
 *   2) 退化为同目录下所有 `*.test.ts`（并说明依据）
 * 改动文件本身就是测试文件时，直接用它。
 */
export function deriveTestTargets(
  root: string,
  sources: string[],
): { files: string[]; basis: string } {
  const picked = new Set<string>();
  let usedColocated = false;
  let usedSiblings = false;
  const MAX = 12;

  for (const rel of sources) {
    const abs = path.join(root, rel);
    if (/\.test\.tsx?$/.test(rel)) { picked.add(rel); usedColocated = true; continue; }

    const dir = path.dirname(abs);
    const stem = path.basename(abs).replace(/\.(ts|tsx|js|jsx|mjs|cjs|json)$/i, '');
    for (const ext of ['.test.ts', '.test.tsx']) {
      const cand = path.join(dir, `${stem}${ext}`);
      if (fs.existsSync(cand)) {
        picked.add(path.relative(root, cand).replace(/\\/g, '/'));
        usedColocated = true;
      }
    }
    if ([...picked].some((p) => p.startsWith(path.relative(root, dir).replace(/\\/g, '/')))) continue;

    // 无共址测试 → 退化为同目录测试文件
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/\.test\.tsx?$/.test(name)) {
          picked.add(path.relative(root, path.join(dir, name)).replace(/\\/g, '/'));
          usedSiblings = true;
        }
      }
    } catch { /* 目录读不到就跳过 */ }
    if (picked.size >= MAX) break;
  }

  const basis = usedColocated && usedSiblings
    ? 'colocated + sibling'
    : usedColocated ? 'colocated naming' : usedSiblings ? 'sibling tests in same dir' : 'none';
  return { files: [...picked].slice(0, MAX), basis };
}

/** 解析 bin 的 js 入口：优先本地 node_modules，其次 require.resolve */
function resolveBin(root: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    const direct = path.join(root, 'node_modules', rel);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    const req = createRequire(path.join(root, 'package.json'));
    for (const rel of candidates) {
      try { return req.resolve(rel); } catch { /* 试下一个 */ }
    }
  } catch { /* ignore */ }
  return null;
}
