import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, FileText, Eye, Send, Clock } from 'lucide-react';
import { listWeeklyPosters, type WeeklyPoster } from '@/services';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

function statusLabel(status: WeeklyPoster['status']) {
  if (status === 'published') return '已发布';
  if (status === 'archived') return '已归档';
  return '草稿';
}

function statusColor(status: WeeklyPoster['status']) {
  if (status === 'published') return { bg: 'rgba(34,197,94,0.16)', fg: '#86efac' };
  if (status === 'archived') return { bg: 'rgba(100,116,139,0.18)', fg: '#94a3b8' };
  return { bg: 'rgba(251,191,36,0.16)', fg: '#fde68a' };
}

export default function WeeklyPosterListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WeeklyPoster[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    void listWeeklyPosters({ pageSize: 80 }).then((res) => {
      setLoading(false);
      if (res.success && res.data) {
        setItems(res.data.items);
      } else {
        toast.error(res.error?.message || '加载海报失败');
      }
    });
  }, []);

  return (
    <div className="h-full min-h-0 overflow-y-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-[1180px] mx-auto px-8 py-8 pb-24">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase mb-1"
              style={{ color: 'rgba(255,255,255,0.4)' }}>
              Resource · Poster Design
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-white">海报设计</h1>
            <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
              先从列表选择一个海报项目进入工作台；新建只负责创建新的画布草稿。
            </p>
          </div>
          <Link
            to="/weekly-poster/new"
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-md text-[13px] font-medium text-white transition-colors hover:bg-white/20"
            style={{
              background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.22)',
            }}
          >
            <Plus size={14} /> 新建海报
          </Link>
        </div>

        {loading ? (
          <div className="surface rounded-2xl min-h-[360px] flex items-center justify-center">
            <MapSectionLoader text="加载海报列表..." />
          </div>
        ) : items.length === 0 ? (
          <div
            className="rounded-2xl min-h-[420px] flex items-center justify-center text-center"
            style={{
              background: 'rgba(255,255,255,0.025)',
              border: '1px dashed rgba(255,255,255,0.14)',
            }}
          >
            <div>
              <Sparkles size={34} className="mx-auto mb-3 text-white/25" />
              <div className="text-[16px] font-semibold text-white mb-1">还没有海报</div>
              <div className="text-[13px] text-white/45 mb-4">创建第一张海报后会进入工作台继续编辑页面、素材和发布参数。</div>
              <Link
                to="/weekly-poster/new"
                className="inline-flex items-center gap-1.5 px-4 h-9 rounded-md text-[13px] font-medium text-white"
                style={{
                  background: 'rgba(255,255,255,0.12)',
                  border: '1px solid rgba(255,255,255,0.22)',
                }}
              >
                <Plus size={14} /> 新建海报
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {items.map((item) => {
              const c = statusColor(item.status);
              const firstPage = item.pages?.slice().sort((a, b) => a.order - b.order)[0];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/weekly-poster/${encodeURIComponent(item.id)}`)}
                  className="group text-left rounded-xl overflow-hidden transition-colors cursor-pointer"
                  style={{
                    background: 'rgba(255,255,255,0.035)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <div
                    className="relative"
                    style={{
                      aspectRatio: '1200 / 628',
                      background: firstPage?.imageUrl
                        ? '#080b12'
                        : `linear-gradient(135deg, ${firstPage?.accentColor || '#7c3aed'} 0%, rgba(8,11,18,0.95) 100%)`,
                    }}
                  >
                    {firstPage?.imageUrl && (
                      <img src={firstPage.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
                    )}
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.72) 100%)' }} />
                    <div className="absolute left-3 right-3 bottom-3">
                      <div className="text-[11px] text-white/50 mb-1">{item.weekKey}</div>
                      <div className="text-[16px] font-semibold text-white truncate">{item.title || '未命名海报'}</div>
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="inline-flex items-center px-2 h-5 rounded-full text-[10px] font-medium" style={{ background: c.bg, color: c.fg }}>
                        {statusLabel(item.status)}
                      </span>
                      <span className="text-[11px] text-white/40">{item.pages?.length ?? 0} 页</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                      <span className="inline-flex items-center gap-1"><FileText size={11} /> 工作台</span>
                      <span className="inline-flex items-center gap-1"><Eye size={11} /> 预览</span>
                      <span className="inline-flex items-center gap-1"><Send size={11} /> 发布</span>
                      {item.updatedAt && <span className="ml-auto inline-flex items-center gap-1"><Clock size={11} /> {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
