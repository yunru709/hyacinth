import type { LanguageSupport } from './types.js';
import { resolveJavaLike } from './java-kotlin-shared.js';

export const javaSupport: LanguageSupport = {
  id: 'java',
  extensions: ['.java'],
  extMap: { '.java': 'java' },
  isIntraProjectSpecifier: () => false, // com.foo.Bar 这类包名不映射到文件，按外部处理
  resolveSpecifier: (spec, _dir, ctx) => resolveJavaLike(spec, ctx.rootDir, 'java'),
};
