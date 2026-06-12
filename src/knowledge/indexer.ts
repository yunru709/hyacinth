/**
 * 文件索引器 — 将文本文件导入知识库
 *
 * 支持单文件、递归目录导入。可选择性将文件复制到知识库 files/ 目录，
 * 实现"文件系统为主存储"的设计原则。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeBase } from './store.js';
import type { Retriever } from './retriever.js';

const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.html', '.htm', '.xml',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less',
  '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php',
  '.sh', '.bat', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.csv', '.log', '.sql', '.r', '.m', '.swift',
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext);
}

function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 将文件复制到知识库 files/ 目录，保持文件名唯一。
 * 如果同名文件已存在，追加 (N) 后缀。
 * 返回复制后的目标路径。
 */
function copyToKbDir(filePath: string, kbFilesDir: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);

  let dest = path.join(kbFilesDir, base);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(kbFilesDir, `${stem} (${n})${ext}`);
    n++;
  }
  fs.copyFileSync(filePath, dest);
  return dest;
}

// ── 索引入口 ────────────────────────────────────────────────────────

export interface IndexOptions {
  /** 知识库文件存储目录（文件复制目标）。不传则只索引不复制 */
  kbFilesDir?: string;
}

/**
 * 索引单个文件。如果是外部路径且指定了 kbFilesDir，会先复制到知识库目录。
 */
export async function indexFile(
  kb: KnowledgeBase,
  filePath: string,
  opts: IndexOptions = {},
): Promise<number> {
  if (!fs.statSync(filePath).isFile()) return 0;
  if (!isTextFile(filePath)) return 0;
  const content = readFileContent(filePath);
  if (!content.trim()) return 0;

  let sourcePath = filePath;
  // 如果文件不在 kbFilesDir 内，复制进去
  if (opts.kbFilesDir && !filePath.startsWith(opts.kbFilesDir)) {
    sourcePath = copyToKbDir(filePath, opts.kbFilesDir);
  }

  const title = path.basename(sourcePath);
  kb.add(title, content, sourcePath);
  return 1;
}

/**
 * 递归索引目录。跳过隐藏文件/目录。
 */
export async function indexDirectory(
  kb: KnowledgeBase,
  dirPath: string,
  opts: IndexOptions = {},
): Promise<number> {
  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      count += await indexFile(kb, fullPath, opts);
    } else if (entry.isDirectory()) {
      count += await indexDirectory(kb, fullPath, opts);
    }
  }
  return count;
}

// ── 文件变更操作（供 watcher 使用）─────────────────────────────────

/**
 * 删除与指定文件路径关联的知识库条目。
 * 传入 kbFilesDir 内的文件路径，Retriever 按 source 查找并删除。
 */
export function removeFile(retriever: Retriever, filePath: string): boolean {
  const doc = retriever.findBySource(filePath);
  if (!doc) return false;
  return retriever.remove(doc.id);
}

/**
 * 更新已索引的文件（文件内容变更时调用）。
 * 重新读取文件内容并更新知识库条目。
 */
export function updateFile(retriever: Retriever, filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    // 文件被删除 — 移除索引
    return removeFile(retriever, filePath);
  }
  if (!isTextFile(filePath)) return false;
  try {
    const content = readFileContent(filePath);
    if (!content.trim()) return false;
    const doc = retriever.findBySource(filePath);
    if (doc) {
      return retriever.update(doc.id, {
        title: path.basename(filePath),
        content,
      });
    }
    // 新文件 — 添加到索引
    retriever.add({
      id: '',
      title: path.basename(filePath),
      content,
      source: filePath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 全量扫描知识库文件目录，确保索引与文件系统一致。
 * - 新增文件 → 添加索引
 * - 已删除文件 → 移除索引
 * - 已有文件保持不变（不重复索引）
 */
export async function syncDirectory(
  retriever: Retriever,
  kbFilesDir: string,
): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;

  if (!fs.existsSync(kbFilesDir)) {
    fs.mkdirSync(kbFilesDir, { recursive: true });
    return { added, removed };
  }

  // 收集文件系统中的所有文本文件
  const diskFiles = new Set<string>();
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && isTextFile(p)) {
        diskFiles.add(p);
      }
    }
  }
  walk(kbFilesDir);

  // 收集已索引的文件
  const indexed = retriever.list();
  const indexedSources = new Map<string, string>(); // source → id
  for (const doc of indexed) {
    if (doc.source) indexedSources.set(doc.source, doc.id);
  }

  // 新增：磁盘有但索引没有
  for (const f of diskFiles) {
    if (!indexedSources.has(f)) {
      try {
        const content = readFileContent(f);
        if (content.trim()) {
          retriever.add({ id: '', title: path.basename(f), content, source: f });
          added++;
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  // 删除：索引有但磁盘没有
  for (const [source, id] of indexedSources) {
    if (source && !fs.existsSync(source)) {
      retriever.remove(id);
      removed++;
    }
  }

  return { added, removed };
}
