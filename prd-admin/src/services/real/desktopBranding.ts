import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { DesktopBrandingSettings } from '@/services/contracts/desktopBranding';

export async function getDesktopBrandingSettings(): Promise<ApiResponse<DesktopBrandingSettings>> {
  return await apiRequest<DesktopBrandingSettings>(api.assets.desktopBranding());
}

export async function updateDesktopBrandingSettings(input: {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
}): Promise<ApiResponse<DesktopBrandingSettings>> {
  return await apiRequest<DesktopBrandingSettings>(api.assets.desktopBranding(), { method: 'PUT', body: input });
}


