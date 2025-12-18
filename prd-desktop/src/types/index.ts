export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';
export type InteractionMode = 'QA' | 'Guided' | 'Knowledge' | 'PrdPreview';
export type MessageRole = 'User' | 'Assistant';

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
  guideStep?: number;
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
  viewRole?: UserRole;
  timestamp: Date;
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
  type: 'start' | 'delta' | 'done' | 'error' | 'blockStart' | 'blockDelta' | 'blockEnd' | 'phase';
  messageId?: string;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
  blockId?: string;
  blockKind?: MessageBlockKind;
  blockLanguage?: string;
  phase?: string;
}

export interface GuideEvent {
  type: 'step' | 'delta' | 'stepDone' | 'error' | 'blockStart' | 'blockDelta' | 'blockEnd' | 'phase';
  step?: number;
  totalSteps?: number;
  title?: string;
  content?: string;
  blockId?: string;
  blockKind?: MessageBlockKind;
  blockLanguage?: string;
  phase?: string;
}
