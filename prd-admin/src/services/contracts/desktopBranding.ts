import type { ApiResponse } from '@/types/api';

export type DesktopBrandingSettings = {
  desktopName: string;
  loginIconKey: string;
  updatedAt: string;
};

export type GetDesktopBrandingSettingsContract = () => Promise<ApiResponse<DesktopBrandingSettings>>;
export type UpdateDesktopBrandingSettingsContract = (input: { desktopName: string; loginIconKey: string }) => Promise<ApiResponse<DesktopBrandingSettings>>;


