import {
  consumeLaunchRequest,
  readLaunchRequest,
  type DesignArtifactLaunchContext,
} from '@/lib/designArtifactLaunch';
import type { MdToPptPublishRequest } from '@/services/real/mdToPptService';

/**
 * 从网页工作台「网页 PPT」交接过来的那部分状态，全部在这里判，页面只调用：
 * 要求草稿何时预填、何时算用掉、读不到时要不要提示；发布落到哪个空间。
 */

export interface LaunchDraftState {
  /** 输入框初值。只预填，不自动发送。 */
  input: string;
  /** request-lost：带着交接编号来、却读不到草稿（换了标签页、隐私模式、存储被禁），要明说。 */
  notice: 'request-lost' | null;
}

/**
 * 页面挂载（含刷新、返回）时恢复要求草稿。只读不删：用户真正发出去之前，
 * 刷新多少次都应该还在；和知识是否已经带入（launchImported）无关。
 */
export function resolveLaunchDraft(
  launch: DesignArtifactLaunchContext | null,
  storage: Pick<Storage, 'getItem'> | null,
): LaunchDraftState {
  if (!launch?.handoffId) return { input: '', notice: null };
  const draft = readLaunchRequest(launch.handoffId, storage);
  if (draft.status === 'ready') return { input: draft.text, notice: null };
  if (draft.status === 'consumed') return { input: '', notice: null };
  return { input: '', notice: 'request-lost' };
}

/** 发送通过拦截之后调用：这时草稿才算用掉，之后刷新不再回填，也不误报「没带过来」。 */
export function markLaunchDraftSent(
  launch: DesignArtifactLaunchContext | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  if (launch?.handoffId) consumeLaunchRequest(launch.handoffId, storage);
}

/** 发布请求体：从团队空间发起的交接，发布时带上同一个团队，否则落回个人空间。 */
export function buildPptPublishRequest(input: {
  htmlContent: string;
  title: string;
  runId: string;
  destinationTeamId?: string | null;
}): MdToPptPublishRequest {
  return {
    htmlContent: input.htmlContent,
    title: input.title,
    runId: input.runId,
    ...(input.destinationTeamId ? { teamIds: [input.destinationTeamId] } : {}),
  };
}

/** 发布前给用户看的落点。团队名拿不到时退回编号，不许让用户猜会落在哪。 */
export function publishDestinationLabel(destinationTeamId: string | undefined, teamName?: string | null): string | null {
  if (!destinationTeamId) return null;
  const name = teamName?.trim();
  return name ? `发布到：${name} 空间` : `发布到：团队空间（编号 ${destinationTeamId.slice(0, 8)}）`;
}
