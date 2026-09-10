/**
 * tui-model-local.ts —— model/local/* L2 子命令模块（tui.ts 深拆第五批）。
 *
 * 从 handleSlashSubCommand 的 model/local/* 8 个 case 迁出（start/stop/
 * status/switch/register/unregister/detect），作为「命令处理器外移」的
 * 第一个样板：命令以工厂 createModelLocalCmds(deps) 返回的 handle(path,args)
 * 形式对外，调用方（tui.ts）的 case 只保留一行转发。
 *
 * 行为零变更：本地后端检测/启动/停止/状态/注册/注销/切换的全部提示文案
 * 与异步时序原样保留。外部状态 modelName/providerTypeStart 经
 * setModelName/setProviderTypeStart 回调写回（不动 runTui 的 let 绑定）。
 */

import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';
import type { LocalModelModule } from '../local-model/index.js';

/** model/local/* 命令的最小依赖面 */
export interface TuiModelLocalDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  localModel: Pick<
    LocalModelModule,
    | 'checkOllama' | 'checkLlamacpp' | 'list' | 'getBridge'
    | 'start' | 'scanUnregistered' | 'registerModel' | 'unregister'
  >;
  supervisor: {
    startOllamaOnDemand(cwd: string): Promise<unknown>;
    stopModel(name: string): Promise<void>;
  };
  protocolSend: (method: string, params?: unknown) => Promise<unknown>;
  setConfig: (path: string, value: unknown) => Promise<void>;
  refreshStatusFromProtocol: () => Promise<void>;
}

/** 创建 model/local/* 命令处理器 */
export function createModelLocalCmds(deps: TuiModelLocalDeps) {
  const { tui, chatLog, localModel, supervisor, protocolSend, setConfig, refreshStatusFromProtocol } = deps;

  /** 执行一个 model/local/* 子命令（cmdPath 形如 'model/local/start'） */
  async function handle(cmdPath: string, restArgs: string): Promise<void> {
    switch (cmdPath) {
      // ── 本地模型 L2: model/local/start ──
      case 'model/local/start': {
        const { detectLocalBackend } = await import('../provider/local-config.js');
        const detected = await detectLocalBackend();
        const ollamaBin = localModel.checkOllama();
        const llamacppBin = localModel.checkLlamacpp();

        const backend = restArgs?.toLowerCase();
        const validBackend = backend === 'ollama' || backend === 'llamacpp' || backend === 'llama.cpp';

        // 指定了 backend → 启动那个
        if (validBackend) {
          const target = (backend === 'llamacpp' || backend === 'llama.cpp') ? 'llamacpp' : 'ollama';
          if (target === 'ollama' && ollamaBin) {
            if (detected?.backend === 'ollama') {
              chatLog.addSystem(theme.success('Ollama 已在运行。使用 /model/local/switch 切换。'));
            } else {
              chatLog.addSystem(theme.accent('启动 Ollama...'));
              const info = await supervisor.startOllamaOnDemand(process.cwd());
              chatLog.addSystem(info ? theme.success('Ollama 已启动（框架管理进程）。') : theme.warning('启动失败，请手动运行 ollama serve。'));
            }
          } else if (target === 'llamacpp' && llamacppBin) {
            const regModels = localModel.list();
            if (regModels.length === 0) {
              chatLog.addSystem(theme.warning('无注册的 llama.cpp 模型。请先用 /model/local/register 注册。'));
            } else {
              localModel.start(regModels[0].name).then(async (info) => {
                if (info) {
                  await setConfig('provider.local', { type: 'local', model: info.modelFile ?? regModels[0].name, baseUrl: info.baseUrl });
                  await setConfig('provider.local.modelKey', regModels[0].name);
                  try { await protocolSend('model.switch', { provider: 'local' }); await setConfig('provider.active', 'local'); chatLog.addSystem(theme.success(`llama.cpp ${regModels[0].name} started`)); await refreshStatusFromProtocol(); }
                  catch (swErr) { chatLog.addSystem(theme.error(`Switch failed: ${(swErr as Error).message}`)); }
                }
                tui.requestRender();
              }).catch((e) => { chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`)); tui.requestRender(); });
            }
          } else {
            chatLog.addSystem(theme.warning(`${backend} 未安装。`));
          }
          tui.requestRender();
          return;
        }

        // 指定了已注册模型名 → 按名启动
        if (restArgs) {
          const lm = localModel.list().find((m: { name: string }) => m.name === restArgs);
          if (lm) {
            localModel.start(restArgs).then(async (info) => {
              if (info) {
                await setConfig('provider.local', { type: 'local', model: info.modelFile ?? restArgs, baseUrl: info.baseUrl });
                await setConfig('provider.local.modelKey', restArgs);
                try { await protocolSend('model.switch', { provider: 'local' }); await setConfig('provider.active', 'local'); chatLog.addSystem(theme.success(`${restArgs} started on port ${info.port}`)); await refreshStatusFromProtocol(); }
                catch (swErr) { chatLog.addSystem(theme.error(`Switch failed: ${(swErr as Error).message}`)); }
              } else { chatLog.addSystem(theme.error(`Failed to start ${restArgs}`)); }
              tui.requestRender();
            }).catch((e) => { chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`)); tui.requestRender(); });
          } else {
            chatLog.addSystem(theme.warning(`Model "${restArgs}" not registered. Available: ${localModel.list().map((m: { name: string }) => m.name).join(', ') || 'none'}`));
            chatLog.addSystem(theme.dim('To start a backend: /model/local start ollama | /model/local start llamacpp'));
            tui.requestRender();
          }
          return;
        }

        // 无参 → 列出可用选项
        chatLog.addSystem(theme.fg('── 可用本地后端 ──'));
        if (detected) chatLog.addSystem(theme.success(`${detected.backend} 正在运行 — ${detected.baseUrl}`));
        if (ollamaBin) chatLog.addSystem(theme.dim(`Ollama ${detected?.backend === 'ollama' ? '(运行中)' : '— /model/local start ollama'}`));
        if (llamacppBin) chatLog.addSystem(theme.dim(`llama.cpp ${detected?.backend === 'llamacpp' ? '(运行中)' : '— /model/local start llamacpp'}`));
        if (!ollamaBin && !llamacppBin) chatLog.addSystem(theme.warning('本地模型服务未配置。请安装 Ollama 或 llama.cpp。'));
        const reg = localModel.list();
        if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/stop ──
      case 'model/local/stop': {
        const { detectLocalBackend } = await import('../provider/local-config.js');
        const detected = await detectLocalBackend();
        const backend = restArgs?.toLowerCase();
        if (backend === 'ollama') {
          if (detected?.backend === 'ollama') {
            try { await supervisor.stopModel('ollama'); chatLog.addSystem(theme.success('Ollama 已停止。')); }
            catch { chatLog.addSystem(theme.warning('无法停止 Ollama。请手动执行 ollama stop。')); }
          } else { chatLog.addSystem(theme.dim('Ollama 未在运行。')); }
          tui.requestRender(); return;
        }
        if (backend === 'llamacpp' || backend === 'llama.cpp') {
          const running = localModel.getBridge().getAllStatus().filter((s: { state: string }) => s.state === 'running');
          if (running.length > 0) { for (const m of running) { localModel.getBridge().stop(m.name).catch(() => {}); chatLog.addSystem(theme.success(`Stopped: ${m.name}`)); } }
          else { chatLog.addSystem(theme.dim('llama.cpp 未在运行。')); }
          tui.requestRender(); return;
        }
        // 无参 → 停止所有
        let stopped = 0;
        if (detected?.backend === 'ollama') {
          try { await supervisor.stopModel('ollama'); stopped++; chatLog.addSystem(theme.success('Ollama 已停止。')); }
          catch { chatLog.addSystem(theme.warning('无法停止 Ollama。')); }
        }
        const running = localModel.getBridge().getAllStatus().filter((s: { state: string }) => s.state === 'running');
        for (const m of running) { localModel.getBridge().stop(m.name).catch(() => {}); stopped++; chatLog.addSystem(theme.success(`Stopped: ${m.name}`)); }
        if (stopped === 0) chatLog.addSystem(theme.dim('没有运行中的本地服务。'));
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/status ──
      case 'model/local/status': {
        const { detectLocalBackend } = await import('../provider/local-config.js');
        const detected = await detectLocalBackend();
        const ollamaBin = localModel.checkOllama();
        const llamacppBin = localModel.checkLlamacpp();
        chatLog.addSystem(theme.fg('── 本地模型状态 ──'));
        chatLog.addSystem(detected ? theme.success(`运行中: ${detected.backend} — ${detected.baseUrl}`) : theme.dim('运行中: 无'));
        chatLog.addSystem(theme.dim(`Ollama: ${ollamaBin ? '已安装' : '未安装'}  |  llama.cpp: ${llamacppBin ? '已安装' : '未安装'}`));
        const reg = localModel.list();
        if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/switch ──
      case 'model/local/switch': {
        try {
          await protocolSend('model.switch', { provider: 'local' });
          // 显式持久化 provider 选择（switchProvider 不再负责持久化）
          await setConfig('provider.active', 'local');
          // provider/model 缓存由 refreshStatusFromProtocol 经 state.get 读回
          // （不再直读 loop.getActiveProvider —— 纯协议客户端化）
          chatLog.addSystem(theme.success('Switched to local'));
          await refreshStatusFromProtocol();
        } catch (err) {
          chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
        }
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/register ──
      case 'model/local/register': {
        const found = await localModel.scanUnregistered();
        if (found.length === 0) {
          chatLog.addSystem(theme.dim('无新模型。已检查 models/ 目录 (GGUF) 和 ollama list。'));
        } else {
          for (const f of found) {
            localModel.registerModel({ name: f.name, modelFile: f.modelFile, backend: f.backend as 'llama.cpp' | 'ollama' | undefined });
            chatLog.addSystem(theme.success(`Registered: ${f.name} (${f.backend ?? 'llama.cpp'})`));
          }
        }
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/unregister ──
      case 'model/local/unregister': {
        if (!restArgs) { chatLog.addSystem(theme.warning('Usage: /model/local unregister <name>')); tui.requestRender(); return; }
        chatLog.addSystem(theme.success(localModel.unregister(restArgs)));
        tui.requestRender();
        return;
      }

      // ── 本地模型 L2: model/local/detect ──
      case 'model/local/detect': {
        const { detectLocalBackend } = await import('../provider/local-config.js');
        const detected = await detectLocalBackend();
        const ollamaBin = localModel.checkOllama();
        const llamacppBin = localModel.checkLlamacpp();
        chatLog.addSystem(theme.fg('── 本地模型检测 ──'));
        chatLog.addSystem(detected ? theme.success(`运行中: ${detected.backend} — ${detected.baseUrl}`) : theme.dim('运行中: 无'));
        chatLog.addSystem(theme.dim(`Ollama: ${ollamaBin ? '已安装 (' + ollamaBin + ')' : '未安装'}`));
        chatLog.addSystem(theme.dim(`llama.cpp: ${llamacppBin ? '已安装 (' + llamacppBin + ')' : '未安装'}`));
        const reg = localModel.list();
        if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
        tui.requestRender();
        return;
      }

      default:
        // 未匹配 → 静默返回（调用方兜底提示）
        return;
    }
  }

  return { handle };
}

export type TuiModelLocalCmds = ReturnType<typeof createModelLocalCmds>;
