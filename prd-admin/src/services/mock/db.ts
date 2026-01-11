import type { AdminUser, LLMConfig, Model, Platform, UserRole, UserStatus } from '@/types/admin';

function nowISO() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const roles: UserRole[] = ['PM', 'DEV', 'QA', 'ADMIN'];
const statuses: UserStatus[] = ['Active', 'Disabled'];

export const db = {
  users: Array.from({ length: 67 }).map((_, idx): AdminUser => {
    const role = idx === 0 ? 'ADMIN' : pick(roles);
    const status = idx === 0 ? 'Active' : pick(statuses);
    return {
      userId: `u_${idx + 1}`,
      username: idx === 0 ? 'admin' : `user${idx + 1}`,
      displayName: idx === 0 ? 'Admin' : `用户 ${idx + 1}`,
      role,
      status,
      createdAt: nowISO(),
      lastLoginAt: idx % 4 === 0 ? nowISO() : undefined,
      lastActiveAt: idx % 3 === 0 ? nowISO() : undefined,
      // mock：每 9 个用户里随机模拟一个“锁定中”
      lockoutRemainingSeconds: idx % 9 === 0 ? 600 : 0,
      isLocked: idx % 9 === 0,
    };
  }),
  platforms: [
    { id: 'p_openai', name: 'OpenAI', platformType: 'openai', apiUrl: 'https://api.openai.com', apiKeyMasked: 'sk-****************', enabled: true },
    { id: 'p_anthropic', name: 'Anthropic', platformType: 'anthropic', apiUrl: 'https://api.anthropic.com', apiKeyMasked: 'sk-****************', enabled: true },
    { id: 'p_qwen', name: '通义千问', platformType: 'qwen', apiUrl: 'https://dashscope.aliyuncs.com', apiKeyMasked: 'sk-****************', enabled: false },
  ] as Platform[],
  models: [
    { id: 'm_1', name: 'GPT-4o', modelName: 'gpt-4o', platformId: 'p_openai', enabled: true, isMain: true, isIntent: false, isVision: false, isImageGen: false, group: 'openai-gpt', enablePromptCache: true },
    { id: 'm_2', name: 'GPT-4o mini', modelName: 'gpt-4o-mini', platformId: 'p_openai', enabled: true, isMain: false, isIntent: true, isVision: false, isImageGen: false, group: 'openai-gpt', enablePromptCache: true },
    { id: 'm_3', name: 'Claude 3.5 Sonnet', modelName: 'claude-3-5-sonnet-20241022', platformId: 'p_anthropic', enabled: true, isMain: false, isIntent: false, isVision: false, isImageGen: false, group: 'anthropic-claude', enablePromptCache: true },
    { id: 'm_4', name: 'Qwen2.5', modelName: 'qwen2.5-72b-instruct', platformId: 'p_qwen', enabled: false, isMain: false, isIntent: false, isVision: false, isImageGen: false, group: 'qwen-qwen2', enablePromptCache: true },
  ] as Model[],
  llmConfigs: [
    {
      id: 'c_1',
      provider: 'Claude',
      model: 'claude-3-5-sonnet-20241022',
      apiEndpoint: 'https://api.anthropic.com',
      maxTokens: 4096,
      temperature: 0.7,
      topP: 0.95,
      rateLimitPerMinute: 60,
      isActive: true,
      enablePromptCache: true,
      apiKeyMasked: 'sk-****************',
    },
    {
      id: 'c_2',
      provider: 'OpenAI',
      model: 'gpt-4o',
      apiEndpoint: 'https://api.openai.com',
      maxTokens: 8192,
      temperature: 0.6,
      topP: 0.9,
      rateLimitPerMinute: 120,
      isActive: false,
      enablePromptCache: true,
      apiKeyMasked: 'sk-****************',
    },
  ] as LLMConfig[],
};
