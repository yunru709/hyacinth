/* ══════════════════════════════════════════════════════════════════════════
   功能域封装 —— 把 22 个 RPC 域收成可用的 JS 接口
   ══════════════════════════════════════════════════════════════════════════

   为什么需要这一层（而不是让各语言直接 client.request）：
     1. v1 有 101 个 RPC。让三套设计语言各自去记参数名/返回结构 = 3 倍错误面。
     2. 契约有坑，且已实测过：
        · config.get 用 `path`（传 key 会返回整棵树，静默）
        · config.set 必须 `path`，`key` 直接报错
        · state.stats 必须带 sessionId
        · message.history 用 `sessionId`（单数）
     把这些收在本层，语言层就不用再踩。
     3. 统一错误处理：所有调用失败返回 null 并 console.warn，不让一个域崩掉整页。

   ⚠️ 本层**不做任何 UI 决策**。返回原始数据，怎么呈现是各语言的事。
   ══════════════════════════════════════════════════════════════════════════ */

/** 统一的调用包装：失败打日志、返回 null，绝不抛到调用方。 */
function safe(client, tag) {
  return async (method, params) => {
    try {
      const res = await client.request(method, params);
      return res ?? null;
    } catch (err) {
      console.warn(`[domains:${tag}] ${method} 失败:`, err?.message ?? err);
      return null;
    }
  };
}

/* ═══ 配置 ═══════════════════════════════════════════════════════════════ */

export class ConfigDomain {
  constructor(client) {
    this.call = safe(client, 'config');
  }

  /** 整棵配置树（33 个顶层键）。设置页初始化读一次即可。 */
  async all() {
    const r = await this.call('config.getAll', {});
    return r ?? {};
  }

  /**
   * 读单个点路径。
   * ⚠️ 必须用 `path` —— 实测传 `key` 会被忽略并返回整棵树（看起来"能用"但拿错数据）。
   */
  async get(path) {
    const r = await this.call('config.get', { path });
    return r && 'value' in r ? r.value : null;
  }

  /** 写单个点路径。⚠️ 同样必须 `path`，`key` 会报 requires "path"。 */
  async set(path, value) {
    const r = await this.call('config.set', { path, value });
    return r?.ok === true;
  }

  async reset() {
    const r = await this.call('config.reset', {});
    return r?.ok === true;
  }
}

/* ═══ 模型 ═══════════════════════════════════════════════════════════════ */

export class ModelDomain {
  constructor(client) {
    this.call = safe(client, 'model');
  }

  /** { provider, model, providerLabel, isLocal, maxContextTokens } */
  async active() {
    return this.call('model.getActive', {});
  }

  /** { providers: [{type,label,model,active,isLocal,configured,status}] } (16 个) */
  async providers() {
    const r = await this.call('model.listProviders', {});
    return r?.providers ?? [];
  }

  /** { channels: [{name,provider,model,description}] } */
  async channels() {
    const r = await this.call('model.listChannels', {});
    return r?.channels ?? [];
  }

  /** { roles: { chat: 'default', planning: ..., ... } } */
  async roles() {
    const r = await this.call('model.listRoles', {});
    return r?.roles ?? {};
  }

  async localModels() {
    const r = await this.call('model.listLocalModels', {});
    return r?.models ?? [];
  }

  async switchTo(provider, model) {
    const r = await this.call('model.switch', { provider, model });
    return r?.ok === true;
  }

  /** 推理强度档位（thinking） */
  async setThinking(level) {
    const r = await this.call('model.setThinking', { level });
    return r?.ok === true;
  }

  async setChannelModel(name, provider, model) {
    const r = await this.call('model.setChannelModel', { name, provider, model });
    return r?.ok === true;
  }
}

/* ═══ 语音（STT 输入 + TTS 播报）═════════════════════════════════════════ */

export class VoiceDomain {
  constructor(client) {
    this.call = safe(client, 'voice');
  }

  /* ── 语音输入 ── */

  /** { engine, mirror, runtimeAvailable, modelReady, modelDir, missingFiles, downloading } */
  async sttStatus() {
    return this.call('stt.status', {});
  }

  /**
   * 语音识别：把录音转成文字。
   * 入参约定以 v1 为准（audio 为 base64、format 为容器类型）。
   */
  async transcribe(base64Audio, format = 'wav') {
    const r = await this.call('stt.transcribe', { audio: base64Audio, format });
    return r?.text ?? r?.content ?? '';
  }

  /** 触发语音模型下载 */
  async sttDownload() {
    return this.call('stt.download', {});
  }

  /* ── 语音播报 ── */

  /** { active, engines: [{id, kind, kindType, label, capabilities, ready, detail, active}] } */
  async ttsEngines() {
    const r = await this.call('tts.engines', {});
    return r ?? { active: null, engines: [] };
  }

  /** { model, python, service, voices, voicesDir, ... } */
  async ttsStatus() {
    return this.call('tts.status', {});
  }

  async setEngine(engine) {
    const r = await this.call('tts.setEngine', { engine });
    return r?.ok === true;
  }

  /** 是否把回复朗读出来 */
  async setSayBroadcast(on) {
    const r = await this.call('tts.setSayBroadcast', { enabled: !!on });
    return r?.ok === true;
  }

  async synthesize(text) {
    return this.call('tts.synthesize', { text });
  }
}

/* ═══ 能力开关（工具 / 技能 / 插件 / MCP / 工具包）══════════════════════ */

export class CapabilityDomain {
  constructor(client) {
    this.call = safe(client, 'capability');
  }

  /** { bundles: [{name, description, builtin}] } */
  async toolBundles() {
    const r = await this.call('tool.bundles', {});
    return r?.bundles ?? [];
  }

  async tools() {
    const r = await this.call('tool.list', {});
    return r?.tools ?? r ?? [];
  }

  async toggleTool(name, enabled) {
    const r = await this.call('tool.toggle', { name, enabled });
    return r?.ok === true;
  }

  /** { skills: [{name, description, source, enabled, relatedTools, hasDir}] } */
  async skills() {
    const r = await this.call('skill.list', {});
    return r?.skills ?? [];
  }

  async toggleSkill(name, enabled) {
    const r = await this.call('skill.toggle', { name, enabled });
    return r?.ok === true;
  }

  /** [{ id, state, deps }] */
  async plugins() {
    const r = await this.call('plugin.list', {});
    return Array.isArray(r) ? r : (r?.plugins ?? []);
  }

  /** { servers: [{name, ...}] } */
  async mcpServers() {
    const r = await this.call('mcp.list', {});
    return r?.servers ?? [];
  }
}

/* ═══ 运行时（状态 / 进程 / 定时 / 模式 / 命令）══════════════════════════ */

export class RuntimeDomain {
  constructor(client) {
    this.call = safe(client, 'runtime');
  }

  /** ⚠️ state.stats 必须带 sessionId，否则报 INTERNAL_ERROR */
  async stats(sessionId) {
    if (!sessionId) return null;
    return this.call('state.stats', { sessionId });
  }

  async processes() {
    const r = await this.call('process.list', {});
    return r?.processes ?? [];
  }

  async killProcess(pid) {
    const r = await this.call('process.kill', { pid });
    return r?.ok === true;
  }

  /** { tasks: [], status: {running, startedAt, taskCount, enabledTaskCount, uptime} } */
  async schedules() {
    const r = await this.call('schedule.list', {});
    return r ?? { tasks: [], status: null };
  }

  /** { profile, unrestricted, goal } */
  async mode() {
    return this.call('mode.get', {});
  }

  async setProfile(profile) {
    const r = await this.call('mode.setProfile', { profile });
    return r?.ok === true;
  }

  /** { orchestrator: { active, activeAgents } } */
  async orchestrator() {
    const r = await this.call('orchestrator.get', {});
    return r?.orchestrator ?? null;
  }

  async setOrchestrator(enabled) {
    const r = await this.call('orchestrator.setEnabled', { enabled: !!enabled });
    return r?.ok === true;
  }

  async commands() {
    const r = await this.call('command.list', {});
    return r?.commands ?? r ?? [];
  }
}

/* ═══ 会话管理（比 bridge 里的 Sessions 更全）════════════════════════════ */

export class SessionAdminDomain {
  constructor(client) {
    this.call = safe(client, 'sessionAdmin');
  }

  async remove(id) {
    const r = await this.call('session.delete', { id });
    return r?.ok === true;
  }

  async batchRemove(ids) {
    const r = await this.call('session.batchDelete', { sessionIds: ids });
    return r?.ok === true;
  }

  /** ⚠️ 参数是 sessionIds（数组），不是 id */
  async exportSessions(ids) {
    return this.call('session.export', { sessionIds: ids });
  }
}

/* ═══ 装配 ═══════════════════════════════════════════════════════════════ */

/** 一次性把所有域挂到 app 上。语言层拿到 app 就有全套能力。 */
export function attachDomains(app) {
  const c = app.client;
  return Object.assign(app, {
    config: new ConfigDomain(c),
    model: new ModelDomain(c),
    voice: new VoiceDomain(c),
    caps: new CapabilityDomain(c),
    runtime: new RuntimeDomain(c),
    sessionAdmin: new SessionAdminDomain(c),
  });
}
