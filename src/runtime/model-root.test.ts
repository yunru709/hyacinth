// ============================================================
// 模型根目录解析测试（纯函数：env > config > 默认）
// ============================================================
// 这是 STT/TTS 模型位置的**唯一真源**，优先级错了会把模型下到错盘 ——
// 三条通道与边界（空白串视为未设置、相对路径 resolve）都要钉住。
// ============================================================

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveModelRoot } from './model-root.js';

describe('resolveModelRoot（纯解析）', () => {
  it('默认：~/.agent/models（无 env 无 config）', () => {
    expect(resolveModelRoot(undefined, undefined, 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u', '.agent', 'models'),
    );
  });

  it('config models.root 覆盖默认', () => {
    expect(resolveModelRoot(undefined, 'D:\\hyacinth-models', 'C:\\Users\\u')).toBe('D:\\hyacinth-models');
  });

  it('env HYACINTH_MODELS_DIR 优先于 config', () => {
    expect(resolveModelRoot('E:\\models', 'D:\\hyacinth-models', 'C:\\Users\\u')).toBe('E:\\models');
  });

  it('空白串视为未设置（回落到下一级）', () => {
    expect(resolveModelRoot('  ', 'D:\\m', 'C:\\Users\\u')).toBe('D:\\m');
    expect(resolveModelRoot(undefined, '', 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u', '.agent', 'models'),
    );
  });

  it('相对路径 resolve 到绝对（以进程 cwd 为基准）', () => {
    const r = resolveModelRoot(undefined, 'data/models', 'C:\\Users\\u');
    expect(path.isAbsolute(r)).toBe(true);
    expect(r.endsWith(path.join('data', 'models'))).toBe(true);
  });
});
