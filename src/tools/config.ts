import type { Tool } from './interface.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { ConfigSchemaEntry } from '../runtime/config-schema.js';
import { getDefaultConfig } from '../runtime/defaults.js';

// ============================================================
// Shared helpers (retained from original for update_config merge)
// ============================================================

/**
 * 深度合并 source 到 target（原地修改 target）
 * 支持嵌套对象，数组直接替换
 */
function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * 将点分隔路径的扁平对象展开为嵌套对象
 * 例如 { "training.enabled": true } => { training: { enabled: true } }
 */
function expandDotPaths(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let current: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      const lastPart = parts[parts.length - 1];
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        if (!current[lastPart] || typeof current[lastPart] !== 'object') {
          current[lastPart] = {};
        }
        deepMerge(current[lastPart], value);
      } else {
        current[lastPart] = value;
      }
    } else {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === 'object'
      ) {
        deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// ============================================================
// Schema walker used by createConfigSchemaTool
// ============================================================

/**
 * Recursively walk the default config tree and the current effective config
 * to produce a flat list of ConfigSchemaEntry descriptors.
 */
function buildSchemaEntries(
  defaults: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix: string = '',
): ConfigSchemaEntry[] {
  const entries: ConfigSchemaEntry[] = [];

  for (const key of Object.keys(defaults)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const defaultVal = defaults[key];

    // Read current value (may be overridden)
    let currentVal: unknown = undefined;
    if (current && typeof current === 'object') {
      currentVal = (current as Record<string, unknown>)[key];
    }

    if (
      defaultVal !== null &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal)
    ) {
      // Recurse into nested objects
      const childCurrent =
        currentVal !== null && typeof currentVal === 'object' && !Array.isArray(currentVal)
          ? (currentVal as Record<string, unknown>)
          : {};
      entries.push(
        ...buildSchemaEntries(
          defaultVal as Record<string, unknown>,
          childCurrent,
          fullPath,
        ),
      );
    } else {
      // Leaf value
      const typeLabel = Array.isArray(defaultVal) ? 'array' : typeof defaultVal;
      entries.push({
        path: fullPath,
        type: typeLabel,
        description: `Configuration: ${fullPath}`,
        defaultValue: defaultVal,
        currentValue: currentVal !== undefined ? currentVal : defaultVal,
      });
    }
  }

  return entries;
}

// ============================================================
// Tool factory functions
// ============================================================

/**
 * createGetConfigTool — reads current effective configuration.
 * Accepts optional `path` for a single value; otherwise returns full config.
 */
export function createGetConfigTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'get_config',
    description: '读取当前 Agent 配置。传入 dot-path 读取单个配置项（如 "provider.active"），不传则返回完整配置。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional dot-path to a specific config key (e.g. "provider.active"). Omit to get full config.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const path = args.path as string | undefined;

        if (path) {
          const value = configCenter.get(path);
          if (value === undefined) {
            return `Error: config path "${path}" not found.`;
          }
          return JSON.stringify(value, null, 2);
        }

        const config = configCenter.getAll();
        return JSON.stringify(config, null, 2);
      } catch (err) {
        return `Error reading config: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * createUpdateConfigTool — updates configuration at runtime.
 * Supports both dot-path flat keys and nested objects.
 * Persists changes via configCenter.save().
 */
export function createUpdateConfigTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'update_config',
    description:
      '更新 Agent 配置。支持 dot-path 键名（如 "session.maxTurns": 60）或嵌套对象。修改立即持久化。',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'Key-value pairs to update. Supports dot-path keys or nested objects.',
        },
      },
      required: ['updates'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const updates = args.updates as Record<string, unknown>;
        if (!updates || typeof updates !== 'object') {
          return 'Error: updates must be a non-null object';
        }

        // Separate dot-path keys from non-dot-path keys for set-by-path vs merge.
        const dotPaths: Array<{ path: string; value: unknown }> = [];
        const nested: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(updates)) {
          if (key.includes('.')) {
            dotPaths.push({ path: key, value });
          } else {
            nested[key] = value;
          }
        }

        // Apply dot-path keys one by one to benefit from validation.
        for (const { path, value } of dotPaths) {
          configCenter.set(path, value);
        }

        // Merge nested objects (these are already structured).
        if (Object.keys(nested).length > 0) {
          configCenter.merge(nested as any);
        }

        // Persist.
        await configCenter.save();

        return `Configuration updated successfully. Applied keys: ${Object.keys(updates).join(', ')}`;
      } catch (err) {
        return `Error updating config: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * createConfigSchemaTool — returns the configuration schema with defaults and current values.
 */
export function createConfigSchemaTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'config_schema',
    description:
      '返回完整配置 schema，包含每个配置项的路径、类型、描述、默认值和当前值。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const defaults = getDefaultConfig() as unknown as Record<string, unknown>;
        const current = configCenter.getAll() as unknown as Record<string, unknown>;
        const schema = buildSchemaEntries(defaults, current);
        return JSON.stringify(schema, null, 2);
      } catch (err) {
        return `Error building config schema: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * createResetConfigTool — resets runtime config overrides back to defaults.
 * Reset a single path or all paths.
 */
export function createResetConfigTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'reset_config',
    description:
      '将运行时配置恢复为默认值。传 dot-path 重置单项，不传则重置全部。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional dot-path to reset. Omit to reset all runtime overrides.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const path = args.path as string | undefined;

        if (path) {
          configCenter.reset(path);
          return `Config path "${path}" reset to default value.`;
        }

        configCenter.reset(); // no arg = reset all
        return 'All runtime config overrides have been reset to defaults.';
      } catch (err) {
        return `Error resetting config: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
