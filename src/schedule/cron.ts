/**
 * CronExpression — 5-field standard cron expression parser.
 *
 * Fields: minute(0-59) hour(0-23) dayOfMonth(1-31) month(1-12) dayOfWeek(0-6, 0=Sun)
 * Supports: * (all), N (exact), N-M (range), N,M (list), step-N (every N)
 */
export class CronExpression {
  private minute: number[];
  private hour: number[];
  private dayOfMonth: number[];
  private month: number[];
  private dayOfWeek: number[];

  constructor(expression: string) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}: "${expression}"`);
    }

    this.minute = this.parseField(parts[0], 0, 59);
    this.hour = this.parseField(parts[1], 0, 23);
    this.dayOfMonth = this.parseField(parts[2], 1, 31);
    this.month = this.parseField(parts[3], 1, 12);
    this.dayOfWeek = this.parseField(parts[4], 0, 6);
  }

  /** 计算指定时间之后的下一次执行时间 */
  next(from: Date = new Date()): Date | null {
    // 从下一分钟开始检查
    let candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    const maxIterations = 525600; // 最多往前算一年
    for (let i = 0; i < maxIterations; i++) {
      if (this.matches(candidate)) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return null;
  }

  /** 计算指定时间之后的多次执行时间 */
  nextN(from: Date, count: number): Date[] {
    const results: Date[] = [];
    let current = from;

    for (let i = 0; i < count; i++) {
      const n = this.next(current);
      if (!n) break;
      results.push(n);
      current = n;
    }

    return results;
  }

  /** 检查给定时间是否匹配 cron 表达式 */
  private matches(date: Date): boolean {
    const m = date.getMinutes();
    const h = date.getHours();
    const d = date.getDate();
    const mo = date.getMonth() + 1;
    const dw = date.getDay();

    if (!this.minute.includes(m)) return false;
    if (!this.hour.includes(h)) return false;
    if (!this.month.includes(mo)) return false;

    // 日和周：如果两者都不是 *，则满足任一即可
    const isDayAll = this.dayOfMonth.length === 31; // 1-31 全覆盖
    const isWeekAll = this.dayOfWeek.length === 7;  // 0-6 全覆盖

    if (!isDayAll && !isWeekAll) {
      return this.dayOfMonth.includes(d) || this.dayOfWeek.includes(dw);
    }
    if (!isDayAll && !this.dayOfMonth.includes(d)) return false;
    if (!isWeekAll && !this.dayOfWeek.includes(dw)) return false;

    return true;
  }

  /** 解析一个 cron 字段 */
  private parseField(field: string, min: number, max: number): number[] {
    if (field === '*') {
      return this.range(min, max);
    }

    const values = new Set<number>();

    // 逗号分隔列表
    for (const part of field.split(',')) {
      const trimmed = part.trim();

      if (trimmed.includes('/')) {
        // 步进：*/N 或 N-M/N
        const [rangePart, stepPart] = trimmed.split('/');
        const step = parseInt(stepPart, 10);
        if (isNaN(step) || step < 1) continue;

        let rMin: number, rMax: number;
        if (rangePart === '*') {
          rMin = min;
          rMax = max;
        } else if (rangePart.includes('-')) {
          const [s, e] = rangePart.split('-');
          rMin = parseInt(s, 10);
          rMax = parseInt(e, 10);
        } else {
          rMin = parseInt(rangePart, 10);
          rMax = max;
        }

        if (isNaN(rMin) || isNaN(rMax)) continue;
        for (let v = rMin; v <= rMax; v += step) {
          if (v >= min && v <= max) values.add(v);
        }
      } else if (trimmed.includes('-')) {
        // 范围 N-M
        const [s, e] = trimmed.split('-');
        const start = parseInt(s, 10);
        const end = parseInt(e, 10);
        if (isNaN(start) || isNaN(end)) continue;
        for (let v = start; v <= end; v++) {
          if (v >= min && v <= max) values.add(v);
        }
      } else {
        // 单个值
        const v = parseInt(trimmed, 10);
        if (!isNaN(v) && v >= min && v <= max) {
          values.add(v);
        }
      }
    }

    if (values.size === 0) {
      throw new Error(`Invalid cron field "${field}" (range ${min}-${max})`);
    }

    return [...values].sort((a, b) => a - b);
  }

  private range(min: number, max: number): number[] {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }
}