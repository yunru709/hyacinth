import EventEmitter from 'node:events';
import type { FullConfig } from './config-schema.js';
import type { ConfigManager } from '../setup/config.js';

// ============================================================
// Types
// ============================================================

export interface ConfigChangeEvent {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: string;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Read a value from a nested object using dot-path notation.
 * Returns `undefined` if the path does not exist.
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Write a value into a nested object using dot-path notation.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let next = current[part];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      next = {};
      current[part] = next;
    }
    current = next as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Check whether a dot-path is structurally valid against the defaults schema.
 * Every ancestor segment must exist and be an object.
 * The final leaf is always allowed (to support Record<>-style dynamic keys).
 */
function hasPath(obj: Record<string, unknown>, path: string): boolean {
  if (!path) return true;
  const parts = path.split('.');
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return false;
    }
    const cur = current as Record<string, unknown>;
    if (!(parts[i] in cur)) {
      return false;
    }
    current = cur[parts[i]];
  }

  // The parent of the final segment must exist and be an object (not array / primitive).
  return current !== null && typeof current === 'object' && !Array.isArray(current);
}

/**
 * Delete a value from a nested object by dot-path.
 * Cleans up empty ancestor objects afterward.
 */
function deleteByPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  // Walk to the second-to-last node, tracking the stack for cleanup.
  const stack: Array<{ container: Record<string, unknown>; key: string }> = [];
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== 'object') {
      return; // path doesn't exist, nothing to delete
    }
    const container = current as Record<string, unknown>;
    if (!(parts[i] in container)) {
      return; // path doesn't exist
    }
    stack.push({ container, key: parts[i] });
    current = container[parts[i]];
  }

  if (current === null || typeof current !== 'object') {
    return;
  }
  delete (current as Record<string, unknown>)[parts[parts.length - 1]];

  // Walk back up and prune empty objects.
  for (let i = stack.length - 1; i >= 0; i--) {
    const { container, key } = stack[i];
    const child = container[key];
    if (
      child !== undefined &&
      typeof child === 'object' &&
      !Array.isArray(child) &&
      Object.keys(child as object).length === 0
    ) {
      delete container[key];
    } else {
      break;
    }
  }
}

/**
 * Generate parent wildcard paths for event bubbling.
 *   "provider.active.model"  -->  ["provider.active.*", "provider.*", "*"]
 */
function generateParentWildcardPaths(path: string): string[] {
  const parts = path.split('.');
  const paths: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    paths.push([...parts.slice(0, i), '*'].join('.'));
  }
  return paths;
}

/**
 * Deep-merge `source` into `target`. Returns a new object.
 * - Nested plain objects are merged recursively.
 * - Arrays and primitives are replaced (source wins).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Deep-clone via JSON round-trip.
 * Only used for FullConfig-shaped data (no functions, no undefined values).
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * 将旧格式配置（ConfigManager 的扁平格式）转换为 RuntimeConfigCenter 的嵌套格式。
 * 例如：{ provider: 'anthropic', model: 'claude-...' } → { provider: { active: 'anthropic' } }
 */
function normalizeConfig(persisted: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...persisted };

  // 旧格式：provider 是字符串（如 'anthropic'）
  // 新格式：provider 是对象 { active: string, routeMode: string, ... }
  if (typeof normalized.provider === 'string') {
    const providerName = normalized.provider as string;
    const modelName = normalized.model as string | undefined;
    normalized.provider = {
      active: providerName,
      routeMode: 'auto',
      enableThinking: false,
      anthropic: { model: modelName || providerDefault('anthropic'), apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { model: providerDefault('openai'), apiKeyEnv: 'OPENAI_API_KEY' },
      deepseek: { model: providerDefault('deepseek'), apiKeyEnv: 'DEEPSEEK_API_KEY' },
      gemini: { model: providerDefault('gemini'), apiKeyEnv: 'GEMINI_API_KEY' },
      local: {
        model: modelName || 'qwen2.5-7b',
        baseUrl: 'http://127.0.0.1:8080/v1',
        maxTokens: 4096,
        healthCheck: {
          restartDelayMs: 3000,
          intervalMs: 5000,
          timeoutMs: 5000,
          maxRetries: 6,
          startupTimeoutMs: 120000,
        },
      },
    };
  }

  // 删除旧格式的扁平 model 字段（已合并到 provider.active provider 中）
  if ('model' in normalized && typeof normalized.provider === 'object') {
    delete normalized.model;
  }

  return normalized;
}

// ============================================================
// Diff helpers (used by merge / reset-all / load)
// ============================================================

interface DiffEntry {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Compute a flat list of per-leaf differences between two config trees.
 */
function deepDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  prefix: string = '',
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    // Key exists only in one side.
    if (oldVal === undefined) {
      entries.push({ path: fullPath, oldValue: undefined, newValue: newVal });
      continue;
    }
    if (newVal === undefined) {
      entries.push({ path: fullPath, oldValue: oldVal, newValue: undefined });
      continue;
    }

    // Both sides are plain objects -- recurse.
    if (
      oldVal !== null &&
      typeof oldVal === 'object' &&
      !Array.isArray(oldVal) &&
      newVal !== null &&
      typeof newVal === 'object' &&
      !Array.isArray(newVal)
    ) {
      entries.push(
        ...deepDiff(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          fullPath,
        ),
      );
      continue;
    }

    // Primitives or arrays -- compare by value.
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      entries.push({ path: fullPath, oldValue: oldVal, newValue: newVal });
    }
  }

  return entries;
}

// ============================================================
// RuntimeConfigCenter
// ============================================================

import { DEFAULT_PROVIDERS, getProviderConfigLoader } from '../provider/config.js';

function providerDefault(providerId: string): string {
  try {
    const loader = getProviderConfigLoader();
    const meta = loader.getProvider(providerId);
    if (meta?.defaultModel) return meta.defaultModel;
  } catch {}
  return DEFAULT_PROVIDERS.providers[providerId]?.defaultModel ?? 'unknown';
}

export class RuntimeConfigCenter {
  private static instance: RuntimeConfigCenter;

  /** Default configuration provided at initialization time (immutable snapshot). */
  private defaults: FullConfig | null = null;

  /** Base defaults — the complete schema defaults, preserved for reload merging. */
  private baseDefaults: FullConfig | null = null;

  /** Runtime overrides keyed by dot-path segments (nested object). */
  private runtime: Record<string, unknown> = {};

  /** Persistence back-end. */
  private configManager: ConfigManager | null = null;

  /** Node.js event emitter used as the pub/sub transport. */
  private emitter: EventEmitter;

  /** Guards against use-before-initialize. */
  private initialized = false;

  // ----------------------------------------------------------
  // Singleton
  // ----------------------------------------------------------

  private constructor() {
    this.emitter = new EventEmitter();
    // Allow many concurrent watchers without hitting the default limit.
    this.emitter.setMaxListeners(500);
  }

  static getInstance(): RuntimeConfigCenter {
    if (!RuntimeConfigCenter.instance) {
      RuntimeConfigCenter.instance = new RuntimeConfigCenter();
    }
    return RuntimeConfigCenter.instance;
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /**
   * Initialise the config centre with default values and a persistence layer.
   * Must be called once before any other methods are used.
   * Calling it again resets all runtime overrides.
   */
  initialize(defaults: FullConfig, configManager: ConfigManager): void {
    this.defaults = deepClone(defaults);
    this.baseDefaults = deepClone(defaults);
    this.configManager = configManager;
    this.runtime = {};
    this.initialized = true;
  }

  // ----------------------------------------------------------
  // Read
  // ----------------------------------------------------------

  /**
   * Read a single config value by dot-path.
   * Returns `undefined` for unknown paths (does not throw).
   * Runtime overrides take precedence over defaults.
   */
  get<T = unknown>(path: string): T {
    this.ensureInitialized();

    // Check runtime overrides first.
    const runtimeVal = getByPath(this.runtime, path);
    if (runtimeVal !== undefined) {
      return runtimeVal as T;
    }

    // Fall back to defaults.
    return getByPath(this.defaults as unknown as Record<string, unknown>, path) as T;
  }

  /**
   * Return the complete effective configuration by deep-merging
   * runtime overrides into the default configuration.
   * The returned object is a fresh clone -- mutations will not affect the centre.
   */
  getAll(): FullConfig {
    this.ensureInitialized();
    return deepMerge(
      this.defaults as unknown as Record<string, unknown>,
      this.runtime,
    ) as unknown as FullConfig;
  }

  // ----------------------------------------------------------
  // Write
  // ----------------------------------------------------------

  /**
   * Set a single config value at the given dot-path.
   * Throws if the path does not structurally exist in the defaults schema.
   * Triggers change events for the exact path and all parent wildcard paths.
   */
  set(path: string, value: unknown): void {
    this.ensureInitialized();

    if (!hasPath(this.defaults as unknown as Record<string, unknown>, path)) {
      throw new Error(
        `[RuntimeConfigCenter] Cannot set unknown config path: "${path}". ` +
          `The path (or one of its ancestors) does not exist in the default configuration schema.`,
      );
    }

    const oldValue = this.get(path);

    setByPath(this.runtime, path, value);

    const timestamp = new Date().toISOString();
    const event: ConfigChangeEvent = { path, oldValue, newValue: value, timestamp };

    // Emit for the exact path.
    this.emitter.emit(path, event);

    // Emit for each parent wildcard so that broader watchers fire.
    for (const wildcardPath of generateParentWildcardPaths(path)) {
      this.emitter.emit(wildcardPath, event);
    }
  }

  /**
   * Deep-merge a partial config into the runtime overrides.
   * Fires change events for every path that actually changed.
   */
  merge(partial: Partial<FullConfig>): void {
    this.ensureInitialized();

    const oldConfig = this.getAll() as unknown as Record<string, unknown>;
    this.runtime = deepMerge(this.runtime, normalizeConfig(partial as unknown as Record<string, unknown>));
    const newConfig = this.getAll() as unknown as Record<string, unknown>;

    this.fireDiffs(oldConfig, newConfig);
  }

  /**
   * Reset runtime overrides.
   * - No argument  : reset everything back to defaults.
   * - With a path  : reset only that subtree.
   * Fires change events for every value that reverts.
   */
  reset(path?: string): void {
    this.ensureInitialized();

    if (path === undefined) {
      // Reset all.
      const oldConfig = this.getAll() as unknown as Record<string, unknown>;
      this.runtime = {};
      const newConfig = this.getAll() as unknown as Record<string, unknown>;
      this.fireDiffs(oldConfig, newConfig);
      return;
    }

    // Reset a specific subtree.
    const oldValue = this.get(path);
    deleteByPath(this.runtime, path);
    const newValue = this.get(path);

    // Only fire if the value actually changed.
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      const timestamp = new Date().toISOString();
      const event: ConfigChangeEvent = { path, oldValue, newValue, timestamp };

      this.emitter.emit(path, event);
      for (const wildcardPath of generateParentWildcardPaths(path)) {
        this.emitter.emit(wildcardPath, event);
      }
    }
  }

  // ----------------------------------------------------------
  // Watch
  // ----------------------------------------------------------

  /**
   * Subscribe to config changes matching a pattern.
   *
   * The `pattern` supports wildcards:
   *   - `"provider.*"` matches `"provider.active"`, `"provider.anthropic.model"`, etc.
   *   - `"*"` matches every path.
   *
   * Each callback is wrapped in a try-catch so that one failing subscriber
   * does not prevent others from receiving the event.
   *
   * @returns An unsubscribe function; call it to stop receiving events.
   */
  watch(pattern: string, callback: (event: ConfigChangeEvent) => void): () => void {
    const safeCallback = (event: ConfigChangeEvent) => {
      try {
        callback(event);
      } catch (err) {
        console.error(
          `[RuntimeConfigCenter] Error in watch callback for pattern "${pattern}":`,
          err,
        );
      }
    };

    this.emitter.on(pattern, safeCallback);

    return () => {
      this.emitter.off(pattern, safeCallback);
    };
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  /** 是否正在保存配置（用于 config-watcher 跳过自身 save 触发的文件变更） */
  isSaving = false;

  /**
   * Persist the current effective configuration via the ConfigManager.
   */
  async save(): Promise<void> {
    this.ensureInitialized();
    this.isSaving = true;
    try {
      const config = this.getAll();
      // ConfigManager.save accepts AgentConfig; FullConfig is a superset so
      // extra keys will be serialised and round-tripped safely through JSON.
      await this.configManager!.save(config as unknown as Parameters<ConfigManager['save']>[0]);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Reload configuration from the ConfigManager, diff against the previously-
   * effective config, and fire change events for every path that differs.
   */
  async load(): Promise<void> {
    this.ensureInitialized();

    const oldConfig = this.getAll() as unknown as Record<string, unknown>;

    // Reload from persistent storage and merge into the complete base defaults.
    // This ensures the defaults schema always stays intact even if the saved
    // config file is missing some fields.
    const persisted = await this.configManager!.load();

    this.defaults = deepMerge(
      this.baseDefaults as unknown as Record<string, unknown>,
      normalizeConfig(deepClone(persisted) as unknown as Record<string, unknown>),
    ) as unknown as FullConfig;
    this.runtime = {};

    const newConfig = this.getAll() as unknown as Record<string, unknown>;

    this.fireDiffs(oldConfig, newConfig);
  }

  // ----------------------------------------------------------
  // Internal utilities
  // ----------------------------------------------------------

  /** Throw a descriptive error if the centre has not been initialised yet. */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        '[RuntimeConfigCenter] Not initialized. Call initialize(defaults, configManager) before using the config center.',
      );
    }
  }

  /**
   * Compare two config snapshots and emit change events for every leaf that differs.
   */
  private fireDiffs(
    oldConfig: Record<string, unknown>,
    newConfig: Record<string, unknown>,
  ): void {
    const diffs = deepDiff(oldConfig, newConfig);
    if (diffs.length === 0) return;

    const timestamp = new Date().toISOString();

    for (const diff of diffs) {
      const event: ConfigChangeEvent = {
        path: diff.path,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        timestamp,
      };

      this.emitter.emit(diff.path, event);
      for (const wildcardPath of generateParentWildcardPaths(diff.path)) {
        this.emitter.emit(wildcardPath, event);
      }
    }
  }
}
