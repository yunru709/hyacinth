/**
 * config-consistency.test.ts —— 配置一致性自检单测（见 docs/design/config-code-separation.md）
 *
 * 覆盖当日真实踩到的两类事故：
 *   ① 厂商与模型名错配（provider=deepseek + model=stealth/pixel-canary，后者属 commandcode）
 *   ② 旁路通道指向无 key 的厂商（调用会失败并**静默降级**）
 *
 * ⚠️ 隔离：全部在 mkdtemp 临时 home 下构造，绝不触碰真实 ~/.agent。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConfigConsistency } from './config-consistency.js';

let home: string;
let agentDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-cfgcheck-'));
  agentDir = path.join(home, '.agent');
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, data: unknown): void {
  fs.writeFileSync(path.join(agentDir, file), JSON.stringify(data, null, 2), 'utf-8');
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((i) => i.code);
}

describe('checkConfigConsistency', () => {
  it('三文件都不存在 → 仅 info，不报错', () => {
    const r = checkConfigConsistency({ homeDir: home, env: {} });
    expect(r.ok).toBe(true);
    expect(r.summary.errors).toBe(0);
    expect(codes(r.issues)).toEqual(['file_absent', 'file_absent', 'file_absent']);
  });

  it('JSON 损坏 → error（否则症状是"配置改了没反应"）', () => {
    fs.writeFileSync(path.join(agentDir, 'model-channels.json'), '{ broken', 'utf-8');
    const r = checkConfigConsistency({ homeDir: home, env: {} });
    expect(r.ok).toBe(false);
    expect(codes(r.issues)).toContain('file_unparsable');
  });

  it('厂商与模型名错配 → error（当日实例：deepseek + stealth/pixel-canary）', () => {
    write('providers.json', {
      providers: {
        commandcode: {
          envKey: 'COMMANDCODE_API_KEY',
          models: [{ id: 'stealth/pixel-canary', name: 'Pixel Canary', provider: 'commandcode' }],
        },
      },
    });
    write('model-channels.json', {
      channels: { default: { provider: 'deepseek', model: 'stealth/pixel-canary' } },
      roles: { assessment: 'default' },
    });
    const r = checkConfigConsistency({ homeDir: home, env: { DEEPSEEK_API_KEY: 'x' } });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'model_provider_mismatch');
    expect(issue?.where).toBe('channels.default');
    expect(issue?.message).toContain('commandcode');
  });

  it('厂商未声明 → error；缺 apiKey → warn', () => {
    write('model-channels.json', {
      channels: {
        a: { provider: 'nosuchvendor', model: 'm' },
        b: { provider: 'deepseek', model: 'deepseek-flash' },
      },
      roles: {},
    });
    const r = checkConfigConsistency({ homeDir: home, env: {} });
    expect(codes(r.issues)).toContain('channel_provider_unknown');
    expect(codes(r.issues)).toContain('provider_key_missing');
  });

  it('角色指向不存在的通道 → error（悬空映射）', () => {
    write('model-channels.json', {
      channels: { default: { provider: 'deepseek', model: 'deepseek-flash' } },
      roles: { compression: 'ghost' },
    });
    const r = checkConfigConsistency({ homeDir: home, env: { DEEPSEEK_API_KEY: 'x' } });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'role_channel_missing');
    expect(issue?.message).toContain('ghost');
  });

  it('provider.active 只是遗留字段 → info（不参与决策、不计入 warn）', () => {
    write('config.json', { provider: { active: 'openai' } });
    write('model-channels.json', {
      channels: { chat: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
      roles: { chat: 'chat' },
    });
    write('providers.json', {
      providers: {
        commandcode: {
          envKey: 'COMMANDCODE_API_KEY',
          models: [{ id: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode' }],
        },
      },
    });
    const r = checkConfigConsistency({ homeDir: home, env: { COMMANDCODE_API_KEY: 'x' } });
    const issue = r.issues.find((i) => i.code === 'active_field_legacy');
    expect(issue?.severity).toBe('info'); // 2026-10-02：由 warn 降级（字段已退役）
    expect(issue?.message).toContain('openai');
    expect(r.summary.warnings).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('deprecated 模型在使用中 → warn 且给出建议', () => {
    write('model-channels.json', {
      channels: { x: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
      roles: {},
    });
    const r = checkConfigConsistency({ homeDir: home, env: { DEEPSEEK_API_KEY: 'x' } });
    const issue = r.issues.find((i) => i.code === 'model_deprecated');
    expect(issue?.message).toContain('deepseek-flash');
  });

  it('自洽配置 → 无 error / 无 warn', () => {
    write('config.json', { provider: { active: 'commandcode' } });
    write('providers.json', {
      providers: {
        commandcode: {
          envKey: 'COMMANDCODE_API_KEY',
          // 纯用户侧声明的厂商：其模型目录也来自这里（不在内置 MODEL_CATALOG 里）
          models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'commandcode' }],
        },
      },
    });
    write('model-channels.json', {
      channels: { chat: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
      roles: { chat: 'chat' },
    });
    const r = checkConfigConsistency({
      homeDir: home,
      env: { COMMANDCODE_API_KEY: 'x' },
    });
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warnings).toBe(0);
    expect(r.ok).toBe(true);
  });
});
