# 配置提示词增强记录

日期: 2026-06-08

## 背景

之前在 release 环境中尝试让 Agent 配置飞书渠道时，模型没有明确知道应该修改哪个配置文件，也容易把渠道配置当成普通运行时配置处理。

排查后确认：

- `src/prompts/environment/feishu.md` 已经包含飞书配置细节，但它不是默认注入上下文。
- `src/prompts/tools/framework-capabilities.md` 是默认注入的框架能力提示词，适合放通用配置指导。
- `src/prompts/environment/environment.md` 是默认环境段，适合放配置文件路径索引。

## 修改内容

### framework-capabilities.md

文件: `src/prompts/tools/framework-capabilities.md`

新增了两类配置指导：

1. 运行时配置
   - 明确 `get_config` / `update_config` / `reset_config` / `config_schema` 适合修改 RuntimeConfigCenter 已支持的路径。
   - 补充常见路径，例如 `provider.active`、`provider.<provider>.model`、`session.maxTurns`、`session.maxContext`、`safety.requireConfirmation`、`tools.disabled`、`skills.disabled`、`models.assessment`、`logging.level`、`hotReload.*` 等。

2. 项目文件配置
   - 明确部分配置不应优先使用 `update_config`，而应读取并写回项目 `.agent/` 下的 JSON 文件。
   - 覆盖渠道、MCP、工具包、Provider 元数据、本地模型、本地 Provider、子 Agent、身份提示词等配置入口。
   - 为渠道配置增加专门说明，明确飞书/Lark 等渠道写入项目级 `.agent/config.json` 的 `channels` 字段。
   - 强调修改 JSON 时必须保留已有字段，只合并用户要求的部分。

### environment.md

文件: `src/prompts/environment/environment.md`

新增默认环境路径索引：

- 全局身份提示词: `~/.agent/prompts/persona/*.md`
- 渠道配置: 项目级 `{{cwd}}/.agent/config.json` 的 `channels` 字段
- MCP 配置: `{{cwd}}/.agent/mcp.json`
- 工具包配置: `{{cwd}}/.agent/tool-bundles.json`
- Provider 元数据: `{{cwd}}/.agent/providers.json`
- 本地模型配置: `{{cwd}}/.agent/models.json` 或 `{{cwd}}/.agent/local-models.json`

## 预期效果

模型在用户要求修改框架设置时，应先判断目标属于哪类配置：

- 如果路径存在于 `config_schema`，优先使用 `update_config`。
- 如果是渠道、MCP、工具包、Provider 元数据、本地模型等项目文件配置，则使用 `read` + `write` 修改对应 JSON。
- 配置飞书/Lark 渠道时，优先修改当前工作区 `.agent/config.json` 的 `channels.feishu`，不要误用 `update_config`。
- 修改前应告知用户当前值和计划改成的值，且不应把 API Key 写入不合适的位置。

## 验证

已执行：

```powershell
corepack pnpm run build
```

结果：

- TypeScript 编译通过。
- `src/prompts` 已同步复制到 `dist/prompts`。
- 已确认 `dist/prompts/tools/framework-capabilities.md` 中包含新增的运行时配置、项目文件配置和渠道配置说明。
