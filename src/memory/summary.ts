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
}
