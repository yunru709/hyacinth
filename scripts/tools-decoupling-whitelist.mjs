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
]);

/**
 * 已登记的违规（**只减不增**）。修掉就删对应条目。
 * 每条格式：`<from 模块 basename>→<to 模块 basename>`
 */
export const KNOWN_TOOL_COUPLINGS = new Set([
  'write→symbol-references',  // 待修：应改为"分析订阅变更"而非"写工具调用分析"
  'edit→symbol-references',   // 同上
]);
