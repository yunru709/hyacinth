import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { OnlineProviderInfo, ModelChannelInfo } from '../types';
import { EmptyState, LoadingState } from './ui/PanelStates';

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

interface ModelCenterPanelProps {
  switchProvider: (provider: string) => void;
  switchModel: (model: string) => void;
}

export function ModelCenterPanel({ switchProvider, switchModel }: ModelCenterPanelProps) {
  const config = useStore(s => s.config);
  const modelStatus = useStore(s => s.modelStatus);
  const webuiConfig = useStore(s => s.webuiConfig);
  const patchConfig = useStore(s => s.patchConfig);
  const fetchConfig = useStore(s => s.fetchConfig);
  const configSaving = useStore(s => s.configSaving);
  const localModelLoading = useStore(s => s.localModelLoading);
  const channelLoading = useStore(s => s.channelLoading);
  const detectLocalModels = useStore(s => s.detectLocalModels);
  const registerLocalModels = useStore(s => s.registerLocalModels);
  const unregisterLocalModel = useStore(s => s.unregisterLocalModel);
  const startLocalModel = useStore(s => s.startLocalModel);
  const stopLocalModel = useStore(s => s.stopLocalModel);
  const switchLocalModel = useStore(s => s.switchLocalModel);
  const refreshModelStatus = useStore(s => s.refreshModelStatus);
  const addChannel = useStore(s => s.addChannel);
  const removeChannel = useStore(s => s.removeChannel);
  const setRoleMapping = useStore(s => s.setRoleMapping);

  // 本地检测结果的临时状态（用于显示安装情况）
  const [detectResult, setDetectResult] = useState<{ ollamaInstalled: boolean; llamacppInstalled: boolean } | null>(null);
  const [localModelInput, setLocalModelInput] = useState('');
  const [channelForm, setChannelForm] = useState({ name: '', provider: '', model: '', description: '' });
  const [roleForm, setRoleForm] = useState({ role: '', channel: '' });

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

  const handleDetect = async () => {
    const result = await detectLocalModels();
    if (result) {
      setDetectResult({ ollamaInstalled: result.ollamaInstalled, llamacppInstalled: result.llamacppInstalled });
    }
    await refreshModelStatus();
  };

  const handleRegister = async () => {
    await registerLocalModels();
    await refreshModelStatus();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm" style={{color:'var(--text)'}}>
      {/* ── 当前状态 ── */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>当前状态</div>
        <div className="space-y-2">
          <div className="flex justify-between gap-3">
            <span style={{color:'var(--muted)'}}>提供商</span>
            <span className="truncate font-medium">{provider}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{color:'var(--muted)'}}>模型</span>
            <span className="truncate font-medium">{model}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{color:'var(--muted)'}}>运行模式</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{background: routing.isLocal ? 'var(--success)' : 'var(--accent)'}} />
              <span>{routing.isLocal ? '本地模型' : '在线模型'}</span>
            </span>
          </div>
        </div>
        {mismatch && (
          <div className="mt-2 px-2.5 py-2 rounded-md text-[11px] leading-relaxed"
               style={{background:'rgba(245,158,11,0.1)', color:'var(--warning)', border:'1px solid var(--warning)'}}>
            ⚠ 提供商与模型不匹配：当前提供商为 {provider}，但模型名 {model} 似乎属于其他提供商。
          </div>
        )}
      </div>

      {/* ── 在线模型 ── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>在线模型提供商</div>
          <button
            onClick={refreshModelStatus}
            disabled={localModelLoading}
            className="btn btn-sm btn-ghost"
            title="刷新状态"
          >
            刷新
          </button>
        </div>
        <div className="text-[11px] leading-relaxed" style={{color:'var(--muted)'}}>
          点击提供商切换，已配置的提供商会显示 ✓ 标记。切换后可修改模型名。
        </div>
        <div className="grid grid-cols-1 gap-2">
          {(onlineProviders.length > 0 ? onlineProviders : DEFAULT_ONLINE_PROVIDERS).map((p: OnlineProviderInfo) => (
            <ProviderCard
              key={p.type}
              provider={p}
              isActive={provider === p.type && !routing.isLocal}
              onClick={() => switchProvider(p.type)}
            />
          ))}
        </div>
      </div>

      {/* ── 自定义模型名 ── */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>自定义模型名</div>
        <div className="text-[11px] leading-relaxed" style={{color:'var(--muted)'}}>
          修改当前提供商使用的模型名称。例如 DeepSeek 提供商可以使用 deepseek-chat 或 deepseek-coder。
        </div>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            className="input w-full text-xs"
            placeholder="输入模型名，如 deepseek-chat"
            defaultValue={model}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                switchModel((e.target as HTMLInputElement).value);
              }
            }}
          />
          <button
            onClick={(e) => {
              const input = (e.currentTarget.previousElementSibling as HTMLInputElement);
              switchModel(input.value);
            }}
            className="btn btn-primary btn-sm w-full"
            disabled={configSaving}
          >
            应用模型名
          </button>
        </div>
      </div>

      {/* ── 本地模型 ── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>本地模型</div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleDetect}
              disabled={localModelLoading}
              className="btn btn-sm btn-ghost"
              title="检测本地后端（Ollama/llama.cpp）"
            >
              {localModelLoading ? '检测中...' : '检测'}
            </button>
            <button
              onClick={refreshModelStatus}
              disabled={localModelLoading}
              className="btn btn-sm btn-ghost"
              title="刷新状态"
            >
              刷新
            </button>
          </div>
        </div>

        {!localModel.detected ? (
          <div className="space-y-3">
            <EmptyState icon="💻" text="未检测到本地模型后端" hint="点击检测按钮扫描 Ollama 或 llama.cpp" />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleDetect} disabled={localModelLoading} className="btn btn-sm btn-primary">检测后端</button>
              <button onClick={handleRegister} disabled={localModelLoading} className="btn btn-sm">扫描注册</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 后端状态 */}
            <div className="grid grid-cols-1 gap-2 text-xs">
              <div className="flex justify-between gap-2">
                <span style={{color:'var(--muted)'}}>Ollama</span>
                <span>{detectResult?.ollamaInstalled ? '已安装' : localModel.backend === 'ollama' ? '运行中' : '未检测到'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{color:'var(--muted)'}}>llama.cpp</span>
                <span>{detectResult?.llamacppInstalled ? '已安装' : localModel.backend === 'llamacpp' ? '运行中' : '未检测到'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{color:'var(--muted)'}}>当前后端</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{background: 'var(--success)'}} />
                  <span>{localModel.backend ?? '未检测到'}</span>
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{color:'var(--muted)'}}>运行状态</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{background: localModel.running ? 'var(--success)' : 'var(--warning)'}} />
                  <span>{localModel.running ? '运行中' : '已停止'}</span>
                </span>
              </div>
            </div>

            {/* 已注册模型 */}
            <div>
              <div className="text-[11px] mb-1.5" style={{color:'var(--muted)'}}>已注册模型</div>
              {localModel.registeredModels.length > 0 ? (
                <div className="space-y-1">
                  {localModel.registeredModels.map((m: string) => (
                    <div key={m} className="flex items-center justify-between text-xs px-2 py-1.5 rounded border" style={{borderColor:'var(--border)'}}>
                      <span className="truncate pr-2">{m}</span>
                      <div className="flex items-center flex-wrap justify-end gap-1">
                        <button
                          onClick={() => { switchLocalModel(m).then(refreshModelStatus); }}
                          disabled={localModelLoading}
                          className="px-2 py-1 rounded text-[10px] hover:opacity-80 min-w-[2rem]"
                          style={{background:'var(--success)', color:'#fff'}}
                          title="切换并使用此模型"
                        >
                          使用
                        </button>
                        <button
                          onClick={() => { unregisterLocalModel(m).then(refreshModelStatus); }}
                          disabled={localModelLoading}
                          className="px-2 py-1 rounded text-[10px] hover:opacity-80 min-w-[2rem]"
                          style={{background:'var(--danger)', color:'#fff'}}
                          title="注销此模型"
                        >
                          注销
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon="🧩" text="未注册模型" hint="点击下方扫描注册或手动输入模型名" />
              )}
            </div>

            {/* 操作区 - 根据状态显示不同按钮 */}
            <div className="space-y-2">
              <div className="text-[11px]" style={{color:'var(--muted)'}}>操作</div>
              
              {/* 手动启动 */}
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  className="input w-full text-xs"
                  placeholder="模型名（如 llama3.1）或后端名（ollama/llamacpp）"
                  value={localModelInput}
                  onChange={(e) => setLocalModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && localModelInput.trim()) {
                      startLocalModel(localModelInput.trim()).then(() => { setLocalModelInput(''); refreshModelStatus(); });
                    }
                  }}
                />
                <button
                  onClick={() => { if (localModelInput.trim()) { startLocalModel(localModelInput.trim()).then(() => { setLocalModelInput(''); refreshModelStatus(); }); } }}
                  disabled={localModelLoading || !localModelInput.trim()}
                  className="btn btn-primary btn-sm w-full"
                >
                  启动
                </button>
              </div>

              {/* 快捷操作 */}
              <div className="grid grid-cols-2 gap-2">
                {!localModel.running ? (
                  <>
                    <button onClick={() => { startLocalModel().then(refreshModelStatus); }} disabled={localModelLoading} className="btn btn-sm btn-primary" title="使用默认配置启动">启动默认</button>
                    <button onClick={handleRegister} disabled={localModelLoading} className="btn btn-sm" title="扫描并注册本地模型">扫描注册</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { stopLocalModel().then(refreshModelStatus); }} disabled={localModelLoading} className="btn btn-sm" title="停止所有本地模型">停止全部</button>
                    <button onClick={() => { switchLocalModel().then(refreshModelStatus); }} disabled={localModelLoading} className="btn btn-sm" title="切换到本地模型模式">切到本地</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Thinking Settings ── */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>思考</div>

        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0" style={{color:'var(--text)'}}>启用思考</span>
          <ToggleSwitch
            checked={enableThinking}
            disabled={configSaving}
            onClick={() => patchConfig({ 'provider.enableThinking': !enableThinking })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0" style={{color:'var(--text)'}}>思考深度</span>
          <select
            className="text-xs rounded px-2 py-1 flex-shrink-0"
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

        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0" style={{color:'var(--text)'}}>显示思考</span>
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

        {/* Add channel form */}
        <div className="space-y-2 p-2 rounded-lg" style={{background:'var(--bg)'}}>
          <div className="text-[11px]" style={{color:'var(--muted)'}}>新增通道</div>
          <div className="grid grid-cols-1 gap-2">
            <input
              type="text"
              className="input text-xs"
              placeholder="名称"
              value={channelForm.name}
              onChange={(e) => setChannelForm(s => ({ ...s, name: e.target.value }))}
            />
            <input
              type="text"
              className="input text-xs"
              placeholder="provider"
              value={channelForm.provider}
              onChange={(e) => setChannelForm(s => ({ ...s, provider: e.target.value }))}
            />
            <input
              type="text"
              className="input text-xs"
              placeholder="模型名"
              value={channelForm.model}
              onChange={(e) => setChannelForm(s => ({ ...s, model: e.target.value }))}
            />
            <input
              type="text"
              className="input text-xs"
              placeholder="描述"
              value={channelForm.description}
              onChange={(e) => setChannelForm(s => ({ ...s, description: e.target.value }))}
            />
          </div>
          <button
            onClick={() => {
              if (!channelForm.name.trim()) return;
              addChannel(channelForm.name.trim(), channelForm.provider.trim() || undefined, channelForm.model.trim() || undefined, channelForm.description.trim() || undefined)
                .then((ok) => { if (ok) { setChannelForm({ name: '', provider: '', model: '', description: '' }); refreshModelStatus(); } });
            }}
            disabled={channelLoading || !channelForm.name.trim()}
            className="btn btn-primary btn-sm w-full"
          >
            {channelLoading ? '保存中...' : '添加通道'}
          </button>
        </div>

        {/* Channels list */}
        <div className="space-y-2">
          <div className="text-[11px]" style={{color:'var(--muted)'}}>通道</div>
          {channels.length > 0 ? (
            channels.map((ch: ModelChannelInfo) => (
              <ChannelCard
                key={ch.name}
                channel={ch}
                onRemove={ch.name === 'main' ? undefined : () => { removeChannel(ch.name).then(refreshModelStatus); }}
              />
            ))
          ) : (
            <EmptyState text="未配置通道" />
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

        {/* Add role mapping form */}
        <div className="space-y-2 p-2 rounded-lg" style={{background:'var(--bg)'}}>
          <div className="text-[11px]" style={{color:'var(--muted)'}}>新增角色映射</div>
          <div className="flex flex-col gap-2">
            <input
              type="text"
              className="input text-xs"
              placeholder="角色，如 compression"
              value={roleForm.role}
              onChange={(e) => setRoleForm(s => ({ ...s, role: e.target.value }))}
            />
            <input
              type="text"
              className="input text-xs"
              placeholder="通道名"
              value={roleForm.channel}
              onChange={(e) => setRoleForm(s => ({ ...s, channel: e.target.value }))}
            />
            <button
              onClick={() => {
                if (!roleForm.role.trim() || !roleForm.channel.trim()) return;
                setRoleMapping(roleForm.role.trim(), roleForm.channel.trim())
                  .then((ok) => { if (ok) { setRoleForm({ role: '', channel: '' }); refreshModelStatus(); } });
              }}
              disabled={channelLoading || !roleForm.role.trim() || !roleForm.channel.trim()}
              className="btn btn-primary btn-sm w-full"
            >
              映射
            </button>
          </div>
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
      className="inline-flex items-center rounded-full transition-colors flex-shrink-0"
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
function ProviderCard({ provider, isActive, onClick }: { provider: OnlineProviderInfo; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border px-2 py-2 text-xs transition-colors text-left"
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
    </button>
  );
}

/** Channel card */
function ChannelCard({ channel, onRemove }: { channel: ModelChannelInfo; onRemove?: () => void }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs" style={{borderColor:'var(--border)', background:'var(--bg)'}}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium" style={{color:'var(--text)'}}>{channel.name}</span>
        <div className="flex items-center gap-2">
          <span style={{color:'var(--muted)'}}>{channel.provider}/{channel.model}</span>
          {onRemove && (
            <button
              onClick={onRemove}
              className="text-[10px] px-2 py-1 rounded hover:opacity-80 min-w-[2rem]"
            style={{background:'var(--danger)', color:'#fff'}}
              title="删除通道"
            >
              删除
            </button>
          )}
        </div>
      </div>
      {channel.description && (
        <div className="text-[10px] mb-1" style={{color:'var(--muted)'}}>{channel.description}</div>
      )}
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
  { name: 'OpenRouter', type: 'openrouter', description: 'Multi-provider routing', status: 'available' },
  { name: 'Moonshot', type: 'moonshot', description: 'Moonshot (Kimi)', status: 'available' },
  { name: 'Qwen', type: 'qwen', description: 'Qwen (阿里百炼)', status: 'available' },
  { name: 'Zhipu', type: 'zhipu', description: 'Zhipu (智谱)', status: 'available' },
  { name: 'MiniMax', type: 'minimax', description: 'MiniMax', status: 'available' },
  { name: 'MiMo', type: 'mimo', description: 'MiMo (小米)', status: 'available' },
];
