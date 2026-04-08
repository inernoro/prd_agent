/**
 * LibrarySection — 首页「智识殿堂」预览板块
 *
 * 展示社区共享的公共知识库（IsPublic=true 的 DocumentStore），
 * 替代原 TutorialSection 在首页的位置。
 *
 * 数据源：listPublicDocumentStores API。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Library, BookOpen, Heart, Eye, ArrowRight } from 'lucide-react';
import { listPublicDocumentStores } from '@/services';
import type { PublicDocumentStore } from '@/services/contracts/documentStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

export function LibrarySection() {
  const navigate = useNavigate();
  const [stores, setStores] = useState<PublicDocumentStore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    listPublicDocumentStores(1, 6).then((res) => {
      if (!mounted) return;
      if (res.success) setStores(res.data.items);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  return (
    <section className="relative py-24 px-6 overflow-hidden">
      {/* 背景：图书馆氛围（径向光晕） */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 30% 20%, rgba(168,85,247,0.08) 0%, transparent 50%),' +
            'radial-gradient(ellipse at 70% 80%, rgba(59,130,246,0.08) 0%, transparent 50%)',
        }}
      />

      <div className="max-w-7xl mx-auto relative">
        {/* 标题区 */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-6"
            style={{
              background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.15))',
              border: '1px solid rgba(168,85,247,0.25)',
            }}>
            <Library size={14} style={{ color: 'rgba(168,85,247,0.9)' }} />
            <span className="text-[12px] font-semibold tracking-wider"
              style={{ color: 'rgba(255,255,255,0.85)' }}>
              SHARED KNOWLEDGE
            </span>
          </div>
          <h2 className="text-[48px] md:text-[64px] font-bold leading-[1.05] mb-4"
            style={{
              background: 'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.6) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
            智识殿堂
          </h2>
          <p className="text-[15px] md:text-[17px] max-w-2xl mx-auto"
            style={{ color: 'rgba(255,255,255,0.55)' }}>
            社区共建的知识图书馆 · 收录开发者倾囊相授的洞见与心得
          </p>
        </div>

        {/* 卡片网格 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={20} />
          </div>
        ) : stores.length === 0 ? (
          <div className="text-center py-16">
            <BookOpen size={48} className="mx-auto mb-4" style={{ color: 'rgba(255,255,255,0.15)' }} />
            <p className="text-[14px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
              暂无公开知识库，成为第一个分享者吧
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {stores.map((s) => (
                <button
                  key={s.id}
                  onClick={() => navigate(`/library/${s.id}`)}
                  className="group relative text-left p-6 rounded-[20px] transition-all duration-300 hover:-translate-y-1 cursor-pointer"
                  style={{
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    backdropFilter: 'blur(20px)',
                  }}
                >
                  {/* 渐变光晕 */}
                  <div className="absolute inset-0 rounded-[20px] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    style={{
                      background: 'radial-gradient(circle at 50% 0%, rgba(168,85,247,0.12), transparent 70%)',
                    }}
                  />
                  <div className="relative">
                    <div className="w-12 h-12 rounded-[14px] flex items-center justify-center mb-4"
                      style={{
                        background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.15))',
                        border: '1px solid rgba(168,85,247,0.25)',
                      }}>
                      <Library size={20} style={{ color: 'rgba(168,85,247,0.9)' }} />
                    </div>
                    <h3 className="text-[18px] font-bold mb-2 line-clamp-1"
                      style={{ color: 'rgba(255,255,255,0.95)' }}>
                      {s.name}
                    </h3>
                    {s.description && (
                      <p className="text-[13px] line-clamp-2 mb-5"
                        style={{ color: 'rgba(255,255,255,0.5)' }}>
                        {s.description}
                      </p>
                    )}
                    <div className="flex items-center gap-4 text-[11px]"
                      style={{ color: 'rgba(255,255,255,0.4)' }}>
                      <span className="flex items-center gap-1">
                        <BookOpen size={11} />
                        {s.documentCount} 篇
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart size={11} />
                        {s.likeCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <Eye size={11} />
                        {s.viewCount}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* 查看全部按钮 */}
            <div className="text-center">
              <button
                onClick={() => navigate('/library')}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-[14px] font-semibold cursor-pointer transition-all hover:scale-105"
                style={{
                  background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.15))',
                  border: '1px solid rgba(168,85,247,0.3)',
                  color: 'rgba(255,255,255,0.95)',
                }}
              >
                走进智识殿堂
                <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
