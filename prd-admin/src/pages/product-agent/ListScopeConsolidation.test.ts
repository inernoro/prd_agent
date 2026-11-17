import { describe, expect, it } from 'vitest';
import overview from './OverviewShell.tsx?raw';
import singleProduct from './SingleProductView.tsx?raw';
import routes from './ProductVersionAccessPage.tsx?raw';
import versions from './VersionWorkflowTab.tsx?raw';

describe('shared requirement and version lists', () => {
  it('prefers the edit capability returned for each internal version row', () => {
    expect(versions).toContain('({ record, legacyRegistration, exportFields, canEdit }) => ({ ...record, legacyRegistration, exportFields, canEdit })');
    expect(versions).toContain("const canEdit = item.canEdit ?? (isOwner && item.status !== 'voided'");
    expect(versions).toContain('{canEdit && <button');
  });

  it('only mounts the version workflow list, not the old overview list', () => {
    expect(overview).toContain('<VersionWorkflowTab isAdmin />');
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
    expect(versions).toContain('aria-label="按产品筛选版本"');
  });

  it('filters both version lists by version type and uses the appropriate person field', () => {
    expect(versions).toContain('clearOptionLabel="全部版本类型"');
    expect(versions).toContain('aria-label="按负责人筛选"');
    expect(versions).toContain('item.createdBy === initiationApplicantId');
    expect(versions).toContain('item.ownerId === releaseOwnerId');
    expect(versions.match(/item\.versionType === versionTypeFilter/g)).toHaveLength(2);
  });
});
