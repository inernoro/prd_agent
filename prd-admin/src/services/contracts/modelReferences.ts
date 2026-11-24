/** 应用授权的逻辑模型目录；前端不按供应商型号猜测替代关系。 */
export interface LogicalModelOption {
  logicalModelId: string;
  publicId: string;
  name: string;
  available: boolean;
  reason?: string | null;
}

export type ModelReferenceStatus = 'available' | 'unavailable' | 'legacy' | 'unknown';

export interface ModelReferenceState {
  logicalModelId?: string | null;
  modelReferenceStatus?: ModelReferenceStatus;
  modelReferenceReason?: string | null;
}

export type ModelLabPurpose = 'chat' | 'image' | 'image-batch';
