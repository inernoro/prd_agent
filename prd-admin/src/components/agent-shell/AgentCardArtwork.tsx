import visualAgentArtwork from '@/assets/agent-card-art/visual-agent.webp';
import visualStoryboardArtwork from '@/assets/agent-card-art/visual-storyboard.webp';
import literaryAgentArtwork from '@/assets/agent-card-art/literary-agent.webp';
import defectAgentArtwork from '@/assets/agent-card-art/defect-agent.webp';
import videoAgentArtwork from '@/assets/agent-card-art/video-agent.webp';
import reportAgentArtwork from '@/assets/agent-card-art/report-agent.webp';
import mdToPptAgentArtwork from '@/assets/agent-card-art/md-to-ppt-agent.webp';
import taskTreeAgentArtwork from '@/assets/agent-card-art/task-tree-agent.webp';
import speechAgentArtwork from '@/assets/agent-card-art/speech-agent.webp';
import pmAgentArtwork from '@/assets/agent-card-art/pm-agent.webp';
import productAgentArtwork from '@/assets/agent-card-art/product-agent.webp';
import paAgentArtwork from '@/assets/agent-card-art/pa-agent.webp';
import frontEndAgentArtwork from '@/assets/agent-card-art/front-end-agent.webp';
import arenaArtwork from '@/assets/agent-card-art/arena.webp';
import reviewAgentArtwork from '@/assets/agent-card-art/review-agent.webp';
import projectRouteAgentArtwork from '@/assets/agent-card-art/project-route-agent.webp';
import ccasAgentArtwork from '@/assets/agent-card-art/ccas-agent.webp';
import emailAgentArtwork from '@/assets/agent-card-art/email-agent.webp';
import shituAgentArtwork from '@/assets/agent-card-art/shitu-agent.webp';
import prReviewArtwork from '@/assets/agent-card-art/pr-review.webp';
import cdsAgentArtwork from '@/assets/agent-card-art/cds-agent.webp';
import techDocFormatAgentArtwork from '@/assets/agent-card-art/tech-doc-format-agent.webp';
import emergenceAgentArtwork from '@/assets/agent-card-art/emergence-agent.webp';

interface AgentCardPresentation {
  artwork: string;
  task: string;
}

const AGENT_CARD_PRESENTATION: Readonly<Record<string, AgentCardPresentation>> = {
  'visual-agent': { artwork: visualAgentArtwork, task: '完成视觉创作' },
  'visual-storyboard': { artwork: visualStoryboardArtwork, task: '生成视频分镜' },
  'literary-agent': { artwork: literaryAgentArtwork, task: '撰写完整文章' },
  'defect-agent': { artwork: defectAgentArtwork, task: '闭环产品缺陷' },
  'video-agent': { artwork: videoAgentArtwork, task: '生成成片视频' },
  'report-agent': { artwork: reportAgentArtwork, task: '汇总本周进展' },
  'md-to-ppt-agent': { artwork: mdToPptAgentArtwork, task: '生成演示页面' },
  'task-tree-agent': { artwork: taskTreeAgentArtwork, task: '梳理今日任务' },
  'speech-agent': { artwork: speechAgentArtwork, task: '组织上台表达' },
  'pm-agent': { artwork: pmAgentArtwork, task: '推进项目交付' },
  'product-agent': { artwork: productAgentArtwork, task: '管理产品全链' },
  'pa-agent': { artwork: paAgentArtwork, task: '拆解模糊想法' },
  'front-end-agent': { artwork: frontEndAgentArtwork, task: '完成前端交付' },
  arena: { artwork: arenaArtwork, task: '对比模型表现' },
  'review-agent': { artwork: reviewAgentArtwork, task: '评审产品方案' },
  'project-route-agent': { artwork: projectRouteAgentArtwork, task: '定位项目路径' },
  'ccas-agent': { artwork: ccasAgentArtwork, task: '生成赋码方案' },
  'email-agent': { artwork: emailAgentArtwork, task: '起草流程邮件' },
  'shitu-agent': { artwork: shituAgentArtwork, task: '解答制度问题' },
  'pr-review': { artwork: prReviewArtwork, task: '审查代码变更' },
  'cds-agent': { artwork: cdsAgentArtwork, task: '运行远程任务' },
  'tech-doc-format-agent': { artwork: techDocFormatAgentArtwork, task: '校验技术文档' },
  'emergence-agent': { artwork: emergenceAgentArtwork, task: '发现交叉价值' },
};

export function hasAgentCardArtwork(agentKey?: string): boolean {
  return !!agentKey && !!AGENT_CARD_PRESENTATION[agentKey];
}

export function getAgentCardTask(agentKey?: string): string | null {
  return agentKey ? AGENT_CARD_PRESENTATION[agentKey]?.task ?? null : null;
}

interface AgentCardArtworkProps {
  agentKey?: string;
  /** 紧凑卡片加深底部遮罩，避免更短的文字区与主体争抢。 */
  compact?: boolean;
  /** 编辑型卡片只让图片占据上部，给下方信息面板留出稳定空间。 */
  imageHeight?: string;
}

/**
 * 智能体卡片背景的统一渲染层。
 *
 * 图片只负责表达智能体职责；名称、说明、状态与操作仍由真实 HTML 渲染，
 * 保持可访问性和跨端清晰度。下半部遮罩对应图片自带柔焦区，为文字保留安静背景。
 */
export function AgentCardArtwork({ agentKey, compact = false, imageHeight }: AgentCardArtworkProps) {
  const src = agentKey ? AGENT_CARD_PRESENTATION[agentKey]?.artwork : undefined;
  if (!src) return null;

  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden rounded-[inherit] pointer-events-none"
      style={imageHeight ? { clipPath: `inset(0 0 calc(100% - ${imageHeight}) 0)` } : undefined}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-[1.015]"
      />
      <div
        className="absolute inset-0"
        style={{
          background: compact
            ? 'var(--media-card-overlay-compact)'
            : 'var(--media-card-overlay)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{ boxShadow: 'var(--media-card-inset)' }}
      />
    </div>
  );
}


export function AgentCardTask({
  agentKey,
  compact = false,
  dense = false,
}: {
  agentKey?: string;
  compact?: boolean;
  /** 高密度卡片省略重复的“任务”字样，只保留职责文本与识别线。 */
  dense?: boolean;
}) {
  const task = getAgentCardTask(agentKey);
  if (!task) return null;

  if (dense) {
    return (
      <span
        aria-label={`任务：${task}`}
        className="inline-flex shrink-0 items-center justify-end gap-1.5 whitespace-nowrap"
        style={{ color: 'var(--text-on-media)' }}
      >
        <span
          aria-hidden
          className="block h-px w-3"
          style={{ background: 'var(--media-card-task)' }}
        />
        <span className="text-[11px] font-medium leading-none">{task}</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center justify-end whitespace-nowrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
      <span
        className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-[0.14em]"
        style={{ color: 'var(--media-card-task)' }}
      >
        <span
          aria-hidden
          className="block h-px w-4"
          style={{ background: 'var(--media-card-task)' }}
        />
        任务
      </span>
      <span
        className={compact ? 'text-[12px] font-medium leading-none' : 'text-[13px] font-medium leading-none'}
        style={{ color: 'var(--text-on-media)' }}
      >
        {task}
      </span>
    </span>
  );
}
