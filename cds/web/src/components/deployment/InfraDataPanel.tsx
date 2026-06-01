/*
 * InfraDataPanel — Railway 式「数据」面板:不离开拓扑页就能对数据库执行查询、看结构、
 * 跑初始化 SQL。后端为 cds/src/routes/infra-data.ts(query / schema / init-sql)。
 *
 * 独立组件(不动 BranchTopologyPage 大文件的其余部分)。仅对支持的数据库类型渲染,
 * 其余返回 null。颜色全走主题 token(无暗色字面量,白天/黑夜都可读)。无 emoji。
 */
import { useState } from 'react';
import { Database, Loader2, Play, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';

const SUPPORTED = /postgres|timescale|mysql|mariadb|mongo|redis|clickhouse/;

interface DataResult {
  kind: string;
  exitCode: number;
  truncated: boolean;
  output: string;
  error: string | null;
}

export function InfraDataPanel({
  infraId,
  projectId,
  image,
  running,
}: {
  infraId: string;
  projectId: string;
  image: string;
  running: boolean;
}): JSX.Element | null {
  const supported = SUPPORTED.test((image || '').toLowerCase());
  const [sql, setSql] = useState('');
  const [asInit, setAsInit] = useState(false);
  const [busy, setBusy] = useState<'query' | 'schema' | null>(null);
  const [result, setResult] = useState<DataResult | null>(null);
  const [error, setError] = useState('');

  if (!supported) return null;

  const base = `/api/infra/${encodeURIComponent(infraId)}`;
  const projectQs = `project=${encodeURIComponent(projectId)}`;

  async function run(kind: 'query' | 'schema'): Promise<void> {
    setError('');
    setBusy(kind);
    try {
      const res =
        kind === 'schema'
          ? await apiRequest<DataResult>(`${base}/schema?${projectQs}`)
          : await apiRequest<DataResult>(`${base}/${asInit ? 'init-sql' : 'query'}?${projectQs}`, {
              method: 'POST',
              body: { sql },
            });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-background/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4" />
          数据操作
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!running || busy !== null}
          onClick={() => void run('schema')}
        >
          {busy === 'schema' ? <Loader2 className="animate-spin" /> : <Search />}
          查看结构
        </Button>
      </div>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        placeholder="输入 SQL / 查询语句，例如 SELECT * FROM items LIMIT 20;（Redis 直接写命令，如 KEYS *）"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-input"
            checked={asInit}
            onChange={(event) => setAsInit(event.target.checked)}
          />
          作为初始化执行（记录为破坏性操作）
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!running || busy !== null || !sql.trim()}
          onClick={() => void run('query')}
        >
          {busy === 'query' ? <Loader2 className="animate-spin" /> : <Play />}
          执行
        </Button>
      </div>
      {!running ? (
        <div className="text-xs text-muted-foreground">服务未运行，启动后才能执行数据操作。</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {result ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words cds-surface-sunken cds-hairline p-3 font-mono text-xs leading-6">
          {(result.error ? `[exit ${result.exitCode}]\n${result.error}\n\n` : '') + (result.output || '(无输出)')}
          {result.truncated ? '\n…(输出已截断)' : ''}
        </pre>
      ) : null}
    </div>
  );
}
