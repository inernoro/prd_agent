import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Eye, Globe, Users } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { listSites } from '@/services';
import type { HostedSite, SiteOwnerCard } from '@/services/real/webPages';
import { useTeamStore } from '@/stores/teamStore';

/**
 * 知识库「团队空间」内的团队网页区块：
 * 展示我加入的团队（或选中团队）共享的网页托管站点。
 * teamId 为 null = 「全部」聚合视图（跨团队），由后端 AnyIn 聚合查询支撑。
 * 团队归属以标签形式展示在每张卡上；点击卡片新窗口打开站点（团队成员免密）。
 */
export function TeamWebPagesSection({ teamId }: { teamId: string | null }) {
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [owners, setOwners] = useState<Record<string, SiteOwnerCard>>({});
  const [loading, setLoading] = useState(true);
  const { teams } = useTeamStore();
  const navigate = useNavigate();

  const teamNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of teams) map.set(t.team.id, t.team.name);
    return map;
  }, [teams]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await listSites({ scope: 'team', teamId, sort: 'newest', limit: 100 });
      if (alive && res.success) {
        setSites(res.data.items);
        setOwners(res.data.owners ?? {});
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [teamId]);

  // 没有任何团队网页时整个区块不出现，不打扰知识库主视图
  if (!loading && sites.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <Globe size={14} style={{ color: 'var(--accent-primary)' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>团队网页</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          来自网页托管 · {sites.length} 个
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={() => navigate('/web-pages')}>
          <ExternalLink size={11} className="mr-1" /> 去网页托管
        </Button>
      </div>
      {loading ? (
        <MapSectionLoader text="正在加载团队网页…" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {sites.map((site) => {
            const owner = owners[site.ownerUserId];
            const siteTeams = (site.sharedTeamIds ?? [])
              .map((tid) => teamNameMap.get(tid))
              .filter((n): n is string => !!n);
            return (
              <GlassCard
                key={site.id}
                animated
                interactive
                padding="none"
                className="group"
                onClick={() => window.open(site.siteUrl, '_blank', 'noopener')}
              >
                <div className="p-3.5 flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {site.title}
                      </p>
                      {site.description && (
                        <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {site.description}
                        </p>
                      )}
                    </div>
                    <ExternalLink size={12} className="shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--text-muted)' }} />
                  </div>
                  {/* 团队归属标签（一站可属多个团队） */}
                  {siteTeams.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      {siteTeams.map((name) => (
                        <span
                          key={name}
                          className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-[5px] text-[10px] font-medium"
                          style={{ background: 'rgba(212,175,55,0.12)', color: 'var(--accent-gold, #d4af37)', border: '1px solid rgba(212,175,55,0.25)' }}
                        >
                          <Users size={9} /> {name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }} title="浏览次数">
                      <Eye size={11} /> {site.viewCount}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <RelativeTime value={site.updatedAt} refreshIntervalMs={0} />
                      </span>
                      {owner && (
                        <UserAvatar
                          src={resolveAvatarUrl({ avatarFileName: owner.avatarFileName })}
                          className="w-5 h-5 rounded-full"
                          style={{ border: '1.5px solid var(--bg-card, #1b1b1e)' }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
