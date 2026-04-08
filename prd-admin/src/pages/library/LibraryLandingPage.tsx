/**
 * LibraryLandingPage — 「智识殿堂」公共知识库浏览页
 *
 * 设计风格：Claymorphism (参考 uuupm.cc/demo/educational-platform LearnHub)
 *
 * 关键设计语言：
 *  - 字体：Fredoka (标题) + Nunito (正文) — 圆润、活泼、友好
 *  - 背景：奶油色 #FFF7ED (偏暖) + 柔和渐变
 *  - 卡片：纯白背景 + 厚边框 (3-4px) + 硬投影 (offset 下右) + 内阴影 (柔软感)
 *  - 主题色：绿色 #16A34A (CTA) + 粉色 #EC4899 + 蓝色 #3B82F6 + 紫色 #A855F7 + 橙色 #F97316
 *  - 圆角：card 20-28px，button 14-16px
 *  - 交互：按下时 translate-y + 缩短阴影（"按扁"的感觉）
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Heart,
  Eye,
  Star,
  Sparkles,
  Flame,
  ArrowLeft,
  ArrowRight,
  Clock,
  Users,
  Rocket,
  GraduationCap,
  Award,
} from 'lucide-react';
import { listPublicDocumentStores } from '@/services';
import type { PublicDocumentStore } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

type SortKey = 'hot' | 'new' | 'popular' | 'viewed';

const SORT_OPTIONS: { key: SortKey; label: string; icon: typeof Flame; color: string; border: string }[] = [
  { key: 'hot', label: '热门', icon: Flame, color: '#F97316', border: '#EA580C' },
  { key: 'popular', label: '高赞', icon: Heart, color: '#EC4899', border: '#DB2777' },
  { key: 'viewed', label: '高阅', icon: Eye, color: '#3B82F6', border: '#2563EB' },
  { key: 'new', label: '最新', icon: Clock, color: '#A855F7', border: '#9333EA' },
];

// 每张卡片使用不同的颜色主题（循环）
const CARD_PALETTES = [
  { bg: '#FEF3C7', border: '#F59E0B', shadow: '#D97706', icon: '#F59E0B', accent: '#92400E' }, // amber
  { bg: '#DBEAFE', border: '#3B82F6', shadow: '#2563EB', icon: '#2563EB', accent: '#1E3A8A' }, // blue
  { bg: '#FCE7F3', border: '#EC4899', shadow: '#DB2777', icon: '#DB2777', accent: '#831843' }, // pink
  { bg: '#D1FAE5', border: '#10B981', shadow: '#059669', icon: '#059669', accent: '#064E3B' }, // green
  { bg: '#EDE9FE', border: '#A855F7', shadow: '#9333EA', icon: '#9333EA', accent: '#4C1D95' }, // purple
  { bg: '#FED7AA', border: '#F97316', shadow: '#EA580C', icon: '#EA580C', accent: '#7C2D12' }, // orange
];

/** 注入 Fredoka + Nunito 字体 (仅在 LibraryLandingPage 需要) */
function useFredokaFonts() {
  useEffect(() => {
    const id = 'library-claymorphism-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(link);
  }, []);
}

export function LibraryLandingPage() {
  const navigate = useNavigate();
  const [stores, setStores] = useState<PublicDocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('hot');
  useFredokaFonts();

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

  const totalLikes = stores.reduce((s, x) => s + x.likeCount, 0);
  const totalDocs = stores.reduce((s, x) => s + x.documentCount, 0);
  const totalViews = stores.reduce((s, x) => s + x.viewCount, 0);

  return (
    <div
      className="min-h-screen w-full overflow-y-auto"
      style={{
        background:
          'radial-gradient(ellipse at 20% 0%, rgba(251,191,36,0.25) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 80% 30%, rgba(59,130,246,0.18) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 50% 100%, rgba(236,72,153,0.15) 0%, transparent 60%),' +
          'linear-gradient(180deg, #FFF7ED 0%, #FEF3C7 100%)',
        fontFamily: "'Nunito', system-ui, sans-serif",
        color: '#1E1B4B',
      }}
    >
      {/* 浮动装饰（书本、星星） */}
      <FloatingDecor />

      {/* 返回按钮 —— clay 风格 */}
      <button
        onClick={() => navigate(-1)}
        className="fixed top-6 left-6 z-50 w-12 h-12 rounded-2xl flex items-center justify-center cursor-pointer transition-all active:translate-y-0.5"
        style={{
          background: '#FFFFFF',
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
          color: '#1E1B4B',
        }}
        title="返回"
      >
        <ArrowLeft size={20} strokeWidth={2.8} />
      </button>

      {/* Hero 区 */}
      <section className="relative pt-24 pb-12 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            {/* 左侧文字 */}
            <div>
              {/* 徽章 */}
              <div
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6"
                style={{
                  background: '#D1FAE5',
                  border: '2.5px solid #10B981',
                  boxShadow: '0 3px 0 #059669',
                }}
              >
                <span
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{ background: '#10B981' }}
                />
                <span className="text-[12px] font-bold" style={{ color: '#064E3B' }}>
                  SHARED KNOWLEDGE · 社区共建
                </span>
              </div>

              <h1
                className="text-[56px] md:text-[84px] font-bold leading-[0.95] mb-2"
                style={{
                  fontFamily: "'Fredoka', 'Nunito', sans-serif",
                  color: '#1E1B4B',
                  letterSpacing: '-0.02em',
                }}
              >
                智识
                <br />
                <span style={{ color: '#F97316' }}>殿堂</span>。
              </h1>

              <p
                className="text-[16px] md:text-[19px] mb-8 max-w-md"
                style={{ color: '#475569', lineHeight: 1.6, fontWeight: 500 }}
              >
                汇聚千百开发者的洞见与心得。在这里 <b style={{ color: '#F97316' }}>阅读</b>
                、<b style={{ color: '#EC4899' }}>点赞</b>、
                <b style={{ color: '#A855F7' }}>收藏</b>、再创造。
              </p>

              {/* 双按钮 */}
              <div className="flex flex-wrap gap-3">
                <ClayButton
                  primary
                  onClick={() => {
                    const el = document.getElementById('catalog');
                    el?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  开始探索 <ArrowRight size={18} strokeWidth={3} />
                </ClayButton>
                <ClayButton
                  onClick={() => navigate('/document-store')}
                >
                  发布我的知识
                </ClayButton>
              </div>

              {/* 统计数据 */}
              <div className="grid grid-cols-3 gap-4 mt-10 max-w-md">
                <MiniStat value={stores.length} label="知识库" color="#A855F7" />
                <MiniStat value={totalDocs} label="文档" color="#3B82F6" />
                <MiniStat value={totalLikes} label="点赞" color="#EC4899" />
              </div>
            </div>

            {/* 右侧装饰卡片 —— mock 一张正在学习的卡片 */}
            <div className="hidden md:block relative">
              <HeroMockCard totalViews={totalViews} />
            </div>
          </div>
        </div>
      </section>

      {/* 名言 banner */}
      <section className="relative px-6 mb-12">
        <div className="max-w-4xl mx-auto">
          <div
            className="px-8 py-6 rounded-[28px] flex items-center gap-4"
            style={{
              background: '#FFFFFF',
              border: '3px solid #1E1B4B',
              boxShadow: '6px 6px 0 #1E1B4B',
            }}
          >
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{
                background: '#FEF3C7',
                border: '2.5px solid #F59E0B',
                boxShadow: '0 3px 0 #D97706',
              }}
            >
              <Award size={26} style={{ color: '#D97706' }} strokeWidth={2.5} />
            </div>
            <div>
              <p
                className="text-[16px] md:text-[18px] font-semibold"
                style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
              >
                "An investment in knowledge pays the best interest."
              </p>
              <p className="text-[12px] mt-0.5" style={{ color: '#64748B' }}>
                — Benjamin Franklin · 知识是最好的投资
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 排序切换 */}
      <section id="catalog" className="relative px-6 mb-8">
        <div className="max-w-6xl mx-auto">
          <h2
            className="text-[32px] md:text-[40px] font-bold mb-6"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            热门知识库 📚
          </h2>
          <div className="flex items-center gap-3 flex-wrap">
            {SORT_OPTIONS.map((opt) => {
              const active = sort === opt.key;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.key}
                  onClick={() => setSort(opt.key)}
                  className="px-5 py-2.5 rounded-2xl text-[14px] font-bold flex items-center gap-2 cursor-pointer transition-all active:translate-y-0.5"
                  style={{
                    background: active ? opt.color : '#FFFFFF',
                    border: `3px solid ${active ? opt.border : '#1E1B4B'}`,
                    boxShadow: active ? `0 3px 0 ${opt.border}` : '0 3px 0 #1E1B4B',
                    color: active ? '#FFFFFF' : '#1E1B4B',
                  }}
                >
                  <Icon size={16} strokeWidth={2.8} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* 知识库网格 */}
      <section className="relative px-6 pb-24">
        <div className="max-w-6xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <MapSectionLoader text="正在召集藏书阁..." />
            </div>
          ) : stores.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {stores.map((s, idx) => (
                <StoreCard
                  key={s.id}
                  store={s}
                  palette={CARD_PALETTES[idx % CARD_PALETTES.length]}
                  onClick={() => navigate(`/library/${s.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 推荐/社区见证 —— testimonial 占位 */}
      {stores.length > 0 && (
        <section className="relative px-6 pb-24">
          <div className="max-w-6xl mx-auto">
            <h2
              className="text-[28px] md:text-[36px] font-bold mb-8 text-center"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              为什么要分享？ ✨
            </h2>
            <div className="grid md:grid-cols-3 gap-6">
              <Testimonial
                icon={Rocket}
                title="加速成长"
                body="把脑中的洞见写出来，你会发现自己理解得更深入。教是最好的学。"
                palette={CARD_PALETTES[0]}
              />
              <Testimonial
                icon={Users}
                title="连接同好"
                body="每一份文档都是一扇窗。让有共鸣的人通过点赞、收藏找到你。"
                palette={CARD_PALETTES[2]}
              />
              <Testimonial
                icon={GraduationCap}
                title="沉淀资产"
                body="知识库是永远不会过期的资产，今天写的明天就能被 AI 再利用。"
                palette={CARD_PALETTES[4]}
              />
            </div>
          </div>
        </section>
      )}

      {/* 底部 CTA —— 大 enrollment CTA */}
      <section className="relative px-6 pb-20">
        <div className="max-w-4xl mx-auto">
          <div
            className="px-10 py-12 rounded-[32px] text-center relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, #FEF3C7 0%, #FED7AA 100%)',
              border: '4px solid #1E1B4B',
              boxShadow: '8px 8px 0 #1E1B4B',
            }}
          >
            <Sparkles size={36} className="mx-auto mb-3" style={{ color: '#F97316' }} strokeWidth={2.5} />
            <h3
              className="text-[32px] md:text-[40px] font-bold mb-3"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              成为知识的分享者
            </h3>
            <p className="text-[14px] md:text-[16px] mb-8 max-w-md mx-auto" style={{ color: '#78350F' }}>
              在「知识库」创建你的空间，然后在右上角开启「发布到智识殿堂」。你的每一份分享都会被看见。
            </p>
            <ClayButton primary size="lg" onClick={() => navigate('/document-store')}>
              前往我的知识库 <ArrowRight size={20} strokeWidth={3} />
            </ClayButton>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── 子组件 ──

function ClayButton({
  children,
  primary,
  size = 'md',
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  size?: 'md' | 'lg';
  onClick?: () => void;
}) {
  const sizeClass = size === 'lg' ? 'px-8 py-4 text-[16px]' : 'px-6 py-3 text-[14px]';
  return (
    <button
      onClick={onClick}
      className={`${sizeClass} rounded-2xl font-bold flex items-center gap-2 cursor-pointer transition-all active:translate-y-1`}
      style={{
        background: primary ? '#16A34A' : '#FFFFFF',
        border: '3px solid #1E1B4B',
        boxShadow: '0 4px 0 #1E1B4B',
        color: primary ? '#FFFFFF' : '#1E1B4B',
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
      {children}
    </button>
  );
}

function MiniStat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div
      className="px-3 py-3 rounded-2xl"
      style={{
        background: '#FFFFFF',
        border: '2.5px solid #1E1B4B',
        boxShadow: '0 3px 0 #1E1B4B',
      }}
    >
      <div
        className="text-[24px] font-bold leading-none"
        style={{ color, fontFamily: "'Fredoka', sans-serif" }}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] mt-1 font-semibold" style={{ color: '#64748B' }}>
        {label}
      </div>
    </div>
  );
}

function HeroMockCard({ totalViews }: { totalViews: number }) {
  return (
    <div className="relative">
      {/* 主卡片：模拟一个正在阅读的库 */}
      <div
        className="px-6 py-6 rounded-[28px] relative"
        style={{
          background: '#FFFFFF',
          border: '4px solid #1E1B4B',
          boxShadow: '8px 8px 0 #1E1B4B',
        }}
      >
        {/* 顶部：图标 + 标题 */}
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{
              background: '#DBEAFE',
              border: '2.5px solid #3B82F6',
              boxShadow: '0 3px 0 #2563EB',
            }}
          >
            <BookOpen size={22} style={{ color: '#2563EB' }} strokeWidth={2.5} />
          </div>
          <div>
            <div
              className="text-[16px] font-bold"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              React 工程实战
            </div>
            <div className="text-[11px] font-semibold" style={{ color: '#64748B' }}>
              12 篇文档 · 4h 30m 阅读
            </div>
          </div>
        </div>

        {/* 进度条 */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[12px] font-bold" style={{ color: '#64748B' }}>
              Progress
            </span>
            <span
              className="text-[14px] font-bold"
              style={{ color: '#16A34A', fontFamily: "'Fredoka', sans-serif" }}
            >
              65%
            </span>
          </div>
          <div
            className="h-4 rounded-full overflow-hidden"
            style={{ background: '#F3F4F6', border: '2px solid #1E1B4B' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: '65%',
                background: 'linear-gradient(90deg, #16A34A, #22C55E)',
                boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.15)',
              }}
            />
          </div>
        </div>

        {/* Continue 按钮 */}
        <button
          className="w-full py-3 rounded-2xl text-[14px] font-bold cursor-pointer transition-all active:translate-y-0.5"
          style={{
            background: '#16A34A',
            border: '3px solid #15803D',
            boxShadow: '0 4px 0 #15803D',
            color: '#FFFFFF',
            fontFamily: "'Nunito', sans-serif",
          }}
        >
          继续阅读 →
        </button>
      </div>

      {/* 浮动小装饰 1：Target */}
      <div
        className="absolute -top-5 -right-5 w-14 h-14 rounded-2xl flex items-center justify-center"
        style={{
          background: '#FCE7F3',
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
          transform: 'rotate(12deg)',
        }}
      >
        <Sparkles size={22} style={{ color: '#EC4899' }} strokeWidth={2.8} />
      </div>

      {/* 浮动小装饰 2：Star */}
      <div
        className="absolute -bottom-4 -left-4 w-12 h-12 rounded-2xl flex items-center justify-center"
        style={{
          background: '#FEF3C7',
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
          transform: 'rotate(-8deg)',
        }}
      >
        <Star size={18} style={{ color: '#F59E0B' }} strokeWidth={2.8} fill="#F59E0B" />
      </div>

      {/* 右下浮动：浏览数 */}
      <div
        className="absolute -bottom-8 -right-4 px-4 py-2 rounded-xl flex items-center gap-1.5"
        style={{
          background: '#FFFFFF',
          border: '2.5px solid #1E1B4B',
          boxShadow: '0 3px 0 #1E1B4B',
          transform: 'rotate(3deg)',
        }}
      >
        <Eye size={14} style={{ color: '#3B82F6' }} strokeWidth={2.8} />
        <span className="text-[12px] font-bold" style={{ color: '#1E1B4B' }}>
          {totalViews.toLocaleString()} 次浏览
        </span>
      </div>
    </div>
  );
}

function StoreCard({
  store,
  palette,
  onClick,
}: {
  store: PublicDocumentStore;
  palette: (typeof CARD_PALETTES)[number];
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group relative text-left p-6 rounded-[24px] cursor-pointer transition-all active:translate-y-1"
      style={{
        background: '#FFFFFF',
        border: '3px solid #1E1B4B',
        boxShadow: '6px 6px 0 #1E1B4B',
        fontFamily: "'Nunito', sans-serif",
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
      {/* 头部：图标 + 文档数徽章 */}
      <div className="flex items-start justify-between mb-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
          style={{
            background: palette.bg,
            border: `2.5px solid ${palette.border}`,
            boxShadow: `0 3px 0 ${palette.shadow}`,
          }}
        >
          <BookOpen size={24} style={{ color: palette.icon }} strokeWidth={2.5} />
        </div>
        <div
          className="px-2.5 py-1 rounded-full flex items-center gap-1 text-[11px] font-bold"
          style={{
            background: '#F3F4F6',
            border: '2px solid #1E1B4B',
            boxShadow: '0 2px 0 #1E1B4B',
            color: '#1E1B4B',
          }}
        >
          <BookOpen size={11} strokeWidth={2.8} />
          {store.documentCount}
        </div>
      </div>

      {/* 标题 + 描述 */}
      <h3
        className="text-[20px] font-bold mb-2 line-clamp-1"
        style={{ color: '#1E1B4B', fontFamily: "'Fredoka', sans-serif" }}
      >
        {store.name}
      </h3>
      <p
        className="text-[13px] line-clamp-2 mb-5 min-h-[36px]"
        style={{ color: '#64748B', lineHeight: 1.5 }}
      >
        {store.description || '这位作者还没有写下介绍'}
      </p>

      {/* 作者 */}
      <div
        className="flex items-center gap-2 pb-4 mb-4"
        style={{ borderBottom: '2px dashed #E5E7EB' }}
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold flex-shrink-0"
          style={{
            background: palette.bg,
            border: `2px solid ${palette.border}`,
            color: palette.accent,
          }}
        >
          {store.ownerName.charAt(0)}
        </div>
        <span className="text-[13px] font-semibold" style={{ color: '#475569' }}>
          {store.ownerName}
        </span>
      </div>

      {/* 底部统计 */}
      <div className="flex items-center justify-between text-[12px] font-semibold" style={{ color: '#64748B' }}>
        <span className="flex items-center gap-1.5">
          <Heart size={13} style={{ color: '#EC4899' }} strokeWidth={2.8} fill="#FCE7F3" />
          {store.likeCount}
        </span>
        <span className="flex items-center gap-1.5">
          <Star size={13} style={{ color: '#F59E0B' }} strokeWidth={2.8} fill="#FEF3C7" />
          {store.favoriteCount}
        </span>
        <span className="flex items-center gap-1.5">
          <Eye size={13} style={{ color: '#3B82F6' }} strokeWidth={2.8} />
          {store.viewCount}
        </span>
      </div>
    </button>
  );
}

function Testimonial({
  icon: Icon,
  title,
  body,
  palette,
}: {
  icon: typeof Rocket;
  title: string;
  body: string;
  palette: (typeof CARD_PALETTES)[number];
}) {
  return (
    <div
      className="p-6 rounded-[24px] transition-all"
      style={{
        background: '#FFFFFF',
        border: '3px solid #1E1B4B',
        boxShadow: '6px 6px 0 #1E1B4B',
      }}
    >
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
        style={{
          background: palette.bg,
          border: `2.5px solid ${palette.border}`,
          boxShadow: `0 3px 0 ${palette.shadow}`,
        }}
      >
        <Icon size={24} style={{ color: palette.icon }} strokeWidth={2.5} />
      </div>
      <h3
        className="text-[20px] font-bold mb-2"
        style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
      >
        {title}
      </h3>
      <p className="text-[13px]" style={{ color: '#64748B', lineHeight: 1.6 }}>
        {body}
      </p>
    </div>
  );
}

function EmptyState() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div
        className="w-24 h-24 rounded-3xl flex items-center justify-center mb-6"
        style={{
          background: '#FEF3C7',
          border: '4px solid #1E1B4B',
          boxShadow: '6px 6px 0 #1E1B4B',
        }}
      >
        <BookOpen size={36} style={{ color: '#F59E0B' }} strokeWidth={2.5} />
      </div>
      <h3
        className="text-[28px] font-bold mb-3"
        style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
      >
        殿堂尚待第一卷藏书
      </h3>
      <p
        className="text-[14px] mb-8 max-w-md text-center font-medium"
        style={{ color: '#64748B', lineHeight: 1.6 }}
      >
        成为第一位向社区分享知识的开发者吧。前往「知识库」创建你的空间，然后在右上角开启
        <b style={{ color: '#F97316' }}>「发布到智识殿堂」</b>。
      </p>
      <ClayButton primary onClick={() => navigate('/document-store')}>
        前往我的知识库 <ArrowRight size={18} strokeWidth={3} />
      </ClayButton>
    </div>
  );
}

/** 浮动装饰背景 —— 柔和的几何形状慢慢漂浮 */
function FloatingDecor() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      {/* 几个浮动的圆 */}
      <div
        className="absolute rounded-full"
        style={{
          top: '15%',
          left: '8%',
          width: 80,
          height: 80,
          background: 'rgba(251,191,36,0.4)',
          border: '3px solid rgba(245,158,11,0.5)',
          boxShadow: '0 4px 0 rgba(217,119,6,0.3)',
          animation: 'clay-float-1 8s ease-in-out infinite',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          top: '35%',
          right: '10%',
          width: 60,
          height: 60,
          background: 'rgba(236,72,153,0.35)',
          border: '3px solid rgba(219,39,119,0.5)',
          boxShadow: '0 4px 0 rgba(190,24,93,0.3)',
          animation: 'clay-float-2 10s ease-in-out infinite',
        }}
      />
      <div
        className="absolute rounded-2xl"
        style={{
          top: '60%',
          left: '5%',
          width: 70,
          height: 70,
          background: 'rgba(59,130,246,0.3)',
          border: '3px solid rgba(37,99,235,0.5)',
          boxShadow: '0 4px 0 rgba(29,78,216,0.3)',
          transform: 'rotate(12deg)',
          animation: 'clay-float-3 12s ease-in-out infinite',
        }}
      />
      <div
        className="absolute rounded-2xl"
        style={{
          top: '75%',
          right: '15%',
          width: 50,
          height: 50,
          background: 'rgba(168,85,247,0.3)',
          border: '3px solid rgba(147,51,234,0.5)',
          boxShadow: '0 4px 0 rgba(126,34,206,0.3)',
          transform: 'rotate(-15deg)',
          animation: 'clay-float-1 9s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes clay-float-1 {
          0%, 100% { transform: translateY(0) rotate(0); }
          50% { transform: translateY(-20px) rotate(5deg); }
        }
        @keyframes clay-float-2 {
          0%, 100% { transform: translateY(0) rotate(0); }
          50% { transform: translateY(-15px) rotate(-8deg); }
        }
        @keyframes clay-float-3 {
          0%, 100% { transform: translateY(0) rotate(12deg); }
          50% { transform: translateY(-25px) rotate(20deg); }
        }
      `}</style>
    </div>
  );
}
