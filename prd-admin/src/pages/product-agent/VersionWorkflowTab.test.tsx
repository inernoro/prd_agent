import { describe, expect, it } from 'vitest';
import source from './VersionWorkflowTab.tsx?raw';

describe('VersionWorkflowTab modal', () => {
  it('renders dialogs through a body portal outside the scroll container', () => {
    expect(source).toContain("import { createPortal } from 'react-dom';");
    expect(source).toContain('return createPortal(');
    expect(source).toContain('document.body,');
    expect(source).toContain("style={{ height: 'min(90vh, 760px)', maxHeight: '90vh' }}");
    expect(source).toContain("style={{ minHeight: 0, overscrollBehavior: 'contain' }}");
  });
});
