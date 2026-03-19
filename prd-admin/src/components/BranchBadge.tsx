import { useState, useRef, useEffect, useCallback } from 'react';
import { GitBranch, X, RefreshCw, ChevronUp, ChevronDown, Loader2, CheckCircle2, XCircle } from 'lucide-react';

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

// ── CDS-only helpers (only called when CDS is detected) ──

/** CDS API base — /_cds is rewritten to CDS Dashboard by proxy (both vite dev & CDS worker) */
const CDS_API = '/_cds/api';

function slugify(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface BranchInfo {
  id: string;
  branch: string;
  status: string;
  services: Record<string, { profileId: string; status: string; hostPort?: number }>;
}

interface BuildProfile {
  id: string;
  name: string;
}

type DeployStatus = 'idle' | 'deploying' | 'success' | 'error';

interface DeployState {
  status: DeployStatus;
  profileId?: string;
  message?: string;
  steps: Array<{ step: string; status: string; title: string }>;
}

async function cdsGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${CDS_API}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Detect whether this app is hosted by CDS (silent probe, no UI flicker) */
async function probeCds(): Promise<boolean> {
  try {
    const res = await fetch(`${CDS_API}/branches`, { method: 'GET', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function deployViaSSE(
  branchId: string,
  profileId: string | undefined,
  onStep: (step: { step: string; status: string; title: string }) => void,
  onComplete: (msg: string) => void,
  onError: (msg: string) => void,
): () => void {
  const url = profileId
    ? `${CDS_API}/branches/${branchId}/deploy/${profileId}`
    : `${CDS_API}/branches/${branchId}/deploy`;

  const controller = new AbortController();

  fetch(url, { method: 'POST', signal: controller.signal }).then(async (res) => {
    if (!res.ok || !res.body) {
      onError(`HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === 'step') onStep(data);
            else if (currentEvent === 'complete') onComplete(data.message || 'Done');
            else if (currentEvent === 'error') onError(data.message || 'Error');
          } catch { /* ignore parse errors */ }
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') onError(err.message);
  });

  return () => controller.abort();
}

// ── Shared drag hook ──

function useDrag(initial: { x: number; y: number }) {
  const [position, setPosition] = useState(initial);
  const dragging = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

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

  return { position, onMouseDown };
}

// ── CDS Update Panel (only rendered when CDS is hosting) ──

function CdsUpdatePanel({
  branchSlug,
  borderColor,
}: {
  branchSlug: string;
  borderColor: string;
}) {
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [profiles, setProfiles] = useState<BuildProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [deploy, setDeploy] = useState<DeployState>({ status: 'idle', steps: [] });
  const abortRef = useRef<(() => void) | null>(null);

  // Fetch branch + profiles on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [branchesRes, profilesRes] = await Promise.all([
        cdsGet<BranchInfo[]>('/branches'),
        cdsGet<BuildProfile[]>('/build-profiles'),
      ]);
      if (cancelled) return;
      setLoaded(true);
      const found = (branchesRes || []).find(b => b.id === branchSlug);
      setBranchInfo(found || null);
      setProfiles(profilesRes || []);
    })();
    return () => { cancelled = true; };
  }, [branchSlug]);

  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  const isDeploying = deploy.status === 'deploying';

  const handleDeploy = useCallback((profileId?: string) => {
    if (!branchSlug || isDeploying) return;
    setDeploy({ status: 'deploying', profileId, steps: [] });
    const abort = deployViaSSE(
      branchSlug,
      profileId,
      (step) => setDeploy(prev => ({
        ...prev,
        steps: [...prev.steps.filter(s => s.step !== step.step), step],
      })),
      (msg) => {
        setDeploy(prev => ({ ...prev, status: 'success', message: msg }));
        setTimeout(() => setDeploy({ status: 'idle', steps: [] }), 3000);
      },
      (msg) => {
        setDeploy(prev => ({ ...prev, status: 'error', message: msg }));
      },
    );
    abortRef.current = abort;
  }, [branchSlug, isDeploying]);

  if (!loaded) {
    return (
      <div style={{ color: '#8b949e', fontSize: 11, padding: '4px 0' }}>
        <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> 加载中...
      </div>
    );
  }

  if (!branchInfo) {
    return (
      <div style={{ color: '#8b949e', fontSize: 11, padding: '4px 0' }}>
        分支 &quot;{branchSlug}&quot; 未在 CDS 中注册
      </div>
    );
  }

  return (
    <>
      {/* Service status */}
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>
        状态: <span style={{ color: branchInfo.status === 'running' ? '#3fb950' : '#f0883e' }}>
          {branchInfo.status}
        </span>
      </div>

      {/* Deploy buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {profiles.map(p => (
          <button
            key={p.id}
            disabled={isDeploying}
            onClick={() => handleDeploy(p.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 8px', borderRadius: 6,
              border: '1px solid #30363d', background: '#21262d',
              color: '#c9d1d9', fontSize: 11, cursor: isDeploying ? 'wait' : 'pointer',
              opacity: isDeploying && deploy.profileId !== p.id ? 0.5 : 1,
            }}
            onMouseEnter={e => { if (!isDeploying) e.currentTarget.style.borderColor = '#58a6ff'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#30363d'; }}
          >
            {isDeploying && deploy.profileId === p.id
              ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
              : <RefreshCw size={11} />}
            更新 {p.name}
          </button>
        ))}

        {profiles.length > 1 && (
          <button
            disabled={isDeploying}
            onClick={() => handleDeploy()}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 8px', borderRadius: 6,
              border: '1px solid #30363d', background: '#161b22',
              color: '#c9d1d9', fontSize: 11, cursor: isDeploying ? 'wait' : 'pointer',
              opacity: isDeploying && deploy.profileId !== undefined ? 0.5 : 1,
            }}
            onMouseEnter={e => { if (!isDeploying) e.currentTarget.style.borderColor = '#58a6ff'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#30363d'; }}
          >
            {isDeploying && deploy.profileId === undefined
              ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
              : <RefreshCw size={11} />}
            全量更新
          </button>
        )}
      </div>

      {/* Deploy progress */}
      {deploy.steps.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {deploy.steps.map(s => (
            <div key={s.step} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 10, color: s.status === 'done' ? '#3fb950' : s.status === 'error' ? '#f85149' : '#8b949e',
            }}>
              {s.status === 'running' && <Loader2 size={9} style={{ animation: 'spin 1s linear infinite' }} />}
              {s.status === 'done' && <CheckCircle2 size={9} />}
              {s.status === 'error' && <XCircle size={9} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.title}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Result message */}
      {deploy.status === 'success' && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#3fb950' }}>
          {deploy.message}
        </div>
      )}
      {deploy.status === 'error' && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#f85149' }}>
          {deploy.message}
          <button
            onClick={() => setDeploy({ status: 'idle', steps: [] })}
            style={{
              marginLeft: 6, padding: '1px 4px', fontSize: 10, borderRadius: 3,
              border: '1px solid #f85149', background: 'transparent', color: '#f85149', cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      )}
    </>
  );
}

// ── Main component ──

export function BranchBadge() {
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [cdsDetected, setCdsDetected] = useState(false);

  const badgeRef = useRef<HTMLDivElement>(null);

  const branch = typeof __GIT_BRANCH__ === 'string' ? __GIT_BRANCH__ : '';
  const branchSlug = slugify(branch);
  const deployMode = isDeployMode();
  const { position, onMouseDown } = useDrag({ x: 12, y: 12 });

  // Silent CDS probe on mount — only fires once, no UI flicker
  useEffect(() => {
    if (!branch || HIDDEN_BRANCHES.includes(branch)) return;
    probeCds().then(ok => setCdsDetected(ok));
  }, [branch]);

  // Auto-hide after 5s in deploy mode (only when panel is closed)
  useEffect(() => {
    if (!branch || HIDDEN_BRANCHES.includes(branch) || dismissed) return;
    if (deployMode && !expanded) {
      const timer = setTimeout(() => setVisible(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [branch, dismissed, deployMode, expanded]);

  // Show badge again when panel is expanded
  useEffect(() => {
    if (expanded) setVisible(true);
  }, [expanded]);

  if (!branch || HIDDEN_BRANCHES.includes(branch) || dismissed || !visible) return null;

  const modeColor = deployMode
    ? 'rgba(35, 134, 54, 0.85)'
    : 'rgba(218, 139, 69, 0.85)';
  const borderColor = deployMode ? 'rgba(63, 185, 80, 0.3)' : 'rgba(218, 139, 69, 0.3)';

  return (
    <div
      id="bt-branch-badge"
      ref={badgeRef}
      style={{
        position: 'fixed',
        left: position.x,
        bottom: position.y,
        zIndex: 99999,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        color: '#e2e8f0',
        userSelect: 'none',
      }}
    >
      {/* CDS update panel — only when CDS is hosting AND user expanded */}
      {cdsDetected && expanded && (
        <div style={{
          marginBottom: 4,
          padding: '10px 12px',
          borderRadius: 8,
          fontSize: 12,
          background: 'rgba(22, 27, 34, 0.95)',
          backdropFilter: 'blur(12px)',
          border: `1px solid ${borderColor}`,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          minWidth: 220,
        }}>
          <CdsUpdatePanel branchSlug={branchSlug} borderColor={borderColor} />
        </div>
      )}

      {/* Badge bar */}
      <div
        onMouseDown={onMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1,
          background: modeColor,
          backdropFilter: 'blur(8px)',
          border: `1px solid ${borderColor}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
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

        {/* Expand button — only visible when CDS is detected */}
        {cdsDetected && (
          <button
            onClick={() => setExpanded(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 2, padding: 2, borderRadius: 4,
              border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.6,
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; }}
            title={expanded ? '收起' : '展开更新面板'}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}

        <button
          onClick={() => setDismissed(true)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: 2, padding: 2, borderRadius: 4,
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.5,
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Keyframe for spinner (only injected once, harmless) */}
      {cdsDetected && <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>}
    </div>
  );
}
