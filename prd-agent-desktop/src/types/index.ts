export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';
export type InteractionMode = 'QA' | 'Guided';
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

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  viewRole?: UserRole;
  timestamp: Date;
  senderId?: string;
  senderName?: string;
}

export interface Group {
  groupId: string;
  groupName: string;
  prdTitle?: string;
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
  type: 'start' | 'delta' | 'done' | 'error';
  messageId?: string;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface GuideEvent {
  type: 'step' | 'delta' | 'stepDone' | 'error';
  step?: number;
  totalSteps?: number;
  title?: string;
  content?: string;
}

