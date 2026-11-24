import { lazy, Suspense, useEffect, useState } from 'react';
import { FileText, Folder, MessageSquare, Settings2, Tags, Type } from 'lucide-react';
import { SiteSettingsRow, SiteSettingsToggleRow } from './SiteSettingsRows';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Switch } from '@/components/design/Switch';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getSite, listFolders, setSiteCommentsEnabled, updateSite, type HostedSite } from '@/services/real/webPages';

const AskConfigDrawer = lazy(() => import('./ask/AskConfigDrawer'));
const fieldClass = 'w-full rounded-lg border border-token-default bg-token-input px-2 py-2 text-xs text-token-primary outline-none focus:border-[var(--border-focus)]';

export default function SiteSettingsDialog({ siteId, siteTitle, onClose, onSaved }: {
  siteId: string;
  siteTitle: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'page' | 'ask'>('page');
  const [askVisited, setAskVisited] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={<><Settings2 size={13} /><span>设置</span></>}
    titleAction={<span className="truncate text-[11px] text-token-muted" style={{ maxWidth: 'min(180px, 40vw)' }} title={siteTitle}>{siteTitle}</span>}
    maxWidth={400} contentStyle={{ borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
    content={<div className="flex min-h-0 flex-col" style={{ maxHeight: 'min(72dvh, 620px)' }}>
      <div className="site-settings-tabs shrink-0" aria-label="设置分类">
        {([['page', '网页信息'], ['ask', '提问设置']] as const).map(([value, label]) => <button
          key={value} type="button" disabled={busy} aria-pressed={tab === value}
          onClick={() => { setTab(value); if (value === 'ask') setAskVisited(true); }}
          className="transition-colors">
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
      {loading ? <MapSectionLoader text="正在读取网页信息…" /> : baseline && <fieldset onChange={() => setSaved(false)} onClick={() => setSaved(false)} disabled={saving}>
        <div className="site-settings-group">
          <SiteSettingsRow icon={<Type size={12} />} label="标题" value={title || '未填写'}>
            <input aria-label="网页标题" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className={fieldClass} />
          </SiteSettingsRow>
          <SiteSettingsRow icon={<FileText size={12} />} label="描述" value={description || '未填写'}>
            <textarea aria-label="网页描述" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话介绍这个网页" className={`${fieldClass} resize-none`} />
          </SiteSettingsRow>
          <SiteSettingsRow icon={<Tags size={12} />} label="标签" value={tags || '未设置'}>
            <input aria-label="网页标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔" className={fieldClass} />
          </SiteSettingsRow>
          {!baseline.sharedTeamIds?.length && <SiteSettingsRow icon={<Folder size={12} />} label="分组" value={folder || '未分组'}>
            <input aria-label="网页分组" value={folder} list={`site-folders-${siteId}`} onChange={(event) => setFolder(event.target.value)} placeholder="未分组" className={fieldClass} />
            <datalist id={`site-folders-${siteId}`}>{folders.map((value) => <option key={value} value={value} />)}</datalist>
          </SiteSettingsRow>}
          <SiteSettingsToggleRow icon={<MessageSquare size={12} />} label="允许评论" hint="关闭后保留已有评论，停止新增评论。">
            <Switch checked={comments} onCheckedChange={setComments} disabled={saving} ariaLabel="允许评论" />
          </SiteSettingsToggleRow>
        </div>
        {!!baseline.sharedTeamIds?.length && <p className="mt-2 text-[11px] text-token-muted">团队分组可在网页托管列表中调整。</p>}
      </fieldset>}
      {saved && <p role="status" className="mt-3 text-xs text-token-secondary">网页信息已保存</p>}
      {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--semantic-danger-text)' }}>{error}</p>}
    </div>
    <div className="site-settings-footer">
      <Button variant="secondary" disabled={saving} onClick={onClose}>关闭</Button>
      <Button disabled={loading || saving || !baseline || !title.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存网页信息'}</Button>
    </div>
  </div>;
}
