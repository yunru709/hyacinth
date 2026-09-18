import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { resolveJavaLike } from './java-kotlin-shared.js';

export const kotlinSupport: LanguageSupport = {
  id: 'kotlin',
  extensions: ['.kt'],
  extMap: { '.kt': 'kotlin' },

  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    return [new GenericParser(['.kt'])];
  },

  isIntraProjectSpecifier: () => false,
  resolveSpecifier: (spec, _dir, ctx) => resolveJavaLike(spec, ctx.rootDir, 'kotlin'),
};
