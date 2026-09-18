#!/usr/bin/env node
/**
 * verify:layers —— 分层约束机器化。
 *
 * 目标：把架构分层从注释承诺变成 CI 硬校验。当前两条规则：
 *
 * 规则 1「内核层零业务依赖」
 *   - 扫描 src/kernel 目录树内全部 .ts（排除 *.test.ts）
 *   - 白名单：./（同级原语互引）、../logging/（唯一允许的跨层依赖）
 *   - 其余任何 ../xxx 跨层依赖（orchestrator/channels/companion/context/
 *     tools/memory/provider/gateway/plugins/runtime/setup/ui-protocol/
 *     repair/rollback…）一律报错。装配层（create-kernel）不得住在
 *     kernel/ —— 它依赖业务阶段模块，属于 orchestrator 的装配职责。
 *
 * 规则 2「业务核心不依赖 UI 适配层」（P5-6）
 *   - UI 协议层（src/ui-protocol）与通道装配层（src/channels）是为 UI
 *     服务的适配层。业务核心（orchestrator/companion/tools/context/
 *     memory/...）一旦**运行时**依赖它们，方向就倒置了：协议层未来
 *     引入任何依赖（哪怕一个 logger）都会把 AgentLoop 拖进它的依赖树。
 *   - 允许依赖的层（UI 侧白名单）：ui-protocol(自身)/channels/gateway/
 *     webui/ui/cli。
 *   - **豁免 `import type`**：类型导入编译期擦除，不产生运行时依赖。
 *     协议层为保持「零业务依赖」会自定义最小接口（如 PreciseModeLike），
 *     业务类以结构化类型天然兼容；此时业务侧 `import type` 该接口来
 *     显式声明兼容是合理的，不构成耦合。
 *
 * 规则 3「装配层禁止直接 new 业务类」（P6-4）
 *   - 装配中心（factory.ts）直接 `new` 业务类 = 隐式装配顺序的根源，
 *     应从「承诺」变「硬校验」。白名单（assembly-whitelist.mjs）是
 *     **只减不增**的待迁移清单：未列入白名单的直接 new → 违规；白名单
 *     中有、实际不再 new → 违规（防白名单虚增豁免）。P6 每迁移一个出
 *     factory，删一条白名单。
 *
 * 规则 4「业务核心不依赖 Supervisor 层实现」（Supervisor 方案 S1）
 *   - src/supervisor/ 是**进程级监督层**（Process Supervisor）：guardian /
 *     protocol / shutdown 等进程边界关注点。业务核心（orchestrator/tools/
 *     context/memory/...）只能通过监督层的**契约叶**（supervisor/protocol.js
 *     —— 退出码/标记文件/环境变量常量，零依赖）与监督层协作，不得依赖
 *     guardian 等监督层实现（那是 gateway 装配层的职责）。
 *   - 白名单 SUPERVISOR_LEAF_ALLOWED：当前 = supervisor/protocol（契约叶）。
 *     业务侧 import 监督层实现 → 违规；supervisor 内部自身（guardian 引
 *     protocol）不算跨层（同层互引）。
 *   - **豁免 `import type`**：与规则 2 同因（编译期擦除）。
 *
 * 规则 5「UI 适配层不得直连业务核心」（协议层统一化 T4）
 *   - 目的：同一个操作在 UI 侧只允许有一条实现路径（经 ui-protocol 协议域）。
 *     UI 侧目录（UI_SIDE_DIRS，即规则 2 定义的 UI 侧集合）内的运行时相对
 *     导入指向业务核心（provider/memory/tools/orchestrator/context/...）
 *     必须登记在 UI_DIRECT_ALLOWED 白名单（ui-direct-whitelist.mjs）中。
 *   - 豁免：ui-protocol（走协议正是目标，且协议层自身就是适配层）/ 根级
 *     基础文件与纯工具目录（UI_DIRECT_EXCLUDED）/ 同层互引 / `import type`
 *     （与规则 2 同因，编译期擦除）。
 *   - 白名单**只减不增**：每把一处直连改为经协议层调用就删一条；已登记但
 *     实际不再直连 → stale 违规（防豁免虚增）。基线由 T4 生成，T6 起递减。
 *
 * 规则 6「工具之间零互相依赖」（2026-09-19，用户立的架构原则）
 *   - 理由：**工具是动态的、会一个一个地变动**；不能让"升级一个工具"导致
 *     "另一个工具出故障"。耦合的工具 = 一次改动影响面不可控。
 *   - 范围：只扫 **src/tools/*.ts 顶层文件**（子目录 xref/ runtime-control/
 *     python-bridge/ 内部自有内聚，不属本规则）。其 `./x.js` 相对导入若指向
 *     同目录的**工具侧模块**即违规；指向 SHARED_TOOL_INFRA（共享基础设施）
 *     则豁免。
 *   - 白名单（tools-decoupling-whitelist.mjs）**只减不增**，且白名单 ⊆ 实际：
 *     已登记但实际不再耦合 → stale 违规（防豁免虚增）。
 *   - 实测的反面案例：`multi-edit.ts` 不仅 import `GlobTool`，还 new 它并
 *     **字符串比对它的返回值**（`=== 'No files matched the pattern'`）——
 *     GlobTool 改一句提示语，multi_edit 就静默失效。这就是要防的形态。
 *
 * 用法：npm run verify:layers
 * 退出码：0 = 干净；1 = 有违规（打印违规清单）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_DIRECT_NEW, ASSEMBLY_EXCLUDED } from './assembly-whitelist.mjs';
import { UI_DIRECT_ALLOWED, UI_DIRECT_EXCLUDED } from './ui-direct-whitelist.mjs';
import { SHARED_TOOL_INFRA, KNOWN_TOOL_COUPLINGS } from './tools-decoupling-whitelist.mjs';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// 规则 2 / 规则 5：允许依赖 UI 适配层的目录（UI 侧）。
// 'cli' 已随 src/cli/ 目录删除移除（目录不复存在，死常量）。
const UI_SIDE_DIRS = ['ui-protocol', 'channels', 'gateway', 'webui', 'ui'];

// 规则 1：kernel 允许的 '../' 跨层前缀
const KERNEL_ALLOWED_CROSS_LAYER = ['../logging/', '../../logging/']; // kernel/security/ 子目录深一层，依赖目标同为 logging（零业务依赖不变）

// 规则 3：装配层文件（相对 src/）。factory 为薄壳，装配主体在 agent-assembly.ts。
const ASSEMBLY_FILES = ['gateway/agent-assembly.ts', 'gateway/factory.ts'];

// 规则 4：业务核心可从监督层 import 的契约叶（相对 src/）。当前 = protocol（退出码/标记文件/环境变量常量）。
const SUPERVISOR_LEAF_ALLOWED = new Set(['supervisor/protocol']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** 提取 import/export ... from '...'，并标记是否 type-only */
function extractImports(src) {
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ spec: m[2], isTypeOnly: Boolean(m[1]) });
  }
  return out;
}

/** 文件所属顶层目录（如 'orchestrator'）；位于 src 根时返回 '' */
function topLevelDir(file) {
  const rel = relative(SRC, file).split('\\').join('/');
  const idx = rel.indexOf('/');
  return idx > 0 ? rel.slice(0, idx) : '';
}

// ── 规则 1：内核层零业务依赖 ────────────────────────────────
function checkKernel() {
  const files = walk(join(SRC, 'kernel'));
  const violations = [];
  for (const file of files) {
    for (const { spec } of extractImports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      if (spec.startsWith('./')) continue; // 同级 OK
      if (KERNEL_ALLOWED_CROSS_LAYER.some((p) => spec.startsWith(p))) continue;
      violations.push({ file: relative(SRC, file), spec });
    }
  }
  return { count: files.length, violations };
}

// ── 规则 2：业务核心不依赖 UI 适配层 ────────────────────────
function checkBusinessCore() {
  const violations = [];
  let scanned = 0;
  for (const file of walk(SRC)) {
    const dir = topLevelDir(file);
    if (UI_SIDE_DIRS.includes(dir)) continue; // UI 侧允许
    scanned += 1;
    for (const { spec, isTypeOnly } of extractImports(readFileSync(file, 'utf8'))) {
      if (isTypeOnly) continue; // 类型导入编译期擦除，不构成运行时耦合
      // 只看指向 ui-protocol / channels 的相对路径
      if (!/\b(ui-protocol|channels)\//.test(spec)) continue;
      violations.push({ file: relative(SRC, file), spec });
    }
  }
  return { count: scanned, violations };
}

// ── 规则 3：装配层禁止直接 new 业务类（P6-4） ────────────────────
function checkAssembly() {
  const violations = [];
  const actual = new Map();
  for (const rel of ASSEMBLY_FILES) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    const re = /new ([A-Z][A-Za-z0-9]*)\s*[<(]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (ASSEMBLY_EXCLUDED.has(m[1])) continue;
      actual.set(m[1], rel);
    }
  }
  // 未列入白名单的直接 new → 违规（新增业务类实例化被禁止）
  for (const [cls, file] of actual) {
    if (!ALLOWED_DIRECT_NEW.has(cls)) violations.push({ file, cls, kind: 'unlisted' });
  }
  // 白名单过期（已不在任何装配文件）→ 违规（白名单只减不增，防虚增豁免）
  for (const cls of ALLOWED_DIRECT_NEW) {
    if (!actual.has(cls)) violations.push({ file: ASSEMBLY_FILES[0], cls, kind: 'stale-whitelist' });
  }
  return { violations, actual };
}

// ── 规则 4：业务核心不依赖 Supervisor 层实现（Supervisor 方案 S1） ────
function checkSupervisor() {
  const violations = [];
  let scanned = 0;
  for (const file of walk(SRC)) {
    const dir = topLevelDir(file);
    if (dir === 'supervisor' || dir === 'gateway') continue; // 监督层自身 + 装配层(唯一授权装配方)免检
    scanned += 1;
    for (const { spec, isTypeOnly } of extractImports(readFileSync(file, 'utf8'))) {
      if (isTypeOnly) continue; // 类型导入编译期擦除，不构成运行时耦合
      if (!spec.startsWith('../')) continue; // 只看跨目录相对路径
      // 按相对路径反算目标子模块：'../../supervisor/protocol.js' → 'supervisor/protocol'
      const target = spec.replace(/^(\.\.\/)+/, '').replace(/\.js$/, '');
      if (!target.startsWith('supervisor/')) continue; // 只看指向 supervisor/ 的 import
      if (!SUPERVISOR_LEAF_ALLOWED.has(target)) {
        violations.push({ file: relative(SRC, file), spec });
      }
    }
  }
  return { count: scanned, violations };
}

// ── 规则 5：UI 适配层不得直连业务核心（协议层统一化 T4） ──────────
// 目的：同一个操作在 UI 侧只允许有一条实现路径（经 ui-protocol）。
// 允许：指向 ui-protocol / 根级基础与纯工具目录（UI_DIRECT_EXCLUDED）的引用、
//       同层互引，以及 import type（编译期擦除，与规则 2 同理由）。
// 其余指向业务核心的相对导入必须登记在 UI_DIRECT_ALLOWED 白名单中。
// 白名单只减不增：已登记但实际不再直连 → stale 违规（防豁免虚增）。

/** 把相对 import spec 解析为目标顶层目录（Windows 分隔符统一 '/'）。
 *  'gateway/tui.ts' + '../ui-protocol/adapter.js' → 'ui-protocol'；
 *  指向 src 根级文件（如 '../events.js'）→ ''（与 topLevelDir 语义一致）。 */
function resolveTopLevel(relFile, spec) {
  const parts = relFile.split('/');
  parts.pop(); // 文件所在目录段
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const joined = parts.join('/');
  const idx = joined.indexOf('/');
  return idx > 0 ? joined.slice(0, idx) : '';
}

function checkUiDirect() {
  const violations = [];
  const staleEntries = [];
  const seen = new Map(); // rel → Set<target>（实际命中的白名单条目）
  let scanned = 0;
  for (const file of walk(SRC)) {
    const dir = topLevelDir(file);
    if (!UI_SIDE_DIRS.includes(dir)) continue; // 非 UI 侧不管
    if (dir === 'ui-protocol') continue;       // 协议层自身允许依赖业务（它就是适配层）
    scanned += 1;
    const rel = relative(SRC, file).split('\\').join('/');
    const allowed = UI_DIRECT_ALLOWED.get(rel);
    for (const { spec, isTypeOnly } of extractImports(readFileSync(file, 'utf8'))) {
      if (isTypeOnly) continue;                 // 类型导入编译期擦除
      if (!spec.startsWith('.')) continue;      // 第三方包 / node_modules 不管
      const target = resolveTopLevel(rel, spec);
      if (target === dir) continue;             // 同层互引
      if (UI_DIRECT_EXCLUDED.has(target)) continue; // 根级基础 / 纯工具 / UI 内部
      if (target === 'ui-protocol') continue;   // 走协议正是目标
      if (allowed?.has(target)) {
        if (!seen.has(rel)) seen.set(rel, new Set());
        seen.get(rel).add(target);
        continue;
      }
      violations.push({ file: rel, spec, target });
    }
  }
  // 白名单虚增检测：已登记但实际不再直连 → 同样违规
  for (const [file, dirs] of UI_DIRECT_ALLOWED) {
    for (const d of dirs) {
      if (!seen.get(file)?.has(d)) staleEntries.push({ file, dir: d });
    }
  }
  return { scanned, violations, staleEntries };
}

// ── 规则 6：工具之间零互相依赖 ──────────────────────────────
/**
 * 只扫 src/tools 的**顶层** *.ts（子目录内部自有内聚，不属本规则）。
 * - 排除 index.ts：它是**组合根**，职责就是 import 并导出全部工具。
 * - 豁免 `import type`：编译期擦除，不产生运行时耦合（与规则 2/5 同因）。
 * - 判据：`./x.js` 相对导入若指向同目录的**工具侧模块**即违规；
 *   x ∈ SHARED_TOOL_INFRA（共享基础设施）则豁免。
 * - 同时检查白名单是否过期（登记的耦合已不存在 → stale，防豁免虚增）。
 */
function checkToolDecoupling() {
  const dir = join(SRC, 'tools');
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(dir, e.name))
    .filter((f) => !f.endsWith('index.ts'));

  const violations = [];
  const seen = new Set();

  for (const file of files) {
    const rel = relative(SRC, file).split('\\').join('/');       // tools/xxx.ts
    const from = rel.replace(/^tools\//, '').replace(/\.ts$/, '');
    for (const { spec, isTypeOnly } of extractImports(readFileSync(file, 'utf8'))) {
      if (isTypeOnly) continue;                                   // 编译期擦除
      if (!spec.startsWith('./')) continue;                       // 只管同目录（顶层）互引
      const to = spec.slice(2).replace(/\.js$/, '');
      if (SHARED_TOOL_INFRA.has(to)) continue;                    // 共享基础设施：豁免
      const key = `${from}→${to}`;
      seen.add(key);
      if (!KNOWN_TOOL_COUPLINGS.has(key)) {
        violations.push({ file: rel, from, to });
      }
    }
  }

  const staleEntries = [...KNOWN_TOOL_COUPLINGS].filter((k) => !seen.has(k));
  return { scanned: files.length, violations, staleEntries };
}

const kernel = checkKernel();
const core = checkBusinessCore();
const assembly = checkAssembly();
const supervisor = checkSupervisor();
const uiDirect = checkUiDirect();

let failed = false;

if (kernel.violations.length > 0) {
  failed = true;
  console.error('❌ 规则 1「内核层零业务依赖」失败：');
  for (const v of kernel.violations) {
    console.error(`   ${v.file}\n      → import '${v.spec}'`);
  }
  console.error(
    '\n规则：src/kernel/** 只允许依赖 ./（同级）与 ../logging/。\n' +
      '装配层（如 create-kernel 依赖 orchestrator 阶段模块）应移出 kernel/。',
  );
}

if (core.violations.length > 0) {
  failed = true;
  console.error('❌ 规则 2「业务核心不依赖 UI 适配层」失败：');
  for (const v of core.violations) {
    console.error(`   ${v.file}\n      → import '${v.spec}'`);
  }
  console.error(
    `\n规则：只有 UI 侧（${UI_SIDE_DIRS.join(' / ')}）可运行时依赖 ui-protocol / channels。\n` +
      '业务核心需要事件常量请从 src/events.ts（中立层）取；\n' +
      '需要接口形状可用 `import type`（编译期擦除，已豁免）。',
  );
}

if (assembly.violations.length > 0) {
  failed = true;
  console.error('❌ 规则 3「装配层禁止直接 new 业务类」失败：');
  for (const v of assembly.violations) {
    console.error(
      v.kind === 'unlisted'
        ? `   ${v.file}\n      → 白名单外的直接 new：${v.cls}（新增业务类实例化被禁止，先迁移到装配贡献/服务表）`
        : `   ${v.file}\n      → 白名单过期：${v.cls}（已不在装配中，请从 assembly-whitelist.mjs 删除该条）`,
    );
  }
  console.error(
    '\n规则：装配层直接 new 业务类必须 ∈ 白名单（assembly-whitelist.mjs），且白名单 ⊆ 实际。\n' +
      '白名单只减不增 —— P6 每迁移一个类出 factory 就删一条。',
  );
}

if (supervisor.violations.length > 0) {
  failed = true;
  console.error('❌ 规则 4「业务核心不依赖 Supervisor 层实现」失败：');
  for (const v of supervisor.violations) {
    console.error(`   ${v.file}\n      → import '${v.spec}'`);
  }
  console.error(
    `\n规则：业务核心只能依赖监督层的契约叶（${[...SUPERVISOR_LEAF_ALLOWED].join(' / ')}），\n` +
      '监督层实现（guardian / restart 编排 / 更新）是 gateway 装配层的职责。\n' +
      '需要监督层能力请通过 gateway 注入或事件，不要直接 import supervisor 实现。',
  );
}

if (uiDirect.violations.length > 0 || uiDirect.staleEntries.length > 0) {
  failed = true;
  console.error('❌ 规则 5「UI 适配层不得直连业务核心」失败：');
  for (const v of uiDirect.violations) {
    console.error(`   ${v.file}\n      → import '${v.spec}'（业务核心 ${v.target}）`);
  }
  for (const v of uiDirect.staleEntries) {
    console.error(`   ${v.file}\n      → 白名单过期：${v.dir}（已不再直连，请从 ui-direct-whitelist.mjs 删除该条）`);
  }
  console.error(
    `\n规则：UI 侧（${UI_SIDE_DIRS.join(' / ')}）对业务核心的运行时相对导入必须 ∈ 白名单` +
      '（ui-direct-whitelist.mjs），且白名单 ⊆ 实际。\n' +
      '白名单只减不增 —— 每把一处直连改为经 ui-protocol 协议调用就删一条。\n' +
      '指向 ui-protocol / 根级基础文件 / 纯工具目录（UI_DIRECT_EXCLUDED）的引用已豁免。',
  );
}

// ── 规则 6：工具之间零互相依赖 ──────────────────────────────
// （自成一块，不并入上面的调用区：便于规则 6 独立演进）
const toolCoupling = checkToolDecoupling();
if (toolCoupling.violations.length > 0 || toolCoupling.staleEntries.length > 0) {
  failed = true;
  console.error('❌ 规则 6「工具之间零互相依赖」失败：');
  for (const v of toolCoupling.violations) {
    console.error(`   src/${v.file}\n      → 依赖了同目录的工具侧模块 '${v.to}'`);
  }
  for (const k of toolCoupling.staleEntries) {
    console.error(
      `   ${k}\n      → 白名单过期：该耦合已不存在，请从 tools-decoupling-whitelist.mjs 删除该条`,
    );
  }
  console.error(
    '\n规则：src/tools 顶层文件之间不得互相依赖 —— 工具会一个一个地变动，\n' +
      '耦合意味着"升级一个工具"可能导致"另一个工具出故障"，改动影响面不可控。\n' +
      `共享基础设施请登记进 SHARED_TOOL_INFRA（现 ${SHARED_TOOL_INFRA.size} 个：${[...SHARED_TOOL_INFRA].join(' / ')}）。\n` +
      '新工具若要复用逻辑 → 抽成共享模块并登记，而不是 import 另一个工具的实现。\n' +
      `已登记的待修耦合（只减不增）：${[...KNOWN_TOOL_COUPLINGS].join(' / ')}。`,
  );
}

if (failed) process.exit(1);

console.log('✅ verify:layers 通过');
console.log(`   · 规则 1 内核层：kernel/ 共 ${kernel.count} 个文件，零越层依赖`);
console.log(`   · 规则 2 业务核心：扫描 ${core.count} 个业务文件，零 UI 适配层运行时依赖`);
console.log(`   · 规则 3 装配层：${ASSEMBLY_FILES.join(', ')} 直接 new 业务类 ${assembly.actual.size} 个，全部在白名单内`);
console.log(`   · 规则 4 监督层：扫描 ${supervisor.count} 个业务文件，仅契约叶（supervisor/protocol）可被依赖`);
console.log(`   · 规则 5 UI 直连：扫描 ${uiDirect.scanned} 个 UI 侧文件，业务核心直连 ${uiDirect.violations.length} 处 + 白名单 stale ${uiDirect.staleEntries.length} 条`);
