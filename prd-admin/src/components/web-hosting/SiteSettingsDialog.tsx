import { lazy, Suspense, useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Switch } from '@/components/design/Switch';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getSite, listFolders, setSiteCommentsEnabled, updateSite, type HostedSite } from '@/services/real/webPages';

const AskConfigDrawer = lazy(() => import('./ask/AskConfigDrawer'));
const fieldClass = 'w-full rounded-lg border border-token-default bg-token-input px-3 py-2 text-sm text-token-primary outline-none focus:border-blue-500';

export default function SiteSettingsDialog({ siteId, siteTitle, onClose, onSaved }: {
  siteId: string;
  siteTitle: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'page' | 'ask'>('page');
  const [askVisited, setAskVisited] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="网页设置"
    description={siteTitle} maxWidth={680}
    content={<div className="flex min-h-0 flex-col" style={{ height: 'min(68dvh, 620px)' }}>
      <div className="mb-3 flex shrink-0 gap-1 rounded-lg bg-token-nested p-1" aria-label="设置分类">
        {([['page', '网页信息'], ['ask', '提问设置']] as const).map(([value, label]) => <button
          key={value} type="button" disabled={busy} aria-pressed={tab === value}
          onClick={() => { setTab(value); if (value === 'ask') setAskVisited(true); }}
          className={`min-h-10 flex-1 rounded-md px-4 text-sm transition-colors ${tab === value ? 'bg-token-elevated font-semibold text-token-primary shadow-sm' : 'text-token-muted hover-bg-soft'}`}>
          {label}
        </button>)}
      </div>
      <div className="min-h-0 flex-1" style={{ display: tab === 'page' ? 'flex' : 'none' }}>
        <PageSettingsForm siteId={siteId} onClose={onClose} onSaved={onSaved} onBusyChange={setBusy} />
      </div>
      {askVisited && <div className="min-h-0 flex-1" style={{ display: tab === 'ask' ? 'flex' : 'none' }}>
        <Suspense fallback={<MapSectionLoader text="正在读取提问设置…" />}>
          <AskConfigDrawer siteId={siteId} siteTitle={siteTitle} embedded onClose={onClose}
            onBusyChange={setBusy} onSaved={() => onSaved()} />
        </Suspense>
      </div>}
    </div>} />;
}

/** 只提交改过的字段；各步骤成功后更新基线，失败重试不会覆盖已经保存的值。 */
export function PageSettingsForm({ siteId, onClose, onSaved, onBusyChange }: {
  siteId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [baseline, setBaseline] = useState<HostedSite | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [folder, setFolder] = useState('');
  const [comments, setComments] = useState(true);
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([getSite(siteId), listFolders().catch(() => null)]).then(([result, options]) => {
      if (!active) return;
      if (!result.success) throw new Error(result.error?.message || '读取网页信息失败');
      const site = result.data;
      setBaseline(site); setTitle(site.title); setDescription(site.description ?? '');
      setTags(site.tags.join('，')); setFolder(site.folder ?? ''); setComments(site.commentsEnabled !== false);
      if (options?.success) setFolders(options.data.folders);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取网页信息失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [siteId]);

  const save = async () => {
    if (!baseline || saving || !title.trim()) return;
    setSaving(true); onBusyChange(true); setError(''); setSaved(false);
    let informationSaved = false;
    try {
      const patch: Parameters<typeof updateSite>[1] = {};
      if (title.trim() !== baseline.title) patch.title = title.trim();
      if (description !== (baseline.description ?? '')) patch.description = description;
      if (tags !== baseline.tags.join('，')) patch.tags = [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
      if (!baseline.sharedTeamIds?.length && folder !== (baseline.folder ?? '')) patch.folder = folder;
      let updated = baseline;
      if (Object.keys(patch).length) {
        const result = await updateSite(siteId, patch);
        if (!result.success) throw new Error(result.error?.message || '网页信息保存失败');
        updated = result.data; setBaseline(updated); informationSaved = true;
      }
      if (comments !== (updated.commentsEnabled !== false)) {
        const result = await setSiteCommentsEnabled(siteId, comments);
        if (!result.success) throw new Error(`${informationSaved ? '网页信息已保存；' : ''}评论设置保存失败：${result.error?.message || '请重试'}`);
        setBaseline({ ...updated, commentsEnabled: result.data.commentsEnabled });
      }
      await onSaved(); setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    } finally { setSaving(false); onBusyChange(false); }
  };

  return <div className="flex min-h-0 w-full flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      {loading ? <MapSectionLoader text="正在读取网页信息…" /> : baseline && <fieldset onChange={() => setSaved(false)} onClick={() => setSaved(false)} disabled={saving} className="space-y-4">
        <section className="space-y-3 rounded-xl border border-token-subtle p-4">
          <h3 className="text-xs font-semibold text-token-secondary">基本信息</h3>
          <label className="block space-y-1.5 text-xs text-token-secondary">标题
            <input aria-label="网页标题" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className={fieldClass} />
          </label>
          <label className="block space-y-1.5 text-xs text-token-secondary">描述
            <textarea aria-label="网页描述" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话介绍这个网页" className={`${fieldClass} resize-none`} />
          </label>
        </section>
        <section className="space-y-3 rounded-xl border border-token-subtle p-4">
          <h3 className="text-xs font-semibold text-token-secondary">整理与分类</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-xs text-token-secondary">标签
              <input aria-label="网页标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔" className={fieldClass} />
            </label>
            {!baseline.sharedTeamIds?.length && <label className="block space-y-1.5 text-xs text-token-secondary">分组
              <input aria-label="网页分组" value={folder} list={`site-folders-${siteId}`} onChange={(event) => setFolder(event.target.value)} placeholder="未分组" className={fieldClass} />
              <datalist id={`site-folders-${siteId}`}>{folders.map((value) => <option key={value} value={value} />)}</datalist>
            </label>}
          </div>
          {!!baseline.sharedTeamIds?.length && <p className="text-xs text-token-muted">团队分组可在网页托管列表中调整。</p>}
        </section>
        <section className="flex items-center justify-between gap-4 rounded-xl border border-token-subtle p-4">
          <div><h3 className="text-sm font-medium text-token-primary">允许评论</h3><p className="mt-1 text-xs text-token-muted">关闭后保留已有评论，停止新增评论。</p></div>
          <Switch checked={comments} onCheckedChange={setComments} disabled={saving} ariaLabel="允许评论" />
        </section>
      </fieldset>}
      {saved && <p role="status" className="mt-3 text-xs text-token-secondary">网页信息已保存</p>}
      {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--semantic-danger-text)' }}>{error}</p>}
    </div>
    <div className="mt-3 flex shrink-0 justify-end gap-2 border-t border-token-subtle pt-3">
      <Button variant="secondary" disabled={saving} onClick={onClose}>关闭</Button>
      <Button disabled={loading || saving || !baseline || !title.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存网页信息'}</Button>
    </div>
  </div>;
}
