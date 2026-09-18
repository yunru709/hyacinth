/**
 * ui-direct-whitelist.mjs —— UI 适配层直连业务核心白名单（规则 5 门禁 · 单一真源）。
 *
 * **只减不增**：每把一个 UI 侧直连改为经协议层调用，从本表删除一条。
 * 白名单是"待迁移清单"，不是豁免许可证 —— 已登记但实际不再直连同样违规
 * （verify:layers 规则 5 的 stale 检测，防豁免虚增）。
 *
 * 键：'相对 src/ 的文件路径'（/ 分隔）  值：允许直连的顶层目录集合。
 * 不算"业务核心"的目录（纯工具/常量/类型/UI 内部，允许直连）见
 * UI_DIRECT_EXCLUDED；指向 ui-protocol 的引用在规则内直接豁免（走协议正是目标）。
 *
 * 迁移基线（2026-09-05，T4）：T1/T3 channel 收口后全量违规登记，31 文件 / 87 对。
 * 其中 gateway/tui-channel-cmds.ts 已零业务直连（T1 收口后不经协议即不可见），
 * 未入表 —— 即任务书验收 4「T1 完成后 provider 条目可从白名单删除」的前置满足。
 *
 * 语义分类（T11 纯协议客户端化后修订，2026-09-05）：
 * 1. 装配/接线类（*-wiring/contribution/assembly/server/boot）：把业务模块接进
 *    系统是本职，直连为架构所需 —— 永不迁移，本表是其豁免凭证。
 * 2. 本地宿主装配豁免（gateway/tui.ts 等）：本地 InProc 模式下 TUI 与协议宿主
 *    同进程，剩余直连（channels/local-model/memory/provider/setup/supervisor）支撑
 *    「宿主角色装配 + 本地渲染数据」，非管理操作绕过 —— 管理命令已全部协议化。
 * 3. 诊断/进程保留（CLI arch/export/localModel 等）：单发进程诊断或进程管理，无
 *    协议等价物，按架构保留直连。
 * 待迁移的「交互管理操作」已清零 —— 本表当前条目均为上述豁免/保留类。
 */

/** UI 适配层直连业务核心白名单（T1/T3 收口后的迁移起点，只减不增） */
export const UI_DIRECT_ALLOWED = new Map([
  ['channels/auto-detect.ts', new Set(['setup'])],
  ['channels/builtin/http-webhook.ts', new Set(['context', 'gateway', 'local-model', 'prompts', 'runtime', 'setup'])],
  ['channels/builtin/ui-protocol-session.ts', new Set(['companion', 'generation', 'hot-reload'])],
  ['gateway/agent-assembly.ts', new Set(['agents', 'dependency', 'evolution', 'memory', 'orchestrator', 'provider', 'skills', 'supervisor', 'tools'])],
  ['gateway/arch-assembly.ts', new Set(['context', 'supervisor'])],
  ['gateway/base-contributions.ts', new Set(['evolution', 'machine', 'rollback'])],
  ['gateway/boot.ts', new Set(['memory', 'provider', 'setup'])],
  ['gateway/bootstrap-wiring.ts', new Set(['provider', 'setup'])],
  ['gateway/bypass-wiring.ts', new Set(['plugins'])],
  ['gateway/channel-contributions.ts', new Set(['provider'])],
  ['gateway/cli.ts', new Set(['lifecycle', 'memory', 'orchestrator', 'provider', 'runtime', 'setup', 'supervisor', 'update'])], // lifecycle：诊断/进程保留（arch/export 等读全局注册表，无协议等价物）
  ['gateway/config-wiring.ts', new Set(['context', 'generation', 'hot-reload', 'provider', 'runtime', 'tools'])],
  ['gateway/context-chain-contributions.ts', new Set(['context'])],
  ['gateway/context-mode-service.ts', new Set(['context'])],
  ['gateway/core-contributions.ts', new Set(['memory', 'skills'])],
  ['gateway/infra-contributions.ts', new Set(['mcp', 'memory', 'schedule'])],
  ['gateway/media-routes.ts', new Set(['generation', 'media'])],
  ['gateway/orchestrator-contributions.ts', new Set(['agents', 'orchestrator', 'provider', 'tools'])],
  ['gateway/plugin-contributions.ts', new Set(['plugins'])],
  ['gateway/plugin-manager-contribution.ts', new Set(['plugins'])],
  ['gateway/runtime-contributions.ts', new Set(['hot-reload', 'provider', 'tools'])],
  ['gateway/runtime-wiring.ts', new Set(['context', 'setup'])],
  ['gateway/server.ts', new Set(['channels', 'memory', 'provider', 'runtime', 'setup', 'supervisor'])],
  ['gateway/tool-registration.ts', new Set(['rollback', 'tools'])],
  ['gateway/tui-format.ts', new Set(['memory'])], // 只读事件回放渲染（本地展示）
  ['gateway/tui-model-cmds.ts', new Set(['setup'])], // 上下文窗口本地常量（runtime 直连已随 T11 清理移除）
  // 本地宿主装配豁免（T11 纯协议客户端化）：管理命令全协议化，剩余 import 支撑
  // 宿主角色（channelManager/supervisor/localModel 进程）+ 本地 stats 渲染 + 共享组件源
  ['gateway/tui.ts', new Set(['channels', 'lifecycle', 'local-model', 'memory', 'provider', 'runtime', 'setup', 'supervisor'])],
  ['gateway/world-engine-service.ts', new Set(['world-engine'])],
  // 命令面板读取 provider 的模型目录 / 元信息**用于展示**（只读渲染数据；管理命令已全部协议化）
  ['ui/command-registry.ts', new Set(['provider'])],
]);

/** 不算"业务核心"的目标目录（纯工具/常量/类型/UI 内部/内核，允许直连）。
 *  '' = src 根级基础文件（events.ts / types.ts / index.ts 等中立层）。 */
export const UI_DIRECT_EXCLUDED = new Set([
  '', 'ui', 'webui', 'logging', 'utils', 'env', 'kernel',
]);
