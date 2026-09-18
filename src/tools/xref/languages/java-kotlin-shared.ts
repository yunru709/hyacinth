import { firstExisting } from './resolve-helpers.js';

/**
 * Java/Kotlin 共用的解析实现（两者只差扩展名 —— 原 manager.ts 的 resolveJavaLike
 * 就是靠 lang 参数区分，故这里保留同一形状，而不是复制两份）。
 */
export async function resolveJavaLike(spec: string, root: string, lang: string): Promise<string | null> {
  const rel = spec.replace(/^static\s+/, '').split('.').filter(Boolean).join('/');
  const exts = lang === 'kotlin' ? ['.kt'] : ['.java', '.kt'];
  const roots = [root, `${root}/src`, `${root}/src/main/java`, `${root}/src/main/kotlin`];
  const candidates: string[] = [];
  for (const r of roots) {
    for (const e of exts) candidates.push(`${r}/${rel}${e}`);
  }
  return firstExisting(candidates);
}
