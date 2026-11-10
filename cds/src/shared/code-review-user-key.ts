export interface ReviewUserKeyInput { provider: 'openai' | 'anthropic' | 'openrouter' | 'deepseek'; model: string; apiKey: string; tokenLimit?: number }
export interface ReviewUserKeyBinding { id: string; owner: string; keyId: string; provider: string; model: string; fingerprint: string; tokenLimit: number }
export interface ReviewKeyUsageSummary { requests: number; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null; providerActualUsd?: number | null; costKind: 'estimated' | 'unknown'; unknownUsageRequests: number }
export interface ReviewKeyUsage { task: ReviewKeyUsageSummary; key: ReviewKeyUsageSummary; reservedTokens: number; tokenLimit: number; calls: number; credentialSource: 'user'; accountBalance: null }
