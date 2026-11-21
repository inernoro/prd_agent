import { invoke } from '@tauri-apps/api/core';

export interface SelectedUploadFile { selectionId: string; name: string }
export function selectUploadFiles(purpose: 'attachment' | 'document', multiple = true, sessionId?: string) {
  return invoke<SelectedUploadFile[]>('select_upload_files', { purpose, multiple, sessionId: sessionId ?? null });
}
