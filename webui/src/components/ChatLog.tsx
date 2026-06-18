import { useRef, useEffect } from 'react';
import { useStore } from '../store';
import type {
  UserMsgNode,
  TextMsgNode,
  ThinkingMsgNode,
  ToolCallNode,
  SystemMsgNode,
} from '../types';

function UserBubble({ msg }: { msg: UserMsgNode }) {
  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[80%] bg-accent/15 text-text-bright rounded-lg px-4 py-2">
        <pre className="whitespace-pre-wrap font-sans text-sm">{msg.content}</pre>
      </div>
    </div>
  );
}

function TextBlock({ msg }: { msg: TextMsgNode }) {
  return (
    <div className="mb-2">
      <div className="text-text text-sm whitespace-pre-wrap leading-relaxed">
        {msg.content}
      </div>
    </div>
  );
}

function ThinkingBlock({ msg }: { msg: ThinkingMsgNode }) {
  const toggle = useStore((s) => s.toggleThinkingCollapsed);

  return (
    <div className="mb-2">
      <button
        onClick={() => toggle(msg.id)}
        className="flex items-center gap-2 text-xs text-muted hover:text-text transition-colors mb-1"
      >
        <span>{msg.collapsed ? '▶' : '▼'}</span>
        <span>🧠 Thinking</span>
      </button>
      {!msg.collapsed && (
        <div className="pl-5 border-l-2 border-border ml-1 text-xs text-muted whitespace-pre-wrap italic">
          {msg.content}
        </div>
      )}
    </div>
  );
}

function ToolCard({ msg }: { msg: ToolCallNode }) {
  const toggle = useStore((s) => s.toggleToolExpanded);

  return (
    <div className="mb-2 border border-border rounded-md overflow-hidden">
      {/* Tool header */}
      <button
        onClick={() => toggle(msg.id)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface hover:bg-border/30 transition-colors text-left"
      >
        <span className="text-xs">{msg.expanded ? '▼' : '▶'}</span>
        <span className="text-accent text-sm font-mono font-bold">
          {msg.name}
        </span>
        <span className="text-muted text-xs truncate flex-1">
          {msg.inputSummary.length > 80
            ? msg.inputSummary.slice(0, 77) + '...'
            : msg.inputSummary}
        </span>
        {msg.result !== undefined && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              msg.isError
                ? 'bg-red-500/15 text-red-400'
                : 'bg-green-500/15 text-green-400'
            }`}
          >
            {msg.isError ? '✗' : '✓'}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {msg.expanded && (
        <div className="border-t border-border">
          {/* Diff view */}
          {msg.diff && (
            <div className="p-3 border-b border-border">
              <div className="text-xs text-muted mb-1 font-mono">
                📄 {msg.diff.filePath}
              </div>
              <pre className="text-xs font-mono overflow-x-auto max-h-48">
                {msg.diff.diffLines.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === '+'
                        ? 'bg-green-500/10 text-green-400'
                        : line.kind === '-'
                        ? 'bg-red-500/10 text-red-400'
                        : 'text-muted'
                    }
                  >
                    {line.kind} {line.text}
                  </div>
                ))}
              </pre>
            </div>
          )}

          {/* Tool result */}
          {msg.result !== undefined && (
            <div className="p-3">
              <pre
                className={`text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto ${
                  msg.isError ? 'text-red-400' : 'text-muted'
                }`}
              >
                {msg.result.length > 5000
                  ? msg.result.slice(0, 5000) +
                    '\n\n... (truncated, showing first 5000 chars)'
                  : msg.result}
              </pre>
            </div>
          )}

          {/* Pending (tool in flight) */}
          {msg.result === undefined && (
            <div className="p-3 text-muted text-xs">⏳ Executing...</div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemMsg({ msg }: { msg: SystemMsgNode }) {
  const colorClass =
    msg.level === 'error'
      ? 'text-red-400'
      : msg.level === 'warn'
      ? 'text-yellow-400'
      : 'text-muted';

  return (
    <div className={`mb-2 text-xs ${colorClass}`}>
      {msg.content}
    </div>
  );
}

export function ChatLog() {
  const messages = useStore((s) => s.messages);
  const currentText = useStore((s) => s.currentText);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentText]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      {messages.length === 0 && !currentText && (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          <div className="text-center">
            <div className="text-3xl mb-2">DeepThink</div>
            <div>Type a message to start</div>
          </div>
        </div>
      )}

      {messages.map((msg) => {
        switch (msg.kind) {
          case 'user':
            return <UserBubble key={msg.id} msg={msg} />;
          case 'text':
            return <TextBlock key={msg.id} msg={msg} />;
          case 'thinking':
            return <ThinkingBlock key={msg.id} msg={msg} />;
          case 'tool':
            return <ToolCard key={msg.id} msg={msg} />;
          case 'system':
            return <SystemMsg key={msg.id} msg={msg} />;
          default:
            return null;
        }
      })}

      {/* Streaming text */}
      {currentText && (
        <div className="mb-2">
          <div className="text-text text-sm whitespace-pre-wrap leading-relaxed">
            {currentText}
            <span className="inline-block w-2 h-4 bg-accent animate-pulse ml-0.5 align-middle" />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
