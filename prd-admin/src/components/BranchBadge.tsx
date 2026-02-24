import { useState, useRef, useEffect, useCallback } from 'react';
import { GitBranch, X } from 'lucide-react';

declare const __GIT_BRANCH__: string;

const HIDDEN_BRANCHES = ['main', 'master'];

/**
 * Detect deployment mode:
 * - Port 5500 (nginx gateway) = deploy (artifact) mode → auto-hide after 5s
 * - Other ports (direct) = run (source) mode → persistent
 */
function isDeployMode(): boolean {
  try {
    return window.location.port === '5500' || window.location.port === '';
  } catch {
    return true;
  }
}

export function BranchBadge() {
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(true);
  const [position, setPosition] = useState({ x: 12, y: 12 }); // {left, bottom}
  const dragging = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });
  const badgeRef = useRef<HTMLDivElement>(null);

  const branch = typeof __GIT_BRANCH__ === 'string' ? __GIT_BRANCH__ : '';
  const deployMode = isDeployMode();

  // Auto-hide after 5s in deploy mode
  useEffect(() => {
    if (!branch || HIDDEN_BRANCHES.includes(branch) || dismissed) return;
    if (deployMode) {
      const timer = setTimeout(() => setVisible(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [branch, dismissed, deployMode]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: position.x,
      posY: position.y,
    };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.mouseX;
      const dy = e.clientY - dragStart.current.mouseY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 180, dragStart.current.posX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 50, dragStart.current.posY - dy)),
      });
    };
    const onMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (!branch || HIDDEN_BRANCHES.includes(branch) || dismissed || !visible) return null;

  // Normal badge — sole trusted identity source via __GIT_BRANCH__
  const modeColor = deployMode
    ? 'rgba(35, 134, 54, 0.85)'  // green for deploy
    : 'rgba(218, 139, 69, 0.85)'; // orange for run

  return (
    <div
      id="bt-branch-badge"
      ref={badgeRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'fixed',
        left: position.x,
        bottom: position.y,
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
        background: modeColor,
        backdropFilter: 'blur(8px)',
        border: `1px solid ${deployMode ? 'rgba(63, 185, 80, 0.3)' : 'rgba(218, 139, 69, 0.3)'}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        userSelect: 'none',
        cursor: 'grab',
      }}
    >
      <GitBranch size={13} style={{ flexShrink: 0, opacity: 0.8 }} />
      <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {branch}
      </span>
      <span style={{
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'rgba(255,255,255,0.15)',
        marginLeft: 2,
      }}>
        {deployMode ? '制品' : '源码'}
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
