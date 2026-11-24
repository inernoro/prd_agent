import {
  buildDesignArtifactLaunchPath,
  DESIGN_ARTIFACT_TARGETS,
  type DesignArtifactTarget,
} from '@/lib/designArtifactLaunch';

/**
 * 「用这份内容生成」的来源：一条知识库条目。
 *
 * 录音转录也是知识库条目（转录稿写回音频条目，或旧数据里一条独立笔记），
 * 所以同一份契约能带它——入口只负责把「哪一条」交出去，正文由服务端按条目重新读取，
 * 客户端从不携带正文。
 */
export interface GenerateContentSource {
  storeId: string;
  entryId: string;
  title: string;
  storeName?: string;
}

export interface DesignLaunchAgent {
  target: DesignArtifactTarget;
  title: string;
  description: string;
}

const AGENT_COPY: Record<DesignArtifactTarget, Omit<DesignLaunchAgent, 'target'>> = {
  'web-page': {
    title: '网页设计智能体',
    description: '补充两句话，生成并保存为可继续微调的托管网页。',
  },
  'html-ppt': {
    title: 'HTML PPT 智能体',
    description: '进入大纲、主题、生成和发布工作台，输出可翻页网页。',
  },
};

/** 弹窗里可选的智能体，顺序即展示顺序；从目标清单派生，新增目标忘了写文案会编译失败。 */
export const DESIGN_LAUNCH_AGENTS: DesignLaunchAgent[] = DESIGN_ARTIFACT_TARGETS.map((target) => ({
  target,
  ...AGENT_COPY[target],
}));

/**
 * 条目的正文到底在哪一条上：音视频条目的正文是转录稿，`metadata.transcribe_entry_id`
 * 指向它（新数据指向自身，旧数据指向一条独立笔记）；其余条目就是自身。
 * 与阅读器（DocBrowser 的 audioNoteId）读同一个字段，不另起一套取法。
 */
export function contentSourceEntryId(entry: {
  id: string;
  contentType?: string;
  metadata?: Record<string, string> | null;
}): string {
  const type = (entry.contentType ?? '').toLowerCase();
  const isMedia = type.startsWith('audio/') || type.startsWith('video/');
  const noteId = entry.metadata?.transcribe_entry_id?.trim();
  return isMedia && noteId ? noteId : entry.id;
}

/** 入口唯一的跳转路径构造：所有「生成」入口都经这里，路由守卫只需核对这一处。 */
export function buildGenerateLaunchPath(target: DesignArtifactTarget, source: GenerateContentSource): string {
  return buildDesignArtifactLaunchPath({
    target,
    sourceStoreId: source.storeId,
    sourceEntryId: source.entryId,
    sourceTitle: source.title,
    sourceStoreName: source.storeName,
  });
}
