import type { ApiResponse } from '@/types/api';

export type LlmGatewaySsoTicket = {
  code: string;
  expiresAt: string;
};

export type CreateLlmGatewaySsoTicketContract = () => Promise<ApiResponse<LlmGatewaySsoTicket>>;
