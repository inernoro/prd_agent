import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
describe('stuck runtime diff production wiring', () => {
  it('wires the actual index watchdog without synchronous git diff', () => {
    const source = fs.readFileSync(path.resolve('src/index.ts'), 'utf8');
    const start = source.indexOf('function startStaleDeployDispatchReconciler(');
    const end = source.indexOf('function dispatchRecoveredWebhookDeploys(', start);
    const watchdog = source.slice(start, end);
    expect(watchdog).not.toContain('execSync(');
    expect(watchdog).toContain('new StuckDeployRuntimeDiff(shell)');
    expect(watchdog).toContain('runtimeDiff.hasRuntimeChanges(b)');
  });
});
