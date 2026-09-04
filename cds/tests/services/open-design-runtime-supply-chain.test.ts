import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('OpenDesign runtime supply chain', () => {
  it('pins the CDS runtime to an immutable digest', () => {
    const runtimeSource = fs.readFileSync(
      path.join(repoRoot, 'cds/src/services/agent-workspace-session-runtime.ts'),
      'utf8',
    );

    expect(runtimeSource).toMatch(
      /OPEN_DESIGN_IMAGE\s*=\s*'ghcr\.io\/inernoro\/prd_agent\/opendesign-runtime@sha256:[a-f0-9]{64}'/,
    );
  });

  it('publishes only commit-addressed tags from branch workflows', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/open-design-runtime.yml'),
      'utf8',
    );

    expect(workflow).toContain(
      'tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}',
    );
    expect(workflow).not.toContain('RUNTIME_TAG');
    expect(workflow).not.toContain('od-0.21.1-opencode-1.18.28');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('Build runtime without publishing');
  });
});
