/**
 * assembly-whitelist.mjs —— 装配层直接 new 业务类白名单（P6-4 门禁 · 单一真源）。
 *
 * 被两处引用，保证不漂移：
 * - verify:layers 规则 3：factory 中每个 new 业务类必须 ∈ ALLOWED_DIRECT_NEW，
 *   且白名单 ⊆ 实际（双向）—— 违规 exit 1（CI 硬校验）；
 * - assembly-graph.test.ts 守卫 B：基线从本表派生（替代原硬编码 INSTANCE_BASELINE）。
 *
 * **只减不增**：P6 每把一类迁出 factory（经装配贡献 / 服务表 / 工厂间接创建），
 * 从本表删除一条 —— 白名单是"待迁移清单"，不是豁免许可证。
 * ASSEMBLY_EXCLUDED 是语言/库/装配工具（非业务类，不计入）。
 */
export const ASSEMBLY_EXCLUDED = new Set([
  'Set', 'Map', 'Error', 'Date', 'Promise', 'RegExp', 'URL', 'Array', 'Tool', 'AssemblyRunner',
]);

export const ALLOWED_DIRECT_NEW = new Set([
  // 工具执行 —— 子 Agent 委托工具（createSubProvider 闭包已抽至 boot.ts，本体现留）。
  // 后续若再迁：需 DelegateToAgentTool 接受 deps 对象或工厂注入。
  'DelegateToAgentTool',
  // 主循环 —— 内核本体，方案明确「不追求 AgentLoop 可替换」，唯一合理残留。
  // 其余装配全部经 *-contributions.ts 贡献批 / boot.ts 引导完成。
  'AgentLoop',
]);
