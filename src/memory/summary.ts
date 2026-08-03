import fs from 'node:fs/promises';
import path from 'node:path';

export class SummaryStore {
  private readonly summaryFile: string;

  /** 默认全量摘要文件名（含目录：summaries/_full.md） */
  static readonly FULL_SUMMARY = 'summaries/_full.md';

  constructor(summaryFile: string = SummaryStore.FULL_SUMMARY) {
    this.summaryFile = summaryFile;
  }

  /** 获取指定簇的摘要文件路径 */
  static clusterFile(clusterId: string): string {
    return `summaries/cluster_${clusterId}.md`;
  }

  /** 获取某意图簇（capability）的摘要文件路径（方案 G：summary.{capability}.md） */
  static capabilityFile(clusterKey: string): string {
    return `summaries/summary.${clusterKey}.md`;
  }

  async save(sessionDir: string, summary: string, clusterId?: string): Promise<void> {
    const fileName = clusterId ? SummaryStore.clusterFile(clusterId) : this.summaryFile;
    const filePath = path.join(sessionDir, fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, summary, 'utf-8');
  }

  async load(sessionDir: string, clusterId?: string): Promise<string | null> {
    const fileName = clusterId ? SummaryStore.clusterFile(clusterId) : this.summaryFile;
    const filePath = path.join(sessionDir, fileName);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 保存某意图簇（capability）的压缩摘要（方案 G 分桶）。
   * clusterKey 白名单校验：仅允许 [a-zA-Z0-9_-]{1,64}（决策 F 安全护栏）。
   */
  async saveClusterSummary(sessionDir: string, clusterKey: string, text: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clusterKey)) {
      throw new Error(`saveClusterSummary: 非法 clusterKey "${clusterKey}"`);
    }
    const filePath = path.join(sessionDir, SummaryStore.capabilityFile(clusterKey));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf-8');
  }

  /**
   * 读取某意图簇（capability）的压缩摘要（方案 G 分桶）。
   * 兼容旧格式：分桶文件不存在时，'general' 桶回退到全量摘要（_full.md 单字符串）。
   */
  async getClusterSummary(sessionDir: string, clusterKey: string): Promise<string | null> {
    const filePath = path.join(sessionDir, SummaryStore.capabilityFile(clusterKey));
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim() || null;
    } catch {
      // 分桶文件不存在 → 仅 general 回退到全量摘要（旧格式单字符串）
      if (clusterKey === 'general') {
        return this.load(sessionDir);
      }
      return null;
    }
  }
}
