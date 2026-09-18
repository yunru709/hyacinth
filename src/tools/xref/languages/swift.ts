import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { resolveTsLike } from './resolve-helpers.js';

export const swiftSupport: LanguageSupport = {
  id: 'swift',
  extensions: ['.swift'],
  extMap: { '.swift': 'swift' },

  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    return [new GenericParser(['.swift'])];
  },

  isIntraProjectSpecifier: () => false,

  // ⚠️ 现状如实保留：旧 resolveSpecifier 的 switch **没有 swift 分支**，
  // 于是 swift 落到 default = "相对路径按 ts-like 试，非相对视为外部"。
  // （SwiftPM 的模块路径并不符合这个模型，但本阶段是纯重构、行为不变优先；
  //   给它真解析器属 Phase 2。）
  async resolveSpecifier(spec, dir): Promise<string | null> {
    return spec.startsWith('.') ? resolveTsLike(spec, dir) : null;
  },
};
