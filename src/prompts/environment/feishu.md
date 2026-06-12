# 飞书渠道配置

你可以通过飞书渠道让用户通过飞书客户端直接与 Agent 对话。

## 配置方式

修改 `.agent/config.json`，在 `channels` 字段中添加飞书配置：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "domain": "feishu",
      "dmPolicy": "open",
      "requireMention": true
    }
  }
}
```

## 配置字段说明

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | 否 | `true` | 是否启用飞书渠道 |
| `appId` | 是 | - | 飞书应用 App ID，从飞书开放平台获取 |
| `appSecret` | 是 | - | 飞书应用 App Secret |
| `domain` | 否 | `feishu` | `feishu`（国内飞书）/ `lark`（国际版 Lark） |
| `dmPolicy` | 否 | `allowlist` | 私聊策略：`open`（允许所有人私聊）/ `allowlist`（仅白名单用户）/ `disabled`（不允许私聊） |
| `allowFrom` | 否 | `[]` | 私聊白名单（用户 open_id 列表），空数组=不限制 |
| `groupPolicy` | 否 | `allowlist` | 群组策略，同上 |
| `groupAllowFrom` | 否 | `[]` | 群组白名单（chat_id 列表），空数组=不限制 |
| `requireMention` | 否 | `true` | 群聊中是否需要 @提及 机器人才回复 |
| `resolveSenderNames` | 否 | `true` | 是否调用 API 解析发送者名称（消耗 API 配额） |

## 获取 App ID 和 App Secret

用户需要：

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建「企业自建应用」
3. 添加「机器人」能力
4. 在「凭证与基础信息」页面获取 App ID 和 App Secret
5. 在「权限管理」中申请以下权限：
   - `im:message:send` — 发送消息
   - `im:message:receive` — 接收消息
6. 发布应用

## 使用方式

配置完成后，用户通过 `pnpm serve` 启动服务器，飞书渠道会自动连接。

用户可以在飞书客户端中：
- 搜索机器人名称，开始一对一私聊
- 将机器人添加到群组，@机器人 进行群聊

## 辅助用户配置（自动写入 + 重启生效）

当用户表示想用飞书连接 Agent，或用户直接提供了 App ID 和 App Secret 时，按以下步骤操作：

### 步骤 1：收集信息

询问用户：
- 飞书 App ID（格式: `cli_xxxxxxxxxxxx`）
- 飞书 App Secret
- 飞书版本：国内飞书（feishu）还是国际版 Lark

如果用户还没有，引导用户按上面「获取 App ID 和 App Secret」的步骤创建。

### 步骤 2：写入配置

配置文件路径：`<workspace>/.agent/config.json`

1. 先用 `read` 工具读取 `{workspace}/.agent/config.json`
2. 解析 JSON，在根对象中添加或更新 `channels` 字段：
```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "用户提供的 App ID",
      "appSecret": "用户提供的 App Secret",
      "domain": "feishu",
      "dmPolicy": "open",
      "requireMention": true
    }
  }
}
```
3. 用 `write` 工具将合并后的完整 JSON 写回 `{workspace}/.agent/config.json`

### 步骤 3：完成

配置写入后，调用 `restart` 工具重启 Agent 进程。重启后飞书渠道自动连接，当前 session 会被自动恢复。

告知用户：

> 配置已写入。请调用 `restart` 工具重启，飞书渠道将在重启后自动连接，当前 session 会恢复。

### 注意事项

- 写入时务必保留 config.json 中已有的其他配置（provider、model、maxTurns 等），不要覆盖
- 如果文件不存在，创建一个包含完整配置的新文件
- `update_config` 工具无法写入 channels 字段，必须用 `read` + `write` 工具直接操作文件
