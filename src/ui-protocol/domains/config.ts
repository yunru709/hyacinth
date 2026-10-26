// ============================================================
// UI 契约层 — 配置域（config.*）
// ============================================================
// 覆盖 UI 对配置的全部读写操作：
//   config.get      读取单路径配置
//   config.getAll   读取完整有效配置
//   config.set      设置单路径（转发 RuntimeConfigCenter + 持久化）
//   config.merge    合并部分配置
//   config.reset    重置（单项或全部）
//   config.schema   暴露配置 schema（路径/类型/默认值/描述）——
//                   WebUI 据此动态渲染设置表单
//
// 同时订阅 configCenter.watch('*') 的变更事件，转发为
// config.change 事件推送给所有 UI 客户端（实时刷新）。
//
// 为独立可测，本域只依赖 ConfigCenterLike 接口（结构类型）；
// 真实 RuntimeConfigCenter 天然满足该接口。
// ============================================================

import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';
import type { ConfigEntry, ConfigChangeEvent } from '../types.js';

// ────────────────────────────────────────────────────────────
// 最小配置中心接口（RuntimeConfigCenter 结构兼容）
// ────────────────────────────────────────────────────────────

export interface ConfigCenterLike {
  get<T = unknown>(path: string): T;
  getAll(): Record<string, unknown>;
  set(path: string, value: unknown): void;
  merge(partial: Record<string, unknown>): void;
  reset(path?: string): void;
  watch(pattern: string, cb: (event: ConfigChangeEvent) => void): () => void;
}

// ────────────────────────────────────────────────────────────
// 配置域选项
// ────────────────────────────────────────────────────────────

export interface ConfigDomainOptions {
  configCenter: ConfigCenterLike;
  /** 变更事件推送（绑定到 server.broadcast）。可选，缺省不推送。 */
  emit?: (type: string, payload?: unknown) => void;
  /** 额外描述元数据：path → 中文描述。可选，覆盖默认 `Configuration: <path>`。 */
  descriptions?: Record<string, string>;
  /** set/merge/reset 后是否持久化。默认 true（调用 save）。 */
  persist?: boolean;
}

// ────────────────────────────────────────────────────────────
// 敏感键遮蔽（协议边界）
// ────────────────────────────────────────────────────────────
// 为什么必须在**协议边界**遮蔽：`config.get` / `config.getAll` / `config.schema`
// 会把整包配置推给前端，`config.change` 还会把 oldValue/newValue **广播给所有 UI 客户端**。
// 密钥一旦进了浏览器，DOM 属性、截图、devtools、日志全能捞到 —— 那就等于已泄漏，
// 哪怕界面上根本没画出来。判据是硬性的：明文不得出现在发往 UI 的任何一帧里。
//
// 两个**不能误伤**的键（写在这里防止后人用 contains/suffix 一把梭）：
//   - `apiKeyEnv`：值是**环境变量名**（如 ANTHROPIC_API_KEY），UI 靠它显示"用哪个变量"；
//   - `autoRefreshToken`：布尔开关，不是密钥。
// 所以这里用**最后一段路径精确匹配**。
const SENSITIVE_LEAF_KEYS = new Set([
  'apikey',
  'appsecret',
  'bottoken',
  'token',
  'password',
  'secret',
  'credential',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
]);

/** 遮蔽占位符（字段保留 ⇒ schema 形状不变，UI 不会因缺键而崩） */
export const REDACTED_PLACEHOLDER = '***';

/** 路径末段是否为敏感键 */
export function isSensitiveConfigPath(path: string): boolean {
  const leaf = path.split('.').pop()?.toLowerCase() ?? '';
  return SENSITIVE_LEAF_KEYS.has(leaf);
}

/**
 * 遮蔽单个值：只对**非空字符串**下手。
 * 空值保持空 —— "空"本身表示"未配置"，遮成 *** 反而会让用户以为已经配了。
 */
function redactValue(path: string, value: unknown): unknown {
  if (isSensitiveConfigPath(path) && typeof value === 'string' && value !== '') {
    return REDACTED_PLACEHOLDER;
  }
  return value;
}

/** 深拷贝 + 按路径遮蔽（数组按非敏感处理；配置里没有敏感数组） */
function redactDeep(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactDeep(v as Record<string, unknown>, fullPath);
    } else {
      out[k] = redactValue(fullPath, v);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// schema 推导（递归遍历 defaults + current）
// ────────────────────────────────────────────────────────────

function inferType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function walkSchema(
  defaults: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix: string,
  descriptions: Record<string, string>,
): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const key of Object.keys(defaults)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const defaultVal = defaults[key];
    const currentVal = current?.[key];

    if (
      defaultVal !== null &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal)
    ) {
      entries.push(
        ...walkSchema(
          defaultVal as Record<string, unknown>,
          currentVal && typeof currentVal === 'object' && !Array.isArray(currentVal)
            ? (currentVal as Record<string, unknown>)
            : {},
          fullPath,
          descriptions,
        ),
      );
    } else {
      entries.push({
        path: fullPath,
        type: inferType(defaultVal),
        value: currentVal !== undefined ? currentVal : defaultVal,
        default: defaultVal,
        description: descriptions[fullPath] ?? `Configuration: ${fullPath}`,
        label: descriptions[fullPath] ? key : undefined,
      });
    }
  }
  return entries;
}

// ────────────────────────────────────────────────────────────
// 配置域工厂
// ────────────────────────────────────────────────────────────

export type ConfigDomain = DomainHandler & {
  /** 释放资源（取消 watch 订阅） */
  dispose(): void;
};

export function createConfigDomain(options: ConfigDomainOptions): ConfigDomain {
  const { configCenter, emit, descriptions = {}, persist = true } = options;

  // 订阅所有配置变更 → 转发 config.change 事件
  let unsub: (() => void) | null = null;
  if (emit) {
    unsub = configCenter.watch('*', (event) => {
      // ⚠️ 这条是**广播**（所有 UI 客户端）。实测它会把 voice.tts.online.apiKey 的
      // oldValue/newValue 明文推给前端 —— 比单次 get 更危险，因为同样的话会被所有连接看到。
      emit(UI_EVENT.CONFIG_CHANGE, {
        ...event,
        oldValue: redactValue(event.path, event.oldValue),
        newValue: redactValue(event.path, event.newValue),
      });
    });
  }

  /** 持久化（fire-and-forget，失败不阻断响应） */
  const maybePersist = async (center: ConfigCenterLike): Promise<void> => {
    if (!persist) return;
    const save = (center as { save?: () => Promise<void> }).save;
    if (save) {
      try {
        // 必须 call(center)：save 内部依赖 this（ensureInitialized/getAll/configManager），
        // 直接 save() 会丢失 this 绑定抛 TypeError，且被下方 catch 静默吞掉导致配置不落盘。
        await save.call(center);
      } catch (err) {
        // 持久化失败不阻断 UI 响应，但要留痕（否则静默失败极难排查）
        console.error('[ui-protocol] config persist failed:', err instanceof Error ? err.message : err);
      }
    }
  };

  const handler: DomainHandler = {
    // ── config.get ─────────────────────────────────────────
    get: (params: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (path) {
        const value = configCenter.get(path);
        if (value === undefined) {
          throw new Error(`config path "${path}" not found`);
        }
        // 单路径也要遮蔽：否则「读整包被挡了」还能逐键捞回来，等于没修
        return { path, value: redactValue(path, value) };
      }
      return { path: undefined, value: redactDeep(configCenter.getAll()) };
    },

    // ── config.getAll ──────────────────────────────────────
    getAll: () => redactDeep(configCenter.getAll()),

    // ── config.set ─────────────────────────────────────────
    async set(params: unknown): Promise<unknown> {
      const { path, value } = params as { path: string; value: unknown };
      if (!path) throw new Error('config.set requires "path"');
      configCenter.set(path, value);
      await maybePersist(configCenter);
      // 回显也遮蔽（写入方虽然本来就是自己发的，但响应会进日志/抓包）
      return { ok: true, path, value: redactValue(path, value) };
    },

    // ── config.merge ───────────────────────────────────────
    async merge(params: unknown): Promise<unknown> {
      const partial = params as Record<string, unknown>;
      if (!partial || typeof partial !== 'object') {
        throw new Error('config.merge requires a partial config object');
      }
      configCenter.merge(partial);
      await maybePersist(configCenter);
      return { ok: true };
    },

    // ── config.reset ───────────────────────────────────────
    async reset(params: unknown): Promise<unknown> {
      const path = (params as { path?: string } | undefined)?.path;
      configCenter.reset(path);
      await maybePersist(configCenter);
      return { ok: true, path: path ?? '*' };
    },

    // ── config.schema ──────────────────────────────────────
    schema: () => {
      const defaults = configCenter.getAll(); // 作为 schema 形状来源
      // ⚠️ value 和 default **两个**字段都会带真值：walkSchema(defaults, defaults, ...)
      // 拿的是同一份 getAll()，所以 default 里也是当前生效值。
      // 实测只遮 value 时密钥照样从 default 漏出去（我第一版就是这么错的）。
      const entries = walkSchema(defaults, defaults, '', descriptions).map((e) => {
        const masked = redactValue(e.path, e.value);
        return {
          ...e,
          value: masked,
          // 密钥的 default 也常量化为占位符：它的语义是"默认配置"，对密钥没有意义
          ...(masked === REDACTED_PLACEHOLDER ? { default: REDACTED_PLACEHOLDER } : {}),
        };
      });
      return { entries };
    },
  };

  // dispose 是生命周期管理，不是协议方法 —— 必须以不可枚举方式挂载。
  // 原因：server 用 Object.keys(handler) 生成能力清单（meta.get）并用
  // handler[action] 分发请求，任何可枚举属性都会同时成为"对外暴露的
  // 协议方法"。若 dispose 可枚举，客户端可远程调用 config.dispose 取消
  // 全局配置订阅，使所有 UI 的 config.change 事件静默失效。
  return Object.defineProperty(handler, 'dispose', {
    value: (): void => {
      if (unsub) {
        unsub();
        unsub = null;
      }
    },
    enumerable: false,
    configurable: true,
    writable: true,
  }) as ConfigDomain;
}
