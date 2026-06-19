import { useRef, useEffect, useState } from 'react';
import { useStore } from '../store';
import type { UserMsgNode, TextMsgNode, ThinkingMsgNode, ToolCallNode, SystemMsgNode } from '../types';

function UserBubble({ msg, onRollback }: { msg: UserMsgNode; onRollback: (turnId: number) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="flex items-start gap-1 mb-4 px-4 group"
         onMouseEnter={() => setHovered(true)}
         onMouseLeave={() => setHovered(false)}>
      {/* Rollback button — appears on hover, left of message */}
      <button
        onClick={() => onRollback(msg.turnId)}
        className="flex-shrink-0 mt-1 btn-ghost btn-sm opacity-0 group-hover:opacity-100 transition-opacity"
        style={{color:'var(--muted)'}}
        title={`回滚到第 ${msg.turnId} 回合前`}
      >↩</button>

      <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed ml-auto"
           style={{background:'var(--accent)', color:'#fff'}}>
        {msg.content}
      </div>
    </div>
  );
}

function TextBlock({ msg }: { msg: TextMsgNode }) {
  return (
    <div className="mb-3 px-4 text-sm leading-relaxed" style={{color:'var(--text)'}}>
      {msg.content.split('\n').map((line, i) => (
        <div key={i}>{line || ' '}</div>
      ))}
    </div>
  );
}

function ThinkingBlock({ msg }: { msg: ThinkingMsgNode }) {
  const toggle = useStore(s => s.toggleThinkingCollapsed);
  return (
    <div className="mb-2 px-4">
      <button onClick={() => toggle(msg.id)}
              className="flex items-center gap-1.5 text-xs transition-colors mb-1"
              style={{color:'var(--muted)'}}>
        <span className="text-[10px]">{msg.collapsed ? '▶' : '▼'}</span>
        <span>思考</span>
      </button>
      {!msg.collapsed && (
        <div className="pl-3 ml-1 text-xs leading-relaxed whitespace-pre-wrap italic" style={{color:'var(--text-dim)', borderLeft:'2px solid var(--border)'}}>
          {msg.content}
        </div>
      )}
    </div>
  );
}

function ToolCard({ msg }: { msg: ToolCallNode }) {
  const toggle = useStore(s => s.toggleToolExpanded);
  return (
    <div className="mb-3 mx-4 card overflow-hidden">
      <button onClick={() => toggle(msg.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
              style={{background:'var(--surface)'}}>
        <span className="text-[10px]">{msg.expanded ? '▼' : '▶'}</span>
        <span className="font-mono font-semibold" style={{color:'var(--accent)'}}>{msg.name}</span>
        <span className="truncate flex-1" style={{color:'var(--text-dim)'}}>
          {msg.inputSummary.length > 80 ? msg.inputSummary.slice(0,77)+'...' : msg.inputSummary}
        </span>
        {msg.result !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{
            background: msg.isError ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
            color: msg.isError ? 'var(--danger)' : 'var(--success)',
          }}>{msg.isError ? '✗' : '✓'}</span>
        )}
      </button>
      {msg.expanded && (
        <div style={{borderTop:'1px solid var(--border)'}}>
          {msg.diff && (
            <div className="p-3" style={{borderBottom:'1px solid var(--border)'}}>
              <div className="text-[11px] mb-1 font-mono" style={{color:'var(--muted)'}}>📄 {msg.diff.filePath}</div>
              <pre className="text-[11px] font-mono overflow-x-auto max-h-44 leading-relaxed">
                {msg.diff.diffLines.map((line, i) => (
                  <div key={i} className={line.kind === '+' ? 'diff-add' : line.kind === '-' ? 'diff-remove' : 'diff-context'}>
                    {line.kind} {line.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
          {msg.result !== undefined && (
            <div className="p-3 overflow-y-auto max-h-64">
              <pre className={`text-[11px] font-mono whitespace-pre-wrap leading-relaxed ${msg.isError ? 'diff-remove' : ''}`}
                   style={{color: msg.isError ? 'var(--danger)' : 'var(--text-dim)'}}>
                {msg.result.length > 5000 ? msg.result.slice(0,5000)+'\n\n... (已截断)' : msg.result}
              </pre>
            </div>
          )}
          {msg.result === undefined && (
            <div className="p-3 text-xs" style={{color:'var(--muted)'}}>⏳ 执行中...</div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemMsg({ msg }: { msg: SystemMsgNode }) {
  const colors = { error: 'var(--danger)', warn: 'var(--warning)', info: 'var(--muted)' };
  return (
    <div className="mb-2 px-4 text-xs whitespace-pre-wrap" style={{color: colors[msg.level] || 'var(--muted)'}}>
      {msg.content}
    </div>
  );
}

export function ChatLog({ sendRollback }: { sendRollback: (toTurnId: number) => void }) {
  const messages = useStore(s => s.messages);
  const currentText = useStore(s => s.currentText);
  const clearChatLog = useStore(s => s.clearChatLog);
  const setAllToolsExpanded = useStore(s => s.setAllToolsExpanded);
  const showHelp = useStore(s => s.showHelp);
  const hasTools = messages.some(msg => msg.kind === 'tool');
  const allToolsExpanded = hasTools && messages.every(msg => msg.kind !== 'tool' || msg.expanded);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleRollback = (turnId: number) => {
    useStore.getState().addSystemMsg(`↩ Rolling back to turn ${turnId}...`, 'info');
    sendRollback(turnId);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentText]);

  return (
    <div className="flex-1 overflow-y-auto py-4" style={{minHeight:0}}>
      <div className="sticky top-0 z-10 flex justify-end gap-2 px-4 pb-3" style={{background:'var(--bg)'}}>
        <button
          onClick={clearChatLog}
          className="btn-ghost btn-sm"
          title="清除聊天记录"
        >清屏</button>
        <button
          onClick={() => setAllToolsExpanded(!allToolsExpanded)}
          disabled={!hasTools}
          className="btn-ghost btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          title={allToolsExpanded ? '折叠所有工具卡片' : '展开所有工具卡片'}
        >{allToolsExpanded ? '折叠工具' : '展开工具'}</button>
        <button
          onClick={showHelp}
          className="btn-ghost btn-sm"
          title="显示帮助"
        >帮助</button>
      </div>

      {messages.length === 0 && !currentText && (
        <div className="flex items-center justify-center h-full" style={{color:'var(--muted)'}}>
          <div className="text-center">
            <div className="text-4xl mb-3" style={{color:'var(--accent)'}}>DeepThink</div>
            <div className="text-sm">输入消息开始</div>
            <div className="text-xs mt-2" style={{color:'var(--text-dim)'}}>/help 查看命令</div>
          </div>
        </div>
      )}

      {messages.map(msg => {
        switch (msg.kind) {
          case 'user': return <UserBubble key={msg.id} msg={msg} onRollback={handleRollback} />;
          case 'text': return <TextBlock key={msg.id} msg={msg} />;
          case 'thinking': return <ThinkingBlock key={msg.id} msg={msg} />;
          case 'tool': return <ToolCard key={msg.id} msg={msg} />;
          case 'system': return <SystemMsg key={msg.id} msg={msg} />;
          default: return null;
        }
      })}

      {currentText && (
        <div className="mb-3 px-4 text-sm leading-relaxed" style={{color:'var(--text)'}}>
          {currentText}
          <span className="inline-block w-1.5 h-4 ml-0.5 align-middle animate-pulse rounded-sm" style={{background:'var(--accent)'}} />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
