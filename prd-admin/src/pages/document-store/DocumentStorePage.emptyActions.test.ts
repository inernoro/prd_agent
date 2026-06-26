import { describe, expect, it } from 'vitest';
import { DOCUMENT_STORE_EMPTY_ACTIONS } from './DocumentStorePage';

describe('document store empty actions', () => {
  it('keeps all onboarding cards actionable', () => {
    expect(DOCUMENT_STORE_EMPTY_ACTIONS.map(action => action.key)).toEqual([
      'create',
      'upload',
      'emergence',
    ]);
    expect(DOCUMENT_STORE_EMPTY_ACTIONS.every(action => action.title && action.desc)).toBe(true);
  });
});
