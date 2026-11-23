import type { Page } from "@playwright/test";
export const targetName: string;
export const run: { commitSha: string };
export const target: {
  id: string; projectId: string; name: string; type: string; isEnabled: boolean;
  environment: string; isCanonical: boolean; strategy: { mode: string; command: string };
};
export function installOperationsFixtures(page: Page, options?: { quickstart?: boolean }): Promise<{
  writes: Array<{ path: string; method: string; body: unknown }>;
  setReleaseTargets(value: Array<{id: string; projectId: string; name: string; isEnabled: boolean; type?: string; lifecycle?: string}>): void;
  setError(value: boolean): void;
  setPreflightPass(value: boolean): void;
}>;
export function installEntryMediaFixture(page: Page, url: string, asset: { bytes: number; sha256: string }): Promise<void>;
