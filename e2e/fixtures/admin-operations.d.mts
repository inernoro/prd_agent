import type { Page } from "@playwright/test";
export const targetName: string;
export function installOperationsFixtures(page: Page): Promise<{
  writes: Array<{ path: string; method: string; body: unknown }>;
  setReleaseTargets(value: Array<{id: string; projectId: string; name: string; isEnabled: boolean; type?: string; lifecycle?: string}>): void;
  setError(value: boolean): void;
  setPreflightPass(value: boolean): void;
}>;
