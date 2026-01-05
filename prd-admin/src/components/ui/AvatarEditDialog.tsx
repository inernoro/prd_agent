import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { Button } from '@/components/design/Button';

export function AvatarEditDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  username?: string | null;
  userType?: string | null;
  avatarFileName?: string | null;
  onSave: (avatarFileName: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedFileName = useMemo(() => {
    const u = String(props.username ?? '').trim();
    if (!u) return '';
    return `${u}.png`;
  }, [props.username]);

  useEffect(() => {
    if (!props.open) return;
    setError(null);
    setSaving(false);
    setValue((props.avatarFileName ?? '').trim());
  }, [props.open, props.avatarFileName]);

  const previewUrl = useMemo(() => {
    const v = value.trim();
    return resolveAvatarUrl({
      username: props.username ?? undefined,
      userType: props.userType ?? undefined,
      avatarFileName: v || null,
    });
  }, [value, props.username, props.userType]);
  const fallbackUrl = useMemo(() => resolveNoHeadAvatarUrl(), []);

  const submit = async () => {
    const v = value.trim();
    setSaving(true);
    setError(null);
    try {
      await props.onSave(v ? v : null);
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
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
          <div className="flex items-center gap-4">
            <div
              className="h-16 w-16 rounded-[16px] overflow-hidden flex items-center justify-center shrink-0"
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

            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                头像文件名（仅文件名）
              </div>
              <input
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
                placeholder={props.username ? `例如 ${props.username}.png（或 .gif；留空=清空头像）` : '例如 admin.png（或 .gif；留空=清空头像）'}
                autoComplete="off"
              />
              <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                只需要填 <span style={{ color: 'var(--text-secondary)' }}>用户名.ext</span>（ext 可为 png/gif 等），服务端会把头像 URL 分发给各端展示。
              </div>

              {suggestedFileName && value.trim().length === 0 && (
                <div
                  className="mt-3 rounded-[14px] px-4 py-3 text-sm flex items-center justify-between gap-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>建议文件名</div>
                    <div className="mt-1 text-sm font-semibold truncate">{suggestedFileName}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setValue(suggestedFileName);
                      setError(null);
                    }}
                  >
                    一键填充
                  </Button>
                </div>
              )}
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
            <Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      }
    />
  );
}


