import { useCallback, useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { Dialog } from '@/components/ui/Dialog';
import { WatermarkSettingsPanel } from '@/components/watermark/WatermarkSettingsPanel';
import { listLiteraryPrompts, createLiteraryPrompt, updateLiteraryPrompt, deleteLiteraryPrompt } from '@/services';
import { RefreshCw, Plus, Trash2 } from 'lucide-react';

interface LiteraryPrompt {
  id: string;
  title: string;
  content: string;
  scenarioType?: string | null;
  order: number;
  isSystem: boolean;
}

export function LiteraryPromptsPanel() {
  const [loading, setLoading] = useState(false);
  const [prompts, setPrompts] = useState<LiteraryPrompt[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState<string | null>('article-illustration');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [editingContent, setEditingContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listLiteraryPrompts({ scenarioType: scenarioFilter });
      if (!res.success) {
        setError(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setPrompts(res.data?.items || []);
    } finally {
      setLoading(false);
    }
  }, [scenarioFilter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      {error && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid var(--border-default)', background: 'var(--nested-block-bg)', color: 'rgba(255,120,120,0.95)' }}>
          {error}
        </div>
      )}

      <GlassCard animated className="p-5 flex-shrink-0">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>文学创作提示词</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              管理文学创作场景的提示词模板（支持场景分类与全局共享）
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedTabs<string>
              ariaLabel="场景筛选"
              items={[
                { key: 'article-illustration', label: '文章配图' },
                { key: 'global', label: '全局共享' },
              ]}
              value={scenarioFilter || 'article-illustration'}
              onChange={(next) => setScenarioFilter(next === 'global' ? null : next)}
              disabled={loading}
            />
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} /> 刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setCreating(true)} disabled={loading}>
              <Plus size={16} /> 新建
            </Button>
          </div>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {prompts.map((prompt) => (
            <GlassCard animated key={prompt.id} className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{prompt.title}</div>
                  <div className="flex items-center gap-1 mt-1">
                    {(!prompt.scenarioType || prompt.scenarioType === 'global') ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(168, 85, 247, 0.12)', color: 'rgba(168, 85, 247, 0.95)', border: '1px solid rgba(168, 85, 247, 0.28)' }}>全局</span>
                    ) : prompt.scenarioType === 'article-illustration' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'rgba(34, 197, 94, 0.95)', border: '1px solid rgba(34, 197, 94, 0.28)' }}>文章配图</span>
                    ) : null}
                    {prompt.isSystem && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(147, 197, 253, 0.12)', color: 'rgba(147, 197, 253, 0.95)', border: '1px solid rgba(147, 197, 253, 0.28)' }}>系统</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-xs mt-2 line-clamp-3" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{prompt.content}</div>
              <div className="flex items-center gap-2 mt-3">
                <Button variant="secondary" size="xs" onClick={() => { setEditingId(prompt.id); setEditingTitle(prompt.title); setEditingContent(prompt.content); }} disabled={loading}>编辑</Button>
                {!prompt.isSystem && (
                  <Button variant="danger" size="xs" onClick={async () => {
                    if (!confirm(`确定要删除「${prompt.title}」吗？`)) return;
                    const res = await deleteLiteraryPrompt({ id: prompt.id });
                    if (res.success) await load();
                    else setError(res.error?.message || '删除失败');
                  }} disabled={loading}>
                    <Trash2 size={12} /> 删除
                  </Button>
                )}
              </div>
            </GlassCard>
          ))}
        </div>

        {prompts.length === 0 && !loading && (
          <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
            暂无提示词，点击「新建」创建第一个模板
          </div>
        )}
      </GlassCard>

      <div className="min-h-0 flex-1 flex flex-col">
        <WatermarkSettingsPanel appKey="literary-agent" columns={3} />
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={(open) => !open && setCreating(false)} title="新建文学创作提示词" description="创建一个新的提示词模板" maxWidth={800} content={
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>标题</label>
            <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="例如：文章配图标准模板" className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field" />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>内容</label>
            <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder="输入提示词内容..." rows={12} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none resize-none font-mono prd-field" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setCreating(false)}>取消</Button>
            <Button variant="primary" onClick={async () => {
              if (!newTitle.trim() || !newContent.trim()) { setError('标题和内容不能为空'); return; }
              const res = await createLiteraryPrompt({ title: newTitle, content: newContent, scenarioType: scenarioFilter || 'article-illustration' });
              if (res.success) { setCreating(false); setNewTitle(''); setNewContent(''); await load(); }
              else setError(res.error?.message || '创建失败');
            }} disabled={!newTitle.trim() || !newContent.trim()}>创建</Button>
          </div>
        </div>
      } />

      {/* Edit dialog */}
      <Dialog open={!!editingId} onOpenChange={(open) => !open && setEditingId(null)} title="编辑文学创作提示词" description="修改提示词模板" maxWidth={800} content={
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>标题</label>
            <input type="text" value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field" />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>内容</label>
            <textarea value={editingContent} onChange={(e) => setEditingContent(e.target.value)} rows={12} className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none resize-none font-mono prd-field" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setEditingId(null)}>取消</Button>
            <Button variant="primary" onClick={async () => {
              if (!editingId || !editingTitle.trim() || !editingContent.trim()) { setError('标题和内容不能为空'); return; }
              const res = await updateLiteraryPrompt({ id: editingId, title: editingTitle, content: editingContent });
              if (res.success) { setEditingId(null); await load(); }
              else setError(res.error?.message || '保存失败');
            }} disabled={!editingTitle.trim() || !editingContent.trim()}>保存</Button>
          </div>
        </div>
      } />
    </div>
  );
}
