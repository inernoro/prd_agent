import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchPublicProfile } from '@/services';
import type { PublicProfile } from '@/services/real/publicProfile';
import { Globe, ExternalLink, Eye, Inbox, UserX, Loader2 } from 'lucide-react';
import { SitePreview } from '@/components/SitePreview';

function fmtDate(s: string | null | undefined) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PublicProfilePage() {
  const { username } = useParams<{ username: string }>();
  const [data, setData] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!username) {
      setError('用户名无效');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchPublicProfile(username)
      .then((res) => {
        if (cancelled) return;
        if (res.success) setData(res.data);
        else setError(res.error?.message || '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0b0f] text-white/70">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>正在加载公开页…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0b0f] text-white/70">
        <div className="flex flex-col items-center gap-3 text-center">
          <UserX size={48} strokeWidth={1.5} className="text-white/30" />
          <div className="text-lg font-medium text-white/85">用户不存在</div>
          <div className="text-sm text-white/50">{error || '找不到这个用户'}</div>
          <a
            href="/"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10"
          >
            回到首页
          </a>
        </div>
      </div>
    );
  }

  const { user, sites } = data;

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header / Profile Banner */}
      <div className="relative overflow-hidden border-b border-white/10">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 30% 0%, rgba(56,189,248,0.25) 0%, transparent 55%), radial-gradient(ellipse 60% 50% at 90% 20%, rgba(139,92,246,0.2) 0%, transparent 60%)',
          }}
        />
        <div className="relative mx-auto flex max-w-5xl items-center gap-5 px-6 py-10">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/30 to-violet-500/20 text-2xl font-bold text-white/90 ring-1 ring-white/15">
            {user.displayName?.[0]?.toUpperCase() || user.username[0]?.toUpperCase() || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm text-white/60">
              <Globe size={14} />
              <span>公开主页</span>
            </div>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
              {user.displayName}
            </h1>
            <div className="mt-1 text-sm text-white/50">@{user.username}</div>
            <div className="mt-3 flex items-center gap-4 text-xs text-white/50">
              <span className="inline-flex items-center gap-1">
                <Inbox size={12} />
                {data.total} 个公开站点
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Sites Grid */}
      <div className="mx-auto max-w-5xl px-6 py-8">
        {sites.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-20 text-center text-white/50">
            <Inbox size={48} strokeWidth={1.5} className="text-white/20" />
            <div className="text-base font-medium text-white/70">还没有公开的站点</div>
            <div className="text-xs text-white/40">用户尚未公开任何托管网页</div>
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
          >
            {sites.map((s) => (
              <a
                key={s.id}
                href={s.siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:border-white/25 hover:bg-white/[0.06] hover:shadow-[0_0_24px_rgba(56,189,248,0.15)]"
              >
                <div
                  className="relative overflow-hidden"
                  style={{ aspectRatio: '16 / 9', background: '#0f1014' }}
                >
                  {s.coverImageUrl ? (
                    <img
                      src={s.coverImageUrl}
                      alt={s.title}
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <SitePreview url={s.siteUrl} className="h-full w-full" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                  <div className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <ExternalLink size={10} /> 访问
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <h3 className="truncate text-sm font-medium text-white/90">{s.title}</h3>
                  {s.description && (
                    <p className="line-clamp-2 text-[11px] text-white/55">{s.description}</p>
                  )}
                  <div className="mt-auto flex items-center gap-3 pt-2 text-[10px] text-white/40">
                    <span className="inline-flex items-center gap-0.5">
                      <Eye size={10} />
                      {s.viewCount}
                    </span>
                    {s.publishedAt && <span>公开于 {fmtDate(s.publishedAt)}</span>}
                  </div>
                  {s.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.tags.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-white/50"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mx-auto max-w-5xl px-6 py-6 text-center text-[10px] text-white/30">
        由 PRD Agent 网页托管 · 拖到右上角「公开」槽位即可发布到此页
      </div>
    </div>
  );
}
