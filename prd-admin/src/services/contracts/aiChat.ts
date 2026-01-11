import type { ApiResponse } from '@/types/api';

export type AiChatDocumentInfo = {
  id: string;
  title: string;
  charCount: number;
  tokenEstimate: number;
};

export type AiChatUploadDocumentResponse = {
  sessionId: string;
  document: AiChatDocumentInfo;
};

export type AiChatUploadDocumentContract = (input: { content: string; title?: string | null }) => Promise<ApiResponse<AiChatUploadDocumentResponse>>;

export type AiChatTokenUsage = {
  input?: number | null;
  output?: number | null;
};

export type AiChatHistoryMessage = {
  id: string;
  groupSeq?: number | null;
  role: 'User' | 'Assistant';
  content: string;
  replyToMessageId?: string | null;
  resendOfMessageId?: string | null;
  viewRole?: string | null;
  timestamp: string;
  tokenUsage?: AiChatTokenUsage | null;
};

export type AiChatGetHistoryContract = (input: { sessionId: string; limit?: number }) => Promise<ApiResponse<AiChatHistoryMessage[]>>;

export type AiChatDocCitation = {
  headingId?: string | null;
  headingTitle?: string | null;
  excerpt?: string | null;
};

export type AiChatStreamEvent = {
  type: string; // start, blockStart, blockDelta, blockEnd, delta, citations, done, error
  messageId?: string | null;
  content?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  blockId?: string | null;
  blockKind?: string | null;
  blockLanguage?: string | null;
  citations?: AiChatDocCitation[] | null;
};


