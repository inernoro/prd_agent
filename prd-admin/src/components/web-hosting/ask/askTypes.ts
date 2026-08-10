/**
 * 「向我提问」的前端类型与协议常量。
 *
 * SSE 事件协议（与 WebPageAskController 一一对应）：
 *   session { sessionId }        —— 服务端分配/复用的会话，续问要带回去
 *   phase   { phase, message }   —— 阶段提示，填满"等待期不能静止"
 *   model   { model, platform }  —— 当前回答用的模型，面板顶部必须展示
 *   typing  { text }             —— 增量文本
 *   done    { elapsedMs, truncated }
 *   error   { message }
 *
 * 门禁类失败（未开启 / 需登录 / 超配额 / 无正文）不走 error 事件，而是普通 JSON
 * + 真实 HTTP 状态码 —— 这样前端能区分「没资格问」和「问了但答失败」。
 */

export type AskRole = 'user' | 'assistant';

export interface AskMessage {
  id: string;
  role: AskRole;
  content: string;
  /** 仅 assistant：这条是不是还在流式输出中 */
  streaming?: boolean;
  /** 仅 assistant：失败原因 */
  error?: string;
}

/** 分享页随分享视图一起下发的提问配置（服务端已算好开场问题，前端直接渲染） */
export interface ShareAskInfo {
  siteId: string;
  enabled: boolean;
  allowAnonymous: boolean;
  welcome?: string | null;
  /** 已经过服务端两层三态取舍，前端**不要**再自己合并站点题库 */
  openingQuestions: string[];
}

/** 提问入口的数据来源：分享页走 token，站内预览走 siteId */
export type AskSource =
  | { mode: 'share'; token: string; siteId?: string; password?: string }
  | { mode: 'site'; siteId: string };

export type AskStatus = 'idle' | 'connecting' | 'answering' | 'done' | 'error';

/**
 * 单条问题的最大长度，必须与后端 WebPageAskController.MaxQuestionLength 保持一致。
 *
 * 后端超长是**拒绝**而不是截断——静默截断会让答案漏掉问题结尾的诉求，而用户看不出异常。
 * 前端在输入框同步这个上限并显示剩余字数，是为了让用户在打字时就知道边界，
 * 而不是写完一大段、点发送才吃一个 400。
 */
export const ASK_MAX_QUESTION_LENGTH = 500;

/**
 * 一条分享面板最多显示几条开场问题，必须与后端 AskOpeningQuestions.MaxDisplay 一致。
 *
 * 注意与「题库上限」区分：题库是候选池（后端 MaxLibrary，更大），分享时从中挑子集，
 * 挑的这份就是要显示的那份，所以卡的是展示上限。挑超了后端也存不下，
 * 与其让第 N+1 条静默消失，不如在选的时候就挡住。
 */
export const ASK_MAX_DISPLAY = 4;

/** 门禁失败时的错误码，前端据此给不同的引导（登录 / 稍后再来 / 换个页面） */
export const ASK_ERROR_CODES = {
  disabled: 'ASK_DISABLED',
  unauthorized: 'UNAUTHORIZED',
  quotaExceeded: 'QUOTA_EXCEEDED',
  noContent: 'ASK_NO_CONTENT',
} as const;

/**
 * 分享面板提交时，该不该带上「本条链接的开场问题」这个字段。
 *
 * 抽成函数是为了让它可被测试。这里区分的是两件容易被当成一件的事：
 *   - 用户没碰过这一栏  → 返回 undefined，字段整个不传，后端存 null，
 *                        这条链接**继承**站点题库（日后 owner 改题库会跟着变）
 *   - 用户清空了所有选项 → 返回 []，明确表示"这条链接不显示开场问题"
 *
 * 图省事写成 `picked.length ? picked : undefined` 会把第二种情况变成第一种，
 * 表现是"取消全部、保存后又原样回来"。守卫见 askSelection.test.ts。
 */
export function resolveShareAskSelection(
  touched: boolean,
  picked: string[],
): string[] | undefined {
  return touched ? picked : undefined;
}
