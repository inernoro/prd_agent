import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { getUserProfile } from '@/services';
import type { UserProfileResponse } from '@/services/contracts/adminUsers';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { Users2, Zap, Clock, Image, Eye } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

type UserProfilePopoverProps = {
  userId: string;
  username: string;
  userType?: string;
  botKind?: string;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  children: React.ReactNode;
};

// Agent 名称映射
const agentLabels: Record<string, string> = {
  'prd-agent': 'PRD Agent',
  'visual-agent': '视觉创作',
  'literary-agent': '文学创作',
  dashboard: '仪表盘',
  users: '用户管理',
  groups: '群组管理',
  mds: '模型管理',
  logs: '日志',
  settings: '设置',
};

function formatRelativeTime(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);

  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const suffix = diff >= 0 ? '前' : '后';
  if (sec < 60) return `${sec} 秒${suffix}`;
  if (min < 60) return `${min} 分钟${suffix}`;
  if (hr < 24) return `${hr} 小时${suffix}`;
  if (day < 30) return `${day} 天${suffix}`;
  return '';
}

export function UserProfilePopover({
  userId,
  username,
  userType,
  botKind,
  avatarFileName,
  avatarUrl,
  children,
}: UserProfilePopoverProps) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = async () => {
    if (profile || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getUserProfile(userId);
      if (res.success) {
        setProfile(res.data);
      } else {
        setError(res.error?.message || '加载失败');
      }
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const avatarSrc = resolveAvatarUrl({
    username,
    userType,
    botKind,
    avatarFileName: avatarFileName ?? null,
    avatarUrl,
  });
  const fallbackSrc = resolveNoHeadAvatarUrl();

  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild onMouseEnter={loadProfile}>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            align="start"
            sideOffset={8}
            className="rounded-[12px] p-3 w-[240px] z-[100]"
            style={{
              background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
              border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
              boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
              backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
            }}
          >
            {loading && !profile && (
              <div className="text-center py-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            )}

            {error && !profile && (
              <div className="text-center py-4 text-[12px]" style={{ color: 'rgba(239,68,68,0.9)' }}>
                {error}
              </div>
            )}

            {profile && (
              <div className="space-y-3">
                {/* 头部信息 */}
                <div className="flex items-center gap-2.5">
                  <div className="h-10 w-10 rounded-[10px] overflow-hidden shrink-0 ring-1 ring-white/10">
                    <img
                      src={avatarSrc}
                      alt="avatar"
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        const el = e.currentTarget;
                        if (el.getAttribute('data-fallback-applied') === '1') return;
                        if (!fallbackSrc) return;
                        el.setAttribute('data-fallback-applied', '1');
                        el.src = fallbackSrc;
                      }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {profile.displayName}
                    </div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      @{profile.username}
                    </div>
                  </div>
                  <div
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-[4px]"
                    style={{
                      background: profile.role === 'ADMIN' ? 'rgba(214,178,106,0.12)' : 'rgba(59,130,246,0.12)',
                      border: `1px solid ${profile.role === 'ADMIN' ? 'rgba(214,178,106,0.25)' : 'rgba(59,130,246,0.25)'}`,
                      color: profile.role === 'ADMIN' ? 'var(--accent-gold)' : 'rgba(59,130,246,0.95)',
                    }}
                  >
                    {profile.role}
                  </div>
                </div>

                {/* 最后活跃 */}
                {profile.lastActiveAt && (
                  <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <Clock size={12} />
                    <span>最后活跃：{formatRelativeTime(profile.lastActiveAt)}</span>
                  </div>
                )}

                {/* 创作统计（近30天） */}
                {(profile.totalImageCount > 0 || profile.totalRunCount > 0) && (
                  <div className="flex items-center gap-3 px-2 py-1.5 rounded-[8px]" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <div className="flex items-center gap-1.5">
                      <Image size={12} style={{ color: 'var(--accent-gold)' }} />
                      <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                        {profile.totalImageCount}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>张图</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Zap size={12} style={{ color: 'var(--accent-gold)' }} />
                      <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                        {profile.totalRunCount}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>次任务</span>
                    </div>
                  </div>
                )}

                {/* 群组列表 */}
                {profile.groups.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Users2 size={12} style={{ color: 'var(--text-muted)' }} />
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        已加入群组
                      </span>
                    </div>
                    <div className="space-y-1">
                      {profile.groups.slice(0, 5).map((g) => (
                        <div
                          key={g.groupId}
                          className="flex items-center justify-between px-2 py-1 rounded-[6px]"
                          style={{ background: 'rgba(255,255,255,0.03)' }}
                        >
                          <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                            {g.name}
                          </span>
                          <span className="text-[10px] shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                            {g.memberCount}人
                          </span>
                        </div>
                      ))}
                      {profile.groups.length > 5 && (
                        <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                          +{profile.groups.length - 5} 个群组
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Agent 使用统计 */}
                {profile.agentUsage.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Zap size={12} style={{ color: 'var(--text-muted)' }} />
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        常用功能 (近30天)
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {profile.agentUsage.map((a) => (
                        <div
                          key={a.appKey}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded-[4px]"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                          <span className="text-[10px]" style={{ color: 'var(--text-primary)' }}>
                            {agentLabels[a.appKey] || a.appKey}
                          </span>
                          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            {a.usageCount}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 空状态 */}
                {profile.groups.length === 0 && profile.agentUsage.length === 0 && profile.totalImageCount === 0 && (
                  <div className="text-center py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    暂无使用记录
                  </div>
                )}

                {/* 底部操作：查看日志 */}
                <div className="pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[11px] transition-colors hover:bg-white/5"
                    style={{ color: 'var(--text-secondary)' }}
                    onClick={() => navigate(`/logs?userId=${profile.userId}`)}
                  >
                    <Eye size={12} />
                    <span>查看用户日志</span>
                  </button>
                </div>
              </div>
            )}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
