import { describe, expect, it } from 'vitest';
import overview from './OverviewShell.tsx?raw';
import singleProduct from './SingleProductView.tsx?raw';
import routes from './ProductVersionAccessPage.tsx?raw';
import versions from './VersionWorkflowTab.tsx?raw';

describe('shared requirement and version lists', () => {
  it('only mounts the version workflow list, not the old overview list', () => {
    expect(overview).toContain('<VersionWorkflowTab isAdmin={isAdmin} />');
    expect(overview).not.toContain('function VersionOverviewSection(');
    expect(overview).not.toContain('function ReleaseOverviewTable(');
    expect(overview).not.toContain('function InitiationOverviewTable(');
    expect(singleProduct).not.toContain('<VersionWorkflowTab');
  });

  it('removes the separate personal-only requirement list', () => {
    expect(singleProduct).not.toContain('function RequirementsTab(');
    expect(singleProduct).not.toContain('function RequirementDataTable(');
    expect(overview).not.toContain('MineToggle');
    expect(overview).not.toContain('setMine');
    expect(overview).not.toContain('我负责的');
    expect(overview).toContain('await getOverviewRequirements()');
    expect(overview).toContain('aria-label="按产品筛选需求"');
    expect(overview).toContain('clearOptionLabel="全部产品"');
  });

  it('redirects old links before mounting a product view and keeps product context', () => {
    expect(routes).toContain("productListPath('requirements', productId)");
    expect(routes).toContain("productListPath('versions', productId, searchParams)");
    expect(singleProduct).toContain('navigate(productListPath(key, productId))');
    expect(versions).toContain("useState<RecordScope>('all')");
    expect(versions).toContain('aria-label="按产品筛选版本"');
  });
});
