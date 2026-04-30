import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, Loader2, Pencil, Plus, Save, Search, Trash2, Upload, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
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

type EntryMode = 'single' | 'bulk';

type InlineEditState = { key: string; value: string } | null;

const inputClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const singleFieldLabelClass = 'text-sm font-medium leading-5';

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

function normalizeBulkValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'" || quote === '`') && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBulkText(text: string): { entries: Array<{ key: string; value: string }>; errors: string[]; duplicates: string[] } {
  const trimmed = text.trim();
  const entries = new Map<string, string>();
  const duplicates = new Set<string>();
  const errors: string[] = [];

  if (!trimmed) return { entries: [], errors: [], duplicates: [] };

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        return { entries: [], errors: ['JSON 必须是对象格式，例如 {"AI_ACCESS_KEY":"..."}'], duplicates: [] };
      }
      for (const [key, value] of Object.entries(parsed)) {
        const nextKey = key.trim();
        const error = validateKey(nextKey);
        if (error) errors.push(`${nextKey || '(空 key)'}：${error}`);
        else entries.set(nextKey, normalizeBulkValue(value));
      }
      return { entries: Array.from(entries, ([key, value]) => ({ key, value })), errors, duplicates: [] };
    } catch (err) {
      return { entries: [], errors: [err instanceof Error ? err.message : String(err)], duplicates: [] };
    }
  }

  text.split(/\r?\n/).forEach((rawLine, index) => {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const equalIndex = line.indexOf('=');
    if (equalIndex === -1) {
      errors.push(`第 ${index + 1} 行缺少 =`);
      return;
    }
    const key = line.slice(0, equalIndex).trim();
    const error = validateKey(key);
    if (error) {
      errors.push(`第 ${index + 1} 行 ${key || '(空 key)'}：${error}`);
      return;
    }
    if (entries.has(key)) duplicates.add(key);
    entries.set(key, unquoteEnvValue(line.slice(equalIndex + 1)));
  });

  return { entries: Array.from(entries, ([key, value]) => ({ key, value })), errors, duplicates: Array.from(duplicates) };
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
  const [entryMode, setEntryMode] = useState<EntryMode>('single');
  const [draft, setDraft] = useState({ key: '', value: '' });
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkOverwrite, setBulkOverwrite] = useState(true);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [rowSavingKey, setRowSavingKey] = useState('');
  const [deletingKey, setDeletingKey] = useState('');
  const [formError, setFormError] = useState('');
  const [bulkError, setBulkError] = useState('');

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

  const currentEnv = state.status === 'ok' ? state.data.env || {} : {};

  const bulkPreview = useMemo(() => {
    const parsed = parseBulkText(bulkText);
    const currentKeys = new Set(Object.keys(currentEnv));
    const matched = parsed.entries.filter((entry) => currentKeys.has(entry.key));
    const added = parsed.entries.filter((entry) => !currentKeys.has(entry.key));
    return { ...parsed, matched, added };
  }, [bulkText, currentEnv]);

  function resetDraft(): void {
    setDraft({ key: '', value: '' });
    setFormError('');
  }

  function startEdit(key: string, value: string): void {
    setInlineEdit({ key, value });
    setFormError('');
  }

  async function saveNewEnv(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextKey = draft.key.trim();
    const error = validateKey(nextKey);
    if (error) {
      setFormError(error);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      await apiRequest(`/api/env/${encodeURIComponent(nextKey)}?${queryForScope(scope)}`, {
        method: 'PUT',
        body: { value: draft.value },
      });
      onToast(`${nextKey} 已添加`);
      resetDraft();
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveInlineEdit(key: string): Promise<void> {
    if (!inlineEdit || inlineEdit.key !== key) return;
    setRowSavingKey(key);
    try {
      await apiRequest(`/api/env/${encodeURIComponent(key)}?${queryForScope(scope)}`, {
        method: 'PUT',
        body: { value: inlineEdit.value },
      });
      onToast(`${key} 已更新`);
      setInlineEdit(null);
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRowSavingKey('');
    }
  }

  async function importBulkEnv(): Promise<void> {
    if (state.status !== 'ok') {
      setBulkError('环境变量仍在加载，稍后再导入');
      return;
    }
    if (bulkPreview.errors.length > 0) {
      setBulkError(bulkPreview.errors[0]);
      return;
    }
    if (bulkPreview.entries.length === 0) {
      setBulkError('请粘贴 KEY=value 或 JSON 对象');
      return;
    }

    const nextEnv = { ...currentEnv };
    let updated = 0;
    let added = 0;
    let skipped = 0;
    for (const entry of bulkPreview.entries) {
      const exists = Object.prototype.hasOwnProperty.call(currentEnv, entry.key);
      if (exists && !bulkOverwrite) {
        skipped += 1;
        continue;
      }
      if (nextEnv[entry.key] === entry.value) continue;
      if (exists) updated += 1;
      else added += 1;
      nextEnv[entry.key] = entry.value;
    }
    const changed = updated + added;
    if (changed === 0) {
      setBulkError(skipped ? `同名变量已跳过 ${skipped} 项，没有写入变化` : '没有需要写入的变化');
      return;
    }

    setBulkSaving(true);
    setBulkError('');
    try {
      await apiRequest(`/api/env?${queryForScope(scope)}`, {
        method: 'PUT',
        body: nextEnv,
      });
      onToast(`已导入 ${changed} 项，更新 ${updated} 项，新增 ${added} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
      setBulkText('');
      await load();
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBulkSaving(false);
    }
  }

  async function deleteEnv(key: string): Promise<void> {
    setDeletingKey(key);
    try {
      await apiRequest(`/api/env/${encodeURIComponent(key)}?${queryForScope(scope)}`, { method: 'DELETE' });
      onToast(`${key} 已删除`);
      if (inlineEdit?.key === key) setInlineEdit(null);
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

        <div className="rounded-md border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold">{entryMode === 'single' ? '新增变量' : '导入变量'}</div>
              <div className="mt-1 text-xs text-muted-foreground">保存后立即写入当前 scope，并在下次部署时进入容器环境。</div>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant={entryMode === 'single' ? 'secondary' : 'ghost'} size="sm" onClick={() => setEntryMode('single')}>
                <Plus />
                单条
              </Button>
              <Button type="button" variant={entryMode === 'bulk' ? 'secondary' : 'ghost'} size="sm" onClick={() => setEntryMode('bulk')}>
                <Upload />
                导入
              </Button>
            </div>
          </div>

          {entryMode === 'single' ? (
            <form className="px-4 py-4" onSubmit={(event) => void saveNewEnv(event)}>
              <div className="grid gap-3 lg:grid-cols-[minmax(180px,280px)_minmax(260px,1fr)_112px] lg:items-start">
                <label className="grid gap-2">
                  <span className={singleFieldLabelClass}>变量名</span>
                  <input
                    className={`${inputClass} h-12 font-mono text-base leading-none`}
                    value={draft.key}
                    onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                    placeholder="AI_ACCESS_KEY"
                    spellCheck={false}
                  />
                </label>
                <label className="grid gap-2">
                  <span className={singleFieldLabelClass}>变量值</span>
                  <textarea
                    className={`${textareaClass} h-12 min-h-12 max-h-32 resize-y py-3 text-base leading-5`}
                    value={draft.value}
                    onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    placeholder="value"
                    spellCheck={false}
                  />
                </label>
                <Button type="submit" className="mt-7 h-12 w-full" disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Plus />}
                  添加
                </Button>
              </div>
              {formError ? (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </div>
              ) : null}
            </form>
          ) : (
            <div className="space-y-3 px-4 py-4">
              <textarea
                className={`${textareaClass} min-h-40 resize-y`}
                value={bulkText}
                onChange={(event) => {
                  setBulkText(event.target.value);
                  setBulkError('');
                }}
                placeholder={'AI_ACCESS_KEY=value\nTENCENT_COS_SECRET_ID=value\n\n或粘贴 {"AI_ACCESS_KEY":"value"}'}
                spellCheck={false}
              />
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={bulkOverwrite}
                    onChange={(event) => setBulkOverwrite(event.target.checked)}
                  />
                  同名变量自动覆盖
                </label>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <CodePill>{bulkPreview.entries.length} 项可导入</CodePill>
                  <CodePill>{bulkPreview.matched.length} 项匹配</CodePill>
                  <CodePill>{bulkPreview.added.length} 项新增</CodePill>
                  {bulkPreview.duplicates.length > 0 ? <CodePill>{bulkPreview.duplicates.length} 个重复 key 取最后值</CodePill> : null}
                </div>
                <Button type="button" className="h-10 w-full md:w-auto" onClick={() => void importBulkEnv()} disabled={bulkSaving}>
                  {bulkSaving ? <Loader2 className="animate-spin" /> : <Upload />}
                  导入
                </Button>
              </div>
              {bulkError || bulkPreview.errors.length > 0 ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {bulkError || bulkPreview.errors[0]}
                </div>
              ) : null}
            </div>
          )}
        </div>

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
                      const isEditing = inlineEdit?.key === row.key;
                      return (
                        <div key={row.key} className="grid gap-3 px-4 py-3 text-sm lg:grid-cols-[minmax(220px,300px)_minmax(280px,1fr)_176px] lg:items-center">
                          <div className="min-w-0">
                            <div className="truncate font-mono font-semibold">{row.key}</div>
                            <div className="mt-1 flex gap-2">
                              <CodePill>{row.category.label}</CodePill>
                              {sensitive ? <CodePill>masked</CodePill> : null}
                            </div>
                          </div>
                          {isEditing ? (
                            <textarea
                              className={`${textareaClass} min-h-20 resize-y`}
                              value={inlineEdit.value}
                              onChange={(event) => setInlineEdit({ key: row.key, value: event.target.value })}
                              spellCheck={false}
                              autoFocus
                            />
                          ) : (
                            <code
                              className="flex h-10 min-w-0 items-center truncate rounded-md border border-border bg-background px-3 font-mono text-xs text-muted-foreground"
                              title={revealed || !sensitive ? row.value : undefined}
                            >
                              {displayValue || '(空)'}
                            </code>
                          )}
                          <div className="flex justify-end gap-2">
                            {isEditing ? (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  title="保存"
                                  aria-label={`保存 ${row.key}`}
                                  onClick={() => void saveInlineEdit(row.key)}
                                  disabled={rowSavingKey === row.key}
                                >
                                  {rowSavingKey === row.key ? <Loader2 className="animate-spin" /> : <Save />}
                                </Button>
                                <Button type="button" variant="outline" size="icon" title="取消" aria-label={`取消编辑 ${row.key}`} onClick={() => setInlineEdit(null)}>
                                  <X />
                                </Button>
                              </>
                            ) : (
                              <>
                                {sensitive ? (
                                  <Button type="button" variant="outline" size="icon" title={revealed ? '隐藏' : '显示'} aria-label={`${revealed ? '隐藏' : '显示'} ${row.key}`} onClick={() => toggleReveal(row.key)}>
                                    {revealed ? <EyeOff /> : <Eye />}
                                  </Button>
                                ) : (
                                  <div className="h-9 w-9" aria-hidden="true" />
                                )}
                                <Button type="button" variant="outline" size="icon" title="复制" aria-label={`复制 ${row.key}`} onClick={() => void copyValue(row.key, row.value)}>
                                  <Copy />
                                </Button>
                                <Button type="button" variant="outline" size="icon" title="编辑" aria-label={`编辑 ${row.key}`} onClick={() => startEdit(row.key, row.value)}>
                                  <Pencil />
                                </Button>
                                <ConfirmAction
                                  title="删除环境变量"
                                  description={<span className="break-all font-mono">{row.key}</span>}
                                  confirmLabel="删除"
                                  pending={deletingKey === row.key}
                                  onConfirm={() => deleteEnv(row.key)}
                                  trigger={
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="icon"
                                      title="删除"
                                      aria-label={`删除 ${row.key}`}
                                      disabled={deletingKey === row.key}
                                    >
                                      {deletingKey === row.key ? <Loader2 className="animate-spin" /> : <Trash2 />}
                                    </Button>
                                  }
                                />
                              </>
                            )}
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
