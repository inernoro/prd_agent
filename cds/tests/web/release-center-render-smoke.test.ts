import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommitRail } from '../../web/src/pages/release-center/CommitRail.js';
import { FailureDiagnosis } from '../../web/src/pages/release-center/FailureDiagnosis.js';
import { EnvironmentSidebar } from '../../web/src/pages/release-center/EnvironmentSidebar.js';
import { buildEnvironmentSections } from '../../web/src/lib/releaseEnvironments.js';
import type { CenterRow, ReleaseRun } from '../../web/src/pages/release-center/types.js';

/**
 * 渲染冒烟：源码扫描只能证明「调用写在那儿」，这一层证明「东西真的出现在屏幕上」。
 *
 * 数据照抄 2026-07-29 那次真实失败（rel_3c72935be772e798）：门禁 10 项挂 1 项，
 * gateway_route_self_test 返回 401。用户当时看到的是一堆 WARN；这里断言的是
 * 401 那条判据、它的人话解释、以及「噪音不是原因」这三件事都渲染了出来。
 */

const NOW = Date.parse('2026-07-29T16:00:00Z');

function gateReportJson(): string {
  return JSON.stringify({
    verdict: 'fail',
    checks: [
      { name: 'map_health', ok: true, detail: JSON.stringify({ status: 200 }) },
      { name: 'gateway_key_configured', ok: true, detail: 'keyEnv=LLMGW_GATE_KEY' },
      {
        name: 'gateway_route_self_test',
        ok: false,
        detail: JSON.stringify({ status: 401, keyEnv: 'LLMGW_GATE_KEY' }),
      },
    ],
  }, null, 2);
}

function failedRun(): ReleaseRun {
  const lines = [
    'Preparing worktree (detached HEAD 307301a)',
    'context canceled',
    'WARN: api image warmup skipped or timed out after 30s',
    ...gateReportJson().split('\n'),
  ];
  return {
    releaseId: 'rel_3c72935be772e798',
    projectId: 'prd-agent',
    branchId: 'br_main',
    commitSha: '307301aac0de0000000000000000000000000000',
    artifact: { type: 'branch-preview', commitSha: '307301aac0de', branchName: 'main' },
    targetId: 'rt_prod',
    status: 'failed',
    startedAt: '2026-07-29T16:07:00Z',
    finishedAt: '2026-07-29T16:08:55Z',
    operator: 'user',
    logs: lines.map((message, index) => ({
      seq: index + 1,
      at: '2026-07-29T16:07:10Z',
      level: index === 1 || index === 2 ? 'warn' as const : 'info' as const,
      message,
    })),
  };
}

function productionRow(): CenterRow {
  return {
    target: {
      id: 'rt_prod',
      projectId: 'prd-agent',
      name: '生产站点',
      type: 'ssh',
      isEnabled: true,
      environment: 'production',
      isCanonical: true,
      ssh: {
        host: 'map.example.test',
        port: 22,
        user: 'root',
        privateKeyRef: 'host-1',
        appPath: '/root/app',
        deployCommand: './deploy.sh',
        healthcheckUrl: 'https://map.example.test/api/version',
      },
    },
    currentVersion: 'rel_adf8d987',
    currentCommit: '1b751ad0000000000000000000000000000000aa',
    lastReleasedAt: '2026-07-24T05:54:00Z',
    healthStatus: 'healthy',
    health: {
      status: 'healthy',
      url: 'https://map.example.test/api/version',
      checkedAt: '2026-07-29T15:55:00Z',
      responseTimeMs: 1214,
    },
    canRollback: true,
    successfulRuns: [],
    commitPosition: {
      commitSha: '1b751ad0000000000000000000000000000000aa',
      behindCount: 4,
      aheadCount: 0,
      inRail: true,
    },
  };
}

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe('发布中心渲染冒烟 · 失败诊断', () => {
  const html = render(createElement(FailureDiagnosis, {
    run: failedRun(),
    row: productionRow(),
    retrying: false,
    canRollback: true,
    onRetry: () => {},
    onRollback: () => {},
  }));

  it('结论直接写出是哪一项门禁挂了，不用用户自己翻日志', () => {
    expect(html).toContain('gateway_route_self_test');
    expect(html).toContain('未通过 1 项');
  });

  it('401 判据逐字段渲染在表格里', () => {
    expect(html).toContain('status=401');
    expect(html).toContain('keyEnv=LLMGW_GATE_KEY');
  });

  it('给出人话解释：密钥不被认，不是网络不通', () => {
    expect(html).toContain('对方不认它');
  });

  it('噪音单独成栏并写明它不是失败原因', () => {
    expect(html).toContain('顺带发现的噪音');
    expect(html).toContain('context canceled');
    expect(html).toContain('不是失败原因');
  });

  it('原始日志退到折叠区，不再占首屏', () => {
    expect(html).toContain('原始日志');
    expect(html).toMatch(/<details[^>]*>[\s\S]*原始日志/);
  });

  it('生产未被改动这个结论由数据推出：目标仍在自己那一版', () => {
    // currentCommit(1b751ad) ≠ 本次失败的 commit(307301a)，才敢这么说。
    expect(html).toContain('生产未受影响');
    expect(html).toContain('1b751ad');
    expect(html).toContain('本次版本没有切换上线');
  });

  /**
   * rel_9759ead9be9405e3 的形状：远端执行器把一句人话和 19 行 stderr 拼成
   * **一条** error 丢回来。判据层已经切过一刀，这里证明屏幕上真的只剩一句话。
   */
  it('复合 error 不许在结论位铺成一堵墙', () => {
    const run = failedRun();
    run.logs = [{
      seq: 1,
      at: '2026-07-29T16:07:10Z',
      level: 'error' as const,
      message: [
        '执行项目发布命令失败: ssh exec exit=22',
        '--- stderr(tail) --- ... [truncated, kept last 19 lines / 1418 chars]',
        'Warning: Problem (retrying all errors). Will retry in 2 seconds. 4 retries left.',
        'curl: (22) The requested URL returned error: 404',
      ].join('\n'),
    }];
    const wall = render(createElement(FailureDiagnosis, {
      run,
      row: productionRow(),
      retrying: false,
      canRollback: true,
      onRetry: () => {},
      onRollback: () => {},
    }));
    const headline = wall.slice(wall.indexOf('line-clamp-2'), wall.indexOf('</h3>'));
    expect(headline).toContain('执行项目发布命令失败: ssh exec exit=22');
    expect(headline).not.toContain('curl');
    expect(headline).not.toContain('truncated');
    // 原文没被吞掉：完整 error 仍在下方的 error 行区块里
    expect(wall).toContain('The requested URL returned error: 404');
  });

  it('影响面单独成行，不再挂在元信息末尾当灰色小字', () => {
    // 判据没变，位置变了：以前是「耗时 38s · 目标仍在 xxx」的尾巴，现在自成一行。
    expect(html).not.toMatch(/耗时[^<]*目标仍在/);
  });

  it('目标当前就跑着这一版时不许说「未切换」', () => {
    const row = productionRow();
    const run = failedRun();
    row.currentCommit = run.commitSha;
    const same = render(createElement(FailureDiagnosis, {
      run,
      row,
      retrying: false,
      canRollback: true,
      onRetry: () => {},
      onRollback: () => {},
    }));
    expect(same).not.toContain('生产未受影响');
    expect(same).not.toContain('本次版本没有切换上线');
  });
});

describe('发布中心渲染冒烟 · 流水轴', () => {
  const rail = {
    branch: 'main',
    ref: 'origin/main',
    nodes: [
      { sha: '307301aac0de0000000000000000000000000000', shortSha: '307301a', subject: '修复知识库正文链接', committedAt: '2026-07-29T10:00:00Z' },
      { sha: '1b751ad0000000000000000000000000000000aa', shortSha: '1b751ad', subject: '补齐录音分片生命周期清理闭环', committedAt: '2026-07-24T05:00:00Z' },
    ],
    refsAsOf: '2026-07-29T15:30:00Z',
  };

  it('环境旗插在对应提交上，并带上提交说明', () => {
    const html = render(createElement(CommitRail, {
      rail,
      markers: [{ targetId: 'rt_prod', label: '生产', environment: 'production', commitSha: '1b751ad0000000000000000000000000000000aa' }],
      selectedPosition: productionRow().commitPosition,
      nowMs: NOW,
    }));
    expect(html).toContain('生产在此');
    expect(html).toContain('修复知识库正文链接');
    expect(html).toContain('补齐录音分片生命周期清理闭环');
    // 不 fetch 的代价如实标注，而不是偷偷补一次网络往返把数字「修准」。
    expect(html).toContain('本地 origin/main 读取于');
  });

  it('不在最近提交里的环境单独列出，不凭空造一个节点', () => {
    const html = render(createElement(CommitRail, {
      rail,
      markers: [{ targetId: 'rt_old', label: '演示', environment: 'other', commitSha: 'deadbee0000' }],
      nowMs: NOW,
    }));
    expect(html).toContain('不在最近提交里');
    expect(html).toContain('deadbee');
  });
});

describe('发布中心渲染冒烟 · 左栏是环境列表', () => {
  it('每行给出环境名、当前 sha、落后主干多少', () => {
    const sections = buildEnvironmentSections(
      [{ environment: 'production', label: '生产', targetIds: ['rt_prod'], canonicalTargetId: 'rt_prod', disabledCount: 0 }],
      [productionRow()],
    );
    const html = render(createElement(EnvironmentSidebar, {
      sections,
      selectedTargetId: 'rt_prod',
      branch: 'main',
      archivedTargets: [],
      nowMs: NOW,
      onSelect: () => {},
      onAdd: () => {},
    }));
    expect(html).toContain('生产');
    expect(html).toContain('1b751ad');
    expect(html).toContain('落后 main 4 个提交');
    expect(html).toContain('添加环境');
  });

  it('算不出落后数时说无法比较，不显示成「齐平」', () => {
    const row = productionRow();
    row.commitPosition = {
      commitSha: row.currentCommit,
      behindCount: null,
      aheadCount: null,
      inRail: false,
      reason: '本地仓库不可读',
    };
    const sections = buildEnvironmentSections(
      [{ environment: 'production', label: '生产', targetIds: ['rt_prod'], canonicalTargetId: 'rt_prod', disabledCount: 0 }],
      [row],
    );
    const html = render(createElement(EnvironmentSidebar, {
      sections,
      selectedTargetId: 'rt_prod',
      branch: 'main',
      archivedTargets: [],
      nowMs: NOW,
      onSelect: () => {},
      onAdd: () => {},
    }));
    expect(html).toContain('无法与 main 比较');
    expect(html).toContain('本地仓库不可读');
    expect(html).not.toContain('齐平');
  });
});
