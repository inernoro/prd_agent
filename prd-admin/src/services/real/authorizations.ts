import { apiRequest } from './apiClient';
import { api } from '@/services/api';

export interface AuthFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea';
  placeholder?: string;
  helpText?: string;
  required: boolean;
}

export interface AuthTypeInfo {
  typeKey: string;
  displayName: string;
  fields: AuthFieldDefinition[];
}

export interface AuthorizationSummary {
  id: string;
  type: string;
  name: string;
  status: 'active' | 'expired' | 'revoked';
  metadata: Record<string, unknown>;
  lastUsedAt: string | null;
  lastValidatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  readOnly: boolean;
  hint?: string;
}

export async function listAuthorizations() {
  return apiRequest<AuthorizationSummary[]>(api.authorizations.list(), { method: 'GET' });
}

export async function listAuthorizationTypes() {
  return apiRequest<AuthTypeInfo[]>(api.authorizations.types(), { method: 'GET' });
}

export async function createAuthorization(input: {
  type: string;
  name: string;
  credentials: Record<string, string>;
}) {
  return apiRequest<AuthorizationSummary>(api.authorizations.create(), {
    method: 'POST',
    body: input,
  });
}

export async function updateAuthorization(id: string, input: {
  name?: string;
  credentials?: Record<string, string>;
}) {
  return apiRequest<AuthorizationSummary>(api.authorizations.byId(encodeURIComponent(id)), {
    method: 'PUT',
    body: input,
  });
}

export async function revokeAuthorization(id: string) {
  return apiRequest(api.authorizations.byId(encodeURIComponent(id)), {
    method: 'DELETE',
    emptyResponseData: { success: true },
  });
}

export async function validateAuthorization(id: string) {
  return apiRequest<{
    ok: boolean;
    errorMessage?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }>(api.authorizations.validate(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}
