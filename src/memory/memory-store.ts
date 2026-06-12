import fs from 'node:fs';
import path from 'node:path';

const MEMORY_FILENAME = 'memory.md';
const HEADER = '<!-- Memory managed by Agent. Edit directly or use /memory command. -->';

export class MemoryStore {
  private projectDir: string;
  private filePath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.filePath = path.join(projectDir, MEMORY_FILENAME);
  }

  load(): string {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return raw.trim();
    } catch {
      return '';
    }
  }

  save(content: string): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, content, 'utf-8');
  }

  append(content: string): void {
    const current = this.load();
    this.save(current ? `${current}\n\n${content}` : content);
  }

  getFilePath(): string {
    return this.filePath;
  }

  formatForContext(): string {
    const content = this.load();
    if (!content) return '';

    return `${HEADER}\n\n${content}`;
  }

  initializeIfNeeded(): void {
    try {
      fs.accessSync(this.filePath);
    } catch {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, `${HEADER}\n\n`, 'utf-8');
    }
  }
}
