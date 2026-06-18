/**
 * 回合回滚 — 类型定义
 *
 * ## 术语
 * - **回合 (Turn)**: 用户一条消息 → 模型执行全部工具调用 → 模型回复。一个完整轮次。
 * - **回滚 (Rollback)**: 撤销指定回合中模型所做的所有文件变更。
 */

/** 单个文件变更记录 */
export interface ChangedFile {
  /** 文件路径（相对于项目根） */
  path: string;
  /** 变更类型 */
  action: 'modified' | 'created' | 'deleted';
  /** 修改前的完整内容（modified / deleted 时记录；created 时 undefined） */
  oldContent?: string;
}

/** 一个回合的完整记录 */
export interface TurnRecord {
  /** 回合编号（全局递增） */
  turnId: number;
  /** 回合开始时间 ISO 8601 */
  timestamp: string;
  /** 回合开始前的 git commit hash（非 git 仓库时为空字符串） */
  preCommit: string;
  /** 本回合变更的文件列表 */
  changedFiles: ChangedFile[];
  /** 本回合执行的 bash 命令列表 */
  commands: string[];
}

/** rollback_status 工具返回的摘要 */
export interface RollbackStatusResult {
  currentTurn: number;
  maxStored: number;
  available: RollbackStatusEntry[];
}

export interface RollbackStatusEntry {
  turnId: number;
  timestamp: string;
  fileCount: number;
  commandCount: number;
  /** 变更文件摘要，如 "src/a.ts, src/b.ts (+2 more)" */
  fileSummary: string;
}

/** 环状缓冲区索引文件结构 */
export interface RollbackIndex {
  /** 已存储的回合 ID 列表（按 turnId 升序） */
  turns: number[];
  /** 下次写入的回合 ID（用于判断连续性） */
  lastTurnId: number;
}
