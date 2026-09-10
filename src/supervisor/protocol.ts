import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 进程边界契约（Supervisor Protocol）—— Agent 主进程与守护进程之间的唯一约定面。
 *
 * 这里定义的退出码、环境变量、标记文件是**跨进程契约**：写方（业务侧的
 * restart 工具 / 更新命令 / 插件热更新降级）与读方（gateway 入口 / 守护进程）
 * 都必须从本模块取值，禁止各自写字面量（Supervisor 方案 S1）。
 *
 * 分层地位：**零内部依赖的契约叶**（只依赖 node 内置 API）。verify:layers
 * 规则 4 禁止业务核心依赖 supervisor/ 的其余实现，但本文件在白名单内 ——
 * 它是协议本身，不是监督层的实现；与 events.ts 作为中立事件契约同构。
 */

// ─── 退出码协议 ─────────────────────────────────────────────────────

/** 42 = 用户/Agent 触发重启（原样重启，同一入口，标记文件改变恢复行为） */
export const RESTART_EXIT_CODE = 42;
/** 43 = 更新完成（guardian 剥离子命令参数，进入默认入口加载新代码） */
export const RESTART_AFTER_UPDATE_EXIT_CODE = 43;
/** 44 = 插件热更新失败且无法回退（重启兜底，会话与入口参数原样保留） */
export const RESTART_AFTER_PLUGIN_EXIT_CODE = 44;

// ─── 守护进程环境变量 ───────────────────────────────────────────────

/** guardian 启动子进程时注入的环境变量（子进程据此避免递归再 spawn guardian） */
export const GUARDIAN_ENV = 'HYACINTH_GUARDIAN_CHILD';

/** 当前主进程是否处于 guardian 守护之下（决定降级重启是否有兜底接盘） */
export function isUnderGuardian(): boolean {
  return process.env[GUARDIAN_ENV] === '1';
}

// ─── 标记文件 ───────────────────────────────────────────────────────

/** 重启会话快照：渠道 → sessionId 映射 JSON / 'true'（继续最近） */
export const RESTART_SESSION_MARKER = '.restart-session';
/** 重启续工指令：重启后自动发送给 Agent 的消息 */
export const RESTART_CONTINUATION_MARKER = '.restart-continuation';
/** 重启原因存档：JSON，供诊断与可观测面追溯（读后不删，只追加覆盖） */
export const RESTART_REASON_MARKER = '.restart-reason';

/** ~/.agent 目录（标记文件的统一落点） */
export function agentDir(): string {
  return join(homedir(), '.agent');
}

/** 写入一个标记文件（目录不存在则创建） */
export function writeMarker(name: string, content: string): void {
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf-8');
}

/** 读取标记文件内容；不存在或读失败返回 null */
export function readMarker(name: string): string | null {
  try {
    return readFileSync(join(agentDir(), name), 'utf-8');
  } catch {
    return null;
  }
}

/** 消费标记文件：读取内容并删除（一次性标记的标准读法） */
export function consumeMarker(name: string): string | null {
  const file = join(agentDir(), name);
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf-8');
    unlinkSync(file);
    return content;
  } catch {
    return null;
  }
}

/**
 * 标记文件是否"新鲜"（mtime 距今 ≤ maxAgeMs）。
 * 用于防陈旧：崩溃残留的 marker 不应让下次正常启动误入旧会话。
 */
export function markerIsFresh(name: string, maxAgeMs: number): boolean {
  const file = join(agentDir(), name);
  if (!existsSync(file)) return false;
  try {
    return Date.now() - statSync(file).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

/** 删除标记文件（不需要内容时用，如 serve 模式清理跨模式残留）；返回删除前是否存在 */
export function removeMarker(name: string): boolean {
  const file = join(agentDir(), name);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ─── 重启原因存档 ───────────────────────────────────────────────────

export interface RestartReason {
  /** 退出码（42/43/44，语义见上方常量） */
  code: number;
  /** 触发方标识，如 'restart-tool' / 'self-update' / 'plugin-hot-reload' */
  source: string;
  /** 人类可读补充信息（如出错的插件 id + 错误摘要） */
  detail?: string;
}

/**
 * 记录本次重启原因（exit 前调用）。只保留最近一次（覆盖写）——
 * 供启动日志 / supervisor status 追溯「上次为什么重启」。
 */
export function writeRestartReason(reason: RestartReason): void {
  try {
    writeMarker(RESTART_REASON_MARKER, JSON.stringify(reason));
  } catch { /* 诊断存档失败不影响重启本身 */ }
}

/** 读取最近一次重启原因（不删除，供诊断展示） */
export function readRestartReason(): RestartReason | null {
  const raw = readMarker(RESTART_REASON_MARKER);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RestartReason;
    return typeof parsed?.code === 'number' && typeof parsed?.source === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ─── 会话快照 ───────────────────────────────────────────────────────

/**
 * 采集多渠道会话快照（供重启前写入 .restart-session）。
 *
 * 优先读取全局渠道 Session 注册表（`__channelSessionRegistry`）：
 * 注册表存的是「getter」，调用它获取各渠道当前的 sessionId（实时反映切换），
 * 把「渠道 → sessionId」映射序列化为 JSON，重启后按启动渠道恢复各自 session，
 * 避免多渠道共享进程时（TUI + 飞书）重启串 session。
 * 若无注册表/为空，退化为 'true'（继续最近）。
 *
 * 抽到协议层：自重启（RestartTool）与壳层兜底重启（插件热更新失败 44）
 * 共用同一快照逻辑，保证两种重启路径恢复行为一致。
 */
export function snapshotChannelSessions(): string {
  const sessionRegistry = (globalThis as any).__channelSessionRegistry as Map<string, () => string> | undefined;
  let marker = 'true';
  if (sessionRegistry && sessionRegistry.size > 0) {
    const snapshot: Record<string, string> = {};
    for (const [channel, getter] of sessionRegistry) {
      try {
        const sid = getter();
        // 过滤伪 session（'__shared__' / 'feishu_default' 等无真实目录的虚拟会话）
        if (channel && sid && sid !== '__shared__' && !sid.endsWith('_default')) {
          snapshot[channel] = sid;
        }
      } catch { /* 单渠道 getter 失败不影响整体快照 */ }
    }
    if (Object.keys(snapshot).length > 0) {
      marker = JSON.stringify(snapshot);
    }
  }
  return marker;
}

/**
 * 记录一次需要重启兜底的壳层事件（如插件热更新回滚失败），
 * 写入会话快照 + 重启原因存档。调用方随后 `process.exit(code)`。
 */
export function prepareShellRestart(reason: RestartReason): void {
  writeMarker(RESTART_SESSION_MARKER, snapshotChannelSessions());
  writeRestartReason(reason);
}
