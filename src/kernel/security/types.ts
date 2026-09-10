/**
 * 安全内核类型定义。
 *
 * 内核定位（docs/security-kernel.md）：
 * - 参照 dsh：执行完整性如实上报（on/degraded/off）+ fail-closed；
 * - 参照 Codex：网络必须过中介、危险命令规则集；
 * - 进程内中介不是对抗"完全恶意且带原生 addon 插件"的最终边界（TCB 声明见文档）。
 */

/** 内核工作模式：enforce=拦截+审计；observe=只审计（排障用）；off=完全关闭 */
export type SecurityMode = 'enforce' | 'observe' | 'off';

/** 内核完整性状态：off=未安装；on=守卫在位；degraded=守卫被拆（fail-closed 加固） */
export type KernelStatus = 'off' | 'on' | 'degraded';

/**
 * 归因：本次 IO 由谁驱动。
 * - tool      LLM 工具执行期（ToolExecutor / runToolInline 包裹）—— 受最严策略
 * - schedule  定时任务执行（runtime-wiring 包裹）—— 与 tool 同级
 * - channel   渠道消息处理（clawbot 图片拉取等）—— 只审计，不拦私网（避免破坏局域网媒体）
 * - undefined 框架自身调用（provider / 渠道客户端 / 本地模型健康检查）—— 只做 env 守卫
 */
export interface ToolAttribution {
  kind: 'tool' | 'schedule' | 'channel';
  name: string;
}

/** 进程创建裁决 */
export interface ProcessDecision {
  allowed: boolean;
  reason?: string;
}

/** 命令分类裁决（工具层 bash 用） */
export interface CommandVerdict {
  level: 'ok' | 'review' | 'blocked';
  reasons: string[];
}

/** 审计事件（~/.agent/audit.jsonl 一行一条） */
export interface AuditEvent {
  type: string;
  ts: string;
  [key: string]: unknown;
}
