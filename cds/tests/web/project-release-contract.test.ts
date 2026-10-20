import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptySiteDraft, releaseModeDefinitions, strategyFromDraft, applyDiscoveredStrategy } from '../../web/src/pages/release-center/SiteWizardDialog';
import { EnvConfigSection } from '../../web/src/pages/release-center/EnvConfigSection';
import type { CenterRow, ReleaseStrategyDiscovery } from '../../web/src/pages/release-center/types';

describe('default project release UI', () => {
  it('offers the project standard file first and an explicit standalone fallback, not stack inference', () => {
    const draft = emptySiteDraft('project');
    expect(draft.strategyMode).toBe('project-script');
    expect(draft.scriptFile).toBe('cds-release.sh');
    expect(releaseModeDefinitions(null, draft).map(item => item.mode)).toEqual(['project-script', 'managed-script']);
    expect(strategyFromDraft(draft)).toEqual({ mode: 'project-script', scriptFile: 'cds-release.sh', ciWorkflowFile: 'ci.yml' });
  });
  it.each(['existing-script','generated-compose','generated-static'] as const)('preserves the opened %s option through unsaved mode changes', mode => {
    const fields = { ...emptySiteDraft('project'), id: 'existing', strategyMode: mode, deployCommand:'./legacy.sh', composeFile:'legacy.yml', publicDirectory:'/srv/legacy', detectedFrom:['original'] };
    const draft = {...fields,originalStrategy:strategyFromDraft(fields)};
    const discovery = {candidates:[{mode,strategy:{mode,command:'./wrong.sh',composeFile:'wrong.yml',publicDirectory:'/wrong'}}]} as ReleaseStrategyDiscovery;
    const expected = ['project-script', 'managed-script', mode];
    expect(releaseModeDefinitions(null, draft).map(item => item.mode)).toEqual(expected);
    for (const next of ['project-script','managed-script'] as const) {
      const changed = applyDiscoveredStrategy(draft, {mode:next});
      expect(releaseModeDefinitions(null, changed).map(item => item.mode)).toEqual(expected);
      const option = releaseModeDefinitions(discovery,changed).find(item=>item.mode===mode)!;
      const restored = applyDiscoveredStrategy(changed, option.strategy);
      expect(strategyFromDraft(restored)).toEqual(strategyFromDraft(draft));
    }
  });
  it('round-trips separately managed script bytes without silently trimming its body', () => {
    const script = '#!/bin/bash\n# separately reviewed\n\n';
    const draft = applyDiscoveredStrategy(emptySiteDraft('project'), { mode: 'managed-script', script });
    expect(strategyFromDraft(draft)).toEqual({ mode: 'managed-script', script, ciWorkflowFile: 'ci.yml' });
  });
  it.each([undefined,'existing'])('keeps per-mode unsaved script values for target %s through generic and detected choices', id => {
    const script = '#!/bin/bash\n# draft body\n\n';
    let draft = {...emptySiteDraft('project'),id,scriptFile:'ops/publish.sh',managedScript:script,ciWorkflowFile:'release-check.yaml',originalStrategy:id?{mode:'project-script' as const,scriptFile:'old.sh'}:undefined};
    const discovery = {candidates:[{mode:'project-script',strategy:{mode:'project-script',scriptFile:'cds-release.sh'}},{mode:'managed-script',strategy:{mode:'managed-script',script:''}}]} as ReleaseStrategyDiscovery;
    for(const mode of ['managed-script','project-script','managed-script','project-script'] as const){
      const option = releaseModeDefinitions(discovery,draft).find(item=>item.mode===mode)!;
      draft = applyDiscoveredStrategy(draft,option.strategy) as typeof draft;
      expect(draft.scriptFile).toBe('ops/publish.sh');
      expect(draft.managedScript).toBe(script);
      expect(draft.ciWorkflowFile).toBe('release-check.yaml');
    }
  });
  it('renders a configured project file as a real read-only entry, not an empty deployment command', () => {
    const row = { target: { id: 'target', name: 'Production', projectId: 'project', isEnabled: true, strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' }, ssh: { appPath: '/srv/project', healthcheckUrl: 'https://project.example.test/health' } } } as CenterRow;
    const html = renderToStaticMarkup(createElement(EnvConfigSection, { row, onSaved: () => {}, onReload: () => {}, onConfigure: () => {} }));
    expect(html).toContain('项目发布脚本（默认）');
    expect(html).toContain('bash ./cds-release.sh check');
    expect(html).toContain('readonly');
    expect(html).not.toContain('未配置部署命令，保存前无法发布');
  });
});
