import type { Page } from '@playwright/test';
export function enterVisualFromHome(page: Page, options?: { touch?: boolean; timeout?: number }): Promise<{ label: string; path: string; realClick: boolean; touch: boolean }>;
export function openOwnVisualWorkspace(page: Page, workspaceId: string, options?: { touch?: boolean }): Promise<void>;
