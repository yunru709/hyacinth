import fs from 'node:fs/promises';

export interface DataFlowPoint {
  file: string;
  line: number;
  kind: 'declaration' | 'assignment' | 'read' | 'argument' | 'return' | 'destructuring';
  text: string;
  context: string[];
}

const CONTEXT_LINES = 2;
const MAX_RESULTS = 50;

export class DataFlowTracker {
  async trace(variableName: string, file: string): Promise<DataFlowPoint[]> {
    const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRegex = new RegExp(`\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${escaped}\\b[^}]*\\}|\\b${escaped}\\b)\\s*[=:]`);
    const destructRegex = new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*=`);
    const assignRegex = new RegExp(`\\b${escaped}\\s*(?:\\[|\\.)?[\\s]*=(?!=)`);
    const returnRegex = new RegExp(`\\breturn\\b[^;]*\\b${escaped}\\b`);
    const argRegex = new RegExp(`\\(.*\\b${escaped}\\b.*\\)`);
    const readRegex = new RegExp(`\\b${escaped}\\b`);

    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      const points: DataFlowPoint[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (points.length >= MAX_RESULTS) break;

        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        if (destructRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'destructuring',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        } else if (declRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'declaration',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        } else if (returnRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'return',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        } else if (assignRegex.test(line) && !declRegex.test(line) && !destructRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'assignment',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        } else if (argRegex.test(line) && !declRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'argument',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        } else if (readRegex.test(line) && !declRegex.test(line) && !assignRegex.test(line) && !destructRegex.test(line)) {
          points.push({
            file,
            line: i + 1,
            kind: 'read',
            text: trimmed,
            context: this.getContext(lines, i),
          });
        }
      }

      return points;
    } catch {
      return [];
    }
  }

  private getContext(lines: string[], index: number): string[] {
    const context: string[] = [];
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    for (let i = start; i <= end; i++) {
      if (i !== index) {
        context.push(`  ${i + 1}: ${lines[i].trimEnd()}`);
      }
    }
    return context;
  }
}
