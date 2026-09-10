/**
 * extension-contracts.ts —— 可替换点契约集中面（注册表即开发者手册）。
 *
 * 与 REPLACEABLE_POINTS 目录（supervisor/extension-registry.ts）搭配：
 *   目录声明「哪里能换」（id / kind / defaultImpl / description / contract），
 *   本文件声明「换的东西长什么样」（各 kind 的接口形状）。
 *
 * 开发者的完整闭环：
 *   1. 在目录里找到要替换的点（如 `slot:context`）；
 *   2. 按该点 contract 字段指向的接口（本文件导出）实现用户模块；
 *   3. 在 extension-registry.json 名单里声明 `{ point, impl, module }`；
 *   4. 装配层按 kind 分发（gateway/arch-assembly.ts）动态装载并校验生效。
 *
 * 本文件只做类型 re-export（import type），编译期被擦除，零运行时依赖，
 * 因此不引入分层违规（与 types.ts / events.ts 同为跨层中立类型面）。
 */

// ── provider:main —— 主通道模型 ─────────────────────────────────────
export type { Provider } from './provider/interface.js';

// ── slot:* —— 内核管线阶段模块 ───────────────────────────────────────
export type { StageModule, FieldContract, StageContext } from './kernel/pipeline.js';

// ── service:* —— 内核阶段服务表 ──────────────────────────────────────
// 服务面契约的真相源：StageServiceMap（service:<key> 的契约 = StageServiceMap[<key>]）。
export type { StageServiceMap, StageServiceKey } from './orchestrator/stage-services.js';
// 高频服务的具体契约（供目录 contract 精确定位）
export type { CompressorOrchestrator } from './context/compressor.js';   // service:compressor
export type { ContextComposerLike } from './context/interface.js';       // service:contextComposer

// ── source:* —— 上下文数据源 ─────────────────────────────────────────
export type { ContextSource } from './context/interface.js';

// ── router:* —— 上下文模式路由 ───────────────────────────────────────
export type { IContextRouter } from './context/router.js';

// ── agent:* —— 子 Agent 定义 ─────────────────────────────────────────
export type { AgentDefinition } from './types.js';

// ── tool:* / skill:* —— 能力注册项 ───────────────────────────────────
export type { ToolDefinition } from './types.js';
export type { SkillDefinition } from './types.js';

// ── plugin:* —— 插件本体（内核挂载面） ────────────────────────────────
export type { HyPlugin, PluginContext } from './kernel/plugin-host.js';

// ── adapter:* —— 生成适配器（图/视频/音频） ───────────────────────────
export type { GenerationAdapterFactory } from './generation/registry.js';

// ── channel:* —— 接入渠道 ────────────────────────────────────────────
export type { ChannelPlugin } from './channels/auto-detect.js';
