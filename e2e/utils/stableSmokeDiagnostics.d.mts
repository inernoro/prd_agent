export function redactStableSmokeDiagnosticText(value: string): string;
export function sanitizeStableSmokeTestInfo(testInfo: { errors?: unknown[] }): void;
export function stableSmokeDiagnosticIndicatesInfrastructureTimeout(value: unknown): boolean;
export function probeStableSmokeReadiness(request: {
  get(path: string, options?: Record<string, unknown>): Promise<{
    ok(): boolean;
    json(): Promise<unknown>;
  }>;
}, timeoutMs?: number): Promise<boolean>;
export function readStableSmokeInfrastructureCircuit(outputDirectory: string): { reason: string; lastProbeAt: number } | undefined;
export function writeStableSmokeInfrastructureCircuit(outputDirectory: string, circuit: { reason: string; lastProbeAt: number }): void;
export function clearStableSmokeInfrastructureCircuit(outputDirectory: string): void;
export function stableSmokeReporterConfig(options: { jsonOutput: string; htmlOutput?: string; stableRun: boolean }): Array<[string, Record<string, unknown>]> | undefined;
export function stableSmokeTraceMode(stableRun: boolean): 'off' | 'on-first-retry';
export function sanitizeStableSmokeArtifactFile(path: string): { scanned: number; changed: number };
export function sanitizeStableSmokeArtifactTree(root: string): { scanned: number; changed: number };
