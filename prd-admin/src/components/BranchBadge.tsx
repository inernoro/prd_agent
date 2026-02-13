import { useState } from 'react';
import { GitBranch, X } from 'lucide-react';

declare const __GIT_BRANCH__: string;

const HIDDEN_BRANCHES = ['main', 'master'];

export function BranchBadge() {
  const [dismissed, setDismissed] = useState(false);

  const branch = typeof __GIT_BRANCH__ === 'string' ? __GIT_BRANCH__ : '';
  if (!branch || HIDDEN_BRANCHES.includes(branch) || dismissed) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        bottom: 12,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        color: '#e2e8f0',
        background: 'rgba(30, 41, 59, 0.85)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(148, 163, 184, 0.2)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
    >
      <GitBranch size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
      <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {branch}
      </span>
      <button
        onClick={() => setDismissed(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginLeft: 2,
          padding: 2,
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
