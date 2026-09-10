// ============================================================
// UI 协议层 — 知识库域测试
// ============================================================
// 覆盖 kb.get / kb.setEnabled / kb.setZone4 三条路径，重点验证：
//  1. 依赖未注入（getKb 返回 null）时的降级行为
//  2. 开关切换后快照反映真实状态
//  3. 参数校验与方法能力缺失时的错误语义
//  4. 开关写入同步持久化配置（kb.enabled / kb.zone4），且缺
//     configCenter 时明确报错（写入类依赖缺失不静默降级）
//
// 依赖用结构化 fake（KnowledgeBaseLike / ConfigWriterLike），
// 不碰真实文件系统。
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createKbDomain, type KnowledgeBaseLike, type ConfigWriterLike } from './kb.js';
import type { UiResponse, KnowledgeBaseState } from '../types.js';

/** 可观测的知识库 fake：记录 enable/disable/setZone4Enabled 调用 */
function makeKb(initial: KnowledgeBaseState = { enabled: true, zone4Enabled: true }) {
  const state = { ...initial };
  const calls: string[] = [];
  const kb: KnowledgeBaseLike & { calls: string[] } = {
    calls,
    get enabled() { return state.enabled; },
    get zone4Enabled() { return state.zone4Enabled; },
    enable() { calls.push('enable'); state.enabled = true; },
    disable() { calls.push('disable'); state.enabled = false; },
    setZone4Enabled(v: boolean) { calls.push(`setZone4:${v}`); state.zone4Enabled = v; },
  };
  return kb;
}

/** 可观测的配置写入器 fake：记录 set 调用，save 可注入失败场景 */
function makeConfigWriter(opts?: { saveError?: boolean }) {
  const writes: Array<{ path: string; value: unknown }> = [];
  const writer: ConfigWriterLike & { writes: Array<{ path: string; value: unknown }> } = {
    writes,
    set(path, value) { writes.push({ path, value }); },
    save: async () => {
      if (opts?.saveError) throw new Error('disk full');
    },
  };
  return writer;
}

function setup(
  getKb: () => KnowledgeBaseLike | null,
  configCenter?: ConfigWriterLike,
  getComposerConditions?: () => Set<string> | null,
) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('kb', createKbDomain({ getKb, configCenter, getComposerConditions }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const wait = async (id: string, timeout = 3000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  return { client, wait };
}

describe('知识库域', () => {
  describe('kb.get', () => {
    it('依赖未注入时降级为全开默认值（不抛错，UI 可正常渲染）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 'g1', method: 'kb.get' });
      const resp = await wait('g1');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ kb: { enabled: true, zone4Enabled: true } });
    });

    it('注入后反映真实开关状态', async () => {
      const { client, wait } = setup(() => makeKb({ enabled: false, zone4Enabled: true }));
      client.send({ kind: 'request', id: 'g2', method: 'kb.get' });
      const resp = await wait('g2');
      expect((resp.result as any).kb).toEqual({ enabled: false, zone4Enabled: true });
    });
  });

  describe('kb.setEnabled', () => {
    it('关闭总开关 → 返回新快照且真实调用了 disable', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 's1', method: 'kb.setEnabled', params: { enabled: false } });
      const resp = await wait('s1');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ ok: true, kb: { enabled: false, zone4Enabled: true } });
      expect(kb.calls).toEqual(['disable']);
    });

    it('重新开启 → 调用 enable', async () => {
      const kb = makeKb({ enabled: false, zone4Enabled: false });
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 's2', method: 'kb.setEnabled', params: { enabled: true } });
      const resp = await wait('s2');
      expect(resp.result).toEqual({ ok: true, kb: { enabled: true, zone4Enabled: false } });
      expect(kb.calls).toEqual(['enable']);
    });

    it('非 boolean 参数 → 报错（避免 undefined 被当成 false 静默关库）', async () => {
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => makeKb(), writer);
      client.send({ kind: 'request', id: 's3', method: 'kb.setEnabled', params: { enabled: 'yes' } });
      const resp = await wait('s3');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('requires boolean');
    });

    it('缺少 enabled 参数 → 报错', async () => {
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => makeKb(), writer);
      client.send({ kind: 'request', id: 's4', method: 'kb.setEnabled', params: {} });
      const resp = await wait('s4');
      expect(resp.ok).toBe(false);
    });

    it('依赖未注入 → 报错（写入类操作不做静默降级）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 's5', method: 'kb.setEnabled', params: { enabled: true } });
      const resp = await wait('s5');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('not available');
    });

    it('开关写入同步持久化 kb.enabled（配置与对象双写对齐）', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 's6', method: 'kb.setEnabled', params: { enabled: false } });
      const resp = await wait('s6');
      expect(resp.ok).toBe(true);
      expect(writer.writes).toContainEqual({ path: 'kb.enabled', value: false });
      expect(kb.enabled).toBe(false);
    });

    it('缺 configCenter → 明确报错（写入类依赖缺失不静默忽略）', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const { client, wait } = setup(() => kb);
      client.send({ kind: 'request', id: 's7', method: 'kb.setEnabled', params: { enabled: false } });
      const resp = await wait('s7');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('configCenter');
    });

    it('持久化失败 → 响应不受阻断（对象开关已生效，失败仅留痕）', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const writer = makeConfigWriter({ saveError: true });
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 's8', method: 'kb.setEnabled', params: { enabled: false } });
      const resp = await wait('s8');
      expect(resp.ok).toBe(true);
      expect(kb.enabled).toBe(false);
      expect(writer.writes).toContainEqual({ path: 'kb.enabled', value: false });
    });
  });

  describe('kb.setZone4', () => {
    it('切换 Zone4 并只影响 zone4Enabled（总开关不变）', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 'z1', method: 'kb.setZone4', params: { enabled: false } });
      const resp = await wait('z1');
      expect(resp.result).toEqual({ ok: true, kb: { enabled: true, zone4Enabled: false } });
      expect(kb.calls).toEqual(['setZone4:false']);
    });

    it('知识库不支持 setZone4Enabled → 明确报错而非静默忽略', async () => {
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => ({ enabled: true, zone4Enabled: true }), writer);
      client.send({ kind: 'request', id: 'z2', method: 'kb.setZone4', params: { enabled: true } });
      const resp = await wait('z2');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('setZone4Enabled not supported');
    });

    it('Zone4 开关写入同步持久化 kb.zone4', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: true });
      const writer = makeConfigWriter();
      const { client, wait } = setup(() => kb, writer);
      client.send({ kind: 'request', id: 'z3', method: 'kb.setZone4', params: { enabled: true } });
      const resp = await wait('z3');
      expect(resp.ok).toBe(true);
      expect(writer.writes).toContainEqual({ path: 'kb.zone4', value: true });
    });

    it('Zone4 开关同步 composer 运行时条件（立即生效，吸收 TUI 本地补丁）', async () => {
      const kb = makeKb({ enabled: true, zone4Enabled: false });
      const writer = makeConfigWriter();
      const conds = new Set<string>();
      const { client, wait } = setup(() => kb, writer, () => conds);
      // 开启 → 条件加入
      client.send({ kind: 'request', id: 'z4', method: 'kb.setZone4', params: { enabled: true } });
      await wait('z4');
      expect(conds.has('zone4_enabled')).toBe(true);
      // 关闭 → 条件移除
      client.send({ kind: 'request', id: 'z5', method: 'kb.setZone4', params: { enabled: false } });
      await wait('z5');
      expect(conds.has('zone4_enabled')).toBe(false);
    });
  });

  it('未知 action → UNKNOWN_METHOD', async () => {
    const { client, wait } = setup(() => makeKb());
    client.send({ kind: 'request', id: 'u1', method: 'kb.destroy' });
    const resp = await wait('u1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('UNKNOWN_METHOD');
  });
});
