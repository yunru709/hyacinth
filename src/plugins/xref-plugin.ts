/**
 * Xref 插件（P4 第一个）—— 代码交叉引用工具插件化。
 *
 * 原为 gateway/factory.ts 的 ~8 行内联装配（573-586）：new XrefManager +
 * init(cwd) + 注册 XrefBuild/Query/Graph 三个工具。
 * 自包含度最高：只依赖 cwd + toolRegistry，不依赖 loop/其他插件，
 * 是 P4 规模化迁移的零成本起点。
 *
 * 与 knowledge 模式一致：引擎留 src/tools/xref/，本文件提供 HyPlugin 包装，
 * activate 时经 ctx.registerTool 注册工具，disposer 里关闭 SQLite 连接。
 */
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';

export const XREF_PLUGIN_ID = 'xref';

export interface XrefPluginServices {
  cwd: string;
}

export function createXrefPlugin(
  services: XrefPluginServices,
): HyPlugin<Record<string, unknown>, LoopHooks> {
  return {
    id: XREF_PLUGIN_ID,

    async activate(ctx: PluginContext<Record<string, unknown>, LoopHooks>) {
      const { XrefManager, XrefBuildTool, XrefQueryTool, XrefGraphTool } = await import('../tools/xref/index.js');
      const xrefManager = new XrefManager();
      try {
        await xrefManager.init(services.cwd);
      } catch {
        // xref 初始化失败不影响核心功能（如 node:sqlite 不可用等）
        ctx.logger.warn('xref init failed, plugin idle');
        return;
      }

      ctx.registerTool(new XrefBuildTool(xrefManager));
      ctx.registerTool(new XrefQueryTool(xrefManager));
      ctx.registerTool(new XrefGraphTool(xrefManager));

      // Phase 6：把「引用分析能力」注册进宿主服务表。
      // ctx.register 的 disposer 会在**卸载时把服务恢复为注册前的值**（热替换可回滚），
      // 正是任务单要的"挂载即注册、卸载即摘除"。
      // 消费侧（loop-tools 后置序列）经 loop.pluginHost.get('referenceAnalysis') 取用；
      // 取不到时自动退回核心内置的字符串扫描兜底 —— 故卸载后行为等于"从未挂载过"。
      // ── [圈三锚点 · 首条绑定] ────────────────────────────────────────────
      // 这是**第一条**真实联动绑定（消费者=核心后置序列，提供方=xref 能力）。
      // 第三圈接入时，这一行（ctx.register）由"声明清单驱动"取代/包一层 ——
      // 关系写进 tool-links.json，handler id 在此注册。
      // 触发条件：第二个真实联动用例出现（见 docs/design/tool-linkage-laws.md）
      const { createReferenceAnalysisCapability } = await import('../tools/xref/reference-capability.js');
      ctx.register('referenceAnalysis', createReferenceAnalysisCapability(xrefManager) as never);

      // 卸载时关闭 SQLite 连接
      ctx.add({
        dispose: () => { try { xrefManager.close(); } catch { /* ignore */ } },
      });

      ctx.logger.info('xref plugin activated');
    },
  };
}
