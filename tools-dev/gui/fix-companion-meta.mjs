#!/usr/bin/env node
/**
 * 一次性迁移 + 核验：校正陪伴角色目录 meta.json 的 type（2026-10-16）
 *
 * 事故：柔柔/meta.json = {"type":"normal"}（2026-09-17 那个批次写的），
 * 而 sessionModeOfDir 以 meta.type 为准 ⇒ 跨模式闸门拒绝把会话切进陪伴
 * ⇒ 陪伴模式进不去（报「该会话属于「normal」模式」）。
 *
 * ⚠️ 这里调的是**产品代码本身**（dist/memory/companion-session.js 的 getOrCreate），
 * 不是手写一遍逻辑 —— 既完成迁移，也顺带核验自愈真的在真实数据上生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionSessionManager } from '../../dist/memory/companion-session.js';

const base = path.join(os.homedir(), '.agent', 'companion');
const metaPath = (n) => path.join(base, n, 'meta.json');
const readType = (n) => {
  try { return JSON.parse(fs.readFileSync(metaPath(n), 'utf8')).type ?? '(no type)'; }
  catch { return '(no file)'; }
};

// 只处理真角色目录（有 persona.md），且**已存在**的目录
const chars = fs.readdirSync(base, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((n) => fs.existsSync(path.join(base, n, 'persona.md')));

console.log(`角色 ${chars.length} 个：${chars.join(', ')}`);
console.log('');

const rows = [];
for (const n of chars) {
  const before = readType(n);
  const convBefore = (() => {
    try { return fs.readFileSync(path.join(base, n, 'conversation.jsonl'), 'utf8').length; } catch { return -1; }
  })();

  const m = new CompanionSessionManager(); // 新实例：绕开单例，逐个处理
  m.setCharacter(n);
  m.getOrCreate();                          // ← 自愈点

  const after = readType(n);
  const convAfter = (() => {
    try { return fs.readFileSync(path.join(base, n, 'conversation.jsonl'), 'utf8').length; } catch { return -1; }
  })();
  rows.push({ n, before, after, convBefore, convAfter });
  console.log(`  ${n}:  meta ${before} → ${after}   ;  conversation.jsonl ${convBefore}B → ${convAfter}B`);
}

// 再用闸门真正读的判定函数复核一遍（不是复用上面的读法）
console.log('');
console.log('--- 用 sessionModeOfDir（闸门判据）复核 ---');
const { sessionModeOfDir } = await import('../../dist/memory/session.js');
for (const { n } of rows) {
  const mode = await sessionModeOfDir(path.join(base, n));
  console.log(`  ${n}: sessionModeOfDir = ${JSON.stringify(mode)}`);
}

const bad = rows.filter((r) => r.convBefore !== r.convAfter);
console.log('');
console.log(bad.length === 0
  ? '✅ 对话数据零改动（conversation.jsonl 字节数全部一致）'
  : '❌ 对话数据被改动：' + bad.map((b) => b.n).join(', '));
