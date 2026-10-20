import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptySiteDraft, releaseModeDefinitions, strategyFromDraft, applyDiscoveredStrategy } from '../../web/src/pages/release-center/SiteWizardDialog';
import { EnvConfigSection } from '../../web/src/pages/release-center/EnvConfigSection';
import type { CenterRow } from '../../web/src/pages/release-center/types';

describe('default project release UI', () => {
  it('offers the project standard file first and an explicit standalone fallback, not stack inference', () => {
    const draft = emptySiteDraft('project');
    expect(draft.strategyMode).toBe('project-script');
    expect(draft.scriptFile).toBe('cds-release.sh');
    expect(releaseModeDefinitions(null, draft).map(item => item.mode)).toEqual(['project-script', 'managed-script']);
    expect(strategyFromDraft(draft)).toEqual({ mode: 'project-script', scriptFile: 'cds-release.sh', ciWorkflowFile: 'ci.yml' });
  });
  it('preserves a legacy target only while explicitly editing that target', () => {
    const draft = { ...emptySiteDraft('project'), id: 'existing', strategyMode: 'generated-compose' as const };
    expect(releaseModeDefinitions(null, draft).map(item => item.mode)).toEqual(['project-script', 'managed-script', 'generated-compose']);
  });
  it('round-trips separately managed script bytes without silently trimming its body', () => {
    const script = '#!/bin/bash\n# separately reviewed\n\n';
    const draft = applyDiscoveredStrategy(emptySiteDraft('project'), { mode: 'managed-script', script });
    expect(strategyFromDraft(draft)).toEqual({ mode: 'managed-script', script, ciWorkflowFile: 'ci.yml' });
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
