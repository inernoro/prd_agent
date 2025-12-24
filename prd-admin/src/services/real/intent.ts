import { apiRequest } from '@/services/real/apiClient';
import type { SuggestGroupNameContract } from '@/services/contracts/intent';

export const suggestGroupNameReal: SuggestGroupNameContract = async ({ fileName, snippet }) => {
  return await apiRequest('/api/v1/intent/group-name', {
    method: 'POST',
    body: {
      fileName: fileName ?? null,
      snippet,
    },
  });
};


