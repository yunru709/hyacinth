import fs from 'node:fs';
import path from 'node:path';

const HEADER = '<!-- Memory managed by Agent. Edit directly or use /memory command. -->';

export class MemoryStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
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
