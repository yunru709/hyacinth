import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';

interface InputAreaProps {
  sendChat: (content: string) => void;
  sendStop: () => void;
  ready: boolean;
}

export function InputArea({ sendChat, sendStop, ready }: InputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isProcessing = useStore(s => s.isProcessing);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !ready) return;
    sendChat(text);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, sendChat, ready]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isProcessing && ready) handleSend();
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
    if (ready && !isProcessing) textareaRef.current?.focus();
  }, [ready, isProcessing]);

  const tokens = Math.ceil(input.length / 4);
  const disabled = isProcessing || !ready;

  return (
    <div className="px-4 py-3 flex-shrink-0" style={{background:'var(--surface)', borderTop:'1px solid var(--border)'}}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={!ready ? 'Initializing...' : isProcessing ? 'Agent is thinking... (Esc to stop)' : 'Message DeepThink...'}
            disabled={disabled}
            rows={1}
            className="w-full rounded-xl px-4 py-2.5 text-sm resize-none outline-none"
            style={{
              background:'var(--bg)', border:'1px solid var(--border)',
              color:'var(--text)', opacity: disabled ? 0.5 : 1,
            }}
          />
        </div>

        <span className="text-[11px] font-mono flex-shrink-0" style={{color:'var(--muted)'}}>~{tokens}t</span>

        {isProcessing ? (
          <button onClick={sendStop} className="btn btn-danger btn-sm flex-shrink-0">■ Stop</button>
        ) : (
          <button onClick={handleSend} disabled={!input.trim() || !ready}
                  className="btn btn-primary btn-sm flex-shrink-0">↑ Send</button>
        )}
      </div>
    </div>
  );
}
