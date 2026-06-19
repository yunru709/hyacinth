import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { EmptyState, LoadingState } from './ui/PanelStates';

export function SettingsPanel() {
  const webuiConfig = useStore(s => s.webuiConfig);
  const configSaving = useStore(s => s.configSaving);
  const fetchConfig = useStore(s => s.fetchConfig);
  const patchConfig = useStore(s => s.patchConfig);

  const [safety, setSafety] = useState({ requireConfirmation: true });
  const [compression, setCompression] = useState({ compressionStrategy: 'C' as 'A' | 'C', compressThreshold: 0.75, emergencyThreshold: 0.92, compressDepth: 0.5 });
  const [repair, setRepair] = useState({ scavengeEnabled: true, stormEnabled: false, stormWindow: 6, stormThreshold: 3 });
  const [logging, setLogging] = useState({ level: 'info' as 'debug' | 'info' | 'warn' | 'error' | 'off' });

  const [expanded, setExpanded] = useState({
    safety: true,
    compression: true,
    repair: false,
    logging: false,
  });

  const [dirty, setDirty] = useState({
    safety: false,
    compression: false,
    repair: false,
    logging: false,
  });

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (webuiConfig) {
      if (webuiConfig.safety) {
        setSafety({ requireConfirmation: webuiConfig.safety.requireConfirmation });
      }
      if (webuiConfig.context) {
        setCompression({
          compressionStrategy: webuiConfig.context.compressionStrategy,
          compressThreshold: webuiConfig.context.compressThreshold,
          emergencyThreshold: webuiConfig.context.emergencyThreshold,
          compressDepth: webuiConfig.context.compressDepth,
        });
      }
      if (webuiConfig.repair) {
        setRepair({
          scavengeEnabled: webuiConfig.repair.scavenge.enabled,
          stormEnabled: webuiConfig.repair.storm.enabled,
          stormWindow: webuiConfig.repair.storm.windowSize,
          stormThreshold: webuiConfig.repair.storm.threshold,
        });
      }
      if (webuiConfig.logging) {
        setLogging({ level: webuiConfig.logging.level });
      }
      setDirty({ safety: false, compression: false, repair: false, logging: false });
    }
  }, [webuiConfig]);

  const hasChanges = Object.values(dirty).some(Boolean);

  const handleSaveAll = useCallback(async () => {
    const updates: Record<string, unknown> = {};
    if (dirty.safety) {
      updates['safety.requireConfirmation'] = safety.requireConfirmation;
    }
    if (dirty.compression) {
      updates['context.compressionStrategy'] = compression.compressionStrategy;
      updates['context.compressThreshold'] = compression.compressThreshold;
      updates['context.emergencyThreshold'] = compression.emergencyThreshold;
      updates['context.compressDepth'] = compression.compressDepth;
    }
    if (dirty.repair) {
      updates['repair.scavenge.enabled'] = repair.scavengeEnabled;
      updates['repair.storm.enabled'] = repair.stormEnabled;
      updates['repair.storm.windowSize'] = repair.stormWindow;
      updates['repair.storm.threshold'] = repair.stormThreshold;
    }
    if (dirty.logging) {
      updates['logging.level'] = logging.level;
    }
    if (Object.keys(updates).length > 0) {
      await patchConfig(updates);
      setDirty({ safety: false, compression: false, repair: false, logging: false });
    }
  }, [patchConfig, dirty, safety, compression, repair, logging]);

  const updateSafety = (patch: Partial<typeof safety>) => {
    setSafety(s => ({ ...s, ...patch }));
    setDirty(d => ({ ...d, safety: true }));
  };

  const updateCompression = (patch: Partial<typeof compression>) => {
    setCompression(c => ({ ...c, ...patch }));
    setDirty(d => ({ ...d, compression: true }));
  };

  const updateRepair = (patch: Partial<typeof repair>) => {
    setRepair(r => ({ ...r, ...patch }));
    setDirty(d => ({ ...d, repair: true }));
  };

  const updateLogging = (patch: Partial<typeof logging>) => {
    setLogging(l => ({ ...l, ...patch }));
    setDirty(d => ({ ...d, logging: true }));
  };

  if (!webuiConfig) {
    return (
      <div className="space-y-4">
        <LoadingState text="加载设置中..." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="安全"
        expanded={expanded.safety}
        onToggle={() => setExpanded(e => ({ ...e, safety: !e.safety }))}
      >
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-sm min-w-0" style={{ color: 'var(--text)' }}>需要确认</span>
          <button
            onClick={() => updateSafety({ requireConfirmation: !safety.requireConfirmation })}
            className="w-9 h-5 rounded-full relative transition-colors flex-shrink-0"
            style={{ background: safety.requireConfirmation ? 'var(--success)' : 'var(--border)' }}
          >
            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                  style={{ left: safety.requireConfirmation ? 'calc(100% - 18px)' : '2px' }} />
          </button>
        </label>
      </Section>

      <Section
        title="压缩"
        expanded={expanded.compression}
        onToggle={() => setExpanded(e => ({ ...e, compression: !e.compression }))}
      >
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>策略</label>
          <div className="inline-flex rounded-md overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
            {(['A', 'C'] as const).map(s => (
              <button
                key={s}
                onClick={() => updateCompression({ compressionStrategy: s })}
                className="px-3 py-1 text-xs transition-colors"
                style={{
                  background: compression.compressionStrategy === s ? 'var(--accent)' : 'transparent',
                  color: compression.compressionStrategy === s ? '#fff' : 'var(--text-dim)',
                }}
              >
                {s === 'A' ? '独立模式 (A)' : '克隆模式 (C)'}
              </button>
            ))}
          </div>
        </div>

        <SliderField label="阈值" value={compression.compressThreshold} min={0} max={1} step={0.01}
          onChange={v => updateCompression({ compressThreshold: v })} />
        <SliderField label="紧急阈值" value={compression.emergencyThreshold} min={0} max={1} step={0.01}
          onChange={v => updateCompression({ emergencyThreshold: v })} />
        <SliderField label="深度" value={compression.compressDepth} min={0} max={1} step={0.01}
          onChange={v => updateCompression({ compressDepth: v })} />
      </Section>

      <Section
        title="修复"
        expanded={expanded.repair}
        onToggle={() => setExpanded(e => ({ ...e, repair: !e.repair }))}
      >
        <Toggle label="清扫" value={repair.scavengeEnabled}
          onChange={v => updateRepair({ scavengeEnabled: v })} />
        <Toggle label="风暴" value={repair.stormEnabled}
          onChange={v => updateRepair({ stormEnabled: v })} />

        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>风暴窗口</label>
          <input type="number" className="input" value={repair.stormWindow}
            onChange={e => updateRepair({ stormWindow: Number(e.target.value) })} min={1} step={1} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>风暴阈值</label>
          <input type="number" className="input" value={repair.stormThreshold}
            onChange={e => updateRepair({ stormThreshold: Number(e.target.value) })} min={1} step={1} />
        </div>
      </Section>

      <Section
        title="日志"
        expanded={expanded.logging}
        onToggle={() => setExpanded(e => ({ ...e, logging: !e.logging }))}
      >
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>级别</label>
          <select className="input" value={logging.level}
            onChange={e => updateLogging({ level: e.target.value as typeof logging.level })}>
            <option value="debug">调试</option>
            <option value="info">信息</option>
            <option value="warn">警告</option>
            <option value="error">错误</option>
            <option value="off">关闭</option>
          </select>
        </div>
      </Section>

      <div className="card p-3">
        <button
          className="btn btn-primary btn-sm w-full justify-center"
          onClick={handleSaveAll}
          disabled={configSaving || !hasChanges}
        >
          {configSaving ? '保存中...' : '保存所有设置'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, expanded, onToggle, children }: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-3 space-y-3">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-left"
        type="button"
      >
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{title}</div>
        <span className="text-xs transition-transform" style={{ color: 'var(--muted)', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
      </button>
      {expanded && (
        <div className="space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-sm min-w-0" style={{ color: 'var(--text)' }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        className="w-9 h-5 rounded-full relative transition-colors flex-shrink-0"
        style={{ background: value ? 'var(--success)' : 'var(--border)' }}
      >
        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
              style={{ left: value ? 'calc(100% - 18px)' : '2px' }} />
      </button>
    </label>
  );
}

function SliderField({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between">
        <label className="text-[11px]" style={{ color: 'var(--muted)' }}>{label}</label>
        <span className="text-[11px] font-mono" style={{ color: 'var(--text)' }}>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ accentColor: 'var(--accent)' }}
      />
    </div>
  );
}
