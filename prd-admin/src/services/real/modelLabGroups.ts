import type { DeleteModelLabGroupContract, ListModelLabGroupsContract, UpsertModelLabGroupContract } from '@/services/contracts/modelLabGroups';
import type { ModelLabGroup } from '@/services/contracts/modelLabGroups';
import { apiRequest } from '@/services/real/apiClient';

export const listModelLabGroupsReal: ListModelLabGroupsContract = async (args) => {
  const sp = new URLSearchParams();
  if (args?.search) sp.set('search', args.search);
  if (typeof args?.limit === 'number') sp.set('limit', String(args.limit));
  const qs = sp.toString();
  return await apiRequest<{ items: ModelLabGroup[] }>(`/api/lab/model/lab-groups${qs ? `?${qs}` : ''}`);
};

export const upsertModelLabGroupReal: UpsertModelLabGroupContract = async (input) => {
  return await apiRequest<ModelLabGroup>('/api/lab/model/lab-groups', {
    method: 'POST',
    body: { id: input.id, name: input.name, models: input.models },
  });
};

export const deleteModelLabGroupReal: DeleteModelLabGroupContract = async (id) => {
  return await apiRequest<true>(`/api/lab/model/lab-groups/${encodeURIComponent(id)}`, { method: 'DELETE', emptyResponseData: true });
};


