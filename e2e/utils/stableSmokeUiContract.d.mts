import type { Locator, Page } from '@playwright/test';

export interface MapLoginSnapshot {
  headingCount: number;
  hasBrand: boolean;
  usernameCount: number;
  passwordCount: number;
  submitCount: number;
  ssoCount: number;
}

export interface GatewayLogicalModelAuditIdentity {
  id: string;
  publicId: string;
  enabled: boolean;
  modelType?: string;
  capabilities?: string[];
  isDefaultForType?: boolean;
  offerings: Array<{ enabled: boolean }>;
}

export function validateMapLoginSnapshot(snapshot: MapLoginSnapshot): { authenticationMethods: string[] };
export function assertScopedSyntheticUsername(username: string, runId: string): void;
export function blockUnsafeProductionFixture(test: { skip(condition: boolean, description: string): void }, environment: string, caseId: 'LIT-004' | 'MVIS-010'): void;
export function validateReadOnlyAvatarAsset(snapshot: {
  pageUrl: string; source: string; complete: boolean; width: number; height: number;
  status: number; mime: string; byteLength: number;
}): { source: string; width: number; height: number; byteLength: number };
export function getQuickEditInput(page: Page): Locator;
export function getMapLoginTarget(page: Page, options?: { timeout?: number }): Promise<{ target: Locator; authenticationMethods: string[] }>;
export function selectGatewayImageLogicalModel<T extends GatewayLogicalModelAuditIdentity>(items: T[]): T;
export function openGatewayLogicalModelDetails(page: Page, logical: { publicId: string }, options?: { timeout?: number }): Promise<{
  list: Locator;
  row: Locator;
  detail: Locator;
  routeDetails: Locator;
  layout: 'inline' | 'collection-pane';
  publicId: string;
}>;
