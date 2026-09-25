import { buildDesignArtifactLaunchPath } from '@/lib/designArtifactLaunch';

/**
 * 生成工作台的「产出形式」：同一份资料，做成网页，或做成一套网页 PPT（幻灯片）。
 *
 * 为什么「网页 PPT」是交接而不是在工作台里就地生成：统一的设计任务入口
 * （POST /api/design-artifacts/runs）只接受 artifactType=web-page，并明确回绝 html-ppt；
 * 幻灯片走的是 HTML PPT 智能体自己那条链路——先流式出大纲、用户确认后逐页生成、
 * 用户点发布后才进网页托管（服务端识别为幻灯片，IsSlideDeck）。把那条多阶段链路搬进
 * 设计任务 Worker 等于重写一遍 PPT 生成器，所以这里只负责把资料和要求原样交过去。
 */
export type WorkbenchOutputForm = 'web-page' | 'html-ppt';

export interface OutputFormCopy {
  label: string;
  /** 分段控件的悬浮说明。 */
  title: string;
}

export const OUTPUT_FORM_REGISTRY: Record<WorkbenchOutputForm, OutputFormCopy> = {
  'web-page': {
    label: '网页',
    title: '做成一个可滚动阅读的网页，在这里直接生成',
  },
  'html-ppt': {
    label: '网页 PPT',
    title: '做成一套可翻页的幻灯片，带着资料去 HTML PPT 智能体生成',
  },
};

export const OUTPUT_FORM_ORDER: readonly WorkbenchOutputForm[] = ['web-page', 'html-ppt'];

/**
 * 网页 PPT 的耗时说明。PPT 这条链路没有和网页生成共用的耗时统计，这里不照搬网页的
 * 「约 1 分钟 / 9–12 分钟」，只给经验值，并说清以 PPT 智能体里的实时进度为准。
 */
export const HTML_PPT_TIMING_NOTE =
  '经验值约几分钟：先出大纲（边写边显示），你确认后再逐页生成；这条链路还没有耗时统计，以 PPT 智能体里的实时进度为准。';

export interface HandoffKnowledge {
  entryId: string;
  storeId: string;
  title: string;
  storeName?: string;
}

export type HtmlPptHandoff =
  | { ok: false; blocker: string }
  | {
    ok: true;
    path: string;
    /** 会被带过去的那篇稿子。 */
    carriedTitle: string;
    /** 带不过去、需要在 PPT 智能体里重新放一次的资料（给用户看的名字）。 */
    leftBehind: string[];
  };

/**
 * 把工作台里放好的资料与要求折成一次去 HTML PPT 智能体的跳转。
 *
 * 跳转契约（designArtifactLaunch）一次只带一篇知识库稿子；多出来的稿子与上传的文件
 * 不静默丢弃，而是逐个列出来，让用户在那边再放一次。
 */
export function buildHtmlPptHandoff(input: {
  instruction: string;
  knowledge: readonly HandoffKnowledge[];
  uploadedFileNames: readonly string[];
}): HtmlPptHandoff {
  const [first, ...rest] = input.knowledge;
  if (!first) {
    return {
      ok: false,
      blocker: input.uploadedFileNames.length > 0
        ? '网页 PPT 需要从知识库带一篇稿子过去；上传的文件请到 PPT 智能体里直接上传'
        : '先点左下角的 + 从知识库放一篇稿子，网页 PPT 会带着它过去',
    };
  }
  return {
    ok: true,
    path: buildDesignArtifactLaunchPath({
      target: 'html-ppt',
      sourceStoreId: first.storeId,
      sourceEntryId: first.entryId,
      sourceTitle: first.title,
      sourceStoreName: first.storeName,
      request: input.instruction,
    }),
    carriedTitle: first.title,
    leftBehind: [...rest.map((entry) => entry.title), ...input.uploadedFileNames],
  };
}
