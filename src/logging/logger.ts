/**
 * Structured Logging System
 *
 * JSON-lines format to stderr for machine readability.
 * stdout is reserved for agent output, so all logs go to stderr.
 *
 * Levels: debug < info < warn < error
 * Environment: LOG_LEVEL=debug|info|warn|error (default: info)
 */

// ─── Types ────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  ts: string;      // ISO timestamp
  lvl: LogLevel;
  mod: string;     // module name
  msg: string;
  ctx?: Record<string, unknown>;
  err?: { name: string; message: string; stack?: string };
}

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, error?: Error, context?: Record<string, unknown>): void;
  /** Create a child logger with additional default context */
  child(extraModule: string, extraContext?: Record<string, unknown>): Logger;
}

// ─── Console Logger ────────────────────────────────────────────────

function getMinLevel(): LogLevel {
  // 已通过 setLogLevel() 显式设置（configCenter 驱动）优先；
  // 否则回退 LOG_LEVEL env；两者皆无则 info。
  if (_explicitLogLevel) return _explicitLogLevel;
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (env === 'debug') return 'debug';
  if (env === 'warn') return 'warn';
  if (env === 'error') return 'error';
  return 'info';
}

/** 显式日志级别（由 setLogLevel 写入；优先于 LOG_LEVEL env） */
let _explicitLogLevel: LogLevel | null = null;
/** setLogLevel('off') 置 true：createLogger 返回 NoopLogger */
let _loggingOff = false;

/**
 * 显式设置全局日志级别（优先于 LOG_LEVEL env）。
 * 由 factory 在 RuntimeConfigCenter 初始化后调用，把配置的
 * logging.level 同步给 logger——使配置中心成为日志级别的权威来源，
 * env 仅作启动级兜底。
 */
export function setLogLevel(level: LogLevel | 'off'): void {
  if (level === 'off') {
    _loggingOff = true;
    _explicitLogLevel = null;
    return;
  }
  _loggingOff = false;
  _explicitLogLevel = level;
}

export class ConsoleLogger implements Logger {
  private module: string;
  private minLevel: LogLevel;
  private defaultContext: Record<string, unknown>;

  constructor(
    module: string,
    minLevel?: LogLevel,
    defaultContext?: Record<string, unknown>,
  ) {
    this.module = module;
    this.minLevel = minLevel ?? getMinLevel();
    this.defaultContext = defaultContext ?? {};
  }

  debug(msg: string, context?: Record<string, unknown>): void {
    this.log('debug', msg, undefined, context);
  }

  info(msg: string, context?: Record<string, unknown>): void {
    this.log('info', msg, undefined, context);
  }

  warn(msg: string, context?: Record<string, unknown>): void {
    this.log('warn', msg, undefined, context);
  }

  error(msg: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('error', msg, error, context);
  }

  child(extraModule: string, extraContext?: Record<string, unknown>): Logger {
    return new ConsoleLogger(
      `${this.module}:${extraModule}`,
      this.minLevel,
      { ...this.defaultContext, ...extraContext },
    );
  }

  private log(
    level: LogLevel,
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      lvl: level,
      mod: this.module,
      msg: message,
      ctx: context ? { ...this.defaultContext, ...context } : (Object.keys(this.defaultContext).length > 0 ? this.defaultContext : undefined),
    };

    if (error) {
      entry.err = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    // JSON line to stderr
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}

// ─── Noop Logger (for tests / disabled logging) ────────────────────

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(_extraModule: string, _extraContext?: Record<string, unknown>): Logger {
    return this;
  }
}

// ─── Factory ───────────────────────────────────────────────────────

/**
 * Create a logger for the given module.
 * Use LOG_LEVEL=off environment variable or setLogLevel('off') to disable all logging.
 */
export function createLogger(module: string): Logger {
  if (process.env.LOG_LEVEL === 'off' || _loggingOff) {
    return new NoopLogger();
  }
  return new ConsoleLogger(module);
}

// Re-export the class for testing
export { NoopLogger as _NoopLogger };