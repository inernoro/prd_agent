import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { apiRequest } from './api';

export async function signInWithPasskey(verifyCurrent = false): Promise<void> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const optionsJSON = await apiRequest<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkeys/login/options', {
    method: 'POST', body: { verifyCurrent },
  });
  const credential = await startAuthentication({ optionsJSON });
  await apiRequest('/api/auth/passkeys/login/verify', { method: 'POST', body: credential });
}

export async function approveSystemPasswordChange(input: { oldPassword: string; newPassword: string }): Promise<void> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const optionsJSON = await apiRequest<PublicKeyCredentialRequestOptionsJSON>('/api/auth/change-password/approval', {
    method: 'POST', body: input,
  });
  const approval = await startAuthentication({ optionsJSON });
  await apiRequest('/api/auth/change-password', { method: 'POST', body: { ...input, approval } });
}

export async function registerPasskey(): Promise<void> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const optionsJSON = await apiRequest<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/register/options', {
    method: 'POST', body: {},
  });
  const credential = await startRegistration({ optionsJSON });
  await apiRequest('/api/auth/passkeys/register/verify', { method: 'POST', body: credential });
}
