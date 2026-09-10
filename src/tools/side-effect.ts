/**
 * 工具副作用元数据 —— 审批 / 回滚 / LoopGuard / path-sandbox 四张名单的单一来源。
 *
 * 背景：此前审批（dangerousTools）、回滚（WRITE_TOOLS）、LoopGuard（MUTATING_TOOLS）、
 * 路径围栏（WRITE_TOOLS）各维护一份按名字判定的集合，互不同步：edit 系列在治理层
 * 被视为写工具（要做回滚/围栏/风暴检测），审批层却认为它不需要人看。且对插件/MCP
 * 注册的写工具全部失效。
 *
 * 设计（对应「可插拔接口稳定」原则）：
 * - 工具可在定义处声明 sideEffect（Tool 接口可选字段，向后兼容）；
 * - 未声明时按 LEGACY_SIDE_EFFECT 按名兜底（覆盖全部内置工具）；
 * - 仍未命中视为 'read'（与旧行为一致：不在危险名单 → 自动放行）。
 *
 * 外部配置（safety.dangerousTools）仍权威：用户显式声明的名字与推导集合并
 * （加性覆盖）；要豁免某个工具请用 safety.allowedTools 或会话 allowlist。
 */

export type SideEffect = 'read' | 'write' | 'exec';

/** 旧内置工具按名字的副作用兜底表（工具定义处未声明 sideEffect 时的退路） */
export const LEGACY_SIDE_EFFECT: Readonly<Record<string, SideEffect>> = {
  // 写文件系统
  write: 'write',
  edit: 'write',
  insert: 'write',
  multi_edit: 'write',
  json_edit: 'write',
  delete: 'write',
  archive: 'write',
  // 执行命令 / 代码 / 网络副作用
  bash: 'exec',
  git_tool: 'exec',
  db_query: 'exec',
  process: 'exec',
  restart: 'exec',
  http_request: 'exec',
};

/** 取工具副作用：声明优先，旧表兜底，未知只读（保守放行，与旧行为一致） */
export function sideEffectOf(name: string, declared?: SideEffect): SideEffect {
  if (declared) return declared;
  return LEGACY_SIDE_EFFECT[name] ?? 'read';
}

/** 是否写类工具（修改工作区/文件系统）—— 回滚前置状态 / 路径围栏 / 写冲突检测共用 */
export function isWriteTool(name: string, declared?: SideEffect): boolean {
  return sideEffectOf(name, declared) === 'write';
}

/** 是否执行类工具（命令/代码/网络，副作用不可逆）—— 命令记录 / 审批共用 */
export function isExecTool(name: string, declared?: SideEffect): boolean {
  return sideEffectOf(name, declared) === 'exec';
}

/** 是否会改变系统外部状态（write | exec）—— LoopGuard 风暴检测等共用 */
export function isMutatingTool(name: string, declared?: SideEffect): boolean {
  return sideEffectOf(name, declared) !== 'read';
}

/**
 * 从注册表推导「默认需要审批」的工具名集合：所有非只读工具（write/exec），
 * 含声明了 sideEffect 的插件 / MCP 工具。仅当外部配置 safety.dangerousTools
 * 为空 / 未设置时作为默认值；配置显式给出的名单为加性覆盖。
 */
export function deriveDangerousTools(
  getAll?: () => Array<{ name: string; sideEffect?: SideEffect }>,
): string[] {
  const names = new Set<string>();
  for (const [name, effect] of Object.entries(LEGACY_SIDE_EFFECT)) {
    if (effect !== 'read') names.add(name);
  }
  if (getAll) {
    for (const t of getAll()) {
      if (sideEffectOf(t.name, t.sideEffect) !== 'read') names.add(t.name);
    }
  }
  return [...names];
}