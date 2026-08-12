import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const harnessPath = new URL('../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs', import.meta.url);

test('visual harness persists the unique acceptance slot id in the manifest record', () => {
  const source = readFileSync(harnessPath, 'utf8');

  assert.match(source, /\bslotId,\s*\n\s*evidenceState,/);
  assert.match(source, /slotId:\s*slotId\s*\|\|\s*null,/);
  assert.match(source, /targetEnvironment:\s*opts\.environment\s*\|\|\s*null,/);
  assert.match(source, /environment:\s*targetEnvironment\s*\|\|\s*pageEnvironment\.targetEnvironment\s*\|\|\s*undefined,/);
  assert.match(source, /runId:\s*runId\s*\|\|\s*process\.env\.STABLE_SMOKE_RUN_ID\s*\|\|\s*undefined,/);
  assert.match(source, /commit:\s*commit\s*\|\|\s*process\.env\.STABLE_SMOKE_COMMIT\s*\|\|\s*undefined,/);
  assert.match(source, /capturedAt:\s*new Date\(\)\.toISOString\(\),/);
  assert.match(source, /pageOrigin\s*=\s*new URL\(actualPageUrl\)\.origin/);
  assert.match(source, /pageOrigin,/);
  assert.match(source, /automatedStatus:\s*warnings\.length\s*>\s*0\s*\?\s*'不通过'\s*:\s*automatedStatus\s*\|\|\s*'通过',/);
  assert.match(source, /manualStatus:\s*manualStatus\s*\|\|\s*status\s*\|\|\s*undefined,/);
});
