import type { LanguageSupport } from './types.js';
import { resolveJavaLike } from './java-kotlin-shared.js';

export const kotlinSupport: LanguageSupport = {
  id: 'kotlin',
  extensions: ['.kt'],
  extMap: { '.kt': 'kotlin' },
  isIntraProjectSpecifier: () => false,
  resolveSpecifier: (spec, _dir, ctx) => resolveJavaLike(spec, ctx.rootDir, 'kotlin'),
};
