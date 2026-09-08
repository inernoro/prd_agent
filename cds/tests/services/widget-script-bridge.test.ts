import { afterEach, describe, expect, it } from 'vitest';
import { buildWidgetScript } from '../../src/widget-script.js';

describe('widget bridge polling gate', () => {
  const original = process.env.CDS_BRIDGE_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.CDS_BRIDGE_ENABLED;
    else process.env.CDS_BRIDGE_ENABLED = original;
  });

  it('renders Bridge disabled by default', () => {
    delete process.env.CDS_BRIDGE_ENABLED;
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('var BRIDGE_ENABLED=false;');
    expect(script).toContain('if(!BRIDGE_ENABLED)return;');
    expect(script).toContain('if(BRIDGE_ENABLED){');
  });

  it('can still be explicitly enabled for rollback', () => {
    process.env.CDS_BRIDGE_ENABLED = '1';
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('var BRIDGE_ENABLED=true;');
  });

  it('keeps the preview widget above mobile bottom navigation by default', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('function defaultWidgetBottom(){');
    expect(script).toContain('return window.innerWidth<=640?88:12;');
    expect(script).toContain('var pos={x:defaultWidgetLeft(),y:defaultWidgetBottom()};');
    expect(script).toContain('@media (max-width:640px)');
    expect(script).toContain('#cds-widget .cds-branch,#cds-widget .cds-mode{display:none}');
    expect(script).toContain('#cds-widget .cds-badge:not(.is-expanded){width:44px;height:44px;min-width:44px;max-width:44px');
    expect(script).toContain('#cds-widget .cds-badge:not(.is-expanded) .cds-badge-main>:not(button[data-action="toggle"]){display:none}');
    expect(script).toContain('#cds-widget .cds-panel{width:calc(100vw - 24px)');
    expect(script).toContain('max-height:calc(100vh - 176px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain');
    expect(script).toContain('data-action="close-panel" title="关闭 CDS 诊断面板" aria-label="关闭 CDS 诊断面板"');
    expect(script).toContain("if(action==='close-panel'){expanded=false;render();return;}");
    expect(script).toContain('#cds-widget button{min-width:44px;min-height:44px}');
    expect(script).toContain('#cds-widget .cds-mode-select{min-height:44px}');
  });

  it('keeps the preview widget in a right-side safe area outside expanded navigation', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('function defaultWidgetLeft(){');
    expect(script).toContain('return window.innerWidth<=640?12:Math.max(12,window.innerWidth-492);');
    expect(script).toContain('var widgetWasDragged=false;');
    expect(script).toContain("window.addEventListener('resize'");
    expect(script).toContain('function setWidgetPosition(x,y){');
    expect(script).toContain('var compactMobile=window.innerWidth<=640&&!expanded;');
    expect(script).toContain('var widgetWidth=Math.max(compactMobile?44:180,root.offsetWidth||0);');
    expect(script).toContain('var widgetHeight=Math.max(compactMobile?44:50,root.offsetHeight||0);');
    expect(script).toContain('setWidgetPosition(pos.x,pos.y);');
    expect(script).not.toContain('if(widgetWasDragged)return;');
  });

  it('exposes explicit labels and focus treatment for the controlled diagnostic panel', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('aria-expanded="\'+expanded+\'" aria-controls="cds-widget-panel"');
    expect(script).toContain('role="region" aria-label="CDS 分支诊断"');
    expect(script).toContain('#cds-widget button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px;opacity:1}');
    expect(script).toContain('aria-label="关闭 CDS 调试工具"');
  });

  it('uses text or SVG instead of emoji and symbolic state characters', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(script).toContain("else if(s.status==='done')h+='<span>完成</span>';");
    expect(script).toContain("else if(s.status==='error')h+='<span>错误</span>';");
    expect(script).toContain("if(s.status==='pending')icon='待';");
    expect(script).toContain("else if(s.status==='running')icon='中';");
    expect(script).toContain("addOpsStep('end','snapshot','AI 操作完成');");
    expect(script).toContain("showHandshakeToast('已授权 AI 操作此页面','#60a5fa');");
  });
});
