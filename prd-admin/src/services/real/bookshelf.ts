/**
 * 公共藏书阁 —— 个人进度与团队看板的服务端接口。
 *
 * 契约要点（对照 apiClient.ts 的 apiRequest 签名，别凭记忆写）：
 *  - body 传原始对象，apiRequest 内部会 JSON.stringify，调用方再 stringify 就双重序列化，后端 400
 *  - 返回是 ApiResponse<T> = { success, data, error }，判断用 res.success 不是 res.ok
 *  - 错误是对象，取 res.error?.message，不是字符串
 */
import { apiRequest } from './apiClient';
// connectSse 住在 lib/useSseStream（它同时导出 hook 与这个低层函数）——
// service 层要的是「连上、逐条给我事件」，不需要 hook 的那套 React 状态。
import { connectSse } from '@/lib/useSseStream';

export interface ServerExamResult {
  volumeId: string;
  correct: number;
  total: number;
  passed: boolean;
  /** 交卷时该卷已读 / 总本数。旧记录没有这两个字段，前端按零本（裸考）处理 */
  readAtExam?: number;
  totalAtExam?: number;
  takenAt: string;
}

export interface BookshelfProgressDto {
  readBookIds: string[];
  /** 书 id → 一句话心得。旧记录没有这个字段 */
  bookNotes?: Record<string, string>;
  examResults: Record<string, ServerExamResult>;
  updatedAt: string | null;
}

export interface TeamMemberRow {
  userId: string;
  /** 查不到用户时后端返回 null，前端显示「未知成员」，不编造名字 */
  displayName: string | null;
  readCount: number;
  /** 写下过几条心得 —— 比「已读 N 本」更能说明真读过。旧后端不返回这个字段 */
  noteCount?: number;
  passedCount: number;
  passedVolumeIds: string[];
  updatedAt: string;
}

export interface BookshelfTeamDto {
  members: TeamMemberRow[];
  memberCount: number;
  /** 卷 id → 通关人数（读过 + 通过）。看板真正的用处：一眼看出全队哪一卷最薄弱 */
  passedByVolume: Record<string, number>;
  /** 卷 id → 裸考通过人数（一本没读就考过）。单独计，不混进上面那个数 */
  blindPassedByVolume?: Record<string, number>;
}

export function getMyBookshelfProgress() {
  return apiRequest<BookshelfProgressDto>('/api/bookshelf/progress');
}

export function saveMyBookshelfProgress(payload: {
  readBookIds: string[];
  bookNotes: Record<string, string>;
  examResults: Record<string, {
    correct: number; total: number; passed: boolean;
    readAtExam: number; totalAtExam: number;
  }>;
}) {
  return apiRequest<BookshelfProgressDto>('/api/bookshelf/progress', {
    method: 'PUT',
    body: payload,
  });
}

export function getBookshelfTeamBoard() {
  return apiRequest<BookshelfTeamDto>('/api/bookshelf/team');
}

/**
 * 一本书的精读稿。
 *
 * 这是藏书阁里唯一「系统产出」的内容 —— 在它之前整个页面只有静态书单加两个
 * 让用户自己填的格子。稿子是公共的：一本一篇，第一个点进来的人触发生成，
 * 之后所有人读同一篇。
 */
export interface BookDigestDto {
  exists: boolean;
  content?: string;
  model?: string | null;
  platform?: string | null;
  /** 这一稿引用了哪几条团队规则（`.claude/rules/` 文件名），前端渲染成延伸阅读 */
  citedRules?: string[];
  generatedAt?: string;
  /** 提示词升版后存量稿子会是 true —— 提示「这篇是旧版写法，可以重生成」 */
  stale?: boolean;
}

export function getBookDigest(bookId: string) {
  return apiRequest<BookDigestDto>(`/api/bookshelf/books/${encodeURIComponent(bookId)}/digest`);
}

/** 精读稿生成过程中推的事件 */
export type BookDigestStreamEvent =
  /** 库里已有，一次性吐回 */
  | { type: 'cached'; content: string; model?: string | null; platform?: string | null; citedRules?: string[] }
  /** 开始生成，带出实际用的模型（`ai-model-visibility`） */
  | { type: 'start'; model?: string | null; platform?: string | null }
  /** 增量正文 */
  | { type: 'text'; content: string }
  | { type: 'done'; reused: boolean; citedRules?: string[] }
  | { type: 'error'; code: string; message: string };

/**
 * 流式生成精读稿。
 *
 * 走 SSE 而不是等生成完一次性返回：一篇一两千字，等完再给就是几十秒白屏
 * （规则 #6：静止的「加载中」超过 2 秒即为体验缺陷）。
 *
 * `force` 是「重新生成」那个按钮走的路径；不带它时后端有稿子就直接吐缓存，
 * 不会重复烧一次生成。
 */
export async function streamBookDigest(args: {
  bookId: string;
  force?: boolean;
  signal: AbortSignal;
  onEvent: (evt: BookDigestStreamEvent) => void;
}) {
  const { bookId, force, signal, onEvent } = args;
  const qs = force ? '?force=true' : '';
  return connectSse({
    url: `/api/bookshelf/books/${encodeURIComponent(bookId)}/digest/stream${qs}`,
    signal,
    onEvent: (evt) => {
      if (!evt.data) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(evt.data) as Record<string, unknown>;
      } catch {
        // 解析不了就丢掉这一条。SSE 里混进半行是常态（网络切片），
        // 不该让一条坏数据把整篇稿子中断。
        return;
      }
      const name = evt.event ?? '';
      if (name === 'cached') {
        onEvent({
          type: 'cached',
          content: String(payload.content ?? ''),
          model: (payload.model as string | null | undefined) ?? null,
          platform: (payload.platform as string | null | undefined) ?? null,
          citedRules: (payload.citedRules as string[] | undefined) ?? [],
        });
      } else if (name === 'start') {
        onEvent({
          type: 'start',
          model: (payload.model as string | null | undefined) ?? null,
          platform: (payload.platform as string | null | undefined) ?? null,
        });
      } else if (name === 'text') {
        onEvent({ type: 'text', content: String(payload.content ?? '') });
      } else if (name === 'done') {
        onEvent({
          type: 'done',
          reused: Boolean(payload.reused),
          citedRules: (payload.citedRules as string[] | undefined) ?? [],
        });
      } else if (name === 'error') {
        onEvent({
          type: 'error',
          code: String(payload.code ?? 'UNKNOWN'),
          message: String(payload.message ?? '生成失败'),
        });
      }
    },
  });
}
