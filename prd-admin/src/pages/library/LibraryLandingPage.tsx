/**
 * LibraryLandingPage — 「智识殿堂」公共知识库浏览页
 *
 * 设计参考：uupm.cc/demo/educational-platform (LearnHub)
 *
 * 关键特征：
 *  - 纯奶油色背景 #FEF3C7（无径向 gradient，无浮动装饰，简洁）
 *  - 顶部居中悬浮 navbar（白色 + 4px 黑边 + 6px 硬投影）
 *  - 超大 font-black 标题（tighter letter-spacing）
 *  - Hero 左文右 mock 卡片
 *  - 居中 "Popular Courses" 风格 pill badge + 居中大标题
 *  - 2x2 课程卡片网格（彩色图标盒 + 作者 + 星级 + 统计）
 *  - 所有可点击元素 hover:-translate-y
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Heart,
  Eye,
  Star,
  ArrowLeft,
  ArrowRight,
  Rocket,
  Users,
  GraduationCap,
  Code,
  Palette,
  BarChart3,
  Smartphone,
  Layers,
  Search,
  X,
} from 'lucide-react';
import { listPublicDocumentStores } from '@/services';
import type { PublicDocumentStore } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { ClayButton } from './ClayButton';

type SortKey = 'hot' | 'new' | 'popular' | 'viewed';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'hot', label: '热门' },
  { key: 'popular', label: '高赞' },
  { key: 'viewed', label: '高阅' },
  { key: 'new', label: '最新' },
];

// 卡片头部图标色彩池（参考 LearnHub 课程卡片）
const CARD_ACCENTS = [
  { bg: '#FECACA', icon: Code, iconColor: '#DC2626' },        // 红：代码/开发
  { bg: '#BFDBFE', icon: Palette, iconColor: '#2563EB' },     // 蓝：设计
  { bg: '#C7D2FE', icon: BarChart3, iconColor: '#6366F1' },   // 靛：数据
  { bg: '#BBF7D0', icon: Smartphone, iconColor: '#16A34A' },  // 绿：移动
  { bg: '#FED7AA', icon: Layers, iconColor: '#EA580C' },      // 橙：综合
  { bg: '#F9A8D4', icon: GraduationCap, iconColor: '#DB2777' }, // 粉：教育
];

/** 注入 Fredoka + Nunito 字体 */
function useFredokaFonts() {
  useEffect(() => {
    const id = 'library-claymorphism-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800;900&display=swap';
    document.head.appendChild(link);
  }, []);
}

export function LibraryLandingPage() {
  const navigate = useNavigate();
  const [stores, setStores] = useState<PublicDocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('hot');
  const [searchQuery, setSearchQuery] = useState('');
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

  // 客户端按关键词过滤：匹配名称 / 描述 / 作者 / 标签（大小写不敏感）
  const q = searchQuery.trim().toLowerCase();
  const filteredStores = q
    ? stores.filter((s) => {
        const hay = [
          s.name,
          s.description ?? '',
          s.ownerName,
          ...(s.tags ?? []),
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : stores;

  return (
    <div
      className="min-h-screen w-full overflow-y-auto"
      style={{
        // 纯奶油色背景，无 gradient，无 radial
        background: '#FEF3C7',
        fontFamily: "'Nunito', system-ui, sans-serif",
        color: '#1E1B4B',
      }}
    >
      {/* ── 顶部悬浮 Navbar (LearnHub style) ── */}
      <FloatingNavbar
        onStartExplore={() => {
          const el = document.getElementById('catalog');
          el?.scrollIntoView({ behavior: 'smooth' });
        }}
        onBack={() => navigate(-1)}
      />

      {/* ── Hero 区 ── */}
      <section className="relative px-6 pt-44 pb-16">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            {/* 左侧文字 */}
            <div>
              {/* NEW badge */}
              <div
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-8"
                style={{
                  background: '#BBF7D0',
                  border: '3px solid #1E1B4B',
                  boxShadow: '0 4px 0 #1E1B4B',
                }}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: '#16A34A', boxShadow: '0 0 6px #16A34A' }}
                />
                <span className="text-[12px] font-black" style={{ color: '#14532D' }}>
                  NEW · 社区驱动的知识库
                </span>
              </div>

              {/* 超大标题 */}
              <h1
                className="mb-6 leading-[0.9]"
                style={{
                  fontFamily: "'Fredoka', 'Nunito', sans-serif",
                  fontSize: 'clamp(56px, 9vw, 112px)',
                  fontWeight: 700,
                  color: '#1E1B4B',
                  letterSpacing: '-0.04em',
                }}
              >
                读<span style={{ color: '#16A34A' }}>万卷书</span>，<br />
                行<span style={{ color: '#F97316' }}>万里路</span>。
              </h1>

              <p
                className="text-[16px] md:text-[18px] mb-10 max-w-md leading-relaxed"
                style={{ color: '#475569', fontWeight: 500 }}
              >
                汇聚千百开发者的洞见与心得。加入社区，探索 {stores.length}+ 个
                知识库，来自各领域专家倾情分享。
              </p>

              {/* 双按钮 */}
              <div className="flex flex-wrap gap-4 mb-14">
                <ClayButton
                  size="lg"
                  variant="primary"
                  onClick={() => {
                    const el = document.getElementById('catalog');
                    el?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  开始探索 <ArrowRight size={18} strokeWidth={3} />
                </ClayButton>
                <ClayButton size="lg" variant="secondary" onClick={() => navigate('/document-store')}>
                  发布我的知识
                </ClayButton>
              </div>

              {/* 统计数据（横向 like LearnHub） */}
              <div className="flex items-start gap-10">
                <Stat num={stores.length} label="知识库" />
                <Stat num={totalDocs} label="文档" />
                <Stat num={totalLikes} label="点赞" />
              </div>
            </div>

            {/* 右侧 Feature Card —— 用排序下的 #1 知识库的真实数据驱动 */}
            <div className="hidden md:block">
              <HeroFeatureCard
                store={stores[0]}
                loading={loading}
                onView={(id) => navigate(`/library/${id}`)}
                onPublish={() => navigate('/document-store')}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── 课程目录区（Popular Courses → Explore Top-Rated Courses） ── */}
      <section id="catalog" className="relative px-6 py-24" style={{ background: '#FFFFFF' }}>
        <div className="max-w-6xl mx-auto">
          {/* 居中 badge */}
          <div className="text-center mb-6">
            <div
              className="inline-block px-5 py-2 rounded-full"
              style={{
                background: '#BFDBFE',
                border: '3px solid #1E1B4B',
                boxShadow: '0 4px 0 #1E1B4B',
              }}
            >
              <span className="text-[13px] font-black" style={{ color: '#1E3A8A' }}>
                Popular Knowledge
              </span>
            </div>
          </div>

          <h2
            className="text-center mb-4"
            style={{
              fontFamily: "'Fredoka', sans-serif",
              fontSize: 'clamp(36px, 5vw, 56px)',
              fontWeight: 700,
              color: '#1E1B4B',
              letterSpacing: '-0.02em',
              lineHeight: 1.05,
            }}
          >
            探索热门知识库
          </h2>
          <p
            className="text-center mb-10 text-[16px]"
            style={{ color: '#64748B', fontWeight: 500 }}
          >
            向行业专家学习，获取真实世界的经验与洞见
          </p>

          {/* 搜索框（claymorphism 风格，与页面视觉一致） */}
          <div className="max-w-xl mx-auto mb-6">
            <div
              className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-white"
              style={{
                border: '3px solid #1E1B4B',
                boxShadow: '0 4px 0 #1E1B4B',
              }}
            >
              <Search size={18} strokeWidth={3} style={{ color: '#6366F1', flexShrink: 0 }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索知识库名称 / 作者 / 标签..."
                className="flex-1 bg-transparent outline-none text-[15px] font-semibold placeholder:font-medium"
                style={{ color: '#1E1B4B' }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="p-1 rounded-full hover:bg-[#FEF3C7] transition-colors"
                  aria-label="清除搜索"
                >
                  <X size={16} strokeWidth={3} style={{ color: '#64748B' }} />
                </button>
              )}
            </div>
            {q && (
              <div className="mt-2 text-center text-[13px] font-semibold" style={{ color: '#475569' }}>
                找到 <span style={{ color: '#1E1B4B', fontWeight: 800 }}>{filteredStores.length}</span> 个匹配结果
              </div>
            )}
          </div>

          {/* 排序切换 */}
          <div className="flex items-center justify-center gap-3 mb-12 flex-wrap">
            {SORT_OPTIONS.map((opt) => (
              <ClayButton
                key={opt.key}
                size="sm"
                variant={sort === opt.key ? 'primary' : 'white'}
                active={sort === opt.key}
                onClick={() => setSort(opt.key)}
              >
                {opt.label}
              </ClayButton>
            ))}
          </div>

          {loading ? (
            <MapSectionLoader text="加载中..." />
          ) : stores.length === 0 ? (
            <EmptyState onPublish={() => navigate('/document-store')} />
          ) : filteredStores.length === 0 ? (
            <div
              className="text-center py-16 px-6 rounded-3xl bg-white max-w-xl mx-auto"
              style={{ border: '3px solid #1E1B4B', boxShadow: '0 6px 0 #1E1B4B' }}
            >
              <div className="text-[48px] mb-2">🔍</div>
              <div className="text-[20px] font-black mb-1" style={{ color: '#1E1B4B' }}>
                未找到匹配「{searchQuery}」的知识库
              </div>
              <div className="text-[14px] font-semibold" style={{ color: '#64748B' }}>
                换个关键词试试，或清空搜索浏览全部
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filteredStores.map((s, idx) => (
                <CourseCard
                  key={s.id}
                  store={s}
                  accent={CARD_ACCENTS[idx % CARD_ACCENTS.length]}
                  onClick={() => navigate(`/library/${s.id}`)}
                />
              ))}
            </div>
          )}

          {/* View All */}
          {stores.length > 0 && (
            <div className="text-center mt-12">
              <ClayButton
                size="lg"
                variant="secondary"
                onClick={() => {
                  const el = document.getElementById('why');
                  el?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                查看更多 <ArrowRight size={18} strokeWidth={3} />
              </ClayButton>
            </div>
          )}
        </div>
      </section>

      {/* ── Why Choose Us 区（Testimonial） ── */}
      <section id="why" className="relative px-6 py-24">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-6">
            <div
              className="inline-block px-5 py-2 rounded-full"
              style={{
                background: '#FECACA',
                border: '3px solid #1E1B4B',
                boxShadow: '0 4px 0 #1E1B4B',
              }}
            >
              <span className="text-[13px] font-black" style={{ color: '#7F1D1D' }}>
                Why Share
              </span>
            </div>
          </div>

          <h2
            className="text-center mb-4"
            style={{
              fontFamily: "'Fredoka', sans-serif",
              fontSize: 'clamp(36px, 5vw, 56px)',
              fontWeight: 700,
              color: '#1E1B4B',
              letterSpacing: '-0.02em',
              lineHeight: 1.05,
            }}
          >
            分享，让知识倍增
          </h2>
          <p
            className="text-center mb-14 text-[16px]"
            style={{ color: '#64748B', fontWeight: 500 }}
          >
            每一次分享都是一次教学相长
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            <Testimonial
              icon={Rocket}
              iconBg="#FECACA"
              iconColor="#DC2626"
              title="加速成长"
              body="把脑中的洞见写出来，你会发现自己理解得更深入。教是最好的学。"
            />
            <Testimonial
              icon={Users}
              iconBg="#BFDBFE"
              iconColor="#2563EB"
              title="连接同好"
              body="每一份文档都是一扇窗。让有共鸣的人通过点赞、收藏找到你。"
            />
            <Testimonial
              icon={GraduationCap}
              iconBg="#BBF7D0"
              iconColor="#16A34A"
              title="沉淀资产"
              body="知识库是永远不会过期的资产，今天写的明天就能被 AI 再利用。"
            />
          </div>
        </div>
      </section>

      {/* ── 底部大 CTA ── */}
      <section className="relative px-6 pb-24">
        <div className="max-w-4xl mx-auto">
          <div
            className="px-10 py-16 rounded-[36px] text-center"
            style={{
              background: '#16A34A',
              border: '4px solid #1E1B4B',
              boxShadow: '8px 8px 0 #1E1B4B',
            }}
          >
            <h3
              className="mb-4"
              style={{
                fontFamily: "'Fredoka', sans-serif",
                fontSize: 'clamp(32px, 4.5vw, 48px)',
                fontWeight: 700,
                color: '#FFFFFF',
                letterSpacing: '-0.02em',
                lineHeight: 1.05,
              }}
            >
              今天就开始分享
            </h3>
            <p
              className="mb-8 max-w-md mx-auto text-[15px] md:text-[17px]"
              style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}
            >
              加入社区，把你的知识变成一本永不过时的书
            </p>
            <div className="inline-block">
              <ClayButton size="lg" variant="white" onClick={() => navigate('/document-store')}>
                前往我的知识库 <ArrowRight size={18} strokeWidth={3} />
              </ClayButton>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── 顶部悬浮导航栏（LearnHub style） ──

function FloatingNavbar({ onStartExplore, onBack }: { onStartExplore: () => void; onBack: () => void }) {
  return (
    <nav
      className="z-50 px-4 md:px-6"
      style={{
        position: 'fixed',
        top: 24,
        left: 0,
        right: 0,
      }}
    >
      <div
        className="max-w-6xl mx-auto rounded-[28px] px-5 md:px-6 py-3 flex items-center justify-between"
        style={{
          background: '#FFFFFF',
          border: '4px solid #1E1B4B',
          boxShadow: '0 6px 0 #1E1B4B',
        }}
      >
        {/* Logo */}
        <button
          onClick={onBack}
          className="flex items-center gap-3 cursor-pointer hover:-translate-y-0.5 transition-transform"
        >
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{
              background: '#FECACA',
              border: '3px solid #1E1B4B',
              boxShadow: '0 3px 0 #1E1B4B',
            }}
          >
            <BookOpen size={20} style={{ color: '#DC2626' }} strokeWidth={2.8} />
          </div>
          <span
            className="text-[20px] md:text-[22px] font-black"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            智识殿堂
          </span>
        </button>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-10">
          <a
            href="#catalog"
            className="text-[15px] font-bold transition-colors hover:opacity-60"
            style={{ color: '#1E1B4B' }}
          >
            知识库
          </a>
          <a
            href="#why"
            className="text-[15px] font-bold transition-colors hover:opacity-60"
            style={{ color: '#1E1B4B' }}
          >
            为什么
          </a>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-[14px] font-bold cursor-pointer transition-colors hover:opacity-60"
            style={{ color: '#1E1B4B' }}
          >
            <ArrowLeft size={14} strokeWidth={2.8} />
            返回
          </button>
          <ClayButton size="md" variant="primary" onClick={onStartExplore}>
            开始探索
          </ClayButton>
        </div>
      </div>
    </nav>
  );
}

// ── 横向统计（LearnHub style：10K+ Courses） ──
function Stat({ num, label }: { num: number; label: string }) {
  return (
    <div>
      <div
        className="text-[32px] md:text-[40px] leading-none mb-1"
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 700,
          color: '#1E1B4B',
          letterSpacing: '-0.02em',
        }}
      >
        {num.toLocaleString()}+
      </div>
      <div className="text-[12px] md:text-[13px] font-bold" style={{ color: '#64748B' }}>
        {label}
      </div>
    </div>
  );
}

// ── Hero 右侧 Feature Card（真实数据，展示当前排序下的 #1 知识库） ──
function HeroFeatureCard({
  store,
  loading,
  onView,
  onPublish,
}: {
  store?: PublicDocumentStore;
  loading: boolean;
  onView: (id: string) => void;
  onPublish: () => void;
}) {
  // 加载态：骨架卡片，避免空白
  if (loading) {
    return (
      <div className="relative max-w-md ml-auto">
        <div
          className="p-6 rounded-[28px]"
          style={{
            background: '#FFFFFF',
            border: '4px solid #1E1B4B',
            boxShadow: '8px 8px 0 #1E1B4B',
            minHeight: 260,
          }}
        >
          <MapSectionLoader text="正在加载特色知识库…" />
        </div>
      </div>
    );
  }

  // 空数据态：引导发布
  if (!store) {
    return (
      <div className="relative max-w-md ml-auto">
        <div
          className="p-8 rounded-[28px] text-center"
          style={{
            background: '#FFFFFF',
            border: '4px solid #1E1B4B',
            boxShadow: '8px 8px 0 #1E1B4B',
          }}
        >
          <div
            className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{
              background: '#FECACA',
              border: '3px solid #1E1B4B',
              boxShadow: '0 3px 0 #1E1B4B',
            }}
          >
            <BookOpen size={26} style={{ color: '#DC2626' }} strokeWidth={2.5} />
          </div>
          <div
            className="text-[20px] mb-2"
            style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 700, color: '#1E1B4B' }}
          >
            等待第一卷藏书
          </div>
          <p className="text-[13px] mb-6 font-medium" style={{ color: '#64748B' }}>
            成为第一位向社区分享知识的人
          </p>
          <button
            onClick={onPublish}
            className="w-full py-4 rounded-2xl text-[15px] font-black cursor-pointer transition-all hover:-translate-y-0.5"
            style={{
              background: '#16A34A',
              border: '3px solid #1E1B4B',
              boxShadow: '0 4px 0 #1E1B4B',
              color: '#FFFFFF',
              fontFamily: "'Nunito', sans-serif",
            }}
          >
            发布我的知识 →
          </button>
        </div>
      </div>
    );
  }

  // 真实数据：用渐近曲线把 (likes + views/5) 映射到 0-100% 热度
  // 0 = 0%, combined=15 → 50%, combined=60 → 80%, combined=∞ → 100%
  const combined = store.likeCount + Math.floor(store.viewCount / 5);
  const heatPct = Math.round((combined / (combined + 15)) * 100);

  return (
    <div className="relative max-w-md ml-auto">
      <div
        className="p-6 rounded-[28px]"
        style={{
          background: '#FFFFFF',
          border: '4px solid #1E1B4B',
          boxShadow: '8px 8px 0 #1E1B4B',
        }}
      >
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{
              background: '#BFDBFE',
              border: '3px solid #1E1B4B',
              boxShadow: '0 3px 0 #1E1B4B',
            }}
          >
            <BookOpen size={24} style={{ color: '#2563EB' }} strokeWidth={2.5} />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="text-[18px] leading-tight truncate"
              style={{
                fontFamily: "'Fredoka', sans-serif",
                fontWeight: 700,
                color: '#1E1B4B',
              }}
              title={store.name}
            >
              {store.name}
            </div>
            <div className="text-[12px] font-bold mt-0.5 truncate" style={{ color: '#64748B' }}>
              {store.documentCount} 篇文档 · by {store.ownerName}
            </div>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[13px] font-bold" style={{ color: '#64748B' }}>
              热度
            </span>
            <span
              className="text-[15px]"
              style={{
                fontFamily: "'Fredoka', sans-serif",
                fontWeight: 700,
                color: '#16A34A',
              }}
            >
              {heatPct}%
            </span>
          </div>
          <div
            className="h-4 rounded-full overflow-hidden"
            style={{ background: '#F3F4F6', border: '2.5px solid #1E1B4B' }}
          >
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${heatPct}%`,
                background: '#16A34A',
              }}
            />
          </div>
          <div
            className="flex items-center gap-4 mt-3 text-[11px] font-bold"
            style={{ color: '#64748B' }}
          >
            <span className="flex items-center gap-1">
              <Heart size={12} strokeWidth={2.8} style={{ color: '#EC4899' }} fill="#FCE7F3" />
              {store.likeCount}
            </span>
            <span className="flex items-center gap-1">
              <Eye size={12} strokeWidth={2.8} />
              {store.viewCount}
            </span>
            <span className="flex items-center gap-1">
              <BookOpen size={12} strokeWidth={2.8} />
              {store.documentCount}
            </span>
          </div>
        </div>

        <button
          onClick={() => onView(store.id)}
          className="w-full py-4 rounded-2xl text-[15px] font-black cursor-pointer transition-all hover:-translate-y-0.5"
          style={{
            background: '#16A34A',
            border: '3px solid #1E1B4B',
            boxShadow: '0 4px 0 #1E1B4B',
            color: '#FFFFFF',
            fontFamily: "'Nunito', sans-serif",
          }}
        >
          立即查看 →
        </button>
      </div>

      {/* 右上角装饰 */}
      <div
        className="absolute -top-4 -right-4 w-14 h-14 rounded-2xl flex items-center justify-center"
        style={{
          background: '#FECACA',
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
          transform: 'rotate(8deg)',
        }}
      >
        <Rocket size={22} style={{ color: '#DC2626' }} strokeWidth={2.5} />
      </div>

      {/* 右下角星星 */}
      <div
        className="absolute -bottom-4 -right-4 w-12 h-12 rounded-full flex items-center justify-center"
        style={{
          background: '#BBF7D0',
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
        }}
      >
        <Star size={18} style={{ color: '#16A34A' }} strokeWidth={2.8} fill="#16A34A" />
      </div>

      {/* 左下角 */}
      <div
        className="absolute -bottom-3 -left-3 w-11 h-11 rounded-2xl flex items-center justify-center"
        style={{
          background: '#E9D5FF',
          border: '3px solid #1E1B4B',
          boxShadow: '0 3px 0 #1E1B4B',
          transform: 'rotate(-10deg)',
        }}
      >
        <Layers size={16} style={{ color: '#9333EA' }} strokeWidth={2.8} />
      </div>
    </div>
  );
}

// ── 课程卡片（LearnHub 2x2 grid） ──
function CourseCard({
  store,
  accent,
  onClick,
}: {
  store: PublicDocumentStore;
  accent: (typeof CARD_ACCENTS)[number];
  onClick: () => void;
}) {
  const Icon = accent.icon;
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-5 p-6 rounded-[24px] cursor-pointer transition-all hover:-translate-y-1 text-left w-full"
      style={{
        background: '#FFFFFF',
        border: '3px solid #1E1B4B',
        boxShadow: '6px 6px 0 #1E1B4B',
        fontFamily: "'Nunito', sans-serif",
      }}
    >
      {/* 左侧大图标 */}
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0"
        style={{
          background: accent.bg,
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
        }}
      >
        <Icon size={26} style={{ color: accent.iconColor }} strokeWidth={2.5} />
      </div>

      {/* 中间：标题 + 作者 + 统计 */}
      <div className="flex-1 min-w-0">
        <h3
          className="text-[17px] md:text-[18px] mb-1 truncate"
          style={{
            fontFamily: "'Fredoka', sans-serif",
            fontWeight: 700,
            color: '#1E1B4B',
          }}
        >
          {store.name}
        </h3>
        <p className="text-[13px] font-bold mb-3 truncate" style={{ color: '#64748B' }}>
          by {store.ownerName}
        </p>
        <div className="flex items-center gap-3 text-[11px] font-bold" style={{ color: '#64748B' }}>
          <span className="flex items-center gap-1">
            <BookOpen size={12} strokeWidth={2.8} />
            {store.documentCount} 篇
          </span>
          <span className="flex items-center gap-1">
            <Heart size={12} strokeWidth={2.8} style={{ color: '#EC4899' }} fill="#FCE7F3" />
            {store.likeCount}
          </span>
          <span className="flex items-center gap-1">
            <Eye size={12} strokeWidth={2.8} />
            {store.viewCount}
          </span>
        </div>
      </div>

      {/* 右侧：星级 badge */}
      <div
        className="flex items-center gap-1 px-3 py-1.5 rounded-full flex-shrink-0"
        style={{
          background: '#BBF7D0',
          border: '2.5px solid #1E1B4B',
          boxShadow: '0 2px 0 #1E1B4B',
        }}
      >
        <Star size={12} strokeWidth={2.8} fill="#16A34A" style={{ color: '#16A34A' }} />
        <span className="text-[12px] font-black" style={{ color: '#14532D' }}>
          {(4 + Math.min(store.likeCount, 10) / 10).toFixed(1)}
        </span>
      </div>
    </button>
  );
}

// ── Testimonial ──
function Testimonial({
  icon: Icon,
  iconBg,
  iconColor,
  title,
  body,
}: {
  icon: typeof Rocket;
  iconBg: string;
  iconColor: string;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded-[24px] transition-all hover:-translate-y-1 cursor-default"
      style={{
        background: '#FFFFFF',
        border: '3px solid #1E1B4B',
        boxShadow: '6px 6px 0 #1E1B4B',
        padding: 28,
      }}
    >
      <div
        className="rounded-2xl flex items-center justify-center"
        style={{
          width: 64,
          height: 64,
          minWidth: 64,
          minHeight: 64,
          marginBottom: 20,
          background: iconBg,
          border: '3px solid #1E1B4B',
          boxShadow: '0 4px 0 #1E1B4B',
        }}
      >
        <Icon size={26} style={{ color: iconColor }} strokeWidth={2.5} />
      </div>
      <h3
        style={{
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 700,
          color: '#1E1B4B',
          letterSpacing: '-0.01em',
          fontSize: 22,
          marginBottom: 12,
        }}
      >
        {title}
      </h3>
      <p style={{ color: '#64748B', lineHeight: 1.65, fontSize: 14, fontWeight: 500 }}>
        {body}
      </p>
    </div>
  );
}

function EmptyState({ onPublish }: { onPublish: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div
        className="w-24 h-24 rounded-[24px] flex items-center justify-center mb-6"
        style={{
          background: '#FECACA',
          border: '4px solid #1E1B4B',
          boxShadow: '6px 6px 0 #1E1B4B',
        }}
      >
        <BookOpen size={36} style={{ color: '#DC2626' }} strokeWidth={2.5} />
      </div>
      <h3
        className="text-[28px] mb-3"
        style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 700, color: '#1E1B4B' }}
      >
        殿堂尚待第一卷藏书
      </h3>
      <p
        className="text-[14px] mb-8 max-w-md text-center font-medium"
        style={{ color: '#64748B', lineHeight: 1.6 }}
      >
        成为第一位向社区分享知识的开发者吧
      </p>
      <ClayButton size="lg" variant="primary" onClick={onPublish}>
        前往我的知识库 <ArrowRight size={18} strokeWidth={3} />
      </ClayButton>
    </div>
  );
}
