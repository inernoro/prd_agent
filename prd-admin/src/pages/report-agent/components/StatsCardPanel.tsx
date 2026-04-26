import { useState, useEffect } from 'react';
import {
  GitCommitHorizontal, Bug, MessageSquare, FileText,
  Image, Video, Workflow, Globe, Brain,
  Github, BookOpen, ChevronRight,
} from 'lucide-react';
import { getCollectedActivity } from '@/services';
import type { CollectedActivity } from '@/services/contracts/reportAgent';
import { useDataTheme } from '../hooks/useDataTheme';

interface Props {
  weekYear: number;
  weekNumber: number;
  /** 是否显示渐进增强引导 */
  showEnhanceGuide?: boolean;
  /** 引导点击回调 */
  onGuideClick?: (target: 'github' | 'workflow' | 'daily-log') => void;
  /** Mock 数据 — 预览模式下传入，跳过 API 调用 */
  mockData?: CollectedActivity;
}

interface CardDef {
  key: string;
  label: string;
  icon: React.ElementType;
  color: string;
  getValue: (a: CollectedActivity) => number;
  getDetail?: (a: CollectedActivity) => string | null;
  /** true = 始终显示（系统内数据）; false = 有数据时才显示 */
  alwaysShow: boolean;
  group: 'code' | 'task' | 'defect' | 'collab' | 'ai' | 'creative';
}

const CARD_DEFS: CardDef[] = [
  {
    key: 'commits',
    label: '代码提交',
    icon: GitCommitHorizontal,
    color: 'rgba(59, 130, 246, 0.85)',
    getValue: (a) => a.commits?.length ?? 0,
    getDetail: (a) => {
      if (!a.commits?.length) return null;
      const add = a.commits.reduce((s, c) => s + (c.additions ?? 0), 0);
      const del = a.commits.reduce((s, c) => s + (c.deletions ?? 0), 0);
      return `+${add} / -${del}`;
    },
    alwaysShow: false,
    group: 'code',
  },
  {
    key: 'defects',
    label: '缺陷处理',
    icon: Bug,
    color: 'rgba(239, 68, 68, 0.85)',
    getValue: (a) => a.defectsSubmitted ?? 0,
    getDetail: (a) => {
      if (!a.defectDetails) return null;
      const parts: string[] = [];
      if (a.defectDetails.resolved > 0) parts.push(`${a.defectDetails.resolved} 已解决`);
      if (a.defectDetails.avgResolutionHours > 0) parts.push(`${a.defectDetails.avgResolutionHours}h 平均`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    alwaysShow: false,
    group: 'defect',
  },
  {
    key: 'collab',
    label: '协作交流',
    icon: MessageSquare,
    color: 'rgba(34, 197, 94, 0.85)',
    getValue: (a) => (a.prdSessions ?? 0) + (a.prdMessageCount ?? 0),
    getDetail: (a) => {
      const parts: string[] = [];
      if (a.prdSessions > 0) parts.push(`${a.prdSessions} 会话`);
      if (a.prdMessageCount > 0) parts.push(`${a.prdMessageCount} 消息`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    alwaysShow: true,
    group: 'collab',
  },
  {
    key: 'documents',
    label: '文档协作',
    icon: FileText,
    color: 'rgba(168, 85, 247, 0.85)',
    getValue: (a) => (a.documentEditCount ?? 0) + (a.attachmentUploadCount ?? 0),
    getDetail: (a) => {
      const parts: string[] = [];
      if (a.documentEditCount > 0) parts.push(`${a.documentEditCount} 文档`);
      if (a.attachmentUploadCount > 0) parts.push(`${a.attachmentUploadCount} 附件`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    alwaysShow: false,
    group: 'collab',
  },
  {
    key: 'ai-tools',
    label: 'AI 工具',
    icon: Brain,
    color: 'rgba(249, 115, 22, 0.85)',
    getValue: (a) => (a.llmCalls ?? 0) + (a.toolboxRunCount ?? 0),
    getDetail: (a) => {
      const parts: string[] = [];
      if (a.llmCalls > 0) parts.push(`${a.llmCalls} AI 调用`);
      if (a.toolboxRunCount > 0) parts.push(`${a.toolboxRunCount} 工具箱`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    alwaysShow: true,
    group: 'ai',
  },
  {
    key: 'visual',
    label: '视觉创作',
    icon: Image,
    color: 'rgba(236, 72, 153, 0.85)',
    getValue: (a) => (a.visualSessions ?? 0) + (a.imageGenCompletedCount ?? 0),
    getDetail: (a) => {
      const parts: string[] = [];
      if (a.visualSessions > 0) parts.push(`${a.visualSessions} 会话`);
      if (a.imageGenCompletedCount > 0) parts.push(`${a.imageGenCompletedCount} 图片`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    alwaysShow: false,
    group: 'creative',
  },
  {
    key: 'video',
    label: '视频生成',
    icon: Video,
    color: 'rgba(20, 184, 166, 0.85)',
    getValue: (a) => a.videoGenCompletedCount ?? 0,
    alwaysShow: false,
    group: 'creative',
  },
  {
    key: 'workflow',
    label: '自动化',
    icon: Workflow,
    color: 'rgba(99, 102, 241, 0.85)',
    getValue: (a) => a.workflowExecutionCount ?? 0,
    alwaysShow: false,
    group: 'ai',
  },
  {
    key: 'webpages',
    label: '网页发布',
    icon: Globe,
    color: 'rgba(14, 165, 233, 0.85)',
    getValue: (a) => a.webPagePublishCount ?? 0,
    alwaysShow: false,
    group: 'collab',
  },
];

const ENHANCE_GUIDES = [
  {
    key: 'github' as const,
    icon: Github,
    title: '绑定 GitHub',
    desc: '自动统计代码提交',
  },
  {
    key: 'workflow' as const,
    icon: Workflow,
    title: '接入 TAPD',
    desc: '自动追踪需求进度',
  },
  {
    key: 'daily-log' as const,
    icon: BookOpen,
    title: '每日记录',
    desc: '2 分钟记录每天',
  },
];

export function StatsCardPanel({ weekYear, weekNumber, showEnhanceGuide, onGuideClick, mockData }: Props) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const [activity, setActivity] = useState<CollectedActivity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // If mock data provided, use it directly
    if (mockData) {
      setActivity(mockData);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await getCollectedActivity({ weekYear, weekNumber });
      if (!cancelled && res.success && res.data) {
        setActivity(res.data);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [weekYear, weekNumber, mockData]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="h-[72px] rounded-xl animate-pulse"
            style={{ background: 'var(--bg-secondary)' }}
          />
        ))}
      </div>
    );
  }

  if (!activity) return null;

  // Filter cards: alwaysShow OR value > 0
  const visibleCards = CARD_DEFS.filter(
    (c) => c.alwaysShow || c.getValue(activity) > 0
  );

  // Check if we need enhance guide (no commits, no daily logs)
  const hasCommits = (activity.commits?.length ?? 0) > 0;
  const hasDailyLogs = (activity.dailyLogs?.length ?? 0) > 0;
  const needsGuide = showEnhanceGuide && (!hasCommits || !hasDailyLogs);

  // Determine which guides to show
  const activeGuides = ENHANCE_GUIDES.filter((g) => {
    if (g.key === 'github' && hasCommits) return false;
    if (g.key === 'daily-log' && hasDailyLogs) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {visibleCards.map((card) => {
          const value = card.getValue(activity);
          const detail = card.getDetail?.(activity);
          const Icon = card.icon;

          return (
            <div
              key={card.key}
              className="relative rounded-xl px-3.5 py-3 overflow-hidden transition-all duration-200 hover:scale-[1.02]"
              style={{
                background: 'var(--bg-secondary)',
                border: `1px solid ${card.color}20`,
              }}
            >
              {/* Color accent bar */}
              <div
                className="absolute top-0 left-0 w-full h-[2px]"
                style={{ background: card.color }}
              />
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    {card.label}
                  </div>
                  <div
                    className="text-[24px] font-bold leading-tight"
                    style={{
                      color: card.color,
                      fontFamily: isLight ? 'var(--font-serif)' : undefined,
                      letterSpacing: isLight ? '-0.02em' : undefined,
                    }}
                  >
                    {value}
                  </div>
                  {detail && (
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {detail}
                    </div>
                  )}
                </div>
                <Icon size={16} style={{ color: card.color, opacity: 0.5 }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Progressive enhance guide — 浅色下走 Claude 橙温暖邀请感 */}
      {needsGuide && activeGuides.length > 0 && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-[12px]"
          style={{
            background: isLight ? 'var(--accent-claude-soft)' : 'rgba(59, 130, 246, 0.04)',
            border: isLight ? '1px solid var(--accent-claude-border)' : '1px solid rgba(59, 130, 246, 0.08)',
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>想让周报更丰富？</span>
          <div className="flex items-center gap-2 ml-auto">
            {activeGuides.map((g) => (
              <button
                key={g.key}
                onClick={() => onGuideClick?.(g.key)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                style={{ color: isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.85)' }}
              >
                <g.icon size={12} />
                <span>{g.title}</span>
                <ChevronRight size={10} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
