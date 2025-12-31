export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';
export type InteractionMode = 'QA' | 'Knowledge' | 'PrdPreview';
export type MessageRole = 'User' | 'Assistant';

export interface DocCitation {
  headingTitle: string;
  headingId: string;
  excerpt: string;
  score?: number | null;
  rank?: number | null;
}

export interface User {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface Session {
  sessionId: string;
  groupId?: string;
  documentId: string;
  currentRole: UserRole;
  mode: InteractionMode;
}

export interface PromptItem {
  promptKey: string;
  order: number;
  role: UserRole; // PM/DEV/QA
  title: string;
}

export interface PromptsClientResponse {
  updatedAt: string;
  prompts: PromptItem[];
}

export interface Document {
  id: string;
  title: string;
  charCount: number;
  tokenEstimate: number;
}

export interface DocumentContent {
  id: string;
  title: string;
  content: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  blocks?: MessageBlock[];
  citations?: DocCitation[];
  viewRole?: UserRole;
  timestamp: Date;
  // 群内顺序键（用于断线续收/严格有序）
  groupSeq?: number;
  // 服务端时间点（用于端到端统一与首字延迟）
  serverRequestReceivedAtUtc?: Date;
  serverStartAtUtc?: Date;
  serverFirstTokenAtUtc?: Date;
  serverDoneAtUtc?: Date;
  ttftMs?: number;
  totalMs?: number;
  senderId?: string;
  senderName?: string;
}

export type MessageBlockKind = 'paragraph' | 'heading' | 'listItem' | 'codeBlock';

export interface MessageBlock {
  id: string;
  kind: MessageBlockKind;
  content: string; // markdown/纯文本内容（codeBlock 为纯文本）
  language?: string | null; // codeBlock 可选
  isComplete?: boolean;
}

export interface Group {
  groupId: string;
  groupName: string;
  prdDocumentId?: string | null;
  prdTitle?: string;
  inviteLink?: string;
  inviteCode: string;
  memberCount: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface StreamEvent {
  type: 'start' | 'delta' | 'done' | 'error' | 'blockStart' | 'blockDelta' | 'blockEnd' | 'phase' | 'citations';
  messageId?: string;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
  // 服务端时间点（ISO 字符串，UTC）
  requestReceivedAtUtc?: string;
  startAtUtc?: string;
  firstTokenAtUtc?: string;
  doneAtUtc?: string;
  ttftMs?: number;
  blockId?: string;
  blockKind?: MessageBlockKind;
  blockLanguage?: string;
  phase?: string;
  citations?: DocCitation[];
}
