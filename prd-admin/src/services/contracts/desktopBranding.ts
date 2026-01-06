import type { ApiResponse } from '@/types/api';

export type DesktopBrandingSettings = {
  desktopName: string;
  desktopSubtitle: string;
  windowTitle: string;
  loginIconKey: string;
  loginBackgroundKey: string;
  loginIconUrl?: string | null;
  loginBackgroundUrl?: string | null;
  assets?: Record<string, string>; // 所有资源的 key -> URL 映射
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


