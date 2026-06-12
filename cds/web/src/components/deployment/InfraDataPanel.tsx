/*
 * InfraDataPanel — Railway 式「数据」面板:不离开拓扑页就能对数据库执行查询、看结构、
 * 跑初始化 SQL。后端为 cds/src/routes/infra-data.ts(query / schema / init-sql)。
 *
 * 独立组件(不动 BranchTopologyPage 大文件的其余部分)。仅对支持的数据库类型渲染,
 * 其余返回 null。颜色全走主题 token(无暗色字面量,白天/黑夜都可读)。无 emoji。
 */
import { useRef, useState } from 'react';
import { Database, Loader2, Play, RefreshCw, Search, Terminal, Upload } from 'lucide-react';
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

interface MigrationProfile {
  id: string;
  name: string;
}

export function InfraDataPanel({
  infraId,
  projectId,
  branchId,
  profiles = [],
  image,
  running,
  initSql,
}: {
  infraId: string;
  projectId: string;
  branchId?: string;
  profiles?: MigrationProfile[];
  image: string;
  running: boolean;
  /** Initialization SQL configured at project/infra creation; offered as a one-click prefill. */
  initSql?: string;
}): JSX.Element | null {
  const supported = SUPPORTED.test((image || '').toLowerCase());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sql, setSql] = useState('');
  const [asInit, setAsInit] = useState(false);
  const [migrationCommand, setMigrationCommand] = useState('');
  const [migrationProfileId, setMigrationProfileId] = useState(profiles[0]?.id || '');
  const [busy, setBusy] = useState<'query' | 'schema' | 'init-sql' | 'migration' | null>(null);
  const [result, setResult] = useState<DataResult | null>(null);
  const [error, setError] = useState('');

  if (!supported) return null;

  const base = `/api/infra/${encodeURIComponent(infraId)}`;
  const projectQs = `project=${encodeURIComponent(projectId)}`;

  async function runData(kind: 'query' | 'schema' | 'init-sql', sqlOverride?: string): Promise<void> {
    setError('');
    setBusy(kind);
    try {
      const res =
        kind === 'schema'
          ? await apiRequest<DataResult>(`${base}/schema?${projectQs}`)
          : await apiRequest<DataResult>(`${base}/${kind === 'init-sql' ? 'init-sql' : asInit ? 'init-sql' : 'query'}?${projectQs}`, {
              method: 'POST',
              body: { sql: sqlOverride ?? sql },
            });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function importSqlFile(file: File | null): Promise<void> {
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      setSql(text);
      setAsInit(true);
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runMigrationCommand(): Promise<void> {
    if (!branchId || !migrationCommand.trim()) return;
    setError('');
    setBusy('migration');
    try {
      const res = await apiRequest<{ ok: boolean; exitCode: number; output: string; error?: string }>(
        `/api/branches/${encodeURIComponent(branchId)}/database-init/run`,
        {
          method: 'POST',
          body: {
            command: migrationCommand.trim(),
            profileId: migrationProfileId || profiles[0]?.id,
          },
        },
      );
      setResult({
        kind: 'migration',
        exitCode: res.exitCode,
        truncated: false,
        output: res.output || '',
        error: res.ok ? null : res.error || null,
      });
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
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.txt"
            className="hidden"
            onChange={(event) => void importSqlFile(event.currentTarget.files?.[0] ?? null)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => fileInputRef.current?.click()}
            title="导入 SQL 作为自动识别失败后的手动兜底"
          >
            <Upload />
            导入 SQL
          </Button>
          {initSql && initSql.trim() ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => { setSql(initSql); setAsInit(true); }}
              title="载入创建项目时配置的初始化 SQL"
            >
              载入默认 SQL
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!running || busy !== null}
            onClick={() => void runData('schema')}
          >
            {busy === 'schema' ? <Loader2 className="animate-spin" /> : <Search />}
            查看结构
          </Button>
        </div>
      </div>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        placeholder="输入 SQL / 查询语句。SQL 初始化是自动识别失败后的手动兜底。"
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!running || busy !== null || !sql.trim()}
            onClick={() => void runData('init-sql')}
            title="重新执行当前 SQL 初始化脚本"
          >
            {busy === 'init-sql' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            重新初始化
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!running || busy !== null || !sql.trim()}
            onClick={() => void runData('query')}
          >
            {busy === 'query' ? <Loader2 className="animate-spin" /> : <Play />}
            执行
          </Button>
        </div>
      </div>
      <details className="rounded-md border border-border bg-background/60 p-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4" />
          执行迁移命令
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            value={migrationProfileId || profiles[0]?.id || ''}
            onChange={(event) => setMigrationProfileId(event.target.value)}
            disabled={profiles.length <= 1 || busy !== null}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name || profile.id}</option>
            ))}
          </select>
          <input
            className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            value={migrationCommand}
            onChange={(event) => setMigrationCommand(event.target.value)}
            placeholder="pnpm exec prisma migrate deploy"
          />
          <Button
            type="button"
            size="sm"
            disabled={!branchId || !running || busy !== null || !migrationCommand.trim()}
            onClick={() => void runMigrationCommand()}
          >
            {busy === 'migration' ? <Loader2 className="animate-spin" /> : <Play />}
            执行
          </Button>
        </div>
      </details>
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
