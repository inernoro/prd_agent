export const FRONT_END_AGENT_STREAM_URL = '/api/front-end-agent/assist/stream';

export type FrontEndAgentTaskType = 'api-adapter' | 'component' | 'debug' | 'visual-diagnosis';

export interface FrontEndAgentRequest {
  taskType: FrontEndAgentTaskType;
  requirement: string;
  apiSpec?: string;
  existingCode?: string;
  errorLog?: string;
  screenshotNotes?: string;
  targetFramework?: string;
  styleGuidance?: string;
}

