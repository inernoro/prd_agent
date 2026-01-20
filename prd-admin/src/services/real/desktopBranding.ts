import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';
import type { DesktopBrandingSettings } from '@/services/contracts/desktopBranding';

export async function getDesktopBrandingSettings(): Promise<ApiResponse<DesktopBrandingSettings>> {
  return await apiRequest<DesktopBrandingSettings>('/api/assets/branding');
}

export async function updateDesktopBrandingSettings(input: {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
}): Promise<ApiResponse<DesktopBrandingSettings>> {
  return await apiRequest<DesktopBrandingSettings>('/api/assets/branding', { method: 'PUT', body: input });
}


