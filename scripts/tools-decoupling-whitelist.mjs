/**
 * tools-decoupling-whitelist.mjs — 规则 6「工具之间零互相依赖」的白名单
 *
 * 为什么有这条规则（用户立的架构原则）：
 *   **工具是动态的、会一个一个地变动** —— 不能让"升级一个工具"导致"另一个工具出故障"。
 *   实测到的反面案例（2026-09-19 审计，全仓只有 3 条越界边）：
 *     - `multi-edit.ts` 不仅 import `GlobTool`，还 **new 它、并字符串比对它的返回值**
 *       （`globResult.trim() === 'No files matched the pattern'`）—— GlobTool 改一句
 *       提示语，multi_edit 就**静默失效**。这正是该规则要防的故障形态。
 *     - `write.ts` / `edit.ts` import `symbol-references.ts`（同目录的分析模块，非 Tool 类）
 *       —— 同一类耦合：工具实现之间硬连接。
 *
 * 规则形状：只扫 **src/tools/*.ts 顶层文件**（不含子目录 —— xref/ runtime-control/
 * python-bridge/ 等子目录内部自有内聚，不属本规则范围），
 * 其 `./x.js` 相对导入若指向同目录的**另一个工具侧模块**，即违规；
 * 指向 `SHARED_TOOL_INFRA`（共享基础设施）则豁免。
 *
 * 白名单纪律（沿用 assembly-whitelist / ui-direct-whitelist 的约定）：
 *   只减不增，且白名单 ⊆ 实际 —— 修掉一条就删一条，过期条目也会报错。
 */

/** 任何工具都可以依赖的**共享基础设施**（模块 basename，不含扩展名）。新增需在此登记并说明用途
 *
 * ⚠️ 维护提示（2026-09-19 的教训）：本清单的初始版本是**人眼审计**得出的，而规则是
 * **机械穷举** —— 首次运行就抓出 2 条审计漏掉的项（`write/edit → diff-channel`、
 * `filtered-registry → registry`）。所以：
 *   ① 改完规则**务必跑一次** `npm run verify:layers`，看它报什么；
 *   ② 但**不要因为"它报错"就直接加白名单** —— 先核实目标是不是真的是共享基础设施；
 *   ③ 规则报出来的、以及白名单里已登记的，才是真实耦合的全貌。
 */
export const SHARED_TOOL_INFRA = new Set([
  'interface',          // Tool 契约本身（所有工具都实现它）
  'tool-config',        // 工具级配置读取
  'file-tracker',       // read-before-write 门控的状态（被 read/write/edit/multi-edit/read-gate 共用）
  'read-gate',          // 门控失败的统一响应（被 write/edit/multi-edit 共用）
  'diff-channel',       // 变更差异的暂存队列（pushDiff/popDiff，被 write/edit 共用；与 read-gate 同族的响应助手）
  'registry',           // ToolRegistry 本体（工具注册面，全仓约 50 处引用）
  'side-effect',        // sideEffect 声明
  'result-buffer',      // 大结果落盘缓冲
  'diagnostics',        // 写后诊断
  'background-registry',// 后台进程句柄表（bash 与 process-* 共用）
  'sqlite',             // node:sqlite 薄封装
  'bundle-registry',    // 工具包注册表（bundle-tools 用）
  'types',              // 工具侧共享类型
  // 引用自检（Phase 6 收敛）：write/edit 共用同**一份**实现 —— 原为两份内联副本（方案 A），
  // 2026-09-19 按《工具联动架构研究报告 v1.1》改判为单一共享模块，理由见该文件头部
  //（兜底必须永远在 + 核心消费者要覆盖子代理）。属纯分析模块，不含工具语义。
  'reference-analysis',
]);

/**
 * 已登记的违规（**只减不增**）。修掉就删对应条目。
 * 每条格式：`<from 模块 basename>→<to 模块 basename>`
 *
 * ✅ 2026-09-19：**已清空 —— 3 条全部解除**
 *   - multi-edit→glob          已内联目录遍历 + glob 匹配（86 行）
 *   - write→symbol-references  已按方案 A 内联：把 424 行实现**复制**进 write.ts 与 edit.ts
 *                              （工具独立 > DRY；两份一致性由 src/tools/inlined-copies-sync.test.ts 守住）
 *   - edit→symbol-references   同上
 *
 * ⚠️ 2026-09-19（同日稍晚，Phase 6）**改判**：方案 A 的两份副本已收敛为单一共享模块
 *   src/tools/reference-analysis.ts，并登记进上面的 SHARED_TOOL_INFRA；
 *   inlined-copies-sync.test.ts 一并删除（它守的东西不存在了）。
 *   改判理由：① 兜底必须永远在（副本若改成插件订阅会随插件消失）；
 *             ② 子代理跑同一套 stages，核心消费者自动覆盖，而插件订阅形态会漏掉它们。
 *   注意：这不是"给规则 6 开口子"—— 登记的是**共享基础设施**，不是工具间耦合；
 *   KNOWN_TOOL_COUPLINGS 依旧空集。
 *
 * **空集就是目标状态**：从此任何新出现的"工具依赖工具"都会被规则 6 直接拦下，
 * 不再有"已登记待修"这种中间态可以塞进去。
 */
export const KNOWN_TOOL_COUPLINGS = new Set();
