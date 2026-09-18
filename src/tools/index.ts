// === 导出所有模块 ===
//
// 工具注册规范（供人类和 AI Agent 共同遵守）：
//
//   所有 Tool 必须通过注册表统一注册，禁止在业务代码中硬编码 new XXXTool() 调用。
//
//   内置工具（启动即注册，始终可用）：
//     → createDefaultRegistry() / createBuiltInTools()
//
//   运行时控制工具（依赖 AgentLoop 等运行时实例）：
//     → tool.registry.ts → registerRuntimeControlTools()
//
//   热插拔工具（会话临时，无需重启）：
//     → registry.register(...) 或 createPluginTool()
//
//   新增工具的正确流程：
//     1. 新建 src/tools/xxx.ts，实现 Tool 接口
//     2. 在 createDefaultRegistry() 中注册（内置工具）
//        或在 registerRuntimeControlTools() 中注册（运行时工具）
//     3. 禁止在 factory.ts / loop.ts 中直接 new Tool() 并硬编码调用
//
//   路径规范：
//     - Tool 实现: src/tools/xxx.ts
//     - 注册入口: src/tools/index.ts (内置) / src/registry/tool.registry.ts (运行时)
//     - 禁止写在 src/gateway/、src/orchestrator/ 等业务目录
export type { Tool } from './interface.js';
export type { SandboxConfig } from './bash.js';
export { ToolRegistry } from './registry.js';
export { ReadTool } from './read.js';
export { WriteTool } from './write.js';
export { EditTool } from './edit.js';
export { BashTool } from './bash.js';
export { GlobTool } from './glob.js';
export { GrepTool } from './grep.js';
export { ProbeTool } from './probe.js';
export { GitTool } from './git-tool.js';
export { MultiEditTool } from './multi-edit.js';
export { InsertTool } from './insert.js';
export { RestartTool } from './restart.js';
export { DiffFilesTool } from './diff-files.js';
export { JsonEditTool } from './json-edit.js';
export { HttpRequestTool } from './http-request.js';
export { ArchiveTool } from './archive.js';
export { DbQueryTool } from './db-query.js';
export { DiskUsageTool } from './disk-usage.js';
export { GenerateMediaTool } from './generate-media.js';
export { XrefManager, XrefBuildTool, XrefQueryTool, XrefGraphTool } from './xref/index.js';
export { PythonToolBridge } from './python-bridge/index.js';
export type { PythonToolMeta } from './python-bridge/index.js';
export { ToolExecutor } from './executor.js';
export { ToolResultBuffer } from './result-buffer.js';
export type { ResultBufferConfig } from './result-buffer.js';

// === 创建默认工具注册表 ===
import { ToolRegistry } from './registry.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { BashTool } from './bash.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { ProbeTool } from './probe.js';
import { GitTool } from './git-tool.js';
import { MultiEditTool } from './multi-edit.js';
import { InsertTool } from './insert.js';
import { RestartTool } from './restart.js';
import { DiffFilesTool } from './diff-files.js';
import { JsonEditTool } from './json-edit.js';
import { HttpRequestTool } from './http-request.js';
import { ArchiveTool } from './archive.js';
import { DbQueryTool } from './db-query.js';
import { DiskUsageTool } from './disk-usage.js';
import { GenerateMediaTool } from './generate-media.js';
import type { SandboxConfig } from './bash.js';
import type { GitManager } from '../evolution/git-manager.js';

/**
 * 创建包含所有内置工具的默认注册表（不包含 GitTool，需要 GitManager 实例）
 * @param cwd BashTool 的工作目录，默认为 process.cwd()
 * @param sandboxConfig 可选沙箱配置，传入后 BashTool 将启用命令拦截
 * @param sessionId 当前 session ID（供 RestartTool 写入重启标记，按渠道精确恢复）
 * @param channel 当前渠道（'tui' | 'feishu' 等，供 RestartTool 渠道隔离）
 */
export function createDefaultRegistry(
  cwd?: string,
  sandboxConfig?: SandboxConfig,
  sessionId?: string,
  channel?: string,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadTool());
  registry.register(new WriteTool());
  registry.register(new EditTool());
  registry.register(new BashTool(cwd, sandboxConfig));
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  // probe 与 grep 同族（都是"在文件里找东西"），紧跟其后注册：
  // grep 面向文本行，probe 面向二进制/超大/编码混杂文件的"上下文窗口"。
  registry.register(new ProbeTool());
  registry.register(new MultiEditTool());
  registry.register(new InsertTool());
  registry.register(new RestartTool(cwd ?? process.cwd(), sessionId, channel));
  registry.register(new DiffFilesTool());
  registry.register(new JsonEditTool());
  registry.register(new HttpRequestTool());
  registry.register(new ArchiveTool());
  registry.register(new DbQueryTool());
  registry.register(new DiskUsageTool(cwd));
  registry.register(new GenerateMediaTool(cwd));
  return registry;
}

/**
 * 创建包含所有内置工具的注册表（含 GitTool）
 * @param gitManager GitManager 实例
 * @param sessionId 可选 sessionId，用于 commit message 追溯
 * @param cwd BashTool 的工作目录，默认为 process.cwd()
 * @param sandboxConfig 可选沙箱配置
 */
export function createBuiltInTools(
  gitManager: GitManager,
  sessionId?: string,
  cwd?: string,
  sandboxConfig?: SandboxConfig,
  channel?: string,
): ToolRegistry {
  const registry = createDefaultRegistry(cwd, sandboxConfig, sessionId, channel);
  registry.register(new GitTool(gitManager, sessionId));
  return registry;
}
