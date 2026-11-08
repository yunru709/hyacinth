/**
 * QQ 渠道插件回归守卫。
 *
 * 钉死的几条不变式：
 *   ① 安全默认：allowFrom 空 = 谁都不理（**不是**"对所有人开放"）
 *   ② enabled=false 时不注册渠道（与 clawbot 不同 —— clawbot 有个"扫码登录入口"要恒定可达，
 *      QQ 没有这种鸡生蛋问题，禁用就该彻底不连）
 *   ③ 配置事故（启用但白名单空）必须拒绝启动并大声报错，而不是静默全拦
 *   ④ session 前缀无论 enabled 与否都登记（存量 qq_xxx 会话归属不丢）
 *   ⑤ OneBot 文本提取 / @ 判定 / 分片的纯函数行为
 */
import { describe, it, expect, vi } from 'vitest';

const { qqChannelPlugin } = await import('./index.js');
const { resolveQqConfig, validateQqConfig, isAllowedUser, isAllowedGroup } = await import('./qq-config.js');
const { extractText, isMentioned, chunkText, buildWsCandidates, stripMarkdown } = await import('./qq-client.js');

// ── ① 配置解析与安全默认 ──────────────────────────────────────

describe('qq-config', () => {
  it('allowFrom 缺省为空数组（谁都不理），不是开放', () => {
    const cfg = resolveQqConfig({});
    expect(cfg.allowFrom).toEqual([]);
    expect(cfg.enabled).toBe(false);
    expect(isAllowedUser(cfg, 746896396)).toBe(false);
  });

  it('启用但 allowFrom 空 ⇒ validate 报错（配置事故，不静默全拦）', () => {
    const cfg = resolveQqConfig({ enabled: true, allowFrom: [] });
    const err = validateQqConfig(cfg);
    expect(err).toBeTruthy();
    expect(err).toContain('allowFrom');
  });

  it('未启用时 allowFrom 空不算错误', () => {
    const cfg = resolveQqConfig({ enabled: false });
    expect(validateQqConfig(cfg)).toBeNull();
  });

  it('白名单匹配支持数字与字符串混写', () => {
    const cfg = resolveQqConfig({ enabled: true, allowFrom: [746896396, '123456'] });
    expect(isAllowedUser(cfg, 746896396)).toBe(true);
    expect(isAllowedUser(cfg, '746896396')).toBe(true);
    expect(isAllowedUser(cfg, 123456)).toBe(true);
    expect(isAllowedUser(cfg, 999)).toBe(false);
  });

  it('群白名单独立于私聊白名单', () => {
    const cfg = resolveQqConfig({ enabled: true, allowFrom: [1], groupAllowFrom: [] });
    expect(isAllowedGroup(cfg, 888)).toBe(false);
  });

  it('默认 requireMention=true（群里必须 @ 才回）', () => {
    expect(resolveQqConfig({}).requireMention).toBe(true);
  });
});

// ── ⑤ OneBot 消息纯函数 ───────────────────────────────────────

describe('qq-client 纯函数', () => {
  it('extractText 从 array 消息段取文本，丢弃图片/表情', () => {
    const ev = {
      post_type: 'message', message_type: 'private', user_id: 1,
      message_id: 1, self_id: 2, time: 0,
      message: [
        { type: 'text', data: { text: '你好' } },
        { type: 'image', data: { file: 'x.jpg' } },
        { type: 'text', data: { text: '世界' } },
      ],
    } as never;
    expect(extractText(ev)).toBe('你好世界');
  });

  it('extractText 把 at 段保留为 @qq 文本', () => {
    const ev = {
      post_type: 'message', message_type: 'group', user_id: 1, group_id: 9,
      message_id: 1, self_id: 2, time: 0,
      message: [
        { type: 'at', data: { qq: '3994097359' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    } as never;
    expect(extractText(ev)).toContain('@3994097359');
    expect(extractText(ev)).toContain('在吗');
  });

  it('extractText 纯文本串直接返回', () => {
    const ev = {
      post_type: 'message', message_type: 'private', user_id: 1,
      message_id: 1, self_id: 2, time: 0, message: 'hi',
    } as never;
    expect(extractText(ev)).toBe('hi');
  });

  it('isMentioned 只在 at 段 qq 等于 selfId 时为真', () => {
    const mk = (qq: string) => ({
      post_type: 'message', message_type: 'group', user_id: 1, group_id: 9,
      message_id: 1, self_id: 2, time: 0,
      message: [{ type: 'at', data: { qq } }],
    }) as never;
    expect(isMentioned(mk('3994097359'), '3994097359')).toBe(true);
    expect(isMentioned(mk('123456'), '3994097359')).toBe(false);
    // selfId 空 ⇒ 永不判定为被 @（防止配置缺失时群里乱回）
    expect(isMentioned(mk('3994097359'), '')).toBe(false);
  });

  it('chunkText 超长时按换行优先切分且不丢字', () => {
    const text = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
    const chunks = chunkText(text, 70);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text.replace(/\n/, ''));
  });

  it('chunkText 短文本原样一条', () => {
    expect(chunkText('短', 100)).toEqual(['短']);
    expect(chunkText('', 100)).toEqual([]);
  });

  // QQ 不渲染 Markdown（2026-11-08 孑遗要求）⇒ 出口必须降级成纯文本。
  // 这里钉的是**渲染契约**：任何 markdown 记号出现在发出去的正文里都是 bug。
  describe('stripMarkdown', () => {
    it('标题/粗体/斜体/删除线/行内代码 全部去符号留文字', () => {
      expect(stripMarkdown('## 标题')).toBe('标题');
      expect(stripMarkdown('**粗体**')).toBe('粗体');
      expect(stripMarkdown('__粗体__')).toBe('粗体');
      expect(stripMarkdown('~~删掉~~')).toBe('删掉');
      expect(stripMarkdown('用 `chunkText` 切分')).toBe('用 chunkText 切分');
    });

    it('代码围栏去围栏与语言标记，保留代码内容', () => {
      const md = '```ts\nconst a = 1;\n```';
      expect(stripMarkdown(md)).toBe('const a = 1;');
    });

    it('列表统一成 · 且保留缩进', () => {
      expect(stripMarkdown('- 一\n- 二')).toBe('· 一\n· 二');
      expect(stripMarkdown('  * 子项')).toBe('  · 子项');
    });

    it('表格删分隔行，竖线缩成两空格', () => {
      const md = '| 名 | 值 |\n|---|---|\n| a | 1 |';
      expect(stripMarkdown(md)).toBe('名  值\na  1');
    });

    it('链接降级成 文案（url）', () => {
      expect(stripMarkdown('[文档](https://x.com)')).toBe('文档（https://x.com）');
    });

    it('引用与分隔线去符号', () => {
      expect(stripMarkdown('> 引用')).toBe('引用');
      expect(stripMarkdown('---')).toBe('');
    });

    it('不误伤正文：snake_case / 路径 / 乘号 / 下划线', () => {
      expect(stripMarkdown('use session_identity.json please')).toBe('use session_identity.json please');
      expect(stripMarkdown('C:\\Users\\74689\\Desktop')).toBe('C:\\Users\\74689\\Desktop');
      expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
      expect(stripMarkdown('a_b_c')).toBe('a_b_c');
    });

    it('空串 / 纯空白 ⇒ 空', () => {
      expect(stripMarkdown('')).toBe('');
      expect(stripMarkdown('   \n  ')).toBe('');
    });
  });
});

// ── ②③④ 插件注册语义 ────────────────────────────────────────

describe('qqChannelPlugin.autoRegister', () => {
  function setup() {
    const registered: Array<{ handler: { id: string }; config: Record<string, unknown> }> = [];
    const channelManager = {
      register: (handler: { id: string }, config: Record<string, unknown>) => {
        registered.push({ handler, config });
      },
    } as never;
    const channelsInfo: Array<Record<string, unknown>> = [];
    return { registered, channelManager, channelsInfo };
  }

  it('enabled=false ⇒ 不注册渠道', async () => {
    const { registered, channelManager, channelsInfo } = setup();
    await qqChannelPlugin.autoRegister(channelManager, { enabled: false }, channelsInfo as never);
    expect(registered).toHaveLength(0);
    expect(channelsInfo).toHaveLength(0);
  });

  it('config 为 undefined（未配置）⇒ 不注册', async () => {
    const { registered, channelManager, channelsInfo } = setup();
    await qqChannelPlugin.autoRegister(channelManager, undefined, channelsInfo as never);
    expect(registered).toHaveLength(0);
  });

  it('启用但 allowFrom 空 ⇒ 拒绝注册（配置事故）', async () => {
    const { registered, channelManager, channelsInfo } = setup();
    await qqChannelPlugin.autoRegister(channelManager, { enabled: true, allowFrom: [] }, channelsInfo as never);
    expect(registered).toHaveLength(0);
  });

  it('启用且白名单非空 ⇒ 注册并把 allowFrom 透传下去', async () => {
    const { registered, channelManager, channelsInfo } = setup();
    await qqChannelPlugin.autoRegister(
      channelManager,
      { enabled: true, allowFrom: [746896396] },
      channelsInfo as never,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0].handler.id).toBe('qq');
    expect(registered[0].config.allowFrom).toEqual([746896396]);
    expect(registered[0].config.enabled).toBe(true);
    expect(channelsInfo).toHaveLength(1);
    expect(channelsInfo[0].name).toBe('qq');
  });
});

// ── 双栈回退（2026-11-08 实测 NapCat WS 绑 IPv6-only）──────────

describe('buildWsCandidates', () => {
  it('127.0.0.1 时追加 [::1] 候选', () => {
    const c = buildWsCandidates('ws://127.0.0.1:3001');
    expect(c).toHaveLength(2);
    expect(c[0]).toBe('ws://127.0.0.1:3001');
    expect(c[1]).toContain('[::1]');
    expect(c[1]).toContain('3001');
  });

  it('localhost 同样追加', () => {
    const c = buildWsCandidates('ws://localhost:3001');
    expect(c).toHaveLength(2);
    expect(c[1]).toContain('[::1]');
  });

  it('非 loopback 地址不追加（远端主机没有 ::1 语义）', () => {
    const c = buildWsCandidates('ws://192.168.1.10:3001');
    expect(c).toHaveLength(1);
    expect(c[0]).toBe('ws://192.168.1.10:3001');
  });

  it('非法 URL 时原样返回单候选（不抛错）', () => {
    const c = buildWsCandidates('not a url');
    expect(c).toEqual(['not a url']);
  });
});
