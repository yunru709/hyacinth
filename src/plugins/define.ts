import type { PluginDefinition, PluginApi } from './types.js';

export type DefinePluginOptions = {
  id: string;
  name: string;
  description: string;
  configSchema?: Record<string, unknown>;
  register: (api: PluginApi) => void | Promise<void>;
  onActivate?: (api: PluginApi) => void | Promise<void>;
  onDeactivate?: (api: PluginApi) => void | Promise<void>;
};

/**
 * 定义插件入口。
 *
 * 用法：
 * ```ts
 * export default definePlugin({
 *   id: 'my-plugin',
 *   name: 'My Plugin',
 *   description: 'Does something',
 *   register: (api) => {
 *     api.registerTool(myTool);
 *   },
 * });
 * ```
 */
export function definePlugin(options: DefinePluginOptions): PluginDefinition {
  const { id, name, description, configSchema, register, onActivate, onDeactivate } = options;

  const def: PluginDefinition = {
    id,
    name,
    description,
    register,
  };

  if (configSchema) def.configSchema = configSchema;
  if (onActivate) def.onActivate = onActivate;
  if (onDeactivate) def.onDeactivate = onDeactivate;

  return def;
}