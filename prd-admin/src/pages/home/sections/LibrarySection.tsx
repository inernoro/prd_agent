/**
 * LibrarySection — 首页「智识殿堂」预览板块（claymorphism 风格）
 *
 * 展示社区共享的公共知识库（IsPublic=true 的 DocumentStore），
 * 替代原 TutorialSection 在首页的位置。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Heart, Eye, ArrowRight, Sparkles } from 'lucide-react';
import { listPublicDocumentStores } from '@/services';
import type { PublicDocumentStore } from '@/services/contracts/documentStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

const CARD_PALETTES = [
  { bg: '#FEF3C7', border: '#F59E0B', shadow: '#D97706', icon: '#F59E0B' },
  { bg: '#DBEAFE', border: '#3B82F6', shadow: '#2563EB', icon: '#2563EB' },
  { bg: '#FCE7F3', border: '#EC4899', shadow: '#DB2777', icon: '#DB2777' },
  { bg: '#D1FAE5', border: '#10B981', shadow: '#059669', icon: '#059669' },
  { bg: '#EDE9FE', border: '#A855F7', shadow: '#9333EA', icon: '#9333EA' },
  { bg: '#FED7AA', border: '#F97316', shadow: '#EA580C', icon: '#EA580C' },
];

export function LibrarySection() {
  const navigate = useNavigate();
  const [stores, setStores] = useState<PublicDocumentStore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 注入字体
    const id = 'library-claymorphism-fonts';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800&display=swap';
      document.head.appendChild(link);
    }

    let mounted = true;
    listPublicDocumentStores(1, 6).then((res) => {
      if (!mounted) return;
      if (res.success) setStores(res.data.items);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  return (
    <section
      className="relative py-24 px-6 overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #FFF7ED 0%, #FEF3C7 50%, #FFF7ED 100%)',
        fontFamily: "'Nunito', system-ui, sans-serif",
      }}
    >
      <div className="max-w-7xl mx-auto relative">
        {/* 标题区 */}
        <div className="text-center mb-16">
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6"
            style={{
              background: '#D1FAE5',
              border: '2.5px solid #10B981',
              boxShadow: '0 3px 0 #059669',
            }}
          >
            <Sparkles size={14} style={{ color: '#D97706' }} strokeWidth={2.8} />
            <span className="text-[12px] font-bold" style={{ color: '#064E3B' }}>
              SHARED KNOWLEDGE · 社区共建
            </span>
          </div>
          <h2
            className="text-[48px] md:text-[72px] font-bold leading-[0.95] mb-4"
            style={{
              fontFamily: "'Fredoka', sans-serif",
              color: '#1E1B4B',
              letterSpacing: '-0.02em',
            }}
          >
            智识<span style={{ color: '#F97316' }}>殿堂</span>。
          </h2>
          <p className="text-[15px] md:text-[17px] max-w-2xl mx-auto font-semibold" style={{ color: '#64748B' }}>
            社区共建的知识图书馆 · 收录开发者倾囊相授的洞见与心得
          </p>
        </div>

        {/* 卡片网格 */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={20} />
          </div>
        ) : stores.length === 0 ? (
          <div
            className="max-w-md mx-auto text-center p-10 rounded-[28px]"
            style={{
              background: '#FFFFFF',
              border: '4px solid #1E1B4B',
              boxShadow: '8px 8px 0 #1E1B4B',
            }}
          >
            <div
              className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-5"
              style={{
                background: '#FEF3C7',
                border: '3px solid #F59E0B',
                boxShadow: '0 4px 0 #D97706',
              }}
            >
              <BookOpen size={32} style={{ color: '#F59E0B' }} strokeWidth={2.5} />
            </div>
            <p
              className="text-[18px] font-bold mb-2"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              殿堂尚待第一卷藏书
            </p>
            <p className="text-[13px]" style={{ color: '#64748B' }}>
              成为第一位分享者吧
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {stores.map((s, idx) => {
                const p = CARD_PALETTES[idx % CARD_PALETTES.length];
                return (
                  <button
                    key={s.id}
                    onClick={() => navigate(`/library/${s.id}`)}
                    className="group relative text-left p-6 rounded-[24px] cursor-pointer transition-all active:translate-y-1"
                    style={{
                      background: '#FFFFFF',
                      border: '3px solid #1E1B4B',
                      boxShadow: '6px 6px 0 #1E1B4B',
                    }}
                    onMouseDown={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '2px 2px 0 #1E1B4B';
                    }}
                    onMouseUp={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '6px 6px 0 #1E1B4B';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '6px 6px 0 #1E1B4B';
                    }}
                  >
                    <div
                      className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
                      style={{
                        background: p.bg,
                        border: `2.5px solid ${p.border}`,
                        boxShadow: `0 3px 0 ${p.shadow}`,
                      }}
                    >
                      <BookOpen size={24} style={{ color: p.icon }} strokeWidth={2.5} />
                    </div>
                    <h3
                      className="text-[20px] font-bold mb-2 line-clamp-1"
                      style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
                    >
                      {s.name}
                    </h3>
                    {s.description && (
                      <p className="text-[13px] line-clamp-2 mb-5 font-medium" style={{ color: '#64748B' }}>
                        {s.description}
                      </p>
                    )}
                    <div
                      className="flex items-center gap-4 text-[12px] font-bold pt-4"
                      style={{ borderTop: '2px dashed #E5E7EB', color: '#64748B' }}
                    >
                      <span className="flex items-center gap-1">
                        <BookOpen size={12} strokeWidth={2.8} />
                        {s.documentCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart size={12} style={{ color: '#EC4899' }} fill="#FCE7F3" strokeWidth={2.8} />
                        {s.likeCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <Eye size={12} strokeWidth={2.8} />
                        {s.viewCount}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 查看全部按钮 */}
            <div className="text-center">
              <button
                onClick={() => navigate('/library')}
                className="inline-flex items-center gap-2 px-8 py-4 rounded-2xl text-[16px] font-bold cursor-pointer transition-all active:translate-y-1"
                style={{
                  background: '#F97316',
                  border: '3px solid #1E1B4B',
                  boxShadow: '0 4px 0 #1E1B4B',
                  color: '#FFFFFF',
                  fontFamily: "'Nunito', sans-serif",
                }}
                onMouseDown={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 0 #1E1B4B';
                }}
                onMouseUp={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 0 #1E1B4B';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 0 #1E1B4B';
                }}
              >
                走进智识殿堂
                <ArrowRight size={18} strokeWidth={3} />
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
