/**
 * golden-session.ts —— 会话处理「黄金主测试」探测脚本（无真实 provider）。
 *
 * 目标：验证「用户输入 → 会话处理全链路 → 落盘输出」的输入输出关系是否合理。
 * 用真实文件存储（ConversationStore/StatsManager/SummaryStore/EventStore），
 * 仅 stub provider 与外部服务，跑 AgentLoop.run() 完整链路（runTurn 之外含
 * 输入落盘、事件、finalize、stats 记账）。
 *
 * 用法：npx tsx scripts/golden-session.ts   （会创建临时 sessionDir，跑完即删）
 *
 * 输入：覆盖全部 26 字母（大小写）+ 数字 + 常见特殊字符 + 中文（Unicode 混排），
 * 用于验证会话链路对输入逐字完整、无转义/截断。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/orchestrator/loop.js';
import type { AgentLoopServices } from '../src/orchestrator/loop.js';
import { ConversationStore } from '../src/memory/conversation.js';
import { EventStore } from '../src/memory/events.js';
import { StatsManager } from '../src/memory/stats.js';
import { SummaryStore } from '../src/memory/summary.js';
import type { Provider } from '../src/provider/interface.js';

// ── 测试输入：所有字母 + 数字 + 特殊字符 + 中文（Unicode 混排） ──
const INPUT = [
  '黄金主测试输入（含全部 26 字母大小写/数字/特殊字符/中文混排）：',
  'The quick brown fox jumps over the lazy dog.',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789',
  '!@#$%^&*()_+-=[]{}|;:\'",.<>/?~`',
  '中文：钩子模块钩子架构验证（钩子模块钩子）— 标点，。！？（）《》',
].join('\n');

const STUB_REPLY = '黄金主回复：已收到你的全部输入，会话链路正常。';

// ── stub provider：固定回复流（createStream 记录收到的 messages 供核对） ──
// 注意：必须按真实契约产出大写 StreamEvent（TEXT/STOP），
// OutputRouter.route 只认大写 type —— 第一次跑用错格式导致全链路静默失效。
const seenMessages: unknown[][] = [];
const createStream = async function* (messages: unknown[]) {
  seenMessages.push(messages as unknown[]);
  yield { type: 'TEXT', content: STUB_REPLY };
  yield { type: 'STOP', reason: 'end_turn' };
};
const provider = {
  getProviderType: () => 'deepseek',
  getModel: () => 'deepseek-chat',
  getCapabilities: () => ({ vision: false }),
  setThinking: () => {},
  createStream,
} as unknown as Provider;

// ── 真实存储（纯文件系统，无外部依赖） ──
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-session-'));
const conversationStore = new ConversationStore();
const eventStore = new EventStore();
const statsManager = new StatsManager();
const summaryStore = new SummaryStore();

// ── 外部服务 stub（参照 loop-integration.test.ts makeServices） ──
const toolRegistry = {
  register: () => {},
  getToolDefinitions: () => [],
  getAll: () => [],
};
const flowRegistry = { getActive: () => null };
const onStatusLog: Array<[string, string]> = [];
const compressor = { compress: async () => null };
const orchestrator = {};
const toolExecutor = {};
// 轻量 composer：模拟真实 compose 的核心行为——把 userInput 注入 messages
const contextComposer = {
  compose: async (opts: { userInput: string; history: unknown[]; historySummary?: string }) => {
    const userMsg = { role: 'user', content: [{ type: 'text' as const, text: opts.userInput }] };
    return {
      messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'pre-turn' }] }, userMsg],
      zoneBreakdown: { total: 123 },
    };
  },
};

const services = {
  provider,
  contextComposer,
  compressor,
  orchestrator,
  toolExecutor,
  toolRegistry,
  conversationStore,
  eventStore,
  statsManager,
  summaryStore,
  flowRegistry,
  outputHandler: { onStatus: (msg: string, level: string) => onStatusLog.push([level, msg]) },
} as unknown as AgentLoopServices;

async function main() {
  console.log('══════ 黄金主测试 · 会话处理全链路 ══════\n');
  // 退出前清理临时会话目录
  process.on('exit', () => { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  console.log(`【输入】${INPUT.split('\n').length} 行 / ${INPUT.length} 字符：`);
  console.log(INPUT);
  console.log('');

  const loop = new AgentLoop(services, { sessionDir, maxContextTokens: 128000 });
  try {
    await loop.run(INPUT);
  } catch (err) {
    console.error('✗ run() 异常：', (err as Error)?.message ?? err);
  }

  console.log('──── 输出快照 ────\n');
  console.log(`会话目录：${sessionDir}`);
  console.log(`落盘文件：${fs.readdirSync(sessionDir).sort().join(', ') || '(空!)'}\n`);

  // 1. conversation.jsonl
  const convRaw = fs.existsSync(path.join(sessionDir, 'conversation.jsonl'))
    ? fs.readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8').trim()
    : '';
  const convLines = convRaw ? convRaw.split('\n') : [];
  console.log(`[1] conversation.jsonl：${convLines.length} 行`);
  convLines.forEach((l, i) => {
    const m = JSON.parse(l);
    const text = Array.isArray(m.content)
      ? m.content.map((c: { type: string; text?: string }) => c.type === 'text' ? c.text : `[${c.type}]`).join('')
      : (typeof m.content === 'string' ? m.content : (m.content.type === 'text' ? m.content.text : JSON.stringify(m.content)));
    console.log(`    行${i + 1} role=${m.role} → ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  });

  // 2. 全量存档
  const fullRaw = fs.existsSync(path.join(sessionDir, 'conversation_full.jsonl'))
    ? fs.readFileSync(path.join(sessionDir, 'conversation_full.jsonl'), 'utf-8').trim()
    : '';
  console.log(`[2] conversation_full.jsonl：${fullRaw ? fullRaw.split('\n').length : 0} 行`);

  // 3. 事件
  const evRaw = fs.existsSync(path.join(sessionDir, 'events.jsonl'))
    ? fs.readFileSync(path.join(sessionDir, 'events.jsonl'), 'utf-8').trim()
    : '';
  const evLines = evRaw ? evRaw.split('\n') : [];
  console.log(`[3] events.jsonl：${evLines.length} 行`);
  for (const l of evLines) {
    const e = JSON.parse(l);
    console.log(`    事件 type=${e.type} ${e.type === 'user_input' ? `content=${String(e.content).slice(0, 60)}…` : ''}${e.type === 'stop' ? `reason=${e.reason}` : ''}`);
  }

  // 4. stats
  console.log(`[4] stats.json：${fs.existsSync(path.join(sessionDir, 'stats.json')) ? fs.readFileSync(path.join(sessionDir, 'stats.json'), 'utf-8').replace(/\n\s*/g, ' ') : '(无)'}`);

  // 5. summary
  const sumFile = path.join(sessionDir, 'summary.json');
  console.log(`[5] summary：${fs.existsSync(sumFile) ? fs.readFileSync(sumFile, 'utf-8').slice(0, 80) : '(无——未触发压缩，符合预期)'}`);

  // 6. createStream 收到的 messages（验证输入进入上下文）
  console.log(`[6] createStream 调用 ${seenMessages.length} 次；收到的 messages ${seenMessages[0]?.length ?? 0} 条：`);
  const lastMsg = seenMessages[0]?.[seenMessages[0].length - 1] as { role?: string; content?: Array<{ type: string; text?: string }> };
  if (lastMsg) {
    const lastText = lastMsg.content?.map((c) => c.text ?? '').join('');
    console.log(`    最后一条 role=${lastMsg.role}，文本前 60 字：${String(lastText ?? '').slice(0, 60)}`);
  }

  // 7. onStatus 事件流（观察压缩/警告）
  console.log(`[7] onStatus 事件 ${onStatusLog.length} 条：`);
  for (const [level, msg] of onStatusLog) console.log(`    [${level}] ${msg}`);

  // ── 黄金断言（预测 vs 实际） ──
  console.log('\n──── 预测对照 ────');
  /** 兼容单对象/数组 content 的文本提取 */
  const msgText = (m: { content: unknown }): string => {
    const c = m.content as { type: string; text?: string } | Array<{ type: string; text?: string }> | string;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('');
    return c?.type === 'text' ? (c.text ?? '') : '';
  };
  const checks: Array<[string, boolean, string]> = [
    ['conversation.jsonl 恰 2 行（user + assistant）', convLines.length === 2, `实际 ${convLines.length} 行`],
    ['行1 = user 且文本 === 输入原文（逐字完整）', convLines.length > 0 && JSON.parse(convLines[0]).role === 'user' && msgText(JSON.parse(convLines[0])) === INPUT, '逐字比对（含特殊字符/中文）'],
    ['行2 = assistant 且文本 === stub 固定回复', convLines.length > 1 && JSON.parse(convLines[1]).role === 'assistant' && msgText(JSON.parse(convLines[1])) === STUB_REPLY, ''],
    ['events 含 user_input（content=输入）', evLines.some((l) => JSON.parse(l).type === 'user_input'), ''],
    ['events 含 text（流式输出事件）', evLines.some((l) => JSON.parse(l).type === 'text' && JSON.parse(l).content === STUB_REPLY), ''],
    ['events 含 stop（reason=end_turn）', evLines.some((l) => JSON.parse(l).type === 'stop' && JSON.parse(l).reason === 'end_turn'), ''],
    ['stats.turn_count = 1', fs.existsSync(path.join(sessionDir, 'stats.json')) && JSON.parse(fs.readFileSync(path.join(sessionDir, 'stats.json'), 'utf-8')).turn_count === 1, ''],
    ['createStream 恰 1 次（无 7 次回归）', seenMessages.length === 1, `实际 ${seenMessages.length} 次`],
    ['createStream messages 末条含输入原文', lastMsg?.content?.some((c) => c.text === INPUT) ?? false, ''],
  ];
  let pass = 0;
  for (const [label, ok, note] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}${note ? `（${note}）` : ''}`);
    if (ok) pass++;
  }
  console.log(`\n通过 ${pass}/${checks.length} 项`);
}

main().catch((e) => { console.error(e); process.exit(1); });
