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

  it('docks the preview widget away from desktop user controls and mobile bottom content', () => {
    const script = buildWidgetScript('branch-a', 'branch/a');
    expect(script).toContain('#cds-widget{position:fixed;right:12px;bottom:12px;');
    expect(script).toContain('#cds-widget{top:12px;right:12px;bottom:auto;left:auto;');
    expect(script).toContain('#cds-widget:not(.cds-widget-expanded) .cds-badge-main>:not([data-action="toggle"]){display:none}');
    expect(script).toContain("root.classList.toggle('cds-widget-expanded',expanded);");
    expect(script).toContain('var pos=null;');
  });
});
