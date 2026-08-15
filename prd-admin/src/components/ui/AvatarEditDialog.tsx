import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  applyGeneratedMyAvatar,
  generateMyAvatarPreview,
  hasRecoverableMyAvatarGeneration,
  resumeMyAvatarPreview,
  uploadUserAvatar,
} from '@/services';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';

export function AvatarEditDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  userId?: string | null;
  username?: string | null;
  userType?: string | null;
  avatarFileName?: string | null;
  /** 上传或生成头像已由服务端持久化；这里只同步调用方的本地视图状态。 */
  onPersisted: (avatar: AdminUserAvatarUploadResponse) => void;
  /** 自定义上传函数（用于自服务场景，绕过 users.write 权限） */
  onUpload?: (file: File) => Promise<ApiResponse<AdminUserAvatarUploadResponse>>;
  /** 仅用于当前用户自己的头像弹窗；管理员修改他人头像时不展示 AI 操作。 */
  enableAiEdit?: boolean;
  /** 当前用户头像的完整地址，作为 AI 编辑参考图。 */
  currentAvatarUrl?: string | null;
}) {
  const [avatarFileName, setAvatarFileName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [generatedAssetSha256, setGeneratedAssetSha256] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationIdRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);

  const aiEnabled = Boolean(props.enableAiEdit);

  const releaseGeneratedPreview = () => {
    setGeneratedUrl(null);
    setGeneratedAssetSha256(null);
  };

  useEffect(() => {
    if (!props.open) return;
    generationIdRef.current += 1;
    setGenerating(false);
    setGenerationStage('');
    setElapsedSeconds(0);
    setError(null);
    setAvatarFileName((props.avatarFileName ?? '').trim());
    setPrompt('');
    releaseGeneratedPreview();
  }, [props.open, props.avatarFileName]);

  useEffect(() => () => generationAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!props.open || !aiEnabled) return;
    if (!hasRecoverableMyAvatarGeneration()) return;

    const generationId = ++generationIdRef.current;
    generationAbortRef.current?.abort();
    const generationAbort = new AbortController();
    generationAbortRef.current = generationAbort;
    setGenerating(true);
    setGenerationStage('正在恢复头像生成任务');
    setElapsedSeconds(0);
    setError(null);

    void resumeMyAvatarPreview({
      signal: generationAbort.signal,
      onProgress: (stage) => {
        if (generationIdRef.current === generationId) setGenerationStage(stage);
      },
    }).then((response) => {
      if (generationIdRef.current !== generationId) return;
      generationAbortRef.current = null;
      setGenerating(false);
      setGenerationStage('');
      if (!response.success) {
        setError(response.error?.message || '头像生成任务恢复失败，请稍后重试');
        return;
      }
      setGeneratedAssetSha256(response.data.assetSha256);
      setGeneratedUrl(response.data.previewUrl);
    });

    return () => {
      if (generationIdRef.current === generationId) generationIdRef.current += 1;
      generationAbort.abort();
      if (generationAbortRef.current === generationAbort) generationAbortRef.current = null;
    };
  }, [aiEnabled, props.open]);

  useEffect(() => {
    if (!generating) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  const previewUrl = useMemo(() => {
    const value = avatarFileName.trim();
    return props.currentAvatarUrl?.trim() || resolveAvatarUrl({
      username: props.username ?? undefined,
      userType: props.userType ?? undefined,
      avatarFileName: value || null,
    });
  }, [avatarFileName, props.currentAvatarUrl, props.username, props.userType]);

  const closeDialog = () => {
    generationIdRef.current += 1;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    setGenerating(false);
    setGenerationStage('');
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
      const response = props.onUpload
        ? await props.onUpload(file)
        : await uploadUserAvatar({ userId: props.userId!, file });
      if (!response.success) {
        setError(toUserReadableErrorMessage(response.error, {
          code: response.error.code,
          fallbackMessage: '头像上传未完成',
          recoveryMessage: '请检查图片格式、大小和网络后重新上传。',
        }));
        return;
      }
      const fileName = String(response.data?.avatarFileName || '').trim();
      if (!fileName) throw new Error('上传返回为空');
      setAvatarFileName(fileName);
      props.onPersisted({ ...response.data, avatarFileName: fileName });
      closeDialog();
    } catch (uploadError) {
      setError(toUserReadableErrorMessage(uploadError, {
        fallbackMessage: '头像上传未完成',
        recoveryMessage: '请检查图片和网络后重新上传。',
      }));
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
    generationAbortRef.current?.abort();
    const generationAbort = new AbortController();
    generationAbortRef.current = generationAbort;
    releaseGeneratedPreview();
    setGenerating(true);
    setGenerationStage('正在排队');
    setElapsedSeconds(0);
    setError(null);

    const response = await generateMyAvatarPreview({
      prompt: trimmedPrompt,
      onProgress: (stage) => {
        if (generationIdRef.current === generationId) setGenerationStage(stage);
      },
      signal: generationAbort.signal,
    });
    if (generationIdRef.current !== generationId) return;
    generationAbortRef.current = null;
    setGenerating(false);
    setGenerationStage('');

    if (!response.success) {
      setError(response.error?.message || '头像生成失败，请重试');
      return;
    }

    setGeneratedAssetSha256(response.data.assetSha256);
    setGeneratedUrl(response.data.previewUrl);
  };

  const onApplyGeneratedAvatar = async () => {
    if (!generatedAssetSha256) return;
    setUploading(true);
    setError(null);
    try {
      const response = await applyGeneratedMyAvatar(generatedAssetSha256);
      if (!response.success) {
        setError(toUserReadableErrorMessage(response.error, {
          code: response.error.code,
          fallbackMessage: '头像替换未完成',
          recoveryMessage: '请重新生成预览后再应用。',
        }));
        return;
      }
      const fileName = String(response.data?.avatarFileName || '').trim();
      if (!fileName) throw new Error('替换头像返回为空');
      setAvatarFileName(fileName);
      props.onPersisted({ ...response.data, avatarFileName: fileName });
      closeDialog();
    } catch (applyError) {
      setError(toUserReadableErrorMessage(applyError, {
        fallbackMessage: '头像替换未完成',
        recoveryMessage: '请稍后重试。',
      }));
    } finally {
      setUploading(false);
    }
  };

  const progress = Math.min(92, 14 + elapsedSeconds * 2.6);
  const stageUrl = generatedUrl || previewUrl;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeDialog();
        else props.onOpenChange(true);
      }}
      title={aiEnabled ? <span className="sr-only">{props.title}</span> : props.title}
      description={aiEnabled ? undefined : props.description}
      maxWidth={620}
      closePlacement={aiEnabled ? 'left' : 'right'}
      contentClassName="max-[640px]:!h-[100dvh] max-[640px]:!max-h-[100dvh] max-[640px]:w-full max-[640px]:rounded-none max-[640px]:border-0 max-[640px]:p-4"
      contentStyle={{ height: 'min(820px, calc(100vh - 32px))' }}
      content={
        <div className="flex h-full min-h-0 flex-col">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              void onChooseFile(file);
            }}
            disabled={uploading || generating}
          />

          {aiEnabled ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="min-h-0 flex-1 overflow-y-auto pr-0.5" style={{ overscrollBehavior: 'contain' }}>
                <div
                  className="relative mx-auto aspect-square w-full max-w-[500px] overflow-hidden rounded-[22px]"
                  style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--border-subtle)' }}
                >
                  <UserAvatar
                    src={stageUrl}
                    alt={generatedUrl ? '生成的头像预览' : '当前头像预览'}
                    className={generating
                      ? 'absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-xl'
                      : 'absolute inset-0 h-full w-full object-cover'}
                  />

                  {generating && (
                    <>
                      <div
                        className="absolute inset-0 opacity-60"
                        style={{
                          backgroundImage: 'radial-gradient(circle, color-mix(in srgb, var(--text-primary) 72%, transparent) 1.4px, transparent 1.7px)',
                          backgroundSize: '22px 22px',
                        }}
                      />
                      <div
                        className="absolute bottom-4 left-4 flex min-h-11 items-center gap-2 rounded-full px-4 text-[13px] font-semibold"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                        role="status"
                        aria-live="polite"
                      >
                        <MapSpinner size={16} />
                        {generationStage || '正在生成头像'} · {elapsedSeconds} 秒
                      </div>
                      <div className="absolute inset-x-0 bottom-0 h-1" style={{ background: 'var(--nested-block-bg)' }}>
                        <div
                          className="h-full transition-[width] duration-500 motion-reduce:transition-none"
                          style={{ width: `${progress}%`, background: 'var(--accent-gold)' }}
                        />
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-3 flex min-h-14 items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || generating}
                    className="group relative h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded-[10px] border transition-colors hover:border-[var(--border-focus)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--nested-block-bg)' }}
                    aria-label="点击当前头像上传图片"
                    title="点击上传新头像"
                  >
                    <UserAvatar src={previewUrl} alt="当前头像" className="h-full w-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      {uploading ? <MapSpinner size={16} /> : <Upload size={16} color="white" />}
                    </span>
                  </button>
                  {generatedUrl && (
                    <div
                      className="h-12 w-12 shrink-0 overflow-hidden rounded-[10px] border"
                      style={{ borderColor: 'var(--border-focus)', background: 'var(--nested-block-bg)' }}
                      aria-label="生成头像缩略图"
                    >
                      <UserAvatar src={generatedUrl} alt="生成头像" className="h-full w-full object-cover" />
                    </div>
                  )}
                </div>
              </div>

              {error && (
                <div className="surface-state-danger shrink-0 rounded-[12px] px-3 py-2 text-[12px]" role="alert">
                  {error}
                </div>
              )}

              <div className="shrink-0">
                <label htmlFor="avatar-ai-prompt" className="mb-2 block text-[12px] font-semibold text-token-secondary">
                  描述你想要的头像
                </label>
                <div
                  className="flex min-h-14 items-center gap-2 rounded-[18px] px-2"
                  style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--border-subtle)' }}
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || generating}
                    className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[13px] text-token-muted transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="上传头像图片"
                    title="上传头像图片"
                  >
                    <ImagePlus size={20} />
                  </button>
                  <input
                    id="avatar-ai-prompt"
                    aria-describedby="avatar-ai-prompt-help"
                    value={prompt}
                    onChange={(event) => {
                      setPrompt(event.target.value.slice(0, 500));
                      if (error === '请描述想怎么修改头像') setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing && prompt.trim() && !generating && !uploading) {
                        event.preventDefault();
                        void onGeneratePreview();
                      }
                    }}
                    disabled={generating || uploading}
                    className="h-12 min-w-0 flex-1 bg-transparent px-1 text-[16px] text-token-primary outline-none placeholder:text-token-muted disabled:opacity-60"
                    placeholder="例如：改成细腻的手绘插画风格"
                    autoComplete="off"
                  />
                  <Button
                    variant="primary"
                    className="min-h-11 shrink-0 rounded-[14px] px-4 max-[420px]:px-3"
                    onClick={() => void onGeneratePreview()}
                    disabled={generating || uploading || !prompt.trim()}
                  >
                    {generating ? <MapSpinner size={16} /> : <Wand2 size={16} />}
                    <span className="max-[420px]:sr-only">{generatedUrl ? '重新生成' : '生成预览'}</span>
                  </Button>
                </div>
                <p id="avatar-ai-prompt-help" className="mt-2 px-1 text-[11px] text-token-muted">
                  {prompt.trim()
                    ? '可以继续补充细节，点击生成预览后再确认替换。'
                    : '请先描述想怎么修改头像，输入后即可生成预览。'}
                </p>
              </div>

              {generatedUrl && !generating && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="text-[11px] text-token-muted">确认后才会替换当前头像</div>
                  <div className="flex gap-2">
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
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || (!props.onUpload && !props.userId)}
                className="group relative h-36 w-36 cursor-pointer overflow-hidden rounded-[24px] border transition-colors hover:border-[var(--border-focus)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--nested-block-bg)' }}
                aria-label="点击头像上传图片"
              >
                <UserAvatar src={previewUrl} alt="当前头像" className="h-full w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 flex min-h-11 items-center justify-center gap-2 bg-black/65 px-2 text-[12px] font-semibold text-white">
                  {uploading ? <MapSpinner size={14} /> : <Upload size={15} />}
                  {uploading ? '上传中' : '点击上传'}
                </span>
              </button>
              <div className="text-center text-[12px] leading-5 text-token-muted">
                支持 png、jpg、gif、webp，上传后自动保存
              </div>
              {error && (
                <div className="surface-state-danger rounded-[12px] px-3 py-2 text-[12px]" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
