import { useState, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { WatermarkSettingsPanel, type WatermarkSettingsPanelHandle } from '@/components/watermark/WatermarkSettingsPanel';
import {
  ConfigManagementDialogBase,
  MarketplaceWatermarkCard,
  type ConfigManagementDialogHandle as BaseDialogHandle,
  type ConfigColumn,
  type MarketplaceCardContext,
} from '@/components/config-management';
import {
  Plus, Trash2, Edit2, Check, Image as ImageIcon, CheckCircle2, Sparkles, Hand, User
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  listLiteraryPrompts,
  createLiteraryPrompt,
  updateLiteraryPrompt,
  deleteLiteraryPrompt,
  listLiteraryPromptsMarketplace,
  publishLiteraryPrompt,
  unpublishLiteraryPrompt,
  forkLiteraryPrompt,
  listReferenceImageConfigs,
  createReferenceImageConfig,
  deleteReferenceImageConfig,
  activateReferenceImageConfig,
  deactivateReferenceImageConfig,
  listReferenceImageConfigsMarketplace,
  publishReferenceImageConfig,
  unpublishReferenceImageConfig,
  forkReferenceImageConfig,
  listWatermarksMarketplace,
  forkWatermark,
} from '@/services';
import type { LiteraryPrompt, MarketplaceLiteraryPrompt } from '@/services/contracts/literaryPrompts';
import type { ReferenceImageConfig, MarketplaceReferenceImageConfig } from '@/services/contracts/literaryAgentConfig';
import type { MarketplaceWatermarkConfig } from '@/services/contracts/watermark';

export interface ConfigManagementDialogHandle {
  open: () => void;
  close: () => void;
  editWatermarkSpec: () => void;
}

interface ConfigManagementDialogProps {
  selectedPromptId?: string | null;
  onSelectPrompt?: (prompt: LiteraryPrompt | null) => void;
  onWatermarkStatusChange?: (status: { hasActiveConfig: boolean; activeId?: string; activeName?: string }) => void;
}

export const ConfigManagementDialog = forwardRef<ConfigManagementDialogHandle, ConfigManagementDialogProps>(
  ({ selectedPromptId, onSelectPrompt, onWatermarkStatusChange }, ref) => {
    const baseDialogRef = useRef<BaseDialogHandle | null>(null);
    const watermarkPanelRef = useRef<WatermarkSettingsPanelHandle | null>(null);
    const referenceImageInputRef = useRef<HTMLInputElement | null>(null);

    // 我的配置数据
    const [myPrompts, setMyPrompts] = useState<LiteraryPrompt[]>([]);
    const [myReferenceImages, setMyReferenceImages] = useState<ReferenceImageConfig[]>([]);
    const [loading, setLoading] = useState({ prompts: false, refImages: false });
    const [saving, setSaving] = useState(false);

    // 编辑状态
    const [editingPrompt, setEditingPrompt] = useState<{ id: string; title: string; content: string; scenarioType?: string | null } | null>(null);
    const [editingPromptOpen, setEditingPromptOpen] = useState(false);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      open: () => baseDialogRef.current?.open(),
      close: () => baseDialogRef.current?.close(),
      editWatermarkSpec: () => {
        baseDialogRef.current?.open();
        setTimeout(() => watermarkPanelRef.current?.editCurrentSpec(), 200);
      },
    }));

    // 加载我的配置
    const loadMyConfigs = useCallback(async () => {
      setLoading({ prompts: true, refImages: true });
      try {
        const [promptsRes, refImagesRes] = await Promise.all([
          listLiteraryPrompts({ scenarioType: 'article-illustration' }),
          listReferenceImageConfigs(),
        ]);
        if (promptsRes.success && promptsRes.data) {
          setMyPrompts(promptsRes.data.items);
        }
        if (refImagesRes.success && refImagesRes.data) {
          setMyReferenceImages(refImagesRes.data.items);
        }
      } finally {
        setLoading({ prompts: false, refImages: false });
      }
    }, []);

    // ========== 提示词操作 ==========
    const handleCreatePrompt = async () => {
      const title = await systemDialog.prompt({
        title: '新建提示词',
        message: '请输入提示词名称',
        defaultValue: `提示词 ${myPrompts.length + 1}`,
      });
      if (!title) return;
      setSaving(true);
      try {
        const res = await createLiteraryPrompt({ title, content: '', scenarioType: 'article-illustration' });
        if (res.success && res.data?.prompt) {
          await loadMyConfigs();
          setEditingPrompt({ id: res.data.prompt.id, title: res.data.prompt.title, content: '', scenarioType: 'article-illustration' });
          setEditingPromptOpen(true);
        }
      } finally {
        setSaving(false);
      }
    };

    const handleEditPrompt = (prompt: LiteraryPrompt) => {
      setEditingPrompt({ id: prompt.id, title: prompt.title, content: prompt.content, scenarioType: prompt.scenarioType });
      setEditingPromptOpen(true);
    };

    const handleSavePrompt = async () => {
      if (!editingPrompt) return;
      setSaving(true);
      try {
        const res = await updateLiteraryPrompt({ id: editingPrompt.id, title: editingPrompt.title, content: editingPrompt.content });
        if (res.success) {
          await loadMyConfigs();
          setEditingPromptOpen(false);
          setEditingPrompt(null);
          toast.success('保存成功');
        }
      } finally {
        setSaving(false);
      }
    };

    const handleDeletePrompt = async (prompt: LiteraryPrompt) => {
      const confirmed = await systemDialog.confirm({
        title: '删除提示词',
        message: `确定要删除「${prompt.title}」吗？`,
        confirmText: '确定删除',
        tone: 'danger',
      });
      if (!confirmed) return;
      setSaving(true);
      try {
        const res = await deleteLiteraryPrompt({ id: prompt.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已删除');
        }
      } finally {
        setSaving(false);
      }
    };

    const handlePublishPrompt = async (prompt: LiteraryPrompt) => {
      setSaving(true);
      try {
        const res = await publishLiteraryPrompt({ id: prompt.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已发布到海鲜市场');
        }
      } finally {
        setSaving(false);
      }
    };

    const handleUnpublishPrompt = async (prompt: LiteraryPrompt) => {
      setSaving(true);
      try {
        const res = await unpublishLiteraryPrompt({ id: prompt.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已从海鲜市场下架');
        }
      } finally {
        setSaving(false);
      }
    };

    // ========== 风格图操作 ==========
    const handleCreateRefImage = async (file: File) => {
      const name = await systemDialog.prompt({
        title: '新建风格图配置',
        message: '请输入配置名称（如"科技风格"、"水墨风格"等）',
        defaultValue: `风格图配置 ${myReferenceImages.length + 1}`,
      });
      if (!name) return;
      setSaving(true);
      try {
        const res = await createReferenceImageConfig({ name, file });
        if (res.success) {
          await loadMyConfigs();
          toast.success('风格图配置创建成功');
        } else {
          toast.error('创建失败', res.error?.message || '未知错误');
        }
      } finally {
        setSaving(false);
      }
    };

    const handleDeleteRefImage = async (config: ReferenceImageConfig) => {
      const confirmed = await systemDialog.confirm({
        title: '删除风格图配置',
        message: `确定要删除「${config.name}」吗？`,
        confirmText: '确定删除',
        tone: 'danger',
      });
      if (!confirmed) return;
      setSaving(true);
      try {
        const res = await deleteReferenceImageConfig({ id: config.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已删除');
        }
      } finally {
        setSaving(false);
      }
    };

    const handleActivateRefImage = async (config: ReferenceImageConfig) => {
      setSaving(true);
      try {
        const res = await activateReferenceImageConfig({ id: config.id });
        if (res.success) {
          await loadMyConfigs();
        }
      } finally {
        setSaving(false);
      }
    };

    const handleDeactivateRefImage = async (config: ReferenceImageConfig) => {
      setSaving(true);
      try {
        const res = await deactivateReferenceImageConfig({ id: config.id });
        if (res.success) {
          await loadMyConfigs();
        }
      } finally {
        setSaving(false);
      }
    };

    const handlePublishRefImage = async (config: ReferenceImageConfig) => {
      setSaving(true);
      try {
        const res = await publishReferenceImageConfig({ id: config.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已发布到海鲜市场');
        }
      } finally {
        setSaving(false);
      }
    };

    const handleUnpublishRefImage = async (config: ReferenceImageConfig) => {
      setSaving(true);
      try {
        const res = await unpublishReferenceImageConfig({ id: config.id });
        if (res.success) {
          await loadMyConfigs();
          toast.success('已从海鲜市场下架');
        }
      } finally {
        setSaving(false);
      }
    };

    // ========== 海鲜市场 Fork 操作 ==========
    const handleForkPrompt = async (prompt: MarketplaceLiteraryPrompt): Promise<boolean> => {
      const res = await forkLiteraryPrompt({ id: prompt.id });
      if (res.success) {
        toast.success('下载成功，已添加到「我的」');
        await loadMyConfigs();
        return true;
      }
      return false;
    };

    const handleForkRefImage = async (config: MarketplaceReferenceImageConfig): Promise<boolean> => {
      const res = await forkReferenceImageConfig({ id: config.id });
      if (res.success) {
        toast.success('下载成功，已添加到「我的」');
        await loadMyConfigs();
        return true;
      }
      return false;
    };

    const handleForkWatermark = async (config: MarketplaceWatermarkConfig): Promise<boolean> => {
      const res = await forkWatermark({ id: config.id });
      if (res.success) {
        toast.success('下载成功，已添加到「我的」');
        await loadMyConfigs();
        return true;
      }
      return false;
    };

    // ========== 渲染辅助函数 ==========
    const renderAuthorInfo = (avatarUrl?: string | null, userName?: string) => (
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-4 h-4 rounded-full object-cover" />
        ) : (
          <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center">
            <User size={10} />
          </div>
        )}
        <span>{userName || '未知用户'} 发布</span>
      </div>
    );

    const renderForkCountBadge = (count: number) => (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1"
        style={{
          background: 'rgba(59, 130, 246, 0.12)',
          color: 'rgba(59, 130, 246, 0.95)',
          border: '1px solid rgba(59, 130, 246, 0.28)',
        }}
        title="下载次数"
      >
        <Hand size={10} />
        {count}
      </span>
    );

    const renderPublicBadge = () => (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
        style={{
          background: 'rgba(34, 197, 94, 0.12)',
          color: 'rgba(34, 197, 94, 0.95)',
          border: '1px solid rgba(34, 197, 94, 0.28)',
        }}
      >
        已公开
      </span>
    );

    const renderScenarioTag = (scenarioType?: string | null) => {
      if (!scenarioType || scenarioType === 'global') {
        return (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
            style={{
              background: 'rgba(168, 85, 247, 0.12)',
              color: 'rgba(168, 85, 247, 0.95)',
              border: '1px solid rgba(168, 85, 247, 0.28)',
            }}
            title="全局共享（所有场景可用）"
          >
            全局
          </span>
        );
      }
      if (scenarioType === 'article-illustration') {
        return (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
            style={{
              background: 'rgba(34, 197, 94, 0.12)',
              color: 'rgba(34, 197, 94, 0.95)',
              border: '1px solid rgba(34, 197, 94, 0.28)',
            }}
            title="文章配图专用"
          >
            文章配图
          </span>
        );
      }
      return null;
    };

    // ========== 栏配置 ==========
    const columns: ConfigColumn<any>[] = [
      // 提示词栏
      {
        key: 'prompts',
        title: '系统提示词',
        filterLabel: '提示词',
        titleAction: (
          <Button size="xs" variant="secondary" onClick={handleCreatePrompt} disabled={saving}>
            <Plus size={12} />
            新建
          </Button>
        ),
        renderMineContent: () => {
          if (loading.prompts) {
            return (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
              </div>
            );
          }
          if (myPrompts.length === 0) {
            return (
              <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                还没有提示词模板，点击上方「新建」创建第一个模板
              </div>
            );
          }
          return (
            <div className="flex-1 min-h-0 overflow-auto pr-1">
              <div className="grid grid-cols-1 gap-3">
                {myPrompts.map((prompt) => (
                  <GlassCard animated glow key={prompt.id} className="p-0 overflow-hidden">
                    <div className="group relative flex flex-col h-full">
                      {/* 标题区 */}
                      <div className="p-2 pb-1 flex-shrink-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            <Sparkles size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
                            <div
                              className="flex-1 font-semibold text-[13px]"
                              title={prompt.title}
                              style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                            >
                              {prompt.title}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {renderScenarioTag(prompt.scenarioType)}
                            {prompt.isPublic && renderPublicBadge()}
                            {(prompt.forkCount ?? 0) > 0 && renderForkCountBadge(prompt.forkCount ?? 0)}
                            {selectedPromptId === prompt.id && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                                style={{ background: 'var(--accent-primary)', color: 'white' }}
                              >
                                当前
                              </span>
                            )}
                          </div>
                        </div>
                        {prompt.forkedFromUserName && (
                          <div className="mt-1">
                            {renderAuthorInfo(prompt.forkedFromUserAvatar, prompt.forkedFromUserName)}
                          </div>
                        )}
                      </div>
                      {/* 内容预览区 */}
                      <div className="px-2 pb-1 flex-1 min-h-0 overflow-hidden">
                        <div
                          className="h-full overflow-auto border rounded-[6px]"
                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', minHeight: '80px', maxHeight: '120px' }}
                        >
                          <style>{`
                            .modal-prompt-md { font-size: 11px; line-height: 1.5; color: var(--text-secondary); padding: 8px; }
                            .modal-prompt-md h1,.modal-prompt-md h2,.modal-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 8px 0 4px; }
                            .modal-prompt-md p { margin: 4px 0; }
                          `}</style>
                          <div className="modal-prompt-md">
                            {prompt.content ? (
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt.content}</ReactMarkdown>
                            ) : (
                              <div style={{ color: 'var(--text-muted)' }}>（内容为空）</div>
                            )}
                          </div>
                        </div>
                      </div>
                      {/* 操作按钮区 */}
                      <div className="px-2 pb-2 pt-1 flex-shrink-0">
                        <div className="flex flex-wrap gap-1.5 justify-end">
                          {selectedPromptId !== prompt.id ? (
                            <Button size="xs" variant="secondary" onClick={() => onSelectPrompt?.(prompt)} disabled={saving}>
                              <Check size={12} />
                              选择
                            </Button>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center gap-1.5 font-semibold h-[28px] px-3 rounded-[9px] text-[12px]"
                              style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: 'rgba(34, 197, 94, 0.95)' }}
                              title="当前选中"
                            >
                              <CheckCircle2 size={12} />
                              已选择
                            </button>
                          )}
                          <Button size="xs" variant="secondary" onClick={() => handleEditPrompt(prompt)} disabled={saving}>
                            <Edit2 size={12} />
                            编辑
                          </Button>
                          {prompt.isPublic ? (
                            <Button size="xs" variant="secondary" onClick={() => handleUnpublishPrompt(prompt)} disabled={saving}>
                              取消发布
                            </Button>
                          ) : (
                            <Button size="xs" variant="secondary" onClick={() => handlePublishPrompt(prompt)} disabled={saving}>
                              发布
                            </Button>
                          )}
                          <Button size="xs" variant="danger" onClick={() => handleDeletePrompt(prompt)} disabled={saving}>
                            <Trash2 size={12} />
                            删除
                          </Button>
                        </div>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          );
        },
        loadMarketplace: async ({ keyword, sort }) => {
          const res = await listLiteraryPromptsMarketplace({ keyword, sort });
          return res.success && res.data ? res.data.items : [];
        },
        renderMarketplaceCard: (prompt: MarketplaceLiteraryPrompt, ctx: MarketplaceCardContext) => (
          <GlassCard animated key={prompt.id} className="p-0 overflow-hidden">
            <div className="flex flex-col">
              <div className="p-2 pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[13px]" style={{ color: 'var(--text-primary)' }}>
                      {prompt.title}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {renderForkCountBadge(prompt.forkCount)}
                  </div>
                </div>
                <div className="mt-1">
                  {renderAuthorInfo(prompt.ownerUserAvatar, prompt.ownerUserName)}
                </div>
              </div>
              <div className="px-2 pb-1">
                <div
                  className="overflow-hidden border rounded-[6px] p-2"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', maxHeight: '80px' }}
                >
                  <div className="text-[11px] line-clamp-3" style={{ color: 'var(--text-muted)' }}>
                    {prompt.content || '（内容为空）'}
                  </div>
                </div>
              </div>
              <div className="px-2 pb-2 pt-1">
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => ctx.onFork(prompt.id, () => handleForkPrompt(prompt))}
                    disabled={ctx.saving || ctx.forkingId === prompt.id}
                  >
                    <Hand size={12} />
                    {ctx.forkingId === prompt.id ? '下载中...' : '拿来吧'}
                  </Button>
                </div>
              </div>
            </div>
          </GlassCard>
        ),
      },
      // 风格图栏
      {
        key: 'reference-images',
        title: '风格图设置',
        filterLabel: '风格图',
        titleAction: (
          <Button size="xs" variant="secondary" disabled={saving} onClick={() => referenceImageInputRef.current?.click()}>
            <Plus size={12} />
            新增配置
          </Button>
        ),
        renderMineContent: () => {
          if (loading.refImages) {
            return (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
              </div>
            );
          }
          if (myReferenceImages.length === 0) {
            return (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4">
                <div
                  className="w-16 h-16 rounded-xl flex items-center justify-center"
                  style={{ background: 'rgba(147, 197, 253, 0.08)', border: '1px dashed rgba(147, 197, 253, 0.25)' }}
                >
                  <ImageIcon size={28} style={{ color: 'rgba(147, 197, 253, 0.5)' }} />
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  上传一张风格图后，生成的所有图片都会参考此图的风格。
                </div>
              </div>
            );
          }
          return (
            <div className="flex-1 min-h-0 overflow-auto pr-1">
              <div className="grid grid-cols-1 gap-3">
                {myReferenceImages.map((config) => (
                  <GlassCard animated key={config.id} className="p-0 overflow-hidden">
                    <div className="flex flex-col">
                      {/* 标题栏 */}
                      <div className="p-2 pb-1 flex-shrink-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {config.name}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {config.isPublic && renderPublicBadge()}
                            {(config.forkCount ?? 0) > 0 && renderForkCountBadge(config.forkCount ?? 0)}
                          </div>
                        </div>
                        {config.forkedFromUserName && (
                          <div className="mt-1">
                            {renderAuthorInfo(config.forkedFromUserAvatar, config.forkedFromUserName)}
                          </div>
                        )}
                      </div>
                      {/* 内容区 */}
                      <div className="px-2 pb-1 flex-shrink-0">
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 80px' }}>
                          <div
                            className="overflow-auto border rounded-[6px] p-2"
                            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', minHeight: '60px', maxHeight: '80px' }}
                          >
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {config.prompt || '（无提示词）'}
                            </div>
                          </div>
                          <div
                            className="relative flex items-center justify-center overflow-hidden rounded-[6px]"
                            style={{
                              background: config.imageUrl
                                ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
                                : 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                              border: config.imageUrl ? 'none' : '1px solid var(--border-subtle)',
                              minHeight: '60px',
                              maxHeight: '80px',
                            }}
                          >
                            {config.imageUrl ? (
                              <img src={config.imageUrl} alt={config.name} className="block w-full h-full object-contain" />
                            ) : (
                              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无图片</div>
                            )}
                          </div>
                        </div>
                      </div>
                      {/* 操作按钮区 */}
                      <div className="px-2 pb-2 pt-1 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex flex-wrap gap-1.5 justify-end">
                          {config.isActive ? (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center gap-1.5 font-semibold h-[28px] px-3 rounded-[9px] text-[12px] hover:brightness-110"
                              style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: 'rgba(34, 197, 94, 0.95)' }}
                              onClick={() => handleDeactivateRefImage(config)}
                              disabled={saving}
                              title="点击取消选择"
                            >
                              <CheckCircle2 size={12} />
                              已选择
                            </button>
                          ) : (
                            <Button size="xs" variant="secondary" onClick={() => handleActivateRefImage(config)} disabled={saving}>
                              <Check size={12} />
                              选择
                            </Button>
                          )}
                          {config.isPublic ? (
                            <Button size="xs" variant="secondary" onClick={() => handleUnpublishRefImage(config)} disabled={saving}>
                              取消发布
                            </Button>
                          ) : (
                            <Button size="xs" variant="secondary" onClick={() => handlePublishRefImage(config)} disabled={saving}>
                              发布
                            </Button>
                          )}
                          <Button size="xs" variant="danger" onClick={() => handleDeleteRefImage(config)} disabled={saving}>
                            <Trash2 size={12} />
                            删除
                          </Button>
                        </div>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          );
        },
        loadMarketplace: async ({ keyword, sort }) => {
          const res = await listReferenceImageConfigsMarketplace({ keyword, sort });
          return res.success && res.data ? res.data.items : [];
        },
        renderMarketplaceCard: (config: MarketplaceReferenceImageConfig, ctx: MarketplaceCardContext) => (
          <GlassCard animated key={config.id} className="p-0 overflow-hidden">
            <div className="flex flex-col">
              <div className="p-2 pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[13px]" style={{ color: 'var(--text-primary)' }}>
                      {config.name}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {renderForkCountBadge(config.forkCount)}
                  </div>
                </div>
                <div className="mt-1">
                  {renderAuthorInfo(config.ownerUserAvatar, config.ownerUserName)}
                </div>
              </div>
              <div className="px-2 pb-1">
                <div
                  className="relative flex items-center justify-center overflow-hidden rounded-[6px]"
                  style={{
                    background: config.imageUrl
                      ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
                      : 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                    height: '80px',
                  }}
                >
                  {config.imageUrl ? (
                    <img src={config.imageUrl} alt={config.name} className="block max-w-full max-h-full object-contain" />
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无图片</div>
                  )}
                </div>
              </div>
              <div className="px-2 pb-2 pt-1">
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => ctx.onFork(config.id, () => handleForkRefImage(config))}
                    disabled={ctx.saving || ctx.forkingId === config.id}
                  >
                    <Hand size={12} />
                    {ctx.forkingId === config.id ? '下载中...' : '拿来吧'}
                  </Button>
                </div>
              </div>
            </div>
          </GlassCard>
        ),
      },
      // 水印栏
      {
        key: 'watermarks',
        title: '水印设置',
        filterLabel: '水印',
        titleAction: (
          <Button size="xs" variant="secondary" onClick={() => watermarkPanelRef.current?.addSpec()}>
            <Plus size={12} />
            新增配置
          </Button>
        ),
        renderMineContent: () => (
          <WatermarkSettingsPanel
            ref={watermarkPanelRef}
            appKey="literary-agent"
            onStatusChange={onWatermarkStatusChange}
            hideAddButton
          />
        ),
        loadMarketplace: async ({ keyword, sort }) => {
          const res = await listWatermarksMarketplace({ keyword, sort });
          return res.success && res.data ? res.data.items : [];
        },
        renderMarketplaceCard: (config: MarketplaceWatermarkConfig, ctx: MarketplaceCardContext) => (
          <MarketplaceWatermarkCard
            key={config.id}
            config={config}
            ctx={ctx}
            onFork={() => handleForkWatermark(config)}
          />
        ),
      },
    ];

    return (
      <>
        <ConfigManagementDialogBase
          ref={baseDialogRef}
          columns={columns}
          mineTitle="配置管理"
          marketplaceTitle="海鲜市场"
          mineDescription="系统提示词、风格图与水印设置"
          marketplaceDescription="发现和下载社区分享的配置"
          maxWidth={1500}
          onLoadMine={loadMyConfigs}
        />

        {/* 隐藏的文件上传 input */}
        <input
          ref={referenceImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            await handleCreateRefImage(file);
          }}
        />

        {/* 提示词编辑对话框 */}
        <Dialog
          open={editingPromptOpen}
          onOpenChange={(open) => {
            if (!open) {
              setEditingPromptOpen(false);
              setEditingPrompt(null);
            }
          }}
          title="编辑提示词"
          maxWidth={800}
          content={
            editingPrompt ? (
              <div className="flex flex-col gap-4">
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>标题</label>
                  <input
                    type="text"
                    value={editingPrompt.title}
                    onChange={(e) => setEditingPrompt({ ...editingPrompt, title: e.target.value })}
                    className="w-full h-10 px-3 rounded-lg text-sm mt-1"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>内容</label>
                  <textarea
                    value={editingPrompt.content}
                    onChange={(e) => setEditingPrompt({ ...editingPrompt, content: e.target.value })}
                    rows={12}
                    className="w-full px-3 py-2 rounded-lg text-sm mt-1 resize-none"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="输入提示词内容..."
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={() => { setEditingPromptOpen(false); setEditingPrompt(null); }}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleSavePrompt}
                    disabled={!editingPrompt.title.trim() || saving}
                  >
                    保存
                  </Button>
                </div>
              </div>
            ) : null
          }
        />
      </>
    );
  }
);

ConfigManagementDialog.displayName = 'ConfigManagementDialog';
