import { useEffect } from 'react';
import { useStore } from '../store';
import type { OnlineProviderInfo, ModelChannelInfo } from '../types';

/** 检测 provider 与 model 名称是否可能不匹配 */
function isProviderModelMismatch(provider: string, model: string): boolean {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (m.includes('claude') && p !== 'anthropic') return true;
  if (m.includes('gpt') && p !== 'openai') return true;
  if (m.includes('deepseek') && p !== 'deepseek') return true;
  if (m.includes('gemini') && p !== 'gemini' && p !== 'google') return true;
  if (m.includes('grok') && p !== 'xai' && p !== 'grok') return true;
  if (m.includes('mistral') && p !== 'mistral') return true;
  return false;
}

export function ModelCenterPanel() {
  const config = useStore(s => s.config);
  const modelStatus = useStore(s => s.modelStatus);
  const webuiConfig = useStore(s => s.webuiConfig);
  const patchConfig = useStore(s => s.patchConfig);
  const fetchConfig = useStore(s => s.fetchConfig);
  const configSaving = useStore(s => s.configSaving);

  // 确保配置已加载
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const provider = config?.provider ?? modelStatus?.provider ?? 'Unknown';
  const model = config?.model ?? modelStatus?.model ?? 'Unknown';
  const routing = modelStatus?.routing ?? { mode: 'auto', isLocal: false };
  const onlineProviders = modelStatus?.onlineProviders ?? [];
  const localModel = modelStatus?.localModel ?? { detected: false, backend: null, running: false, registeredModels: [], note: 'connect to API' };
  const channels = modelStatus?.channels ?? [];
  const roleMappings = modelStatus?.roleMappings ?? {};

  // 从 webuiConfig 读取 thinking 配置，回退到 modelStatus
  const enableThinking = webuiConfig?.provider?.enableThinking ?? modelStatus?.thinking.enableThinking ?? false;
  const showThinking = webuiConfig?.provider?.showThinking ?? modelStatus?.thinking.showThinking ?? false;
  const thinkingEffort = webuiConfig?.provider?.thinkingEffort ?? modelStatus?.thinking.thinkingEffort ?? null;

  const mismatch = isProviderModelMismatch(provider, model);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm" style={{color:'var(--text)'}}>
      {/* ── Current Provider / Model / Routing ── */}
      <div className="card p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>当前模型</div>
        <div className="flex justify-between gap-3">
          <span style={{color:'var(--muted)'}}>提供商</span>
          <span className="truncate font-medium">{provider}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span style={{color:'var(--muted)'}}>模型</span>
          <span className="truncate font-medium">{model}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span style={{color:'var(--muted)'}}>路由</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{background: routing.isLocal ? 'var(--success)' : 'var(--accent)'}} />
            <span className="capitalize">{routing.mode}{routing.isLocal ? ' (本地)' : ' (在线)'}</span>
          </span>
        </div>
        {mismatch && (
          <div className="mt-2 px-2.5 py-2 rounded-md text-[11px] leading-relaxed"
               style={{background:'rgba(245,158,11,0.1)', color:'var(--warning)', border:'1px solid var(--warning)'}}>
            ⚠ 提供商与模型可能不匹配：当前提供商为 {provider}，但模型名 {model} 似乎属于其他提供商。请检查配置文件。
          </div>
        )}
      </div>

      {/* ── Online Providers ── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>在线提供商</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(onlineProviders.length > 0 ? onlineProviders : DEFAULT_ONLINE_PROVIDERS).map((p: OnlineProviderInfo) => (
            <ProviderCard key={p.type} provider={p} isActive={provider === p.type} />
          ))}
        </div>
        <div className="text-[11px] text-center" style={{color:'var(--muted)'}}>
          提供商切换将通过 API 可用
        </div>
      </div>

      {/* ── Local Model Status ── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>本地模型</div>
        </div>

        {!localModel.detected ? (
          <div className="flex items-center justify-center h-16 rounded-lg border border-dashed" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
            <span className="text-xs">未检测到本地模型后端</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex justify-between gap-3">
              <span style={{color:'var(--muted)'}}>后端</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{background: 'var(--success)'}} />
                <span>{localModel.backend ?? '未检测到'}</span>
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span style={{color:'var(--muted)'}}>状态</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{background: localModel.running ? 'var(--success)' : 'var(--warning)'}} />
                <span>{localModel.running ? '运行中' : '已停止'}</span>
              </span>
            </div>

            <div>
              <div className="text-[11px] mb-1.5" style={{color:'var(--muted)'}}>已注册模型</div>
              {localModel.registeredModels.length > 0 ? (
                <div className="space-y-1">
                  {localModel.registeredModels.map((m: string) => (
                    <div key={m} className="text-xs px-2 py-1 rounded border" style={{borderColor:'var(--border)'}}>{m}</div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-16 rounded-lg border border-dashed" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
                  <span className="text-xs">未注册模型 — 连接 API</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Thinking Settings ── */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>思考</div>

        <div className="flex items-center justify-between">
          <span style={{color:'var(--text)'}}>启用思考</span>
          <ToggleSwitch
            checked={enableThinking}
            disabled={configSaving}
            onClick={() => patchConfig({ 'provider.enableThinking': !enableThinking })}
          />
        </div>

        <div className="flex items-center justify-between">
          <span style={{color:'var(--text)'}}>思考深度</span>
          <select
            className="text-xs rounded px-2 py-1"
            style={{background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)'}}
            value={thinkingEffort ?? ''}
            disabled={configSaving}
            onChange={(e) => patchConfig({ 'provider.thinkingEffort': e.target.value })}
          >
            <option value="">默认</option>
            <option value="high">高</option>
            <option value="max">最大</option>
            <option value="4000">4K tokens</option>
            <option value="8000">8K tokens</option>
            <option value="16000">16K tokens</option>
            <option value="32000">32K tokens</option>
          </select>
        </div>

        <div className="flex items-center justify-between">
          <span style={{color:'var(--text)'}}>显示思考</span>
          <ToggleSwitch
            checked={showThinking}
            disabled={configSaving}
            onClick={() => patchConfig({ 'provider.showThinking': !showThinking })}
          />
        </div>
      </div>

      {/* ── Model Channel Routing ── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>模型通道路由</div>
        </div>

        {/* Channels list */}
        <div className="space-y-2">
          <div className="text-[11px]" style={{color:'var(--muted)'}}>通道</div>
          {channels.length > 0 ? (
            channels.map((ch: ModelChannelInfo) => (
              <ChannelCard key={ch.name} channel={ch} />
            ))
          ) : (
            <div className="text-xs text-center py-2" style={{color:'var(--muted)'}}>未配置通道</div>
          )}
        </div>

        {/* Role Mappings */}
        {Object.keys(roleMappings).length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px]" style={{color:'var(--muted)'}}>角色映射</div>
            <div className="space-y-1">
              {Object.entries(roleMappings).map(([role, channel]) => (
                <div key={role} className="flex items-center justify-between text-xs px-2 py-1.5 rounded border" style={{borderColor:'var(--border)'}}>
                  <span className="capitalize">{role}</span>
                  <span className="inline-flex items-center gap-1">
                    <span style={{color:'var(--muted)'}}>→</span>
                    <span style={{color:'var(--accent)'}}>{String(channel)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-center" style={{color:'var(--muted)'}}>
          通道路由将通过 API 配置
        </div>
      </div>
    </div>
  );
}

/** Toggle switch with click handler */
function ToggleSwitch({ checked, disabled, onClick }: { checked: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className="inline-flex items-center rounded-full transition-colors"
      style={{
        width: 36, height: 20, padding: 2,
        background: checked ? 'var(--accent)' : 'var(--border)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
      }}
    >
      <span
        className="inline-block rounded-full bg-white transition-transform"
        style={{
          width: 16, height: 16,
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        }}
      />
    </button>
  );
}

/** Provider card in the online providers grid */
function ProviderCard({ provider, isActive }: { provider: OnlineProviderInfo; isActive: boolean }) {
  return (
    <div
      className="rounded-lg border px-2 py-2 text-xs transition-colors"
      style={{
        borderColor: isActive ? 'var(--accent)' : 'var(--border)',
        background: isActive ? 'rgba(79,142,247,0.08)' : 'var(--bg)',
        opacity: isActive ? 1 : 0.85,
      }}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        {isActive && <span className="w-1 h-1 rounded-full flex-shrink-0" style={{background:'var(--accent)'}} />}
        <span className="font-medium truncate" style={{color: isActive ? 'var(--accent)' : 'var(--text)'}}>{provider.name}</span>
      </div>
      <div className="text-[10px] leading-tight" style={{color:'var(--muted)'}}>{provider.description}</div>
    </div>
  );
}

/** Channel card */
function ChannelCard({ channel }: { channel: ModelChannelInfo }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs" style={{borderColor:'var(--border)', background:'var(--bg)'}}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium" style={{color:'var(--text)'}}>{channel.name}</span>
        <span style={{color:'var(--muted)'}}>{channel.provider}/{channel.model}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {channel.roles.map(r => (
          <span key={r} className="text-[10px] px-1.5 py-0.5 rounded" style={{background:'var(--border)', color:'var(--text-dim)'}}>{r}</span>
        ))}
      </div>
    </div>
  );
}

/** Default online providers fallback when API data is not yet available */
const DEFAULT_ONLINE_PROVIDERS: OnlineProviderInfo[] = [
  { name: 'Anthropic', type: 'anthropic', description: 'Claude Opus 4, Sonnet 4', status: 'available' },
  { name: 'OpenAI', type: 'openai', description: 'GPT-4o, GPT-4.1', status: 'available' },
  { name: 'DeepSeek', type: 'deepseek', description: 'DeepSeek V4', status: 'available' },
  { name: 'Gemini', type: 'gemini', description: 'Gemini 2.5 Pro', status: 'available' },
  { name: 'Groq', type: 'groq', description: 'Llama 4, Mixtral', status: 'available' },
  { name: 'xAI', type: 'xai', description: 'Grok 3', status: 'available' },
  { name: 'Mistral', type: 'mistral', description: 'Mistral Large 2', status: 'available' },
  { name: 'OpenRouter', type: 'openrouter', description: 'Multi-provider', status: 'available' },
];
