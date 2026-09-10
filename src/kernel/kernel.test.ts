import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DisposableStore, toDisposable, noopDisposable } from './types.js';
import { HookBus } from './hook-bus.js';
import { PluginHost } from './plugin-host.js';
import type { HyPlugin, PluginContext } from './plugin-host.js';

// ─── DisposableStore ───────────────────────────────────────────────

describe('DisposableStore', () => {
  let store: DisposableStore;

  beforeEach(() => {
    store = new DisposableStore();
  });

  it('add 登记资源，dispose 全部释放', async () => {
    const a = vi.fn();
    const b = vi.fn();
    store.add(toDisposable(a));
    store.add(toDisposable(b));

    expect(store.size).toBe(2);
    await store.dispose();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });

  it('dispose 逆序释放（后注册的先释放）', async () => {
    const order: string[] = [];
    store.add(() => { order.push('first'); });
    store.add(() => { order.push('second'); });
    store.add(() => { order.push('third'); });

    await store.dispose();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('dispose 幂等：重复调用不再释放', async () => {
    const fn = vi.fn();
    store.add(toDisposable(fn));

    await store.dispose();
    await store.dispose();

    expect(fn).toHaveBeenCalledOnce();
    expect(store.isDisposed).toBe(true);
  });

  it('单个资源释放失败不阻断其余，结束后抛出最先遇到的错误', async () => {
    const after = vi.fn();
    store.add(() => { throw new Error('boom-1'); });
    store.add(toDisposable(after));
    store.add(() => { throw new Error('boom-2'); });

    // 逆序释放 ⇒ 最先遇到的是最后登记的 boom-2
    await expect(store.dispose()).rejects.toThrow('boom-2');
    // 异常隔离：其余资源仍然被释放
    expect(after).toHaveBeenCalledOnce();
  });

  it('已释放的 store 再 add 时立即释放该资源，防止泄漏', async () => {
    await store.dispose();
    const late = vi.fn();
    store.add(toDisposable(late));

    expect(late).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });

  it('add 支持裸函数形式并原样返回 Disposable 对象', async () => {
    const fn = vi.fn();
    const d = store.add(fn);
    expect(typeof d.dispose).toBe('function');
    await store.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('noopDisposable 释放为空操作', () => {
    expect(() => noopDisposable().dispose()).not.toThrow();
  });
});

// ─── HookBus ───────────────────────────────────────────────────────

interface TestHooks extends Record<string, unknown> {
  onTurnStart: { turn: number };
  beforeToolExecute: { calls: string[] };
}

describe('HookBus', () => {
  let bus: HookBus<TestHooks>;

  beforeEach(() => {
    bus = new HookBus<TestHooks>({ name: 'test-bus' });
  });

  it('emit 触发已注册的处理器', async () => {
    const h = vi.fn();
    bus.on('onTurnStart', h);

    await bus.emit('onTurnStart', { turn: 1 });

    expect(h).toHaveBeenCalledWith({ turn: 1 });
  });

  it('无订阅者时 emit 是安全空操作', async () => {
    await expect(bus.emit('onTurnStart', { turn: 1 })).resolves.toBeUndefined();
  });

  it('多个处理器按注册顺序串行执行', async () => {
    const order: string[] = [];
    bus.on('onTurnStart', async () => { order.push('a'); });
    bus.on('onTurnStart', async () => { order.push('b'); });
    bus.on('onTurnStart', async () => { order.push('c'); });

    await bus.emit('onTurnStart', { turn: 1 });

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('处理器可原地修改 payload，后续处理器可见（观察者语义）', async () => {
    bus.on('beforeToolExecute', (p) => { p.calls.push('write'); });
    bus.on('beforeToolExecute', (p) => { p.calls.push('bash'); });

    const payload = { calls: ['read'] };
    await bus.emit('beforeToolExecute', payload);

    expect(payload.calls).toEqual(['read', 'write', 'bash']);
  });

  it('disposer 只移除自己那一个订阅', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const da = bus.on('onTurnStart', a);
    bus.on('onTurnStart', b);

    da.dispose();
    await bus.emit('onTurnStart', { turn: 1 });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
    expect(bus.count('onTurnStart')).toBe(1);
  });

  it('异常隔离：单个钩子抛错不阻断后续钩子，也不冒泡', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();

    bus.on('onTurnStart', () => { throw new Error('hook boom'); });
    bus.on('onTurnStart', after);

    await expect(bus.emit('onTurnStart', { turn: 1 })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('onError 返回 abort 时中断后续钩子并抛出', async () => {
    const strict = new HookBus<TestHooks>({
      name: 'strict',
      onError: () => 'abort',
    });
    const after = vi.fn();
    strict.on('onTurnStart', () => { throw new Error('red line'); });
    strict.on('onTurnStart', after);

    await expect(strict.emit('onTurnStart', { turn: 1 })).rejects.toThrow('red line');
    expect(after).not.toHaveBeenCalled();
  });

  it('run 带 core 时，观察者可替换 payload（拦截器语义）', async () => {
    bus.on('beforeToolExecute', (p) => ({ calls: p.calls.filter((c) => c !== 'bash') }));
    bus.on('beforeToolExecute', (p) => ({ calls: [...p.calls, 'grep'] }));

    const result = await bus.run('beforeToolExecute', { calls: ['read', 'bash'] });

    expect(result.calls).toEqual(['read', 'grep']);
  });

  it('run 中观察者返回 undefined 表示不修改', async () => {
    bus.on('beforeToolExecute', () => undefined);
    const result = await bus.run('beforeToolExecute', { calls: ['read'] });

    expect(result.calls).toEqual(['read']);
  });

  it('run 中抛错的观察者被跳过，其余仍然生效', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on('beforeToolExecute', () => { throw new Error('boom'); });
    bus.on('beforeToolExecute', (p) => ({ calls: [...p.calls, 'ok'] }));

    const result = await bus.run('beforeToolExecute', { calls: [] });

    expect(result.calls).toEqual(['ok']);
    spy.mockRestore();
  });

  it('run 传入 core 时：观察者先跑，再跑 core', async () => {
    const order: string[] = [];
    bus.on('onTurnStart', () => { order.push('observer'); });
    await bus.run('onTurnStart', { turn: 1 }, (p) => { order.push('core'); return p; });

    expect(order).toEqual(['observer', 'core']);
  });

  it('无挂载者时 run 走快路径，直接执行 core', async () => {
    const core = vi.fn((p: { turn: number }) => ({ turn: p.turn + 1 }));
    const result = await bus.run('onTurnStart', { turn: 1 }, core);

    expect(core).toHaveBeenCalledOnce();
    expect(result.turn).toBe(2);
  });

  // ─── 拦截器（洋葱中间件） ────────────────────────────────────────

  it('intercept 可包裹 core：next 前后各做一次事', async () => {
    const order: string[] = [];
    bus.intercept('onTurnStart', async (_p, next) => {
      order.push('before');
      const r = await next();
      order.push('after');
      return r;
    });

    await bus.run('onTurnStart', { turn: 1 }, (p) => { order.push('core'); return p; });

    expect(order).toEqual(['before', 'core', 'after']);
  });

  it('intercept 可短路：不调 next 则 core 完全不执行', async () => {
    const core = vi.fn((p: { turn: number }) => p);
    bus.intercept('onTurnStart', async (p) => ({ turn: p.turn + 100 }));

    const result = await bus.run('onTurnStart', { turn: 1 }, core);

    expect(core).not.toHaveBeenCalled();
    expect(result.turn).toBe(101);
  });

  it('intercept 可改写传给下层的 payload', async () => {
    bus.intercept('onTurnStart', async (p, next) => next({ turn: p.turn * 10 }));
    const core = vi.fn((p: { turn: number }) => ({ turn: p.turn + 1 }));

    const result = await bus.run('onTurnStart', { turn: 3 }, core);

    expect(result.turn).toBe(31);
  });

  it('多个 intercept 按洋葱顺序嵌套（先注册的在外层）', async () => {
    const order: string[] = [];
    bus.intercept('onTurnStart', async (_p, next) => {
      order.push('outer-in');
      const r = await next();
      order.push('outer-out');
      return r;
    });
    bus.intercept('onTurnStart', async (_p, next) => {
      order.push('inner-in');
      const r = await next();
      order.push('inner-out');
      return r;
    });

    await bus.run('onTurnStart', { turn: 1 }, (p) => { order.push('core'); return p; });

    expect(order).toEqual(['outer-in', 'inner-in', 'core', 'inner-out', 'outer-out']);
  });

  it('intercept 抛错时兜底走内层，主流程不被卡死', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const core = vi.fn((p: { turn: number }) => ({ turn: p.turn + 1 }));
    bus.intercept('onTurnStart', async () => { throw new Error('interceptor boom'); });

    const result = await bus.run('onTurnStart', { turn: 1 }, core);

    expect(core).toHaveBeenCalledOnce();
    expect(result.turn).toBe(2);
    spy.mockRestore();
  });

  it('内层 intercept 短路后，外层仍能收到返回值', async () => {
    const outer: number[] = [];
    bus.intercept('onTurnStart', async (_p, next) => {
      const r = await next();
      outer.push(r.turn);
      return r;
    });
    bus.intercept('onTurnStart', async (p) => ({ turn: p.turn * 2 }));

    const result = await bus.run('onTurnStart', { turn: 5 }, (p) => ({ turn: -1 }));

    expect(result.turn).toBe(10);
    expect(outer).toEqual([10]);
  });

  it('观察者与拦截器共存：观察者在最内层、core 之前', async () => {
    const order: string[] = [];
    bus.intercept('onTurnStart', async (_p, next) => { order.push('wrap'); return next(); });
    bus.on('onTurnStart', () => { order.push('observe'); });

    await bus.run('onTurnStart', { turn: 1 }, (p) => { order.push('core'); return p; });

    expect(order).toEqual(['wrap', 'observe', 'core']);
  });

  it('observerCount / interceptorCount 分别计数，disposer 精确移除', async () => {
    const d1 = bus.intercept('onTurnStart', async (_p, next) => next());
    const d2 = bus.on('onTurnStart', () => {});

    expect(bus.observerCount('onTurnStart')).toBe(1);
    expect(bus.interceptorCount('onTurnStart')).toBe(1);
    expect(bus.count('onTurnStart')).toBe(2);

    d1.dispose();
    expect(bus.interceptorCount('onTurnStart')).toBe(0);
    expect(bus.observerCount('onTurnStart')).toBe(1);

    d2.dispose();
    expect(bus.has('onTurnStart')).toBe(false);
  });

  it('has / count / hookNames / clear', async () => {
    expect(bus.has('onTurnStart')).toBe(false);

    const d = bus.on('onTurnStart', () => {});
    expect(bus.has('onTurnStart')).toBe(true);
    expect(bus.count('onTurnStart')).toBe(1);
    expect(bus.hookNames()).toEqual(['onTurnStart']);

    bus.clear();
    expect(bus.has('onTurnStart')).toBe(false);
    expect(bus.hookNames()).toEqual([]);
    // clear 后旧的 disposer 调用仍是安全的
    await expect(Promise.resolve(d.dispose())).resolves.toBeUndefined();
  });

  it('钩子执行期间注册新订阅不影响本轮遍历（快照迭代）', async () => {
    const late = vi.fn();
    bus.on('onTurnStart', () => { bus.on('onTurnStart', late); });

    await bus.emit('onTurnStart', { turn: 1 });

    expect(late).not.toHaveBeenCalled();
    await bus.emit('onTurnStart', { turn: 2 });
    expect(late).toHaveBeenCalledOnce();
  });
});

// ─── PluginHost ────────────────────────────────────────────────────

interface TestServices extends Record<string, unknown> {
  'provider.main': string;
  'router.ctx': { name: string };
}

type TestPlugin = HyPlugin<TestServices, TestHooks>;

describe('PluginHost', () => {
  let host: PluginHost<TestServices, TestHooks>;

  beforeEach(() => {
    host = new PluginHost<TestServices, TestHooks>();
  });

  it('mount 后插件被激活，list 可见', async () => {
    const activate = vi.fn();
    await host.mount({ id: 'p1', activate });

    expect(activate).toHaveBeenCalledOnce();
    expect(host.isMounted('p1')).toBe(true);
    expect(host.list()).toEqual([{ id: 'p1', state: 'mounted', deps: [] }]);
  });

  it('ctx.config 读插件配置，未配置时为空对象', async () => {
    let seen: unknown;
    await host.mount({ id: 'p1', activate: (ctx) => { seen = ctx.config(); } });
    expect(seen).toEqual({});

    let seen2: unknown;
    await host.mount({ id: 'p2', activate: (ctx) => { seen2 = ctx.config(); } }, { a: 1 });
    expect(seen2).toEqual({ a: 1 });
  });

  it('ctx.register 注册服务，get/require 可读', async () => {
    await host.mount({
      id: 'p1',
      activate: (ctx) => { ctx.register('provider.main', 'deepseek'); },
    });

    expect(host.get('provider.main')).toBe('deepseek');
    expect(host.require('provider.main')).toBe('deepseek');
    expect(host.has('provider.main')).toBe(true);
  });

  it('require 未注册的服务抛错', () => {
    expect(() => host.require('router.ctx')).toThrow(/not registered/);
  });

  it('卸载插件后服务被摘除，且恢复到注册前的值（热替换可回滚）', async () => {
    host.register('provider.main', 'builtin');
    await host.mount({
      id: 'p1',
      activate: (ctx) => { ctx.register('provider.main', 'deepseek'); },
    });
    expect(host.get('provider.main')).toBe('deepseek');

    await host.unmount('p1');

    expect(host.get('provider.main')).toBe('builtin');
    expect(host.isMounted('p1')).toBe(false);
  });

  it('ctx.add 登记的资源随插件卸载自动释放', async () => {
    const tool = vi.fn();
    await host.mount({
      id: 'p1',
      activate: (ctx) => { ctx.add(toDisposable(tool)); },
    });
    expect(tool).not.toHaveBeenCalled();

    await host.unmount('p1');
    expect(tool).toHaveBeenCalledOnce();
  });

  it('卸载时调用 deactivate', async () => {
    const deactivate = vi.fn();
    await host.mount({ id: 'p1', activate: () => {}, deactivate });
    await host.unmount('p1');

    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('依赖缺失时 mount 报错且不留下半挂载状态', async () => {
    await expect(
      host.mount({ id: 'p2', deps: ['missing'], activate: () => {} }),
    ).rejects.toThrow(/missing dependency "missing"/);

    expect(host.isMounted('p2')).toBe(false);
  });

  it('依赖已挂载时正常激活', async () => {
    await host.mount({ id: 'base', activate: () => {} });
    await host.mount({ id: 'child', deps: ['base'], activate: () => {} });

    expect(host.isMounted('child')).toBe(true);
  });

  it('重复 mount 同一 id 报错', async () => {
    await host.mount({ id: 'p1', activate: () => {} });
    await expect(host.mount({ id: 'p1', activate: () => {} })).rejects.toThrow(/already mounted/);
  });

  it('activate 抛错时回滚已注册资源，并保留 error 条目', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tool = vi.fn();

    await expect(
      host.mount({
        id: 'bad',
        activate: (ctx) => {
          ctx.add(toDisposable(tool));
          throw new Error('activate failed');
        },
      }),
    ).rejects.toThrow('activate failed');

    // 已登记资源被回滚
    expect(tool).toHaveBeenCalledOnce();
    // 条目保留为 error 状态，便于诊断
    expect(host.list()).toEqual([
      { id: 'bad', state: 'error', error: 'activate failed', deps: [] },
    ]);
    expect(host.isMounted('bad')).toBe(false);
    spy.mockRestore();
  });

  it('mount 返回的 disposer 等价于 unmount', async () => {
    const d = await host.mount({ id: 'p1', activate: () => {} });
    expect(host.isMounted('p1')).toBe(true);

    await Promise.resolve(d.dispose());

    expect(host.isMounted('p1')).toBe(false);
  });

  it('reload 完整走卸载 → 重新挂载', async () => {
    let calls = 0;
    const plugin: TestPlugin = {
      id: 'p1',
      activate: () => { calls++; },
      deactivate: () => { calls--; },
    };
    await host.mount(plugin);
    expect(calls).toBe(1);

    await host.reload('p1');

    expect(calls).toBe(1); // -1 +1
    expect(host.isMounted('p1')).toBe(true);
  });

  it('reload 未挂载的插件报错', async () => {
    await expect(host.reload('nope')).rejects.toThrow(/unknown plugin/);
  });

  it('dispose 逆序卸载全部插件', async () => {
    const order: string[] = [];
    await host.mount({ id: 'a', activate: () => {}, deactivate: () => { order.push('a'); } });
    await host.mount({ id: 'b', activate: () => {}, deactivate: () => { order.push('b'); } });

    await host.dispose();

    expect(order).toEqual(['b', 'a']);
    expect(host.list()).toEqual([]);
  });

  it('注入 hooks 后插件可通过 ctx.hooks 挂主循环钩子', async () => {
    const bus = new HookBus<TestHooks>({ name: 'loop' });
    const wired = new PluginHost<TestServices, TestHooks>({ hooks: bus });

    let captured: HookBus<TestHooks> | undefined;
    await wired.mount({
      id: 'p1',
      activate: (ctx: PluginContext<TestServices, TestHooks>) => {
        captured = ctx.hooks;
        ctx.onHook('onTurnStart', () => {});
      },
    });

    expect(captured).toBe(bus);
    expect(bus.count('onTurnStart')).toBe(1);

    // 插件卸载后钩子自动摘除 —— 这是「卸载 → 功能消失」验收条件的一部分
    await wired.unmount('p1');
    expect(bus.count('onTurnStart')).toBe(0);
  });

  it('onHook 的钩子真的能收到主循环事件', async () => {
    const bus = new HookBus<TestHooks>({ name: 'loop' });
    const wired = new PluginHost<TestServices, TestHooks>({ hooks: bus });
    const seen: number[] = [];

    await wired.mount({
      id: 'p1',
      activate: (ctx) => { ctx.onHook('onTurnStart', (p) => { seen.push(p.turn); }); },
    });

    await bus.emit('onTurnStart', { turn: 7 });
    expect(seen).toEqual([7]);
  });

  it('aroundHook 的拦截器可短路主循环槽位，且随卸载摘除', async () => {
    const bus = new HookBus<TestHooks>({ name: 'loop' });
    const wired = new PluginHost<TestServices, TestHooks>({ hooks: bus });

    await wired.mount({
      id: 'p1',
      activate: (ctx) => {
        ctx.aroundHook('beforeToolExecute', async (p) => ({ calls: p.calls.filter((c) => c !== 'bash') }));
      },
    });

    // 短路：bash 被过滤掉
    const out = await bus.run('beforeToolExecute', { calls: ['read', 'bash'] });
    expect(out.calls).toEqual(['read']);

    // 卸载后拦截器摘除，不再过滤
    await wired.unmount('p1');
    const out2 = await bus.run('beforeToolExecute', { calls: ['read', 'bash'] });
    expect(out2.calls).toEqual(['read', 'bash']);
  });

  it('未注入 hooks 时调用 onHook 快速失败（避免钩子静默丢失）', async () => {
    await expect(
      host.mount({ id: 'p1', activate: (ctx) => { ctx.onHook('onTurnStart', () => {}); } }),
    ).rejects.toThrow(/has no hook bus/);
  });

  it('直接用 ctx.hooks.on() 时钩子不随卸载摘除 —— 文档化的反例', async () => {
    const bus = new HookBus<TestHooks>({ name: 'loop' });
    const wired = new PluginHost<TestServices, TestHooks>({ hooks: bus });

    await wired.mount({
      id: 'p1',
      activate: (ctx) => { ctx.hooks?.on('onTurnStart', () => {}); },
    });
    await wired.unmount('p1');

    // 这正是需要 ctx.onHook() 的原因：裸用 hooks.on 会漏 disposer
    expect(bus.count('onTurnStart')).toBe(1);
  });

  it('未注入 hooks 时 ctx.hooks 为 undefined（内核可无总线运行）', async () => {
    let hasHooks = true;
    await host.mount({ id: 'p1', activate: (ctx) => { hasHooks = ctx.hooks !== undefined; } });

    expect(hasHooks).toBe(false);
  });

  // ── P6-1：setHooks 运行时注入（追加语义，宿主不重建） ──────────────

  it('setHooks 运行时注入：已挂载插件的 ctx.hooks 延迟读到新总线（getter 非快照）', async () => {
    const bare = new PluginHost<TestServices, TestHooks>(); // 构造期无总线
    let ctxRef: PluginContext<TestServices, TestHooks> | undefined;
    await bare.mount({
      id: 'p1',
      activate: (ctx) => { ctxRef = ctx; },
    });
    expect(ctxRef!.hooks).toBeUndefined(); // 注入前为 undefined

    const bus = new HookBus<TestHooks>({ name: 'loop' });
    bare.setHooks(bus);

    // 同一 ctx 对象在注入后重新访问 → 读到新总线（getter，非 mount 时快照）
    expect(ctxRef!.hooks).toBe(bus);
  });

  it('setHooks 不重建宿主：已挂载插件保留、卸载仍有效（P6-1 修复重建丢失）', async () => {
    const bare = new PluginHost<TestServices, TestHooks>();
    const activated = vi.fn();
    await bare.mount({ id: 'p1', activate: activated, deactivate: vi.fn() });

    bare.setHooks(new HookBus<TestHooks>({ name: 'loop' }));

    expect(bare.list().map((e) => e.id)).toEqual(['p1']);
    expect(activated).toHaveBeenCalledOnce(); // 未被重复激活
    await bare.unmount('p1');
    expect(bare.isMounted('p1')).toBe(false);
  });

  it('总线后注入：已挂载插件随后经 ctx.onHook 挂的钩子能收到事件', async () => {
    const bare = new PluginHost<TestServices, TestHooks>();
    let ctxRef: PluginContext<TestServices, TestHooks> | undefined;
    await bare.mount({ id: 'p1', activate: (ctx) => { ctxRef = ctx; } });

    const bus = new HookBus<TestHooks>({ name: 'loop' });
    bare.setHooks(bus);

    const seen: number[] = [];
    ctxRef!.onHook('onTurnStart', (p) => { seen.push(p.turn); });
    await bus.emit('onTurnStart', { turn: 9 });
    expect(seen).toEqual([9]);
  });
});
