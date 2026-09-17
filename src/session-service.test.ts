/**
 * SessionService 单测 —— 会话主控权收归内核的唯一入口。
 *
 * 覆盖（计划第七节用例）：
 *   ① 显式 id 归属校验（fail-closed，绝不回落他人会话）
 *   ② identity → sessionId 解析 + 持久化复用（conversation 多会话 / 群线程派生）
 *   ③ 死会话重建（conversation 一律新建 / single 回落本渠道最近）
 *   ④ 重启恢复：快照 → 本渠道最近 → fail-closed（绝不回落全局最近）
 *   ⑤ loop 注册表 LRU 驱逐（最近使用保活）
 *   ⑥ shared 伪会话（__shared__ 键共享 loop）
 *   ⑦ 旧飞书映射迁移（migrateFeishuLegacy：归属校验 + key 转换 + 幂等）
 *   ⑧ 每渠道策略隔离 + bindChannel/registerMainLoop/runTask
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './memory/session.js';
import {
  SessionService,
  type ChannelSessionPolicy,
  type SessionLoopRunner,
  type SessionOutputHandler,
  type SessionAgentFactory,
} from './session-service.js';
import {
  registerChannelPrefix,
  unregisterChannelPrefixes,
  loadRestartSnapshot,
  clearRestartSnapshot,
  clearChannelSessionGetters,
  getChannelSessionRegistry,
} from './session-channel.js';

const TEST_PREFIXES = ['feishu_', 'tui_', 'claw_', 'webui_', 'ui_'];

interface FakeLoopRec {
  sessionId?: string;
  channel?: string;
  runInputs: string[];
  outputHandler: SessionOutputHandler | null;
}

/** 假 agent 工厂：记录 createAgent 调用，loop.run 模拟输出一段文本 */
function createFakeAgentFactory(recs: FakeLoopRec[]): SessionAgentFactory {
  return {
    async createAgent(options) {
      const rec: FakeLoopRec = {
        sessionId: options.sessionId,
        channel: options.channel,
        runInputs: [],
        outputHandler: options.outputHandler ?? null,
      };
      recs.push(rec);
      const loop: SessionLoopRunner = {
        async run(input) {
          rec.runInputs.push(input);
          rec.outputHandler?.onText?.(`reply-to:${input.slice(0, 12)}`);
        },
        setOutputHandler(h) { rec.outputHandler = h; },
      };
      return { loop };
    },
  };
}

interface TestEnv {
  root: string;
  sessionsRoot: string;
  identityDir: string;
  legacyFile: string;
  manager: SessionManager;
  service: SessionService;
  recs: FakeLoopRec[];
}

/** 独立临时环境：sessions 根 + identity 目录 + 旧飞书文件全隔离 */
function makeEnv(opts: { policies?: Record<string, ChannelSessionPolicy>; loopCacheMax?: number } = {}): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-ss-'));
  roots.push(root);
  const sessionsRoot = path.join(root, 'sessions');
  const identityDir = path.join(root, 'agent');
  const legacyFile = path.join(root, 'legacy.json');
  const manager = new SessionManager(root, sessionsRoot);
  const recs: FakeLoopRec[] = [];
  const service = new SessionService({
    sessionManager: manager,
    agentFactory: createFakeAgentFactory(recs),
    policies: opts.policies,
    identityDir,
    legacyFeishuFile: legacyFile,
    loopCacheMax: opts.loopCacheMax,
  });
  return { root, sessionsRoot, identityDir, legacyFile, manager, service, recs };
}

/** 同一环境再造实例（共享 identityDir / sessions），模拟重启后的新 Service */
function makeService(env: TestEnv, opts: { policies?: Record<string, ChannelSessionPolicy> } = {}): SessionService {
  return new SessionService({
    sessionManager: env.manager,
    agentFactory: createFakeAgentFactory(env.recs),
    policies: opts.policies,
    identityDir: env.identityDir,
    legacyFeishuFile: env.legacyFile,
  });
}

const roots: string[] = [];
beforeEach(() => {
  roots.length = 0;
  clearRestartSnapshot();
  clearChannelSessionGetters();
  unregisterChannelPrefixes(TEST_PREFIXES);
});
afterEach(() => {
  unregisterChannelPrefixes(TEST_PREFIXES);
  clearRestartSnapshot();
  clearChannelSessionGetters();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('① 显式 sessionId 归属校验（fail-closed）', () => {
  it('归属正确的显式 id 原样返回', async () => {
    registerChannelPrefix('tui_', 'tui');
    const { service } = makeEnv();
    expect(await service.resolveSession('tui', { sessionId: 'tui_abc' })).toBe('tui_abc');
  });

  it('归属错误的显式 id → 新建本渠道会话，绝不回落他人会话', async () => {
    registerChannelPrefix('tui_', 'tui');
    registerChannelPrefix('feishu_', 'feishu');
    const { service } = makeEnv();
    const sid = await service.resolveSession('tui', { sessionId: 'feishu_xxx' });
    expect(sid).not.toBe('feishu_xxx');
    expect(sid.startsWith('tui_')).toBe(true);
  });

  it('explicit 策略缺 sessionId → fail-closed 新建（不把别渠道会话喂过来）', async () => {
    registerChannelPrefix('tui_', 'tui');
    const { service } = makeEnv({ policies: { tui: { sessionKey: 'explicit' } } });
    const sid = await service.resolveSession('tui', { userId: 'u1' });
    expect(sid.startsWith('tui_')).toBe(true);
  });
});

describe('② identity → sessionId 解析与持久化复用', () => {
  it('同 identity 复用同一会话；不同用户/群/线程各自独立', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const { service } = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });

    const a1 = await service.resolveSession('feishu', { identity: { userId: 'u1' } });
    const a2 = await service.resolveSession('feishu', { identity: { userId: 'u1' } });
    expect(a2).toBe(a1); // 未物化也不算死会话 → 复用

    const b = await service.resolveSession('feishu', { identity: { userId: 'u2' } });
    expect(b).not.toBe(a1);

    const g = await service.resolveSession('feishu', { identity: { isGroup: true, chatId: 'g1' } });
    const gt = await service.resolveSession('feishu', { identity: { isGroup: true, chatId: 'g1', threadId: 't1' } });
    expect(g).not.toBe(a1);
    expect(gt).not.toBe(g);
  });

  it('映射持久化形状：user:<id> / chat:<chatId> / chat:<chatId>:thread:<threadId>', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const { service } = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });

    const a = await service.resolveSession('feishu', { identity: { userId: 'u1' } });
    const g = await service.resolveSession('feishu', { identity: { isGroup: true, chatId: 'g1' } });
    const gt = await service.resolveSession('feishu', { identity: { isGroup: true, chatId: 'g1', threadId: 't1' } });

    const snap = service.identitySnapshot();
    expect(snap.feishu).toEqual({
      'user:u1': a,
      'chat:g1': g,
      'chat:g1:thread:t1': gt,
    });
  });

  it('重启后（新实例读同一身份文件 + 目录仍在）复用同一会话', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });
    const a1 = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });
    fs.mkdirSync(env.manager.getSessionDir(a1), { recursive: true }); // 物化（真实会话有目录）

    const svc2 = makeService(env, { policies: { feishu: { sessionKey: 'conversation' } } });
    const a2 = await svc2.resolveSession('feishu', { identity: { userId: 'u1' } });
    expect(a2).toBe(a1);
  });

  it('identity 文件损坏 → 降级为空映射，不抛错', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(path.join(env.identityDir, 'session-identity.json'), '{oops', 'utf-8');

    const sid = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });
    expect(sid.startsWith('feishu_')).toBe(true); // 视为空映射 → 正常新建
  });

  it('并发首消息（多用户同时）→ 不丢映射：重启后逐一复用', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });

    // 10 个用户同时发首条消息 → 并发 loadIdentity + resolve + persist
    const sids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        env.service.resolveSession('feishu', { identity: { userId: `u${i}` } }),
      ),
    );
    expect(new Set(sids).size).toBe(10); // 各自独立会话

    // 内存快照全量在
    expect(Object.keys(env.service.identitySnapshot().feishu ?? {})).toHaveLength(10);

    // 物化后重启（新实例）：并发解析 → 全部命中文件映射，逐一复用
    for (const sid of sids) fs.mkdirSync(env.manager.getSessionDir(sid), { recursive: true });
    const svc2 = makeService(env, { policies: { feishu: { sessionKey: 'conversation' } } });
    const reborn = await Promise.all(
      sids.map((sid, i) =>
        svc2.resolveSession('feishu', { identity: { userId: `u${i}` } }).then((s) => ({ sid, s })),
      ),
    );
    for (const { sid, s } of reborn) expect(s).toBe(sid);
  });
});

describe('③ 死会话重建', () => {
  it('conversation 策略：目录被清理 → 一律新建，不回落他人会话', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv({ policies: { feishu: { sessionKey: 'conversation' } } });

    // 预置另一个 feishu 会话（验证不回落它）
    const other = await env.manager.create('normal', 'feishu');
    const a1 = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });
    fs.mkdirSync(env.manager.getSessionDir(a1), { recursive: true }); // 物化
    fs.rmSync(env.manager.getSessionDir(a1), { recursive: true, force: true }); // 模拟 cleanup

    const svc2 = makeService(env, { policies: { feishu: { sessionKey: 'conversation' } } });
    const a2 = await svc2.resolveSession('feishu', { identity: { userId: 'u1' } });
    expect(a2).not.toBe(a1);
    expect(a2).not.toBe(other.id);
    expect(a2.startsWith('feishu_')).toBe(true);
  });

  it('single 策略：目录被清理 → 回落本渠道最近会话', async () => {
    registerChannelPrefix('claw_', 'claw');
    const env = makeEnv({ policies: { claw: { sessionKey: 'single' } } });

    // 预置一个物化的 claw 会话（最近的）
    const recent = await env.manager.create('normal', 'claw');
    // identity 文件预置：claw:default 指向一个已删除的会话
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.identityDir, 'session-identity.json'),
      JSON.stringify({ claw: { default: 'claw_dead_sid' } }),
      'utf-8',
    );

    const svc = makeService(env, { policies: { claw: { sessionKey: 'single' } } });
    const sid = await svc.resolveSession('claw', { userId: 'x' });
    expect(sid).toBe(recent.id); // 死会话 → getLatestByChannel('claw') → recent
  });

  it('single 策略：死会话且本渠道无任何存量 → 新建（绝不回落全局最近）', async () => {
    registerChannelPrefix('claw_', 'claw');
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv({ policies: { claw: { sessionKey: 'single' } } });
    await env.manager.create('normal', 'feishu'); // 全局唯一存量是 feishu 会话
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.identityDir, 'session-identity.json'),
      JSON.stringify({ claw: { default: 'claw_dead_sid' } }),
      'utf-8',
    );

    const svc = makeService(env, { policies: { claw: { sessionKey: 'single' } } });
    const sid = await svc.resolveSession('claw', { userId: 'x' });
    expect(sid.startsWith('claw_')).toBe(true);
    expect(sid).not.toMatch(/^feishu_/); // 不回落全局最近
  });
});

describe('④ 重启恢复：快照 → 最近 → fail-closed', () => {
  it('快照优先：快照指向的会话存在 → 恢复它，而非最近', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const { service, manager } = makeEnv();
    const older = await manager.create('normal', 'feishu');
    const newer = await manager.create('normal', 'feishu');
    loadRestartSnapshot(JSON.stringify({ feishu: older.id }));

    const sid = await service.restoreSession('feishu');
    expect(sid).toBe(older.id);
    expect(sid).not.toBe(newer.id);
  });

  it('无快照 → 取本渠道最近会话', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const { service, manager } = makeEnv();
    await manager.create('normal', 'feishu');

    const sid = await service.restoreSession('feishu');
    expect(sid?.startsWith('feishu_')).toBe(true);
  });

  it('fail-closed：本渠道无存量会话 → 新建，绝不回落全局最近（2026-09-17 串台事故回归）', async () => {
    registerChannelPrefix('tui_', 'tui');
    registerChannelPrefix('feishu_', 'feishu');
    const { service, manager } = makeEnv();
    await manager.create('normal', 'tui'); // 全局最近是 tui 会话

    const sid = await service.restoreSession('feishu');
    expect(sid?.startsWith('feishu_')).toBe(true);
    expect(sid).not.toMatch(/^tui_/);
  });

  it('快照指向的会话已不存在 → 跳过快照，回退最近', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const { service, manager } = makeEnv();
    const recent = await manager.create('normal', 'feishu');
    loadRestartSnapshot(JSON.stringify({ feishu: 'feishu_ghost' })); // 目录不存在

    const sid = await service.restoreSession('feishu');
    expect(sid).toBe(recent.id);
  });

  it('bindChannel：恢复 + 注册 getter + single 策略持久化 default 键', async () => {
    registerChannelPrefix('claw_', 'claw');
    const env = makeEnv({ policies: { claw: { sessionKey: 'single' } } });
    const recent = await env.manager.create('normal', 'claw');

    await env.service.bindChannel('claw');
    expect(env.service.getCurrentSessionId('claw')).toBe(recent.id);
    expect(env.service.identitySnapshot().claw?.default).toBe(recent.id);
    expect(getChannelSessionRegistry().get('claw')?.()).toBe(recent.id);
  });

  it('快照指向别渠道会话（目录存在）→ 归属校验不通过 → 回落本渠道最近（防串台）', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    registerChannelPrefix('tui_', 'tui');
    const { service, manager } = makeEnv();
    const recent = await manager.create('normal', 'feishu');
    const foreign = await manager.create('normal', 'tui'); // 快照却指向 tui 会话（目录存在）
    loadRestartSnapshot(JSON.stringify({ feishu: foreign.id }));

    const sid = await service.restoreSession('feishu');
    expect(sid).toBe(recent.id);
    expect(sid).not.toMatch(/^tui_/);
  });

  it('restoreSession：channel 为空 → undefined', async () => {
    const { service } = makeEnv();
    expect(await service.restoreSession('')).toBeUndefined();
  });
});

describe('⑤ loop 注册表 LRU 驱逐', () => {
  it('超过上限驱逐最久未用的；最近使用保活', async () => {
    const { service, recs } = makeEnv({ loopCacheMax: 2 });
    await service.getOrCreateLoop('ch1', 'ch1_s1'); // order: [s1]
    await service.getOrCreateLoop('ch1', 'ch1_s2'); // order: [s1, s2]
    await service.getLoopBySession('ch1', 'ch1_s1'); // touch s1 → [s2, s1]
    await service.getOrCreateLoop('ch1', 'ch1_s3'); // push s3 → [s2,s1,s3] → shift s2

    expect(recs).toHaveLength(3);
    expect(service.getLoopBySession('ch1', 'ch1_s2')).toBeNull(); // s2 被驱逐
    expect(service.getLoopBySession('ch1', 'ch1_s1')).not.toBeNull(); // s1 保活
    expect(service.getLoopBySession('ch1', 'ch1_s3')).not.toBeNull();
  });
});

describe('⑥ shared 伪会话（多对话共享一个 loop）', () => {
  it('sharedLoop 渠道：不同 sessionId 复用同一 loop（键 __shared__）', async () => {
    const env = makeEnv({ policies: { feishu: { sessionKey: 'conversation', sharedLoop: true } } });
    const l1 = await env.service.getOrCreateLoop('feishu', 'feishu_a');
    const l2 = await env.service.getOrCreateLoop('feishu', 'feishu_b');

    expect(env.recs).toHaveLength(1); // 只创建一个 agent
    expect(l2).toBe(l1);
    expect(env.service.getLoopBySession('feishu', 'feishu_a')).toBe(l1);
    expect(env.service.getLoopBySession('feishu', 'feishu_b')).toBe(l1);
    expect(env.recs[0].sessionId).toBe('feishu_a'); // 建 loop 用首个 sessionId 作上下文物化锚
  });
});

describe('⑦ 旧飞书映射迁移（migrateFeishuLegacy）', () => {
  it('仅当身份文件不存在时导入一次；归属校验 + key 转换 + 幂等', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    registerChannelPrefix('tui_', 'tui');
    const env = makeEnv();
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(
      env.legacyFile,
      JSON.stringify({
        chatId: 'g1',
        isGroup: true,
        sessions: {
          feishu_dm_u1: 'feishu_sid_dm1',
          feishu_group_g1: 'feishu_sid_grp1',
          feishu_group_g1_thread_t1: 'feishu_sid_grp1_thread',
          feishu_shared: '__shared__',          // 伪会话 → 丢弃
          feishu_dm_other: 'tui_sid_other',     // 值不归属 feishu → 丢弃
          legacy_key: 'feishu_sid_unknown',     // key 无法转换 → 丢弃
        },
      }),
      'utf-8',
    );

    const imported = await env.service.migrateFeishuLegacy();
    expect(imported).toBe(3);
    expect(env.service.identitySnapshot().feishu).toEqual({
      'user:u1': 'feishu_sid_dm1',
      'chat:g1': 'feishu_sid_grp1',
      'chat:g1:thread:t1': 'feishu_sid_grp1_thread',
    });

    // 幂等：身份文件已写入 → 二次调用直接 0
    expect(await env.service.migrateFeishuLegacy()).toBe(0);
  });

  it('迁移：旧文件不存在 → 0（首次启动）', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    expect(await env.service.migrateFeishuLegacy()).toBe(0);
  });

  it('迁移：旧文件损坏 → 0', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(env.legacyFile, 'not-json', 'utf-8');
    expect(await env.service.migrateFeishuLegacy()).toBe(0);
  });

  it('迁移：空身份 key（feishu_dm_ / feishu_group_ / 空线程）→ 丢弃，不产生空键', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    fs.mkdirSync(env.identityDir, { recursive: true });
    fs.writeFileSync(
      env.legacyFile,
      JSON.stringify({
        sessions: {
          feishu_dm_: 'feishu_sid_bad1',            // 空用户 id → 丢弃
          feishu_group_: 'feishu_sid_bad2',         // 空群 id → 丢弃
          feishu_group_g1_thread_: 'feishu_sid_bad3', // 空线程 id → 丢弃
          feishu_dm_u9: 'feishu_sid_ok',            // 正常 → 保留
        },
      }),
      'utf-8',
    );

    expect(await env.service.migrateFeishuLegacy()).toBe(1);
    expect(env.service.identitySnapshot().feishu).toEqual({ 'user:u9': 'feishu_sid_ok' });
  });
});

describe('⑧ 每渠道策略隔离 + 运行通道', () => {
  it('conversation 与 single 渠道互不干扰', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    registerChannelPrefix('claw_', 'claw');
    const { service } = makeEnv({
      policies: { feishu: { sessionKey: 'conversation' }, claw: { sessionKey: 'single' } },
    });

    const f1 = await service.resolveSession('feishu', { identity: { userId: 'u1' } });
    const f2 = await service.resolveSession('feishu', { identity: { userId: 'u2' } });
    expect(f1).not.toBe(f2); // conversation 多会话

    const c1 = await service.resolveSession('claw', { userId: 'x' });
    const c2 = await service.resolveSession('claw', { userId: 'y' });
    expect(c2).toBe(c1); // single 恒 default 键
  });

  it('registerMainLoop：预注册主 loop + 当前会话 + 快照 getter', async () => {
    const env = makeEnv();
    const loop: SessionLoopRunner = { run: async () => {}, setOutputHandler: () => {} };
    env.service.registerMainLoop('tui', 'tui_main', loop);
    expect(env.service.getCurrentSessionId('tui')).toBe('tui_main');
    expect(env.service.getLoopBySession('tui', 'tui_main')).not.toBeNull();
    expect(getChannelSessionRegistry().get('tui')?.()).toBe('tui_main');
  });

  it('runTask：查 loop 运行任务 → 收集输出 → deliver', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    const sid = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });
    await env.service.getOrCreateLoop('feishu', sid);

    const delivered: string[] = [];
    await env.service.runTask({
      channel: 'feishu',
      taskName: 'daily-report',
      sessionId: sid,
      deliver: async (_s, text) => { delivered.push(text); },
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('reply-to:');
  });

  it('runTask：查不到 loop（会话尚无消息）→ 不新建、不 deliver', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    const sid = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });

    let delivered = false;
    await env.service.runTask({
      channel: 'feishu',
      taskName: 'nobody-home',
      sessionId: sid,
      deliver: async () => { delivered = true; },
    });
    expect(delivered).toBe(false);
    expect(env.recs).toHaveLength(0);
  });

  it('runTask：无 sessionId 且渠道无当前会话 → 不跑不 deliver', async () => {
    const env = makeEnv();
    let delivered = false;
    await env.service.runTask({
      channel: 'feishu',
      taskName: 'nobody-home',
      deliver: async () => { delivered = true; },
    });
    expect(delivered).toBe(false);
    expect(env.recs).toHaveLength(0);
  });

  it('runTask：无 sessionId 时回落渠道当前会话', async () => {
    registerChannelPrefix('feishu_', 'feishu');
    const env = makeEnv();
    const sid = await env.service.resolveSession('feishu', { identity: { userId: 'u1' } });
    await env.service.getOrCreateLoop('feishu', sid);

    const delivered: string[] = [];
    await env.service.runTask({
      channel: 'feishu',
      taskName: 'fallback-task',
      deliver: async (_s, text) => { delivered.push(text); },
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('reply-to:');
  });

  it('runTask：loop.run 抛错 → 不 deliver、异常不扩散', async () => {
    const env = makeEnv();
    const loop: SessionLoopRunner = {
      run: async () => { throw new Error('boom'); },
      setOutputHandler: () => {},
    };
    env.service.registerMainLoop('tui', 'tui_main', loop);

    let delivered = false;
    await expect(env.service.runTask({
      channel: 'tui',
      taskName: 'failing-task',
      sessionId: 'tui_main',
      deliver: async () => { delivered = true; },
    })).resolves.toBeUndefined();
    expect(delivered).toBe(false);
  });
});
