/**
 * 查询预处理器 — 中文查询优化
 *
 * 将原始用户输入转为多级查询变体（从精确到宽泛），
 * 解决"我的同桌是谁"被停用词淹没、FTS5 无法匹配的问题。
 */

// ── 中文停用词 ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没有', '看', '好', '自己', '这', '他', '她', '它',
  '们', '那', '些', '所', '为', '所以', '因为', '但是', '然而',
  '可以', '这个', '那个', '什么', '怎么', '哪', '哪里', '谁',
  '吗', '呢', '吧', '啊', '嘛', '哦', '嗯', '哈', '呀', '哇',
  '还', '被', '把', '让', '给', '向', '从', '对', '跟', '与',
  '或', '且', '而', '但', '虽', '虽然', '如果', '即使', '无论',
  '能', '能够', '可能', '应该', '可以', '需要', '必须', '要',
  '已', '已经', '将', '正在', '一直', '还是', '只是', '就是',
  '来', '去', '做', '搞', '弄', '干', '进行', '使用', '通过',
]);

// ── 预处理 ──────────────────────────────────────────────────────────

export interface QueryVariants {
  raw: string;
  keywords: string[];
  variants: string[];
}

export function preprocessQuery(rawInput: string): QueryVariants {
  let clean = rawInput.replace(/["*()^~@:]/g, ' ').trim();
  if (!clean) return { raw: rawInput, keywords: [], variants: [] };

  const cjkSeq = clean.match(/[一-鿿㐀-䶿]+/g) ?? [];
  const allCjkWords = cjkSeq.flatMap(seq => segmentCjk(seq));

  const keywords = allCjkWords.filter(w => !STOP_WORDS.has(w) && w.length >= 1);

  const variants: string[] = [];
  const seen = new Set<string>();
  for (const kw of keywords) { if (!seen.has(kw)) { variants.push(kw); seen.add(kw); } }
  for (let i = 0; i < keywords.length - 1; i++) {
    const phrase = keywords.slice(i, i + 2).join('');
    if (!seen.has(phrase) && phrase.length >= 2) { variants.push(phrase); seen.add(phrase); }
  }
  if (!seen.has(clean) && clean.length >= 1) { variants.push(clean); seen.add(clean); }
  if (rawInput !== clean && !seen.has(rawInput)) { variants.push(rawInput); }

  return { raw: rawInput, keywords, variants };
}

function segmentCjk(text: string): string[] {
  const words: string[] = [];
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i <= text.length - n; i++) {
      words.push(text.slice(i, i + n));
    }
  }
  for (const ch of text) words.push(ch);
  return words;
}
