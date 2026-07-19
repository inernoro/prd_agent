import type { CreateLlmGatewaySsoTicketContract } from '@/services/contracts/llmGatewaySso';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';

export const createLlmGatewaySsoTicketReal: CreateLlmGatewaySsoTicketContract = () =>
  apiRequest(api.llmGateway.ssoTicket(), { method: 'POST', body: {} });
