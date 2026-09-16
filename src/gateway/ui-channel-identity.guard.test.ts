/**
 * 「TUI 的会话归属渠道 = 'tui'」契约的源码守卫。
 *
 * 为什么需要它：这个身份要在**三处保持一致**，任一处漂移都会让 TUI 恢复不到自己的会话。
 * 2026-09-17 事故即由此而来 —— ui-protocol 硬编码 'webui'（那句本为浏览器 WebUI 而写），
 * TUI 的会话被贴成 webui_ 前缀（标签漂移），而 cli.ts 按 'tui' 取重启快照：
 *   ① 快照键取不到 → 每次重启都新开会话（连 /session 显式切过的会话也会丢）；
 *   ② 续工指令被判「渠道不符」而搁置 / 或反之把别渠道的续工注入本渠道 → 跨渠道串台。
 *
 * 三处副本：
 *   ① tui.ts                 —— 构造 UiProtocolSession 时传 'tui'（不吃 'webui' 缺省）
 *   ② ui-protocol-session.ts —— 渠道来自调用方，不得硬编码
 *   ③ cli.ts                 —— launchChannel（快照键 / 续工判定）同为 'tui'
 * 行为侧由 boot-channel-restore.test.ts 覆盖（恢复/不越界），此处只钉「身份不分叉」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';

const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf-8');

describe('会话归属渠道契约：TUI ⇒ tui', () => {
  it('① tui.ts 构造 UiProtocolSession 时显式传 channel: "tui"', async () => {
    expect(await read('./tui.ts')).toContain("channel: 'tui',");
  });

  it('② ui-protocol-session.ts 的渠道来自调用方（缺省仅对 WebUI 生效）', async () => {
    const src = await read('../channels/builtin/ui-protocol-session.ts');
    expect(src).toContain("channel: this.backend.channel ?? 'webui'");
    // 硬编码会把 TUI 会话贴成 webui_ 前缀（漂移）—— 必须没有
    expect(src).not.toContain("channel: 'webui',");
  });

  it('③ cli.ts 的 launchChannel 在 TUI 模式取 "tui"（与快照键 / 续工判定同源）', async () => {
    expect(await read('./cli.ts')).toContain("const launchChannel = options.tui ? 'tui' : undefined;");
  });
});
