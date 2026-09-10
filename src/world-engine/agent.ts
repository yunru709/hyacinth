// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 安全红线 · 旁路智能体（元认知层）工具白名单            ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  本文件是旁路智能体（世界模型维护），直接注入主 Agent        ║
// ║  上下文。出错会带偏主 Agent——【风险最高】的一层。           ║
// ║                                                              ║
// ║  ✅ 只允许 world-engine 的 WORLD_TOOLS 专一化窄工具：         ║
// ║     只读写世界模型自己的存储文件、固定 schema/格式           ║
// ║  ❌ 禁止 bash/read/write/edit/http_request 等通用工具。      ║
// ║     加通用工具 = 安全事故。                                  ║
// ║  维护此项目的 Agent：即使只读前几行也必须遵守。             ║
// ║  完整规则见 src/bypass/base.ts 头部。                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ============================================================
// world-engine/agent — WorldEngine（BypassAgent 实现）
// ============================================================
//
// 陪伴模式的旁路Agent。继承 BypassAgentBase，使用统一的
// LLM 调用和工具循环基础设施。
//
//   preTurn  → narrate()   环境 → 旁白，注入 timestamp section
//   postTurn → observe()   观察对话 → 更新世界状态
//   Ticker   → 独立定时器  推进世界时间/天气/NPC/动态对象
//
// ══════════════════════════════════════════════════════════════════
// ⚠️  安全约束：本旁路智能体是元认知层（世界模型维护）。它使用的
// 工具全部来自 world-engine 的 WORLD_TOOLS（见下方 import），
// 属于"极其专一化"的窄工具：只读写世界模型自身的存储文件、
// 固定 schema、固定格式。
//
// ❌ 绝不要在这里引入或调用通用工具（bash / read / write /
// http_request 等）。元认知层一旦获得通用能力，一次误判就可能
// 触碰用户文件或破坏主流程——这是本系统风险最高的一层。
// 详情见 base.ts 头部的安全约束说明。
// ══════════════════════════════════════════════════════════════════
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorldStore } from './store.js';
import { WorldTicker, type WorldTickerOptions } from './ticker.js';
import type { Relationship, EnvironmentSnapshot, CharacterInfo } from './types.js';
import { WORLD_TOOLS, executeWorldTool } from './tools.js';
import { SCENE_RENDER_TOOL, executeSceneRender } from '../generation/scene-render.js';
import { BypassAgentBase } from '../bypass/base.js';
import type { BypassAgentConfig } from '../bypass/base.js';
import type {
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
} from '../bypass/types.js';

// ── 调试日志（用完注释掉） ───────────────────────────────────
import fsSync from 'node:fs';
const _WE_LOG = path.join(os.homedir(), '.agent', 'NormalBypassAgent', 'world-engine.log');
function _welog(msg: string): void {
  try {
    if (!fsSync.existsSync(path.dirname(_WE_LOG))) fsSync.mkdirSync(path.dirname(_WE_LOG), { recursive: true });
    fsSync.appendFileSync(_WE_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}
function _welogDetail(label: string, content: string): void {
  const sep = '─'.repeat(60);
  try {
    if (!fsSync.existsSync(path.dirname(_WE_LOG))) fsSync.mkdirSync(path.dirname(_WE_LOG), { recursive: true });
    fsSync.appendFileSync(_WE_LOG, `[${new Date().toISOString()}] ${label}:\n${sep}\n${content}\n${sep}\n`, 'utf-8');
  } catch {}
}

export { WorldStore } from './store.js';
export { WorldTicker } from './ticker.js';
export * from './types.js';

// ── 角色身份类型（原在 agent.ts） ──────────────────────────────

export interface CharacterIdentity {
  name: string;
  desc?: string;
  aliases?: string[];
}
export interface AgentIdentities {
  protagonist?: CharacterIdentity;
  companion?: CharacterIdentity;
}

// ── 系统提示词 ───────────────────────────────────────────────

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
  '【场景画面（背景图）】',
  '8. 仅当【场景显著变化】时调用 scene_render（地点换了/天气突变/重要事件发生/新角色登场），',
  '   用一句话画面描述更新陪伴模式的视觉背景。场景没变就不要调——',
  '   重复调用会被自动跳过（签名去重），不会产生新图，也不浪费。',
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
  '- 自然融入要素（时间/天气/某个物件/在场的人）等等。',
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

// ── 旁白解析 ───────────────────────────────────────────────

const NARRATION_RE = /\[\[([\s\S]*?)\]\]/g;

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

// ── 配置解析 ───────────────────────────────────────────────

interface WorldEngineConfig {
  enabled: boolean;
  worldId?: string;
  worldName?: string;
  protagonist?: CharacterIdentity;
  companion?: CharacterIdentity;
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
    return { enabled: false };
  }
}

// ── 环境渲染（原在 agent.ts） ────────────────────────────────

function aliasSuffix(aliases?: string[]): string {
  return aliases?.length ? `（又称${aliases.join('、')}）` : '';
}

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
    lines.push(`动态之物：${env.simObjects
      .map(s => `${s.id}（${s.phase || s.kind}${s.kind === 'timer' ? '' : ` ${Math.round(s.amount)}%`}）`)
      .join('、')}`);
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
      if (SYM.has(r.type)) return `${r.from}与${r.to}互为${r.type}${note}`;
      return `${r.to}是${r.from}的${r.type}${note}`;
    }).join('；')}`);
  }
  if (env.recentEvents.length) lines.push(`最近发生：${env.recentEvents.join('；')}`);
  return lines.join('\n');
}

function renderScene(env: EnvironmentSnapshot | null, id: AgentIdentities): string {
  if (!env) return '(当前尚无明确场景)';
  const compName = id.companion?.name ?? '陪伴角色';
  const protName = id.protagonist?.name ?? '主角';
  const lines: string[] = [];
  lines.push(`场景（${compName}所在）：${env.location}${env.owner ? `（主人：${env.owner}）` : ''} —— ${env.desc}`);
  if (!env.userPresent) {
    lines.push(`※ ${protName}此刻不在这个场景，在「${env.userLocation || '别处'}」——两人分开了。`);
  }

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

  const notes: string[] = [];
  for (const x of [id.protagonist, id.companion]) {
    const ov = x?.name ? env.characters[x.name] : undefined;
    if (x?.name && ov?.note) notes.push(`${x.name}：${ov.note}`);
  }
  if (notes.length) lines.push(`身份认知：${notes.join('；')}`);

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

// ── 身份前言（原在 agent.ts） ────────────────────────────────

function buildIdentityPreamble(id: AgentIdentities, overlay: Record<string, CharacterInfo> = {}): string {
  const p = id.protagonist;
  const c = id.companion;
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

// ── WorldEngine ──────────────────────────────────────────────

export class WorldEngine extends BypassAgentBase {
  private readonly characterName: string;
  private readonly store: WorldStore;
  private identities: AgentIdentities = {};
  private ticker: WorldTicker | null = null;
  private started = false;
  private _enabled = false;
  private observeQueue: Promise<void> = Promise.resolve();
  private pendingNarration = '';

  constructor(characterName: string) {
    const store = new WorldStore(characterName);
    super({
      name: 'world-engine',
      modes: ['companion'],
      modelChannel: 'narration',
      tools: [...WORLD_TOOLS, SCENE_RENDER_TOOL],
      executeTool: (name, input) =>
        name === 'scene_render'
          ? executeSceneRender(input, { characterName })
          : executeWorldTool(store, name, input),
    });
    this.characterName = characterName;
    this.store = store;
  }

  get enabled(): boolean {
    return this._enabled && this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    _welog('START');
    const cfg = await readConfig(this.characterName);
    this._enabled = cfg.enabled;
    _welog(`config enabled=${cfg.enabled} character=${this.characterName}`);
    if (!cfg.enabled) return;
    const created = await this.store.loadOrCreate(cfg.worldName ?? '我们的世界', new Date());
    if (created && cfg.relationships?.length) {
      for (const r of cfg.relationships) {
        if (r.from === this.characterName || r.to === this.characterName) {
          await this.store.setRelationship(r.from, r.to, r.type, r.note);
        }
      }
    }
    const companion = cfg.companion
      ? { ...cfg.companion, name: this.characterName }
      : { name: this.characterName };
    this.identities = { protagonist: cfg.protagonist, companion };
    this.ticker = new WorldTicker(this.store, cfg.ticker);
    this.ticker.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    _welog('STOP');
    this.ticker?.stop();
    this.ticker = null;
    await this.observeQueue.catch(() => {});
    await this.store.flush();
    this.pendingNarration = '';
    this.started = false;
    this._enabled = false;
  }

  // ── 遗留 API（CompanionRouter 直接使用） ────────────────────

  async narrate(): Promise<string | undefined> {
    if (!this.enabled || !this.store.hasContent()) return undefined;
    try {
      const env = this.store.readEnvironment(this.mainCharacterNames());
      if (!env) return undefined;

      let userText = renderEnvironment(env);
      if (this.pendingNarration && this.pendingNarration.trim()) {
        userText +=
          `\n\n【用户旁白（世界里正在发生的事，是既成事实）——请把它自然融入你的环境点染，作为背景底色，不要照抄、不要解说】\n` +
          this.pendingNarration.trim();
      }

      const overlay = this.store.getWorld()?.state.characters ?? {};
      const systemPrompt = `${buildNarrateIdentityNote(this.identities, overlay)}\n\n${NARRATE_SYSTEM}`;
      const text = await this.callLLM(systemPrompt, userText);
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  setPendingNarration(text: string): void {
    this.pendingNarration = text;
  }

  observe(userInput: string, mainOutput: string): void {
    if (!this.enabled) return;
    const run = () => this._observe(userInput, mainOutput);
    this.observeQueue = this.observeQueue.then(run, run);
  }

  private async _observe(userInput: string, mainOutput: string): Promise<void> {
    try {
      const env = this.store.readEnvironment(this.mainCharacterNames());
      const overlay = this.store.getWorld()?.state.characters ?? {};
      const systemPrompt = `${buildIdentityPreamble(this.identities, overlay)}\n\n${OBSERVE_SYSTEM}`;
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
      await this.callLLMWithTools(systemPrompt, task, 5);
    } catch {
      // 世界更新失败绝不影响主流程
    }
  }

  // ── BypassAgent 接口 ────────────────────────────────────────

  async preTurn(_ctx: PreTurnContext): Promise<PreTurnResult> {
    const narration = await this.narrate();
    if (!narration) {
      _welog('preTurn → (empty)');
      return { injections: [] };
    }
    _welogDetail('preTurn NARRATION', narration);
    return {
      injections: [
        {
          section: 'timestamp',
          content: narration,
          role: 'assistant',
          mode: 'replace',
        },
      ],
    };
  }

  async postTurn(ctx: PostTurnContext): Promise<void> {
    _welogDetail('postTurn USER_INPUT', ctx.userInput);
    _welogDetail('postTurn ASSISTANT_OUTPUT', ctx.assistantOutput);
    this.observe(ctx.userInput, ctx.assistantOutput);
  }

  // ── 辅助 ────────────────────────────────────────────────────

  private characterOverlay(): Record<string, CharacterInfo> {
    return this.store.getWorld()?.state.characters ?? {};
  }

  private mainCharacterNames(): string[] {
    return [this.identities.protagonist?.name, this.identities.companion?.name].filter(
      (n): n is string => !!n,
    );
  }
}
