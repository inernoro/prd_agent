import type { ApiResponse } from '@/types/api';

export type SuggestGroupNameResponse = { name: string };

export type SuggestGroupNameContract = (input: { fileName?: string | null; snippet: string }) => Promise<ApiResponse<SuggestGroupNameResponse>>;


