/**
 * LanguageSupport —— 一门语言在交叉引用里的**声明式事实**。
 *
 * 为什么要有注册表（Phase 1 重构）：加一门语言原先要同时改 4 处 ——
 *   parser.ts 的工厂注册、manager.ts 的 guessLanguage / resolveSpecifier /
 *   isIntraProjectSpecifier。知识散落是漂移的温床，而且**已经付过代价**：
 *   resolveImportPath 只拼尾部扩展名那阵，本项目 2617 条 `from './x.js'` 全部解析不到，
 *   imports 表长期恒为 0 且无人察觉。
 *
 * 本阶段（半 1）只收敛「哪个后缀属于哪门语言」这一张表 —— 它是漂移前科所在，
 * 且可以**逐条对照**证明行为不变。解析器链与说明符解析在后续增量里迁入。
 */
export interface LanguageSupport {
  /** 描述符 id（'typescript' / 'python' / 'ccpp' …） */
  id: string;
  /** 该语言**可被扫描与解析**的后缀（= 对应解析器认的后缀） */
  extensions: string[];
  /**
   * 后缀 → 写入 files.language 的取值。
   *
   * 注意：这里的键是 extensions 的**子集** —— 现状确实如此：.mjs/.cjs/.mts/.cts
   * （TS 解析器认）与 .pyi/.pyx（Python 解析器认）都能被解析入库，但**没有** language 映射，
   * 于是 guessLanguage 对它们返回 'unknown'。这是**既有**的不一致（潜在 bug），
   * 纯重构阶段如实保留、不做行为变更；要不要修是单独的决定。
   */
  extMap: Record<string, string>;
}
