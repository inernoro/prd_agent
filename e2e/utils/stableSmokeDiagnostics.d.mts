export function redactStableSmokeDiagnosticText(value: string): string;
export function sanitizeStableSmokeTestInfo(testInfo: { errors?: unknown[] }): void;
export function stableSmokeReporterConfig(options: { jsonOutput: string; htmlOutput?: string; stableRun: boolean }): Array<[string, Record<string, unknown>]> | undefined;
export function stableSmokeTraceMode(stableRun: boolean): 'off' | 'on-first-retry';
export function sanitizeStableSmokeArtifactFile(path: string): { scanned: number; changed: number };
export function sanitizeStableSmokeArtifactTree(root: string): { scanned: number; changed: number };
