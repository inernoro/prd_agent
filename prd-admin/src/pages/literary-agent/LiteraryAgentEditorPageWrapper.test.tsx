// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import LiteraryAgentEditorPageWrapper from './LiteraryAgentEditorPageWrapper';

vi.mock('./LiteraryAgentEditorPage', () => ({
  default: function Editor({ workspaceId }: { workspaceId: string }) {
    const [loadedWorkspace] = useState(workspaceId);
    return <div>{workspaceId} / {loadedWorkspace}</div>;
  },
}));

it('直接切换草稿路由时重新挂载编辑器，避免复用上一份草稿状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/literary-agent/draft-a']}>
        <Link to="/literary-agent/draft-b">打开草稿 B</Link>
        <Routes>
          <Route path="/literary-agent/:workspaceId" element={<LiteraryAgentEditorPageWrapper />} />
        </Routes>
      </MemoryRouter>,
    ));
    expect(container.querySelector('div')?.textContent).toBe('draft-a / draft-a');

    const nextDraft = container.querySelector('a');
    expect(nextDraft).not.toBeNull();
    await act(async () => nextDraft!.click());
    expect(container.querySelector('div')?.textContent).toBe('draft-b / draft-b');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
