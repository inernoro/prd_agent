import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'cds', 'exec_cds.sh');

describe('exec_cds.sh nginx template guard', () => {
  it('does not enable upstream keepalive for cds_worker preview traffic', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).toContain('upstream cds_worker { server 127.0.0.1:${worker}; }');
    expect(script).not.toMatch(/upstream cds_worker \{[^}]*keepalive/i);
  });
});
