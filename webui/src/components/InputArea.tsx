import { useState, useRef, useCallback } from 'react';
import { useStore } from '../store';

interface InputAreaProps {
  sendChat: (content: string) => void;
  sendStop: () => void;
  ready: boolean;
}

export function InputArea({ sendChat, sendStop, ready }: InputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isProcessing = useStore((s) => s.isProcessing);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    sendChat(text);
    setInput('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, sendChat]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isProcessing) {
        handleSend();
      }
    }
    // Escape to stop
    if (e.key === 'Escape' && isProcessing) {
      e.preventDefault();
      sendStop();
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  // Auto-focus on mount
  const focusInput = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  // Focus on click in the input area background
  const handleContainerClick = () => {
    if (!isProcessing) {
      focusInput();
    }
  };

  const tokens = Math.ceil(input.length / 4);

  return (
    <div
      className="border-t border-border bg-surface px-4 py-3"
      onClick={handleContainerClick}
    >
      {/* Permission bar (shown when awaiting permission) */}
      <PermissionBar />

      {/* Input row */}
      <div className="flex items-end gap-3">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              !ready
                ? 'Initializing... please wait'
                : isProcessing
                ? 'Agent is thinking... (Esc to stop)'
                : 'Type a message... (/help for commands, Enter to send)'
            }
            disabled={isProcessing || !ready}
            rows={1}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text placeholder-muted
                       focus:outline-none focus:border-accent resize-none
                       disabled:opacity-50 disabled:cursor-not-allowed
                       font-sans"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted font-mono whitespace-nowrap">
            ~{tokens}t
          </span>

          {isProcessing ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                sendStop();
              }}
              className="px-4 py-2 bg-red-500/15 text-red-400 rounded-lg text-sm font-medium
                         hover:bg-red-500/25 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSend();
              }}
              disabled={!input.trim()}
              className="px-4 py-2 bg-accent/15 text-accent rounded-lg text-sm font-medium
                         hover:bg-accent/25 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Permission confirmation bar */
function PermissionBar() {
  const permissionRequest = useStore((s) => s.permissionRequest);

  if (!permissionRequest) return null;

  // This is handled inside the useWebSocket hook
  return (
    <div className="mb-3 p-3 border border-yellow-500/30 bg-yellow-500/10 rounded-lg">
      <div className="text-yellow-400 text-sm font-medium mb-1">
        ⚠ Tool Permission Required
      </div>
      <div className="text-yellow-300/80 text-xs font-mono mb-2">
        {permissionRequest.toolName}(
        {JSON.stringify(permissionRequest.input).slice(0, 100)})
      </div>
      <div className="text-xs text-yellow-400/60">
        Awaiting response — use the permission buttons in the WebSocket handler
      </div>
    </div>
  );
}
