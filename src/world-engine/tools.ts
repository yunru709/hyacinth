// ============================================================
// world-engine / tools — 模块内工具
// ============================================================
//
// 后置 WorldAgent 用来"生长世界"的定制工具。按 world.json 格式定制，
// 直连 WorldStore。不进全局 tool.registry，不被主 agent 看见。
// ============================================================

import type { ToolDefinition } from '../types.js';
import type { WorldStore } from './store.js';

export const WORLD_TOOLS: ToolDefinition[] = [
  {
    name: 'world_upsert_location',
    description:
      '创建或更新一个地点。对话中提到但世界里还没有的地点，用它"造"出来。visible=能看见的邻近地点，connects=能走过去的地点。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '地点名（唯一标识，如"森林""木屋"）' },
        desc: { type: 'string', description: '地点描述' },
        objects: { type: 'array', items: { type: 'string' }, description: '地点内的物品' },
        visible: { type: 'array', items: { type: 'string' }, description: '能看见的邻近地点 id' },
        connects: { type: 'array', items: { type: 'string' }, description: '能走过去的地点 id' },
        owner: { type: 'string', description: '地点主人（角色名，如"柔柔"）。私人住所要填；公共场所留空。主人在自己地盘是主人不是客人' },
      },
      required: ['id', 'desc'],
    },
  },
  {
    name: 'world_upsert_npc',
    description:
      '创建或更新一个 NPC。世界从对话中逐渐长细节：所有字段都可以【后续丰富】——第一次也许只知道"一个店员"，后来了解到名字/性格/住处，再调用它补上即可（只传你要更新的字段）。home=常驻地点，roaming=0~1 离开常驻地点的概率，mobility=anchored(基本不动)/free(会逛)。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'NPC 主标识（选一个固定名字，之后都用它）' },
        aliases: { type: 'array', items: { type: 'string' }, description: '该 NPC 的其他称呼（昵称/头衔/全名等，如徐青的[小青,蛋糕店老板]），都指同一人' },
        race: { type: 'string', description: '种族/物种（如"兔子""天马"）。是属性不是身份：同种族的不同个体各建各的条目，绝不因同族合并' },
        note: { type: 'string', description: '认知留痕：这个 NPC 是如何被逐渐了解的（初见→得知名字/性格/住处…）' },
        desc: { type: 'string', description: '外观/身份描述（可随了解加深而更新）' },
        persona: { type: 'string', description: '性格人设（可随了解加深而更新）' },
        home: { type: 'array', items: { type: 'string' }, description: '常驻地点 id（可更新）' },
        roaming: { type: 'number', description: '离开常驻地点的概率 0~1（可更新）' },
        mobility: { type: 'string', enum: ['anchored', 'free'], description: '移动性（可更新）' },
        state: { type: 'string', description: '当前状态描述（可随时更新）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'world_set_character',
    description:
      '设置/更新【主角】或【陪伴角色】的动态身份信息（种族、别名、认知历程）。' +
      '主角和陪伴角色不是 NPC，但你对他们的了解会随对话深入——第一次可能只知道种族/长相，' +
      '后来才得知名字、昵称、外号——用此工具逐步补充。' +
      'name=角色的【规范主名】（如前文已用"天角兽"就一直用它；若之前不知主名，用你当前所知最稳定的称呼）。' +
      'aliases=这把学到的其他称呼（小名/外号/全名）汇进去，与新学到的合并，不覆盖已记录的。' +
      'race=种族/物种（关键属性，非身份键：同种族的不同个体各建各的，绝不因同族合并）。' +
      'note=留痕——何时从"只知种族"到"得知名字/昵称"，帮助此后追踪认知变化。' +
      '只在确实学到了新信息时调用；没有新信息就不调。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色规范主名（已用的固定名，如"天角兽""柔柔"）' },
        race: { type: 'string', description: '种族/物种' },
        aliases: { type: 'array', items: { type: 'string' }, description: '新学到的其他称呼（小名/外号/全名）' },
        note: { type: 'string', description: '认知留痕，如"初见时只知是独角兽；第N轮得知本名XXX"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'world_remove_npc',
    description:
      '删除一个错误创建的 NPC。最常见的用途：之前把「主角」或「陪伴角色」误当成 NPC 建了条目，用它删掉。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的 NPC id' } },
      required: ['id'],
    },
  },
  {
    name: 'world_remove_character',
    description:
      '删除一个误建的重复角色条目（state.characters 里的）。用于清理把同一人的别名当成独立角色、建了多余条目的情况。删前先确认该角色的信息已合并到正确条目。',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要删除的角色条目名（state.characters 的 key）' } },
      required: ['name'],
    },
  },
  {
    name: 'world_set_relationship',
    description:
      '设置/更新/删除两个角色间的社会关系。关系随对话发展而变。' +
      '对称关系（朋友/好友/恋人/伴侣/夫妻/家人/同事/同学/熟人/邻居/室友）：两个人互为同一类关系，只记一条（方向任意，工具会自动去重）。' +
      '有向关系（宠物/主人/老师/学生/老板/下属）：方向有意义，可分别记录。' +
      '删除建错的或已结束的关系：传 remove=true。只在对话确实体现了关系建立/变化/结束时才调用。',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '角色 A（关系的主体）' },
        to: { type: 'string', description: '角色 B（关系的对象）' },
        type: { type: 'string', description: '关系类型：陌生人/朋友/好友/恋人/家人/宠物/主人/同事…（remove=true 时可省略）' },
        note: { type: 'string', description: '可选补充，如"刚认识，还有些拘谨"' },
        remove: { type: 'boolean', description: 'true=删除 from→to 这条关系（建错了/关系结束了）' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'world_move',
    description:
      '移动角色所在地点。who：both=两人一起移动（最常见，默认）；user=只有用户/主角移动（与陪伴角色分开了）；companion=只有陪伴角色移动。两人分开后，环境旁白会以【陪伴角色】所在地作为场景。',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '新地点 id' },
        who: { type: 'string', enum: ['both', 'user', 'companion'], description: '谁移动，默认 both' },
      },
      required: ['location'],
    },
  },
  {
    name: 'world_scene_change',
    description: '记录对当前环境的临时变更（如"灯关了""窗户开着"）。value 传空字符串表示撤销该变更。',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '变更项（如"灯光"）' },
        value: { type: 'string', description: '变更后的状态；空字符串=撤销' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'world_define_kind',
    description:
      '声明一个"新的动态对象类型"，交给框架按规则自动演化。当内置类型(snow/plant/timer)覆盖不了对话里出现的动态之物时用它（如融化的冰淇淋、越烧越短的蜡烛、逐渐枯萎的花）。声明后即可用 world_spawn_sim 以该 kind 生成实例。用规则而非代码描述：ratePerHour=每世界小时的变化量(正=增/负=减)，tempFactor=温度影响(如冰淇淋填负数，越热化越快)，removeAtOrBelow=降到该值就消失。',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '类型名（如 icecream、candle、wilting_flower）' },
        desc: { type: 'string', description: '这类东西是什么' },
        ratePerHour: { type: 'number', description: 'amount 每世界小时的基础变化（正=增长，负=衰减）' },
        tempFactor: { type: 'number', description: '温度影响：有效速率 += tempFactor × 温度（越热化越快就填负数）' },
        max: { type: 'number', description: 'amount 上限，默认 100' },
        removeAtOrBelow: { type: 'number', description: 'amount ≤ 此值则消失（如融尽=0）' },
        start: { type: 'number', description: '初始 amount（不填：衰减型默满，增长型默 0）' },
        phases: {
          type: 'array',
          description: '阶段标签，按 amount 阈值从高到低',
          items: {
            type: 'object',
            properties: { atOrAbove: { type: 'number' }, label: { type: 'string' } },
            required: ['atOrAbove', 'label'],
          },
        },
      },
      required: ['kind', 'ratePerHour'],
    },
  },
  {
    name: 'world_spawn_sim',
    description:
      '生成一个"由框架自动维护"的动态对象——之后它会随世界时间/环境自行变化，你不用再管它。内置类型：snow(随温度融化消失)、plant(生长成熟；采摘用 world_harvest)、timer(计时装置如烤面包机，到点变"完成")。也可用先前 world_define_kind 声明的自定义类型。当对话里出现这类东西时才生成。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '对象名（如"院子里的雪""窗台的番茄""烤着的面包机"）' },
        kind: { type: 'string', description: '类型：snow/plant/timer 或已声明的自定义类型' },
        location: { type: 'string', description: '所在地点 id（通常是主角当前地点）' },
        desc: { type: 'string', description: '简短描述' },
        multiHarvest: { type: 'boolean', description: 'plant 专用：true=多茬生(采后重长)，false=一茬生(采后消失)' },
        durationHours: { type: 'number', description: 'timer 专用：多少"世界小时"后完成（面包机可填 0.05）' },
      },
      required: ['id', 'kind', 'location'],
    },
  },
  {
    name: 'world_object',
    description:
      '与物体交互并记录其影响。物体可以是地点里的静物，也可以是动态对象（雪/植物等）。' +
      'action：move=把物体搬到另一个地点（需 to）；remove=物体被消耗/用掉/毁坏而消失；' +
      'harvest=采摘已成熟的植物（多茬生重长/一茬生消失）；' +
      'place=设置物体的相对位置（需 relation+anchor），如"花瓶 place 上 柜子"=花瓶在柜子上、"柜子 place 旁边 床"。用它记住屋里东西的相对摆放。',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: '物体名 / id' },
        action: { type: 'string', enum: ['move', 'remove', 'harvest', 'place'], description: '交互类型' },
        to: { type: 'string', description: 'move 时的目标地点 id' },
        relation: { type: 'string', description: 'place 时的关系：上/里/下/旁边/附近 等' },
        anchor: { type: 'string', description: 'place 时的参照物（另一件物品/家具，如"柜子""床"）' },
      },
      required: ['object', 'action'],
    },
  },
  {
    name: 'world_note_event',
    description: '记录这一轮对话中发生的、对世界有意义的事件（简短一句）。',
    input_schema: {
      type: 'object',
      properties: { event: { type: 'string', description: '事件描述' } },
      required: ['event'],
    },
  },
];

/** 执行一个世界工具，返回给模型的结果字符串 */
export async function executeWorldTool(
  store: WorldStore,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'world_upsert_location': {
      const id = String(input.id ?? '').trim();
      if (!id) return 'error: id 缺失';
      await store.upsertLocation(id, {
        desc: input.desc as string | undefined,
        objects: input.objects as string[] | undefined,
        visible: input.visible as string[] | undefined,
        connects: input.connects as string[] | undefined,
        owner: input.owner as string | undefined,
      });
      return `ok: 地点 "${id}" 已保存`;
    }
    case 'world_upsert_npc': {
      const id = String(input.id ?? '').trim();
      if (!id) return 'error: id 缺失';
      await store.upsertNpc(id, {
        desc: input.desc as string | undefined,
        aliases: Array.isArray(input.aliases) ? (input.aliases as string[]) : undefined,
        race: input.race as string | undefined,
        note: input.note as string | undefined,
        persona: input.persona as string | undefined,
        home: input.home as string[] | undefined,
        roaming: input.roaming as number | undefined,
        mobility: input.mobility as 'anchored' | 'free' | undefined,
        state: input.state as string | undefined,
      });
      return `ok: NPC "${id}" 已保存`;
    }
    case 'world_set_character': {
      const name = String(input.name ?? '').trim();
      if (!name) return 'error: name 缺失';
      await store.setCharacter(name, {
        race: input.race as string | undefined,
        aliases: Array.isArray(input.aliases) ? (input.aliases as string[]) : undefined,
        note: input.note as string | undefined,
      });
      return `ok: 角色 "${name}" 的身份信息已更新`;
    }
    case 'world_remove_character': {
      const name = String(input.name ?? '').trim();
      if (!name) return 'error: name 缺失';
      await store.removeCharacter(name);
      return `ok: 角色条目 "${name}" 已删除`;
    }
    case 'world_remove_npc': {
      const id = String(input.id ?? '').trim();
      if (!id) return 'error: id 缺失';
      await store.removeNpc(id);
      return `ok: NPC "${id}" 已删除`;
    }
    case 'world_set_relationship': {
      const from = String(input.from ?? '').trim();
      const to = String(input.to ?? '').trim();
      if (!from || !to) return 'error: from/to 缺失';
      if (input.remove === true) {
        await store.removeRelationship(from, to);
        return `ok: 已删除关系 ${from}→${to}`;
      }
      const type = String(input.type ?? '').trim();
      if (!type) return 'error: type 缺失（或用 remove=true 删除）';
      await store.setRelationship(from, to, type, input.note as string | undefined);
      return `ok: 关系已记录（${to} 是 ${from} 的${type}）`;
    }
    case 'world_move': {
      const location = String(input.location ?? '').trim();
      if (!location) return 'error: location 缺失';
      const who = String(input.who ?? 'both');
      if (who === 'user') {
        await store.moveUser(location);
        return `ok: 用户/主角现在在 "${location}"（与陪伴角色分开）`;
      }
      if (who === 'companion') {
        await store.moveCompanion(location);
        return `ok: 陪伴角色现在在 "${location}"`;
      }
      await store.moveBoth(location);
      return `ok: 两人现在都在 "${location}"`;
    }
    case 'world_scene_change': {
      const key = String(input.key ?? '').trim();
      if (!key) return 'error: key 缺失';
      const value = String(input.value ?? '');
      await store.setSceneOverride(key, value === '' ? null : value);
      return `ok: 环境变更 "${key}" 已记录`;
    }
    case 'world_define_kind': {
      const kind = String(input.kind ?? '').trim();
      if (!kind) return 'error: kind 缺失';
      if (typeof input.ratePerHour !== 'number') return 'error: ratePerHour 必须是数字';
      await store.defineKind({
        kind,
        desc: input.desc as string | undefined,
        ratePerHour: input.ratePerHour,
        tempFactor: typeof input.tempFactor === 'number' ? input.tempFactor : undefined,
        max: typeof input.max === 'number' ? input.max : undefined,
        removeAtOrBelow: typeof input.removeAtOrBelow === 'number' ? input.removeAtOrBelow : undefined,
        start: typeof input.start === 'number' ? input.start : undefined,
        phases: Array.isArray(input.phases)
          ? (input.phases as any[])
              .filter(p => typeof p?.atOrAbove === 'number' && typeof p?.label === 'string')
              .map(p => ({ atOrAbove: p.atOrAbove, label: p.label }))
          : undefined,
      });
      return `ok: 已声明动态类型 "${kind}"，可用 world_spawn_sim 生成它`;
    }
    case 'world_spawn_sim': {
      const id = String(input.id ?? '').trim();
      const kind = String(input.kind ?? '').trim();
      const location = String(input.location ?? '').trim();
      if (!id || !kind || !location) return 'error: id/kind/location 缺失';
      const params: Record<string, unknown> = {};
      if (typeof input.multiHarvest === 'boolean') params.multiHarvest = input.multiHarvest;
      if (typeof input.durationHours === 'number') params.durationHours = input.durationHours;
      await store.spawnSimObject(id, kind, location, input.desc as string | undefined, params);
      return `ok: 动态对象 "${id}"(${kind}) 已生成，框架将自动维护`;
    }
    case 'world_object': {
      const object = String(input.object ?? '').trim();
      const action = String(input.action ?? '').trim();
      if (!object || !action) return 'error: object/action 缺失';
      switch (action) {
        case 'move': {
          const to = String(input.to ?? '').trim();
          if (!to) return 'error: move 需要 to（目标地点）';
          await store.moveObject(object, to);
          return `ok: "${object}" 已搬到 "${to}"`;
        }
        case 'remove':
          await store.removeObject(object);
          return `ok: "${object}" 已消失`;
        case 'place': {
          const relation = String(input.relation ?? '').trim();
          const anchor = String(input.anchor ?? '').trim();
          if (!relation || !anchor) return 'error: place 需要 relation 和 anchor';
          await store.placeObject(object, relation, anchor);
          return `ok: "${object}" 在 "${anchor}" ${relation}`;
        }
        case 'harvest': {
          const sim = store.getWorld()?.simObjects[object];
          if (!sim) return `error: 没有 "${object}" 这个动态对象`;
          if (sim.kind !== 'plant') return `error: "${object}" 不是可采摘的植物`;
          if (sim.amount < 100) return `"${object}" 还没成熟（当前 ${Math.round(sim.amount)}%）`;
          const multi = (sim.params as any)?.multiHarvest === true;
          await store.harvestSim(object);
          return multi ? `ok: 已采摘 "${object}"，会重新生长` : `ok: 已采摘 "${object}"（一茬生，已消失）`;
        }
        default:
          return `error: 未知 action "${action}"`;
      }
    }
    case 'world_note_event': {
      const event = String(input.event ?? '').trim();
      if (!event) return 'error: event 缺失';
      await store.addEvent(event);
      return 'ok: 事件已记录';
    }
    default:
      return `error: 未知工具 "${name}"`;
  }
}
