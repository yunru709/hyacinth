import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import type { ActivityView } from '../types';

interface CommandItem {
  id: string;
  label: string;
  description: string;
  panel?: ActivityView;
  action?: () => void;
}

const LOCAL_COMMANDS: CommandItem[] = [
  { id: 'sessions', label: '会话', description: '查看和管理会话', panel: 'sessions' },
  { id: 'models', label: '模型中心', description: '配置模型和提供商', panel: 'model' },
  { id: 'settings', label: '设置', description: '配置安全、压缩和日志', panel: 'settings' },
  { id: 'context', label: '上下文', description: '查看 Token 使用和上下文统计', panel: 'context' },
  { id: 'knowledge', label: '知识库', description: '搜索和管理知识库', panel: 'knowledge' },
  { id: 'scheduler', label: '调度', description: '查看和管理定时任务', panel: 'scheduler' },
  { id: 'clear', label: '清屏', description: '清除当前聊天记录', action: () => useStore.getState().clearChatLog() },
  { id: 'collapse', label: '折叠所有工具', description: '折叠所有工具卡片', action: () => useStore.getState().setAllToolsExpanded(false) },
  { id: 'help', label: '帮助', description: '显示帮助信息', action: () => useStore.getState().showHelp() },
];

export function CommandPalette() {
  const open = useStore(s => s.commandPaletteOpen);
  const setOpen = useStore(s => s.setCommandPaletteOpen);
  const setActiveActivity = useStore(s => s.setActiveActivity);
  const [query, setQuery] = useState('');
  const [commands, setCommands] = useState<CommandItem[]>(LOCAL_COMMANDS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  // Load commands from backend or fallback to local
  useEffect(() => {
    if (open && !loadedRef.current) {
      loadedRef.current = true;
      fetch('/api/commands')
        .then(r => r.json())
        .then((data: CommandItem[]) => {
          if (Array.isArray(data) && data.length > 0) {
            setCommands(data);
          }
        })
        .catch(() => {
          // Keep local fallback
        });
    }
    if (!open) {
      loadedRef.current = false;
    }
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Global keyboard shortcut
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || (e.key === 'p' && e.shiftKey))) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, setOpen]);

  const filtered = commands.filter(c =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.description.toLowerCase().includes(query.toLowerCase())
  );

  const executeCommand = useCallback((cmd: CommandItem) => {
    if (cmd.action) {
      cmd.action();
    } else if (cmd.panel) {
      setActiveActivity(cmd.panel);
    } else {
      // Coming soon fallback
      useStore.getState().addSystemMsg(`"${cmd.label}" is coming soon.`, 'info');
    }
    setOpen(false);
  }, [setActiveActivity, setOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        executeCommand(filtered[selectedIndex]);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={() => setOpen(false)}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="command-palette-search">
          <span className="command-palette-search-icon">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="输入命令..."
            className="command-palette-input"
          />
          <span className="command-palette-hint">ESC 关闭</span>
        </div>

        <div className="command-palette-list">
          {filtered.length === 0 && (
            <div className="command-palette-empty">未找到命令</div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${i === selectedIndex ? 'command-palette-item-selected' : ''}`}
              onClick={() => executeCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <div className="command-palette-item-label">{cmd.label}</div>
              <div className="command-palette-item-desc">{cmd.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}