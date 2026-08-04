import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const harnessPath = new URL('../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs', import.meta.url);

test('visual harness persists the unique acceptance slot id in the manifest record', () => {
  const source = readFileSync(harnessPath, 'utf8');

  assert.match(source, /\bslotId,\s*\n\s*evidenceState,/);
  assert.match(source, /slotId:\s*slotId\s*\|\|\s*null,/);
});
