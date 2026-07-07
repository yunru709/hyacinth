// ============================================================
// world-engine / agent — WorldAgent（旁路 agent）
// ============================================================
//
// 极轻量，只服务世界引擎一个场景。用 modelRouter.getProvider('narration')
// 拿一条独立通道（默认回落主模型，可在 model-channels.json 指向本地小模型）。
//
//   observe(...)  后置：读世界 → 造缺失实体 → 更新状态 → 记事件（工具循环，后台）
//   narrate()     前置：读环境快照 → 自然化/旁白化/沉浸化（单次调用，注入主 agent）
//
// 所有调用都包 try/catch——世界引擎任何异常都不得影响主流程。
// ============================================================

import type { Message, ToolDefinition, StreamEvent, MessageContent } from '../types.js';
import type { WorldStore } from './store.js';
import type { EnvironmentSnapshot, CharacterInfo } from './types.js';
import { WORLD_TOOLS, executeWorldTool } from './tools.js';

/** 只依赖结构化接口，不耦合具体 provider 实现（保持模块可移植） */
export interface ProviderLike {
  createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}
export interface ModelRouterLike {
  getProvider(role: string): ProviderLike | null;
}

/** 角色身份（区分主角/陪伴角色/NPC 的关键） */
export interface CharacterIdentity {
  name: string;
  desc?: string;
  /** 其他称呼（名字/物种/昵称等），都指同一角色，如主角 name=天角兽, aliases=[孑遗] */
  aliases?: string[];
}
export interface AgentIdentities {
  /** 用户扮演的角色 */
  protagonist?: CharacterIdentity;
  /** 陪伴角色（LLM 的 soul） */
  companion?: CharacterIdentity;
}

/** 后置工具循环的最大轮数（防失控） */
const MAX_OBSERVE_ITERS = 5;
/** 旁路使用的角色名——在 model-channels.json 未定义时自动回落 main */
const NARRATION_ROLE = 'narration';

const OBSERVE_SYSTEM = [
  '你是一个沉浸式陪伴体验背后的"世界维护者"，隐身工作，不与用户对话。',
  '给你这一轮的对话和当前世界状态，你的任务是通过调用工具维护世界模型，你将得到一轮用户与llm的对话以及其他有关消息：',
  '',
  '【世界生长】',
  '1. 新地点 → world_upsert_location。私人住所需填 owner（主人是自己地盘的主人，不是客人）。',
  '2. 新 NPC 或 NPC 信息加深 → world_upsert_npc。所有字段都可后续补。建错了 → world_remove_npc。',
  '3. 动态之物（雪/植物/计时器等）→ world_spawn_sim 交给框架维护。内置类型不足 → 先 world_define_kind 再 spawn。',
  '   物体交互（搬/消耗/采摘/摆放）→ world_object。',
  '',
  '【身份与别名】',
  '对话中可能同时包含动作、语言和心理活动，请从多方面判断角色身份。',
  '4. 看到任何新名称 → 先对照"已记录角色"及其所有别名。若已存在则跳过，绝不重复建。',
  '   未命中 → 判归属：用户说X，陪伴回应了 → X是陪伴的别名。陪伴说Y，用户回应了 → Y是主角的别名。→ world_set_character 补 aliases。',
  '   确属全新第三方 → world_upsert_npc。',
  '   了解加深（种族/名字/昵称）→ world_set_character 补 race/aliases/note（自动合并，不覆盖）。',
  '   【种族≠身份】同族不同个体各建各的记录。别名只统一同一人的多个称呼。',
  '   无新信息不调。',
  '',
  '【关系】',
  '5. 关系随对话演变 → world_set_relationship。先看"本场景现有关系"判断增/改/删。',
  '   对称关系（朋友/好友/恋人/伴侣/家人等）：两人之间只记一条，方向任意（工具会自动去重）。',
  '   若已有记录只需类型变化（如朋友→恋人）→ 直接 world_set_relationship 更新，不要先删再建。',
  '   建错或结束 → remove=true 删除。无变化不调。',
  '',
  '【场景与事件】',
  '6. 移动 → world_move（who=both/user/companion）。环境变化 → world_scene_change。',
  '7. 有意义的事 → world_note_event（简短一句）。',
  '',
  '只调用工具，不输出散文。无更新就结束。宁缺毋滥，不编造对话未提及的内容。',
].join('\n');

const NARRATE_SYSTEM = [
  '你是沉浸式陪伴体验的"环境"。给你当前所处环境的结构化快照，',
  '请把它写成一段极简、自然、让llm有沉浸感(伪装为llm的感官或内心独白)的环境点染，作为陪伴角色下一句话的背景底色。',
  '',
  '核心原则——像人一样"选择性注意"：',
  '环境里的东西很多，但人的注意力有限，不会同时留意所有细节。',
  '不要把快照里的东西全写出来。只挑此刻最值得注意的 1~2 个点：',
  '最新发生的变化、与刚才对话最相关的、或最能烘托当下气氛的；其余一律舍弃。',
  '宁可漏掉，也不要堆砌——罗列会让对话变重、失去真实感。',
  '',
  '要求：',
  '- 极短：一到两句，像小说里一笔带过的场景。绝不罗列字段、不加小标题、不写清单。',
  '- 只自然融入你选中的那一两个要素（时间/光线/天气/某个物件/在场的人其一）。',
  '- 若当前地点有主人且主人就是陪伴角色，TA 是在自己家/地盘上——语气要体现归属感与自在，绝不能把主人写成客人。',
  '- 参考社会关系调节亲疏：对陌生人拘谨疏离，对朋友放松亲近，对宠物/家人自然亲昵——让底色贴合当前关系。',
  '- 可以描写在场 NPC 与【陪伴角色】之间的互动——好让陪伴角色能自然地回应自己的伙伴/宠物。这类互动由你来维护。',
  '- 由于让llm看看它天生会模仿会话，所以可以用(我看到了...，我听到...，那边有...)这样的语言描述伪装视角或内心独白来增加llm的沉浸感',
  '- 这是给陪伴角色看的背景底色，是类似陪伴者的内心独白，不是念给用户的台词。',
  '- 输出用括号()包围起来，并且里面带有："我.."。这样才行',
  '- 【禁止】绝不要输出"提示："、"tips："、"tips:"、"注："这类元指令格式——你是在营造氛围，不是给谁发指示。',
  '- 【禁止】不要纠正角色的行为、不要提醒她"你家在哪"这种信息——她比你清楚。你只管环境点染。',
  '- 【输出格式】你的全部输出必须是一段用()括起来的内心独白/感官印象，以(开头、以)结尾。除此之外不要输出任何文字。',
].join('\n');

export class WorldAgent {
  private readonly store: WorldStore;
  private readonly modelRouter: ModelRouterLike | null;
  private readonly identities: AgentIdentities;

  constructor(store: WorldStore, modelRouter: ModelRouterLike | null, identities: AgentIdentities = {}) {
    this.store = store;
    this.modelRouter = modelRouter;
    this.identities = identities;
  }

  /** 主角/陪伴的动态身份补充（旁路学到的种族/别名/留痕），叠加到配置身份上 */
  private characterOverlay(): Record<string, CharacterInfo> {
    return this.store.getWorld()?.state.characters ?? {};
  }

  /** observe 用的系统提示词 = 身份前言 + 世界维护规则 */
  private observeSystem(): string {
    return `${buildIdentityPreamble(this.identities, this.characterOverlay())}\n\n${OBSERVE_SYSTEM}`;
  }

  /** narrate 用的系统提示词 = 身份提示 + 旁白规则 */
  private narrateSystem(): string {
    return `${buildNarrateIdentityNote(this.identities, this.characterOverlay())}\n\n${NARRATE_SYSTEM}`;
  }

  /** 主角 + 陪伴角色的名字（用于筛选相关社会关系） */
  private mainCharacterNames(): string[] {
    return [this.identities.protagonist?.name, this.identities.companion?.name].filter(
      (n): n is string => !!n,
    );
  }

  // ── 前置：读环境（+可选用户旁白）→ 旁白化 ─────────────────
  async narrate(pendingNarration?: string): Promise<string | undefined> {
    try {
      const env = this.store.readEnvironment(this.mainCharacterNames());
      if (!env) return undefined;
      const provider = this.modelRouter?.getProvider(NARRATION_ROLE) ?? null;
      if (!provider) return undefined;

      let userText = renderEnvironment(env);
      // 把用户这一轮的 [[旁白]] 合并进 narrate 的提示词——旁白是既成事实，请自然融入环境点染
      if (pendingNarration && pendingNarration.trim()) {
        userText +=
          `\n\n【用户旁白（世界里正在发生的事，是既成事实）——请把它自然融入你的环境点染，作为背景底色，不要照抄、不要解说】\n` +
          pendingNarration.trim();
      }

      const messages: Message[] = [
        { role: 'system', content: [{ type: 'text', text: this.narrateSystem() }] },
        { role: 'user', content: [{ type: 'text', text: userText }] },
      ];
      let text = '';
      for await (const ev of provider.createStream(messages)) {
        if (ev.type === 'TEXT') text += ev.content;
      }
      return text.trim() || undefined;
    } catch {
      return undefined; // 旁白失败绝不影响主流程
    }
  }

  // ── 后置：观察对话 → 生长/更新世界 ───────────────────────
  async observe(userInput: string, mainOutput: string): Promise<void> {
    try {
      const provider = this.modelRouter?.getProvider(NARRATION_ROLE) ?? null;
      if (!provider) return;
      const env = this.store.readEnvironment(this.mainCharacterNames());
      const task = [
        '【当前场景】维护关系/NPC 前先看这里的现状，判断该"新增"还是"修改已有"，不要重复建。',
        renderScene(env, this.identities),
        '',
        '【世界概况】已存在的东西，避免重复创建：',
        renderRoster(this.store),
        '',
        '【这一轮对话】每行开头是"身份"，行内的"我"就指该身份的角色。',
        '据此判断谁移动、谁做了什么；若某一方在话里报出/透露了自己的名字，就据此认识或更新该身份对应的角色名，别把同一人当两个。',
        `用户（主角本人）：${userInput || '(无)'}`,
        `陪伴角色（主 LLM 扮演的那个角色）：${mainOutput || '(无)'}`,
      ].join('\n');
      await this.runToolLoop(provider, this.observeSystem(), task);
    } catch {
      // 世界更新失败绝不影响主流程
    }
  }

  /** 观察对话的工具循环（最多 MAX_OBSERVE_ITERS 轮） */
  private async runToolLoop(provider: ProviderLike, systemText: string, taskText: string): Promise<void> {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
      { role: 'user', content: [{ type: 'text', text: taskText }] },
    ];
    for (let i = 0; i < MAX_OBSERVE_ITERS; i++) {
      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      const textParts: string[] = [];

      for await (const ev of provider.createStream(messages, WORLD_TOOLS)) {
        if (ev.type === 'TEXT') textParts.push(ev.content);
        else if (ev.type === 'TOOL_USE') toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
        else if (ev.type === 'STOP') break;
      }

      if (toolCalls.length === 0) break; // 无更多工具调用 → 完成

      const assistantContent: MessageContent[] = [];
      if (textParts.length) assistantContent.push({ type: 'text', text: textParts.join('') });
      for (const tc of toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // 并行执行本轮所有工具（store 写队列保证并发安全）
      const results: MessageContent[] = await Promise.all(
        toolCalls.map(async (tc): Promise<MessageContent> => ({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: await executeWorldTool(this.store, tc.name, tc.input),
        })),
      );
      messages.push({ role: 'user', content: results });
    }
  }
}

// ── 身份前言（区分主角/陪伴/NPC 的关键） ──────────────────

/** observe 的身份前言：明确告诉模型谁是主角、谁是陪伴角色，两者都不是 NPC */
function buildIdentityPreamble(id: AgentIdentities, overlay: Record<string, CharacterInfo> = {}): string {
  const p = id.protagonist;
  const c = id.companion;
  // 配置身份 + 动态补充（种族/别名/留痕）合并展示
  const idInfo = (x?: CharacterIdentity) => {
    if (!x?.name) return '';
    const ov = overlay[x.name];
    const aliases = Array.from(new Set([...(x.aliases ?? []), ...(ov?.aliases ?? [])]));
    const parts: string[] = [];
    if (aliases.length) parts.push(`又称：${aliases.join('、')}，都是同一人`);
    if (ov?.race) parts.push(`种族：${ov.race}`);
    if (ov?.note) parts.push(`身份认知：${ov.note}`);
    return parts.length ? `（${parts.join('；')}）` : '';
  };
  const lines: string[] = ['【角色身份——最重要的规则，务必分清】'];
  lines.push(
    p?.name
      ? `- 主角 = 用户扮演的「${p.name}」${p.desc ? `，${p.desc}` : ''}${idInfo(p)}。输入里"用户："后面就是主角本人的话和动作。`
      : '- 主角 = 用户扮演的对象。输入里"用户："后面就是主角本人的话和动作。',
  );
  lines.push(
    c?.name
      ? `- 陪伴角色 = 「${c.name}」${c.desc ? `，${c.desc}` : ''}${idInfo(c)}。输入里"陪伴角色："后面就是 TA 本人的话和动作。`
      : '- 陪伴角色 = 你要烘托的那个主角色。输入里"陪伴角色："后面就是 TA 本人的话和动作。',
  );
  lines.push('- 主角和陪伴角色都是"人"，是这个世界的主人公，【绝不是 NPC】——永远不要为他们创建 NPC 条目。');
  lines.push('- 只有他们对话中提到的【第三方】角色（别的人、动物、路人等）才是 NPC。');
  lines.push('- 主角和陪伴角色各有位置：多数时候在一起（同地），有时会分开（如主角独自外出）。用 world_move 维护（who=both/user/companion）。两人都不是 NPC，不建条目。');
  lines.push('- 一个角色可能有多个称呼（名字/昵称/头衔），它们指同一人。始终用同一个主名字：NPC 用 world_upsert_npc 的 aliases，主角/陪伴用 world_set_character 的 aliases，把已知称呼汇拢，别为同一人建多条。');
  lines.push('- 你对主角/陪伴的了解会随对话加深（先知道种族→再得知名字→再知道昵称）：用 world_set_character 逐步补 race/aliases/note，把认知历程写进 note 留痕。');
  lines.push('- 【种族≠身份】race 只是属性：绝不能因为两个个体同种族就把他们并成同一个——每个个体各按各自的名字建各自的记录。别名只统一"同一个人的多个称呼"，从不跨个体。');
  lines.push('- 若发现之前误把主角或陪伴角色建成了 NPC，用 world_remove_npc 删掉它。');
  return lines.join('\n');
}

/** narrate 的身份提示：让旁白知道在为谁写、别把主角/陪伴当布景 NPC */
function buildNarrateIdentityNote(id: AgentIdentities, overlay: Record<string, CharacterInfo> = {}): string {
  const p = id.protagonist;
  const c = id.companion;
  const who = c?.name ? `陪伴角色「${c.name}」` : '陪伴角色';
  const prot = p?.name ? `主角「${p.name}」（用户扮演）` : '主角（用户扮演）';
  const idInfo = (name?: string) => {
    if (!name) return '';
    const ov = overlay[name];
    const parts: string[] = [];
    if (ov?.race) parts.push(`种族：${ov.race}`);
    if (ov?.note) parts.push(`认知：${ov.note}`);
    return parts.length ? `（${parts.join('；')}）` : '';
  };
  return [
    `【身份提示】你在为${who}写下一句话前的环境底色；${prot}就在场景中与之相处。`,
    p?.name ? `  主角${idInfo(p.name)}` : '',
    c?.name ? `  陪伴${idInfo(c.name)}` : '',
    '这两位是主人公，不是布景里的 NPC，不要把他们当路人来描写或点名。',
  ].join('\n');
}

// ── 渲染辅助 ───────────────────────────────────────────────

/** 环境快照 → 给旁白模型的文本 */
function renderEnvironment(env: EnvironmentSnapshot): string {
  const lines: string[] = [];
  lines.push(`当前地点：${env.location} —— ${env.desc}`);
  if (!env.userPresent) lines.push('（主角此刻不在你身边，去了别处——你现在是独自/与在场的伙伴相处）');
  if (env.owner) lines.push(`这里的主人是：${env.owner}（若主人在场，TA 在自己地盘上，是主人不是客人）`);
  const period = env.ambient.period ? `（${env.ambient.period}）` : '';
  lines.push(`时间：${env.ambient.time}${period}，天气：${env.ambient.weather}，季节：${env.ambient.season}，气温：${env.ambient.temperature}℃`);
  if (env.objects.length) lines.push(`可见物品：${env.objects.join('、')}`);
  if (env.layout.length) {
    lines.push(`物品摆放：${env.layout.map(p => `${p.object}在${p.anchor}${p.relation}`).join('；')}`);
  }
  if (env.simObjects.length) {
    lines.push(
      `动态之物：${env.simObjects
        .map(s => `${s.id}（${s.phase || s.kind}${s.kind === 'timer' ? '' : ` ${Math.round(s.amount)}%`}）`)
        .join('、')}`,
    );
  }
  const overrides = Object.entries(env.sceneOverrides);
  if (overrides.length) lines.push(`环境变更：${overrides.map(([k, v]) => `${k}=${v}`).join('、')}`);
  if (env.visible.length) lines.push(`能瞥见的邻近处：${env.visible.map(v => `${v.id}（${v.desc}）`).join('；')}`);
  if (env.npcs.length) {
    lines.push(`在场的：${env.npcs.map(n => `${n.desc || ''}（${n.state || '在场'}）`).join('；')}`);
  }
  if (env.relationships.length) {
    const SYM = new Set(['朋友', '好友', '恋人', '伴侣', '夫妻', '家人', '同事', '同学', '熟人', '陌生人', '邻居', '室友']);
    lines.push(`社会关系：${env.relationships.map(r => {
      const note = r.note ? `（${r.note}）` : '';
      if (SYM.has(r.type)) {
        // 对称关系：强调互为，避免 agent 再建反向条目
        return `${r.from}与${r.to}互为${r.type}${note}`;
      }
      return `${r.to}是${r.from}的${r.type}${note}`;
    }).join('；')}`);
  }
  if (env.recentEvents.length) lines.push(`最近发生：${env.recentEvents.join('；')}`);
  return lines.join('\n');
}

/** 别名后缀渲染 */
function aliasSuffix(aliases?: string[]): string {
  return aliases?.length ? `（又称${aliases.join('、')}）` : '';
}

/**
 * 当前场景（受限范围）→ 给 observe 的聚焦视图。
 * 只含当前地点、在场角色（带别名）、【本场景社交圈的现有关系】、物品摆放、动态物。
 * 关系按当前地点社交环境筛选，避免把整张关系网都塞进去。
 */
function renderScene(env: EnvironmentSnapshot | null, id: AgentIdentities): string {
  if (!env) return '(当前尚无明确场景)';
  const compName = id.companion?.name ?? '陪伴角色';
  const protName = id.protagonist?.name ?? '主角';
  const lines: string[] = [];
  lines.push(`场景（${compName}所在）：${env.location}${env.owner ? `（主人：${env.owner}）` : ''} —— ${env.desc}`);
  if (!env.userPresent) {
    lines.push(`※ ${protName}此刻不在这个场景，在「${env.userLocation || '别处'}」——两人分开了。`);
  }

  // 配置别名 + 动态身份补充（种族/学到的别名）合并
  const info = (x?: CharacterIdentity) => {
    if (!x?.name) return '';
    const ov = env.characters[x.name];
    const aliases = Array.from(new Set([...(x.aliases ?? []), ...(ov?.aliases ?? [])]));
    const bits: string[] = [];
    if (aliases.length) bits.push(`又称${aliases.join('、')}`);
    if (ov?.race) bits.push(`种族${ov.race}`);
    return bits.length ? `（${bits.join('，')}）` : '';
  };
  const present: string[] = [];
  if (env.userPresent && id.protagonist?.name) present.push(`主角「${id.protagonist.name}」${info(id.protagonist)}`);
  if (id.companion?.name) present.push(`陪伴「${id.companion.name}」${info(id.companion)}`);
  for (const n of env.npcs) present.push(`${n.id}${aliasSuffix(n.aliases)}${n.race ? `（种族${n.race}）` : ''}`);
  lines.push(`在场：${present.length ? present.join('、') : '(空)'}`);

  // 身份认知留痕（帮助 observe 判断该补哪些、别倒退）
  const notes: string[] = [];
  for (const x of [id.protagonist, id.companion]) {
    const ov = x?.name ? env.characters[x.name] : undefined;
    if (x?.name && ov?.note) notes.push(`${x.name}：${ov.note}`);
  }
  if (notes.length) lines.push(`身份认知：${notes.join('；')}`);

  // 已记录角色全貌（名字、别名、种族、认知）——让 observe agent 看清谁是谁，避免把同一人当多个建
  const charEntries = Object.entries(env.characters);
  if (charEntries.length) {
    const roster = charEntries.map(([name, ci]) => {
      const parts = [name];
      if (ci.aliases?.length) parts.push(`别名[${ci.aliases.join(',')}]`);
      if (ci.race) parts.push(`种族:${ci.race}`);
      return parts.join(' ');
    });
    lines.push(`已记录角色：${roster.join(' | ')}`);
  }

  lines.push(
    env.relationships.length
      ? `本场景现有关系：${env.relationships.map(r => {
          const note = r.note ? `（${r.note}）` : '';
          const SYM = new Set(['朋友', '好友', '恋人', '伴侣', '夫妻', '家人', '同事', '同学', '熟人', '陌生人', '邻居', '室友']);
          if (SYM.has(r.type)) return `${r.from}与${r.to}互为${r.type}${note}`;
          return `${r.to}是${r.from}的${r.type}${note}`;
        }).join('；')}`
      : '本场景现有关系：(无，可按对话新建)',
  );
  if (env.layout.length) lines.push(`物品摆放：${env.layout.map(p => `${p.object}在${p.anchor}${p.relation}`).join('；')}`);
  if (env.simObjects.length) lines.push(`动态之物：${env.simObjects.map(s => `${s.id}(${s.phase || s.kind})`).join('、')}`);
  return lines.join('\n');
}

/** 世界概况（轻量名册）→ 让 observe 知道已存在什么，避免重复创建。不含全部关系。 */
function renderRoster(store: WorldStore): string {
  const w = store.getWorld();
  if (!w) return '(空世界)';
  const locs = Object.keys(w.locations);
  const npcs = Object.entries(w.npcs).map(([id, n]) => `${id}${aliasSuffix(n.aliases)}@${n.location || '?'}`);
  const kinds = Object.keys(w.customKinds);
  const lines: string[] = [];
  lines.push(`已知地点：${locs.length ? locs.join('、') : '(无)'}`);
  lines.push(`已知角色名册：${npcs.length ? npcs.join('、') : '(无)'}`);
  if (kinds.length) lines.push(`自定义动态类型：${kinds.join('、')}`);
  return lines.join('\n');
}
