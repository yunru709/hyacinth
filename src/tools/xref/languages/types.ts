/**
 * LanguageSupport —— 一门语言在交叉引用里的**声明式事实**。
 *
 * 为什么要有注册表（Phase 1 重构）：加一门语言原先要同时改 4 处 ——
 *   parser.ts 的工厂注册、manager.ts 的 guessLanguage / resolveSpecifier /
 *   isIntraProjectSpecifier。知识散落是漂移的温床，而且**已经付过代价**：
 *   resolveImportPath 只拼尾部扩展名那阵，本项目 2617 条 `from './x.js'` 全部解析不到，
 *   imports 表长期恒为 0 且无人察觉。
 *
 * 已迁入：后缀→语言表（半 1）、项目内说明符判定（半 2a）。
 * 待迁入：说明符解析实现（半 2b）、解析器工厂（半 3）。
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
  /**
   * 「本语言特有的、非相对路径的**项目内**说明符形态」。
   *
   * 相对路径（`spec.startsWith('.')`）对所有语言都成立，由调用方统一处理，
   * **不在这里重复**；本方法只声明额外形态。
   * true → 解析失败要计入 unresolved_imports（图缺边，必须可见）；
   * false → 视为外部依赖（npm 包 / 标准库 / 外部 crate），设计上不入图。
   */
  isIntraProjectSpecifier(spec: string): boolean;
}
