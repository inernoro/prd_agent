import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { joinTeam } from '@/services/real/teams';
import { useTeamStore } from '@/stores/teamStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

/**
 * 自动加入共享文件夹（团队）落地页：`/join/:code`。
 * 进到这里时 RequireAuth 已保证登录（未登录会先跳 /login?returnUrl 再回来）。
 * 凭邀请码自动加入对应空间 → 设网页托管作用域到该空间 → 跳「我的共享文件夹」。
 * 隔离铁律：加入只针对邀请码映射的那一个空间 Id，不授予任何额外可见性。
 */
export default function JoinTeamPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      const c = (code ?? '').trim();
      if (!c) {
        navigate('/web-pages', { replace: true });
        return;
      }
      const res = await joinTeam(c);
      if (res.success) {
        // 直接把网页托管作用域切到该共享文件夹，落地即看到内容
        useTeamStore.getState().setScope('web-hosting', 'team', res.data.teamId);
        await useTeamStore.getState().loadTeams(true);
        toast.success(
          res.data.alreadyMember ? '你已是该共享文件夹成员' : `已加入「${res.data.teamName ?? '共享文件夹'}」`,
        );
        navigate('/web-pages', { replace: true });
      } else {
        setError(res.error?.message ?? '邀请链接无效或已过期');
      }
    })();
  }, [code, navigate]);

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center max-w-[360px] px-6">
          <div className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            无法加入
          </div>
          <div className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>{error}</div>
          <button
            type="button"
            onClick={() => navigate('/web-pages', { replace: true })}
            className="mt-5 px-4 py-2 text-[13px] rounded-md"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          >
            去网页托管
          </button>
        </div>
      </div>
    );
  }

  return <MapSectionLoader text="正在加入共享文件夹…" />;
}
