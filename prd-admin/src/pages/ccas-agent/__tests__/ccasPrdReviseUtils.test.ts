import { describe, expect, it } from 'vitest';
import { finalizeCcasReviseDocument } from '../ccasPrdReviseUtils';

describe('finalizeCcasReviseDocument', () => {
  it('commits the streamed revision only after a completed non-empty response', () => {
    expect(finalizeCcasReviseDocument('old prd', 'new prd', 'completed')).toBe('new prd');
  });

  it('restores the original document after a failed partial stream', () => {
    expect(finalizeCcasReviseDocument('old prd', 'partial new', 'failed')).toBe('old prd');
  });

  it('restores the original document after an aborted partial stream', () => {
    expect(finalizeCcasReviseDocument('old prd', 'partial new', 'aborted')).toBe('old prd');
  });

  it('restores the original document when the stream completes without body text', () => {
    expect(finalizeCcasReviseDocument('old prd', '   ', 'completed')).toBe('old prd');
  });
});
