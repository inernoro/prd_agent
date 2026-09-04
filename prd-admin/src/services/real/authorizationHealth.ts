import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import { apiRequest } from './apiClient';

export type AuthorizationHealthStatus = 'healthy' | 'attention' | 'conditional' | 'blocked';

export interface AuthorizationHealthItem {
  id: string;
  label: string;
  audience: string;
  status: AuthorizationHealthStatus;
  statusLabel: string;
  summary: string;
  evidenceSource: string;
  actionUrl: string;
  actionLabel: string;
  actionPermission?: string | null;
  recovery?: string | null;
}

export interface AuthorizationFailureItem {
  requestId: string;
  occurredAt: string;
  path: string;
  statusCode: number;
  code: string;
  clientType: string;
  appName?: string | null;
  action: string;
}

export interface AuthorizationHealthOverview {
  generatedAt: string;
  observationHours: number;
  verdict: 'healthy' | 'attention' | 'blocked';
  conclusion: string;
  counts: { total: number; healthy: number; attention: number; blocked: number };
  quality: {
    recentUnauthorized: number;
    recentForbidden: number;
    genericUnauthorized: number;
    classifiedRate: number;
  };
  systems: AuthorizationHealthItem[];
  recentFailures: AuthorizationFailureItem[];
}

export function getAuthorizationHealth(): Promise<ApiResponse<AuthorizationHealthOverview>> {
  return apiRequest<AuthorizationHealthOverview>(api.authorizationHealth.overview());
}
