# 飞书渠道静默故障诊断报告（2026-08-05）

## 现象

用户报告：8/5 早晨运行 agent，当天下午通过飞书发消息，没有任何响应。

## 根因（确认）

**飞书渠道从未被启动——config.json 在 8/4 22:37 被改写，`channels.feishu` 配置（含 appId/appSecret）被移除。**

飞书渠道的注册完全依赖配置：

- `src/channels/auto-detect.ts` → `registerConfigChannels()` 从 config.json 读 `channels.feishu`
- `src/channels/plugins/feishu/index.ts:91` → `shouldRun = enabled !== false && appId && appSecret`，缺配置直接不注册
- 缺 appId/appSecret → 渠道不注册 → WebSocket 不建立 → 消息无人接收

## 证据链（时间线，UTC+8）

| 时间 | 事件 |
|---|---|
| 8/4 21:05 | 飞书最后活跃：`feishu_chat.json` 最后写入（155 字节） |
| **8/4 22:37** | **`~/.agent/config.json` 被改写**：从含 `channels.feishu` 变为只剩 `provider/model/maxTurns/maxContext`（103 字节），飞书配置丢失 |
| 8/5 02:11 | 用户早晨启动的进程（PID 31152）加载的是已无飞书配置的 config.json |
| 8/5 下午 | 用户发飞书 → 无进程监听 → 无响应 |
| 8/5 20:57 | 当前进程启动，日志明确：`starting channels count: 1`（仅 tui，无 feishu） |

日志佐证：

- 8/4 的 tui.log 中飞书渠道正常：`channel started`、`WebSocket connected`、`received: om_x100b... from=ou_37f06... chat=oc_68567...`
- 8/5 日志（08:00 后）无任何飞书渠道启动记录，仅 `channel registered: tui` + `starting channels count: 1`

## 当前 config.json 状态

8/5 23:46 又被改写为完整默认模板（3905 字节），`channels.feishu` 存在但：
```json
"feishu": { "enabled": false, "appId": "", "appSecret": "", ... }
```
**enabled=false、凭据为空 → 渠道仍然不会启动。**

## 与 "no loop available" 的关系（澄清）

`handleTaskNotification: no loop available` 在 tui.log 中累计 **57,179 次**（6/28 ~ 8/4 飞书正常运行时即有），是**另一个独立的历史代码缺陷**：

- `start()` 漏读 `config.agentFactory` → 重启后 `this.agentFactory = null`
- `restoreFeishuState()` 不恢复 loop
- `handleTaskNotification` 无 loop 直接 return

但它**不是** 8/5 下午无响应的原因——那天飞书渠道压根没启动。

## 恢复方案（待用户确认后执行）

1. **需要飞书 appId/appSecret**（原配置已随 8/4 22:37 改写丢失，无备份）
2. 在 `~/.agent/config.json` 的 `channels.feishu` 填入：
   ```json
   "feishu": { "enabled": true, "appId": "<appId>", "appSecret": "<appSecret>", "domain": "feishu" }
   ```
3. 重启 agent，确认日志出现 `channel started` + `WebSocket connected`
4. 建议顺带修复代码缺陷（start() 补读 agentFactory + handleTaskNotification 惰性创建 loop），否则定时任务路由到飞书仍会失败

## 待调查

- config.json 8/4 22:37 被谁改写（用户确认未手动操作）
- 8/5 23:46 的完整模板重写来源
