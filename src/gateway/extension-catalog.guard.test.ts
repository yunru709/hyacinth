import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLACEABLE_POINTS, getReplaceablePoint } from '../supervisor/extension-registry.js';
import { BUILTIN_STAGE_IDS } from '../orchestrator/stage-registry.js';
import type { StageServiceMap } from '../orchestrator/stage-services.js';
import { NormalRouter, CompanionRouter } from '../context/router.js';
import { getDefaultConfig } from '../runtime/defaults.js';

/**
 * 可替换点目录守卫 —— 目录是「哪里能被替换」的唯一名单来源（架构监督）。
 * 漂移即失败：内核槽位/服务面/路由/内置源增删，或出现新的注册原语调用点，
 * 都必须先登记目录（extension-registry.ts 的 REPLACEABLE_POINTS）再过本测试。
 */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 服务面键清单：satisfies 使「StageServiceMap 增删键而此处未同步」在编译期即报错
const SERVICE_KEYS = [
  'conversationStore', 'configCenter', 'compressor', 'turnRecorder', 'sessionDir',
  'toolRegistry', 'contextComposer', 'summaryStore', 'statsManager', 'gitManager',
  'outputHandler', 'maxContextTokens', 'personaDir', 'bundleRegistry', 'kbState',
  'loopHooks', 'getRouter', 'eventStore', 'orchestrator', 'bypassManager',
  'toolService', 'clusterService',
] as const satisfies readonly (keyof StageServiceMap)[];

// 注册原语 → 原语宿主（home）+ 已知调用方。新调用点出现 = 悄悄新开注册入口，必须登记目录后加入此表。
const REGISTRAR_ALLOWLIST: Record<string, string[]> = {
  registerProviderFactory: ['provider/factory-registry.ts'],
  registerRouter: ['context/profiles.ts', 'context/router.ts', 'gateway/arch-assembly.ts'],
  registerAdapter: ['generation/registry.ts'],
};

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTsFiles(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('可替换点目录守卫', () => {
  it('slot: 与 kernel.pipeline 出厂槽位双向一致（id + defaultImpl）', () => {
    const pipeline = getDefaultConfig().kernel?.pipeline ?? [];
    const catalogSlots = REPLACEABLE_POINTS.filter((p) => p.kind === 'slot');
    expect(catalogSlots.map((p) => p.id)).toEqual(pipeline.map((s) => `slot:${s.id}`));
    for (const s of pipeline) {
      expect(getReplaceablePoint(`slot:${s.id}`)?.defaultImpl).toBe(s.impl);
    }
    // 内置阶段 id 与出厂 impl 集一致（stage-registry 注释承诺的守卫延伸）
    expect(new Set(BUILTIN_STAGE_IDS)).toEqual(new Set(pipeline.map((s) => s.impl)));
  });

  it('service: 与 StageServiceMap 键集一致', () => {
    const catalogServices = new Set(
      REPLACEABLE_POINTS.filter((p) => p.kind === 'service').map((p) => p.id),
    );
    for (const key of SERVICE_KEYS) {
      expect(catalogServices.has(`service:${key}`)).toBe(true);
    }
    expect(catalogServices.size).toBe(SERVICE_KEYS.length);
  });

  it('router: 与出厂路由名一致', () => {
    expect(getReplaceablePoint(`router:${new NormalRouter().name}`)).toBeDefined();
    expect(getReplaceablePoint(`router:${new CompanionRouter().name}`)).toBeDefined();
    const catalogRouters = REPLACEABLE_POINTS.filter((p) => p.kind === 'router');
    expect(catalogRouters).toHaveLength(2);
  });

  it('source: 覆盖出厂内置数据源（gateway/context-sources.ts 全部 name）', () => {
    const file = path.join(SRC_DIR, 'gateway', 'context-sources.ts');
    const text = fs.readFileSync(file, 'utf-8');
    const names = [...text.matchAll(/name: '([\w-]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(getReplaceablePoint(`source:${name}`), `source:${name} 未登记目录`).toBeDefined();
    }
  });

  it('目录每条可替换点都带 contract（注册表即开发者手册），且契约模块真实存在', () => {
    for (const p of REPLACEABLE_POINTS) {
      expect(p.contract, `${p.id} 缺少 contract —— 目录声明「哪里能换」，contract 声明「换的东西长什么样」`).toBeDefined();
      expect(p.contract!.interface, `${p.id}.contract.interface 不能为空`).toBeTruthy();
      expect(p.contract!.summary, `${p.id}.contract.summary 不能为空`).toBeTruthy();
      const modPath = path.join(SRC_DIR, `${p.contract!.module}.ts`);
      expect(fs.existsSync(modPath), `${p.id} 的 contract.module "${p.contract!.module}" 不是 src/ 下的真实模块`).toBe(true);
    }
  });

  it('注册原语调用点全部在 allowlist 内（新注册入口必须登记）', () => {
    const files = walkTsFiles(SRC_DIR).filter((f) => !f.endsWith('.test.ts'));
    const rel = (f: string) => path.relative(SRC_DIR, f).replace(/\\/g, '/');
    for (const [symbol, allowed] of Object.entries(REGISTRAR_ALLOWLIST)) {
      const callers = files
        .filter((f) => fs.readFileSync(f, 'utf-8').includes(`${symbol}(`))
        .map(rel);
      // home 模块自身可能尚未调用（如 registerAdapter 由动态装载触发），只要求 ⊆
      const unexpected = callers.filter((c) => !allowed.includes(c));
      expect(unexpected, `${symbol} 出现未登记调用点：${unexpected.join(', ')}——先登记 REPLACEABLE_POINTS，再加入 REGISTRAR_ALLOWLIST`).toEqual([]);
    }
  });
});
