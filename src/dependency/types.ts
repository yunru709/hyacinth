/** 文件级依赖边 */
export interface FileDependency {
  /** 源文件（绝对路径） */
  from: string;
  /** 目标文件（绝对路径） */
  to: string;
  /** 导入类型 */
  importType: 'static' | 'dynamic' | 'require';
  /** 导入的符号列表（如果可解析） */
  symbols: string[];
}

/** 依赖图（内存结构，含 Map/Set） */
export interface DependencyGraph {
  /** 项目根目录 */
  rootDir: string;
  /** 所有已解析的文件（绝对路径集合） */
  files: Set<string>;
  /** 文件级依赖边列表 */
  dependencies: FileDependency[];
  /** 正向索引：文件 → 它依赖的文件列表 */
  dependents: Map<string, string[]>;
  /** 反向索引：文件 → 依赖它的文件列表 */
  dependees: Map<string, string[]>;
}

/** 依赖图的可序列化形式（用于持久化） */
export interface SerializedDependencyGraph {
  /** 缓存格式版本 */
  version: number;
  /** 项目根目录 */
  rootDir: string;
  /** 构建时间戳（ISO 8601） */
  builtAt: string;
  /** 所有已解析的文件 */
  files: string[];
  /** 文件级依赖边列表 */
  dependencies: FileDependency[];
  /** 正向索引 */
  dependents: Record<string, string[]>;
  /** 反向索引 */
  dependees: Record<string, string[]>;
  /** 文件哈希映射（相对路径 → content hash，用于增量更新检测） */
  fileHashes: Record<string, string>;
}

/** 影响面分析结果 */
export interface ImpactResult {
  /** 被修改的文件 */
  sourceFile: string;
  /** 可选：被修改的符号 */
  symbol?: string;
  /** 直接依赖（深度 1） */
  directImpacts: string[];
  /** 间接依赖（深度 2+） */
  indirectImpacts: string[];
  /** 所有受影响文件（直接+间接，按深度排序） */
  allImpacts: string[];
}
