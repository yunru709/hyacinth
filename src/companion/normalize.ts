/**
 * 台词 → TTS 输入的规范化（纯函数，确定性变换）。
 *
 * LLM 的输出面向阅读（markdown / 链接 / 括号动作 / emoji），
 * TTS 的输入面向朗读——这里做确定性的剥离与清洗，不走 LLM：
 * 快、稳定、零成本。语义级改写（书面语→口语）不在这里做，
 * 由 companion_say 的工具描述引导主 agent 直接用口语写台词。
 */

/** 单条台词最大长度（超出截断；语音过长失去对话感） */
export const MAX_TTS_TEXT_LEN = 500;

export function normalizeForTts(input: string, maxLen = MAX_TTS_TEXT_LEN): string {
  let s = input || '';

  // 代码块 / 行内代码：代码不适合朗读，整段剥离
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`]*`/g, ' ');

  // URL / 链接：[文本](url) 保留文本；裸 URL 剥离
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');

  // markdown 结构符号：标题/列表/引用/强调
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/(\*\*\*|\*\*|\*|__|_|~~)/g, '');

  // 括号内动作/舞台指示：（微笑）、(停顿) —— 不朗读
  s = s.replace(/[（(][^（）()]*[）)]/g, '');

  // emoji 与符号装饰（U+1F000–U+1FAFF、U+2600–U+27BF、变体选择符、ZWJ）
  s = s.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    '',
  );

  // 表格分隔线与多余空白
  s = s.replace(/\|/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');

  s = s.trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '……' : s;
}
