/**
 * config-consistency.ts —— 配置一致性自检（2026-10-02，见 docs/design/config-code-separation.md）
 *
 * 为什么需要：配置的事实分散在三个文件，且**三者互不校验**——
 *   · providers.json   —— 这家厂商有哪些模型、默认哪个
 *   · config.json      —— 当前选了哪家（provider.active / provider.<X>.model）
 *   · model-channels.json —— 每个调用点走哪条通道
 * 2026-10-02 当天被这条"无仲裁"咬了两次：
 *   ① `provider=deepseek` + `model=stealth/pixel-canary`（后者属 commandcode）—— 错配，调用必失败；
 *   ② 四条旁路通道指向余额为 0 的厂商 —— 压缩**静默降级**为机械裁剪，肉眼不可见。
 *
 * 设计约束：
 *   · **纯读取 + 纯函数**（不依赖运行中的 registry）⇒ doctor / 工具 / 单测三处共用同一实现；
 *   · **只报警、绝不改写** —— 自动"修"配置会制造新的不确定性；
 *   · 不探测网络（余额/可用性属运行时，自检只做**静态一致性**）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_META } from '../provider/provider-meta.js';
import { MODEL_CATALOG, type ModelCatalogEntry } from '../provider/model-types.js';

export type ConfigIssueSeverity = 'error' | 'warn' | 'info';

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  /** 稳定码，便于测试与去重（如 model_provider_mismatch） */
  code: string;
  /** 位置：文件名或 `channels.<名>` / `roles.<角色>` */
  where: string;
  message: string;
  hint?: string;
}

export interface ConfigConsistencyOptions {
  /** 覆盖 home 目录（测试用）；默认 os.homedir() */
  homeDir?: string;
  /** 覆盖环境变量（测试用）；默认 process.env */
  env?: Record<string, string | undefined>;
}

export interface ConfigConsistencyReport {
  /** 无 error 即视为通过（warn 不阻断） */
  ok: boolean;
  issues: ConfigIssue[];
  summary: { errors: number; warnings: number; infos: number };
}

interface ProvidersFile {
  providers?: Record<string, { envKey?: string; defaultModel?: string; models?: ModelCatalogEntry[] }>;
}
interface ConfigFile {
  provider?: Record<string, unknown>;
}
interface ChannelsFile {
  channels?: Record<string, { provider?: string; model?: string }>;
  roles?: Record<string, string>;
}

function readJson<T>(file: string, issues: ConfigIssue[]): T | null {
  try {
    if (!fs.existsSync(file)) {
      issues.push({
        severity: 'info',
        code: 'file_absent',
        where: path.basename(file),
        message: '文件不存在（将使用内置默认值）',
      });
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'file_unparsable',
      where: path.basename(file),
      message: `JSON 解析失败：${(err as Error).message}`,
      hint: '损坏的配置文件会被整体忽略并回退内置默认，症状是"配置改了没反应"',
    });
    return null;
  }
}

/**
 * 读 `~/.agent/.env`（KEY=VALUE，支持引号与注释）。
 *
 * 为什么需要：裸 node 调用本模块时 `process.env` 里**没有** .env 的内容
 * ⇒ 会误报"apiKey 未设置"。误报比不报更糟 —— 它会让人怀疑整套自检。
 * 运行时（agent 进程 / `hyacinth doctor`）已加载 .env，这里只是把它补齐并统一行为。
 */
function loadEnvFile(agentDir: string): Record<string, string> {
  try {
    const file = path.join(agentDir, '.env');
    if (!fs.existsSync(file)) return {};
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!m) continue;
      let value = m[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]!] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 跑一次配置一致性自检（纯读，不修改任何文件） */
export function checkConfigConsistency(opts: ConfigConsistencyOptions = {}): ConfigConsistencyReport {
  const home = opts.homeDir ?? os.homedir();
  const agentDir = path.join(home, '.agent');
  // env 三层合并：.env 文件提供缺失项，显式传入的 env / process.env 优先。
  const env = { ...loadEnvFile(agentDir), ...(opts.env ?? process.env) };
  const issues: ConfigIssue[] = [];

  const providersFile = readJson<ProvidersFile>(path.join(agentDir, 'providers.json'), issues) ?? {};
  const configFile = readJson<ConfigFile>(path.join(agentDir, 'config.json'), issues) ?? {};
  const channelsFile = readJson<ChannelsFile>(path.join(agentDir, 'model-channels.json'), issues) ?? {};

  const userProviders = providersFile.providers ?? {};

  // ── 厂商集合 = 代码出厂快照 ∪ 用户声明 ──────────────────────────────
  const envKeyOf = new Map<string, string | undefined>();
  for (const id of Object.keys(PROVIDER_META)) envKeyOf.set(id, PROVIDER_META[id]?.envKey);
  for (const [id, meta] of Object.entries(userProviders)) {
    if (meta?.envKey) envKeyOf.set(id, meta.envKey);
  }
  const providerIds = new Set<string>([...Object.keys(PROVIDER_META), ...Object.keys(userProviders)]);

  // ── 模型归属表 = 内置目录 ∪ 用户声明的 models[] ─────────────────────
  const modelOwners = new Map<string, Set<string>>();
  const modelMeta = new Map<string, ModelCatalogEntry>();
  const addModel = (prov: string, m: ModelCatalogEntry): void => {
    if (!modelOwners.has(m.id)) modelOwners.set(m.id, new Set());
    modelOwners.get(m.id)!.add(prov);
    // 用户声明优先于内置（同 id 时以后者为准）
    if (!modelMeta.has(m.id) || prov in userProviders) modelMeta.set(m.id, m);
  };
  for (const [pid, list] of Object.entries(MODEL_CATALOG)) for (const m of list) addModel(pid, m);
  for (const [pid, meta] of Object.entries(userProviders)) {
    for (const m of meta?.models ?? []) addModel(pid, m);
  }

  // ── 通道检查 ───────────────────────────────────────────────────────
  const channels = channelsFile.channels ?? {};
  for (const [name, ch] of Object.entries(channels)) {
    const prov = ch?.provider;
    if (!prov) {
      issues.push({
        severity: 'warn',
        code: 'channel_no_provider',
        where: `channels.${name}`,
        message: '通道未指定 provider（运行时将继承默认通道）',
      });
      continue;
    }
    if (!providerIds.has(prov)) {
      issues.push({
        severity: 'error',
        code: 'channel_provider_unknown',
        where: `channels.${name}`,
        message: `厂商 "${prov}" 未在内置厂商表或 providers.json 中声明`,
        hint: '厂商名拼写错误，或该厂商尚未声明（list_providers 可查已声明清单）',
      });
      continue;
    }
    // apiKey 就绪（本地模型不需要 key）
    const envKey = envKeyOf.get(prov);
    if (prov !== 'local' && envKey && !env[envKey]) {
      issues.push({
        severity: 'warn',
        code: 'provider_key_missing',
        where: `channels.${name}`,
        message: `厂商 "${prov}" 需要的环境变量 ${envKey} 未设置`,
        hint: '该通道的调用会失败并降级到主通道 —— 降级可能是静默的（如压缩退化为机械裁剪）',
      });
    }
    // model 归属校验
    const model = ch?.model;
    if (!model) continue;
    const owners = modelOwners.get(model);
    if (!owners) {
      issues.push({
        severity: 'warn',
        code: 'model_not_in_catalog',
        where: `channels.${name}`,
        message: `模型 "${model}" 未收录在模型目录中，无法校验其上下文/能力`,
        hint: `可在 providers.json 的 ${prov}.models[] 中补充声明`,
      });
    } else if (!owners.has(prov)) {
      issues.push({
        severity: 'error',
        code: 'model_provider_mismatch',
        where: `channels.${name}`,
        message: `模型 "${model}" 不属于厂商 "${prov}"（它属于：${[...owners].join(', ')}）`,
        hint: '厂商与模型名不匹配，调用必然失败',
      });
    } else {
      const meta = modelMeta.get(model);
      if (meta?.status === 'deprecated') {
        issues.push({
          severity: 'warn',
          code: 'model_deprecated',
          where: `channels.${name}`,
          message: `模型 "${model}" 已标记 deprecated${meta.replacedBy ? `，建议改用 ${meta.replacedBy}` : ''}`,
        });
      }
    }
  }

  // ── 角色映射悬空 ───────────────────────────────────────────────────
  const roles = channelsFile.roles ?? {};
  for (const [role, target] of Object.entries(roles)) {
    if (!channels[target]) {
      issues.push({
        severity: 'error',
        code: 'role_channel_missing',
        where: `roles.${role}`,
        message: `角色指向的通道 "${target}" 不存在`,
        hint: '悬空映射：该角色的调用会回退到默认通道',
      });
    }
  }

  // ── provider.active 与主对话通道是否一致 ───────────────────────────
  const activeRaw = (configFile.provider as { active?: unknown } | undefined)?.active;
  const active = typeof activeRaw === 'string' ? activeRaw : undefined;
  const chatChannel = roles['chat'];
  const chatProvider = chatChannel ? channels[chatChannel]?.provider : undefined;
  if (active && chatProvider && active !== chatProvider) {
    issues.push({
      severity: 'warn',
      code: 'active_channel_mismatch',
      where: 'config.json',
      message: `provider.active="${active}" 与主对话通道 "${chatChannel}" 的厂商 "${chatProvider}" 不一致`,
      hint: 'provider.active 决定下次启动用哪家（cli.ts 启动时读取），不一致会导致"启动后与预期不同"',
    });
  }

  const summary = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };
  return { ok: summary.errors === 0, issues, summary };
}

/** 人类可读的一行摘要（供日志/工具输出复用） */
export function formatConsistencyReport(report: ConfigConsistencyReport): string {
  if (report.issues.length === 0) return '配置一致性：全部通过 ✓';
  const icon: Record<ConfigIssueSeverity, string> = { error: '❌', warn: '⚠️', info: 'ℹ️' };
  const lines = report.issues.map(
    (i) => `${icon[i.severity]} [${i.where}] ${i.message}${i.hint ? `\n     ↳ ${i.hint}` : ''}`,
  );
  const { errors, warnings, infos } = report.summary;
  return [
    `配置一致性：${errors} 个错误 / ${warnings} 个警告 / ${infos} 条提示`,
    ...lines,
  ].join('\n');
}
