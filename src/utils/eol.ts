/**
 * eol.ts — 行尾（换行符）适配（纯函数）
 *
 * 背景（2026-09-18 字节级实测到的缺陷）：
 *   仓库里的既有文件是 CRLF（`core.autocrlf=true` + `* text=auto`），而模型通过工具
 *   写入的文本通常是 LF。此前四个写文件工具都**原样落盘**，于是：
 *     1. `edit` 字符串模式把 LF 的 new_string 直接插入 CRLF 文件 → 混合行尾。
 *        实测 `src/tools/grep.ts` 变成 CRLF=379 / 裸LF=22。
 *     2. `write` 覆盖既有 CRLF 文件时整份转成 LF（`background-registry.ts` 就这样
 *        从 CRLF 变成纯 LF）。
 *     3. 跨行 old_string 用 LF 去匹配 CRLF 文件**必然失败** —— 报"未找到"，而这
 *        本应是最自然的用法。
 *
 * 因此：**写既有文件前，把要写入文本的换行统一成该文件原有的风格**；
 * 匹配前同理，让调用方不必关心文件是哪种行尾。
 *
 * 判据用"CRLF 与裸 LF 谁多"，而不是"是否含 CRLF" —— 避免一个 CRLF 文件里
 * 恰好混进一处裸 LF 就被整份翻成 LF。
 */

export type Eol = '\r\n' | '\n';

/** 按多数派判定行尾；无换行时按 LF（新建文件的默认） */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** 统一成 LF（先把 CRLF 折平，避免把 \r 留在行尾参与比较/拼接） */
export function toLf(text: string): string {
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
}

/** 把 LF 文本转成指定行尾 */
export function applyEol(text: string, eol: Eol): string {
  const lf = toLf(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/**
 * 把 `text` 的换行适配成 `fileContent` 的风格。
 * fileContent 为空（新建文件）时返回 LF —— 与 write 的既有行为一致。
 */
export function adaptEolTo(text: string, fileContent: string): string {
  if (!fileContent) return toLf(text);
  return applyEol(text, detectEol(fileContent));
}
