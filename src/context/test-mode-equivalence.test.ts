/**
 * 声明式「测试模式」≡ 手写「普通模式」—— 等价性锁定。
 *
 * 为什么要有这个测试：声明式通道此前**从未被真实使用过**（`modes/*.json` 0 个、
 * 生产代码 registerModeHook 0 次调用）⇒ 它是"没人走过的地基"。用「等价普通模式」
 * 的测试模式把它走通，**等价性本身就是验收标准**。
 *
 * 约束（用户 09-22 定）：不碰真实 `~/.agent` 配置 —— profile 从**临时目录**加载。
 * （loader 会顺带扫全局 `~/.agent/modes`，那是只读；所以断言用 toContain，
 *  不假设全局目录为空。）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NormalRouter } from './router.js';
import type { IContextRouter } from './router.js';
import { getRouterByName } from './profiles.js';
import { loadModeProfiles } from './mode-profile-loader.js';
import { listModeHookNames } from './mode-profile.js';
import { registerBuiltinModeHooks, HOOK_TIMESTAMP_PROBABILISTIC } from './builtin-mode-hooks.js';
import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import type { Message } from '../types.js';

const TS_SECTION = {
  name: 'timestamp', source: 'runtime:timestamp', priority: 7, type: 'runtime',
} as SectionEntry;

function ctxAt(timestamp: string, sessionDir: string): ResolverContext {
  return { timestamp, sessionDir } as unknown as ResolverContext;
}

/**
 * 造一个「等价普通模式」的声明式模式：临时项目目录里写 `.agent/modes/test-equiv.json`，
 * 经真实 loader 加载（这样 JSON 解析 / 注册表 / 钩子引用全都真的走一遍）。
 */
function loadTestMode(): IContextRouter {
  registerBuiltinModeHooks();
  const projectDir = mkdtempSync(path.join(tmpdir(), 'test-mode-'));
  try {
    const modesDir = path.join(projectDir, '.agent', 'modes');
    mkdirSync(modesDir, { recursive: true });
    writeFileSync(
      path.join(modesDir, 'test-equiv.json'),
      JSON.stringify({
        description: '等价普通模式的测试模式',
        toolBlacklist: ['reset_companion_session'],
        hooks: { beforeSection: HOOK_TIMESTAMP_PROBABILISTIC },
      }),
      'utf-8',
    );
    expect(loadModeProfiles(projectDir)).toContain('test-equiv');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
  const router = getRouterByName('test-equiv') as IContextRouter | undefined;
  expect(router).toBeDefined();
  return router as IContextRouter;
}

describe('声明式「测试模式」≡ 手写「普通模式」', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('静态面逐项相同：工具面 / 跳过清单 / 覆写 / 定时任务提示词', () => {
    const decl = loadTestMode();
    const normal = new NormalRouter();

    expect(decl.name).toBe('test-equiv');
    expect(decl.toolAllowlist).toEqual(normal.toolAllowlist);       // 都为空 ⇒ 全部工具可用
    expect(decl.toolBlacklist).toEqual(normal.toolBlacklist);       // 那条 reset_companion_session
    expect(decl.skipSections).toEqual(normal.skipSections);         // 都为空 ⇒ 不跳任何 section
    expect(decl.skipRuntimeSources).toEqual(normal.skipRuntimeSources);
    expect(decl.sourceOverrides).toEqual(normal.sourceOverrides);
    expect(decl.getTaskPrompt('t1')).toBe(normal.getTaskPrompt('t1'));
  });

  it('历史过滤行为相同（都原样放行）', () => {
    const history: Message[] = [
      { role: 'user', content: { type: 'text', text: 'a' } },
      { role: 'assistant', content: { type: 'text', text: 'b' } },
    ];
    expect(loadTestMode().filterHistory(history)).toEqual(new NormalRouter().filterHistory(history));
  });

  it('时间戳概率注入：命中/落空序列逐轮一致（同一套判定）', async () => {
    const decl = loadTestMode();
    const normal = new NormalRouter();
    // 随机数与时刻都按同一序列喂给两者：0 → 首次必中；0.9 → 1 分钟后落空；
    // 0.3 → 1 分钟后命中；0.999 → 命中后间隔 5 分钟 ⇒ 必中。
    const randoms = [0, 0.9, 0.3, 0.999];
    const times = ['2026-09-30 01:00', '2026-09-30 01:01', '2026-09-30 01:02', '2026-09-30 01:07'];

    const declResults: unknown[] = [];
    const normalResults: unknown[] = [];
    for (let i = 0; i < randoms.length; i++) {
      vi.spyOn(Math, 'random').mockReturnValue(randoms[i]);
      declResults.push(await decl.beforeSection?.(TS_SECTION, ctxAt(times[i], '/s/equiv-decl')));
      normalResults.push(await normal.beforeSection(TS_SECTION, ctxAt(times[i], '/s/equiv-normal')));
    }

    // undefined = 放行（注入时间戳文本）；null = 本轮跳过
    expect(declResults).toEqual(normalResults);
    expect(normalResults).toEqual([undefined, null, undefined, undefined]);
  });

  it('profile 引用的钩子确实已注册（取不到会静默退化成"不注入"，这条挡住它）', () => {
    registerBuiltinModeHooks();
    expect(listModeHookNames()).toContain(HOOK_TIMESTAMP_PROBABILISTIC);
  });

  it('已知缺口：声明式模式拿不到「入站消息时间锚点」(stampInboundMessage)', () => {
    const decl = loadTestMode();
    // 普通模式 2026-09-30 新增的能力；ModeProfile 没有对应钩子槽位 ⇒ 声明式模式
    // 发不出时间锚点。**这是待补的缺口**，补上后这条断言应改成"行为一致"。
    expect(decl.stampInboundMessage).toBeUndefined();
    expect(typeof new NormalRouter().stampInboundMessage).toBe('function');
  });
});
