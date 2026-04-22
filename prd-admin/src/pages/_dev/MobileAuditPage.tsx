import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { getClientErrors, clearClientErrors, type ClientErrorEntry } from '@/lib/clientErrorReporter';
import { MOBILE_COMPAT_REGISTRY, type MobileCompatLevel } from '@/lib/mobileCompatibility';

/**
 * 移动端适配审计工具 — 开发专用。
 *
 * 双视图：
 *   1. 预览墙：所有页面以 375×667 iframe 并排渲染
 *   2. 诊断面板：每路由自动加载并检测"黑屏 / console 错误 / 未捕获异常"，输出表格
 *
 * 访问路径：/_dev/mobile-audit（需先登录，iframe 共享 cookie）
 */

interface RouteEntry {
  path: string;
  label: string;
  group: string;
}

const ROUTES: RouteEntry[] = [
  // ── 已适配 ──
  { path: '/', label: '首页', group: '✅ 已适配' },
  { path: '/executive', label: '总裁面板', group: '✅ 已适配' },
  { path: '/ai-toolbox', label: 'AI 百宝箱', group: '✅ 已适配' },
  { path: '/prd-agent', label: 'PRD 协作', group: '✅ 已适配' },
  { path: '/settings', label: '系统设置', group: '✅ 已适配' },
  { path: '/prompts', label: '提示词管理', group: '✅ 已适配' },
  { path: '/literary-agent', label: '文学创作列表', group: '✅ 已适配' },
  { path: '/defect-agent', label: '缺陷管理', group: '✅ 已适配' },
  { path: '/open-platform', label: '开放平台', group: '✅ 已适配' },

  // ── P1: 高频未适配 ──
  { path: '/users', label: '用户管理', group: 'P1 待检查' },
  { path: '/mds', label: '模型管理', group: 'P1 待检查' },
  { path: '/logs', label: '请求日志', group: 'P1 待检查' },
  { path: '/skills', label: '技能管理', group: 'P1 待检查' },

  // ── P2: 中频未适配 ──
  { path: '/automations', label: '自动化规则', group: 'P2 待检查' },
  { path: '/assets', label: '资源管理', group: 'P2 待检查' },
  { path: '/marketplace', label: '海鲜市场', group: 'P2 待检查' },
  { path: '/lab', label: '实验室', group: 'P2 待检查' },
];

const VIEWPORT_W = 375;
const VIEWPORT_H = 667;
const SCALE = 0.45;

/** 诊断一个路由的可见性 */
interface DiagResult {
  path: string;
  status: 'pending' | 'ok' | 'blank' | 'error' | 'timeout';
  textLen: number;
  /** body.innerText 首 140 字，供人眼识别 */
  textPreview: string;
  errors: string[];
  elapsedMs: number;
  compat: MobileCompatLevel | 'unknown';
}

type ViewMode = 'wall' | 'diag';

export default function MobileAuditPage() {
  const { isMobile } = useBreakpoint();
  const [view, setView] = useState<ViewMode>('diag');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const groups = useMemo(() => [...new Set(ROUTES.map((r) => r.group))], []);
  const filtered = useMemo(
    () => (selectedGroup ? ROUTES.filter((r) => r.group === selectedGroup) : ROUTES),
    [selectedGroup],
  );

  return (
    <div style={{ background: '#0a0a0c', minHeight: '100vh', padding: isMobile ? 12 : 32 }}>
      <div style={{ maxWidth: 1600, margin: '0 auto' }}>
        <h1 style={{ color: '#f7f7fb', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          Mobile Audit — 移动端适配审计
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 16 }}>
          自动以 {VIEWPORT_W}×{VIEWPORT_H} 视口加载每个路由，检测黑屏 / JS 报错。需先登录后访问。
        </p>

        {/* 视图切换 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <TabButton active={view === 'diag'} onClick={() => setView('diag')}>
            🔬 诊断报告
          </TabButton>
          <TabButton active={view === 'wall'} onClick={() => setView('wall')}>
            🖼 预览墙
          </TabButton>
          <TabButton active={false} onClick={() => window.location.reload()}>
            ↻ 重新审计
          </TabButton>
        </div>

        {/* 分组过滤 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          <Pill active={!selectedGroup} onClick={() => setSelectedGroup(null)}>
            全部 ({ROUTES.length})
          </Pill>
          {groups.map((g) => {
            const count = ROUTES.filter((r) => r.group === g).length;
            return (
              <Pill
                key={g}
                active={selectedGroup === g}
                onClick={() => setSelectedGroup(g === selectedGroup ? null : g)}
              >
                {g} ({count})
              </Pill>
            );
          })}
        </div>

        {view === 'diag' ? (
          <DiagView routes={filtered} />
        ) : (
          <WallView routes={filtered} isMobile={isMobile} />
        )}

        <ClientErrorPanel />
      </div>
    </div>
  );
}

/* ───────────── 诊断视图 ───────────── */

function DiagView({ routes }: { routes: RouteEntry[] }) {
  const [results, setResults] = useState<Record<string, DiagResult>>(() => {
    const init: Record<string, DiagResult> = {};
    for (const r of routes) {
      init[r.path] = {
        path: r.path,
        status: 'pending',
        textLen: 0,
        textPreview: '',
        errors: [],
        elapsedMs: 0,
        compat: MOBILE_COMPAT_REGISTRY[r.path]?.level ?? 'unknown',
      };
    }
    return init;
  });

  // 用 ref 挂 iframe，避免重渲染触发重新加载
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});

  const handleIframeLoad = useCallback((route: RouteEntry, startAt: number) => {
    const iframe = iframeRefs.current[route.path];
    if (!iframe) return;
    // 让子应用完成首屏渲染后再采样（懒加载路由 / Suspense / 异步请求）
    setTimeout(() => {
      try {
        const doc = iframe.contentDocument;
        const win = iframe.contentWindow;
        const text = (doc?.body?.innerText ?? '').trim();
        const elapsedMs = Date.now() - startAt;
        // 检测 sessionStorage 中的客户端错误（子 iframe 与父页同域同 session）
        let errors: string[] = [];
        try {
          const raw = win?.sessionStorage?.getItem('map.client-errors.v1');
          if (raw) {
            const arr = JSON.parse(raw) as ClientErrorEntry[];
            errors = (arr ?? [])
              .filter((e) => {
                try {
                  return new URL(e.url).pathname.startsWith(route.path);
                } catch {
                  return false;
                }
              })
              .map((e) => `[${e.kind}] ${e.message}`);
          }
        } catch {
          // sessionStorage 在某些跨域场景下不可读
        }

        let status: DiagResult['status'] = 'ok';
        if (text.length < 20) status = 'blank';
        if (errors.length > 0) status = 'error';

        setResults((prev) => ({
          ...prev,
          [route.path]: {
            ...prev[route.path],
            status,
            textLen: text.length,
            textPreview: text.slice(0, 140),
            errors,
            elapsedMs,
          },
        }));
      } catch {
        setResults((prev) => ({
          ...prev,
          [route.path]: {
            ...prev[route.path],
            status: 'error',
            errors: ['无法读取 iframe 文档（可能跨域或已卸载）'],
            elapsedMs: Date.now() - startAt,
          },
        }));
      }
    }, 3500);
  }, []);

  // timeout watchdog：iframe 15s 还是 pending → 超时
  useEffect(() => {
    const timer = setTimeout(() => {
      setResults((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k].status === 'pending') {
            next[k] = { ...next[k], status: 'timeout', errors: ['加载超时 >15s'] };
          }
        }
        return next;
      });
    }, 15000);
    return () => clearTimeout(timer);
  }, [routes]);

  const summary = useMemo(() => {
    const s = { ok: 0, blank: 0, error: 0, timeout: 0, pending: 0 };
    for (const r of Object.values(results)) s[r.status]++;
    return s;
  }, [results]);

  return (
    <div>
      {/* 汇总条 */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: 12,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.06)',
          marginBottom: 16,
          color: 'rgba(255,255,255,0.85)',
          fontSize: 13,
          flexWrap: 'wrap',
        }}
      >
        <SummaryChip label="通过" color="#34D399" count={summary.ok} />
        <SummaryChip label="黑屏" color="#F87171" count={summary.blank} />
        <SummaryChip label="报错" color="#FB923C" count={summary.error} />
        <SummaryChip label="超时" color="#FBBF24" count={summary.timeout} />
        <SummaryChip label="扫描中" color="#818CF8" count={summary.pending} />
      </div>

      {/* 结果表 */}
      <div
        style={{
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.08)',
          overflow: 'hidden',
          marginBottom: 16,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
              <th style={th}>路由</th>
              <th style={th}>状态</th>
              <th style={th}>兼容</th>
              <th style={th}>耗时</th>
              <th style={th}>内容预览 / 错误</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => {
              const r = results[route.path];
              const badgeColor = statusColor(r?.status ?? 'pending');
              return (
                <tr key={route.path} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={td}>
                    <div style={{ color: '#f7f7fb', fontWeight: 600 }}>{route.label}</div>
                    <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>{route.path}</div>
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: `${badgeColor}22`,
                        color: badgeColor,
                        fontWeight: 600,
                      }}
                    >
                      {r?.status ?? 'pending'}
                    </span>
                  </td>
                  <td style={td}>
                    <CompatBadge level={r?.compat ?? 'unknown'} />
                  </td>
                  <td style={{ ...td, color: 'rgba(255,255,255,0.5)' }}>
                    {r?.elapsedMs ? `${r.elapsedMs}ms` : '—'}
                  </td>
                  <td style={{ ...td, color: 'rgba(255,255,255,0.7)', maxWidth: 420 }}>
                    {r?.errors && r.errors.length > 0 ? (
                      <div style={{ color: '#f87171' }}>
                        {r.errors.slice(0, 3).map((e, i) => (
                          <div key={i} style={{ marginBottom: 2 }}>{e}</div>
                        ))}
                        {r.errors.length > 3 && <div>...还有 {r.errors.length - 3} 条</div>}
                      </div>
                    ) : (
                      <div
                        style={{
                          color: 'rgba(255,255,255,0.5)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r?.textPreview || '...'}
                        {r && r.textLen > 0 && (
                          <span style={{ color: 'rgba(255,255,255,0.25)', marginLeft: 6 }}>
                            ({r.textLen} 字)
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <a
                      href={route.path}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#818CF8', fontSize: 11, textDecoration: 'none' }}
                    >
                      打开 ↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 隐藏 iframe 用于扫描（不渲染在视觉层） */}
      <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} aria-hidden>
        {routes.map((route) => (
          <iframe
            key={route.path}
            ref={(el) => {
              iframeRefs.current[route.path] = el;
            }}
            src={route.path}
            title={`scan-${route.path}`}
            style={{ width: VIEWPORT_W, height: VIEWPORT_H, border: 'none' }}
            onLoad={() => handleIframeLoad(route, Date.now())}
          />
        ))}
      </div>
    </div>
  );
}

/* ───────────── 预览墙视图 ───────────── */

function WallView({ routes, isMobile }: { routes: RouteEntry[]; isMobile: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(VIEWPORT_W * SCALE + 16)}px, 1fr))`,
        gap: 16,
      }}
    >
      {routes.map((route) => (
        <div
          key={route.path}
          style={{
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.02)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div>
              <div style={{ color: '#f7f7fb', fontSize: 12, fontWeight: 600 }}>{route.label}</div>
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>{route.path}</div>
            </div>
            <a
              href={route.path}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'rgba(99,102,241,0.8)', fontSize: 10, textDecoration: 'none' }}
            >
              打开 ↗
            </a>
          </div>
          <div
            style={{
              width: Math.round(VIEWPORT_W * SCALE),
              height: Math.round(VIEWPORT_H * SCALE),
              overflow: 'hidden',
              margin: '8px auto',
            }}
          >
            <iframe
              src={route.path}
              title={route.label}
              style={{
                width: VIEWPORT_W,
                height: VIEWPORT_H,
                border: 'none',
                transform: `scale(${SCALE})`,
                transformOrigin: 'top left',
                pointerEvents: isMobile ? 'none' : 'auto',
              }}
              loading="lazy"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── 客户端错误面板 ───────────── */

function ClientErrorPanel() {
  const [entries, setEntries] = useState<ClientErrorEntry[]>([]);

  useEffect(() => {
    const refresh = () => setEntries(getClientErrors());
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);

  if (entries.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 24,
        padding: 16,
        borderRadius: 12,
        border: '1px solid rgba(248, 113, 113, 0.25)',
        background: 'rgba(248, 113, 113, 0.06)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ color: '#f87171', fontSize: 14, fontWeight: 700 }}>
          ⚠ 本次会话捕获到 {entries.length} 条客户端错误
        </div>
        <button
          type="button"
          onClick={() => {
            clearClientErrors();
            setEntries([]);
          }}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          清空
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto' }}>
        {entries.slice().reverse().map((e) => (
          <details
            key={e.id}
            style={{
              padding: 10,
              borderRadius: 8,
              background: 'rgba(0,0,0,0.3)',
              fontSize: 12,
              color: 'rgba(255,255,255,0.8)',
            }}
          >
            <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
              <span style={{ color: '#f87171', fontWeight: 600 }}>[{e.kind}]</span>
              <span style={{ marginLeft: 8 }}>{e.message}</span>
              <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                {new Date(e.ts).toLocaleTimeString()} · {e.viewport}
              </span>
            </summary>
            <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
              <div>URL: {e.url}</div>
              {e.source && <div>Source: {e.source}:{e.line}:{e.column}</div>}
              {e.stack && (
                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {e.stack}
                </pre>
              )}
              {e.componentStack && (
                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  -- Component stack --{e.componentStack}
                </pre>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

/* ───────────── 原子组件 ───────────── */

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
        background: active ? 'rgba(99,102,241,0.9)' : 'rgba(255,255,255,0.06)',
        color: active ? '#1a1a1a' : 'rgba(255,255,255,0.75)',
      }}
    >
      {children}
    </button>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 12px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
        background: active ? 'rgba(99,102,241,0.9)' : 'rgba(255,255,255,0.08)',
        color: active ? '#1a1a1a' : 'rgba(255,255,255,0.7)',
      }}
    >
      {children}
    </button>
  );
}

function SummaryChip({ label, color, count }: { label: string; color: string; count: number }) {
  return (
    <span>
      <span style={{ color, fontWeight: 700 }}>● {count}</span>
      <span style={{ marginLeft: 4, color: 'rgba(255,255,255,0.6)' }}>{label}</span>
    </span>
  );
}

function CompatBadge({ level }: { level: MobileCompatLevel | 'unknown' }) {
  const map: Record<string, { color: string; text: string }> = {
    full:     { color: '#34D399', text: '完整' },
    limited:  { color: '#FBBF24', text: '受限' },
    'pc-only':{ color: '#F87171', text: '仅 PC' },
    unknown:  { color: '#9CA3AF', text: '未标' },
  };
  const m = map[level];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        background: `${m.color}22`,
        color: m.color,
        fontWeight: 600,
        fontSize: 11,
      }}
    >
      {m.text}
    </span>
  );
}

function statusColor(s: DiagResult['status']): string {
  switch (s) {
    case 'ok': return '#34D399';
    case 'blank': return '#F87171';
    case 'error': return '#FB923C';
    case 'timeout': return '#FBBF24';
    default: return '#818CF8';
  }
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontWeight: 600,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const td: React.CSSProperties = {
  padding: '10px 12px',
  verticalAlign: 'top',
};
