/**
 * 渠道凭证/状态路径守卫。
 *
 * 真实事故：clawbot 的 bot_token 缓存路径曾写成 `path.join(process.cwd(), '.agent', ...)`，
 * 与其余 103 处 `~/.agent` 配置不一致 —— 换个启动目录就读不到 token，表现为"每次编译重启
 * 都要重新扫码"。
 *
 * 判据：**渠道凭证/状态属用户级数据，必须落家目录**；项目级产物（项目插件、
 * persona 覆盖、specs 等）才随 process.cwd() 走。本守卫锁死前者。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('渠道凭证/状态文件必须落家目录（不得跟 process.cwd 走）', () => {
  it.each([
    ['src/channels/plugins/clawbot/clawbot-auth.ts', 'clawbot_token.json'],
    ['src/channels/plugins/clawbot/clawbot-channel.ts', 'clawbot_session.json'],
    ['src/channels/plugins/feishu/feishu-channel.ts', 'feishu_chat.json'],
  ])('%s：%s 使用 homedir 而非 cwd', (rel, fileName) => {
    const src = read(rel);
    expect(src).not.toContain(`process.cwd(), '.agent', '${fileName}'`);
    expect(src).toContain(`os.homedir(), '.agent', '${fileName}'`);
    // 必须真的导入 os —— 防止"改了字符串却没导入"的空转修复
    expect(src).toMatch(/import os from 'node:os';/);
  });
});
