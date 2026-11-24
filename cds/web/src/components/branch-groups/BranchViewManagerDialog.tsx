import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  BRANCH_VIEW_LIMIT, BRANCH_VIEW_NAME_LIMIT, BRANCH_VIEW_PREFIX_LIMIT, BRANCH_VIEW_SOURCES,
  defaultBranchViews, newBranchViewId, normalizeBranchViews, removeBranchView,
  type BranchViewSource, type BranchViewsSettings,
} from '@/lib/branchViews';

export function BranchViewManagerDialog({ settings, onApply, onClose }: {
  settings: BranchViewsSettings;
  onApply: (settings: BranchViewsSettings) => boolean;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(settings);
  const [source, setSource] = useState<BranchViewSource>('tags');
  const [name, setName] = useState<string>(BRANCH_VIEW_SOURCES.tags.name);
  const [tagPrefix, setTagPrefix] = useState('模块:');
  const [error, setError] = useState('');
  const canAdd = draft.views.length < BRANCH_VIEW_LIMIT && name.trim().length > 0 && (source !== 'tag-prefix' || tagPrefix.trim().length > 0);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent frame className="max-w-2xl" style={{ height: 'min(42.5rem, 90vh)' }}>
        <DialogHeader className="shrink-0 border-b p-5 pr-12">
          <DialogTitle>管理分类</DialogTitle>
          <DialogDescription>只影响你的界面，按账号与项目记住；删除分类不会删除分支、标签或项目分组。</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">已添加 {draft.views.length} / {BRANCH_VIEW_LIMIT} 个分类，至少保留一个。</p>
            {draft.views.map((view) => (
              <div key={view.id} className="flex items-center gap-3 rounded-lg border bg-background p-3" data-managed-branch-view={view.id}>
                <div className="min-w-0 flex-1">
                  <label className="block">
                    <span className="sr-only">{view.name}分类名称</span>
                    <input
                      className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={view.name} maxLength={BRANCH_VIEW_NAME_LIMIT}
                      onChange={(event) => setDraft((current) => ({ ...current, views: current.views.map((item) => item.id === view.id ? { ...item, name: event.target.value } : item) }))}
                    />
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">{BRANCH_VIEW_SOURCES[view.source].name}{view.tagPrefix ? ` · 前缀 ${view.tagPrefix}` : ''}</p>
                </div>
                <Button variant="ghost" size="sm" aria-label={`删除分类 ${view.name}`} disabled={draft.views.length <= 1} onClick={() => setDraft((current) => removeBranchView(current, view.id))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <fieldset className="min-w-0 space-y-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-semibold">新增分类</legend>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              分类依据
              <select className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" value={source} onChange={(event) => {
                const next = event.target.value as BranchViewSource;
                setSource(next); setName(BRANCH_VIEW_SOURCES[next].name);
              }}>
                {(Object.keys(BRANCH_VIEW_SOURCES) as BranchViewSource[]).map((key) => <option key={key} value={key}>{BRANCH_VIEW_SOURCES[key].name}</option>)}
              </select>
            </label>
            <p className="text-xs leading-5 text-muted-foreground">{BRANCH_VIEW_SOURCES[source].description}</p>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              新分类名称
              <input className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={name} maxLength={BRANCH_VIEW_NAME_LIMIT} onChange={(event) => setName(event.target.value)} />
            </label>
            {source === 'tag-prefix' ? <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              标签前缀
              <input className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" placeholder="例如：模块:" value={tagPrefix} maxLength={BRANCH_VIEW_PREFIX_LIMIT} onChange={(event) => setTagPrefix(event.target.value)} />
            </label> : null}
            <Button variant="outline" size="sm" disabled={!canAdd} onClick={() => {
              const id = newBranchViewId();
              setDraft((current) => ({ selectedId: id, views: [...current.views, { id, name: name.trim(), source, ...(source === 'tag-prefix' ? { tagPrefix: tagPrefix.trim() } : {}) }] }));
              setError('');
            }}><Plus />新增分类</Button>
          </fieldset>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter className="shrink-0 gap-2 border-t p-5">
          <Button variant="ghost" className="sm:mr-auto" onClick={() => { setDraft(defaultBranchViews()); setError(''); }}>恢复默认分类</Button>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={draft.views.some((view) => !view.name.trim())} onClick={() => {
            if (onApply(normalizeBranchViews(draft))) onClose();
            else setError('分类已应用到当前页面，但浏览器无法保存偏好。请检查浏览器存储设置后重试。');
          }}>保存分类</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
