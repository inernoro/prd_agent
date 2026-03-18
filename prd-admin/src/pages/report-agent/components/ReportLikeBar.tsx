import { useCallback, useEffect, useMemo, useState } from 'react';
import { Heart } from 'lucide-react';
import { likeReport, listReportLikes, unlikeReport } from '@/services';
import type { ReportLikeSummary, ReportLikeUser } from '@/services/contracts/reportAgent';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { toast } from '@/lib/toast';

interface Props {
  reportId: string;
  compact?: boolean;
}

const EMPTY_SUMMARY: ReportLikeSummary = {
  likedByMe: false,
  count: 0,
  users: [],
};

export function ReportLikeBar({ reportId, compact = false }: Props) {
  const [summary, setSummary] = useState<ReportLikeSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const authUser = useAuthStore((s) => s.user);

  const loadLikes = useCallback(async () => {
    if (!reportId) return;
    setLoading(true);
    const res = await listReportLikes({ reportId });
    if (res.success && res.data) {
      setSummary(res.data);
    } else {
      toast.error(res.error?.message || '加载点赞失败');
    }
    setLoading(false);
  }, [reportId]);

  useEffect(() => {
    void loadLikes();
  }, [loadLikes]);

  const myLikeUser = useMemo<ReportLikeUser>(() => ({
    userId: authUser?.userId || 'me',
    userName: authUser?.displayName || authUser?.username || authUser?.userId || '我',
    avatarFileName: authUser?.avatarFileName || undefined,
    likedAt: new Date().toISOString(),
  }), [authUser]);

  const handleToggleLike = async () => {
    if (!reportId || toggling) return;
    setToggling(true);
    const prev = summary;

    if (prev.likedByMe) {
      const users = prev.users.filter((u) => u.userId !== myLikeUser.userId);
      setSummary({
        likedByMe: false,
        count: Math.max(0, prev.count - 1),
        users,
      });
    } else {
      const exists = prev.users.some((u) => u.userId === myLikeUser.userId);
      setSummary({
        likedByMe: true,
        count: prev.count + (exists ? 0 : 1),
        users: exists ? prev.users : [myLikeUser, ...prev.users],
      });
    }

    const res = prev.likedByMe
      ? await unlikeReport({ reportId })
      : await likeReport({ reportId });

    if (res.success && res.data) {
      setSummary(res.data);
    } else {
      setSummary(prev);
      toast.error(res.error?.message || '操作失败');
    }
    setToggling(false);
  };

  const shownUsers = summary.users.slice(0, compact ? 4 : 8);
  const hiddenCount = Math.max(0, summary.users.length - shownUsers.length);

  return (
    <div
      className="flex items-center justify-between gap-3 flex-wrap"
      style={compact ? undefined : { borderTop: '1px solid var(--border-primary)', paddingTop: 10 }}
    >
      <button
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 text-[12px]"
        style={{
          color: summary.likedByMe ? 'rgba(236, 72, 153, 0.92)' : 'var(--text-secondary)',
          background: summary.likedByMe ? 'rgba(236, 72, 153, 0.08)' : 'var(--bg-secondary)',
          border: `1px solid ${summary.likedByMe ? 'rgba(236, 72, 153, 0.25)' : 'var(--border-primary)'}`,
          opacity: toggling || loading ? 0.72 : 1,
        }}
        onClick={handleToggleLike}
        disabled={toggling || loading}
        title={summary.likedByMe ? '取消点赞' : '点赞'}
      >
        <Heart size={14} fill={summary.likedByMe ? 'currentColor' : 'none'} />
        <span>{summary.likedByMe ? '已点赞' : '点赞'}</span>
        <span className="text-[11px] opacity-80">{summary.count}</span>
      </button>

      <div className="flex items-center gap-2 flex-wrap">
        {shownUsers.length === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无点赞</span>
        ) : (
          <>
            {shownUsers.map((user) => (
              <div
                key={`${user.userId}-${user.likedAt}`}
                className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-md"
                style={{ background: 'var(--bg-secondary)' }}
              >
                <UserAvatar
                  src={resolveAvatarUrl({ avatarFileName: user.avatarFileName })}
                  alt={user.userName}
                  className="w-5 h-5 rounded-full object-cover"
                />
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {user.userName}
                </span>
              </div>
            ))}
            {hiddenCount > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                +{hiddenCount}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
