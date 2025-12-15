export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';

export type UserStatus = 'Active' | 'Disabled';

export type AdminUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt?: string;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
};

export type Platform = {
  id: string;
  name: string;
  platformType: string;
  apiUrl: string;
  apiKeyMasked: string;
  enabled: boolean;
};

export type Model = {
  id: string;
  name: string;
  modelName: string;
  platformId: string;
  enabled: boolean;
  isMain: boolean;
  group?: string;
};

export type LLMConfig = {
  id: string;
  provider: string;
  model: string;
  apiEndpoint?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  rateLimitPerMinute: number;
  isActive: boolean;
  apiKeyMasked: string;
};
