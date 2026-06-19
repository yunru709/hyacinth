import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';

export function SettingsPanel() {
  const webuiConfig = useStore(s => s.webuiConfig);
  const configSaving = useStore(s => s.configSaving);
  const fetchConfig = useStore(s => s.fetchConfig);
  const patchConfig = useStore(s => s.patchConfig);

  const [safety, setSafety] = useState({ requireConfirmation: true });
  const [compression, setCompression] = useState({ compressionStrategy: 'C' as 'A' | 'C', compressThreshold: 0.75, emergencyThreshold: 0.92, compressDepth: 0.5 });
  const [repair, setRepair] = useState({ scavengeEnabled: true, stormEnabled: false, stormWindow: 6, stormThreshold: 3 });
  const [logging, setLogging] = useState({ level: 'info' as 'debug' | 'info' | 'warn' | 'error' | 'off' });

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
    }
  }, [webuiConfig]);

  const saveSafety = useCallback(async () => {
    await patchConfig({ 'safety.requireConfirmation': safety.requireConfirmation });
  }, [patchConfig, safety]);

  const saveCompression = useCallback(async () => {
    await patchConfig({
      'context.compressionStrategy': compression.compressionStrategy,
      'context.compressThreshold': compression.compressThreshold,
      'context.emergencyThreshold': compression.emergencyThreshold,
      'context.compressDepth': compression.compressDepth,
    });
  }, [patchConfig, compression]);

  const saveRepair = useCallback(async () => {
    await patchConfig({
      'repair.scavenge.enabled': repair.scavengeEnabled,
      'repair.storm.enabled': repair.stormEnabled,
      'repair.storm.windowSize': repair.stormWindow,
      'repair.storm.threshold': repair.stormThreshold,
    });
  }, [patchConfig, repair]);

  const saveLogging = useCallback(async () => {
    await patchConfig({ 'logging.level': logging.level });
  }, [patchConfig, logging]);

  return (
    <div className="space-y-4">
      {/* Safety */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>安全</div>
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-sm" style={{ color: 'var(--text)' }}>需要确认</span>
          <button
            onClick={() => setSafety(s => ({ ...s, requireConfirmation: !s.requireConfirmation }))}
            className="w-9 h-5 rounded-full relative transition-colors"
            style={{ background: safety.requireConfirmation ? 'var(--success)' : 'var(--border)' }}
          >
            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                  style={{ left: safety.requireConfirmation ? 'calc(100% - 18px)' : '2px' }} />
          </button>
        </label>
        <button className="btn btn-primary btn-sm w-full justify-center" onClick={saveSafety} disabled={configSaving}>
          {configSaving ? '保存中...' : '保存安全设置'}
        </button>
      </div>

      {/* Compression */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>压缩</div>

        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>策略</label>
          <div className="inline-flex rounded-md overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
            {(['A', 'C'] as const).map(s => (
              <button
                key={s}
                onClick={() => setCompression(c => ({ ...c, compressionStrategy: s }))}
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
          onChange={v => setCompression(c => ({ ...c, compressThreshold: v }))} />
        <SliderField label="紧急阈值" value={compression.emergencyThreshold} min={0} max={1} step={0.01}
          onChange={v => setCompression(c => ({ ...c, emergencyThreshold: v }))} />
        <SliderField label="深度" value={compression.compressDepth} min={0} max={1} step={0.01}
          onChange={v => setCompression(c => ({ ...c, compressDepth: v }))} />

        <button className="btn btn-primary btn-sm w-full justify-center" onClick={saveCompression} disabled={configSaving}>
          {configSaving ? '保存中...' : '保存压缩设置'}
        </button>
      </div>

      {/* Repair */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>修复</div>

        <Toggle label="清扫" value={repair.scavengeEnabled}
          onChange={v => setRepair(r => ({ ...r, scavengeEnabled: v }))} />
        <Toggle label="风暴" value={repair.stormEnabled}
          onChange={v => setRepair(r => ({ ...r, stormEnabled: v }))} />

        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>风暴窗口</label>
          <input type="number" className="input" value={repair.stormWindow}
            onChange={e => setRepair(r => ({ ...r, stormWindow: Number(e.target.value) }))} min={1} step={1} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>风暴阈值</label>
          <input type="number" className="input" value={repair.stormThreshold}
            onChange={e => setRepair(r => ({ ...r, stormThreshold: Number(e.target.value) }))} min={1} step={1} />
        </div>

        <button className="btn btn-primary btn-sm w-full justify-center" onClick={saveRepair} disabled={configSaving}>
          {configSaving ? '保存中...' : '保存修复设置'}
        </button>
      </div>

      {/* Logging */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>日志</div>

        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>级别</label>
          <select className="input" value={logging.level}
            onChange={e => setLogging({ level: e.target.value as typeof logging.level })}>
            <option value="debug">调试</option>
            <option value="info">信息</option>
            <option value="warn">警告</option>
            <option value="error">错误</option>
            <option value="off">关闭</option>
          </select>
        </div>

        <button className="btn btn-primary btn-sm w-full justify-center" onClick={saveLogging} disabled={configSaving}>
          {configSaving ? '保存中...' : '保存日志设置'}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-sm" style={{ color: 'var(--text)' }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        className="w-9 h-5 rounded-full relative transition-colors"
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