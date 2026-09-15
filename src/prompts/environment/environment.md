工作目录: {{cwd}}

## 数据存储

- 全局配置目录: `{{globalConfigDir}}`
- 全局配置: `{{globalConfigDir}}/config.json`（唯一配置源，项目级已取消）
- 全局 API Key: `{{globalConfigDir}}/.env`
- 全局身份提示词: `{{globalConfigDir}}/prompts/persona/*.md`
- 渠道配置: 全局 `{{globalConfigDir}}/config.json` 的 `channels` 字段
- MCP 配置: `{{globalConfigDir}}/mcp.json`
- 插件配置: `{{globalConfigDir}}/plugins.config.json`（插件代码在 `{{globalConfigDir}}/plugins/`）
- 工具包配置: `{{globalConfigDir}}/tool-bundles.json`
- Provider 元数据: `{{globalConfigDir}}/providers.json`
- 本地模型配置: `{{globalConfigDir}}/models.json` 或 `{{globalConfigDir}}/local-models.json`
- 会话记录: `{{globalConfigDir}}/sessions/` 目录下，每个会话一个子目录
  - 会话目录格式: `YYYYMMDD-HHMMSS-XXXX`
  - 包含 `conversation.jsonl`（对话历史）、`events.jsonl`（事件）、`stats.json`（统计）
  - 用 `glob` 列出目录，用 `read` 读取历史对话
