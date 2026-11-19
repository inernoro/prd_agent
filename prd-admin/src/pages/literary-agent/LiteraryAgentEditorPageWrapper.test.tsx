// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
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
  const router = createMemoryRouter([
    { path: '/literary-agent/:workspaceId', element: <LiteraryAgentEditorPageWrapper /> },
  ], { initialEntries: ['/literary-agent/draft-a'] });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).toBe('draft-a / draft-a');

    await act(async () => { await router.navigate('/literary-agent/draft-b'); });
    expect(container.textContent).toBe('draft-b / draft-b');
  } finally {
    await act(async () => root.unmount());
    router.dispose();
    vi.unstubAllGlobals();
  }
});
