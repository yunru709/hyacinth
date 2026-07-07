// ============================================================
// world-engine / store — WorldStore
// ============================================================
//
// world.json 的读写层。纯数据，零 LLM，可独立测试。
//
// 并发模型：读并发、写串行。
//   - 读（readEnvironment / getWorld）直接返回内存快照，永不阻塞。
//   - 写（所有 mutate 方法）先改内存，再进队列顺序持久化。
//   - 持久化用"写临时文件 + rename"，保证磁盘上永远是完整文件。
//
// 目录布局（v0.9.6+：以角色名组织，一个角色一个世界）：
//   .agent/companion/<name>/world.json     世界状态
//   .agent/companion/<name>/saves/*.json   存档快照
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  World,
  WorldLocation,
  WorldNpc,
  SimObject,
  KindSpec,
  EnvironmentSnapshot,
  CharacterInfo,
} from './types.js';
import { createEmptyWorld } from './types.js';
import { initSim } from './sim.js';

/** 最近事件保留条数（防 world.json 无限膨胀） */
const MAX_EVENTS = 30;
/** readEnvironment 返回的最近事件条数 */
const ENV_EVENT_LIMIT = 5;

/** 清掉某地点里与某物品相关的布局边（作为主体或参照物） */
function clearLayoutFor(loc: WorldLocation, object: string): void {
  if (!loc.layout) return;
  loc.layout = loc.layout.filter(p => p.object !== object && p.anchor !== object);
}

export class WorldStore {
  private readonly worldsDir: string;
  private readonly characterName: string;
  /** 内存中的当前世界快照（读的唯一来源） */
  private world: World | null = null;
  /** 写队列：保证持久化顺序执行 */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * @param characterName 陪伴角色名（如"柔柔"）——一个角色 = 一个世界。
   *   world.json 落在 ~/.agent/companion/<name>/world.json
   */
  constructor(characterName: string) {
    if (!characterName || characterName === 'default') {
      throw new Error(`WorldStore: 拒绝保留名 "${characterName}"，请使用正确的角色名`);
    }
    this.worldsDir = path.join(os.homedir(), '.agent', 'companion');
    this.characterName = characterName;
  }

  // ── 路径（一个角色 = 一个世界，角色名即 worldId）──────
  private worldDir(id: string): string {
    return path.join(this.worldsDir, id);
  }
  private worldFilePath(id: string): string {
    return path.join(this.worldDir(id), 'world.json');
  }

  // ── 加载 / 引导 ──────────────────────────────────────────
  /**
   * 加载活动世界到内存。若不存在则创建一个空世界并设为活动。
   * @returns 当前内存中的世界
   */
  /** @returns true 表示本次是新建的空世界（供调用方决定是否注入预设） */
  async loadOrCreate(defaultName: string, now: Date): Promise<boolean> {
    const loaded = await this.readWorldFile(this.characterName);
    if (loaded) {
      // 修复旧数据：meta.id 可能与角色目录名不一致（如旧 bug 导致 id="default"）
      if (loaded.meta.id !== this.characterName) {
        loaded.meta.id = this.characterName;
      }
      this.world = loaded;
      return false;
    }
    this.world = createEmptyWorld(this.characterName, defaultName, now);
    await fs.mkdir(this.worldDir(this.characterName), { recursive: true });
    await this.persist();
    return true;
  }

  private async readWorldFile(id: string): Promise<World | null> {
    try {
      const raw = await fs.readFile(this.worldFilePath(id), 'utf-8');
      const w = JSON.parse(raw) as World;
      if (!Array.isArray(w.relationships)) w.relationships = []; // 兼容旧文件
      if (!w.simObjects || typeof w.simObjects !== 'object') w.simObjects = {};
      if (!w.customKinds || typeof w.customKinds !== 'object') w.customKinds = {};
      // 双地点迁移：旧文件只有 location（用户/场景），陪伴角色默认与其同地
      if (typeof w.state.companionLocation !== 'string') w.state.companionLocation = w.state.location ?? '';
      // 身份补充迁移：旧文件无 characters overlay
      if (!w.state.characters || typeof w.state.characters !== 'object') w.state.characters = {};
      return w;
    } catch {
      return null;
    }
  }

  /** 列出所有世界 id */
  async listWorlds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.worldsDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  // ── 读（并发安全，返回内存快照） ─────────────────────────
  getWorld(): World | null {
    return this.world;
  }

  /** 场景地点 = 陪伴角色所在地（narrate 服务于她）；未设则回落用户地点 */
  private sceneLocation(w: World): string {
    return w.state.companionLocation || w.state.location;
  }

  /** 世界是否已"长出"可注入的内容（有场景地点且该地点存在） */
  hasContent(): boolean {
    const w = this.world;
    if (!w) return false;
    const scene = this.sceneLocation(w);
    return !!(scene && w.locations[scene]);
  }

  /**
   * 组装当前地点的环境快照。
   * 临近可见地点只带一层摘要（desc），绝不展开其 visible——防无限递归。
   * @param mainCharacters 始终视为"在场"的角色名（主角/陪伴），用于筛选相关社会关系。
   */
  readEnvironment(mainCharacters: string[] = []): EnvironmentSnapshot | null {
    const w = this.world;
    if (!w) return null;
    const scene = this.sceneLocation(w); // 陪伴角色所在地
    if (!scene) return null;
    const loc = w.locations[scene];
    if (!loc) return null;

    // depth-1：仅取邻近可见地点的 desc 摘要，不再读它们的 visible
    const visible = loc.visible
      .filter(id => w.locations[id])
      .map(id => ({ id, desc: w.locations[id].desc }));

    const npcsHere = this.npcsAt(scene);
    // 场景内角色 = 主角/陪伴（始终在场）+ 当前地点的 NPC
    const inScene = new Set<string>([...mainCharacters, ...npcsHere.map(n => n.id)]);
    // 只取"双方都在当前场景"的关系——这才是当前地点的社交圈，也避免关系网变大后的性能开销
    const relationships = w.relationships.filter(r => inScene.has(r.from) && inScene.has(r.to));
    // 在场角色的身份补充（种族/别名/留痕），供旁白按规范名叠加渲染
    const characters: Record<string, CharacterInfo> = {};
    for (const name of inScene) {
      if (w.state.characters[name]) characters[name] = w.state.characters[name];
    }

    return {
      location: scene,
      userLocation: w.state.location,
      userPresent: w.state.location === scene,
      desc: loc.desc,
      owner: loc.owner,
      objects: loc.objects,
      layout: loc.layout ?? [],
      sceneOverrides: w.state.sceneOverrides,
      ambient: w.ambient,
      visible,
      npcs: npcsHere,
      relationships,
      characters,
      simObjects: Object.values(w.simObjects).filter(s => s.location === scene),
      recentEvents: w.state.recentEvents.slice(-ENV_EVENT_LIMIT),
    };
  }

  /**
   * 当前在某地点的 NPC，带主标识 id。
   * 【未来·用户↔NPC 交互】曾有"pin 优先于日常 location"的逻辑（剧情把 NPC 钉在某地），
   * 因触发者已移除而清理；将来重做 NPC 交互时可在此恢复 pin 优先判断。
   */
  npcsAt(locationId: string): Array<WorldNpc & { id: string }> {
    const w = this.world;
    if (!w) return [];
    return Object.entries(w.npcs)
      .filter(([, npc]) => npc.location === locationId)
      .map(([id, npc]) => ({ id, ...npc }));
  }

  // ── 写（先改内存，再串行持久化） ─────────────────────────

  /** WorldTicker：更新环境 */
  setAmbient(patch: Partial<World['ambient']>): Promise<void> {
    return this.mutate(w => {
      w.ambient = { ...w.ambient, ...patch };
    });
  }

  /** WorldTicker：放置 NPC 到某地点（跳过被 pin 的调用方自行判断） */
  placeNpc(npcId: string, location: string): Promise<void> {
    return this.mutate(w => {
      const npc = w.npcs[npcId];
      if (npc) npc.location = location;
    });
  }

  /** WorldAgent：创建/更新地点（对话中"长出来"） */
  upsertLocation(id: string, patch: Partial<WorldLocation>): Promise<void> {
    return this.mutate(w => {
      const prev = w.locations[id] ?? { desc: '', objects: [], visible: [], connects: [] };
      w.locations[id] = {
        desc: patch.desc ?? prev.desc,
        objects: patch.objects ?? prev.objects,
        visible: patch.visible ?? prev.visible,
        connects: patch.connects ?? prev.connects,
        owner: patch.owner ?? prev.owner,
      };
    });
  }

  /** WorldAgent：创建 NPC，或后续丰富其信息（世界从对话中逐渐长细节） */
  upsertNpc(id: string, patch: Partial<WorldNpc>): Promise<void> {
    return this.mutate(w => {
      const prev = w.npcs[id];
      if (!prev) {
        w.npcs[id] = {
          desc: patch.desc ?? '',
          aliases: patch.aliases ?? [],
          race: patch.race,
          note: patch.note,
          persona: patch.persona ?? '',
          home: patch.home ?? (patch.location ? [patch.location] : []),
          roaming: patch.roaming ?? 0.1,
          mobility: patch.mobility ?? 'anchored',
          location: patch.location ?? (patch.home?.[0] ?? ''),
          state: patch.state ?? '',
        };
      } else {
        // 更新：所有字段都可后续丰富（了解越多、写得越细），只按传入的字段更新
        if (patch.location !== undefined) prev.location = patch.location;
        if (patch.state !== undefined) prev.state = patch.state;
        if (patch.desc !== undefined) prev.desc = patch.desc;
        if (patch.persona !== undefined) prev.persona = patch.persona;
        if (patch.race !== undefined) prev.race = patch.race;       // 种族：属性，非身份
        if (patch.note !== undefined) prev.note = patch.note;       // 认知留痕
        if (patch.home !== undefined) prev.home = patch.home;
        if (patch.roaming !== undefined) prev.roaming = patch.roaming;
        if (patch.mobility !== undefined) prev.mobility = patch.mobility;
        if (patch.aliases?.length) {
          prev.aliases = Array.from(new Set([...(prev.aliases ?? []), ...patch.aliases]));
        }
      }
    });
  }

  /** WorldAgent：声明一个自定义动态类型（框架据此演化该类对象） */
  defineKind(spec: KindSpec): Promise<void> {
    return this.mutate(w => {
      w.customKinds[spec.kind] = spec;
    });
  }

  /** WorldAgent：生成一个框架维护的动态对象（雪/植物/计时器等） */
  spawnSimObject(
    id: string,
    kind: string,
    location: string,
    desc?: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    return this.mutate(w => {
      // 不预设 amount，交给 initSim 按 kind（内置或自定义）设默认
      const sim = { id, kind, location, desc, params } as SimObject;
      initSim(sim, w.customKinds);
      w.simObjects[id] = sim;
    });
  }

  /** WorldAgent：移除动态对象 */
  removeSimObject(id: string): Promise<void> {
    return this.mutate(w => {
      delete w.simObjects[id];
    });
  }

  /** WorldAgent：设置物品的相对位置（object 在 anchor 的 relation 处），记在主角当前地点 */
  placeObject(object: string, relation: string, anchor: string): Promise<void> {
    return this.mutate(w => {
      const loc = w.locations[this.sceneLocation(w)];
      if (!loc) return;
      // 确保物品与参照物都在场
      for (const name of [object, anchor]) {
        if (name && !loc.objects.includes(name)) loc.objects.push(name);
      }
      if (!loc.layout) loc.layout = [];
      const existing = loc.layout.find(p => p.object === object);
      if (existing) {
        existing.relation = relation;
        existing.anchor = anchor;
      } else {
        loc.layout.push({ object, relation, anchor });
      }
    });
  }

  /**
   * WorldAgent：把物体搬到另一个地点（静物或动态对象都适用）。
   * 静物：从原地点的 objects 移除、加到目标地点；动态对象：改其 location。
   * 搬动会清掉该物品在原地的相对位置（它不再在原来的柜子上了）。
   */
  moveObject(object: string, to: string): Promise<void> {
    return this.mutate(w => {
      const sim = w.simObjects[object];
      if (sim) {
        sim.location = to;
        return;
      }
      for (const loc of Object.values(w.locations)) {
        const i = loc.objects.indexOf(object);
        if (i >= 0) loc.objects.splice(i, 1);
        clearLayoutFor(loc, object);
      }
      const target = w.locations[to];
      if (target && !target.objects.includes(object)) target.objects.push(object);
    });
  }

  /** WorldAgent：物体被消耗/用掉/毁坏而消失（静物或动态对象） */
  removeObject(object: string): Promise<void> {
    return this.mutate(w => {
      if (w.simObjects[object]) {
        delete w.simObjects[object];
        return;
      }
      for (const loc of Object.values(w.locations)) {
        const i = loc.objects.indexOf(object);
        if (i >= 0) loc.objects.splice(i, 1);
        clearLayoutFor(loc, object);
      }
    });
  }

  /**
   * WorldAgent：采摘植物类动态对象。
   * 多茬生 → 成熟度归零重新生长；一茬生 → 直接消失。
   */
  harvestSim(id: string): Promise<void> {
    return this.mutate(w => {
      const s = w.simObjects[id];
      if (!s) return;
      const multi = (s.params as any)?.multiHarvest === true;
      if (multi) {
        s.amount = 0;
        s.phase = '已采摘';
      } else {
        delete w.simObjects[id];
      }
    });
  }

  /** Ticker 演化时用（在 batch 内直接改 world.simObjects，此处无需单独方法） */

  // 对称关系类型：两人互为同一种关系，全自动去重
  private static readonly SYMMETRIC = new Set([
    '朋友', '好友', '恋人', '伴侣', '夫妻', '家人',
    '同事', '同学', '熟人', '陌生人', '邻居', '室友',
  ]);

  /** WorldAgent：创建/更新一条社会关系。对称关系全自动归一化——若同对已存在任一方向的条目则原地更新，保证一对人永远只保留一条。 */
  setRelationship(from: string, to: string, type: string, note?: string): Promise<void> {
    return this.mutate(w => {
      if (from === to) return; // 自指跳过
      if (WorldStore.SYMMETRIC.has(type)) {
        // 对称关系：检查两个方向，找到就原地更新（不关心 from/to 顺序）
        const existing = w.relationships.find(
          r => (r.from === from && r.to === to) || (r.from === to && r.to === from)
        );
        if (existing) {
          existing.type = type;
          if (note !== undefined) existing.note = note;
        } else {
          w.relationships.push({ from, to, type, note });
        }
      } else {
        // 有向关系：按精确方向匹配
        const existing = w.relationships.find(r => r.from === from && r.to === to);
        if (existing) {
          existing.type = type;
          if (note !== undefined) existing.note = note;
        } else {
          w.relationships.push({ from, to, type, note });
        }
      }
    });
  }

  /** WorldAgent：删除误建的重复角色条目（如把同一人的别名当成了独立角色）。 */
  removeCharacter(name: string): Promise<void> {
    return this.mutate(w => {
      delete w.state.characters[name];
    });
  }

  /** WorldAgent：创建/更新主角或陪伴角色的动态身份信息（种族/别名/留痕）。
   *   以规范名（如 天角兽）为键；只增补、不覆盖已有配置——旁路补学到的种族/别名/来由。 */
  setCharacter(name: string, info: CharacterInfo): Promise<void> {
    return this.mutate(w => {
      if (!w.state.characters[name]) w.state.characters[name] = {};
      const c = w.state.characters[name];
      if (info.race !== undefined) c.race = info.race;
      if (info.note !== undefined) c.note = info.note;
      if (info.aliases?.length) {
        c.aliases = Array.from(new Set([...(c.aliases ?? []), ...info.aliases]));
      }
    });
  }

  /** WorldAgent：删除一条社会关系（建错的、或已结束的） */
  removeRelationship(from: string, to: string): Promise<void> {
    return this.mutate(w => {
      w.relationships = w.relationships.filter(r => !(r.from === from && r.to === to));
    });
  }

  /** WorldAgent：删除误建的 NPC（如把主角/陪伴角色错建成了 NPC） */
  removeNpc(id: string): Promise<void> {
    return this.mutate(w => {
      delete w.npcs[id];
    });
  }

  /** WorldAgent：移动用户/主角当前地点（用户单独行动时） */
  moveUser(location: string): Promise<void> {
    return this.mutate(w => {
      w.state.location = location;
    });
  }

  /** WorldAgent：移动陪伴角色当前地点（她单独行动时；narrate 的场景以此为准） */
  moveCompanion(location: string): Promise<void> {
    return this.mutate(w => {
      w.state.companionLocation = location;
    });
  }

  /** WorldAgent：两人一起移动（最常见）——同时更新用户与陪伴角色地点 */
  moveBoth(location: string): Promise<void> {
    return this.mutate(w => {
      w.state.location = location;
      w.state.companionLocation = location;
    });
  }

  /** WorldAgent：设置/清除对环境的临时变更 */
  setSceneOverride(key: string, value: string | null): Promise<void> {
    return this.mutate(w => {
      if (value === null) delete w.state.sceneOverrides[key];
      else w.state.sceneOverrides[key] = value;
    });
  }

  /** WorldAgent：追加事件（自动截断） */
  addEvent(event: string): Promise<void> {
    return this.mutate(w => {
      w.state.recentEvents.push(event);
      if (w.state.recentEvents.length > MAX_EVENTS) {
        w.state.recentEvents = w.state.recentEvents.slice(-MAX_EVENTS);
      }
    });
  }

  // 【未来·用户↔NPC 交互】此处曾有 pinNpc/unpinNpc（剧情钉住 NPC）、setPendingNpcResponse（待注入 NPC 回应），
  // 因隔离 NPC 交互后无触发者，已作为死代码清理。重做 NPC 交互时在此重新添加相应写方法。

  // ── 存档 ────────────────────────────────────────────────
  async save(label: string): Promise<string> {
    const w = this.world;
    if (!w) throw new Error('No active world to save.');
    const savesDir = path.join(this.worldDir(w.meta.id), 'saves');
    await fs.mkdir(savesDir, { recursive: true });
    const file = path.join(savesDir, `${label}.json`);
    await this.atomicWrite(file, JSON.stringify(w, null, 2));
    return file;
  }

  /**
   * 批量修改：多处变更合并为一次持久化（供 WorldTicker 每次心跳使用）。
   * 注意：绕过按方法的所有权约束，仅供受信任的内部模块调用。
   */
  batch(fn: (w: World) => void): Promise<void> {
    return this.mutate(fn);
  }

  // ── 内部：mutate + 持久化 ────────────────────────────────
  private mutate(fn: (w: World) => void): Promise<void> {
    if (!this.world) return Promise.resolve();
    fn(this.world);
    return this.persist();
  }

  /** 串行持久化当前内存世界 */
  private persist(): Promise<void> {
    const run = async () => {
      const w = this.world;
      if (!w) return;
      // 用 characterName（而非 w.meta.id）保证路径始终正确——meta.id 可能因旧数据迁移不一致
      const file = this.worldFilePath(this.characterName);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await this.atomicWrite(file, JSON.stringify(w, null, 2));
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  /** 写临时文件再 rename，保证磁盘上永远是完整文件 */
  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, file);
  }

  /** 等待所有挂起的写完成（stop 时调用，确保落盘） */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
