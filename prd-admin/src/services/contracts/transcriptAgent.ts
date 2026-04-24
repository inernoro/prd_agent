export interface TranscriptWorkspace {
  id: string;
  title: string;
  ownerUserId: string;
  memberUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptItem {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
  duration?: number;
  segments?: TranscriptSegment[];
  transcribeStatus: 'pending' | 'processing' | 'completed' | 'failed';
  transcribeError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptRun {
  id: string;
  itemId: string;
  workspaceId: string;
  type: 'asr' | 'copywrite';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  templateId?: string;
  result?: string;
  error?: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  isSystem: boolean;
  ownerUserId?: string;
}
