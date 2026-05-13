/**
 * CDS branch runtime visual checks.
 *
 * These tests intentionally avoid clicking actions that mutate branch state
 * (deploy / mode switch / reset). They verify the branch-list and deployment
 * drawer visuals that can be observed safely after login.
 */

import { expect, test, type Page } from '@playwright/test';
import { login, requireCreds } from '../utils/auth';

interface ProjectRow {
  id?: string;
  slug?: string;
  name?: string;
  repoFullName?: string;
  githubRepoFullName?: string;
}

async function resolveProjectId(page: Page): Promise<string> {
  const res = await page.request.get('/api/projects');
  expect(res.ok(), `/api/projects returned ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const projects = Array.isArray(body) ? body : (body.projects || []);
  const target = (projects as ProjectRow[]).find((project) => {
    const haystack = [
      project.id,
      project.slug,
      project.name,
      project.repoFullName,
      project.githubRepoFullName,
    ].filter(Boolean).join(' ');
    return /prd[_-]?agent|inernoro\/prd_agent/i.test(haystack);
  }) || projects[0];
  expect(target?.id, 'at least one CDS project is available').toBeTruthy();
  return target.id;
}

async function openBranchList(page: Page): Promise<string> {
  const projectId = await resolveProjectId(page);
  await page.goto(`/branch-list?project=${encodeURIComponent(projectId)}`);
  await expect(page.locator('[data-branch-card-id]').first()).toBeVisible({ timeout: 15_000 });
  return projectId;
}

async function mockFirstBranch(
  page: Page,
  transform: (branch: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await page.route('**/api/branches?**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const branches = Array.isArray(body.branches) ? body.branches : [];
    if (branches.length > 0) {
      branches[0] = transform({ ...branches[0] });
    }
    await route.fulfill({
      response,
      json: { ...body, branches },
    });
  });
}

test.describe('CDS branch runtime visual checks', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const creds = requireCreds(testInfo);
    await login(page, creds.user, creds.password);
  });

  test('source runtime does not render a runtime badge on branch cards', async ({ page }) => {
    await openBranchList(page);
    await expect(page.locator('.branch-runtime-source')).toHaveCount(0);
  });

  test('release runtime badge remains visible when release branches exist', async ({ page }) => {
    await mockFirstBranch(page, (branch) => ({
      ...branch,
      status: 'running',
      deployRuntime: {
        kind: 'release',
        label: '发布版',
        title: '当前分支使用发布版构建模式',
        activeProfiles: 2,
        releaseProfiles: 2,
        sourceProfiles: 0,
        modes: ['publish'],
      },
    }));
    await openBranchList(page);
    const releaseBadge = page.getByTitle('当前分支使用发布版构建模式').first();
    await expect(releaseBadge).toBeVisible();
    await expect(releaseBadge).toContainText('发布版');
  });

  test('branch card timestamp is labeled as deploy attempt/success instead of generic old update', async ({ page }) => {
    await openBranchList(page);
    const deployTime = page.locator(
      '[data-branch-card-id] span[title*="最近一次部署尝试"], [data-branch-card-id] span[title*="最近一次成功部署"], [data-branch-card-id] span[title*="最近一次部署失败"]',
    );
    await expect(deployTime.first()).toBeVisible();
    await expect(deployTime.first()).toContainText(/部署/);
  });

  test('branch list detail drawer exposes deployment container log details', async ({ page }) => {
    await openBranchList(page);
    await page.locator('[data-branch-card-id]').first().click();
    await expect(page.getByText('分支详情', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    await page.locator('nav').getByText('部署', { exact: true }).click();
    const activeDeployment = page.locator('.cds-shape-panel').first();
    const hasDeployment = await activeDeployment.isVisible().catch(() => false);
    test.skip(!hasDeployment, 'No active or recent deployment card is visible for the selected branch drawer.');

    await expect(page.locator('summary', { hasText: '容器日志' }).first()).toBeVisible();
  });

  test('building branch card shows a live elapsed-time chip', async ({ page }) => {
    await mockFirstBranch(page, (branch) => ({
      ...branch,
      status: 'building',
      lastAccessedAt: new Date(Date.now() - 61_000).toISOString(),
      services: {
        api: {
          profileId: 'api',
          status: 'building',
        },
      },
    }));
    await openBranchList(page);
    const chip = page.locator('[data-branch-card-id] .branch-build-elapsed').first();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/构建|启动|重启/);
    await expect(chip).toContainText(/\d{2}:\d{2}/);
    const timerValue = chip.locator('.branch-deploy-timer-value');
    const before = (await timerValue.textContent()) || '';
    await expect
      .poll(async () => (await timerValue.textContent()) || '', {
        timeout: 4_000,
        intervals: [500, 1_000, 1_000],
      })
      .not.toBe(before);
  });
});
