import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Section, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

type Snapshot = Record<'name' | 'displayName' | 'previewIdentifier' | 'originalIdentifier' | 'repository', string>;
interface RecordEntry {
  id: string; at: string; kind: 'created' | 'baseline' | 'changed'; actor: string;
  slugSource?: 'explicit' | 'repository' | 'name';
  before?: Snapshot; after: Snapshot;
}
interface HistoryResponse { records: RecordEntry[]; nextCursor: string | null; coverage: string }
const FIELD_LABELS: Record<keyof Snapshot, string> = {
  name: '项目名称', displayName: '显示名称', previewIdentifier: '预览地址标识',
  originalIdentifier: '内部标识', repository: 'Git 仓库',
};
const SOURCE_LABELS = { explicit: '创建请求指定', repository: '仓库名称', name: '项目名称' };

export function ProjectIdentityHistory({ projectId, version }: { projectId: string; version?: string }): JSX.Element {
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [coverage, setCoverage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const load = useCallback(async (before?: string) => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const data = await apiRequest<HistoryResponse>(`/api/projects/${encodeURIComponent(projectId)}/identity-history${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      if (request !== sequence.current) return;
      setRecords((current) => before ? [...current, ...data.records] : data.records);
      setCursor(data.nextCursor); setCoverage(data.coverage);
    } catch (err) { if (request === sequence.current) setError(err instanceof Error ? err.message : '记录加载失败，请重试。'); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => {
    setRecords([]); setCursor(null); setCoverage(''); void load();
    return () => { sequence.current++; };
  }, [load, version]);
  return (
    <Section title="设置变更记录" description="记录名称、预览地址标识和仓库的变化；与部署活动分开保存。">
      {coverage === 'since-baseline' ? <p className="mb-3 text-xs text-muted-foreground">历史未知：记录启用前的修改无法还原。首次基线仅表示当时观察到的值。</p> : null}
      {error ? <ErrorBlock message={error} /> : null}
      <div className="space-y-3">
        {records.map((record) => (
          <div key={record.id} className="cds-surface-raised cds-hairline p-3 text-xs space-y-2">
            <div className="flex flex-wrap gap-2 text-muted-foreground">
              <span>{new Date(record.at).toLocaleString('zh-CN')}</span><span>{record.actor === 'unknown' ? '操作者未知' : record.actor}</span>
              <span>{record.kind === 'created' ? '创建项目' : record.kind === 'baseline' ? '首次观察基线（历史未知）' : '修改设置'}</span>
            </div>
            {record.slugSource ? <p>初始标识来源：{SOURCE_LABELS[record.slugSource]}</p> : null}
            <dl className="space-y-1">
              {(Object.keys(FIELD_LABELS) as (keyof Snapshot)[]).filter((key) => !record.before || record.before[key] !== record.after[key]).map((key) => (
                <div key={key} className="flex flex-wrap gap-x-2 break-all">
                  <dt className="text-muted-foreground">{FIELD_LABELS[key]}</dt>
                  <dd>{record.before ? `${record.before[key] || '未设置'} → ` : ''}{record.after[key] || '未设置'}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw />刷新记录</Button>
        {cursor ? <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(cursor)}>查看更早记录</Button> : null}
      </div>
      {loading ? <LoadingBlock label="加载设置变更记录" /> : null}
    </Section>
  );
}
