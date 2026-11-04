import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const page = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
const html = '<!doctype html><html><head></head><body><main>Saved deck</main></body></html>';

function patchHarness() {
  let callbacks: Record<string, (value: string) => void | Promise<void>> = {};
  let active = 'parent';
  let emit: (run: Record<string, unknown>) => void = () => {};
  const stop = vi.fn();
  const getRun = vi.fn().mockResolvedValue({ id: 'child', status: 'running', html: '', createdAt: new Date().toISOString() });
  const start = page.indexOf('      const base = baseHtml ?? generatedHtml;', page.indexOf('const startPatch = useCallback('));
  const end = page.indexOf('      cleanupRef.current = cleanup;', start) + '      cleanupRef.current = cleanup;'.length;
  expect(start).toBeGreaterThan(0);
  const body = page.slice(start, end);
  const setters = Object.fromEntries([...body.matchAll(/\b(set[A-Z]\w*)\(/g)].map((match) => [match[1], vi.fn()]));
  const scope = {
    ...setters,
    setGeneratedHtml: vi.fn(), setIsProcessing: vi.fn(),
    setActiveRunId: vi.fn((id: string) => { active = id; }),
    generatedHtml: html, activeRunId: 'parent', artifactSiteUrl: 'saved-site', isProcessing: false,
    mountedRef: { current: true }, patchSubmissionRef: { current: false }, manualSaveIntentRef: { current: null },
    patchParentRef: { current: null }, activePatchRef: { current: null },
    cleanupRef: { current: null }, hasRuntimePreviewRef: { current: false },
    restoreSlideRef: { current: 0 }, pendingRestoreRef: { current: null }, editedHtmlRef: { current: '' },
    theme: 'editorial', templateId: null, slidePos: null,
    resolveNaturalPatchSlideIndex: vi.fn(), createMdToPptModificationKey: () => 'one-key',
    retainMdToPptManualSaveIntent: vi.fn(), resetStreamPreview: vi.fn(), pushMsg: () => ({ id: 'message' }),
    handleDiagNotice: vi.fn(), handleThinkingDelta: vi.fn(), handleStreamDelta: vi.fn(),
    isPreviewableDeck: () => true, getMdToPptRun: getRun, getDesignArtifactRun: vi.fn(),
    observeMdToPptRun: vi.fn((_id: string, onSnapshot: (run: Record<string, unknown>) => void) => { emit = onSnapshot; onSnapshot({ id: 'child', status: 'running', progress: 40 }); return stop; }),
    cancelDesignArtifactRun: vi.fn().mockResolvedValue({ success: true, data: { runId: 'child', status: 'running', cancelRequested: true } }),
    toast: { error: vi.fn() }, window: { setTimeout, clearTimeout },
    streamMdToPptPatch: vi.fn((options: typeof callbacks) => { callbacks = options; return stop; }),
  };
  const emitted = ts.transpileModule(`function invoke(instruction, baseHtml, styleOverride, slideIndex, parentRunIdOverride, manualEditHtml) {${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const invoke = new Function(...Object.keys(scope), `${emitted}; return invoke;`)(...Object.values(scope));
  invoke('Refine this deck');
  return { callbacks, getRun, scope, active: () => active, emit: (run: Record<string, unknown>) => emit(run) };
}

describe('PPT accepted child lifecycle', () => {
  it('keeps the accepted patch child after transport loss and observes it instead of posting another edit', async () => {
    const f = patchHarness();
    f.callbacks.onRun('child');
    await f.callbacks.onError('temporary stream loss');
    expect(f.active()).toBe('child');
    expect(f.scope.patchParentRef.current).not.toBeNull();
    expect(f.scope.streamMdToPptPatch).toHaveBeenCalledOnce();
    expect(f.scope.observeMdToPptRun).toHaveBeenCalledWith('child', expect.any(Function));
    f.emit({ id: 'child', status: 'done', html, siteUrl: '' });
    expect(f.scope.setGeneratedHtml).toHaveBeenCalledWith(html);
    expect(f.scope.setIsProcessing).toHaveBeenCalledWith(false);
    expect(f.scope.activePatchRef.current).toBeNull();
    expect(f.scope.streamMdToPptPatch).toHaveBeenCalledOnce();
  });

  it('sends an explicit cancellation for the child before claiming it was stopped', async () => {
    const f = patchHarness();
    f.callbacks.onRun('child');
    const marker = 'const handleAbort = useCallback(() => {';
    const start = page.indexOf(marker) + marker.length;
    const end = page.indexOf('  }, [', start);
    const body = page.slice(start, end);
    const scope = { ...f.scope, repairRestartKeyRef: { current: null },
      sessionStorage: { removeItem: vi.fn() }, OUTLINE_RUN_KEY: 'outline', updateLastAssistantMsg: vi.fn() };
    new Function(...Object.keys(scope), body)(...Object.values(scope));
    await vi.waitFor(() => expect(scope.cancelDesignArtifactRun).toHaveBeenCalledWith('child'));
    expect(f.active()).toBe('child');
    expect(scope.updateLastAssistantMsg).not.toHaveBeenCalledWith({ content: '已中止。', phase: 'text' });
    await vi.waitFor(() => expect(scope.observeMdToPptRun).toHaveBeenCalledOnce());
    f.emit({ id: 'child', status: 'error', errorCode: 'design_artifact_cancelled', error: '任务已取消' });
    expect(f.active()).toBe('parent');
    expect(scope.cancelDesignArtifactRun).toHaveBeenCalledOnce();
    expect(scope.streamMdToPptPatch).toHaveBeenCalledOnce();
  });
  it('restores a busy accepted child on mount and cancels that same child explicitly', async () => {
    const f = patchHarness();
    f.scope.activePatchRef.current = null;
    f.scope.patchSubmissionRef.current = false;
    f.scope.streamMdToPptPatch.mockClear();
    const marker = '// ─── Session persistence: restore HTML for active run on mount';
    const start = page.indexOf('useEffect(() => {', page.indexOf(marker)) + 'useEffect(() => {'.length;
    const end = page.indexOf('  }, []); // eslint-disable-line react-hooks/exhaustive-deps', start);
    const body = page.slice(start, end);
    const setters = Object.fromEntries([...body.matchAll(/\b(set[A-Z]\w*)\(/g)].map((match) => [match[1], vi.fn()]));
    const scope = { ...setters, ...f.scope, setArtifactPhase: vi.fn(), setOutlineAdjusting: vi.fn(), setOutlineStreaming: vi.fn(), savedSession: { activeRunId: 'child' },
      genStartAtRef: { current: 0 }, getMdToPptRun: vi.fn().mockResolvedValue({ id: 'child', status: 'running',
        runtime: 'open-design', op: 'patch', html: '', createdAt: new Date().toISOString() }),
      mergeRuntimeModelCallCount: (_current: number, next: number) => next,
      window: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() },
      repairRestartKeyRef: { current: null }, sessionStorage: { removeItem: vi.fn() }, OUTLINE_RUN_KEY: 'outline',
      updateLastAssistantMsg: vi.fn(), warnIfDegraded: vi.fn(), recoverPatchParentRun: vi.fn(),
      resolveRecoveredDeckState: vi.fn(), buildRecoveredDoneMessage: vi.fn(), isRestartablePresentationQualityRun: vi.fn(),
    };
    const emitted = ts.transpileModule(`function mount() {${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const stop = new Function(...Object.keys(scope), `${emitted}; return mount();`)(...Object.values(scope));
    try {
      await vi.waitFor(() => expect(scope.setArtifactPhase).toHaveBeenCalled());
      const abortMarker = 'const handleAbort = useCallback(() => {';
      const abortStart = page.indexOf(abortMarker) + abortMarker.length;
      const abort = page.slice(abortStart, page.indexOf('  }, [', abortStart));
      new Function(...Object.keys(scope), abort)(...Object.values(scope));
      await vi.waitFor(() => expect(scope.cancelDesignArtifactRun).toHaveBeenCalledWith('child'));
      expect(scope.setIsProcessing).toHaveBeenCalledWith(true);
      expect(scope.streamMdToPptPatch).not.toHaveBeenCalled();
      expect(scope.updateLastAssistantMsg).not.toHaveBeenCalledWith({ content: '已中止。', phase: 'text' });
    } finally { stop(); }
  });

});
