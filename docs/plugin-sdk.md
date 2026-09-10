# Plugin SDK —— 插件开发者契约

插件开发者只需面对**插件注册表（`PluginApi`）+ 本契约说明**即可编写插件（JS / TS），
**无需接触内核架构代码**。运行时能力由宿主注入，服务以字符串 key 访问，manifest 为纯声明式 JSON。

- 类型契约（TS）：`src/plugin-sdk/`（自包含、零内核 import；入口 `src/plugin-sdk/index.ts`）
- 纯 JS 插件：不需要任何 import，直接导出 `{ id, name, description, register, onActivate, onDeactivate }`，见 [companion/index.js](../../agent/plugins/companion/index.js) 示范
- 安装方式：把插件目录放到 `<project>/.agent/plugins/<plugin-id>/`（用户级）或 `<project>/plugins/<plugin-id>/`（内置），在插件表（`extension-registry.json` / `plugins.config.json`）注册启用即可

---

## 一、Manifest schema（plugin.json）

存放于插件目录根：`<plugin-id>/plugin.json`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一插件 ID（缺省用目录名） |
| `name` | string | ✅ | 显示名称 |
| `description` | string | ✅ | 简短描述 |
| `entry` | string | ✅ | 入口模块路径（相对 manifest 目录） |
| `deps` | string[] | | 依赖的插件 ID（同宿主内；mount 时校验，缺失报错） |
| `enabledByDefault` | boolean | | 默认是否启用 |
| `skills` | string[] | | Skill 定义目录列表 |
| `configSchema` | object | | 配置 JSON Schema（`api.getConfig()` 取到的形状） |
| `architecture` | object | | 可替换点声明（见第四节），如 `{ "source:companion_memory": { "impl": "...", "module": "./mods/memory.js" } }` |
| `priority` | number | | 同点冲突优先级（大者生效，缺省 0） |
| `version` | string | | 插件版本 |

实例：[plugins/companion/plugin.json](../../agent/plugins/companion/plugin.json)

```json
{
  "id": "companion",
  "name": "陪伴模式",
  "description": "陪伴模式聚合插件",
  "entry": "./index.js",
  "deps": ["bypass"],
  "enabledByDefault": true,
  "priority": 100,
  "architecture": {
    "source:companion_memory": { "impl": "companion:memory", "module": "./mods/memory.js" }
  }
}
```

---

## 二、PluginApi（注册表能力）

宿主在 `register()` / `onActivate()` 时把 `api` 注入插件。TS 类型见 `src/plugin-sdk/types.ts`。

| 方法 | 语义 |
|---|---|
| `registerTool(tool: HostTool)` | 注册工具（`{ name, description, inputSchema, execute }`） |
| `registerSkill(skill)` | 注册 Skill |
| `registerContextSource(source)` | 注册上下文来源（`{ name, strategy, cacheability, getContent }`） |
| `registerMcpServer(config)` | 注册 MCP Server 配置（宿主负责连接） |
| `registerChannel(handler, config?)` | 注册渠道处理器（IM / Webhook / 自定义消息源） |
| `registerService(key, service)` | 注册内核服务（卸载自动回滚到原值，支持热替换） |
| `getService<T>(key)` | 读取其他插件/内核注册的服务 |
| `unregisterTool / unregisterSkill / unregisterMcpServer / unregisterContextSource / unregisterChannel` | 反向注销 |
| `onHook(name, handler)` | 挂载主循环钩子（观察/过滤，卸载自动摘除） |
| `aroundHook(name, handler)` | 包裹主循环接缝（可短路/改写，卸载自动摘除） |
| `getConfig<T>()` | 读取插件自身配置（对应 `configSchema`） |
| `logger` / `pluginId` | 日志 / 插件 ID |

最小示例（TS）：

```ts
import { definePlugin } from '../src/plugin-sdk/index.js';

export default definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  description: '注册一个工具 + 读一个服务',
  register: (api) => {
    api.registerTool({
      name: 'hello',
      description: '返回问候语',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'hello from plugin',
    });
    const svc = api.getService('bypass.manager');
    api.logger.info(`bypass manager available: ${!!svc}`);
  },
});
```

---

## 三、服务目录（getService key）

内核只暴露轻量能力服务；业务逻辑（世界引擎、陪伴模式…）都在插件里。

| key | 类型 | 用途 |
|---|---|---|
| `bypass.manager` | BypassManager | 旁路 agent 的注册 / 激活 / 停用 |
| `world-engine.createAgent` | (name: string) => WorldEngine | 世界引擎工厂（创建实例） |
| `world-engine.agent` | WorldEngine | 当前世界引擎实例（由陪伴插件注册，router / UI 层取用） |
| `context.mode` | { activateCompanion, deactivateCompanion } | 上下文模式切换（companion Router + 角色回填） |

> 与 `src/plugin-sdk/types.ts` 的 `SERVICE_CATALOG` 常量同源；改动需同步。

---

## 四、可替换点目录（architecture 声明用）

`plugin.json` 的 `architecture` 字段 key 必须是下面目录中的点（`<kind>:<name>`）。
未声明的点走出厂实现（builtin）。

| kind | 点（节选） | 说明 |
|---|---|---|
| slot | `slot:input / bypass / context / llm / tools / finalize` | 内核回合 6 槽位，defaultImpl 为 builtin 阶段模块 |
| service | `service:compressor / turnRecorder / contextComposer / …` | 内核服务面（共 20+，可热替换） |
| provider | `provider:main` | 主通道模型实现 |
| router | `router:normal / companion` | 上下文模式路由 |
| source | `source:memory / companion_memory / session-tools / tool-bundles / …` | 上下文数据源（内置出厂 9 个） |
| 动态族 | `tool:*`、`channel:*`、`skill:*`、`agent:*`、`plugin:*` | 运行时动态注册族（插件注册即自动收录） |

> ⚠️ 本目录与 `src/supervisor/extension-registry.ts` 的 `REPLACEABLE_POINTS` **同源**，改动需同步。
> 同一扩展点被多个插件申报时，裁决顺序：**用户配置 > 插件 priority > 插件 ID 字典序 > builtin 基线**。
