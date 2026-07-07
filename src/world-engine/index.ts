// ============================================================
// world-engine — 世界引擎门面
// ============================================================
//
// 自包含模块。只在陪伴模式下由 CompanionRouter 启停：
//   onActivate  → engine.start()   加载世界 + 启动 ticker（仅当 enabled）
//   onDeactivate→ engine.stop()    停 ticker + 落盘 + 释放，零占用
//
// 对主流程的全部接触面（都由 CompanionRouter 调用）：
//   narrate()   前置：读环境 → 旁白化，注入主 agent 的时间戳槽位
//   observe()   后置：观察对话 → 生长世界（后台，写串行）
//
// enabled 默认 false —— 没配置或关闭时 narrate() 返回 undefined，
// 陪伴模式行为和现在完全一致（零侵入的硬保证）。
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorldStore } from './store.js';
import { WorldTicker, type WorldTickerOptions } from './ticker.js';
import { WorldAgent, type ModelRouterLike, type AgentIdentities, type CharacterIdentity } from './agent.js';
import type { Relationship } from './types.js';

export { WorldStore } from './store.js';
export { WorldTicker } from './ticker.js';
export { WorldAgent } from './agent.js';
export * from './types.js';

/** 旁白定界符 [[...]]。用户用它包裹"世界旁白/环境事件"，与自己的 `()` 角色动作区分 */
const NARRATION_RE = /\[\[([\s\S]*?)\]\]/g;

/**
 * 从用户输入里解析旁白段（[[...]]）。
 * @returns narration = 所有旁白段拼接；dialogue = 去掉旁白后剩下的、真正说给陪伴角色的话
 */
export function parseNarration(input: string): { narration: string; dialogue: string } {
  const segs: string[] = [];
  const dialogue = input
    .replace(NARRATION_RE, (_m, inner: string) => {
      const t = String(inner).trim();
      if (t) segs.push(t);
      return '';
    })
    .trim();
  return { narration: segs.join('\n'), dialogue };
}

interface WorldEngineConfig {
  enabled: boolean;
  worldId?: string;
  worldName?: string;
  protagonist?: CharacterIdentity;
  companion?: CharacterIdentity;
  /** 预设的初始社会关系（仅新建世界时注入一次） */
  relationships?: Relationship[];
  ticker?: WorldTickerOptions;
}

function parseRelationships(v: unknown): Relationship[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(r => r && typeof r.from === 'string' && typeof r.to === 'string' && typeof r.type === 'string')
    .map(r => ({ from: r.from, to: r.to, type: r.type, note: typeof r.note === 'string' ? r.note : undefined }));
}

function parseIdentity(v: unknown): CharacterIdentity | undefined {
  if (v && typeof v === 'object' && typeof (v as any).name === 'string' && (v as any).name.trim()) {
    return { name: (v as any).name, desc: typeof (v as any).desc === 'string' ? (v as any).desc : undefined };
  }
  return undefined;
}

async function readConfig(characterName: string): Promise<WorldEngineConfig> {
  const charPath = path.join(os.homedir(), '.agent', 'companion', characterName, 'world-engine.json');
  try {
    const cfg = JSON.parse(await fs.readFile(charPath, 'utf-8'));
    return {
      enabled: cfg.enabled === true,
      worldId: typeof cfg.worldId === 'string' ? cfg.worldId : undefined,
      worldName: typeof cfg.worldName === 'string' ? cfg.worldName : undefined,
      protagonist: parseIdentity(cfg.protagonist),
      companion: parseIdentity(cfg.companion),
      relationships: parseRelationships(cfg.relationships),
      ticker: cfg.ticker,
    };
  } catch {
    return { enabled: false }; // 角色没有自己的配置 → 世界引擎关闭
  }
}

export class WorldEngine {
  private readonly characterName: string;
  private readonly modelRouter: ModelRouterLike | null;
  private readonly store: WorldStore;
  /** 在 start() 读到配置（含身份）后才创建 */
  private agent: WorldAgent | null = null;
  private ticker: WorldTicker | null = null;
  private started = false;
  private _enabled = false;
  /** observe 写队列：保证多轮 observe 顺序执行（读并发、写串行） */
  private observeQueue: Promise<void> = Promise.resolve();
  /** 本轮用户旁白（[[...]]），并入 narrate 提示词；每轮由 setPendingNarration 刷新 */
  private pendingNarration = '';

  /**
   * @param characterName 陪伴角色名（如"柔柔"）——一个角色一个世界。
   * @param modelRouter 可选的模型路由（为 null 则不调旁路 LLM）
   */
  constructor(characterName: string, modelRouter: ModelRouterLike | null) {
    this.characterName = characterName;
    this.modelRouter = modelRouter;
    this.store = new WorldStore(characterName);
  }

  get enabled(): boolean {
    return this._enabled && this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const cfg = await readConfig(this.characterName);
    this._enabled = cfg.enabled;
    if (!cfg.enabled) return; // 角色没有自己的配置 → 世界引擎关闭
    const created = await this.store.loadOrCreate(cfg.worldName ?? '我们的世界', new Date());
    // 仅新建世界时注入预设关系；已有世界尊重其现状
    if (created && cfg.relationships?.length) {
      for (const r of cfg.relationships) {
        if (r.from === this.characterName || r.to === this.characterName) {
          await this.store.setRelationship(r.from, r.to, r.type, r.note);
        }
      }
    }
    // companion name 始终与角色目录名一致
    const companion = cfg.companion
      ? { ...cfg.companion, name: this.characterName }
      : { name: this.characterName };
    const identities: AgentIdentities = { protagonist: cfg.protagonist, companion };
    this.agent = new WorldAgent(this.store, this.modelRouter, identities);
    this.ticker = new WorldTicker(this.store, cfg.ticker);
    this.ticker.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.ticker?.stop();
    this.ticker = null;
    await this.observeQueue.catch(() => {}); // 等挂起的 observe 收尾
    await this.store.flush();
    this.agent = null;
    this.pendingNarration = '';
    this.started = false;
    this._enabled = false;
  }

  /** 前置：读环境（+本轮用户旁白）→ 旁白化。世界为空/引擎关闭时返回 undefined */
  async narrate(): Promise<string | undefined> {
    if (!this.enabled || !this.agent || !this.store.hasContent()) return undefined;
    return this.agent.narrate(this.pendingNarration);
  }

  /**
   * 暂存本轮用户旁白（[[...]]），narrate 调用时并入其提示词。
   * 每轮由 transformUserInput 设置（无旁白则设空），narrate 读取但不清除，避免重组时丢失。
   */
  setPendingNarration(text: string): void {
    this.pendingNarration = text;
  }

  /** 后置：观察对话生长世界。后台执行、写串行、绝不阻塞主流程 */
  observe(userInput: string, mainOutput: string): void {
    if (!this.enabled || !this.agent) return;
    const agent = this.agent;
    const run = () => agent.observe(userInput, mainOutput);
    this.observeQueue = this.observeQueue.then(run, run);
  }

}
