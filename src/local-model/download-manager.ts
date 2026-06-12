import https from 'node:https';
import { inflateRawSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  createWriteStream,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** GitHub API: 获取 llama.cpp 最新 release 信息 */
const GITHUB_API_LATEST =
  'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest';

/** Asset 文件名筛选关键词 */
const ASSET_FILTER = 'win-x64-cuda';

/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

/** GitHub API 超时 */
const API_TIMEOUT_MS = 15_000;

/** llama-server 在解压后的相对文件名 */
const LLAMA_SERVER_EXE = 'llama-server.exe';

/** 版本记录文件名 */
const VERSION_FILE = '.version';

/** 解压目标目录相对于 projectRoot */
const LIBS_LLAMACPP = 'libs/llama.cpp';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** check() 返回值 */
export interface CheckResult {
  installed: boolean;
  path?: string;
  version?: string;
}

/** GitHub Release API 返回的 asset 结构（仅需字段） */
interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

// ---------------------------------------------------------------------------
// ZIP 解析工具（纯 Node.js 内置实现，零依赖）
// ---------------------------------------------------------------------------

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

/**
 * 从 Buffer 末尾反向搜索 End of Central Directory Record 签名。
 * 返回 EOCD 相对于 buffer 起始的偏移量，找不到则返回 -1。
 */
function findEocdOffset(buf: Buffer): number {
  // 从末尾开始搜索，EOCD 最大有 64KB 的 comment
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return i;
    }
  }
  return -1;
}

/**
 * 解析中央目录条目，返回 ZipEntry 列表。
 */
function parseCentralDirectory(buf: Buffer, eocdOffset: number): ZipEntry[] {
  // EOCD 结构:
  // [sig:4][disk:2][diskStart:2][entriesOnDisk:2][totalEntries:2][cdSize:4][cdOffset:4][commentLen:2]
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL_DIR) {
      break; // 格式异常，终止
    }

    // 中央目录文件头固定部分 46 字节:
    // [sig:4][versionMade:2][versionNeeded:2][flags:2][method:2]
    // [modTime:2][modDate:2][crc32:4][compSize:4][uncompSize:4]
    // [nameLen:2][extraLen:2][commentLen:2][diskStart:2][internalAttr:2]
    // [externalAttr:4][localHeaderOffset:4]
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * 从 Buffer 中提取并解压单个 ZIP 条目。
 *
 * @returns 解压后的 Buffer，目录条目返回 null
 */
function extractEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  let pos = entry.localHeaderOffset;

  // 跳过签名检查（有的变体签名位可能异常，直接跳过 4 字节再验证）
  if (buf.readUInt32LE(pos) !== SIG_LOCAL_FILE) {
    throw new Error(`ZIP local file header signature mismatch for "${entry.name}"`);
  }

  // 本地文件头:
  // [sig:4][version:2][flags:2][method:2][modTime:2][modDate:2]
  // [crc32:4][compSize:4][uncompSize:4][nameLen:2][extraLen:2]
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const dataStart = pos + 30 + nameLen + extraLen;

  // 目录条目（名称以 / 结尾）不返回数据
  if (entry.name.endsWith('/') || entry.name.endsWith('\\')) {
    return null;
  }

  const compressedData = buf.subarray(dataStart, dataStart + entry.compressedSize);

  // 压缩方法: 0 = stored (无压缩), 8 = deflated
  if (entry.compressionMethod === 0) {
    return Buffer.from(compressedData);
  }

  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData);
  }

  throw new Error(
    `不支持的压缩方法: ${entry.compressionMethod}，文件 "${entry.name}"`,
  );
}

/**
 * 从 Buffer 中解压 ZIP 到目标目录。
 */
function extractZipToDir(zipBuf: Buffer, destDir: string): void {
  // 确保目标目录存在
  mkdirSync(destDir, { recursive: true });

  // 定位 EOCD
  const eocdOffset = findEocdOffset(zipBuf);
  if (eocdOffset === -1) {
    throw new Error('无效的 ZIP 文件：未找到 End of Central Directory Record');
  }

  // 解析中央目录
  const entries = parseCentralDirectory(zipBuf, eocdOffset);
  if (entries.length === 0) {
    throw new Error('ZIP 文件中未找到任何条目');
  }

  // 逐条解压
  for (const entry of entries) {
    const data = extractEntry(zipBuf, entry);
    if (data === null) continue; // 跳过目录

    const outPath = join(destDir, entry.name);
    const outDir = dirname(outPath);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, data);
  }
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

/**
 * 发起 HTTPS GET 请求并收集完整响应体。
 *
 * 自动跟随重定向（最多 5 次）。
 */
function httpsGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    _get(url, timeoutMs, (body) => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error(`GitHub API 响应解析失败: ${(err as Error).message}`));
      }
    });
  });
}

function _get(
  url: string,
  timeoutMs: number,
  onSuccess: (body: string) => void,
  redirectCount = 0,
): void {
  const MAX_REDIRECTS = 5;

  const req = https.get(
    url,
    {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'agent-local-model-downloader/1.0',
        Accept: 'application/json',
      },
    },
    (res) => {
      // 处理重定向
      if (
        (res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308) &&
        res.headers.location
      ) {
        if (redirectCount >= MAX_REDIRECTS) {
          req.destroy();
          throw new Error('重定向次数过多');
        }
        res.resume(); // 耗尽当前响应体
        _get(res.headers.location, timeoutMs, onSuccess, redirectCount + 1);
        return;
      }

      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode === 403 && body.includes('rate limit')) {
            rejectWithManualGuide(req);
          } else {
            req.destroy(
              new Error(
                `HTTP ${res.statusCode}: ${body.slice(0, 500) || res.statusMessage}`,
              ),
            );
          }
        });
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        onSuccess(Buffer.concat(chunks).toString('utf-8'));
      });
    },
  );

  req.on('timeout', () => {
    req.destroy(new Error(`请求超时 (${timeoutMs / 1000}s)`));
  });

  req.on('error', (err: NodeJS.ErrnoException) => {
    // 连接被拒绝或 DNS 解析失败
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      rejectWithNetworkError(req, err);
    }
    // 其他错误已通过 req.destroy 处理
  });

  function rejectWithManualGuide(r: ReturnType<typeof https.get>) {
    r.destroy(
      new Error(
        'GitHub API 访问受限（可能触发频率限制）。\n\n' +
          '手动安装指引:\n' +
          '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
          '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
          '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
          '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
      ),
    );
  }

  function rejectWithNetworkError(
    r: ReturnType<typeof https.get>,
    err: NodeJS.ErrnoException,
  ) {
    r.destroy(
      new Error(
        `网络连接失败: ${err.message}\n\n` +
          '可能的原因:\n' +
          '  1. 无网络连接或代理未配置\n' +
          '  2. GitHub 暂时不可达\n\n' +
          '手动安装指引:\n' +
          '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
          '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
          '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
          '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 文件下载（带进度）
// ---------------------------------------------------------------------------

/**
 * 下载文件到临时路径，支持进度回调。
 *
 * @param url - 下载地址
 * @param totalSize - 已知总大小（来自 GitHub API asset.size），用于计算百分比
 * @param onProgress - 进度回调 (百分比, 速度字符串)
 * @returns 临时文件路径
 */
function downloadFile(
  url: string,
  totalSize: number,
  onProgress?: (percent: number, speed: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpPath = join(tmpdir(), `llamacpp-${Date.now()}.zip`);
    const fileStream = createWriteStream(tmpPath);
    let downloaded = 0;
    const startTime = Date.now();
    let lastReportTime = startTime;
    let lastReportBytes = 0;

    const req = https.get(
      url,
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: {
          'User-Agent': 'agent-local-model-downloader/1.0',
        },
      },
      (res) => {
        // 处理重定向（GitHub Releases 通常重定向到 S3/CDN）
        if (
          (res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308) &&
          res.headers.location
        ) {
          res.resume();
          downloadFile(res.headers.location, totalSize, onProgress)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          fileStream.close();
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
          reject(
            new Error(
              `下载失败: HTTP ${res.statusCode}\n\n` +
                '手动安装指引:\n' +
                '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
                '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
                '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
                '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
            ),
          );
          return;
        }

        // 若响应头提供了 Content-Length，优先使用（比 API 的 asset.size 更准确）
        const contentLength = res.headers['content-length'];
        const effectiveSize = contentLength
          ? parseInt(contentLength, 10)
          : totalSize;

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          fileStream.write(chunk);

          // 控制报告频率：每 200ms 或每 1% 进度
          const now = Date.now();
          const elapsed = now - lastReportTime;
          const percent =
            effectiveSize > 0
              ? Math.min(Math.round((downloaded / effectiveSize) * 100), 99)
              : -1;

          if (onProgress && (elapsed >= 200 || percent <= 0)) {
            const bytesPerSec =
              ((downloaded - lastReportBytes) / elapsed) * 1000;
            onProgress(
              percent >= 0 ? percent : 0,
              formatSpeed(bytesPerSec),
            );
            lastReportTime = now;
            lastReportBytes = downloaded;
          }
        });

        res.on('end', () => {
          fileStream.end(() => {
            if (onProgress) {
              onProgress(100, formatSpeed(0));
            }
            resolve(tmpPath);
          });
        });

        res.on('error', (err) => {
          fileStream.close();
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
          reject(new Error(`下载中断: ${err.message}`));
        });
      },
    );

    req.on('timeout', () => {
      fileStream.close();
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      req.destroy(
        new Error(
          `下载超时 (${DOWNLOAD_TIMEOUT_MS / 1000 / 60} 分钟)\n\n` +
            '手动安装指引:\n' +
            '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
            '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
            '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
            '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
        ),
      );
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      fileStream.close();
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      reject(
        new Error(
          `下载失败: ${err.message}\n\n` +
            '手动安装指引:\n' +
            '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
            '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
            '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
            '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
        ),
      );
    });
  });
}

/** 格式化下载速度 */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let unitIdx = 0;
  let value = bytesPerSec;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`;
}

// ---------------------------------------------------------------------------
// DownloadManager
// ---------------------------------------------------------------------------

/**
 * llama.cpp 预编译包下载管理器。
 *
 * 使用 GitHub API 自动发现最新 Windows CUDA 预编译包，下载并解压到项目目录。
 * 全部基于 Node.js 内置模块（https + zlib），零外部依赖。
 *
 * @example
 * ```ts
 * const dm = new DownloadManager();
 *
 * // 快速检测
 * if (dm.isInstalled(projectRoot)) {
 *   console.log('llama.cpp 已安装');
 * }
 *
 * // 详细检测
 * const result = dm.check(projectRoot);
 * console.log(result); // { installed: true, path: '...', version: 'b4978' }
 *
 * // 自动下载安装
 * const version = await dm.download(projectRoot, (pct, speed) => {
 *   console.log(`${pct}% @ ${speed}`);
 * });
 * console.log(`已安装版本: ${version}`);
 * ```
 */
export class DownloadManager {
  // -----------------------------------------------------------------------
  // 检测
  // -----------------------------------------------------------------------

  /**
   * 检测 llama.cpp（llama-server.exe）是否已安装。
   *
   * @param projectRoot - 项目根目录
   * @returns 检测结果，包含安装状态、路径和版本信息
   */
  check(projectRoot: string): CheckResult {
    const libDir = join(projectRoot, LIBS_LLAMACPP);
    const serverPath = join(libDir, LLAMA_SERVER_EXE);

    if (!existsSync(serverPath)) {
      return { installed: false };
    }

    // 读取版本信息
    const versionPath = join(libDir, VERSION_FILE);
    let version: string | undefined;
    if (existsSync(versionPath)) {
      try {
        version = readFileSync(versionPath, 'utf-8').trim();
      } catch {
        // 版本文件损坏，忽略
      }
    }

    return {
      installed: true,
      path: serverPath,
      version,
    };
  }

  /**
   * 快速检测 llama.cpp 是否已安装。
   *
   * @param projectRoot - 项目根目录
   * @returns true 表示 llama-server.exe 已存在
   */
  isInstalled(projectRoot: string): boolean {
    return existsSync(join(projectRoot, LIBS_LLAMACPP, LLAMA_SERVER_EXE));
  }

  // -----------------------------------------------------------------------
  // 下载安装
  // -----------------------------------------------------------------------

  /**
   * 从 GitHub Releases 下载最新的 llama.cpp Windows CUDA 预编译包，
   * 解压到 libs/llama.cpp/ 目录。
   *
   * @param projectRoot - 项目根目录
   * @param onProgress - 可选进度回调 (百分比, 速度字符串)
   * @returns 安装的版本号（GitHub release tag_name）
   * @throws 网络错误、解压失败时抛出带手动安装指引的 Error
   */
  async download(
    projectRoot: string,
    onProgress?: (percent: number, speed: string) => void,
  ): Promise<string> {
    // 1. 获取最新 release 信息
    if (onProgress) {
      onProgress(0, '查询中...');
    }

    const release = await httpsGetJson<GitHubRelease>(
      GITHUB_API_LATEST,
      API_TIMEOUT_MS,
    );

    // 2. 筛选目标 asset
    const asset = release.assets.find(
      (a) =>
        a.name.toLowerCase().includes(ASSET_FILTER) &&
        a.name.endsWith('.zip'),
    );

    if (!asset) {
      throw new Error(
        `未找到匹配的预编译包（筛选条件: *${ASSET_FILTER}*.zip）。\n` +
          `可用的 assets (${release.assets.length}):\n` +
          release.assets
            .map((a) => `  - ${a.name}`)
            .join('\n') +
          '\n\n' +
          '手动安装指引:\n' +
          '  1. 访问 https://github.com/ggerganov/llama.cpp/releases\n' +
          '  2. 下载最新的 *win-x64-cuda*.zip 预编译包\n' +
          '  3. 解压到项目根目录下的 libs/llama.cpp/\n' +
          '  4. 确保 libs/llama.cpp/llama-server.exe 存在',
      );
    }

    // 3. 下载到临时文件
    if (onProgress) {
      onProgress(0, '开始下载...');
    }

    const tmpZipPath = await downloadFile(
      asset.browser_download_url,
      asset.size,
      onProgress,
    );

    // 4. 读取并解压
    if (onProgress) {
      onProgress(100, '解压中...');
    }

    try {
      const zipBuf = readFileSync(tmpZipPath);
      const destDir = join(projectRoot, LIBS_LLAMACPP);

      // 清空目标目录（避免旧文件残留）
      try {
        // 简单清空：删除并重建目录
        const { rmSync } = await import('node:fs');
        if (existsSync(destDir)) {
          rmSync(destDir, { recursive: true, force: true });
        }
      } catch {
        // 若无法删除（权限或被占用），继续覆盖写入
      }

      mkdirSync(destDir, { recursive: true });
      extractZipToDir(zipBuf, destDir);

      // 5. 验证关键文件
      const serverPath = join(destDir, LLAMA_SERVER_EXE);
      if (!existsSync(serverPath)) {
        throw new Error(
          `解压完成但未找到 ${LLAMA_SERVER_EXE}。\n` +
            `请检查 libs/llama.cpp/ 目录内容。`,
        );
      }

      // 6. 写入版本文件
      const version = release.tag_name;
      writeFileSync(join(destDir, VERSION_FILE), version, 'utf-8');

      return version;
    } finally {
      // 清理临时文件
      try {
        unlinkSync(tmpZipPath);
      } catch {
        // 清理失败不阻塞流程
      }
    }
  }
}