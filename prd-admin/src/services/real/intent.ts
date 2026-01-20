import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { SuggestGroupNameContract } from '@/services/contracts/intent';

export const suggestGroupNameReal: SuggestGroupNameContract = async ({ fileName, snippet }) => {
  return await apiRequest(api.v1.intent.groupName(), {
    method: 'POST',
    body: {
      fileName: fileName ?? null,
      snippet,
    },
  });
};


