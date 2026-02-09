export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';
export type InteractionMode = 'QA' | 'Knowledge' | 'PrdPreview' | 'AssetsDiag' | 'Defect';
export type MessageRole = 'User' | 'Assistant';

export interface DocCitation {
  headingTitle: string;
  headingId: string;
  excerpt: string;
  score?: number | null;
  rank?: number | null;
  documentId?: string | null;
  documentLabel?: string | null;
  verified?: boolean;
}

export interface User {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  userType?: 'Human' | 'Bot' | string;
  botKind?: 'PM' | 'DEV' | 'QA' | string;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
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
  // 运行ID：用于断线恢复/观测订阅（Run 模式）
  runId?: string;
  // 群内顺序键（用于断线续收/严格有序）
  groupSeq?: number;
  // 关联：assistant 回答哪条 user 消息（用于排错/一问多答）
  replyToMessageId?: string;
  // 关联：本条 user 消息是否为重发自旧消息（仅用于排错/溯源）
  resendOfMessageId?: string;
  // 软删除标记（用户态收到 messageUpdated 时用于移除；正常历史/回放默认不应包含 deleted）
  isDeleted?: boolean;
  // 流式输出状态：true 表示正在输出（用于隐藏加载动画）
  isStreaming?: boolean;
  // 服务端时间点（用于端到端统一与首字延迟）
  serverRequestReceivedAtUtc?: Date;
  serverStartAtUtc?: Date;
  serverFirstTokenAtUtc?: Date;
  serverDoneAtUtc?: Date;
  ttftMs?: number;
  totalMs?: number;
  // 统一的发送者信息（User 和 Assistant 都使用）
  senderId?: string;
  senderName?: string;
  senderRole?: UserRole;
  senderAvatarUrl?: string;  // 新增：发送者头像 URL
  senderTags?: GroupMemberTag[];  // 新增：发送者标签（如机器人标识）
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

export interface GroupMemberTag {
  name: string;
  role: string; // robot/pm/dev/qa/admin/...
}

export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  memberRole: UserRole;
  tags: GroupMemberTag[];
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  joinedAt: string;
  isOwner: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// ━━━ 缺陷管理类型 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export type DefectStatus = 'draft' | 'submitted' | 'assigned' | 'processing' | 'resolved' | 'rejected' | 'closed';
export type DefectSeverity = 'critical' | 'major' | 'minor' | 'trivial';

export interface DefectReport {
  id: string;
  defectNo: string;
  title?: string;
  rawContent: string;
  status: DefectStatus;
  severity?: DefectSeverity;
  reporterId: string;
  reporterName?: string;
  assigneeId?: string;
  assigneeName?: string;
  resolution?: string;
  rejectReason?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface DefectMessage {
  id: string;
  defectId: string;
  seq: number;
  role: 'user' | 'assistant';
  userId?: string;
  userName?: string;
  content: string;
  createdAt: string;
}

export interface DefectStats {
  total: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
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
