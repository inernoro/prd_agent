import type { ApiResponse } from '@/types/api';
import type { LlmGatewayConsoleTarget } from '@/lib/llmGatewaySso';

export type LlmGatewaySsoTicket = {
  code: string;
  expiresAt: string;
  /**
   * 这张票据该送去哪个控制台，由服务端按平台注入的已发布入口表回答。
   * 老服务端不返回该字段时为 undefined —— 等同「同源部署」，正是正式环境的行为。
   */
  console?: LlmGatewayConsoleTarget;
};

export type CreateLlmGatewaySsoTicketContract = () => Promise<ApiResponse<LlmGatewaySsoTicket>>;
