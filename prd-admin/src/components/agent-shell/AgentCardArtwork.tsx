import type { CSSProperties } from 'react';

interface AgentCardPresentation {
  task: string;
}

const AGENT_CARD_PRESENTATION: Readonly<Record<string, AgentCardPresentation>> = {
  'visual-agent': { task: '完成视觉创作' },
  'visual-storyboard': { task: '生成视频分镜' },
  'literary-agent': { task: '撰写完整文章' },
  'defect-agent': { task: '闭环产品缺陷' },
  'video-agent': { task: '生成成片视频' },
  'report-agent': { task: '汇总本周进展' },
  'md-to-ppt-agent': { task: '生成演示页面' },
  'task-tree-agent': { task: '梳理今日任务' },
  'speech-agent': { task: '组织上台表达' },
  'pm-agent': { task: '推进项目交付' },
  'product-agent': { task: '管理产品全链' },
  'pa-agent': { task: '拆解模糊想法' },
  'front-end-agent': { task: '完成前端交付' },
  arena: { task: '对比模型表现' },
  'review-agent': { task: '评审产品方案' },
  'project-route-agent': { task: '定位项目路径' },
  'ccas-agent': { task: '生成赋码方案' },
  'email-agent': { task: '起草流程邮件' },
  'shitu-agent': { task: '解答制度问题' },
  'pr-review': { task: '审查代码变更' },
  'cds-agent': { task: '运行远程任务' },
  'tech-doc-format-agent': { task: '校验技术文档' },
  'emergence-agent': { task: '发现交叉价值' },
  'tapd-bug-agent': { task: '规范提交缺陷' },
  'marketplace-openapi': { task: '授权技能接口' },
  'shortcuts-agent': { task: '执行快捷操作' },
  'my-shares': { task: '统管分享链接' },
  'learning-center': { task: '推进学习进度' },
  'share-link-tester': { task: '校验分享链路' },
  'transcript-agent': { task: '编辑音频转录' },
  'short-video-parser': { task: '拆解短视频素材' },
  'code-reviewer': { task: '审查代码质量' },
  translator: { task: '完成多语言翻译' },
  summarizer: { task: '提炼长文要点' },
  'data-analyst': { task: '解析数据洞察' },
};

export function hasAgentCardArtwork(agentKey?: string): boolean {
  return !!agentKey && !!AGENT_CARD_PRESENTATION[agentKey];
}

export function getAgentCardTask(agentKey?: string): string | null {
  return agentKey ? AGENT_CARD_PRESENTATION[agentKey]?.task ?? null : null;
}

export function getAgentCardArtworkToken(agentKey?: string): string | null {
  return agentKey && AGENT_CARD_PRESENTATION[agentKey]
    ? `--agent-card-artwork-${agentKey}`
    : null;
}

interface AgentCardArtworkProps {
  agentKey?: string;
  /** 紧凑卡片加深底部遮罩，避免更短的文字区与主体争抢。 */
  compact?: boolean;
  /** 编辑型卡片只让图片占据上部，给下方信息面板留出稳定空间。 */
  imageHeight?: string;
  /** 首页按智能体类别注入的轻量色彩提示，不承担主题转换。 */
  tint?: string;
}

/**
 * 智能体卡片背景的统一渲染层。
 *
 * 图片只负责表达智能体职责；名称、说明、状态与操作仍由真实 HTML 渲染，
 * 保持可访问性和跨端清晰度。下半部遮罩对应图片自带柔焦区，为文字保留安静背景。
 */
export function AgentCardArtwork({ agentKey, compact = false, imageHeight, tint }: AgentCardArtworkProps) {
  const artworkToken = getAgentCardArtworkToken(agentKey);
  if (!artworkToken) return null;

  return (
    <div
      aria-hidden
      className="agent-card-artwork absolute inset-0 pointer-events-none"
      data-compact={compact ? 'true' : 'false'}
      style={imageHeight ? { clipPath: `inset(0 0 calc(100% - ${imageHeight}) 0)` } : undefined}
    >
      <div
        className="agent-card-artwork-image absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `var(${artworkToken})` }}
      />
      {tint && (
        <div
          className="agent-card-artwork-tint absolute inset-0"
          style={{ '--agent-card-tint': tint } as CSSProperties}
        />
      )}
      <div className="agent-card-artwork-wash absolute inset-0" />
      <div className="agent-card-artwork-overlay absolute inset-0" />
      <div
        className="absolute inset-0"
        style={{ boxShadow: 'var(--media-card-inset)' }}
      />
    </div>
  );
}

/**
 * 大图卡片共用的边缘层。
 *
 * 基础描边与悬浮描边都在同一个最上层边界内绘制，避免父级真实 border、
 * 图片圆角和悬浮 box-shadow 在页面缩放后落到不同亚像素，形成单边漏光。
 */
export function AgentCardFrame({ hoverBorder }: { hoverBorder: string }) {
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 z-20 rounded-[inherit] pointer-events-none"
        style={{ boxShadow: 'inset 0 0 0 1px var(--media-card-border)' }}
      />
      <div
        aria-hidden
        className="absolute inset-0 z-20 rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${hoverBorder}` }}
      />
    </>
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
        style={{ color: 'var(--text-on-media-muted)' }}
      >
        <span
          aria-hidden
          className="block h-px w-3"
          style={{ background: 'var(--media-card-task-muted)' }}
        />
        <span className="text-[11px] font-medium leading-none">{task}</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center justify-end whitespace-nowrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
      <span
        className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-[0.14em]"
        style={{ color: 'var(--media-card-task-muted)' }}
      >
        <span
          aria-hidden
          className="block h-px w-4"
          style={{ background: 'var(--media-card-task-muted)' }}
        />
        任务
      </span>
      <span
        className={compact ? 'text-[12px] font-medium leading-none' : 'text-[13px] font-medium leading-none'}
        style={{ color: 'var(--text-on-media-muted)' }}
      >
        {task}
      </span>
    </span>
  );
}
