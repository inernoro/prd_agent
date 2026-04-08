/**
 * LibraryLandingPage — 「智识殿堂」公共知识库浏览页
 *
 * 灵感来源：claymorphism 风格、温暖的图书馆氛围、宏伟的入口体验。
 * 视觉特征：
 *  - 顶部 Hero：径向光晕 + 浮动书本元素 + 巨型标题
 *  - 排序切换：热门 / 最新 / 高赞 / 高阅
 *  - 卡片网格：玻璃 + 流光描边，hover 上浮
 *  - 空状态：明确告诉用户如何把自己的知识库发布到此
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Library,
  BookOpen,
  Heart,
  Eye,
  Star,
  Sparkles,
  Clock,
  Flame,
  ArrowLeft,
} from 'lucide-react';
import { listPublicDocumentStores } from '@/services';
import type { PublicDocumentStore } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

type SortKey = 'hot' | 'new' | 'popular' | 'viewed';

const SORT_OPTIONS: { key: SortKey; label: string; icon: typeof Flame }[] = [
  { key: 'hot', label: '热门', icon: Flame },
  { key: 'popular', label: '高赞', icon: Heart },
  { key: 'viewed', label: '高阅', icon: Eye },
  { key: 'new', label: '最新', icon: Clock },
];

export function LibraryLandingPage() {
  const navigate = useNavigate();
  const [stores, setStores] = useState<PublicDocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('hot');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    listPublicDocumentStores(1, 48, sort).then((res) => {
      if (!mounted) return;
      if (res.success) setStores(res.data.items);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [sort]);

  return (
    <div
      className="min-h-screen w-full overflow-y-auto"
      style={{
        background:
          'radial-gradient(ellipse at 20% 0%, rgba(168,85,247,0.08) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 80% 30%, rgba(59,130,246,0.06) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 50% 100%, rgba(251,146,60,0.05) 0%, transparent 60%),' +
          'linear-gradient(180deg, #0a0a14 0%, #0f0f1a 100%)',
      }}
    >
      {/* 浮动书本/星辰背景 */}
      <BookStarField />

      {/* 返回按钮 */}
      <button
        onClick={() => navigate(-1)}
        className="fixed top-6 left-6 z-50 w-10 h-10 rounded-full flex items-center justify-center cursor-pointer transition-all hover:scale-110 backdrop-blur-xl"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: 'rgba(255,255,255,0.9)',
        }}
        title="返回"
      >
        <ArrowLeft size={18} />
      </button>

      {/* Hero 区 */}
      <section className="relative pt-32 pb-16 px-6">
        <div className="max-w-5xl mx-auto text-center relative">
          {/* 徽章 */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-8"
            style={{
              background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.15))',
              border: '1px solid rgba(168,85,247,0.25)',
              backdropFilter: 'blur(20px)',
            }}>
            <Sparkles size={14} style={{ color: 'rgba(251,191,36,0.9)' }} />
            <span className="text-[12px] font-semibold tracking-wider"
              style={{ color: 'rgba(255,255,255,0.85)' }}>
              COMMUNITY KNOWLEDGE LIBRARY
            </span>
          </div>

          {/* 巨型标题 */}
          <h1
            className="text-[64px] md:text-[96px] font-black leading-[0.95] mb-6 tracking-tight"
            style={{
              background: 'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.5) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            }}
          >
            智识殿堂
          </h1>

          {/* 副标题 */}
          <p className="text-[16px] md:text-[19px] max-w-2xl mx-auto mb-10 leading-relaxed"
            style={{ color: 'rgba(255,255,255,0.55)' }}>
            汇聚千百开发者的洞见与心得 · 在这里阅读、点赞、收藏、再创造
            <br />
            <span className="text-[14px] mt-2 inline-block" style={{ color: 'rgba(255,255,255,0.4)' }}>
              "An investment in knowledge pays the best interest." — Benjamin Franklin
            </span>
          </p>

          {/* 统计数据 */}
          <div className="flex items-center justify-center gap-8 md:gap-12">
            <Stat icon={Library} value={stores.length} label="知识库" color="rgba(168,85,247,0.9)" />
            <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.1)' }} />
            <Stat icon={BookOpen} value={stores.reduce((s, x) => s + x.documentCount, 0)} label="文档" color="rgba(59,130,246,0.9)" />
            <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.1)' }} />
            <Stat icon={Heart} value={stores.reduce((s, x) => s + x.likeCount, 0)} label="点赞" color="rgba(244,63,94,0.9)" />
          </div>
        </div>
      </section>

      {/* 排序切换 */}
      <section className="relative px-6 mb-10">
        <div className="max-w-7xl mx-auto flex items-center justify-center gap-2 flex-wrap">
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.key;
            const Icon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => setSort(opt.key)}
                className="px-5 py-2.5 rounded-full text-[13px] font-semibold flex items-center gap-2 cursor-pointer transition-all"
                style={{
                  background: active
                    ? 'linear-gradient(135deg, rgba(168,85,247,0.2), rgba(59,130,246,0.2))'
                    : 'rgba(255,255,255,0.04)',
                  border: active
                    ? '1px solid rgba(168,85,247,0.4)'
                    : '1px solid rgba(255,255,255,0.08)',
                  color: active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)',
                  backdropFilter: 'blur(20px)',
                }}
              >
                <Icon size={13} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* 知识库网格 */}
      <section className="relative px-6 pb-32">
        <div className="max-w-7xl mx-auto">
          {loading ? (
            <MapSectionLoader text="正在召集藏书阁..." />
          ) : stores.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {stores.map((s, idx) => (
                <StoreCard key={s.id} store={s} onClick={() => navigate(`/library/${s.id}`)} index={idx} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 页脚标语 */}
      <footer className="relative px-6 pb-16 text-center">
        <div className="inline-block px-6 py-3 rounded-full"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(20px)',
          }}>
          <p className="text-[12px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
            想分享你的知识？前往「知识库」页面，创建空间后开启「公开发布」即可
          </p>
        </div>
      </footer>
    </div>
  );
}

function Stat({ icon: Icon, value, label, color }: { icon: typeof Library; value: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <Icon size={22} style={{ color }} />
      <div className="text-left">
        <div className="text-[24px] font-bold leading-none" style={{ color: 'rgba(255,255,255,0.95)' }}>
          {value.toLocaleString()}
        </div>
        <div className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function StoreCard({ store, onClick, index }: { store: PublicDocumentStore; onClick: () => void; index: number }) {
  // 不同卡片用不同的渐变色，营造彩色书脊效果
  const palettes = [
    { from: 'rgba(168,85,247,0.15)', to: 'rgba(236,72,153,0.10)', accent: 'rgba(168,85,247,0.9)' },
    { from: 'rgba(59,130,246,0.15)', to: 'rgba(14,165,233,0.10)', accent: 'rgba(59,130,246,0.9)' },
    { from: 'rgba(251,146,60,0.15)', to: 'rgba(244,63,94,0.10)', accent: 'rgba(251,146,60,0.9)' },
    { from: 'rgba(34,197,94,0.15)', to: 'rgba(20,184,166,0.10)', accent: 'rgba(34,197,94,0.9)' },
  ];
  const p = palettes[index % palettes.length];

  return (
    <button
      onClick={onClick}
      className="group relative text-left p-6 rounded-[24px] transition-all duration-500 hover:-translate-y-2 cursor-pointer overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${p.from} 0%, ${p.to} 100%)`,
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
      }}
    >
      {/* hover 流光 */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${p.accent.replace('0.9', '0.15')}, transparent 70%)`,
        }}
      />

      <div className="relative">
        {/* 头部：图标 + 文档数 */}
        <div className="flex items-start justify-between mb-5">
          <div className="w-14 h-14 rounded-[18px] flex items-center justify-center"
            style={{
              background: 'rgba(0,0,0,0.25)',
              border: `1px solid ${p.accent.replace('0.9', '0.3')}`,
              boxShadow: `0 0 24px ${p.accent.replace('0.9', '0.2')}`,
            }}>
            <Library size={22} style={{ color: p.accent }} />
          </div>
          <div className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full"
            style={{ background: 'rgba(0,0,0,0.25)', color: 'rgba(255,255,255,0.7)' }}>
            <BookOpen size={10} />
            {store.documentCount}
          </div>
        </div>

        {/* 标题 + 描述 */}
        <h3 className="text-[18px] font-bold mb-2 line-clamp-1" style={{ color: 'rgba(255,255,255,0.95)' }}>
          {store.name}
        </h3>
        <p className="text-[12px] line-clamp-2 mb-5 min-h-[32px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {store.description || '这位作者还没有写下介绍'}
        </p>

        {/* 作者信息 */}
        <div className="flex items-center gap-2 mb-4 pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: p.accent.replace('0.9', '0.2'), color: p.accent }}>
            {store.ownerName.charAt(0)}
          </div>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
            {store.ownerName}
          </span>
        </div>

        {/* 底部统计 */}
        <div className="flex items-center gap-4 text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
          <span className="flex items-center gap-1">
            <Heart size={11} style={{ color: 'rgba(244,63,94,0.7)' }} />
            {store.likeCount}
          </span>
          <span className="flex items-center gap-1">
            <Star size={11} style={{ color: 'rgba(234,179,8,0.7)' }} />
            {store.favoriteCount}
          </span>
          <span className="flex items-center gap-1">
            <Eye size={11} />
            {store.viewCount}
          </span>
        </div>
      </div>
    </button>
  );
}

function EmptyState() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center py-32">
      <div className="w-24 h-24 rounded-full flex items-center justify-center mb-8"
        style={{
          background: 'linear-gradient(135deg, rgba(168,85,247,0.1), rgba(59,130,246,0.1))',
          border: '1px solid rgba(168,85,247,0.2)',
        }}>
        <BookOpen size={36} style={{ color: 'rgba(168,85,247,0.7)' }} />
      </div>
      <h3 className="text-[24px] font-bold mb-3" style={{ color: 'rgba(255,255,255,0.9)' }}>
        殿堂尚待第一卷藏书
      </h3>
      <p className="text-[14px] mb-8 max-w-md text-center" style={{ color: 'rgba(255,255,255,0.5)' }}>
        成为第一位向社区分享知识的开发者吧。前往「知识库」创建你的空间，
        然后在右上角开启「发布到智识殿堂」。
      </p>
      <button
        onClick={() => navigate('/document-store')}
        className="px-6 py-3 rounded-full text-[14px] font-semibold cursor-pointer transition-all hover:scale-105"
        style={{
          background: 'linear-gradient(135deg, rgba(168,85,247,0.2), rgba(59,130,246,0.2))',
          border: '1px solid rgba(168,85,247,0.4)',
          color: 'rgba(255,255,255,0.95)',
        }}
      >
        前往我的知识库
      </button>
    </div>
  );
}

/** 浮动书本/星辰背景装饰 */
function BookStarField() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      {Array.from({ length: 30 }).map((_, i) => {
        const left = Math.random() * 100;
        const top = Math.random() * 100;
        const size = Math.random() * 3 + 1;
        const delay = Math.random() * 6;
        const duration = Math.random() * 4 + 4;
        return (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${size}px`,
              height: `${size}px`,
              background: 'rgba(255,255,255,0.3)',
              boxShadow: '0 0 4px rgba(255,255,255,0.5)',
              animation: `library-twinkle ${duration}s ease-in-out ${delay}s infinite`,
            }}
          />
        );
      })}
      <style>{`
        @keyframes library-twinkle {
          0%, 100% { opacity: 0.2; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.5); }
        }
      `}</style>
    </div>
  );
}
