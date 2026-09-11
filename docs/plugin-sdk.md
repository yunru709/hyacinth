# Plugin SDK —— 插件开发者契约

插件开发者只需面对**插件注册表（`PluginApi`）+ 本契约说明**即可编写插件（JS / TS），
**无需接触内核架构代码**。运行时能力由宿主注入，服务以字符串 key 访问，manifest 为纯声明式 JSON。

- 类型契约（TS）：`src/plugin-sdk/`（自包含、零内核 import；入口 `src/plugin-sdk/index.ts`）
- 纯 JS 插件：不需要任何 import，直接导出 `{ id, name, description, register, onActivate, onDeactivate }`，见 [companion/index.js](../../plugins/companion/index.js) 示范
- 安装方式：把插件目录放到 `<project>/.agent/plugins/<plugin-id>/`（用户级）或 `<project>/plugins/<plugin-id>/`（内置），在插件表（`extension-registry.json` / `plugins.config.json`）注册启用即可

---

## 一、快速上手（三步）

1. **写**：新建插件目录与两个文件（见下文示例）：

   ```
   <project>/.agent/plugins/my-plugin/
   ├── plugin.json     # manifest：id / entry / deps 等
   └── index.js        # 入口：export default { register, onActivate, ... }
   ```

2. **放**：目录放进 `.agent/plugins/`（用户级，随项目走）或 `plugins/`（内置 / 随代码分发）。加载器按 `发现 plugin.json → dynamic import entry` 顺序装载（`src/plugins/loader.ts`）。

3. **启**：以下任一方式启用（裁决链见「六、启用与裁决」）：
   - `hyacinth plugin install <目录|git-url>` 安装后，在 `.agent/plugins.config.json` 写 `{ "plugins": { "my-plugin": { "enabled": true } } }`；
   - 或在 `.agent/extension-registry.json` 的 `plugins` 段显式声明（决定性）；
   - 或依赖 manifest 的 `enabledByDefault`（默认启用则零配置）。
   - serve / TUI 运行中改名单或插件目录会**热生效**（无需重启）。

---

## 二、Manifest schema（plugin.json）

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
| `architecture` | object | | 可替换点声明（见第八节），如 `{ "source:companion_memory": { "impl": "...", "module": "./mods/memory.js" } }` |
| `priority` | number | | 同点冲突优先级（大者生效，缺省 0） |
| `version` | string | | 插件版本 |

实例：[plugins/companion/plugin.json](../../plugins/companion/plugin.json)

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

## 三、生命周期与入口

入口模块的 **default export** 必须是 `PluginDefinition`（TS 用 `definePlugin()` 构造；纯 JS 直接导出普通对象）。

| 阶段 | 回调 | 语义 |
|---|---|---|
| 装载 | `register(api)` | 注册能力（工具 / 技能 / 上下文源 / 服务…）。在插件被启用并激活时执行，先于 `onActivate` |
| 激活 | `onActivate(api)` | 运行时编排（读配置、取服务、激活子能力）。在 `register` 之后调用 |
| 卸载 | `onDeactivate(api)` | 清理（摘除本插件创建的资源）。**经 `registerTool` 等注册的能力无需手动注销**——宿主自动逆序回滚 |

```ts
import { definePlugin } from '../src/plugin-sdk/index.js';

export default definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  description: '注册一个工具 + 读一个服务',
  register: (api) => {
    api.registerTool({ /* ... */ });
  },
  async onActivate(api) {
    const svc = api.getService('bypass.manager');
    api.logger.info(`bypass manager available: ${!!svc}`);
  },
  async onDeactivate(api) {
    api.logger.info('bye');
  },
});
```

> 卸载语义：所有经 `register*` 注册的资源（工具 / 技能 / 上下文源 / 渠道 / 服务）都会在卸载时**自动回滚到注册前的状态**（存在则恢复旧值、不存在则删除），插件无需自己维护清理清单。

---

## 四、PluginApi（注册表能力）

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

## 五、配置（configSchema + getConfig）

1. 在 `plugin.json` 声明 `configSchema`（JSON Schema）。
2. 插件内经 `api.getConfig()` 读取——值来自 `.agent/plugins.config.json` 的 `config` 段（见「六」）。

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "properties": {
      "temperature": { "type": "number", "default": 0.7 },
      "verbose": { "type": "boolean", "default": false }
    }
  }
}
```

```ts
// index.ts —— onActivate 里读配置
onActivate: (api) => {
  const cfg = api.getConfig<{ temperature: number; verbose: boolean }>();
  api.logger.info(`verbose=${cfg.verbose}`);
}
```

---

## 六、启用与裁决

三层裁决（高优先覆盖低优先）：

```
extension-registry.json 显式声明（决定性用户声明）  >  plugins.config.json  >  manifest.enabledByDefault
```

- **`.agent/plugins.config.json`** —— 插件级配置 + 启用开关（`src/plugins/loader.ts` 读取）：

  ```json
  {
    "plugins": {
      "my-plugin": { "enabled": true, "config": { "temperature": 0.3 } }
    }
  }
  ```

- **`.agent/extension-registry.json`** —— 架构名单（`src/supervisor/extension-registry.ts` 裁决），`plugins` 段声明插件启停；serve 运行中修改名单由 `extension-registry-watcher` **热生效**（`enabled` 与实际挂载态不一致时自动 deactivate/activate）。

- **CLI**：`hyacinth plugin install/list/uninstall`（本地目录或 git URL → `.agent/plugins/`）；`hyacinth arch list/get/toggle` 查看可替换点与插件启停（serve 运行中热生效）。

- **热重载**：`plugin-watcher` 监听插件目录变更 → `pluginManager.loadAll()`（幂等，破缓存重 import，失败自动回滚旧版）。

---

## 七、服务目录（getService key）

内核只暴露轻量能力服务；业务逻辑（世界引擎、陪伴模式…）都在插件里。

| key | 类型 | 用途 |
|---|---|---|
| `bypass.manager` | BypassManager | 旁路 agent 的注册 / 激活 / 停用 |
| `world-engine.createAgent` | (name: string) => WorldEngine | 世界引擎工厂（创建实例） |
| `world-engine.agent` | WorldEngine | 当前世界引擎实例（由陪伴插件注册，router / UI 层取用） |
| `context.mode` | { activateCompanion, deactivateCompanion } | 上下文模式切换（companion Router + 角色回填） |

> 与 `src/plugin-sdk/types.ts` 的 `SERVICE_CATALOG` 常量同源；改动需同步。

---

## 八、可替换点目录（architecture 声明用）

`plugin.json` 的 `architecture` 字段 key 必须是下面目录中的点（`<kind>:<name>`）。
未声明的点走出厂实现（builtin）。

| kind | 点（节选） | 说明 |
|---|---|---|
| slot | `slot:input / bypass / context / llm / tools / finalize` | 内核回合 6 槽位，defaultImpl 为 builtin 阶段模块 |
| service | `service:compressor / turnRecorder / contextComposer / …` | 内核服务面（共 20+，可热替换） |
| provider | `provider:main` | 主通道模型实现 |
| router | `router:normal / companion` | 上下文模式路由 |
| source | `source:memory / companion_memory / session-tools / tool-bundles / …` | 上下文数据源（内置出厂 9 个） |
| 动态族 | `tool:*`、`channel:*`、`skill:*`、`agent:*`、`plugin:*`、`adapter:*` | 运行时动态注册族（插件注册即自动收录；adapter 为图/视频/音频生成适配器，`generation/registry` 动态装载） |

> ⚠️ 本目录与 `src/supervisor/extension-registry.ts` 的 `REPLACEABLE_POINTS` **同源**，改动需同步。
> 同一扩展点被多个插件申报时，裁决顺序：**用户配置 > 插件 priority > 插件 ID 字典序 > builtin 基线**。

---

## 九、完整示例

### 9.1 纯 JS（companion 风格，零 import）

`plugins/companion/index.js` 是最小可抄范本——只导出 `{ id, name, description, register, onActivate, onDeactivate }`：

```js
export default {
  id: 'my-plugin',
  name: 'My Plugin',
  description: '演示插件',
  register: () => {},                              // 无需注册能力时可留空

  async onActivate(api) {
    const bypassManager = api.getService('bypass.manager');
    const config = api.getConfig();
    if (bypassManager && config.autoActivate) {
      // 激活 modes 包含 'companion' 的旁路 agent（如陪伴模式；参考 plugins/companion/index.js）
      await bypassManager.activateForMode('companion');
    }
    api.registerTool({
      name: 'my_tool',
      description: '我的工具',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async (args) => `echo: ${args.q}`,
    });
    api.logger.info('activated');
  },

  async onDeactivate(api) {
    // 无需清理 registerTool 的工具——宿主自动回滚
    api.logger.info('deactivated');
  },
};
```

### 9.2 TS（definePlugin 风格）

见「三、生命周期与入口」示例。TS 插件也可以从 `src/plugin-sdk/index.ts` 导入 `HostTool` 等窄接口获得类型补全。

### 9.3 声明可替换点（architecture）

在 `plugin.json` 中声明 `architecture`，把某个内置点换成自己的实现：

```json
{
  "id": "my-plugin",
  "architecture": {
    "source:companion_memory": { "impl": "my:memory", "module": "./mods/memory.js" }
  }
}
```

---

## 十、验证与排错

- **装载失败**：`src/plugins/loader.ts` 在 entry import 失败时记 warn 并返回 null（插件不进宿主，不报错崩溃）；`hyacinth arch list` 可查点状态。
- **激活失败**：`PluginHost.mount` 失败会回滚已注册资源并保留 error 状态（`src/kernel/plugin-host.ts`）。
- **依赖缺失**：`deps` 声明了但同宿主不存在 → mount 时直接报错（而非运行时 undefined）。
- **热重载失败**：`reloadFromDisk` 失败自动回滚旧版（`src/plugins/manager.ts`）；extension-registry 名单校验失败保留旧名单继续运行（`src/hot-reload/extension-registry-watcher.ts`）。
- **测试**：参考 `src/plugins/plugins.test.ts`（目录插件装载/启停/卸载回滚）、`src/plugins/bypass-plugin.test.ts`（内核插件 mount/unmount 可逆性）。
