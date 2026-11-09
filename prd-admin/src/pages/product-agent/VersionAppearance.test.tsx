// @vitest-environment jsdom
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentFullscreenLayout } from '@/components/agent-shell/AgentFullscreenLayout';
import { ProductAgentAppearance, VersionAppearance } from './VersionAppearance';
import appearanceCss from './product-appearance.css?raw';
import versionWorkflow from './VersionWorkflowTab.tsx?raw';

it('默认浅色，保存切换结果，并在离开版本页时恢复原外观', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = appearanceCss;
  document.head.appendChild(stylesheet);
  const rules = Array.from(stylesheet.sheet!.cssRules) as CSSStyleRule[];
  const canvasRule = rules.find((rule) => rule.selectorText.endsWith(' .agent-fullscreen-canvas'))!;
  const sidebarRule = rules.find((rule) => rule.selectorText.endsWith(' .agent-fullscreen-sidebar'))!;
  const panelRule = rules.find((rule) => rule.selectorText.includes('[class~='))!;
  const filterBackground = versionWorkflow.match(/bg-\[#[0-9a-f]{6}\]/)?.[0];
  expect(filterBackground).toBeDefined();
  const component = createRoot(host);
  try {
    await act(async () => component.render(
      <ProductAgentAppearance>
        <AgentFullscreenLayout title="产品管理" items={[]} active="versions" onSelect={() => {}}>
          <VersionAppearance />
          {createPortal(<div data-version-filter className={filterBackground} />, document.body)}
        </AgentFullscreenLayout>
      </ProductAgentAppearance>,
    ));
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    const canvas = host.querySelector('.agent-fullscreen-canvas')!;
    const sidebar = host.querySelector('.agent-fullscreen-sidebar')!;
    const filter = document.querySelector('[data-version-filter]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.hasAttribute('data-product-agent-appearance')).toBe(true);
    expect(canvas.matches(canvasRule.selectorText)).toBe(true);
    expect(canvasRule.style.getPropertyValue('background-color')).toBe('var(--bg-base)');
    expect(canvasRule.style.getPropertyValue('color')).toBe('var(--text-primary)');
    expect(sidebar.matches(sidebarRule.selectorText)).toBe(true);
    expect(filter.matches(panelRule.selectorText)).toBe(true);

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(canvas.matches(canvasRule.selectorText)).toBe(false);
    expect(sidebar.matches(sidebarRule.selectorText)).toBe(false);
    expect(filter.matches(panelRule.selectorText)).toBe(false);
    expect(JSON.parse(localStorage.getItem('map-product-version-appearance') ?? '{}').state.mode).toBe('dark');

    await act(async () => toggle.click());
    expect(root.getAttribute('data-theme')).toBe('light');
  } finally {
    await act(async () => component.unmount());
    host.remove();
    stylesheet.remove();
    localStorage.removeItem('map-product-version-appearance');
    vi.unstubAllGlobals();
  }
  expect(root.hasAttribute('data-theme')).toBe(false);
  expect(root.hasAttribute('data-product-agent-appearance')).toBe(false);
});
