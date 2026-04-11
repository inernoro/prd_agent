import { cn } from '@/lib/cn';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * FeatureDeepDive — Linear.app "Plan / Build / Ship" 风格
 *
 * 六段核心能力，每段左右交替排版：
 *   左：eyebrow + 大标题 + 描述 + bullet + "了解更多 →"
 *   右：抽象几何 mockup（每段一个专属视觉金属）
 *
 * 反套路原则：
 * - 每段只用一个 accent color（不再混搭 3 色渐变）
 * - Mockup 是 CSS/SVG 几何代表，不是假数据浮动卡
 * - 背景每段交替有无微光带，形成节奏
 */

interface FeatureCore {
  id: string;
  eyebrow: string;
  name: string;
  title: string;
  description: string;
  bullets: string[];
  route: string;
  accent: string;
  Mockup: () => ReactNode;
}

const FEATURES: FeatureCore[] = [
  {
    id: 'visual',
    eyebrow: 'VISUAL · 视觉设计师',
    name: '视觉',
    title: '从一句话到一组完整视觉',
    description:
      '文生图、图生图、多图组合、局部重绘、风格迁移。配合参考图池与水印预设，让品牌视觉在一次对话中成型。',
    bullets: ['文生图 / 图生图 / 多图组合', '参考图池 + 风格迁移 + 局部重绘', '可绑定水印配置，一键导出品牌成图'],
    route: '/visual-agent',
    accent: '#a855f7',
    Mockup: VisualMockup,
  },
  {
    id: 'literary',
    eyebrow: 'LITERARY · 文学创作者',
    name: '文学',
    title: '让文字在工作台里流淌',
    description:
      '从命题写作、段落润色到自动配图，文学创作者把写作流程拆成可感知的阶段。每一次调整都能看到上一版的差异。',
    bullets: ['多风格命题写作与续写', '按段润色 + 差异对比视图', '自动为段落生成配图'],
    route: '/literary-agent',
    accent: '#fb923c',
    Mockup: LiteraryMockup,
  },
  {
    id: 'prd',
    eyebrow: 'PRD · 产品分析师',
    name: 'PRD',
    title: '读懂 PRD 的第二双眼睛',
    description:
      '把 PRD 文档丢进来，PRD 分析师会识别需求缺口、回答产品问题、生成评审意见，在方案落地前就找到那些被忽略的角落。',
    bullets: ['需求缺口自动识别', '对话式产品答疑', '正式评审前的 AI 预审'],
    route: '/prd-agent',
    accent: '#3b82f6',
    Mockup: PrdMockup,
  },
  {
    id: 'video',
    eyebrow: 'VIDEO · 视频创作者',
    name: '视频',
    title: '文章直接生成分镜与预览',
    description:
      '上传一篇文章，视频创作者会拆出分镜脚本、逐帧预览图，甚至帮你拼好草稿时间线。适合教程、产品讲解、短视频场景。',
    bullets: ['文章 → 分镜脚本自动拆解', '每一镜生成预览图', '草稿时间线可以直接导入 Remotion'],
    route: '/video-agent',
    accent: '#f43f5e',
    Mockup: VideoMockup,
  },
  {
    id: 'defect',
    eyebrow: 'DEFECT · 缺陷管理员',
    name: '缺陷',
    title: '让每一个 Bug 都能被看见',
    description:
      '从截图、录屏、用户反馈里自动提取关键信息，分类、指派、跟进。外部 Agent 还能接入，做复现 + 根因分析 + 修复报告。',
    bullets: ['截图 / 录屏自动提取信息', '严重度分类 + 优先级指派', '外部 Agent 复现 + 修复报告闭环'],
    route: '/defect-agent',
    accent: '#10b981',
    Mockup: DefectMockup,
  },
  {
    id: 'report',
    eyebrow: 'REPORT · 周报管理员',
    name: '周报',
    title: '周五不再凑字数',
    description:
      '从 Git 提交、任务流水、日报碎片自动汇总一份结构化周报，团队 Leader 还能用"计划 vs 实际"的比对视图审阅。',
    bullets: ['从 Git / 任务 / 日报自动合成', '团队汇总 + 计划对比视图', '一键导出 Markdown / PDF'],
    route: '/report-agent',
    accent: '#06b6d4',
    Mockup: ReportMockup,
  },
];

export function FeatureDeepDive() {
  return (
    <section
      className="relative py-28 md:py-36"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Section header */}
      <div className="max-w-6xl mx-auto px-6 mb-24 md:mb-32 text-center">
        <div
          className="text-[11px] uppercase text-white/40 mb-5"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.32em' }}
        >
          Core Capabilities
        </div>
        <h2
          className="text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2rem, 5vw, 3.75rem)',
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
          }}
        >
          六个专业 Agent，
          <br className="sm:hidden" />
          一个工作台
        </h2>
        <p className="mt-6 text-white/55 max-w-2xl mx-auto text-[15px] leading-relaxed">
          每一个 Agent 都是一个独立的领域专家，在 MAP 里它们共享上下文、互相调用，像一个真正的团队。
        </p>
      </div>

      {/* Six alternating feature blocks */}
      <div className="space-y-28 md:space-y-40">
        {FEATURES.map((feature, i) => (
          <FeatureBlock key={feature.id} feature={feature} reverse={i % 2 === 1} />
        ))}
      </div>
    </section>
  );
}

// ── Feature block（左右交替） ────────────────────────────────

function FeatureBlock({ feature, reverse }: { feature: FeatureCore; reverse: boolean }) {
  const { eyebrow, title, description, bullets, route, accent, Mockup } = feature;

  return (
    <div className="max-w-6xl mx-auto px-6">
      <div
        className={cn(
          'grid md:grid-cols-2 gap-10 md:gap-16 items-center',
          reverse && 'md:[&>*:first-child]:order-2',
        )}
      >
        {/* Copy side */}
        <div>
          <div
            className="text-[10.5px] uppercase mb-5 font-medium"
            style={{
              color: accent,
              fontFamily: 'var(--font-display)',
              letterSpacing: '0.24em',
            }}
          >
            {eyebrow}
          </div>
          <h3
            className="text-white font-medium mb-6"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.75rem, 3.6vw, 3.25rem)',
              lineHeight: 1.05,
              letterSpacing: '-0.025em',
            }}
          >
            {title}
          </h3>
          <p className="text-white/60 text-[15px] leading-relaxed mb-7 max-w-lg">
            {description}
          </p>
          <ul className="space-y-3 mb-8">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-3 text-[14px] text-white/75">
                <span
                  className="mt-[9px] w-1 h-1 rounded-full shrink-0"
                  style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <a
            href={route}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-white/85 hover:text-white transition-colors group"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
          >
            了解更多
            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>

        {/* Mockup side */}
        <div className="relative">
          <Mockup />
        </div>
      </div>
    </div>
  );
}

// ── Mockups（六个抽象几何示意） ────────────────────────────────

function MockupFrame({
  children,
  accent,
}: {
  children: ReactNode;
  accent: string;
}) {
  return (
    <div
      className="relative rounded-2xl overflow-hidden border border-white/10 bg-[#0A0D14] p-5 md:p-6"
      style={{
        boxShadow: `0 40px 100px -30px ${accent}55, 0 20px 60px -20px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.06)`,
      }}
    >
      {/* 顶部 HUD 扫光 */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent}aa 50%, transparent 100%)`,
        }}
      />
      {children}
    </div>
  );
}

// 1. 视觉：2×2 生成图网格
function VisualMockup() {
  const accent = '#a855f7';
  const grads = [
    'radial-gradient(circle at 30% 70%, #00d4ff 0%, transparent 50%), linear-gradient(135deg, #0a0a1e 0%, #2a0a3e 100%)',
    'radial-gradient(circle at 70% 30%, #f43f5e 0%, transparent 50%), linear-gradient(135deg, #1a0515 0%, #0a1a25 100%)',
    'radial-gradient(circle at 50% 50%, #a855f7 0%, transparent 50%), linear-gradient(135deg, #050a15 0%, #200a30 100%)',
    'radial-gradient(circle at 40% 60%, #06b6d4 0%, transparent 50%), linear-gradient(135deg, #0a0515 0%, #0a1a30 100%)',
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          visual-agent · 4 张候选
        </div>
        <div className="flex gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {grads.map((g, i) => (
          <div
            key={i}
            className="relative aspect-[4/3] rounded-lg overflow-hidden border border-white/[0.06]"
            style={{ background: g }}
          >
            <div
              className="absolute inset-x-0 bottom-0 h-1/2"
              style={{ background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.5))' }}
            />
            {i < 2 && (
              <div className="absolute top-1.5 right-1.5 w-3 h-3 rounded-full bg-emerald-400/90 flex items-center justify-center">
                <svg className="w-1.5 h-1.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-[10px] text-white/45">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: accent, animation: 'mockup-pulse 1.5s ease-in-out infinite' }}
        />
        <span>生成中 · 2 / 4 已完成</span>
      </div>
      <style>{`
        @keyframes mockup-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      `}</style>
    </MockupFrame>
  );
}

// 2. 文学：段落 + 光标 + 差异标记
function LiteraryMockup() {
  const accent = '#fb923c';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          literary-agent · 润色中
        </div>
        <div className="text-[10px] text-white/35">段 3 / 7</div>
      </div>
      <div className="space-y-2">
        <TextLine width="100%" />
        <TextLine width="92%" />
        <TextLine width="78%" strike />
        <TextLine width="88%" highlight={accent} />
        <TextLine width="100%" />
        <TextLine width="96%" highlight={accent} />
        <TextLine width="54%" cursor accent={accent} />
      </div>
      <div className="mt-5 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] text-white/45">
        <div className="flex items-center gap-3">
          <span>+ 12 字</span>
          <span style={{ color: accent }}>删除 3 字</span>
        </div>
        <span>差异视图</span>
      </div>
    </MockupFrame>
  );
}

function TextLine({
  width,
  strike,
  highlight,
  cursor,
  accent,
}: {
  width: string;
  strike?: boolean;
  highlight?: string;
  cursor?: boolean;
  accent?: string;
}) {
  return (
    <div className="relative h-2.5 flex items-center">
      <div
        className="h-[3px] rounded-sm"
        style={{
          width,
          background: strike
            ? 'rgba(255, 255, 255, 0.15)'
            : highlight
              ? `linear-gradient(90deg, rgba(255,255,255,0.5), ${highlight}66)`
              : 'rgba(255, 255, 255, 0.3)',
          textDecoration: strike ? 'line-through' : undefined,
        }}
      />
      {strike && (
        <div
          className="absolute left-0 top-1/2 h-px"
          style={{ width, background: 'rgba(251, 146, 60, 0.5)' }}
        />
      )}
      {cursor && (
        <span
          className="ml-0.5 w-0.5 h-3 rounded-sm"
          style={{
            background: accent ?? '#fff',
            animation: 'mockup-blink 1s steps(1) infinite',
          }}
        />
      )}
      <style>{`
        @keyframes mockup-blink { 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}

// 3. PRD：结构化文档 + 缺口标注
function PrdMockup() {
  const accent = '#3b82f6';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          prd-agent · v3.0 需求分析
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          3 gaps
        </div>
      </div>
      <div className="space-y-3">
        <PrdSection title="§ 用户故事" complete />
        <PrdSection title="§ 核心流程" gap accent={accent} note="缺少异常分支" />
        <PrdSection title="§ 数据模型" complete />
        <PrdSection title="§ 权限矩阵" gap accent={accent} note="未定义角色边界" />
        <PrdSection title="§ 测试用例" gap accent={accent} note="缺少失败场景" />
      </div>
    </MockupFrame>
  );
}

function PrdSection({
  title,
  complete,
  gap,
  accent,
  note,
}: {
  title: string;
  complete?: boolean;
  gap?: boolean;
  accent?: string;
  note?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: complete ? 'rgba(16, 185, 129, 0.8)' : accent,
          boxShadow: gap && accent ? `0 0 8px ${accent}` : undefined,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-white/80" style={{ fontFamily: 'var(--font-body)' }}>
          {title}
        </div>
        {note && (
          <div className="text-[10px] mt-0.5" style={{ color: accent }}>
            ⚠ {note}
          </div>
        )}
      </div>
    </div>
  );
}

// 4. 视频：时间线 + 分镜帧
function VideoMockup() {
  const accent = '#f43f5e';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          video-agent · 6 分镜
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-white/45">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: accent, animation: 'mockup-pulse 1.2s ease-in-out infinite' }}
          />
          <span>渲染中 · 72%</span>
        </div>
      </div>
      {/* 分镜缩略图 */}
      <div className="grid grid-cols-6 gap-1.5 mb-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="aspect-[16/9] rounded-sm relative overflow-hidden"
            style={{
              background: `linear-gradient(${135 + i * 20}deg, rgba(244, 63, 94, ${0.15 + i * 0.05}), rgba(124, 58, 237, ${0.1 + i * 0.05}))`,
              border: i === 3 ? `1px solid ${accent}` : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {i === 3 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-2 h-2 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
      {/* 时间线 */}
      <div className="relative h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: '72%', background: `linear-gradient(90deg, ${accent}, #f43f5e)` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white"
          style={{ left: '72%', transform: 'translate(-50%, -50%)', boxShadow: `0 0 10px ${accent}` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-white/40 font-mono">
        <span>00:00</span>
        <span>01:36</span>
        <span>02:45</span>
      </div>
    </MockupFrame>
  );
}

// 5. 缺陷：卡片堆叠
function DefectMockup() {
  const accent = '#10b981';
  const defects = [
    { sev: 'P0', title: '对话消息在刷新后丢失', color: '#ef4444' },
    { sev: 'P1', title: '图像生成超时未释放', color: '#f97316' },
    { sev: 'P2', title: '深色模式下描边消失', color: '#eab308' },
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          defect-agent · 3 个待处理
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          AI triaged
        </div>
      </div>
      <div className="space-y-2.5">
        {defects.map((d, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/5"
          >
            <div
              className="px-2 py-0.5 rounded text-[9px] font-semibold shrink-0"
              style={{ background: `${d.color}22`, color: d.color, fontFamily: 'var(--font-display)' }}
            >
              {d.sev}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-white/85 truncate">{d.title}</div>
            </div>
            <div className="shrink-0 text-[10px] text-white/35">已分派</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-[10px] text-white/45">
        <div>本周新增 · 27</div>
        <div>已修复 · 19</div>
        <div style={{ color: accent }}>修复率 · 70%</div>
      </div>
    </MockupFrame>
  );
}

// 6. 周报：条形图 + 计划对比
function ReportMockup() {
  const accent = '#06b6d4';
  const bars = [
    { label: '周一', plan: 100, actual: 95 },
    { label: '周二', plan: 80, actual: 88 },
    { label: '周三', plan: 90, actual: 72 },
    { label: '周四', plan: 85, actual: 90 },
    { label: '周五', plan: 70, actual: 65 },
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          report-agent · W15
        </div>
        <div className="flex items-center gap-3 text-[9px] text-white/40">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-white/25" />
            <span>计划</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: accent }} />
            <span>实际</span>
          </div>
        </div>
      </div>
      <div className="flex items-end gap-3 h-32 mb-2">
        {bars.map((b, i) => (
          <div key={i} className="flex-1 flex items-end gap-1">
            <div
              className="flex-1 rounded-t"
              style={{ height: `${b.plan}%`, background: 'rgba(255,255,255,0.1)' }}
            />
            <div
              className="flex-1 rounded-t"
              style={{
                height: `${b.actual}%`,
                background: `linear-gradient(180deg, ${accent}, ${accent}80)`,
                boxShadow: `0 0 8px ${accent}66`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-white/40">
        {bars.map((b, i) => (
          <span key={i}>{b.label}</span>
        ))}
      </div>
    </MockupFrame>
  );
}
