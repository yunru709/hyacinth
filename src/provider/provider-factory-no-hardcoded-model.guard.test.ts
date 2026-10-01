/**
 * provider 工厂边界守卫：**不得硬编码具体模型名作兜底**。
 *
 * 判据见 docs/design/config-code-separation.md ——「模型名属配置，代码只能引用不能复制」。
 * 2026-10-02 之前，6 家工厂各自藏了一个模型名兜底（anthropic/openai/gemini/mimo/qwen/zhipu），
 * 于是"改一个模型名"要在多个源码文件之间来回找 —— 这正是"配置与代码没分离"的具体形态。
 *
 * 规则：凡是把值赋给 model 的位置（`this.model =` / `model:`），`??` 右侧的字符串字面量
 * 只允许是哨兵 `unknown`（缺值时显形，而不是静默换一个模型）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PROVIDER_DIR = path.join(process.cwd(), 'src', 'provider');

/** 匹配「给 model 赋值」那一行里的 ?? '字面量' */
const MODEL_FALLBACK_RE = /(?:this\.model\s*=|model:)[^\n;]*?\?\?\s*'([^']+)'/g;

const ALLOWED = new Set(['unknown']);

describe('providers 边界守卫', () => {
  it('provider 工厂不得把具体模型名写成兜底', () => {
    const offenders: string[] = [];
    const files = fs
      .readdirSync(PROVIDER_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    for (const file of files) {
      const src = fs.readFileSync(path.join(PROVIDER_DIR, file), 'utf-8');
      for (const m of src.matchAll(MODEL_FALLBACK_RE)) {
        const literal = m[1]!;
        if (ALLOWED.has(literal)) continue;
        offenders.push(`${file}: ?? '${literal}'`);
      }
    }

    expect(offenders, `模型名应只存在于配置与模型目录，不在工厂里兜底：\n${offenders.join('\n')}`).toEqual([]);
  });
});
