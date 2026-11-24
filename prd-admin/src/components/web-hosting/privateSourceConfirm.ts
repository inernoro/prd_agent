import { create } from 'zustand';
import type { ApiResponse } from '@/types/api';
import type { PrivateSourceItem, PrivateSourceReport } from '@/services/real/webPages';
import { normalizeVisibility } from './shareVisibility';

/**
 * 发布前私有资料确认（2026-09-24，轨道 D0）。
 *
 * 用私有知识库生成的网页一旦发布或分享，里面的内容就对外可见了，而作者往往没意识到。
 * 服务端在「发布到已分享的站点 / 新建对外分享 / 放宽分享可见性 / 设为公开」这几个动作上
 * 强制要求确认（没带确认或确认的集合对不上就 409）；这里是前端那一半：
 *
 *   先问一次服务端「本页引用了哪些私有资料」→ 有就弹确认层 → 确认后带着指纹再发请求；
 *   服务端仍报「需要确认 / 确认已过期」（确认之后引用变了、预检没取到）→ 重新核查、重新确认一次。
 *
 * 判定与流程只放这里（不碰 React），确认层 UI 在 PrivateSourceConfirmHost，
 * 各调用点只用 runWithPrivateSourceGate 包一层，不各自拼流程。
 */

/** 服务端「对外发出前必须确认私有资料」的两个错误码（与 prd-api ErrorCodes 同名）。 */
export const PRIVATE_SOURCE_ERROR_CODES = [
  'HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED',
  'HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_STALE',
] as const;

export function isPrivateSourceConfirmationError(code: string | null | undefined): boolean {
  return !!code && (PRIVATE_SOURCE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * 改一条已有分享链接的可见性时，这次改动是不是「从只有协作者能打开，变成对外可见」。
 *
 * 只有这一种转换需要私有资料确认，与服务端 PATCH /api/web-pages/shares/{id} 的判据一致
 * （WebPagesController.UpdateShareSettings：链接当前是 owner-only，且目标是 logged-in / public）。
 * 公开改登录可见、公开原样再选一次公开、任何收紧都直接提交——否则作者点「取消」会挡住一次收紧。
 *
 * 当前可见性走 normalizeVisibility：没有可见性字段的存量链接按公开处理（后端读路径同样如此），
 * 它本来就对外可见，改档不算新的暴露。
 */
export function isWideningBeyondCollaborators(
  current: string | null | undefined,
  next: string | null | undefined,
): boolean {
  if (next !== 'logged-in' && next !== 'public') return false;
  return normalizeVisibility(current) === 'owner-only';
}

/** 确认层第一句：先说后果，再列资料。 */
export function buildPrivateSourceHeadline(count: number): string {
  return `本页引用了以下 ${count} 份私有资料，发布后任何拿到链接的人都能看到其中内容`;
}

/** 一条资料的「所属位置」：知识库名 + 服务端给的可见范围。 */
export function describePrivateSourceLocation(item: PrivateSourceItem): string {
  const store = item.storeName?.trim();
  return store ? `${store} · ${item.scopeLabel}` : item.scopeLabel;
}

export type PrivateSourceDecision = 'confirm' | 'cancel' | 'revise';

export interface PrivateSourceConfirmRequest {
  report: PrivateSourceReport;
  /** 对外发出的动作叫什么（「发布这版」「生成分享链接」「设为公开」），用在确认按钮上 */
  actionLabel: string;
  /** 是否提供「返回修改」（工作台里有意义；列表页没有可改的地方） */
  allowRevise: boolean;
  resolve: (decision: PrivateSourceDecision) => void;
}

type PrivateSourceConfirmState = {
  current: PrivateSourceConfirmRequest | null;
  /** 当前负责渲染确认层的宿主。同一时刻只认一个，避免两处都挂载时弹出两层。 */
  hostId: string | null;
  claimHost: (id: string) => void;
  releaseHost: (id: string) => void;
  open: (request: PrivateSourceConfirmRequest) => void;
  settle: (decision: PrivateSourceDecision) => void;
};

export const usePrivateSourceConfirmStore = create<PrivateSourceConfirmState>((set, get) => ({
  current: null,
  hostId: null,
  claimHost: (id) => {
    if (!get().hostId) set({ hostId: id });
  },
  releaseHost: (id) => {
    if (get().hostId === id) set({ hostId: null });
  },
  open: (request) => {
    // 同时只允许一个确认在途：上一个没答完又来一个时，把上一个按「取消」结掉，不让它的调用方悬空。
    get().current?.resolve('cancel');
    set({ current: request });
  },
  settle: (decision) => {
    const current = get().current;
    set({ current: null });
    current?.resolve(decision);
  },
}));

function fallbackConfirm(report: PrivateSourceReport, actionLabel: string): PrivateSourceDecision {
  // 没有挂载确认层宿主的页面（例如独立的分享阅读页）退回浏览器原生确认框：
  // 内容同样是「后果 + 逐条资料」，只是样式朴素。绝不静默放行，也绝不让调用方悬空等待。
  const lines = report.items.map((item) => `- ${item.title}（${describePrivateSourceLocation(item)}）`);
  const text = `${buildPrivateSourceHeadline(report.items.length)}：\n\n${lines.join('\n')}\n\n确定要${actionLabel}吗？`;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return 'cancel';
  return window.confirm(text) ? 'confirm' : 'cancel';
}

/** 弹出确认层，等作者做决定。 */
export function requestPrivateSourceConfirmation(
  report: PrivateSourceReport,
  options: { actionLabel: string; allowRevise?: boolean },
): Promise<PrivateSourceDecision> {
  const store = usePrivateSourceConfirmStore.getState();
  if (!store.hostId) return Promise.resolve(fallbackConfirm(report, options.actionLabel));
  return new Promise((resolve) => {
    store.open({
      report,
      actionLabel: options.actionLabel,
      allowRevise: options.allowRevise ?? false,
      resolve,
    });
  });
}

export type PrivateSourceGateOutcome<T> =
  | { status: 'done'; res: ApiResponse<T> }
  | { status: 'cancelled' }
  | { status: 'revise' };

export interface PrivateSourceGateOptions<T> {
  /** 问服务端「本页引用了哪些私有资料」 */
  inspect: () => Promise<ApiResponse<PrivateSourceReport>>;
  /** 真正的发布 / 分享请求；确认过就带上指纹 */
  run: (confirmedFingerprint: string | undefined) => Promise<ApiResponse<T>>;
  actionLabel: string;
  allowRevise?: boolean;
  /** 没有私有资料要确认时的原有确认（例如「设为公开」本来就会问一句）；返回 false = 取消 */
  confirmWithoutPrivateSources?: () => boolean | Promise<boolean>;
  /** 测试注入；默认弹确认层 */
  ask?: typeof requestPrivateSourceConfirmation;
}

/**
 * 包住一次「对外发出」：核查 → 必要时确认 → 带指纹执行；服务端仍要求确认时重新核查一次。
 * 没有私有资料时行为与原来完全一样（不弹层、不带指纹）。
 */
export async function runWithPrivateSourceGate<T>(
  options: PrivateSourceGateOptions<T>,
): Promise<PrivateSourceGateOutcome<T>> {
  const ask = options.ask ?? requestPrivateSourceConfirmation;
  let askedWithoutPrivate = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const inspected = await options.inspect();
    // 核查没取到（网络抖动等）就照常发请求：服务端是最终的闸，需要确认它会 409 回来，
    // 下一轮再核查一次；拿不到明细时拒绝文案本身也点名了资料。
    const report = inspected.success ? inspected.data : null;
    let fingerprint: string | undefined;
    if (report?.requiresConfirmation && report.items.length > 0) {
      const decision = await ask(report, { actionLabel: options.actionLabel, allowRevise: options.allowRevise });
      if (decision === 'cancel') return { status: 'cancelled' };
      if (decision === 'revise') return { status: 'revise' };
      fingerprint = report.fingerprint ?? undefined;
    } else if (options.confirmWithoutPrivateSources && !askedWithoutPrivate) {
      askedWithoutPrivate = true;
      if (!(await options.confirmWithoutPrivateSources())) return { status: 'cancelled' };
    }
    const res = await options.run(fingerprint);
    if (!res.success && attempt === 0 && isPrivateSourceConfirmationError(res.error?.code)) continue;
    return { status: 'done', res };
  }
  // 循环两轮都在 continue 之前 return，这里只为让类型收口。
  return { status: 'cancelled' };
}
