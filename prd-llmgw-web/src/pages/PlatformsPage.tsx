// 平台：表格展示平台名/类型/API URL/并发/启用/密钥是否已配置。密钥本身绝不展示（只回 hasKey）。
// 启用态可就地切换（写入共享 Mongo，MAP 侧模型调度立即生效）。密钥配置仍走 MAP 后台（此处不改密钥）。
import { useEffect, useState } from 'react';
import { getPlatforms, setPlatformEnabled } from '@/lib/api';
import type { PlatformItem } from '@/lib/types';
import { Chip, SectionLoader, Button } from '@/components/ui';
import { boolChip } from '@/components/poolsHelpers';

export function PlatformsPage() {
  const [items, setItems] = useState<PlatformItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getPlatforms().then((res) => {
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await setPlatformEnabled(p.id, !p.enabled);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === p.id ? res.data : x)) : prev));
      setToast(`已${res.data.enabled ? '启用' : '停用'}平台「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!items) return <SectionLoader text="正在加载平台…" />;
  if (items.length === 0) return <Empty text="暂无平台" />;

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
            <tr>
              <th style={th}>平台</th>
              <th style={th}>类型</th>
              <th style={th}>API URL</th>
              <th style={th}>并发</th>
              <th style={th}>状态</th>
              <th style={th}>密钥</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const en = boolChip(p.enabled, '启用', '停用');
              const key = boolChip(p.hasKey, '已配置', '未配置');
              return (
                <tr key={p.id}>
                  <td style={td}><span style={{ fontWeight: 600 }}>{p.name}</span></td>
                  <td style={td}>{p.platformType || '—'}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.apiUrl || ''}>{p.apiUrl || '—'}</td>
                  <td style={td}>{p.maxConcurrency || '—'}</td>
                  <td style={td}><Chip label={en.label} color={en.color} bg={en.bg} /></td>
                  <td style={td}><Chip label={key.label} color={key.color} bg={key.bg} /></td>
                  <td style={td}>
                    <Button size="sm" variant={p.enabled ? 'ghost' : 'primary'} disabled={busyId === p.id} onClick={() => void toggle(p)}>
                      {busyId === p.id ? '处理中…' : p.enabled ? '停用' : '启用'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
