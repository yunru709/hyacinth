#!/usr/bin/env node
/**
 * 安全内核 spike v2 — 在 v1 基础上修复 CJS require 覆盖。
 * 策略：resolve 钩子按 context.parentFormat 分流 ESM shim(.mjs) / CJS shim(.cjs)。
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function report(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-spike2-'));
const write = (rel, content) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return pathToFileURL(p).href;
};

const esmShimURL = write('shims/child-process.mjs', `
import * as orig from 'node:child_process?__hyacinth';
const mark = (fn) => { Object.defineProperty(fn, '__hyacinthGuarded', { value: true, enumerable: false }); return fn; };
const spawn = mark(function (...args) { return orig.spawn(...args); });
const exec = mark(function (...args) { return orig.exec(...args); });
const execSync = mark(function (...args) { return orig.execSync(...args); });
const execFile = mark(function (...args) { return orig.execFile(...args); });
const execFileSync = mark(function (...args) { return orig.execFileSync(...args); });
const spawnSync = mark(function (...args) { return orig.spawnSync(...args); });
export { spawn, exec, execSync, execFile, execFileSync, spawnSync };
export default { ...orig, spawn, exec, execSync, execFile, execFileSync, spawnSync };
`);

const cjsShimPath = write('shims/child-process.cjs', `
const orig = require('node:child_process?__hyacinth');
const mark = (fn) => { try { Object.defineProperty(fn, '__hyacinthGuarded', { value: true, enumerable: false }); } catch {} return fn; };
const guarded = { ...orig };
for (const k of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync']) {
  if (typeof orig[k] === 'function') guarded[k] = mark(function (...args) { return orig[k](...args); });
}
module.exports = guarded;
`);

const staticImportURL = write('subjects/static.mjs', `
import { spawn } from 'node:child_process';
export const isGuarded = spawn.__hyacinthGuarded === true;
`);
const dynamicImportURL = write('subjects/dynamic.mjs', `
export async function probe() {
  const mod = await import('node:child_process');
  return mod.spawn.__hyacinthGuarded === true;
}
`);
const sdkURL = write('subjects/node_modules/fake-sdk/index.mjs', `
import { execSync } from 'node:child_process';
export const isGuarded = execSync.__hyacinthGuarded === true;
`);
const cjsSubjectURL = write('subjects/legacy.cjs', `
const cp = require('node:child_process');
module.exports.isGuarded = cp.spawn.__hyacinthGuarded === true;
`);
// CJS 内的间接 require（模拟 CJS 依赖链深处）
const cjsNestedURL = write('subjects/node_modules/fake-cjs-dep/index.cjs', `
const cp = require('child_process'); // 无 node: 前缀的旧式写法
module.exports.isGuarded = cp.spawn.__hyacinthGuarded === true;
`);

const REDIRECTS = new Map([
  ['node:child_process', { esm: esmShimURL, cjs: cjsShimPath }],
  ['child_process', { esm: esmShimURL, cjs: cjsShimPath }],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('?__hyacinth')) {
      const base = specifier.replace(/\?__hyacinth$/, '');
      return { url: base, format: 'builtin', shortCircuit: true };
    }
    const target = REDIRECTS.get(specifier) ?? REDIRECTS.get(specifier.replace(/^node:/, ''));
    if (target) {
      const isCjs = context.parentFormat === 'commonjs' ||
        (context.parentURL && context.parentURL.endsWith('.cjs'));
      const url = isCjs ? target.cjs : target.esm;
      return {
        url,
        format: isCjs ? 'commonjs' : 'module',
        shortCircuit: true,
        importAttributes: Object.keys(context.importAttributes ?? {}).length ? context.importAttributes : undefined,
      };
    }
    return nextResolve(specifier, context);
  },
});

try {
  const m = await import(staticImportURL);
  report('S3a 静态 import 被重定向', m.isGuarded === true, `isGuarded=${m.isGuarded}`);
} catch (e) { report('S3a 静态 import 被重定向', false, e.message); }

try {
  const m = await import(dynamicImportURL);
  const ok = await m.probe();
  report('S3b 动态 import 被重定向', ok === true, `probe=${ok}`);
} catch (e) { report('S3b 动态 import 被重定向', false, e.message); }

try {
  const m = await import(sdkURL);
  report('S3c node_modules 深处 import 被重定向', m.isGuarded === true, `isGuarded=${m.isGuarded}`);
} catch (e) { report('S3c node_modules 深处 import 被重定向', false, e.message); }

try {
  const m = await import(cjsSubjectURL);
  report('S3d CJS require 被重定向', m.isGuarded === true, `isGuarded=${m.isGuarded}`);
} catch (e) { report('S3d CJS require 被重定向', false, e.message); }

try {
  const m = await import(cjsNestedURL);
  report('S3f CJS 深处裸 require(child_process) 被重定向', m.isGuarded === true, `isGuarded=${m.isGuarded}`);
} catch (e) { report('S3f CJS 深处裸 require(child_process) 被重定向', false, e.message); }

try {
  const m = await import(`${staticImportURL}?t=${Date.now()}`);
  report('S3e ?t= 破缓存后仍被重定向', m.isGuarded === true, `isGuarded=${m.isGuarded}`);
} catch (e) { report('S3e ?t= 破缓存后仍被重定向', false, e.message); }

// 功能性验证：守卫版 spawn 真的能跑（透传语义）
try {
  const cp = await import('node:child_process');
  const r = cp.spawnSync(process.execPath, ['-e', 'console.log("ok")'], { encoding: 'utf-8' });
  report('S5 守卫版 spawnSync 透传语义', r.status === 0 && r.stdout.includes('ok'), `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
} catch (e) { report('S5 守卫版 spawnSync 透传语义', false, e.message); }

// 守卫版是否可被二次覆写剥离（expect: 属性无 setter/writable —— 我们用冻结副本）
try {
  const cp = await import('node:child_process');
  let stripped = false;
  try { cp.spawn = () => null; stripped = true; } catch { /* ESM namespace 本就不可写 */ }
  report('S6 守卫命名空间不可被覆写', !stripped && cp.spawn.__hyacinthGuarded === true, `stripped=${stripped}`);
} catch (e) { report('S6 守卫命名空间不可被覆写', false, e.message); }

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n=== spike v2 结果：${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length > 0 ? 1 : 0);
