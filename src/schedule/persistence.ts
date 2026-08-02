import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ScheduledTask, TaskExecutionRecord, SerializedSchedulerData } from './types.js';

const CACHE_VERSION = 1;

/** 获取持久化文件路径 */
function getStoragePath(): string {
  return path.join(os.homedir(), '.agent', 'scheduler', 'tasks.json');
}

/**
 * SchedulePersistence — 定时任务的持久化存储。
 *
 * 职责：
 *   1. 保存/加载任务列表
 *   2. 保存/加载执行记录
 *   3. 自动去重和容量控制
 */
export class SchedulePersistence {
  private storagePath: string;
  private data: SerializedSchedulerData | null = null;

  constructor() {
    this.storagePath = getStoragePath();
  }

  /**
   * 从磁盘加载数据。
   *
   * 注意：每次调用都重新读取磁盘，而不是永久缓存内存副本。
   * 多个 Agent 实例（TUI / Feishu / WebUI 等）共享同一个 tasks.json，
   * 若缓存 this.data 后永不刷新，某个实例删除任务后，其他实例仍会用它
   * 内存里的旧任务列表整文件重写（如 addRecord 时 save()），导致已删除的
   * 任务"复活"。文件读取频率极低（任务 CRUD 及执行记录写入），性能可忽略。
   */
  async load(): Promise<SerializedSchedulerData> {
    try {
      const content = await fs.readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(content) as SerializedSchedulerData;
      if (parsed.version === CACHE_VERSION) {
        this.data = parsed;
        return parsed;
      }
    } catch {
      // 读取失败（文件不存在/损坏）：回退到内存缓存，避免丢数据
      if (this.data) return this.data;
    }

    this.data = { version: CACHE_VERSION, tasks: [], records: [] };
    return this.data;
  }

  /** 保存到磁盘 */
  private async save(): Promise<void> {
    if (!this.data) return;
    try {
      const dir = path.dirname(this.storagePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.storagePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch {
      // 写入失败不影响主流程
    }
  }

  /** 获取所有任务 */
  async getAllTasks(): Promise<ScheduledTask[]> {
    const data = await this.load();
    return data.tasks;
  }

  /** 添加或更新任务 */
  async saveTask(task: ScheduledTask): Promise<void> {
    const data = await this.load();
    const idx = data.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      data.tasks[idx] = task;
    } else {
      data.tasks.push(task);
    }
    await this.save();
  }

  /** 删除任务 */
  async deleteTask(taskId: string): Promise<boolean> {
    const data = await this.load();
    const idx = data.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;
    data.tasks.splice(idx, 1);
    await this.save();
    return true;
  }

  /** 获取任务 */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const data = await this.load();
    return data.tasks.find(t => t.id === taskId) ?? null;
  }

  /** 添加执行记录（自动裁剪到 maxRecords） */
  async addRecord(record: TaskExecutionRecord, maxRecords: number = 1000): Promise<void> {
    const data = await this.load();
    data.records.unshift(record);
    if (data.records.length > maxRecords) {
      data.records = data.records.slice(0, maxRecords);
    }
    await this.save();
  }

  /** 获取最近的执行记录 */
  async getRecentRecords(limit: number = 20): Promise<TaskExecutionRecord[]> {
    const data = await this.load();
    return data.records.slice(0, limit);
  }

  /** 清空所有数据 */
  async clear(): Promise<void> {
    this.data = { version: CACHE_VERSION, tasks: [], records: [] };
    await this.save();
  }
}