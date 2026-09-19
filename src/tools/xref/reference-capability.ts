/**
 * reference-capability.ts — xref 侧的「引用分析能力」实现（Phase 6 第 2 步）
 *
 * 它把消费侧（loop-tools 的后置序列）归一化好的输入，翻译成**索引查询**：
 *   变更文件 → 提取变更符号（复用核心同一套 extractSymbols，保证"改了哪些符号"判定一致）
 *     ├─ 索引新鲜 → 返回精确调用方清单（file:line + caller_name + [precise]/[heuristic] 标注）
 *     └─ 陈旧 / 查不到 / 任何异常 → 返回**空串**
 *
 * **返回空串是契约、不是失败**：消费侧明确"空 → 走核心兜底"，故能力侧永远不给出可能不全的
 * 精确清单（那会让模型拿到**假阴性**）。同理，本模块不抛错 —— 抛了也只会被消费侧吞掉退兜底，
 * 不如自己如实返回空并把原因记进运行态（供 arch list 展示）。
 *
 * 新鲜度消费**现有 Phase 4 机制**（ensureFresh）：≤20 个变更内联同步；超阈值只提示、不重建。
 */
import type { ReferenceAnalysisCapability, ReferenceAnalysisInput } from '../reference-analysis.js';
import { resolveChangedSymbols } from '../reference-analysis.js';
import type { XrefManager } from './manager.js';

/** 运行态（arch list 的 links 段展示用） */
export interface ReferenceAnalysisRuntime {
  /** 最近一次调用时间（ISO；空 = 从未触发） */
  lastAt: string;
  /** 最近一次涉及的符号 */
  lastSymbols: string[];
  /** 最近一次产出（截断留档） */
  lastOutput: string;
  /** 最近一次"给不出结论"的原因（空 = 上次正常给出；arch links 展示用） */
  lastReason: string;
  /** 累计调用 / 累计退兜底（能力给不出结论的次数） */
  calls: number;
  fallbacks: number;
}

export interface ReferenceAnalysisCapabilityImpl extends ReferenceAnalysisCapability {
  /** 运行态快照（arch list 用） */
  getRuntime(): ReferenceAnalysisRuntime;
}

/** 与核心兜底同口径：最多 3 个符号（避免注记失控） */
const MAX_SYMBOLS = 3;
/** 注记行数上限（有界：不撑爆工具结果） */
const MAX_LINES = 12;

export function createReferenceAnalysisCapability(manager: XrefManager): ReferenceAnalysisCapabilityImpl {
  const runtime: ReferenceAnalysisRuntime = {
    lastAt: '',
    lastSymbols: [],
    lastOutput: '',
    lastReason: '',
    calls: 0,
    fallbacks: 0,
  };

  const giveUp = (reason: string): string => {
    runtime.fallbacks += 1;
    runtime.lastReason = reason;
    return '';
  };

  return {
    getRuntime: () => ({ ...runtime, lastSymbols: [...runtime.lastSymbols] }),

    async analyze(input: ReferenceAnalysisInput): Promise<string> {
      runtime.calls += 1;
      try {
        if (!manager.isReady()) return giveUp('索引未就绪');

        // 与兜底**同一个函数**判定变更符号（不是"各自调用同样的工具" —— 那种写法已经分叉过一次）
        const symbols = resolveChangedSymbols(input.filePath, input.before, input.oldText, input.newText, MAX_SYMBOLS);
        if (symbols.length === 0) return giveUp('未能判定变更符号');

        // 新鲜度：先按现有机制做有界同步（≤20 变更），再只读判定
        await manager.ensureFresh();
        if (!manager.isIndexFresh()) return giveUp('索引陈旧'); // 仍陈旧 → 交由消费侧走兜底

        const lines: string[] = ['[References]'];
        for (const sym of symbols) {
          const out = manager.query({ action: 'callers', symbol: sym });
          // 数据行的**确切形状**取自源码（manager.ts 的 render）：
          //   `  <相对路径>:<行号> (in <caller>)?[precise]`  —— **两个空格**开头，第三个字符非空格
          //   （context 行是四个空格开头，故被下面这条排除）
          // ⚠️ 教训：不要从工具/脚本的**格式化输出**里读形状 —— 冒烟脚本会再加一层缩进，
          //    照抄就写成 `\s{4,}`，于是永远匹配不到（本模块首版即错在此，靠运行态原因定位）。
          const rows = out
            .split('\n')
            .filter((l) => /^ {2}\S.*:\d+/.test(l))
            .slice(0, Math.max(0, MAX_LINES - lines.length));
          if (rows.length === 0) continue;
          lines.push(`  ${sym}:`);
          for (const r of rows) lines.push(r);
          if (lines.length >= MAX_LINES) break;
        }

        const text = lines.length > 1 ? lines.join('\n') : '';
        runtime.lastAt = new Date().toISOString();
        runtime.lastSymbols = symbols;
        runtime.lastOutput = text.slice(0, 400);
        if (!text) return giveUp('索引里没有这些符号的调用方');
        runtime.lastReason = '';
        return text;
      } catch (err) {
        // 能力失败一律退兜底（消费侧还有一层 try/catch，双保险）
        return giveUp(`能力异常：${(err as Error).message}`);
      }
    },
  };
}
