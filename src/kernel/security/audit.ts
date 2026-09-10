/**
 * 安全审计账本 —— ~/.agent/audit.jsonl，一行一条 JSON。
 *
 * 参照 dsh "model-visible means logged" 的账本纪律与 memory/events.ts 的
 * JSONL append 形态：deny / 降级 / 模式切换事件全记账，供事后追溯。
 * 设计红线：审计失败绝不抛出打断业务（append 失败静默 + stderr 日志）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../logging/logger.js';
import type { AuditEvent } from './types.js';

const logger = createLogger('security-kernel').child('mod', { sub: 'audit' });

let auditFile: string | null = null;
let dirReady = false;

/** 审计文件路径（默认 ~/.agent/audit.jsonl；测试可重定向） */
export function getAuditFile(): string {
  if (!auditFile) auditFile = path.join(os.homedir(), '.agent', 'audit.jsonl');
  return auditFile;
}

/** 测试专用：重定向审计文件（传 null 还原默认） */
export function setAuditFile(file: string | null): void {
  auditFile = file;
  dirReady = false;
}

/** 追加一条审计事件（永不抛出） */
export function appendAudit(event: Omit<AuditEvent, 'ts'>): void {
  try {
    const file = getAuditFile();
    if (!dirReady) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    const line = JSON.stringify({ ...event, ts: new Date().toISOString() });
    fs.appendFileSync(file, line + '\n', 'utf-8');
  } catch (err) {
    logger.warn('audit append failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
