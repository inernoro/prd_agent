import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, Loader2, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, Section, maskSecret } from './components';
import type { EnvResponse, LoadState } from './types';

interface EnvEditorProps {
  scope: string;
  title: string;
  description?: ReactNode;
  emptyDescription?: ReactNode;
  onToast: (message: string) => void;
  reloadKey?: number;
  topContent?: ReactNode;
}

type EditState =
  | { mode: 'create'; key: string; value: string }
  | { mode: 'edit'; originalKey: string; key: string; value: string };

const inputClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const textareaClass =
  'min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';

function queryForScope(scope: string): string {
  return `scope=${encodeURIComponent(scope)}`;
}

function isSensitiveKey(key: string): boolean {
  return /password|secret|token|key|pat|jwt|credential|private/i.test(key);
}

function categoryForKey(key: string): { label: string; order: number } {
  if (/^CDS_|^(ROOT_DOMAINS|SWITCH_DOMAIN|MAIN_DOMAIN|PREVIEW_DOMAIN|DASHBOARD_DOMAIN|JWT_SECRET)$/i.test(key)) {
    return { label: 'CDS 系统', order: 1 };
  }
  if (/GITHUB|^GH_/i.test(key)) return { label: 'GitHub', order: 2 };
  if (/MONGO|REDIS|POSTGRES|MYSQL|DATABASE|DB_/i.test(key)) return { label: '数据库', order: 3 };
  if (/PASSWORD|SECRET|TOKEN|KEY|AUTH|JWT|PAT/i.test(key)) return { label: '凭证', order: 4 };
  if (/URL|HOST|DOMAIN|PORT|ORIGIN|ENDPOINT/i.test(key)) return { label: '网络', order: 5 };
  return { label: '项目', order: 9 };
}

function validateKey(key: string): string {
  if (!key.trim()) return '变量名不能为空';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())) {
    return '变量名只允许字母、数字和下划线，且不能以数字开头';
  }
  return '';
}

export function EnvEditor({
  scope,
  title,
  description,
  emptyDescription,
  onToast,
  reloadKey = 0,
  topContent,
}: EnvEditorProps): JSX.Element {
  const [state, setState] = useState<LoadState<EnvResponse>>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<EditState>({ mode: 'create', key: '', value: '' });
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState('');
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<EnvResponse>(`/api/env?${queryForScope(scope)}`);
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const rows = useMemo(() => {
    if (state.status !== 'ok') return [];
    const needle = query.trim().toLowerCase();
    return Object.entries(state.data.env || {})
      .map(([key, value]) => ({ key, value, category: categoryForKey(key) }))
      .filter((row) => !needle || row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle))
      .sort((left, right) => left.category.order - right.category.order || left.key.localeCompare(right.key));
  }, [query, state]);

  const groupedRows = useMemo(() => {
    const groups: Array<{ label: string; rows: typeof rows }> = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last?.label === row.category.label) {
        last.rows.push(row);
      } else {
        groups.push({ label: row.category.label, rows: [row] });
      }
    }
    return groups;
  }, [rows]);

  function resetEdit(): void {
    setEdit({ mode: 'create', key: '', value: '' });
    setFormError('');
  }

  function startEdit(key: string, value: string): void {
    setEdit({ mode: 'edit', originalKey: key, key, value });
    setFormError('');
  }

  async function saveEnv(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextKey = edit.key.trim();
    const error = validateKey(nextKey);
    if (error) {
      setFormError(error);
      return;
    }
    if (edit.mode === 'edit' && edit.originalKey !== nextKey) {
      setFormError('重命名请先新建变量，再删除旧变量，避免误删密钥');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      await apiRequest(`/api/env/${encodeURIComponent(nextKey)}?${queryForScope(scope)}`, {
        method: 'PUT',
        body: { value: edit.value },
      });
      onToast(edit.mode === 'edit' ? `${nextKey} 已更新` : `${nextKey} 已添加`);
      resetEdit();
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteEnv(key: string): Promise<void> {
    const ok = window.confirm(`确认删除环境变量 ${key}？`);
    if (!ok) return;
    setDeletingKey(key);
    try {
      await apiRequest(`/api/env/${encodeURIComponent(key)}?${queryForScope(scope)}`, { method: 'DELETE' });
      onToast(`${key} 已删除`);
      if (edit.mode === 'edit' && edit.originalKey === key) resetEdit();
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDeletingKey('');
    }
  }

  async function copyValue(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      onToast(`${key} 已复制`);
    } catch {
      onToast(value);
    }
  }

  function toggleReveal(key: string): void {
    setRevealedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Section title={title} description={description}>
      <div className="space-y-5">
        {topContent}

        <form className="rounded-md border border-border bg-card px-4 py-4" onSubmit={(event) => void saveEnv(event)}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{edit.mode === 'edit' ? '编辑变量' : '新增变量'}</div>
              <div className="mt-1 text-xs text-muted-foreground">保存后立即写入当前 scope，并在下次部署时进入容器环境。</div>
            </div>
            {edit.mode === 'edit' ? (
              <Button type="button" variant="ghost" size="sm" onClick={resetEdit}>
                <X />
                取消编辑
              </Button>
            ) : null}
          </div>
          <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)_auto] lg:items-end">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">变量名</span>
              <input
                className={`${inputClass} font-mono`}
                value={edit.key}
                onChange={(event) => setEdit({ ...edit, key: event.target.value })}
                placeholder="AI_ACCESS_KEY"
                spellCheck={false}
                disabled={edit.mode === 'edit'}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">变量值</span>
              <textarea
                className={textareaClass}
                value={edit.value}
                onChange={(event) => setEdit({ ...edit, value: event.target.value })}
                placeholder="value"
                spellCheck={false}
              />
            </label>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : edit.mode === 'edit' ? <Save /> : <Plus />}
              {edit.mode === 'edit' ? '保存' : '添加'}
            </Button>
          </div>
          {formError ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {formError}
            </div>
          ) : null}
        </form>

        <div className="rounded-md border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold">变量列表</div>
              <div className="mt-1 text-xs text-muted-foreground">
                scope <CodePill>{scope}</CodePill>，当前显示 {rows.length} 项
              </div>
            </div>
            <label className="relative block min-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 key / value"
              />
            </label>
          </div>

          {state.status === 'loading' ? <div className="p-4"><LoadingBlock label="加载环境变量" /></div> : null}
          {state.status === 'error' ? <div className="p-4"><ErrorBlock message={state.message} /></div> : null}
          {state.status === 'ok' && rows.length === 0 ? (
            <div className="px-4 py-8 text-sm leading-6 text-muted-foreground">
              {emptyDescription || '当前 scope 没有环境变量。'}
            </div>
          ) : null}
          {state.status === 'ok' && rows.length > 0 ? (
            <div className="divide-y divide-border">
              {groupedRows.map((group) => (
                <div key={group.label}>
                  <div className="bg-muted/30 px-4 py-2 text-xs font-semibold text-muted-foreground">{group.label}</div>
                  <div className="divide-y divide-border">
                    {group.rows.map((row) => {
                      const sensitive = isSensitiveKey(row.key);
                      const revealed = revealedKeys.has(row.key);
                      const displayValue = sensitive && !revealed ? maskSecret(row.key, row.value) : row.value;
                      return (
                        <div key={row.key} className="grid gap-3 px-4 py-3 text-sm lg:grid-cols-[260px_minmax(0,1fr)_auto] lg:items-center">
                          <div className="min-w-0">
                            <div className="truncate font-mono font-semibold">{row.key}</div>
                            <div className="mt-1 flex gap-2">
                              <CodePill>{row.category.label}</CodePill>
                              {sensitive ? <CodePill>masked</CodePill> : null}
                            </div>
                          </div>
                          <code className="min-w-0 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground" title={revealed || !sensitive ? row.value : undefined}>
                            {displayValue || '(空)'}
                          </code>
                          <div className="flex flex-wrap justify-end gap-2">
                            {sensitive ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => toggleReveal(row.key)}>
                                {revealed ? <EyeOff /> : <Eye />}
                                {revealed ? '隐藏' : '显示'}
                              </Button>
                            ) : null}
                            <Button type="button" variant="outline" size="sm" onClick={() => void copyValue(row.key, row.value)}>
                              <Copy />
                              复制
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => startEdit(row.key, row.value)}>
                              <Pencil />
                              编辑
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void deleteEnv(row.key)}
                              disabled={deletingKey === row.key}
                            >
                              {deletingKey === row.key ? <Loader2 className="animate-spin" /> : <Trash2 />}
                              删除
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
