// ============================================================
// session-service.ts —— SessionService：内核唯一会话入口
// ============================================================
//
// 【解决的问题】会话主控权曾分给每个渠道（ChannelHandler.handleMessage
// 契约直书「渠道自行管理 session、AgentLoop、回复」），各渠道各自长出
// 身份解析 + loop 池 + 持久化，差异即混乱源（2026-09-17 跨渠道串台事故）。
// 本服务把三类职责收归内核单点：
//   ① identity → sessionId 解析 + 持久化（~/.agent/session-identity.json）
//   ② sessionId → loop 运行时注册表（LRU）
//   ③ 恢复：快照 → 最近 → fail-closed
// 渠道退化为纯传输适配器，不再持有任何会话知识。
//
// 【零渠道知识】本文件只接收字符串级入参（channel / identity / explicitId），
// 不 import 任何 ChannelHandler 实现；loop/agent 通过最小结构化接口注入
// （AgentFactory / ChannelSessionRunner 形状天然兼容），跨项目可移植。
//
// 【策略外部配置化】每渠道的会话策略（sessionKey 派生态 / 是否共享 loop）
// 由组装层从配置读好后注入（session.channelPolicies），本文件不写死。
//
// 【与既有注册表的衔接】
//   - 前缀 → 渠道 表（session-channel.ts）：显式 sessionId 归属校验用
//   - __channelSessionRegistry getter：bindChannel / registerMainLoop 统一注册，
//     取代各渠道各自注册（避免新旧 getter 双轨）
//   - __channelLoopRegistry：仍由调度侧持有，条目由 ChannelManager 在
//     startChannel 时统一构建（notifyTaskFired 委托到本服务的 runTask）
// ============================================================

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager } from './memory/session.js';
import {
  sessionBelongsToChannel,
  registerChannelSession,
  resolveChannelSession,
  unregisterChannelSession,
} from './session-channel.js';
import { createCollectHandler, type CollectHandler } from './output-handler.js';
import { createLogger } from './logging/logger.js';

const logger = createLogger('session-service');

// ── 最小结构化接口（不依赖 channels/interface，零渠道知识）────────────

/** 会话运行器（AgentLoop 形状，结构兼容 ChannelSessionRunner） */
export interface SessionLoopRunner {
  run(input: string): Promise<void>;
  setOutputHandler(handler: SessionOutputHandler): void;
}

/** 回合输出处理器（结构兼容 ChannelOutputHandler） */
export interface SessionOutputHandler {
  onText?(content: string): void;
  onThinking?(content: string): void;
  onToolUse?(name: string, inputSummary: string): void;
  onToolResult?(content: string, isError: boolean): void;
  onStatus?(message: string, level?: string): void;
  onTurnStart?(): void;
  onFlush?(): void;
  onInterrupt?(): void;
}

/** Agent 创建工厂（结构兼容 AgentFactory） */
export interface SessionAgentFactory {
  createAgent(options: {
    sessionId?: string;
    outputHandler: SessionOutputHandler;
    channel?: string;
  }): Promise<{ loop: SessionLoopRunner }>;
}

/** 入站消息的会话解析输入（结构兼容 ChannelMessageEvent） */
export interface SessionResolveInput {
  /** 显式会话 ID（协议自带会话的渠道填） */
  sessionId?: string;
  /** 发送者 ID（identity.userId 缺省时的兜底） */
  userId?: string;
  /** 平台身份：identity → sessionId 解析的输入 */
  identity?: { userId?: string; chatId?: string; threadId?: string; isGroup?: boolean };
}

// ── 会话策略 ───────────────────────────────────────────────────

/**
 * sessionKey 派生态：
 *   - conversation：按对话身份派生（DM 按发送者 user:<id>、群按 chat:<chatId>[:thread:<tid>]）
 *     —— 等价旧飞书 conversationKey 语义；多会话，映射持久化
 *   - single：单会话渠道（clawbot），恒为 default 键；映射持久化
 *   - explicit：协议自带会话（TUI/WebUI/HTTP），不派生、不持久化
 */
export type SessionKeyPolicy = 'conversation' | 'single' | 'explicit';

export interface ChannelSessionPolicy {
  sessionKey: SessionKeyPolicy;
  /** 多对话共享一个 loop（旧飞书 sessionMode==='shared'）：loop 以 __shared__ 为键共享 */
  sharedLoop?: boolean;
}

export interface SessionServiceOptions {
  sessionManager: SessionManager;
  agentFactory: SessionAgentFactory;
  /** 每渠道会话策略（外部配置注入，缺省 conversation） */
  policies?: Record<string, ChannelSessionPolicy>;
  /** 身份映射文件所在目录（缺省 ~/.agent；测试注入临时目录） */
  identityDir?: string;
  /** loop 注册表 LRU 上限（缺省 50） */
  loopCacheMax?: number;
  /** 旧飞书持久化文件路径（迁移用；测试注入临时路径） */
  legacyFeishuFile?: string;
}

interface LoopEntry {
  loop: SessionLoopRunner;
  collectHandler: CollectHandler;
}

/** 定时任务运行参数（deliver 把结果交给渠道传输层发送） */
export interface SessionTaskRequest {
  channel: string;
  taskName: string;
  sessionId?: string;
  deliver: (sessionId: string, text: string) => Promise<void> | void;
}

// ── SessionService ─────────────────────────────────────────────

export class SessionService {
  private sessionManager: SessionManager;
  private agentFactory: SessionAgentFactory;
  private policies: Record<string, ChannelSessionPolicy>;
  private identityFile: string;
  private legacyFeishuFile: string;
  private loopCacheMax: number;

  /** `${channel}:${identityKey}` → sessionId（持久化到 identityFile） */
  private identityMap = new Map<string, string>();
  /** sessionId → loop（sharedLoop 时键为 '__shared__'） */
  private loopRegistry = new Map<string, LoopEntry>();
  private loopAccessOrder: string[] = [];
  /** channel → 当前会话（快照 getter / 任务通知兜底用） */
  private lastUsedByChannel = new Map<string, string>();
  private identityLoaded = false;
  /** 身份文件写队列：并发 resolveSession 的 persist 串行执行，避免后写覆盖先写丢映射 */
  private persistQueue: Promise<void> = Promise.resolve();
  /** 身份文件首次加载 promise 缓存：并发首次调用共享同一次读，读完成前不暴露空映射 */
  private identityLoadPromise: Promise<void> | null = null;
  /**
   * 本实例解析/创建过的 sessionId —— 区分「未物化的新建会话」与「已删除的死会话」。
   * createLazy 零副作用不建目录，若用 existsSync 直接判死，同一实例内二次解析
   * 未物化的会话会被误判为死会话而重建（identity 复用失效）。凡本实例解析过的
   * id 一律视为活会话；死会话判定只对**文件加载**（重启后）的映射生效。
   */
  private sessionCreated = new Set<string>();

  constructor(options: SessionServiceOptions) {
    this.sessionManager = options.sessionManager;
    this.agentFactory = options.agentFactory;
    this.policies = options.policies ?? {};
    this.loopCacheMax = options.loopCacheMax ?? 50;
    const identityDir = options.identityDir ?? path.join(os.homedir(), '.agent');
    this.identityFile = path.join(identityDir, 'session-identity.json');
    this.legacyFeishuFile = options.legacyFeishuFile ?? path.join(os.homedir(), '.agent', 'feishu_chat.json');
  }

  // ── ① 会话解析 ──────────────────────────────────────────────

  /**
   * 解析入站消息的会话：
   *   1. 显式 sessionId → 归属校验（不属于本渠道则告警并新建，fail-closed）
   *   2. 无显式 → 按渠道策略派生 identityKey → identityMap 查找/新建
   *   3. identityMap 命中的会话目录若已不存在（被 cleanup 删除）→ 重建映射
   *      （conversation 策略不回落他人会话，一律新建；single 策略回落本渠道最近）
   *
   * @param channel 会话归属渠道名（sessionChannel，非 handler id）
   */
  async resolveSession(channel: string, input: SessionResolveInput): Promise<string> {
    // ① 显式会话
    if (input.sessionId) {
      if (!sessionBelongsToChannel(input.sessionId, channel)) {
        logger.warn(
          `explicit sessionId ${input.sessionId.slice(0, 20)}... does not belong to channel "${channel}" — creating new (fail-closed)`,
          { channel },
        );
        return this.newIdentitySession(channel);
      }
      this.touchLastUsed(channel, input.sessionId);
      return input.sessionId;
    }

    // ② 按策略派生
    const policy = this.policy(channel);
    if (policy.sessionKey === 'explicit') {
      logger.warn(`channel "${channel}" requires explicit sessionId but none provided — creating new (fail-closed)`, { channel });
      return this.newIdentitySession(channel);
    }

    const identityKey = this.deriveIdentityKey(policy, input);
    const mapKey = `${channel}:${identityKey}`;
    await this.loadIdentity();

    let sid = this.identityMap.get(mapKey);
    if (!sid) {
      // single 策略：优先复用本渠道当前（恢复的）会话，避免新建空会话
      if (policy.sessionKey === 'single') sid = this.lastUsedByChannel.get(channel) ?? undefined;
      if (!sid) {
        sid = this.sessionManager.createLazy(channel).id;
      }
      this.identityMap.set(mapKey, sid);
      await this.persistIdentity();
    } else if (
      !this.sessionCreated.has(sid)
      && !existsSync(this.sessionManager.getSessionDir(sid))
    ) {
      // ③ 死会话：文件映射（重启后加载）指向的目录已被清理 → 重建映射
      //    （conversation 不回落他人会话，一律新建；single 回落本渠道最近）
      this.identityMap.delete(mapKey);
      sid = await this.rebindDeadSession(channel, policy, identityKey);
    }

    this.sessionCreated.add(sid);
    this.touchLastUsed(channel, sid);
    return sid;
  }

  /** 新建（惰性）会话并持久化映射（显式 id 归属校验失败 / explicit 无 id 时的兜底） */
  private async newIdentitySession(channel: string): Promise<string> {
    const session = this.sessionManager.createLazy(channel);
    this.sessionCreated.add(session.id);
    this.touchLastUsed(channel, session.id);
    return session.id;
  }

  /** 死会话重建：conversation 策略一律新建（绝不把 A 对话的会话喂给 B）；single 回落本渠道最近 */
  private async rebindDeadSession(
    channel: string,
    policy: ChannelSessionPolicy,
    identityKey: string,
  ): Promise<string> {
    let sid: string;
    if (policy.sessionKey === 'single') {
      const recent = await this.sessionManager.getLatestByChannel(channel);
      sid = recent?.id ?? this.sessionManager.createLazy(channel).id;
    } else {
      sid = this.sessionManager.createLazy(channel).id;
    }
    this.sessionCreated.add(sid);
    this.identityMap.set(`${channel}:${identityKey}`, sid);
    await this.persistIdentity();
    return sid;
  }

  /** 按策略派生 identityKey */
  private deriveIdentityKey(policy: ChannelSessionPolicy, input: SessionResolveInput): string {
    if (policy.sessionKey === 'single') return 'default';
    const identity = input.identity ?? {};
    if (identity.isGroup) {
      const chatId = identity.chatId || input.userId || '';
      return `chat:${chatId}${identity.threadId ? `:thread:${identity.threadId}` : ''}`;
    }
    return `user:${identity.userId || input.userId || ''}`;
  }

  // ── ② loop 注册表 ──────────────────────────────────────────

  /** 获取或创建会话 loop（LRU；sharedLoop 时以 __shared__ 键共享一个 loop） */
  async getOrCreateLoop(channel: string, sessionId: string): Promise<LoopEntry> {
    const policy = this.policy(channel);
    const key = policy.sharedLoop ? '__shared__' : sessionId;

    const cached = this.loopRegistry.get(key);
    if (cached) {
      this.touchLoop(key);
      return cached;
    }

    const collectHandler = createCollectHandler();
    const { loop } = await this.agentFactory.createAgent({
      sessionId,
      outputHandler: collectHandler,
      channel,
    });
    const entry: LoopEntry = { loop, collectHandler };
    this.loopRegistry.set(key, entry);
    this.loopAccessOrder.push(key);
    if (this.loopAccessOrder.length > this.loopCacheMax) {
      const oldest = this.loopAccessOrder.shift()!;
      this.loopRegistry.delete(oldest);
    }
    return entry;
  }

  /** 按会话查 loop（任务通知用；查不到返回 null，**不新建**） */
  getLoopBySession(channel: string, sessionId: string): LoopEntry | null {
    const policy = this.policy(channel);
    const key = policy.sharedLoop ? '__shared__' : sessionId;
    const entry = this.loopRegistry.get(key) ?? null;
    if (entry) this.touchLoop(key);
    return entry;
  }

  /** 预注册主 loop（TUI/本地）：记录当前会话 + 注册快照 getter */
  registerMainLoop(channel: string, sessionId: string, loop: SessionLoopRunner): void {
    this.lastUsedByChannel.set(channel, sessionId);
    this.loopRegistry.set(sessionId, { loop, collectHandler: createCollectHandler() });
    registerChannelSession(channel, () => this.lastUsedByChannel.get(channel) ?? '');
  }

  // ── ③ 恢复 ─────────────────────────────────────────────────

  /** 绑定渠道：注册会话 getter + 启动恢复（快照 → 最近 → fail-closed，绝不回落全局最近） */
  async bindChannel(channel: string, sessionChannel?: string): Promise<void> {
    const sc = sessionChannel ?? channel;
    registerChannelSession(sc, () => this.lastUsedByChannel.get(channel) ?? '');
    const restored = await this.restoreSession(channel);
    if (restored) {
      this.lastUsedByChannel.set(channel, restored);
      // single 策略持久化恢复结果，保证重启后首条消息复用同一会话
      const policy = this.policy(channel);
      if (policy.sessionKey === 'single') {
        await this.loadIdentity();
        this.identityMap.set(`${channel}:default`, restored);
        await this.persistIdentity();
      }
    }
  }

  /**
   * 恢复某渠道会话：快照（校验归属 + 存在）→ 本渠道最近 → 新建（fail-closed）。
   * 策略本体在 session-channel.resolveChannelSession —— 与 boot.ts（TUI/CLI 入口）
   * 共用同一实现，本方法只按来源补记日志。
   */
  async restoreSession(channel: string): Promise<string | undefined> {
    if (!channel) return undefined;
    const resolved = await resolveChannelSession(this.sessionManager, channel);
    if (!resolved) return undefined;
    if (resolved.source === 'new') {
      // fail-closed：渠道已声明但没有本渠道存量会话 → 新建，绝不认领全局最近
      logger.warn(`no session found for channel "${channel}" — starting a new one (fail-closed, no global fallback)`, { channel });
    }
    return resolved.id;
  }

  /**
   * 解绑渠道：注销重启快照 getter。
   * 已停止的渠道若仍留在注册表里，下次重启快照会携带它的陈旧会话并被其认领。
   */
  unbindChannel(channel: string, sessionChannel?: string): void {
    unregisterChannelSession(sessionChannel ?? channel);
  }

  // ── 定时任务 ───────────────────────────────────────────────

  /**
   * 定时任务运行：查 loop（sessionId → 本渠道当前 → 无则日志返回，不新建 loop）
   * → 运行任务 prompt → 收集输出 → deliver 交给渠道传输层发送。
   * 替代各渠道各自的 handleTaskNotification。
   */
  async runTask(request: SessionTaskRequest): Promise<void> {
    const { channel, taskName, sessionId, deliver } = request;
    const effective = sessionId ?? this.lastUsedByChannel.get(channel);
    if (!effective) {
      logger.error(`runTask: no session available for channel "${channel}" — cannot deliver task result`, undefined, { taskName });
      return;
    }

    const entry = this.getLoopBySession(channel, effective);
    if (!entry) {
      logger.error(
        `runTask: no loop for session ${effective.slice(0, 20)}... on channel "${channel}" — no message processed yet`,
        undefined,
        { taskName },
      );
      return;
    }

    const prompt = `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered via ${channel}. Execute it now and respond naturally. If this was a one-shot task, it has completed — no need to reschedule.`;

    entry.collectHandler.reset();
    entry.loop.setOutputHandler(entry.collectHandler);
    try {
      await entry.loop.run(prompt);
      const response = entry.collectHandler.getResponse().trim();
      if (response) await deliver(effective, response);
    } catch (err) {
      logger.error(`runTask error: ${err instanceof Error ? err.message : String(err)}`, undefined, { taskName, channel });
    } finally {
      entry.loop.setOutputHandler({ onText: () => {}, onStatus: () => {} });
    }
  }

  // ── 迁移 ───────────────────────────────────────────────────

  /**
   * 迁移旧飞书会话映射（~/.agent/feishu_chat.json 的 sessions）到统一身份文件。
   * 仅在身份文件尚不存在时执行一次；`__shared__` 与不归属飞书的映射丢弃
   * （等价旧 restoreFeishuState 的归属校验语义）。
   * @returns 导入的映射条数
   */
  async migrateFeishuLegacy(): Promise<number> {
    if (existsSync(this.identityFile)) return 0;
    let raw: string;
    try {
      raw = await fs.readFile(this.legacyFeishuFile, 'utf-8');
    } catch {
      return 0; // 旧文件不存在：首次启动
    }
    let data: { sessions?: Record<string, unknown> };
    try {
      data = JSON.parse(raw) as { sessions?: Record<string, unknown> };
    } catch {
      return 0;
    }
    const sessions = data?.sessions;
    if (!sessions || typeof sessions !== 'object') return 0;

    await this.loadIdentity();
    let imported = 0;
    for (const [oldKey, sid] of Object.entries(sessions)) {
      if (typeof sid !== 'string' || sid === '__shared__') continue;
      if (!sessionBelongsToChannel(sid, 'feishu')) continue; // 归属校验
      const newKey = migrateFeishuKey(oldKey);
      if (!newKey) continue;
      this.identityMap.set(`feishu:${newKey}`, sid);
      imported++;
    }
    if (imported > 0) await this.persistIdentity();
    return imported;
  }

  // ── 查询 / 测试 ────────────────────────────────────────────

  /** 取某渠道当前（最近使用）会话；无则 undefined */
  getCurrentSessionId(channel: string): string | undefined {
    return this.lastUsedByChannel.get(channel);
  }

  /** 当前身份映射（测试/诊断用） */
  identitySnapshot(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [mapKey, sid] of this.identityMap) {
      const sep = mapKey.indexOf(':');
      const channel = mapKey.slice(0, sep);
      const key = mapKey.slice(sep + 1);
      (out[channel] ??= {})[key] = sid;
    }
    return out;
  }

  /** 测试隔离：清空运行时状态（不动持久化文件） */
  clearRuntimeState(): void {
    this.loopRegistry.clear();
    this.loopAccessOrder = [];
    this.lastUsedByChannel.clear();
  }

  // ── 内部工具 ───────────────────────────────────────────────

  private policy(channel: string): ChannelSessionPolicy {
    return this.policies[channel] ?? { sessionKey: 'conversation' };
  }

  private touchLastUsed(channel: string, sessionId: string): void {
    this.lastUsedByChannel.set(channel, sessionId);
  }

  private touchLoop(key: string): void {
    const idx = this.loopAccessOrder.indexOf(key);
    if (idx >= 0) this.loopAccessOrder.splice(idx, 1);
    this.loopAccessOrder.push(key);
  }

  private loadIdentity(): Promise<void> {
    if (this.identityLoaded) return Promise.resolve();
    if (!this.identityLoadPromise) {
      this.identityLoadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.identityFile, 'utf-8');
          const data = JSON.parse(raw) as Record<string, Record<string, string>>;
          for (const [channel, map] of Object.entries(data)) {
            if (!map || typeof map !== 'object') continue;
            for (const [key, sid] of Object.entries(map)) {
              if (typeof sid === 'string' && sid) this.identityMap.set(`${channel}:${key}`, sid);
            }
          }
        } catch {
          // 文件不存在或损坏：首次启动正常，视为空映射
        } finally {
          this.identityLoaded = true;
        }
      })();
    }
    return this.identityLoadPromise;
  }

  private persistIdentity(): Promise<void> {
    // 写互斥：并发 resolveSession 的 persist 按序串行；快照在**执行时**重取内存
    // 最新状态，无论顺序如何，最后落盘的总是覆盖全部已 set 键的全量快照（不丢映射）。
    const run = this.persistQueue.then(async () => {
      await this.loadIdentity();
      const byChannel = this.identitySnapshot();
      try {
        await fs.mkdir(path.dirname(this.identityFile), { recursive: true });
        await fs.writeFile(this.identityFile, JSON.stringify(byChannel), 'utf-8');
      } catch (err) {
        logger.warn('identity map persist failed', { detail: err instanceof Error ? err.message : String(err) });
      }
    });
    this.persistQueue = run.catch(() => {}); // 队列吞错，不打断后续 persist
    return run;
  }
}

/** 旧飞书 conversationKey → 新 identityKey 转换（迁移用） */
function migrateFeishuKey(oldKey: string): string | null {
  if (oldKey.startsWith('feishu_dm_')) {
    const userId = oldKey.slice('feishu_dm_'.length);
    return userId ? `user:${userId}` : null; // 空用户 id → 丢弃（与空群 id 一致）
  }
  if (oldKey.startsWith('feishu_group_')) {
    const rest = oldKey.slice('feishu_group_'.length);
    if (!rest) return null;
    const idx = rest.lastIndexOf('_thread_');
    if (idx > 0) {
      const chatId = rest.slice(0, idx);
      const threadId = rest.slice(idx + '_thread_'.length);
      if (!chatId || !threadId) return null;
      return `chat:${chatId}:thread:${threadId}`;
    }
    return `chat:${rest}`;
  }
  return null;
}
