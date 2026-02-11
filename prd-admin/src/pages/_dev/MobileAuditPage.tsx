import { useState } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';

/**
 * 移动端适配审计工具 — 开发专用。
 * 将所有后台页面以 375×667 的 iframe 并排展示，方便一眼扫描移动端渲染效果。
 * 访问路径：/_dev/mobile-audit
 * 前提：需要先登录（iframe 共享 cookie）。
 */

const ROUTES: Array<{ path: string; label: string; group: string }> = [
  // ── 已适配 ──
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

export default function MobileAuditPage() {
  const { isMobile } = useBreakpoint();
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  const groups = [...new Set(ROUTES.map((r) => r.group))];
  const filtered = selectedGroup ? ROUTES.filter((r) => r.group === selectedGroup) : ROUTES;

  return (
    <div style={{ background: '#0a0a0c', minHeight: '100vh', padding: isMobile ? 12 : 32 }}>
      <div style={{ maxWidth: 1600, margin: '0 auto' }}>
        <h1 style={{ color: '#f7f7fb', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          Mobile Audit — 移动端适配审计
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 20 }}>
          所有页面以 {VIEWPORT_W}×{VIEWPORT_H} 视口渲染。需先登录后访问此页。点击卡片可跳转对应页面。
        </p>

        {/* 分组过滤 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
          <button
            onClick={() => setSelectedGroup(null)}
            style={{
              padding: '4px 12px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: !selectedGroup ? 'rgba(214,178,106,0.9)' : 'rgba(255,255,255,0.08)',
              color: !selectedGroup ? '#1a1a1a' : 'rgba(255,255,255,0.7)',
            }}
          >
            全部 ({ROUTES.length})
          </button>
          {groups.map((g) => {
            const count = ROUTES.filter((r) => r.group === g).length;
            return (
              <button
                key={g}
                onClick={() => setSelectedGroup(g === selectedGroup ? null : g)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  background: selectedGroup === g ? 'rgba(214,178,106,0.9)' : 'rgba(255,255,255,0.08)',
                  color: selectedGroup === g ? '#1a1a1a' : 'rgba(255,255,255,0.7)',
                }}
              >
                {g} ({count})
              </button>
            );
          })}
        </div>

        {/* 预览网格 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(VIEWPORT_W * SCALE + 16)}px, 1fr))`,
            gap: 16,
          }}
        >
          {filtered.map((route) => (
            <div
              key={route.path}
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
                overflow: 'hidden',
              }}
            >
              {/* 标题 */}
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
                  style={{
                    color: 'rgba(214,178,106,0.8)',
                    fontSize: 10,
                    textDecoration: 'none',
                  }}
                >
                  打开 ↗
                </a>
              </div>

              {/* iframe 预览 */}
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
                    pointerEvents: 'none',
                  }}
                  loading="lazy"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
