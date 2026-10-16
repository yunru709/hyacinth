#!/usr/bin/env node
/**
 * 只改 `startup.defaultMode` 的值（2026-10-16）
 *
 * ⚠️ 为什么不用 `JSON.parse`+`JSON.stringify`：那会把整份 config.json 重排版
 *   （丢格式/丢注释/丢字段顺序），而这里只需要替换**那一个字符串值**。
 * ⚠️ 为什么不能对全文做正则：**config.json 里不止一个 `defaultMode`**
 *   （实测还有 `provider.defaultMode` = "balanced"）⇒ 全文替换会**改错字段**。
 *   ⇒ 先按括号配对定位 `"startup"` 块，**只在该块内**替换。
 * 局限：括号配对不认字符串里的花括号（config 值里出现 `{` 的概率极低）。
 *
 * 用法: node tools-dev/gui/set-default-mode.mjs companion|normal|--show-only
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const p = path.join(os.homedir(), '.agent', 'config.json');

/** 定位 `"startup": { ... }` 的字节区间（含花括号） */
function findBlock(raw, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*\\{`);
  const m = re.exec(raw);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // 指向 '{'
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

const raw = fs.readFileSync(p, 'utf8');
const blk = findBlock(raw, 'startup');
if (!blk) {
  console.error('  ❌ config.json 里找不到 "startup" 块');
  process.exit(1);
}
const inner = raw.slice(blk.start, blk.end);
const readMode = () => {
  const m = /"defaultMode"\s*:\s*"([^"]*)"/.exec(inner);
  return m ? m[1] : '(not found)';
};

if (process.argv.includes('--show-only')) {
  console.log(`  startup.defaultMode = ${readMode()}   （仅供核对：全文里另有 provider.defaultMode，别混）`);
  process.exit(0);
}

const mode = process.argv[2];
if (!mode || !/^[a-z][a-z0-9-]*$/.test(mode)) {
  console.error('用法: node tools-dev/gui/set-default-mode.mjs <mode>|--show-only');
  process.exit(2);
}

const before = readMode();
const inner2 = inner.replace(/("defaultMode"\s*:\s*)"[^"]*"/, `$1"${mode}"`);
if (inner2 === inner) {
  console.error(`  ❌ startup 块里找不到 defaultMode（当前 ${before}），未改动`);
  process.exit(1);
}
fs.writeFileSync(p, raw.slice(0, blk.start) + inner2 + raw.slice(blk.end), 'utf8');

const verify = fs.readFileSync(p, 'utf8');
const after = /"defaultMode"\s*:\s*"([^"]*)"/.exec(verify.slice(blk.start, blk.end));
console.log(`  startup.defaultMode: ${before} -> ${after ? after[1] : '(?)'}`);
