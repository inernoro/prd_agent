// 影子比对（只读）：顶部四个汇总 tile + 最近 N 条 inproc vs http 逐条对照（去黑盒，翻 http 前的一致性证据）。
import { useEffect, useState } from 'react';
import { getLogsMeta, getShadowComparisons } from '@/lib/api';
import type { ShadowData } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

type QuickFilter = 'all' | 'critical' | 'httpFail';

export function ShadowPage() {
  const [data, setData] = useState<ShadowData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appCallers, setAppCallers] = useState<string[]>([]);
  const [appCaller, setAppCaller] = useState('');
  const [quick, setQuick] = useState<QuickFilter>('all');

  useEffect(() => {
    let alive = true;
    getLogsMeta().then((res) => {
      if (!alive) return;
      if (res.success) setAppCallers(res.data.appCallers ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    getShadowComparisons({ limit: 100, appCallerCode: appCaller || undefined }).then((res) => {
      if (!alive) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [appCaller]);

  if (error) return <Empty text={error} />;
  if (!data) return <SectionLoader text="正在加载影子比对…" />;

  const s = data.summary;
  const tiles = [
    { label: '总样本', value: s.total, color: 'var(--text-primary)' },
    { label: '全字段一致', value: s.allMatch, color: '#3fb950' },
    { label: 'critical 差异', value: s.critical, color: s.critical > 0 ? '#f85149' : 'var(--text-muted)' },
    { label: 'http 失败', value: s.httpFail, color: s.httpFail > 0 ? '#d29922' : 'var(--text-muted)' },
  ];
  const recent = data.recent.filter((r) => {
    if (quick === 'critical') return r.hasCritical;
    if (quick === 'httpFail') return !r.httpOk;
    return true;
  });

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };
  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-secondary)',
    borderRadius: 8,
    height: 30,
    padding: '0 8px',
    fontSize: 12,
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Shadow comparisons</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>inproc 与 http 的逐字段一致性证据</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select value={appCaller} onChange={(e) => setAppCaller(e.target.value)} style={selectStyle}>
            <option value="">全部调用方</option>
            {appCallers.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <Button variant={quick === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setQuick('all')}>
            全部
          </Button>
          <Button variant={quick === 'critical' ? 'secondary' : 'ghost'} size="sm" onClick={() => setQuick('critical')}>
            critical
          </Button>
          <Button variant={quick === 'httpFail' ? 'secondary' : 'ghost'} size="sm" onClick={() => setQuick('httpFail')}>
            http 失败
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flexShrink: 0 }}>
        {tiles.map((t) => (
          <div
            key={t.label}
            style={{
              flex: '1 1 160px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
              padding: '12px 16px',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: t.color, marginTop: 2 }}>{t.value}</div>
          </div>
        ))}
      </div>

      {recent.length === 0 ? (
        <Empty text={data.recent.length === 0 ? '暂无影子比对样本（Mode=shadow 或配了灰度白名单后开始积累）' : '当前快速筛选下暂无样本'} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
              <tr>
                <th style={th}>时间</th>
                <th style={th}>调用方</th>
                <th style={th}>inproc 模型</th>
                <th style={th}>http 模型</th>
                <th style={th}>一致</th>
                <th style={th}>差异</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.comparedAt?.replace('T', ' ').slice(0, 19) || '—'}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{r.appCallerCode || '—'}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{r.inproc.actualModel || '—'}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{r.httpOk ? (r.http.actualModel || '—') : <span style={{ color: '#d29922' }}>http失败</span>}</td>
                  <td style={td}>
                    {r.allMatch ? (
                      <Chip label="一致" color="#3fb950" bg="rgba(63,185,80,0.14)" />
                    ) : r.hasCritical ? (
                      <Chip label="critical" color="#f85149" bg="rgba(248,81,73,0.14)" />
                    ) : (
                      <Chip label="warning" color="#d29922" bg="rgba(210,153,34,0.14)" />
                    )}
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{r.mismatches.length > 0 ? r.mismatches.map((m) => m.field).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>
      {text}
    </div>
  );
}
