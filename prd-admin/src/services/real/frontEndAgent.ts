export const FRONT_END_AGENT_STREAM_URL = '/api/front-end-agent/assist/stream';

export type FrontEndAgentTaskType = 'api-adapter' | 'component' | 'debug' | 'visual-diagnosis';

export interface FrontEndAgentRequest {
  taskType: FrontEndAgentTaskType;
  requirement: string;
  apiSpec?: string;
  existingCode?: string;
  errorLog?: string;
  screenshotNotes?: string;
  /** data:image/...;base64,... 格式，视觉诊断任务可随请求发送 */
  screenshotImages?: string[];
  targetFramework?: string;
  styleGuidance?: string;
}

