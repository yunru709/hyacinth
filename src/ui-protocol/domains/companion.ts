// ============================================================
// UI 协议层 — 陪伴模式域（companion.*）
// ============================================================
// 提供陪伴模式的查询与切换接口，供任意 UI（WebUI / TUI / 未来客户端）复用：
//   companion.get        查询当前状态（是否激活、当前角色、可用角色列表）
//   companion.activate    激活陪伴模式（切换 Router + Session + BypassAgent）
//   companion.deactivate 退出陪伴模式（切回 normal Router + 恢复正常 session）
//
// 实装：委托 ContextProfile 的 switchRouter / getActiveRouterName /
// clearPromptCache，以及 CompanionSessionManager（角色列表 / 目录管理），
// 通过闭包延迟解析。
//
// ★ 切换核心流程与 companion_mode 工具（src/tools/runtime-control.ts）逐行对齐 ★
//   - 模式判断以 loop.activeRouter.name 为准（而非全局 _activeRouterName：
//     二者在 syncRouter 执行前可能不同步）
//   - 已激活且同角色 → 幂等返回
//   - 已激活但换角色 → 手动 onDeactivate → 设 activeCompanionName → onActivate
//     （不能用 syncRouter：它检测到 activeRouter.name 与全局一致会直接 return，
//     不会触发 onActivate，换角色就不会生效）
//   - 未激活 → 设 activeCompanionName → loop.syncRouter()（自动完成
//     onDeactivate → 切换 activeRouter → onActivate）
//   - 切换后 clearPromptCache() + 写 .last-character（下次默认进该角色）
//
// 设计原则（P5-2 纯净化）：
// - 协议层不持有任何业务实现：音色库 / 生成语音库 / 台词历史 / 角色文件系统
//   全部收敛到注入接口（VoiceLibraryLike / VoiceGenStoreLike / SayHistoryStoreLike /
//   CompanionMgrLike），由桥接层（UiProtocolSession）注入全局单例或测试临时实例。
// - 不直读 ~/.agent/companion：角色列表经 mgr.listCharacters()，
//   .last-character 经 mgr.getLastCharacter/setLastCharacter。
// - 不硬编码 HTTP 路由：voiceList 的可播放 URL 由注入的 makeVoiceUrl 生成
//   （缺省空串），协议层只返回 id。
// - 域本身不持有状态，每次 get 都从后端实时读取
// - activate / deactivate 是幂等的（重复调用不报错）
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 最小接口（后端能力抽象；桥接层注入实现）
// ────────────────────────────────────────────────────────────

/** AgentLoop 的最小子集（companion 激活/停用需要；与 state 域 LoopLike 语义不同，独立命名） */
export interface CompanionLoopLike {
  /** 当前 session 目录路径 */
  sessionDir: string;
  switchSession(dir: string): Promise<void>;
  setActiveUserId(id: string): void;
  bypassManager?: {
    activateForMode(mode: string): Promise<void>;
    deactivateAll(): Promise<void>;
    getAgent(name: string): unknown | undefined;
    register(agent: unknown): void;
  } | null;
  /**
   * 当前激活的 Router（loop.activeRouter）。
   * 模式判断与换角色切换均以此为准 —— 与 companion_mode 工具一致。
   */
  activeRouter: {
    name: string;
    activeCompanionName?: string;
    onActivate?(loop: unknown): Promise<void>;
    onDeactivate?(loop: unknown): Promise<void>;
  };
  /** 同步 Router：检测 activeRouter.name 与全局不一致时执行 onDeactivate → 切换 → onActivate */
  syncRouter?: () => Promise<void>;
}

/** CompanionSessionManager 的最小子集 */
export interface CompanionMgrLike {
  setCharacter(name: string): void;
  getOrCreate(): string;
  /** 可用角色列表（~/.agent/companion/ 下有 persona.md 的目录名；可选） */
  listCharacters?(): string[];
  /** 上次使用的角色名（.last-character；缺省 ''） */
  getLastCharacter?(): string;
  /** 记住本次使用的角色（写 .last-character；缺省 no-op） */
  setLastCharacter?(name: string): void;
}

/** Router 切换函数类型 */
export interface RouterSwitcherLike {
  switchRouter(name: string): unknown;
  getActiveRouterName(): string;
  /** 清空 prompt 加载缓存（切换角色后强制重载；对应 prompts/loader.clearPromptCache，可选） */
  clearPromptCache?(): void;
}

// ── 音色库（参考声音 · 用户资产）最小接口 ──────────────────
// 对应 companion/voice-library.ts 的 VoiceLibrary / VoiceEntry。
// 协议层只依赖结构，不 import 具体模块。

export interface VoiceEntryLike {
  id: string;
  file: string;
  desc?: string;
  bind?: string;
  createdAt: string;
}

export interface VoiceLibraryLike {
  list(): VoiceEntryLike[];
  get(id: string): VoiceEntryLike | undefined;
  /** 音色文件绝对路径（不存在返回 undefined） */
  fileOf(entry: VoiceEntryLike): string | undefined;
  register(srcPath: string, opts?: { id?: string; desc?: string; bind?: string }): VoiceEntryLike;
  bind(voiceId: string, character: string): VoiceEntryLike;
  delete(id: string): void;
  /** 音色文件字节数（缺失返回 0；voiceStats 用，可选） */
  sizeOf?(entry: VoiceEntryLike): number;
}

// ── 生成语音库（TTS 输出侧 · 重放）最小接口 ────────────────
// 对应 companion/voice-store.ts 的 GeneratedVoiceStore / GeneratedVoiceRow。

export interface GeneratedVoiceRowLike {
  id: string;
  textNorm: string;
  emotionKey: string;
  emotionRaw?: string;
  voiceId: string;
  durationMs?: number;
  createdAt: string;
}

export interface VoiceGenStoreLike {
  listByCharacter(character: string, limit?: number): GeneratedVoiceRowLike[];
  stats(): {
    count: number;
    totalBytes: number;
    byCharacter: Array<{ character: string; count: number; bytes: number }>;
  };
  prune(character: string, keep: number): number;
}

// ── 台词历史最小接口 ────────────────────────────────────────
// 对应 companion/say-history.ts 的 SayHistoryStore / SayHistoryEntry。

export interface SayHistoryEntryLike {
  sayId: string;
  character: string;
  mode: string;
  text: string;
  tone?: string;
  think?: string;
  action?: string;
  at: string;
}

export interface SayHistoryStoreLike {
  listByCharacter(character: string, limit?: number): SayHistoryEntryLike[];
}

// ── 场景（scene_render 产出 · 陪伴背景）最小接口 ─────────────
// 对应 generation/scene-render.ts 的 scene.json 元数据（scene.png
// 是固定文件名，URL 由桥接层注入的 makeSceneUrl 构造，协议层不硬编码路由）。
// 只读查询：读取类依赖缺失 → 降级返回 null（无场景），不报错。

/** scene.json 的元数据（无 URL；URL 由域内 makeSceneUrl 拼接） */
export interface CompanionSceneMeta {
  /** 场景画面签名（scene_desc 规范化 hash；未变化时前端可跳过重绘） */
  signature: string;
  /** 渲染提示词（scene_desc） */
  prompt: string;
  /** 生成供应商（如 volc） */
  provider: string;
  /** 渲染时间（ISO） */
  createdAt: string;
}

export interface SceneReaderLike {
  /** 读取角色场景元数据（scene.json；不存在/损坏返回 null） */
  read(character: string): CompanionSceneMeta | null;
}

export interface CompanionDomainOptions {
  getLoop: () => CompanionLoopLike | null;
  getCompanionMgr: () => CompanionMgrLike | null;
  getRouterSwitcher: () => RouterSwitcherLike | null;
  /** 音色库（桥接层注入；null = 不支持 voice 动作） */
  getVoiceLibrary: () => VoiceLibraryLike | null;
  /** 生成语音库（桥接层注入；null = 不支持 voice 动作） */
  getVoiceGenStore: () => VoiceGenStoreLike | null;
  /** 台词历史库（桥接层注入；null = 不支持 sayHistory） */
  getSayHistoryStore: () => SayHistoryStoreLike | null;
  /** 场景读取器（桥接层注入；null = 无场景数据） */
  getSceneReader: () => SceneReaderLike | null;
  /** 每角色保留的生成语音条数（voicePrune 缺省 / voiceStats 展示；桥接层注入业务值） */
  keepPerCharacter: number;
  /** 生成语音可播放 URL 构造器（voiceList.url 用；缺省返回空串） */
  makeVoiceUrl?: (id: string) => string;
  /** 场景图可播放 URL 构造器（scene.imageUrl 用；缺省返回空串） */
  makeSceneUrl?: (character: string) => string;
}

// ────────────────────────────────────────────────────────────
// 返回值类型
// ────────────────────────────────────────────────────────────

export interface CompanionState {
  /** 是否处于陪伴模式 */
  active: boolean;
  /** 当前角色名（active=false 时为空） */
  character: string;
  /** 可用角色列表 */
  characters: string[];
}

export interface CompanionActivateResult {
  active: true;
  character: string;
}

export interface CompanionDeactivateResult {
  active: false;
}

// ────────────────────────────────────────────────────────────
// Companion 域工厂
// ────────────────────────────────────────────────────────────

export function createCompanionDomain(options: CompanionDomainOptions): DomainHandler {
  const { getLoop, getCompanionMgr, getRouterSwitcher } = options;
  const voiceLib = () => options.getVoiceLibrary();
  const voiceStore = () => options.getVoiceGenStore();
  const sayStore = () => options.getSayHistoryStore();

  /** 当前可用角色列表（mgr.listCharacters；mgr 缺失/未实现 → []） */
  function availableCharacters(): string[] {
    try {
      return getCompanionMgr()?.listCharacters?.() ?? [];
    } catch {
      return [];
    }
  }

  /** 上次使用的角色（mgr.getLastCharacter；缺省 ''） */
  function readLastCharacter(): string {
    try {
      return getCompanionMgr()?.getLastCharacter?.() ?? '';
    } catch {
      return '';
    }
  }

  /** 记住本次角色（mgr.setLastCharacter；mgr 未实现 → no-op） */
  function writeLastCharacter(name: string): void {
    try {
      getCompanionMgr()?.setLastCharacter?.(name);
    } catch { /* 写入失败不影响 */ }
  }

  function loop(): CompanionLoopLike {
    const l = getLoop();
    if (!l) throw new Error('companion not supported (AgentLoop not available)');
    return l;
  }

  function mgr(): CompanionMgrLike {
    const m = getCompanionMgr();
    if (!m) throw new Error('companion not supported (CompanionSessionManager not available)');
    return m;
  }

  function router(): RouterSwitcherLike {
    const r = getRouterSwitcher();
    if (!r) throw new Error('companion not supported (router switcher not available)');
    return r;
  }

  return {
    // ── companion.get ──────────────────────────────────────
    async get(): Promise<CompanionState> {
      // 模式判断：优先 loop.activeRouter（与工具一致），fallback 全局 router 名
      let active = false;
      let character = '';
      try {
        const l = getLoop();
        if (l) {
          active = l.activeRouter?.name === 'companion';
          if (active) character = l.activeRouter?.activeCompanionName || '';
        }
      } catch { /* loop 不可用 */ }

      if (!active) {
        try {
          const rs = getRouterSwitcher();
          active = rs?.getActiveRouterName() === 'companion';
          if (active) {
            // 已激活时 switchRouter('companion') 是幂等的（设同名），无副作用
            const cr = rs?.switchRouter('companion') as { activeCompanionName?: string } | undefined;
            character = cr?.activeCompanionName || '';
          }
        } catch { /* router 不可用 */ }
      }

      if (active && !character) {
        character = readLastCharacter();
      }

      return { active, character, characters: availableCharacters() };
    },

    // ── companion.activate ─────────────────────────────────
    // 对齐 companion_mode 工具（runtime-control.ts）的真实切换流程：
    //   1. 确定角色名（参数 > .last-character > 唯一可用角色）
    //   2. switchRouter('companion') → 设全局 _activeRouterName = 'companion'
    //   3. 设 CompanionRouter.activeCompanionName = charName
    //   4. 分情况完成 Router 生命周期：
    //      已激活且同角色 → 幂等返回
    //      已激活且换角色 → 手动 onDeactivate → 设名字 → onActivate
    //      未激活         → loop.syncRouter()（自动 onDeactivate → 切换 → onActivate）
    //   5. clearPromptCache() + 写 .last-character
    async activate(params: unknown): Promise<CompanionActivateResult> {
      const p = params as { character?: string } | undefined;
      const requestedChar = p?.character;

      const rs = router();
      const l = loop();

      // 确定角色名：参数 > .last-character > 唯一可用角色
      let charName = requestedChar || '';
      if (!charName) charName = readLastCharacter();
      if (!charName) {
        const available = availableCharacters();
        if (available.length === 1) {
          charName = available[0];
        } else if (available.length > 1) {
          throw new Error(
            `多个角色可选 (${available.join(', ')})：请在 设置→模式→陪伴角色 中选择，` +
            '或在请求时指定 character 参数',
          );
        } else {
          throw new Error('没有可用的陪伴角色。请先创建角色（companion_mode create）。');
        }
      }

      // ★ 拿到 CompanionRouter 单例并设角色名（switchRouter 副作用：全局名置为 companion）
      const companionRouter = rs.switchRouter('companion') as {
        activeCompanionName?: string;
        onActivate?(loop: unknown): Promise<void>;
        onDeactivate?(loop: unknown): Promise<void>;
      };

      if (l.activeRouter?.name === 'companion') {
        // 已在陪伴模式
        const currentName = l.activeRouter?.activeCompanionName || '';
        if (currentName === charName) {
          // 同角色 → 幂等
          return { active: true, character: currentName };
        }
        // 换角色：syncRouter 检测到 activeRouter.name 与全局一致会直接 return，
        // 必须手动执行 onDeactivate → 设新名字 → onActivate（与工具一致）
        await l.activeRouter?.onDeactivate?.(l);
        companionRouter.activeCompanionName = charName;
        await companionRouter.onActivate?.(l);
      } else {
        // 从正常模式进入 → 设名字后 syncRouter 自动触发 onDeactivate → 切换 → onActivate
        companionRouter.activeCompanionName = charName;
        if (l.syncRouter) {
          await l.syncRouter();
        } else {
          // Fallback：loop 没有 syncRouter（极简后端），手动走核心步骤
          const m = mgr();
          m.setCharacter(charName);
          const companionDir = m.getOrCreate();
          await l.switchSession(companionDir);
          l.setActiveUserId(`${charName}-companion`);
          await l.bypassManager?.activateForMode('companion');
        }
      }

      // 切换完成：清 prompt 缓存（强制重载角色 persona），记住本次选择
      rs.clearPromptCache?.();
      writeLastCharacter(charName);

      return { active: true, character: charName };
    },

    // ── companion.deactivate ───────────────────────────────
    // 对齐 companion_mode 工具的 deactivate 分支：
    //   1. 判断 loop.activeRouter.name === 'companion'（否则幂等返回）
    //   2. switchRouter('normal') → 设全局名
    //   3. loop.syncRouter() → 触发 companionRouter.onDeactivate（停用 bypass + 切回 normal session）
    //   4. clearPromptCache()
    async deactivate(): Promise<CompanionDeactivateResult> {
      const rs = router();
      const l = loop();

      if (l.activeRouter?.name !== 'companion') {
        return { active: false };
      }

      // ★ 核心：切回 normal，syncRouter 完成清理（onDeactivate 停 bypass + 切回 normal session）
      rs.switchRouter('normal');
      if (l.syncRouter) {
        await l.syncRouter();
      } else {
        await l.bypassManager?.deactivateAll();
      }
      rs.clearPromptCache?.();

      return { active: false };
    },

    // ── 音色库（参考声音 · 用户资产）────────────────────────
    //
    // 音色是用户录的真人声音，**不可重建**，因此管理权归用户（通过 UI），
    // 不开放给模型 —— 模型只在 companion_say 里"选用"音色，不增删改。
    // 这些动作是 voice_manage 工具移除后的能力承接方。
    voices(): { voices: VoiceEntryLike[] } {
      const lib = voiceLib();
      if (!lib) throw new Error('voice not supported (voice library not injected)');
      return { voices: lib.list() };
    },

    // 绑定角色默认音色（companion_say voice 省略时的解析来源）
    voiceBind(params: unknown): { ok: true; voiceId: string; character: string } {
      const { voiceId, character } = (params ?? {}) as { voiceId?: string; character?: string };
      if (!voiceId || !character) throw new Error('voiceBind requires "voiceId" and "character"');
      const lib = voiceLib();
      if (!lib) throw new Error('voice not supported (voice library not injected)');
      const entry = lib.bind(voiceId, character);
      return { ok: true, voiceId: entry.id, character };
    },

    // ── 生成语音（重放列表）：按角色倒序，含可播放 URL ──
    voiceList(params: unknown): {
      character: string;
      voices: Array<{
        id: string;
        text: string;
        emotion: string;
        tone: string | undefined;
        voiceId: string;
        durationMs?: number;
        url: string;
        createdAt: string;
      }>;
    } {
      const { character, limit } = (params ?? {}) as { character?: string; limit?: number };
      if (!character) throw new Error('voiceList requires "character"');
      const store = voiceStore();
      if (!store) throw new Error('voice not supported (voice store not injected)');
      const makeUrl = options.makeVoiceUrl ?? (() => '');
      const rows = store.listByCharacter(character, Math.min(limit ?? 50, 200));
      return {
        character,
        voices: rows.map((r) => ({
          id: r.id,
          text: r.textNorm,
          emotion: r.emotionKey,
          tone: r.emotionRaw,
          voiceId: r.voiceId,
          durationMs: r.durationMs,
          url: makeUrl(r.id),
          createdAt: r.createdAt,
        })),
      };
    },

    // ── 音色库管理（用户操作）──────────────────────────────

    /** 登记音色：把参考音频（绝对路径）复制进音色库。id 缺省=文件名去扩展名 */
    voiceRegister(params: unknown): { ok: true; voice: VoiceEntryLike } {
      const { path: src, id, desc, character } = (params ?? {}) as {
        path?: string;
        id?: string;
        desc?: string;
        character?: string;
      };
      if (!src) throw new Error('voiceRegister requires "path"（参考音频绝对路径）');
      const lib = voiceLib();
      if (!lib) throw new Error('voice not supported (voice library not injected)');
      const entry = lib.register(src, {
        ...(id ? { id } : {}),
        ...(desc ? { desc } : {}),
        // 登记时可直接绑定为某角色的默认音色
        ...(character ? { bind: character } : {}),
      });
      return { ok: true, voice: entry };
    },

    /** 删除音色（索引 + 音频文件一并移除）。不可重建，UI 应二次确认 */
    voiceDelete(params: unknown): { ok: true; id: string } {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) throw new Error('voiceDelete requires "id"');
      const lib = voiceLib();
      if (!lib) throw new Error('voice not supported (voice library not injected)');
      lib.delete(id);
      return { ok: true, id };
    },

    // ── 容量治理 ────────────────────────────────────────────

    /** 两个库的容量统计（管理面板仪表盘） */
    voiceStats(): {
      voices: {
        count: number;
        totalBytes: number;
        entries: Array<{ id: string; file: string; bytes: number; bind?: string; desc?: string }>;
      };
      generated: {
        count: number;
        totalBytes: number;
        byCharacter: Array<{ character: string; count: number; bytes: number }>;
      };
      keepPerCharacter: number;
    } {
      const lib = voiceLib();
      const entries = lib
        ? lib.list().map((e) => ({
            id: e.id,
            file: e.file,
            bytes: lib.sizeOf?.(e) ?? 0,
            ...(e.bind ? { bind: e.bind } : {}),
            ...(e.desc ? { desc: e.desc } : {}),
          }))
        : [];
      const store = voiceStore();
      return {
        voices: {
          count: entries.length,
          totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
          entries,
        },
        generated: store
          ? store.stats()
          : { count: 0, totalBytes: 0, byCharacter: [] },
        keepPerCharacter: options.keepPerCharacter,
      };
    },

    /**
     * 手动清理生成语音：按角色保留最近 keep 条（缺省用注入的 keepPerCharacter）。
     * 生成语音是缓存（台词文本仍在，可重造），清理不丢数据。
     */
    voicePrune(params: unknown): {
      ok: true;
      character: string;
      keep: number;
      removed: number;
      remaining: number;
    } {
      const { character, keep } = (params ?? {}) as { character?: string; keep?: number };
      if (!character) throw new Error('voicePrune requires "character"');
      const store = voiceStore();
      if (!store) throw new Error('voice not supported (voice store not injected)');
      const n = typeof keep === 'number' && keep > 0
        ? Math.min(Math.floor(keep), 100000)
        : options.keepPerCharacter;
      const removed = store.prune(character, n);
      return {
        ok: true,
        character,
        keep: n,
        removed,
        remaining: store.listByCharacter(character, 100000).length,
      };
    },

    // ── 台词历史（companion_say 表达的文字记录；刷新后恢复台词对话） ──
    sayHistory(params: unknown): {
      character: string;
      entries: Array<{
        sayId: string;
        mode: string;
        text: string;
        tone?: string;
        think?: string;
        action?: string;
        at: string;
      }>;
    } {
      const { character, limit } = (params ?? {}) as { character?: string; limit?: number };
      if (!character) throw new Error('sayHistory requires "character"');
      const store = sayStore();
      if (!store) throw new Error('sayHistory not supported (say history store not injected)');
      const entries = store.listByCharacter(character, Math.min(limit ?? 50, 200));
      return { character, entries };
    },

    // ── 当前场景（scene_render 产出 · 陪伴背景）─────────────────
    // 只读查询：读 scene.json 元数据（signature/prompt/provider/createdAt），
    // imageUrl 由注入的 makeSceneUrl 构造（缺省空串）。
    // 语义：读取类依赖缺失（无 reader / 无场景文件）→ 返回 null（无场景），
    // 前端回落默认背景 —— 不做报错，与"读取类降级"约定一致。
    scene(params: unknown): (CompanionSceneMeta & { imageUrl: string }) | null {
      const { character } = (params ?? {}) as { character?: string };
      if (!character) throw new Error('scene requires "character"');
      const reader = options.getSceneReader();
      if (!reader) return null;
      const meta = reader.read(character);
      if (!meta) return null;
      const makeUrl = options.makeSceneUrl ?? (() => '');
      return { ...meta, imageUrl: makeUrl(character) };
    },
  };
}
