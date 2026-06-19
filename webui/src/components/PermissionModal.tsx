import { useEffect, useCallback } from 'react';
import { useStore } from '../store';

interface PermissionModalProps {
  respondPermission: (result: 'yes' | 'no' | 'always') => void;
}

export function PermissionModal({ respondPermission }: PermissionModalProps) {
  const permissionRequest = useStore(s => s.permissionRequest);

  const handleKey = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.key.toLowerCase()) {
      case 'y': respondPermission('yes'); break;
      case 'a': respondPermission('always'); break;
      case 'n': respondPermission('no'); break;
    }
  }, [respondPermission]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  if (!permissionRequest) return null;

  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-modal-header">
          <span className="text-lg">⚠️</span>
          <div>
            <div className="permission-modal-title">需要权限确认</div>
            <div className="text-sm" style={{color:'var(--muted)'}}>
              Agent 想要使用 <span className="permission-toolname">{permissionRequest.toolName}</span>
            </div>
          </div>
        </div>

        <div className="permission-modal-body">
          <pre className="permission-modal-pre">
            {JSON.stringify(permissionRequest.input, null, 2)}
          </pre>
        </div>

        <div className="permission-modal-actions">
          {[
            { key: 'Y', label: '同意', action: 'yes' as const, cls: 'var(--success)' },
            { key: 'A', label: '总是允许', action: 'always' as const, cls: 'var(--accent)' },
            { key: 'N', label: '拒绝', action: 'no' as const, cls: 'var(--danger)' },
          ].map(({ key, label, action, cls }) => (
            <button
              key={key}
              onClick={() => respondPermission(action)}
              className="permission-btn"
              style={{borderColor: cls, color: cls}}
            >
              <span className="permission-btn-key">{key}</span>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}