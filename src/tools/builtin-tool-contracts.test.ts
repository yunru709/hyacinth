/**
 * builtin-tool-contracts.test.ts —— 内置工具契约测试（补齐缺失覆盖）
 *
 * 背景：`tools.test.ts` 只覆盖 read/write/edit/glob/multi_edit/bash 六个工具，
 * 另有 generate-media.test.ts 单测 generate_media。以下 9 个内置工具此前**零测试**：
 *   grep / insert / diff_files / json_edit / db_query / archive / disk_usage / git / http_request
 * 本文件为其补齐契约测试，并把审查中发现的「描述宣称能力 ≠ 实际能力」缺口
 * 用 `it.fails` 固化 —— 缺口被修复后这些用例会转为失败，提示维护者删掉标记。
 *
 * 隔离约定（不污染真实环境）：
 *   - 所有文件操作都在 os.tmpdir() 下的一次性随机目录，afterEach 递归删除；
 *   - 一律传**绝对路径**，因此不依赖也不改变 process.cwd()；
 *   - 不写 ~/.agent、不写项目目录、不调 createDefaultRegistry()（GenerateMediaTool
 *     构造时会落 media.sqlite，故一律不实例化它）；
 *   - 网络仅打本机 127.0.0.1 的临时 HTTP 服务（用毕关闭）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import { GrepTool } from './grep.js';
import { InsertTool } from './insert.js';
import { DiffFilesTool } from './diff-files.js';
import { JsonEditTool } from './json-edit.js';
import { DbQueryTool } from './db-query.js';
import { Database } from './sqlite.js';
import { ArchiveTool } from './archive.js';
import { GitTool } from './git-tool.js';
import { HttpRequestTool } from './http-request.js';
import { DiskUsageTool } from './disk-usage.js';
import { WriteTool } from './write.js';
import { ToolRegistry } from './registry.js';
import { applyWorkspaceFence } from './path-sandbox.js';
import { sideEffectOf } from './side-effect.js';
import { GitManager } from '../evolution/git-manager.js';

// ─── 隔离夹具 ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `hyacinth-tool-test-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const write = (rel: string, content: string) => {
  const abs = path.join(tmpRoot, rel);
  return fs.mkdir(path.dirname(abs), { recursive: true })
    .then(() => fs.writeFile(abs, content, 'utf-8'))
    .then(() => abs);
};

// =====================================================================
// grep —— 无测试
// =====================================================================

describe('GrepTool', () => {
  let aTs: string;
  let bMd: string;

  beforeEach(async () => {
    aTs = await write('a.ts', 'foo\nfoo\nbar\n');
    bMd = await write('b.md', 'nothing here\n');
    await write('sub/c.ts', 'foo again\n');
    await write('.hidden/d.ts', 'foo hidden\n');
  });

  it('默认 files_with_matches 返回命中的文件绝对路径', async () => {
    const result = await new GrepTool().execute({ pattern: 'foo', path: tmpRoot });
    expect(result).toContain('a.ts');
    expect(result).toContain(path.join('sub', 'c.ts'));
  });

  it('count 模式返回「文件:出现次数」（注意统计的是出现次数而非行数）', async () => {
    const result = await new GrepTool().execute({ pattern: 'foo', path: tmpRoot, output_mode: 'count' });
    expect(result).toContain(`${aTs}:2`);
  });

  it('content 模式默认带行号', async () => {
    const result = await new GrepTool().execute({ pattern: 'bar', path: aTs, output_mode: 'content' });
    expect(result).toContain('3:bar');
  });

  it('-C 输出匹配行前后文（匹配行用 : 前缀，上下文用 - 前缀）', async () => {
    const result = await new GrepTool().execute({ pattern: 'bar', path: aTs, output_mode: 'content', '-C': 1 });
    expect(result).toContain('3:bar');
    expect(result).toContain('2-foo');
  });

  it('glob 过滤生效（**/*.ts 命中嵌套，*.md 只命中顶层）', async () => {
    const tsOnly = await new GrepTool().execute({ pattern: 'foo', path: tmpRoot, glob: '**/*.ts' });
    expect(tsOnly).toContain('a.ts');
    expect(tsOnly).not.toContain('b.md');

    const mdOnly = await new GrepTool().execute({ pattern: 'nothing', path: tmpRoot, glob: '*.md' });
    expect(mdOnly).toContain('b.md');
  });

  it('head_limit 截断并给出更多条数提示', async () => {
    const result = await new GrepTool().execute({ pattern: 'foo', path: tmpRoot, head_limit: 1 });
    expect(result).toContain('more files');
    expect(result.split('\n').length).toBe(2);
  });

  it('非法正则抛错', async () => {
    await expect(new GrepTool().execute({ pattern: '[', path: tmpRoot })).rejects.toThrow(/Invalid regex pattern/);
  });

  it('路径不存在抛错', async () => {
    await expect(
      new GrepTool().execute({ pattern: 'x', path: path.join(tmpRoot, 'nope') }),
    ).rejects.toThrow(/Path not found/);
  });

  it('已知行为：以 . 开头的目录/文件被跳过（隐藏文件搜不到）', async () => {
    const result = await new GrepTool().execute({ pattern: 'hidden', path: tmpRoot });
    expect(result).not.toContain('.hidden');
  });

  it.fails('【已知差距】描述宣称支持 multiline（. 匹配换行、模式可跨行），实际逐行匹配无法跨行', async () => {
    const f = await write('multi.txt', 'foo\nbar\n');
    const result = await new GrepTool().execute({
      pattern: 'foo\\nbar',
      path: f,
      output_mode: 'content',
      multiline: true,
    });
    expect(result).toContain('foo');
    expect(result).not.toContain('No matches');
  });
});

// =====================================================================
// insert —— 无测试
// =====================================================================

describe('InsertTool', () => {
  it('line_number=1 插入到文件开头', async () => {
    const f = await write('a.txt', 'l1\nl2\nl3\n');
    await new InsertTool().execute({ file_path: f, line_number: 1, content: 'HEAD' });
    expect(await fs.readFile(f, 'utf-8')).toBe('HEAD\nl1\nl2\nl3\n');
  });

  it('"end" 追加到文件末尾', async () => {
    const f = await write('a.txt', 'a\nb\n');
    const out = await new InsertTool().execute({ file_path: f, line_number: 'end', content: 'END' });
    expect(out).toContain('Appended');
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nb\nEND');
  });

  it('行号越界抛错', async () => {
    const f = await write('a.txt', 'l1\nl2\nl3\n');
    await expect(
      new InsertTool().execute({ file_path: f, line_number: 99, content: 'x' }),
    ).rejects.toThrow(/out of range/);
  });

  it('已知行为：末尾无换行的文件会被补一个换行', async () => {
    const f = await write('a.txt', 'a\nb');
    await new InsertTool().execute({ file_path: f, line_number: 2, content: 'X' });
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nX\nb\n');
  });

  it('已知行为：append 模式对不存在的文件静默创建（不报错）', async () => {
    const missing = path.join(tmpRoot, 'created-by-append.txt');
    const out = await new InsertTool().execute({ file_path: missing, line_number: 0, content: 'x' });
    expect(out).toContain('Appended');
    expect(fss.existsSync(missing)).toBe(true);
  });
});

// =====================================================================
// diff_files —— 无测试
// =====================================================================

describe('DiffFilesTool', () => {
  it('相同文件返回 Files are identical.', async () => {
    const f1 = await write('same1.txt', 'a\nb\n');
    const f2 = await write('same2.txt', 'a\nb\n');
    expect(await new DiffFilesTool().execute({ file1: f1, file2: f2 })).toBe('Files are identical.');
  });

  it('差异文件输出 +/- 行与行号', async () => {
    const f1 = await write('d1.txt', 'a\nb\n');
    const f2 = await write('d2.txt', 'a\nc\n');
    const result = await new DiffFilesTool().execute({ file1: f1, file2: f2 });
    expect(result).toMatch(/- +\d+ \| b/m);
    expect(result).toMatch(/\+ +\d+ \| c/m);
  });

  it('已知行为：错误以普通字符串返回（不抛错），调用方无法从 is_error 判失败', async () => {
    const f1 = await write('e1.txt', 'a\n');
    const result = await new DiffFilesTool().execute({ file1: f1, file2: path.join(tmpRoot, 'nope.txt') });
    expect(result).toContain('Error: Cannot read file2');
  });

  it.fails('【已知差距】描述宣称返回 unified diff，实际是自定义 "行号 | 内容" 格式（无 @@ hunk 头）', async () => {
    const f1 = await write('u1.txt', 'a\nb\n');
    const f2 = await write('u2.txt', 'a\nc\n');
    const result = await new DiffFilesTool().execute({ file1: f1, file2: f2 });
    expect(result).toMatch(/^@@/m);
  });
});

// =====================================================================
// json_edit —— 无测试
// =====================================================================

describe('JsonEditTool', () => {
  it('按点号路径读取值', async () => {
    const f = await write('cfg.json', '{"a":{"b":42}}');
    expect(await new JsonEditTool().execute({ file: f, path: 'a.b' })).toBe('42');
  });

  it('按点号路径写入值', async () => {
    const f = await write('cfg.json', '{"a":{"b":42}}');
    await new JsonEditTool().execute({ file: f, path: 'a.b', value: '7' });
    expect(JSON.parse(await fs.readFile(f, 'utf-8')).a.b).toBe(7);
  });

  it('读取不存在的键返回提示字符串（不抛错）', async () => {
    const f = await write('cfg.json', '{"a":1}');
    expect(await new JsonEditTool().execute({ file: f, path: 'zz' })).toContain('not found');
  });

  it.fails('【已知差距】描述宣称支持 YAML / TOML，实际两者都直接返回错误', async () => {
    const f = await write('cfg.yaml', 'a: 1\n');
    const result = await new JsonEditTool().execute({ file: f, path: 'a', value: '2' });
    expect(result).not.toContain('Error');
  });

  it.fails('【已知差距】描述/注释宣称「保持原格式」，实际整文件重新序列化（紧凑单行变多行）', async () => {
    const f = await write('compact.json', '{"a":1,"b":2}');
    await new JsonEditTool().execute({ file: f, path: 'a', value: '9' });
    expect(await fs.readFile(f, 'utf-8')).toBe('{"a":9,"b":2}');
  });

  it.fails('【安全】路径含 __proto__ 会污染 Object.prototype（工具输入来自 LLM）', async () => {
    const f = await write('empty.json', '{}');
    const key = `polluted_${crypto.randomUUID().slice(0, 8)}`;
    const tool = new JsonEditTool();

    await tool.execute({ file: f, path: `__proto__.${key}`, value: '"leak"' });

    // 先取样、再清理 —— 污染会跨用例存活，必须就地还原
    const leaked = ({} as Record<string, unknown>)[key];
    delete (Object.prototype as unknown as Record<string, unknown>)[key];

    expect(leaked).toBeUndefined();
  });
});

// =====================================================================
// db_query —— 无测试
// =====================================================================

describe('DbQueryTool', () => {
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(tmpRoot, 'test.sqlite');
    const db = Database(dbPath);
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, 'x');
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, 'y');
    db.close();
  });

  it('SELECT 返回 Markdown 表格与行数后缀', async () => {
    const result = await new DbQueryTool().execute({ database: dbPath, query: 'SELECT a, b FROM t ORDER BY a' });
    expect(result).toContain('| a | b |');
    expect(result).toContain('| 1 | x |');
    expect(result).toContain('2 row(s)');
  });

  it('参数化查询正常工作', async () => {
    const result = await new DbQueryTool().execute({
      database: dbPath,
      query: 'SELECT b FROM t WHERE a = ?',
      params: '[1]',
    });
    expect(result).toContain('| x |');
    expect(result).not.toContain('| y |');
  });

  it('写语句返回影响行数', async () => {
    const result = await new DbQueryTool().execute({
      database: dbPath,
      query: 'INSERT INTO t (a, b) VALUES (?, ?)',
      params: '[3, "z"]',
    });
    expect(result).toBe('Query OK. 1 row(s) affected.');
  });

  it('显式 readonly 时写语句被数据库拒绝（以错误字符串返回）', async () => {
    const result = await new DbQueryTool().execute({
      database: dbPath,
      query: 'INSERT INTO t (a, b) VALUES (9, "no")',
      readonly: true,
    });
    expect(result).toContain('Error');
  });

  it('库文件不存在返回错误字符串', async () => {
    const result = await new DbQueryTool().execute({ database: path.join(tmpRoot, 'nope.sqlite'), query: 'SELECT 1' });
    expect(result).toContain('Database file not found');
  });

  it('params 非数组返回错误字符串', async () => {
    const result = await new DbQueryTool().execute({ database: dbPath, query: 'SELECT 1', params: '{"a":1}' });
    expect(result).toContain('params must be a JSON array');
  });
});

// =====================================================================
// archive —— 无测试（只覆盖 tar.gz 路径：不依赖 PowerShell）
// =====================================================================

describe('ArchiveTool', () => {
  it('tar.gz 压缩后能原样解压', async () => {
    const srcDir = path.join(tmpRoot, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'file.txt'), 'hello', 'utf-8');

    const archive = path.join(tmpRoot, 'out.tar.gz');
    const compressed = await new ArchiveTool().execute({ action: 'compress', file: archive, target: srcDir });
    expect(compressed).toContain('Created');
    expect(fss.existsSync(archive)).toBe(true);

    const destDir = path.join(tmpRoot, 'dest');
    const extracted = await new ArchiveTool().execute({ action: 'extract', file: archive, target: destDir });
    expect(extracted).toContain('Extracted to');
    expect(await fs.readFile(path.join(destDir, 'src', 'file.txt'), 'utf-8')).toBe('hello');
  });

  it('归档不存在返回错误字符串', async () => {
    const result = await new ArchiveTool().execute({
      action: 'extract',
      file: path.join(tmpRoot, 'nope.tar.gz'),
    });
    expect(result).toContain('Archive file not found');
  });

  it('compress 缺 target 返回错误字符串', async () => {
    const result = await new ArchiveTool().execute({ action: 'compress', file: path.join(tmpRoot, 'o.tar.gz') });
    expect(result).toContain('target is required for compress action');
  });

  it('不支持的格式返回错误字符串', async () => {
    const f = await write('x.rar', 'not really a rar');
    const result = await new ArchiveTool().execute({ action: 'extract', file: f });
    expect(result).toContain('Unsupported archive format');
  });
});

// =====================================================================
// git —— 无测试
// =====================================================================

describe('GitTool', () => {
  let repo: string;
  let gm: GitManager;

  beforeEach(async () => {
    repo = path.join(tmpRoot, 'repo');
    await fs.mkdir(repo, { recursive: true });
    gm = new GitManager(repo);
    // 本地身份 + 关签名，全部写在临时仓库的 local config 里，不碰用户全局配置
    await gm.git(['init']);
    await gm.git(['config', 'user.email', 'tool-test@example.com']);
    await gm.git(['config', 'user.name', 'tool-test']);
    await gm.git(['config', 'commit.gpgsign', 'false']);
  });

  it('非 Git 仓库返回友好提示', async () => {
    const plain = path.join(tmpRoot, 'plain');
    await fs.mkdir(plain, { recursive: true });
    const result = await new GitTool(new GitManager(plain)).execute({ action: 'commit', message: 'x' });
    expect(result).toContain('不在 Git 仓库中');
  });

  it('commit 返回哈希，并把 session/turn 追加进提交信息', async () => {
    // 先落一次 root commit（其哈希提取有独立缺口，见下方 it.fails），再验证常规提交
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1', 'utf-8');
    await new GitTool(gm).execute({ action: 'commit', message: 'root' });

    await fs.writeFile(path.join(repo, 'a.txt'), 'v2', 'utf-8');
    const result = await new GitTool(gm, 'sess-1').execute({ action: 'commit', message: 'first', turn: 3 });
    expect(result).toMatch(/^Committed: [0-9a-f]{7,}/);

    const log = await gm.log(1);
    expect(log[0].message).toContain('first');
    expect(log[0].message).toContain('session:sess-1');
    expect(log[0].message).toContain('turn:3');
  });

  it.fails('【已知差距】仓库首次提交（root commit）拿不到哈希：git 输出含 "(root-commit)"，正则 [\\w-]+ 不匹配括号', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1', 'utf-8');
    const result = await new GitTool(gm).execute({ action: 'commit', message: 'first' });
    expect(result).toMatch(/^Committed: [0-9a-f]{7,}/);
  });

  it('commit 缺 message 返回错误字符串', async () => {
    expect(await new GitTool(gm).execute({ action: 'commit' })).toContain("'message' parameter is required");
  });

  it('branch 创建并切换分支', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1', 'utf-8');
    await new GitTool(gm).execute({ action: 'commit', message: 'base' });

    const result = await new GitTool(gm).execute({ action: 'branch', name: 'feature/x' });
    expect(result).toContain('feature/x');
    const { stdout } = await gm.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('feature/x');
  });

  it('diff 显示未暂存改动', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1', 'utf-8');
    await new GitTool(gm).execute({ action: 'commit', message: 'base' });
    await fs.writeFile(path.join(repo, 'a.txt'), 'v2', 'utf-8');

    expect(await new GitTool(gm).execute({ action: 'diff' })).toContain('v2');
  });

  it.fails('【已知差距】diff 与 diff stat=true 覆盖的变更集不同（前者只看未暂存，后者比较 HEAD~1）', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1', 'utf-8');
    await new GitTool(gm).execute({ action: 'commit', message: 'base' });

    // 改动并暂存：此时 `git diff`（未暂存）为空，而 `git diff HEAD~1` 能看到
    await fs.writeFile(path.join(repo, 'a.txt'), 'v2', 'utf-8');
    await gm.git(['add', '-A']);

    const plain = await new GitTool(gm).execute({ action: 'diff' });
    const stat = await new GitTool(gm).execute({ action: 'diff', stat: true });

    expect(plain).toContain('v2');
    expect(stat).toContain('a.txt');
  });
});

// =====================================================================
// http_request —— 无测试（打本机临时服务）
// =====================================================================

describe('HttpRequestTool', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastReq: { method?: string; body: string; contentType?: string };

  beforeEach(async () => {
    lastReq = { body: '' };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        lastReq = { method: req.method, body, contentType: req.headers['content-type'] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET 返回状态码与响应体', async () => {
    const result = await new HttpRequestTool().execute({ url: `${baseUrl}/x` });
    expect(result).toContain('HTTP 200');
    expect(result).toContain('"ok":true');
  });

  it('POST + json=true 设置 Content-Type 并发送 body', async () => {
    const result = await new HttpRequestTool().execute({
      url: `${baseUrl}/x`,
      method: 'POST',
      body: '{"a":1}',
      json: true,
    });
    expect(result).toContain('HTTP 200');
    expect(lastReq.method).toBe('POST');
    expect(lastReq.contentType).toContain('application/json');
    expect(lastReq.body).toBe('{"a":1}');
  });

  it('已知行为：GET 携带 body 被静默丢弃（不报错）', async () => {
    await new HttpRequestTool().execute({ url: `${baseUrl}/x`, method: 'GET', body: 'dropped' });
    expect(lastReq.body).toBe('');
  });

  it('缺 url 返回错误字符串', async () => {
    expect(await new HttpRequestTool().execute({})).toContain('url is required');
  });

  it('headers 非法 JSON 返回错误字符串', async () => {
    const result = await new HttpRequestTool().execute({ url: `${baseUrl}/x`, headers: '{not json' });
    expect(result).toContain('headers must be a valid JSON string');
  });

  it('连接失败返回错误字符串（不抛错）', async () => {
    const addr = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await new HttpRequestTool().execute({ url: `http://127.0.0.1:${addr.port}/x`, timeout: 3000 });
    expect(result).toContain('Error');
  });
});

// =====================================================================
// disk_usage —— 无测试
// =====================================================================

describe('DiskUsageTool', () => {
  it('mode=free 返回非空字符串（Windows 走 PowerShell / Unix 走 df）', async () => {
    const result = await new DiskUsageTool(tmpRoot).execute({ path: tmpRoot, mode: 'free' });
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  }, 120_000);
});

// =====================================================================
// 治理名单一致性（sideEffect 推导 / 工作区围栏）
// =====================================================================

describe('侧效应名单与实际工具名一致', () => {
  it('声明了 sideEffect 的写工具解析正确', () => {
    for (const name of ['write', 'edit', 'multi_edit', 'insert', 'json_edit']) {
      expect(sideEffectOf(name)).toBe('write');
    }
    // archive 在名单里被归为 write（它会落盘压缩产物）；restart 归为 exec
    for (const name of ['bash', 'db_query', 'http_request', 'restart']) {
      expect(sideEffectOf(name)).toBe('exec');
    }
    expect(sideEffectOf('archive')).toBe('write');
  });

  it.fails('【治理】git 工具名与 LEGACY_SIDE_EFFECT 的键不匹配（表里是 git_tool）→ 实际被判为 read', () => {
    expect(sideEffectOf('git')).toBe('exec');
  });

  it.fails('【治理】process_kill 未在名单中 → 实际被判为 read（杀进程不受审批/风暴检测约束）', () => {
    expect(sideEffectOf('process_kill')).toBe('exec');
  });

  it.fails('【治理】generate_media 落盘写文件，但既未声明也未在名单中 → 实际被判为 read', () => {
    expect(sideEffectOf('generate_media')).toBe('write');
  });
});

describe('工作区围栏（applyWorkspaceFence）', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = path.join(tmpRoot, 'workspace');
    outside = path.join(tmpRoot, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  it('write 工具写到工作区外被围栏拦下', async () => {
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    expect(applyWorkspaceFence(registry, root)).toBeGreaterThanOrEqual(1);

    const result = await registry.get('write')!.execute({
      file_path: path.join(outside, 'new.txt'),
      content: 'x',
    });
    expect(result).toMatch(/outside the workspace root/);
  });

  it('write 工具写 .git 被围栏拦下', async () => {
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    applyWorkspaceFence(registry, root);

    const result = await registry.get('write')!.execute({
      file_path: path.join(root, '.git', 'hooks', 'pre-commit'),
      content: 'x',
    });
    expect(result).toMatch(/\.git/);
  });

  it('工作区内的正常写入不被围栏误伤', async () => {
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    applyWorkspaceFence(registry, root);

    const result = await registry.get('write')!.execute({
      file_path: path.join(root, 'ok.txt'),
      content: 'fine',
    });
    expect(result).toContain('Successfully wrote');
  });

  it.fails('【安全】json_edit 的参数名是 file（围栏按 file_path 取参）→ 围栏静默失效，可写工作区外', async () => {
    const target = path.join(outside, 'cfg.json');
    await fs.writeFile(target, '{"a":1}', 'utf-8');

    const registry = new ToolRegistry();
    registry.register(new JsonEditTool());
    applyWorkspaceFence(registry, root);

    const result = await registry.get('json_edit')!.execute({ file: target, path: 'a', value: '2' });
    expect(result).toMatch(/outside the workspace root/);
  });
});
