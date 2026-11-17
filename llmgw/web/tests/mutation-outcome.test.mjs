import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationOutcomeUnknown } from '../src/lib/mutationOutcome.ts';
test('只有端点核实的拒绝证明本次未写，新增或超时错误一律先核对', () => {
  for (const code of [undefined, 'NETWORK_ERROR', 'GATEWAY_TIMEOUT', 'UNEXPECTED_FAILURE', 'HTTP_408', 'HTTP_500', 'POST_WRITE_AUDIT_FAILED', 'INVALID_INPUT']) assert.equal(mutationOutcomeUnknown(code), true, code);
  assert.equal(mutationOutcomeUnknown('INVALID_INPUT', ['INVALID_INPUT']), false);
  assert.equal(mutationOutcomeUnknown('NOT_FOUND', ['INVALID_INPUT']), true, '另一个端点的已知拒绝不可自动继承');
});
