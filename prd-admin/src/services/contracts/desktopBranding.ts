import type { ApiResponse } from '@/types/api';

export type DesktopBrandingSettings = {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
  updatedAt: string;
};

export type GetDesktopBrandingSettingsContract = () => Promise<ApiResponse<DesktopBrandingSettings>>;
export type UpdateDesktopBrandingSettingsContract = (input: {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
}) => Promise<ApiResponse<DesktopBrandingSettings>>;


