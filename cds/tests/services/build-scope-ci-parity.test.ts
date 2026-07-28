/**
 * buildScope 必须覆盖 CI 构建该镜像的**全部触发路径**（Codex PR #1275 三轮 P1 + 五轮 P1）。
 *
 * 「per-SHA 镜像拉不到 → 该组件是不是真的没变」这个判断，唯一可信的依据是 CI 构建
 * 该镜像时的输入范围。CDS 侧声明在 `cds-compose.yml` 的
 * `x-cds-deploy-modes.<svc>.express.buildScope`，权威定义在
 * `.github/workflows/branch-image.yml`。两份东西描述同一件事，漂移就出人命：
 *
 *   - 声明得比 CI **窄**：CI 因某路径变更重建了镜像，CDS 却判「没变」而复用旧的
 *     → 静默发旧代码；
 *   - 声明得比 CI **宽**：白白错过复用，退回宿主全量重编（本 PR 要治的事故）。
 *
 * 三轮首版这条测试对拍的是**同名 filter**，那是错的 SSOT —— 真正决定「这个镜像会不会
 * 被重建」的是 job 的 `if:` 条件，而它可以引用**多个** filter。llmgw / llmgw-web /
 * llmgw-serve 三个镜像的条件里都含 `api == 'true'`（Dockerfile 编译 prd-api 的
 * Core/Infrastructure），只按同名 filter 对拍就漏掉了 `prd-api/**`，于是一个只改
 * prd-api 的提交在拉取失败时会被判「serving 组件没变」而复用陈旧镜像（五轮 P1）。
 * 现在直接从 job 条件解析出它引用的全部 filter 再求并集。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readYaml = (rel: string): Record<string, unknown> =>
  yaml.load(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as Record<string, unknown>;

/** CI 的镜像 job → cds-compose 里的服务名。 */
const JOB_TO_SERVICE: Record<string, string> = {
  'api-image': 'api',
  'admin-image': 'admin',
  'llmgw-image': 'llmgw',
  'llmgw-web-image': 'llmgw-web',
  'llmgw-serve-image': 'llmgw-serve',
};

interface WorkflowJob { if?: string; steps?: Array<Record<string, unknown>> }

const wf = readYaml('.github/workflows/branch-image.yml');
const jobs = wf.jobs as Record<string, WorkflowJob>;
const compose = readYaml('cds-compose.yml');
const modes = compose['x-cds-deploy-modes'] as Record<string, Record<string, { buildScope?: string[] }>>;

// filters 在 `with.filters` 里是一段 YAML **字符串**，需要二次解析。
const filterStep = (jobs.changes.steps || []).find((s) => String(s.uses || '').includes('paths-filter'));
const filters = yaml.load(
  String((filterStep?.with as Record<string, unknown>).filters),
) as Record<string, string[]>;

/** 从 job 的 `if:` 里取出它引用的全部 `needs.changes.outputs.<name>`。 */
function referencedFilters(condition: string): string[] {
  const out = new Set<string>();
  for (const m of condition.matchAll(/needs\.changes\.outputs\.([a-z_]+)/g)) out.add(m[1]);
  return [...out];
}

/** 该 job 会被哪些路径触发 = 它引用的所有 filter 的路径并集。 */
function ciScopeFor(jobId: string): string[] {
  const cond = jobs[jobId]?.if || '';
  const names = referencedFilters(cond);
  expect(names.length, `job ${jobId} 的 if 条件里没有引用任何 paths-filter`).toBeGreaterThan(0);
  const paths = new Set<string>();
  for (const name of names) {
    expect(filters[name], `工作流缺少 filter: ${name}`).toBeTruthy();
    for (const p of filters[name]) paths.add(p);
  }
  return [...paths].sort();
}

describe('cds-compose 的 buildScope 与 branch-image.yml 的构建触发条件对拍', () => {
  it('每个镜像 job 在 compose 里都声明了 buildScope', () => {
    for (const [jobId, svc] of Object.entries(JOB_TO_SERVICE)) {
      expect(jobs[jobId], `工作流缺少 job: ${jobId}`).toBeTruthy();
      expect(modes[svc]?.express?.buildScope, `compose 服务 ${svc} 缺 express.buildScope`).toBeTruthy();
    }
  });

  it('声明的路径集合等于该 job 全部触发 filter 的并集（顺序无关）', () => {
    for (const [jobId, svc] of Object.entries(JOB_TO_SERVICE)) {
      const declared = [...(modes[svc].express.buildScope || [])].sort();
      expect(declared, `${svc}.express.buildScope 与 job '${jobId}' 的触发条件不一致`).toEqual(ciScopeFor(jobId));
    }
  });

  it('三个 llmgw 镜像都必须含 prd-api/**（其 Dockerfile 编译 prd-api 的 Core/Infrastructure）', () => {
    for (const svc of ['llmgw', 'llmgw-web', 'llmgw-serve']) {
      expect(modes[svc].express.buildScope, svc).toContain('prd-api/**');
    }
  });

  it('buildScope 不是 workDir 的复制品（后者是整仓挂载，比了等于没比）', () => {
    for (const svc of Object.values(JOB_TO_SERVICE)) {
      const scope = modes[svc].express.buildScope || [];
      expect(scope).not.toContain('.');
      expect(scope).not.toContain('./');
      expect(scope).not.toContain('**');
    }
  });
});
