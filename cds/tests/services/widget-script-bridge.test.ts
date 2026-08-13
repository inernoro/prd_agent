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
  });

  it('keeps the preview widget in a right-side safe area outside expanded navigation', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('function defaultWidgetLeft(){');
    expect(script).toContain('return window.innerWidth<=640?12:Math.max(12,window.innerWidth-492);');
    expect(script).toContain('var widgetWasDragged=false;');
    expect(script).toContain("window.addEventListener('resize'");
    expect(script).toContain('function setWidgetPosition(x,y){');
    expect(script).toContain('var widgetWidth=Math.max(180,root.offsetWidth||0);');
    expect(script).toContain('var widgetHeight=Math.max(50,root.offsetHeight||0);');
    expect(script).toContain('setWidgetPosition(pos.x,pos.y);');
    expect(script).not.toContain('if(widgetWasDragged)return;');
  });
});
