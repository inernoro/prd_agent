import { useEffect, useMemo, useState, useRef } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { Button } from '@/components/design/Button';
import { uploadUserAvatar } from '@/services';
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
  onSave: (avatarFileName: string | null) => Promise<void>;
  /** 自定义上传函数（用于自服务场景，绕过 users.write 权限） */
  onUpload?: (file: File) => Promise<ApiResponse<AdminUserAvatarUploadResponse>>;
}) {
  const [avatarFileName, setAvatarFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setError(null);
    setAvatarFileName((props.avatarFileName ?? '').trim());
  }, [props.open, props.avatarFileName]);

  const previewUrl = useMemo(() => {
    const v = avatarFileName.trim();
    return resolveAvatarUrl({
      username: props.username ?? undefined,
      userType: props.userType ?? undefined,
      avatarFileName: v || null,
    });
  }, [avatarFileName, props.username, props.userType]);
  const fallbackUrl = useMemo(() => resolveNoHeadAvatarUrl(), []);

  const acceptHint = 'image/png,image/jpeg,image/gif,image/webp';

  const onChooseFile = async (file: File | null | undefined) => {
    if (!file) return;
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
      const fn = String(res.data?.avatarFileName || '').trim();
      if (fn) {
        setAvatarFileName(fn);
        // 上传成功后立即保存（自动关闭弹窗）
        await props.onSave(fn);
        props.onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => props.onOpenChange(v)}
      title={props.title}
      description={props.description}
      content={
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4">
            <div
              className="h-24 w-24 rounded-[16px] overflow-hidden flex items-center justify-center shrink-0"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)' }}
              title={previewUrl || ''}
            >
              <img
                src={previewUrl}
                alt="avatar"
                className="h-full w-full object-cover"
                onError={(e) => {
                  const el = e.currentTarget;
                  if (el.getAttribute('data-fallback-applied') === '1') return;
                  if (!fallbackUrl) return;
                  el.setAttribute('data-fallback-applied', '1');
                  el.src = fallbackUrl;
                }}
              />
            </div>

            <div className="flex flex-col items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptHint}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = '';
                  void onChooseFile(f);
                }}
                disabled={uploading}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={uploading || (!props.onUpload && !props.userId)}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? '上传中...' : '上传图片'}
              </Button>
              <div className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
                支持 png/jpg/gif/webp，上传后自动保存
              </div>
            </div>
          </div>

          {error ? (
            <div
              className="rounded-[14px] px-4 py-3 text-sm"
              style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)} disabled={uploading}>
              关闭
            </Button>
          </div>
        </div>
      }
    />
  );
}


