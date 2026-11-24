/**
 * 「账户管理」Tab 内容
 *
 * 原本挂在用户菜单右上角的 AvatarEditDialog 被迁移进此页签。
 * 内容：当前用户的头像预览 + 上传替换；基础信息只读展示（昵称 / 用户 ID / 角色）。
 */

import { useMemo, useRef, useState } from 'react';
import { KeyRound, UserCircle2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
import { useAuthStore } from '@/stores/authStore';
import { changePassword, uploadMyAvatar } from '@/services';

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

      patchUser({
        avatarFileName: fn,
        avatarUrl: uploadRes.data?.avatarUrl ?? null,
      });
    } catch (e) {
      setError(toUserReadableErrorMessage(e, {
        fallbackMessage: '头像上传未完成',
        recoveryMessage: '请检查图片和网络后重新上传。',
      }));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      <GlassCard animated glow accentHue={210} className="mb-5">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]"
          >
            <UserCircle2 size={16} />
          </div>
          <div>
            <div className="text-[14px] font-bold text-token-primary">
              账户信息
            </div>
            <div className="mt-0.5 text-[11px] text-token-muted">
              修改头像会即时同步到左下角和消息卡片
            </div>
          </div>
        </div>

        <div className="flex items-start gap-6 flex-wrap">
          {/* 头像预览 + 上传 */}
          <div className="flex flex-col items-center gap-3 shrink-0">
            <div
              className="surface-inset flex h-28 w-28 items-center justify-center overflow-hidden rounded-[18px]"
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
            <div className="text-center text-[10px] text-token-muted">
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
            className="surface-state-danger mt-4 rounded-[10px] px-3 py-2 text-[12px]"
          >
            {error}
          </div>
        )}
      </GlassCard>

      <PasswordCard />
    </div>
  );
}

/**
 * 自助改密。
 *
 * 原本只有「首次登录被强制改」那一条路，平时想换密码得找管理员——密码一旦忘了
 * 或者疑似泄露，用户自己什么都做不了。这里给一条随时能走的路：验旧密码、改新密码，
 * 服务端顺手把别处的会话全作废，当前这一端换一副新令牌继续用。
 */
function PasswordCard() {
  const isRoot = useAuthStore((s) => s.user?.userId) === 'root';
  const setTokens = useAuthStore((s) => s.setTokens);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = !saving && !isRoot
    && currentPassword.length > 0 && newPassword.length > 0 && confirmPassword.length > 0;

  const onSubmit = async () => {
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      const res = await changePassword(currentPassword, newPassword, confirmPassword);
      if (!res.success) throw new Error(res.error?.message || '改密未完成');
      // 服务端已经把旧会话全作废了，本地必须换成它刚发的那副，否则下一个请求就 401。
      setTokens(res.data.accessToken, res.data.refreshToken, res.data.sessionKey);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    } catch (e) {
      setError(toUserReadableErrorMessage(e, {
        fallbackMessage: '改密未完成',
        recoveryMessage: '请确认当前密码无误后重试。',
      }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassCard animated glow accentHue={150} className="mb-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
          <KeyRound size={16} />
        </div>
        <div>
          <div className="text-[14px] font-bold text-token-primary">登录密码</div>
          <div className="mt-0.5 text-[11px] text-token-muted">
            改完会把你在其它设备上的登录状态一并注销，这一端不受影响
          </div>
        </div>
      </div>

      {isRoot ? (
        <div className="surface-inset rounded-[10px] px-3 py-2 text-[12px] text-token-secondary">
          你现在用的是 ROOT 应急账户，它的口令在部署配置里，不落库、也就改不了。
          请用正式管理员账号登录后再改密。
        </div>
      ) : (
        <div className="grid max-w-[420px] grid-cols-1 gap-2">
          <PasswordField label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
          <PasswordField label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
          <PasswordField label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />

          <div className="mt-1 flex items-center gap-3">
            <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void onSubmit()}>
              {saving ? '提交中...' : '修改密码'}
            </Button>
            {done && <span className="text-[12px] text-token-secondary">已生效，其它设备需要重新登录</span>}
          </div>
        </div>
      )}

      {error && (
        <div className="surface-state-danger mt-4 rounded-[10px] px-3 py-2 text-[12px]">
          {error}
        </div>
      )}
    </GlassCard>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  return (
    <label className="surface-inset flex items-center gap-3 rounded-[10px] px-3 py-2">
      <span className="w-[72px] shrink-0 text-[11px] text-token-muted">{label}</span>
      <input
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-token-primary outline-none"
      />
    </label>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="surface-inset flex items-center justify-between gap-3 rounded-[10px] px-3 py-2"
    >
      <span className="text-[11px] text-token-muted">
        {label}
      </span>
      <span
        className={`truncate text-[12px] text-token-primary ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export default AccountSettings;
