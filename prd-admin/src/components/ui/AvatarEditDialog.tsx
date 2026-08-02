import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { resolveAvatarUrl } from '@/lib/avatar';
import { AVATAR_AI_PROMPT_PRESETS } from '@/lib/avatarAi';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { applyGeneratedMyAvatar, generateMyAvatarPreview, uploadUserAvatar } from '@/services';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';

type EditMode = 'ai' | 'upload';

export function AvatarEditDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  userId?: string | null;
  username?: string | null;
  userType?: string | null;
  avatarFileName?: string | null;
  onSave: (avatarFileName: string | null) => Promise<void>;
  /** 自定义上传函数（用于自服务场景，绕过 users.write 权限） */
  onUpload?: (file: File) => Promise<ApiResponse<AdminUserAvatarUploadResponse>>;
  /** 仅用于当前用户自己的头像弹窗；管理员修改他人头像时不展示 AI 操作。 */
  enableAiEdit?: boolean;
  /** 当前用户头像的完整地址，作为 AI 编辑参考图。 */
  currentAvatarUrl?: string | null;
}) {
  const [avatarFileName, setAvatarFileName] = useState('');
  const [mode, setMode] = useState<EditMode>('upload');
  const [prompt, setPrompt] = useState<string>(AVATAR_AI_PROMPT_PRESETS[1]);
  const [generatedAssetSha256, setGeneratedAssetSha256] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationIdRef = useRef(0);

  const aiEnabled = Boolean(props.enableAiEdit);

  const releaseGeneratedPreview = () => {
    setGeneratedUrl(null);
    setGeneratedAssetSha256(null);
  };

  useEffect(() => {
    if (!props.open) return;
    generationIdRef.current += 1;
    setGenerating(false);
    setElapsedSeconds(0);
    setError(null);
    setAvatarFileName((props.avatarFileName ?? '').trim());
    setMode(aiEnabled ? 'ai' : 'upload');
    setPrompt(AVATAR_AI_PROMPT_PRESETS[1]);
    releaseGeneratedPreview();
  }, [aiEnabled, props.open, props.avatarFileName]);

  useEffect(() => {
    if (!generating) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  const previewUrl = useMemo(() => {
    const v = avatarFileName.trim();
    return props.currentAvatarUrl?.trim() || resolveAvatarUrl({
      username: props.username ?? undefined,
      userType: props.userType ?? undefined,
      avatarFileName: v || null,
    });
  }, [avatarFileName, props.currentAvatarUrl, props.username, props.userType]);

  const acceptHint = 'image/png,image/jpeg,image/gif,image/webp';

  const closeDialog = () => {
    generationIdRef.current += 1;
    setGenerating(false);
    props.onOpenChange(false);
  };

  const uploadAndSave = async (file: File) => {
    if (!props.onUpload && !props.userId) {
      setError('缺少 userId，无法上传头像');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const res = props.onUpload
        ? await props.onUpload(file)
        : await uploadUserAvatar({ userId: props.userId!, file });
      if (!res.success) throw new Error(res.error?.message || '上传失败');
      const fileName = String(res.data?.avatarFileName || '').trim();
      if (!fileName) throw new Error('上传返回为空');
      setAvatarFileName(fileName);
      await props.onSave(fileName);
      closeDialog();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onChooseFile = async (file: File | null | undefined) => {
    if (!file) return;
    await uploadAndSave(file);
  };

  const onGeneratePreview = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError('请描述想怎么修改头像');
      return;
    }

    const generationId = ++generationIdRef.current;
    releaseGeneratedPreview();
    setGenerating(true);
    setElapsedSeconds(0);
    setError(null);

    const res = await generateMyAvatarPreview({ sourceImageUrl: previewUrl, prompt: trimmedPrompt });
    if (generationIdRef.current !== generationId) return;
    setGenerating(false);

    if (!res.success) {
      setError(res.error?.message || '头像生成失败，请重试');
      return;
    }

    setGeneratedAssetSha256(res.data.assetSha256);
    setGeneratedUrl(res.data.previewUrl);
  };

  const onApplyGeneratedAvatar = async () => {
    if (!generatedAssetSha256) return;
    setUploading(true);
    setError(null);
    try {
      const res = await applyGeneratedMyAvatar(generatedAssetSha256);
      if (!res.success) throw new Error(res.error?.message || '替换头像失败');
      const fileName = String(res.data?.avatarFileName || '').trim();
      if (!fileName) throw new Error('替换头像返回为空');
      setAvatarFileName(fileName);
      await props.onSave(fileName);
      closeDialog();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : '替换头像失败');
    } finally {
      setUploading(false);
    }
  };

  const progress = Math.min(92, 14 + elapsedSeconds * 2.6);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeDialog();
        else props.onOpenChange(true);
      }}
      title={props.title}
      description={props.description}
      maxWidth={560}
      contentStyle={{ height: 'min(720px, calc(100vh - 48px))' }}
      content={
        <div className="flex h-full min-h-0 flex-col gap-4">
          {aiEnabled && (
            <div
              className="grid shrink-0 grid-cols-2 rounded-[12px] p-1"
              style={{ background: 'var(--nested-block-bg)' }}
              aria-label="头像修改方式"
            >
              <button
                type="button"
                className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                style={mode === 'ai'
                  ? { background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }
                  : { color: 'var(--text-muted)', border: '1px solid transparent' }}
                onClick={() => setMode('ai')}
              >
                <Wand2 size={16} />
                AI 修改
              </button>
              <button
                type="button"
                className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                style={mode === 'upload'
                  ? { background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }
                  : { color: 'var(--text-muted)', border: '1px solid transparent' }}
                onClick={() => setMode('upload')}
              >
                <Upload size={16} />
                上传图片
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {mode === 'ai' && aiEnabled ? (
              <div className="space-y-4">
                <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-4 max-[420px]:grid-cols-1">
                  <div className="flex flex-col items-center gap-2">
                    <div className="surface-inset flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[18px]">
                      <UserAvatar src={previewUrl} alt="当前头像" className="h-full w-full object-cover" />
                    </div>
                    <span className="text-[11px] text-token-muted">当前头像</span>
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="avatar-ai-prompt" className="mb-2 block text-[12px] font-semibold text-token-primary">
                      想怎么修改
                    </label>
                    <textarea
                      id="avatar-ai-prompt"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value.slice(0, 500))}
                      disabled={generating || uploading}
                      className="surface-inset w-full resize-none rounded-[12px] border border-transparent px-3 py-2.5 text-[14px] leading-6 text-token-primary outline-none transition-colors focus:border-[var(--border-focus)] disabled:opacity-60"
                      style={{ height: 96 }}
                      placeholder="例如：保留五官，改成简洁的手绘头像"
                    />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {AVATAR_AI_PROMPT_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={generating || uploading}
                          className="cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                          onClick={() => setPrompt(preset)}
                        >
                          {preset.replace('保留五官特征，', '').replace('保留人物特征，', '').replace('保留人物和服装，只把', '')}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {generating && (
                  <div
                    className="relative overflow-hidden rounded-[18px]"
                    style={{ height: 220, background: 'var(--nested-block-bg)' }}
                    role="status"
                    aria-live="polite"
                  >
                    <UserAvatar
                      src={previewUrl}
                      alt="正在生成头像预览"
                      className="absolute inset-0 h-full w-full scale-110 object-cover opacity-35 blur-xl"
                    />
                    <div
                      className="absolute inset-0 opacity-55"
                      style={{
                        backgroundImage: 'radial-gradient(circle, var(--text-muted) 1.2px, transparent 1.4px)',
                        backgroundSize: '18px 18px',
                      }}
                    />
                    <div className="absolute inset-x-4 bottom-4 rounded-[14px] p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                      <div className="flex items-center gap-2 text-[12px] font-semibold text-token-primary">
                        <MapSpinner size={15} />
                        正在根据当前头像生成预览 · {elapsedSeconds} 秒
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--nested-block-bg)' }}>
                        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${progress}%`, background: 'var(--accent-gold)' }} />
                      </div>
                    </div>
                  </div>
                )}

                {!generating && generatedUrl && (
                  <div className="flex flex-col items-center gap-3 rounded-[18px] p-4" style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--border-subtle)' }}>
                    <div className="h-40 w-40 overflow-hidden rounded-[22px]" style={{ background: 'var(--bg-card)' }}>
                      <UserAvatar src={generatedUrl} alt="AI 头像预览" className="h-full w-full object-cover" />
                    </div>
                    <div className="text-center">
                      <div className="text-[13px] font-semibold text-token-primary">预览已生成，当前头像还没有变化</div>
                      <div className="mt-1 text-[11px] text-token-muted">确认使用后才会替换你的头像</div>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button variant="secondary" size="sm" className="min-h-11" onClick={() => void onGeneratePreview()} disabled={uploading}>
                        <RefreshCw size={14} />
                        重新生成
                      </Button>
                      <Button variant="primary" size="sm" className="min-h-11" onClick={() => void onApplyGeneratedAvatar()} disabled={uploading || !generatedAssetSha256}>
                        {uploading ? <MapSpinner size={14} /> : <Check size={14} />}
                        {uploading ? '正在替换' : '使用此头像'}
                      </Button>
                    </div>
                  </div>
                )}

                {!generating && !generatedUrl && (
                  <div className="flex justify-end">
                    <Button variant="primary" className="min-h-11" onClick={() => void onGeneratePreview()} disabled={uploading || !prompt.trim()}>
                      <Wand2 size={16} />
                      生成头像预览
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 py-4">
                <div className="surface-inset flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-[18px]">
                  <UserAvatar src={previewUrl} alt="当前头像" className="h-full w-full object-cover" />
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={acceptHint}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = '';
                    void onChooseFile(file);
                  }}
                  disabled={uploading}
                />
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={uploading || (!props.onUpload && !props.userId)}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? <MapSpinner size={14} /> : <Upload size={15} />}
                  {uploading ? '上传中' : '选择图片'}
                </Button>
                <div className="text-center text-[12px] leading-5 text-token-muted">
                  支持 png、jpg、gif、webp，上传后自动保存
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="surface-state-danger shrink-0 rounded-[12px] px-3 py-2 text-[12px]" role="alert">
              {error}
            </div>
          )}

          <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
            <Button variant="ghost" className="min-h-11" onClick={closeDialog} disabled={uploading}>
              关闭
            </Button>
          </div>
        </div>
      }
    />
  );
}
