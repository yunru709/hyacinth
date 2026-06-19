import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';

interface InputAreaProps {
  sendChat: (content: string) => void;
  sendStop: () => void;
  sendInsert: (content: string) => void;
  ready: boolean;
}

export function InputArea({ sendChat, sendStop, sendInsert, ready }: InputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isProcessing = useStore(s => s.isProcessing);
  const queuedMessages = useStore(s => s.queuedMessages);
  const addQueuedMessage = useStore(s => s.addQueuedMessage);
  const removeQueuedMessage = useStore(s => s.removeQueuedMessage);
  const clearQueuedMessages = useStore(s => s.clearQueuedMessages);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !ready) return;
    sendChat(text);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, sendChat, ready]);

  const handleQueue = useCallback(() => {
    const text = input.trim();
    if (!text || !ready) return;
    addQueuedMessage(text);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, addQueuedMessage, ready]);

  const handleInsert = useCallback(() => {
    const text = input.trim();
    if (!text || !ready) return;
    sendInsert(text);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, sendInsert, ready]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!ready) return;
      if (isProcessing) {
        handleQueue();
      } else {
        handleSend();
      }
    }
    if (e.key === 'Escape' && isProcessing) { e.preventDefault(); sendStop(); }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  useEffect(() => {
    if (ready) textareaRef.current?.focus();
  }, [ready, isProcessing]);

  const tokens = Math.ceil(input.length / 4);

  return (
    <div className="px-4 py-3 flex-shrink-0" style={{background:'var(--surface)', borderTop:'1px solid var(--border)'}}>
      {/* Queue tags */}
      {queuedMessages.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className="text-[10px] font-medium" style={{color:'var(--muted)'}}>
            排队 ({queuedMessages.length})
          </span>
          {queuedMessages.map((msg, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
              style={{background:'var(--surface-hover)', border:'1px solid var(--border)', color:'var(--text-dim)'}}>
              <span className="truncate max-w-[120px]">{msg}</span>
              <button onClick={() => removeQueuedMessage(i)}
                className="leading-none opacity-50 hover:opacity-100" style={{color:'var(--muted)'}}>×</button>
            </span>
          ))}
          <button onClick={clearQueuedMessages}
            className="text-[10px] opacity-50 hover:opacity-100" style={{color:'var(--muted)'}}>清除全部</button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={!ready ? '初始化中...' : isProcessing ? 'Agent 思考中... (Enter 排队, Esc 停止)' : '输入消息...'}
            rows={1}
            className="w-full rounded-xl px-4 py-2.5 text-sm resize-none outline-none"
            style={{
              background:'var(--bg)', border:'1px solid var(--border)',
              color:'var(--text)',
            }}
          />
        </div>

        <span className="text-[11px] font-mono flex-shrink-0" style={{color:'var(--muted)'}}>~{tokens}t</span>

        {isProcessing ? (
          <div className="flex gap-1.5 flex-shrink-0">
            <button onClick={handleQueue} disabled={!input.trim() || !ready}
              className="btn btn-sm" style={{borderColor:'var(--accent)', color:'var(--accent)'}}>排队</button>
            <button onClick={handleInsert} disabled={!input.trim() || !ready}
              className="btn btn-sm" style={{borderColor:'var(--warning)', color:'var(--warning)'}}>插队</button>
            <button onClick={sendStop} className="btn btn-danger btn-sm flex-shrink-0">停止</button>
          </div>
        ) : (
          <button onClick={handleSend} disabled={!input.trim() || !ready}
            className="btn btn-primary btn-sm flex-shrink-0">↑ 发送</button>
        )}
      </div>
    </div>
  );
}