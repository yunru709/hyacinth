// ============================================================
// 事件契约层 — 后端 → UI 推送面（跨层中立）
// ============================================================
// 为什么独立成层（P5-6）：
//
// 事件是**业务与 UI 的共享契约**，不属于任何一侧：
//   - 产生者既有协议层（message.text / config.change / permission.request…），
//     也有业务核心（companion.say 由 AgentLoop 产生、companion.voice 由
//     TTS 流程产生）；
//   - 消费者横跨 TUI / WebUI / 未来渠道，UI 协议层只是传输通道之一。
//
// 此前 UI_EVENT 定义在 src/ui-protocol/types.ts，导致 AgentLoop、
// companion/voice、tools/companion-say 三个**业务核心模块**反向依赖
// UI 适配层。当时 types.ts 零依赖，尚无实际危害，但方向是倒置的：
// 一旦协议层未来引入任何依赖（哪怕一个 logger），AgentLoop 就会被拖入
// 协议层的依赖树。
//
// 本层与 src/types.ts 平级，同样保持**零依赖**（纯常量 + 纯类型），
// 任何层都可安全引用。src/types.ts 是纯类型层（249 行无运行时值），
// 故事件常量不塞进去，以免破坏其性质。
//
// 依赖方向（P5-6 之后）：
//        orchestrator/loop.ts ─┐
//        companion/voice.ts   ─┼─▶ src/events.ts ◀─ ui-protocol/*（re-export）
//        tools/companion-say.ts┘        ▲
//        gateway/tui.ts ────────────────┘
// ============================================================

/**
 * 事件类型命名空间（后端 → UI 推送）。
 *
 * 与 UI_METHOD 的区别：method 是「UI 主动请求，等响应」；
 * event 是「后端主动推送，无响应」。同名不同面是允许的
 * （如 message.interrupt 是事件，中断请求走 message.stop）。
 *
 * 事件面无法在运行时枚举（事件按需触发），因此守卫策略是静态的：
 * 每条常量的 domain 前缀必须落在已知域或传输层保留命名空间内
 * （由 ui-protocol/index.test.ts 的「常量同源守卫」断言）。
 */
export const UI_EVENT = {
  // 连接生命周期（UiProtocolServer / UiProtocolSession 内建）
  UI_CONNECTED: 'ui.connected',
  UI_ERROR: 'ui.error',
  // message 域事件（后端 → UI 推送）
  MESSAGE_TEXT: 'message.text',
  /** say 工具交付的结论（与普通 assistant 文本区分渲染：强调色"交付块"） */
  MESSAGE_SAY: 'message.say',
  MESSAGE_THINKING: 'message.thinking',
  MESSAGE_TOOL_USE: 'message.tool_use',
  MESSAGE_TOOL_RESULT: 'message.tool_result',
  MESSAGE_DIFF: 'message.diff',
  MESSAGE_STATUS: 'message.status',
  MESSAGE_ERROR: 'message.error',
  MESSAGE_TURN_START: 'message.turn_start',
  MESSAGE_TURN_INFO: 'message.turn_info',
  /**
   * 迭代级上下文占用推送：每轮 loop 迭代（compose/LLM/工具）结束后广播，
   * 供 UI 即时刷新上下文进度条——不表示回合结束（区别于 MESSAGE_TURN_INFO）。
   */
  MESSAGE_CONTEXT_UPDATE: 'message.context_update',
  MESSAGE_FLUSH: 'message.flush',
  MESSAGE_INTERRUPT: 'message.interrupt',
  MESSAGE_ASK_USER: 'message.ask_user',
  // state 域事件
  STATE_UPDATE: 'state.update',
  // config 域事件
  CONFIG_CHANGE: 'config.change',
  // model 域事件
  MODEL_CHANGE: 'model.change',
  // session 域事件
  SESSION_CHANGE: 'session.change',
  // permission 域事件
  PERMISSION_REQUEST: 'permission.request',
  // companion 域事件（业务核心产生，非协议层产生）
  COMPANION_SAY: 'companion.say',
  COMPANION_VOICE: 'companion.voice',
} as const;

// ── companion 事件载荷 ───────────────────────────────────────
// 陪伴模式表达契约：主 agent 的普通文本只是内心独白，只有通过
// companion_say 工具"发声"才会上屏/朗读。companion.say 承载台词
// 文字，companion.voice 承载对应语音（TTS 异步合成，靠 sayId 与
// 文字关联；前端比对 sayId 丢弃过期语音）。
//
// 载荷与事件名同住：事件契约 = 名字 + 载荷，分开任一侧都会迫使
// 产生者回头依赖另一层。

/** companion.say 事件载荷（台词上屏；text 已是 [动作]（心声）台词 渲染结果） */
export interface CompanionSayEvent {
  /** 渲染后的台词全文：[动作]（心声）内容（各段可选） */
  text: string;
  /** 语气（透传展示，TTS 情感扩展） */
  tone?: string;
  /** 表达发生时间（ISO） */
  at?: string;
  /** 表达唯一标识：与 companion.voice 事件关联（前端时序守卫用） */
  sayId?: string;
  /** 兜底标记：模型未按契约调用工具时，由 loop 把普通文本包装成表达 */
  mode?: 'speak';
}

/** companion.voice 事件载荷（语音就绪/失败；state=ready 时 url 可播放） */
export interface CompanionVoiceEvent {
  /** ready=可播放 / error=合成失败 */
  state: 'ready' | 'error';
  /** 播放地址（/api/companion/voice/:id/file；error 时为空） */
  url?: string;
  /** 表达唯一标识：与 companion.say 事件关联（前端比对丢弃过期语音） */
  sayId?: string;
  /** 生成语音条目 ID（缓存命中时回传，便于前端追踪复用来源） */
  voiceId?: string;
  /** 当前角色名 */
  character?: string;
  /** TTS 供应商 */
  provider?: string;
  /** 语气（原样带回） */
  tone?: string;
  /** 缓存命中（命中生成语音库，未重新合成） */
  cached?: boolean;
  /** 台词预览（前 60 字） */
  textPreview?: string;
  /** error 时的失败信息 */
  message?: string;
}
