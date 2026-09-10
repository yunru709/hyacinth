/**
 * plan-execute/types.ts —— 预测式批量执行的类型（Plan / Step / 断言）。
 *
 * 预测式执行：规划任务 → 每步写命令 + 结构化预测断言 → 机械执行，
 * 结果满足预测则自动推进（零 LLM），落空则交回主循环（onMiss: handoff）。
 *
 * 粒度不设规则：commands[] 长度/串并行由规划器（LLM）自定，
 * 唯一硬约束是 prediction 必须可被断言验收（schema 强校验）。
 */

/** 一步内的单个工具调用（工具 = 系统内的 bash/read/write…，非 shell 字符串） */
export interface CommandCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * 结构化断言原语（零 LLM，纯规则校验）。
 * 作用于一步内全部命令的聚合结果（联合验收）：
 *  - success        所有目标命令无错（is_error === false）
 *  - outputContains 任一命令输出包含子串
 *  - outputMatches  任一命令输出匹配正则
 *  - stdoutEmpty    所有命令输出为空（true）/ 至少一条非空（false）
 *  - fileExists     文件系统存在该路径
 *  - fileContains   文件内容含子串/正则
 *  - jsonField      解析首个 JSON 输出，校验字段
 */
export type AssertionPrimitive =
  | { success: boolean }
  | { outputContains: string }
  | { outputMatches: string }
  | { stdoutEmpty: boolean }
  | { fileExists: string }
  | { fileContains: { path: string; pattern: string } }
  | { jsonField: { field: string; equals?: unknown; exists?: boolean; contains?: string } };

/** 断言（可组合：all/any/not 嵌套） */
export type Prediction =
  | AssertionPrimitive
  | { all: Prediction[] }
  | { any: Prediction[] }
  | { not: Prediction };

/** 一个执行步骤：一组命令 + 一个联合断言 */
export interface PlanStep {
  commands: CommandCall[];
  /** 对整个命令组的验收断言（联合预测，含多工具场景） */
  prediction: Prediction;
  /** 组内命令并行执行（默认串行：后命令可依赖前命令的副作用） */
  parallel?: boolean;
  /** 本步整体超时（毫秒；缺省走工具执行器默认超时） */
  timeoutMs?: number;
}

/** 预测式执行计划 */
export interface Plan {
  steps: PlanStep[];
}

/** 单条命令的执行结果（供断言评估） */
export interface CommandResult {
  tool: string;
  /** 工具返回内容（stdout/文本） */
  content: string;
  /** 工具是否报错（ToolExecutor 的 is_error） */
  is_error: boolean;
}
