import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface CompressionBoundary {
  /** 已压缩消息的数量（conversation.jsonl 中前 N 条已被摘要覆盖） */
  compressedCount: number;
  /** 最后一次压缩的轮次 */
  lastCompactTurn: number;
}

const DEFAULT_BOUNDARY: CompressionBoundary = {
  compressedCount: 0,
  lastCompactTurn: 0,
};

function getBoundaryPath(sessionId: string): string {
  return path.join(os.homedir(), '.agent', 'sessions', sessionId, 'compression-boundary.json');
}

/**
 * 读取压缩边界信息。
 * 文件不存在时返回默认值 { compressedCount: 0, lastCompactTurn: 0 }。
 *
 * @param sessionId 会话 ID
 * @param jsonlLength conversation.jsonl 的当前消息数（用于 truncate 安全降级）
 */
export async function readCompressionBoundary(
  sessionId: string,
  jsonlLength: number,
): Promise<CompressionBoundary> {
  try {
    const content = await fs.readFile(getBoundaryPath(sessionId), 'utf-8');
    const boundary: CompressionBoundary = JSON.parse(content);

    // truncate 安全降级：jsonl 被截断导致 compressedCount >= jsonl 长度
    if (boundary.compressedCount >= jsonlLength) {
      return { compressedCount: 0, lastCompactTurn: 0 };
    }

    return boundary;
  } catch {
    return { ...DEFAULT_BOUNDARY };
  }
}

/**
 * 写入压缩边界信息。
 * 自动创建目录。
 */
export async function writeCompressionBoundary(
  sessionId: string,
  boundary: CompressionBoundary,
): Promise<void> {
  await fs.mkdir(path.dirname(getBoundaryPath(sessionId)), { recursive: true });
  await fs.writeFile(getBoundaryPath(sessionId), JSON.stringify(boundary), 'utf-8');
}
