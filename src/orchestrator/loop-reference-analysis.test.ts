/**
 * loop-reference-analysis.test.ts — 「核心消费者在**无插件宿主**的 loop 内仍然产出引用分析」
 * （任务单二：子代理端到端实测的等价场景）
 *
 * 为什么是这个形状：子代理的处境 = 一个**没有注入 pluginHost 的 AgentLoop**
 *（实测：delegate-tool.ts:318-336 未传该字段 ⇒ create-kernel 给全新空宿主）。
 * 于是子代理里 `host.get('referenceAnalysis')` 恒 undefined ⇒ 走**核心兜底**（字符串扫描）。
 * 本测试就构造这样一个 loop（`makeServices` 本就不含 pluginHost ⇒ 天然等价），
 * 让它在真实 pipeline 里执行一次 write，然后断言工具结果里出现了 `[References]`。
 *
 * 判据（对应任务单的 ① ②）：
 *   ① 引用分析产出出现 —— 且内容符合**兜底**路径（同一份扫描实现，非索引精确结果）
 *   ② 主循环不受影响 —— 一轮 turn 正常结束（不抛、stop=true）
 *
 * 若 ① 不成立（连兜底都没触发）⇒ 按任务单是 P0（说明后置序列有分支没走到）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentLoop } from './loop.js';
import type { AgentLoopServices } from './loop.js';
import type { Provider } from '../provider/interface.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { WriteTool } from '../tools/write.js';

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-refanal-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** provider：流里发一次 write 工具调用，再收尾（形状取自 llm.test.ts:110 —— 大写 TOOL_USE） */
function makeToolCallProvider(input: Record<string, unknown>) {
  // **有状态**（接手方修正）：首轮流发一次 write 工具调用，其后发文本收尾。
  // 原版每次 createStream 都重发同一个工具调用 ⇒ 循环永不收尾（stop 恒 false）⇒ 断言②红；
  // 且它会一直跑到 maxTurns，白耗 1.1s。工具调用仍只在首轮发生一次（断言①的前提不变）。
  let call = 0;
  return {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    getCapabilities: () => ({ vision: false }),
    setThinking: vi.fn(),
    createStream: vi.fn().mockImplementation(() => {
      call += 1;
      const isFirstCall = call === 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (isFirstCall) {
            yield { type: 'TOOL_USE', id: 'tu_ref_1', name: 'write', input };
            yield { type: 'STOP', reason: 'tool_use' };
          } else {
            yield { type: 'TEXT', content: 'done' };
            yield { type: 'STOP', reason: 'end_turn' };
          }
        },
      };
    }),
  } as unknown as Provider;
}

/** 服务面：照 loop-integration.test.ts 的 makeServices，只把 toolExecutor 换成**真实**的 */
function makeServices(provider: Provider, registry: ToolRegistry): AgentLoopServices {
  return {
    provider,
    contextComposer: {
      compose: vi.fn().mockResolvedValue({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
        zoneBreakdown: { total: 100 },
      }),
      activeConditions: new Set<string>(),
    },
    compressor: { compress: vi.fn().mockResolvedValue(null) } as never,
    orchestrator: {} as never,
    toolExecutor: new ToolExecutor(registry),
    toolRegistry: registry,
    conversationStore: {
      readAll: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue(undefined),
      replace: vi.fn().mockResolvedValue(undefined),
    } as never,
    eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
    statsManager: {
      get: vi.fn().mockResolvedValue({ input_tokens: 0, output_tokens: 0, cache_turns: [] }),
      update: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(undefined),
    } as never,
    summaryStore: { load: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) } as never,
    flowRegistry: { getActive: () => null } as never,
  } as unknown as AgentLoopServices;
}

describe('核心消费者在无插件宿主的 loop 内（子代理等价场景）', () => {
  it('① 引用分析产出出现（兜底路径）② 主循环不受影响', async () => {
    const project = tmpdir();
    // **夹具契约**：必须建 .git 标记 —— 兜底扫描靠 findProjectRoot 定根；缺了它会上溯到
    // 用户目录，scanReferences 的 500 文件上限被系统目录吃光 ⇒ 永远扫不到项目内的引用
    //（接手方实测：正因缺这一步，端到端一直拿不到 [References]，而账本侧早已修好）。
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    // 引用方先就位：它引用 targetFn（符号本体将由 loop 里的 write 创建）
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'src', 'caller.ts'),
      "import { targetFn } from './a.js';\n\nexport const v = targetFn();\n",
      'utf8',
    );

    const target = path.join(project, 'src', 'a.ts');
    const content = 'export function targetFn(): number {\n  return 1;\n}\n';
    const provider = makeToolCallProvider({ file_path: target, content });

    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    const services = makeServices(provider, registry);

    // 关键：**不注入 pluginHost** ⇒ 与子代理同处境（host 为全新空宿主 ⇒ 能力 undefined）
    const loop = new AgentLoop(services, { sessionDir: tmpdir() });
    expect((loop as unknown as { pluginHost?: unknown }).pluginHost).toBeTruthy(); // 空宿主存在（但无能力）

    // 用**多轮驱动入口** run() 跑（runTurn 只是单轮：带工具调用的单轮必然返回 stop=false，
    // 那是"继续下一轮"的正确语义，不是故障 —— 原版调 runTurn 因此误红了 ②）。
    const cs = (provider as unknown as { createStream: { mock: { calls: unknown[] } } }).createStream;
    await expect(
      (loop as unknown as { run(u: string): Promise<void> }).run('在 a.ts 里定义 targetFn'),
    ).resolves.toBeUndefined();

    // ② 主循环不受影响：多轮跑完、不抛，且确实进入了多轮（工具调用后继续了）
    expect(cs.mock.calls.length).toBeGreaterThanOrEqual(2);

    // ① 引用分析产出出现 —— 从落进对话的 tool_result 里找
    const append = (services.conversationStore as unknown as { append: ReturnType<typeof vi.fn> }).append;
    const toolResults = append.mock.calls
      .map((c) => c[1] as { content?: { type?: string; content?: unknown } })
      .filter((m) => m?.content?.type === 'tool_result');
    expect(toolResults.length).toBeGreaterThan(0);

    const text = JSON.stringify(toolResults.map((m) => m.content?.content));
    expect(text).toContain('[References]'); // 兜底产出的块头（与字符串扫描同源）
    expect(text).toContain('targetFn');
    // 兜底路径的记号：核心扫描给的是"文件路径 → 引用"，不带索引侧的 caller_name 括号与标注
    expect(text).not.toContain('[precise]');
  });
});
