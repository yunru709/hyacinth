# 安全内核（Security Kernel）

> 版本：P0 ｜ 日期：2026-09-05 ｜ 位置：`src/kernel/security/`
>
> 参照项目：**dsh**（fail-closed、诚实上报、凭据不进子进程环境）、**Codex**（危险命令规则集、常量时间密钥比较、`.git` 写保护、网络过中介）、**opencode**（工具×路径权限、命令结构分析）、**OpenClaw**（入站面"不能审批就拒绝"）。

## 1. 内核是什么

Hyacinth 的安全 historically 分散在各模块内部（bash 黑名单、审批链、注入过滤），带来两个结构性问题：

1. **意图-效果鸿沟**：策略层看到的是调用文本（`"npm install"`），真正的效果发生在子进程里（postinstall 任意代码）；
2. **安全是"组合的属性"而非"平台的属性"**：插件/热重载/模块替换可以绕过任何模块内自保。

安全内核把裁决点下沉到**进程 IO 边界**（`child_process` / `http(s)` / `fetch` 的 node API 层），使保护成为平台属性：

- 35 处进程创建、30 处出站网络调用点**零改动**，全部经由守卫；
- 写文件类工具（write/edit/multi_edit/insert）在工具层加装**工作区围栏**（读不受限）；
- `beforeToolExecute` 钩子从"通知（丢弃返回值）"升级为"可拒绝的门禁"。

## 2. 安装机制（为什么可行）

`scripts/security-spike.mjs` 在 Node v24.11.1 上实测过两种方案：

| 方案 | 结论 |
|---|---|
| loader hooks（`module.register`）重定向内建 | ESM 全链路可行，但 **CJS `require('node:child_process')` 重定向会崩在 `loadBuiltinWithHooks`**——而仓库 node_modules 有 38 处这种调用（commander、@anthropic-ai/sdk 等） |
| **CJS 内建对象原地变异**（采用） | `require('node:child_process')` 返回进程级单例，变异后所有后续 require 实时可见；ESM 具名导入在链接时快照——只要 bootstrap 先于业务模块图运行，快照到的就是守卫版 |

因此 `src/index.ts` 的形态是刻意的：**静态只 import 内核，其余全部动态 import**：

```ts
import { bootstrapSecurity } from './kernel/security/index.js';
bootstrapSecurity();
const { runCli } = await import('./gateway/cli.js');  // 业务模块图此后才加载
```

guardian 守护拉起的子进程走同一入口，自动继承安装。

## 3. 三域策略

### 3.1 进程域（`policy.ts` checkProcess）
- **硬拒绝清单**（对一切调用生效，含框架自身）：`rm -rf /`、`mkfs`、`dd if=`、fork 炸弹、`format C:`、`diskpart`、`vssadmin delete`、`bcdedit`、`reg delete HK`、`cipher /w`、盘根级 `Remove-Item`/`del`/`rd`。命中即拒绝 + 审计。
- **环境守卫**（env-guard，参照 dsh"凭据永不物化进子进程环境"）：`.env` 注册键**始终剥离**；`*API_KEY/*SECRET/*PASSWORD/*CREDENTIAL/*PRIVATE_KEY` 命名键在 **LLM 归因调用**时剥离；`TOKEN` 不做模式剥离（MCP 配置 env 的合法常见键）。守卫透传全部 opts、返回真实 ChildProcess——bash 后台句柄/超时/AbortSignal 语义不变。

### 3.2 网络域（checkNetwork / fetch + http(s) request/get 守卫）
- 仅对**归因调用**生效；框架自身调用（provider、渠道客户端、本地模型健康检查）不受限。
- 私网/SSRF 拦截：10/8、172.16/12、192.168/16、169.254/16（含云元数据地址）、`::1`（可配）、IPv6 ULA/链路本地。回环 127.0.0.1 默认放行（本地开发常态）。
- `kind: 'channel'` 归因只审计不拦（避免破坏局域网媒体地址）。
- 工具层双保险：`http_request` 工具在 fetch 前再查一次 URL。

### 3.3 文件域（工具层工作区围栏，`tools/path-sandbox.ts` applyWorkspaceFence）
- 写类工具（write/edit/multi_edit/insert）只许写 `security.workspaceRoot`（默认项目 cwd）之内，且**拒绝一切 `.git` 路径**（Codex WritableRoot 思想：git hook 是跨会话存活的执行点）。
- read/grep/glob 不受限——读外部是合法需求，写外部才是"不利影响"。
- bash 不在此拦：Windows 下命令本体在临时 .ps1 里（内核只见 `powershell -File` argv），内容级检查由 bash.ts 的 `classifyCommand`（工具层）完成，Unix 下内核可见原始命令，双保险。

## 4. 归因模型（attribution）

`AsyncLocalStorage` 标记"本次 IO 由谁驱动"，包裹点全库仅三处：

| 包裹点 | 归因 | 效果 |
|---|---|---|
| `tools/executor.ts` execute() | `tool` | 批量工具执行期 spawn/fetch 受最严策略 |
| `orchestrator/loop-tools.ts` runToolInline | `tool` | SSE 流内路径同权 |
| `gateway/runtime-wiring.ts` 定时任务 | `schedule` | LLM 经 add_task 写入的命令按 LLM 驱动裁决 |

无归因 = 框架自身调用，只做 env 守卫。

## 5. 审计与完整性

- **审计**：deny/降级/模式切换事件追加 `~/.agent/audit.jsonl`（JSONL，复用 memory/events.ts 形态）。审计失败绝不打断业务。
- **完整性 canary**（integrity.ts，参照 dsh probe）：bootstrap 结束、每次插件 mount（`AgentLoop.mountPlugin`）后核验守卫标记；被拆 → 状态 `degraded` + 审计 + LLM 归因进程创建 fail-closed。状态三档：`on / degraded / off`。

## 6. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| env `HYACINTH_SECURITY_MODE` | `enforce` | `enforce`（拦截+审计）/ `observe`（只审计，排障）/ `off`（完全关闭） |
| `security.mode` | `enforce` | 同上（configCenter 键，P1 登记 schema） |
| `security.workspaceRoot` | 项目 cwd | 工作区围栏根 |
| `security.network.blockPrivate` | `true` | 归因调用拦私网 |
| `security.network.allowLoopback` | `true` | 私网拦截放行回环 |

## 7. 本次同步修复的框架级缝

1. **工具注册表同名覆盖无门禁**（`registry/base.ts`）→ ToolRegistry 设 overwriteGuard：内置工具不可被 plugin/mcp/file/user 替换（同源重注册不受影响）。
2. **`beforeToolExecute` 钩子返回值被丢弃** → 门禁下沉到 `runToolDispatch`/`runToolInline`，拦截器（permission-chain）的剔除真实生效，被剔除调用写回 denied tool_result。
3. **HTTP 渠道危险工具自动放行**（`http-webhook.ts` CollectHandler 返回 `true`）→ fail-closed 返回 `'no'`（渠道无审批 UI，不能审批就拒绝）。
4. **fastify 默认绑 `0.0.0.0`** → 默认 `127.0.0.1`；**WS apiKey 为空时放行** → 401 fail-closed；Bearer 明文比较 → `crypto.timingSafeEqual` 常量时间比较。

## 8. TCB 诚实声明（威胁模型边界）

进程内变异**不是**对抗以下威胁的最终边界：

- 同进程运行、带原生 addon 且刻意反制的恶意插件（可绕过变异/反变异）；
- 独立子进程的行为（MCP stdio server 的文件访问——其 env 已脱敏，但文件/网络能力未受限）；
- DNS rebinding 类解析层绕过（私网判定基于主机名，P1 可加 resolve-pin）。

对应缓解路线：P1 插件能力清单（manifest 声明 fs/net/process，未声明注册即拒）+ verify-layers 规则 6（业务模块禁直调被守卫的 node API）+ fs shim 全量覆盖；P2 OS 级隔离（Docker 后端 / Windows AppContainer）。内核的诚实三档状态（`on/degraded/off`）保证了"防护失效时使用者知道"。

## 9. 测试

- `src/kernel/security/security-kernel.test.ts`：安装幂等、CJS 守卫标记、热导入对抗、env 剥离（归因/非归因）、硬拒绝清单、分类器三级、私网矩阵、归因 fetch 拦截。
- `src/orchestrator/loop-tools-gate.test.ts`：拦截器剔除真实生效 + denied 结果写回。
- `src/registry/tool-registry.test.ts`：同名覆盖门禁矩阵。
- `src/tools/path-sandbox.test.ts`：工作区围栏 + `.git` 拒写。
- `src/channels/builtin/http-webhook.test.ts`：WS fail-closed 回归（含"未配置 apiKey 一律 401"新契约）。
