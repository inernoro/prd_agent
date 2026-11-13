import type { Page } from "@playwright/test";
export const targetName: string;
export function installOperationsFixtures(page: Page): Promise<{
  writes: Array<{ path: string; method: string; body: unknown }>;
  setError(value: boolean): void;
  setPreflightPass(value: boolean): void;
}>;
