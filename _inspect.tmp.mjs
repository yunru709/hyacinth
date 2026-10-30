// 提取 README 更新所需事实（用完删）
import fs from 'node:fs';
import path from 'node:path';

// 1. CLI 命令
const cli = fs.readFileSync('src/gateway/cli.ts', 'utf8');
const cmds = [...cli.matchAll(/\.command\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
console.log('CLI 命令:', [...new Set(cmds)].join(', '));

// 2. provider：目录 + ProviderType 定义
const provDirs = fs.readdirSync('src/provider', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
console.log('provider 子目录:', provDirs.join(', ') || '(无子目录，按文件)');
let provTypeLine = '';
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.ts')&&!p.includes('.test.')){const t=fs.readFileSync(p,'utf8');const m=t.match(/type\s+ProviderType\s*=([^;]+);/s);if(m){provTypeLine=p+': '+m[1].replace(/\s+/g,' ').slice(0,300);}}}})('src/provider');
console.log('ProviderType:', provTypeLine);

// 3. 工具粗数
const toolNames = new Set();
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.ts')&&!p.includes('.test.')){const t=fs.readFileSync(p,'utf8');for(const m of t.matchAll(/^\s+name:\s*'([a-z][a-z0-9_]*)'/gm))toolNames.add(m[1]);}}})('src/tools');
console.log('工具 name(粗):', toolNames.size);

// 4. 顶层模块
const mods = fs.readdirSync('src', { withFileTypes: true }).filter(f => f.isDirectory()).map(f => f.name);
console.log('顶层模块数:', mods.length);
