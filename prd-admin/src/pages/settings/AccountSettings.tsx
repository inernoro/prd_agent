/**
 * 「账户管理」Tab 内容
 *
 * 原本挂在用户菜单右上角的 AvatarEditDialog 被迁移进此页签。
 * 内容：当前用户的头像预览 + 上传替换；基础信息只读展示（昵称 / 用户 ID / 角色）。
 */

import { useMemo, useRef, useState } from 'react';
import { UserCircle2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useAuthStore } from '@/stores/authStore';
import { updateMyAvatar, uploadMyAvatar } from '@/services';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export function AccountSettings() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const previewUrl = useMemo(
    () =>
      resolveAvatarUrl({
        username: user?.username ?? undefined,
        userType: user?.userType ?? undefined,
        avatarFileName: user?.avatarFileName ?? null,
      }),
    [user?.username, user?.userType, user?.avatarFileName],
  );

  const onChooseFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!user?.userId) {
      setError('未检测到当前用户');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const uploadRes = await uploadMyAvatar({ file });
      if (!uploadRes.success) throw new Error(uploadRes.error?.message || '上传失败');
      const fn = String(uploadRes.data?.avatarFileName || '').trim();
      if (!fn) throw new Error('上传返回为空');

      const saveRes = await updateMyAvatar(fn);
      if (!saveRes.success) throw new Error(saveRes.error?.message || '保存失败');

      patchUser({
        avatarFileName: fn,
        avatarUrl: saveRes.data?.avatarUrl ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      <GlassCard animated glow accentHue={210} className="mb-5">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center"
            style={{
              background: 'rgba(59, 130, 246, 0.14)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              color: 'rgba(147, 197, 253, 0.98)',
            }}
          >
            <UserCircle2 size={16} />
          </div>
          <div>
            <div className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
              账户信息
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              修改头像会即时同步到左下角和消息卡片
            </div>
          </div>
        </div>

        <div className="flex items-start gap-6 flex-wrap">
          {/* 头像预览 + 上传 */}
          <div className="flex flex-col items-center gap-3 shrink-0">
            <div
              className="h-28 w-28 rounded-[18px] overflow-hidden flex items-center justify-center"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid var(--border-subtle)',
              }}
              title={previewUrl || ''}
            >
              <UserAvatar src={previewUrl} alt="avatar" className="h-full w-full object-cover" />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
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
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? '上传中...' : '上传新头像'}
            </Button>
            <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
              支持 png/jpg/gif/webp
              <br />
              上传后自动保存
            </div>
          </div>

          {/* 只读信息 */}
          <div className="flex-1 min-w-[240px] grid grid-cols-1 gap-2">
            <InfoRow label="昵称" value={user?.displayName || '-'} />
            <InfoRow label="用户名" value={user?.username || '-'} mono />
            <InfoRow label="用户 ID" value={user?.userId || '-'} mono />
            <InfoRow label="用户类型" value={user?.userType || '-'} />
          </div>
        </div>

        {error && (
          <div
            className="mt-4 rounded-[10px] px-3 py-2 text-[12px]"
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.28)',
              color: 'rgba(252, 165, 165, 0.98)',
            }}
          >
            {error}
          </div>
        )}
      </GlassCard>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-[10px]"
      style={{
        background: 'var(--nested-block-bg, rgba(255,255,255,0.025))',
        border: '1px solid var(--nested-block-border, rgba(255,255,255,0.06))',
      }}
    >
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className={`text-[12px] truncate ${mono ? 'font-mono' : ''}`}
        style={{ color: 'var(--text-primary)' }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export default AccountSettings;
