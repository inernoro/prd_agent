import type { ModelReferenceState } from './modelReferences';

export interface ArenaSlot extends ModelReferenceState {
  id: string;
  displayName: string;
  platformId: string;
  modelId: string;
  group: string;
  sortOrder: number;
  enabled: boolean;
}

export interface ArenaGroup {
  id: string;
  key: string;
  name: string;
  description?: string;
  sortOrder?: number;
  slots: ArenaSlot[];
}

export interface SaveArenaSlotInput {
  displayName?: string;
  logicalModelId?: string;
  group?: string;
  sortOrder?: number;
  enabled?: boolean;
}
