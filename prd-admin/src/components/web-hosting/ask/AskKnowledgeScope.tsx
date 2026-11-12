import { useEffect, useState } from 'react';
import { listDocumentStores } from '@/services';
import type { DocumentStore } from '@/services/contracts/documentStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

/** 使用既有库目录；选库只表达本次检索范围，服务端每轮重新鉴权。 */
export function AskKnowledgeScope({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true); setError('');
      const items: DocumentStore[] = [];
      try {
        for (let page = 1; ; page++) {
          const res = await listDocumentStores(page, 100);
          if (!res.success) throw new Error(res.error?.message ?? '知识库目录读取失败');
          items.push(...res.data.items);
          if (items.length >= res.data.total || res.data.items.length === 0) break;
        }
        if (active) setStores(items);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '知识库目录读取失败');
      } finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [attempt]);
  return <div style={{ padding: '8px 14px', flexShrink: 0, color: 'var(--text-secondary)' }}>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
      回答依据
      <select aria-label="回答依据" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || loading}
        style={{ flex: 1, minWidth: 0, background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 6 }}>
        <option value="">当前网页</option>
        {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
      </select>
      {loading && <MapSpinner size={14} />}
    </label>
    {error && <div role="alert">{error} <button type="button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>}
    {value && <p style={{ fontSize: 11, margin: '6px 0 0' }}>在本人站点检索所选库的已解析正文；没有充分依据时不作答。</p>}
  </div>;
}
