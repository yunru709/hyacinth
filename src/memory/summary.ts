import fs from 'node:fs/promises';
import path from 'node:path';

export class SummaryStore {
  private readonly summaryFile: string;

  constructor(summaryFile: string = 'summary.md') {
    this.summaryFile = summaryFile;
  }

  async save(sessionDir: string, summary: string): Promise<void> {
    const filePath = path.join(sessionDir, this.summaryFile);
    await fs.writeFile(filePath, summary, 'utf-8');
  }

  async load(sessionDir: string): Promise<string | null> {
    const filePath = path.join(sessionDir, this.summaryFile);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }
}
