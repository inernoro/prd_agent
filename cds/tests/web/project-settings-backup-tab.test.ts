/**
 * 项目设置 →「周期备份」面板。
 *
 * 两层：
 *
 *   1. **渲染冒烟**：拿一份真机形状的数据渲染一次，断言用户真的看得到那句判断、
 *      需要处理的目标、以及「不用管的」被收起来了。源码扫描只能证明代码写在那儿，
 *      证明不了它出现在屏幕上。
 *   2. **接线守卫**：一个 tab 要在三处同时登记（类型、导航、面板）才算通。少一处
 *      就是「导航点不进去」或「面板永远不显示」——都不会报错，只会静默不在
 *      （形状 2：建了一半）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupPanel } from '../../web/src/pages/project-settings/BackupTab.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 真机形状：一个拿不到口令的 redis、一个离机没上去的 mysql、一台 MinIO 备不了。 */
function panelData(overrides: Record<string, unknown> = {}): any {
  const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
  return {
    lastRoundAt: threeHoursAgo,
    nextRoundEstimatedAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    localVerifiedAt: threeHoursAgo,
    remoteVerifiedAt: threeHoursAgo,
    verdict: { tone: 'bad', headline: '1 个目标本地就没备出来，手上没有它们的新副本', subline: '正常 2 个 · 这类还备不了 1 个' },
    targets: [
      { id: 'redis', status: 'failed', reason: 'NOAUTH Authentication required', bytes: null, offsite: false, lastSuccessAt: null, fileCount: 0 },
      { id: 'mysql', status: 'offsite-only', reason: '离机副本缺失：连接超时', bytes: 2048, offsite: false, lastSuccessAt: threeHoursAgo, fileCount: 7 },
      { id: 'mongo', status: 'ok', reason: null, bytes: 4096, offsite: true, lastSuccessAt: threeHoursAgo, fileCount: 7 },
      { id: 'postgres', status: 'ok', reason: null, bytes: 8192, offsite: true, lastSuccessAt: threeHoursAgo, fileCount: 7 },
      { id: 'minio', status: 'unsupported', reason: '需要桶到桶复制，不是一份 dump', bytes: null, offsite: false, lastSuccessAt: null, fileCount: 0 },
      { id: 'nacos', status: 'artifact-missing', reason: '上一轮导出的产物 demo--nacos-auto-20260828T090000Z.tar.gz 现在不在备份目录里——被删了、被移走了，或者盘出了问题', bytes: 1024, offsite: true, lastSuccessAt: threeHoursAgo, fileCount: 0 },
    ],
    files: { count: 21, bytes: 1024 * 1024 * 12 },
    directory: '/data/cds/demo/backups',
    directoryExists: true,
    findings: [
      { id: 'restore-drill.never', severity: 'critical', message: '从来没有做过一次恢复演练——现在手上这些备份能不能真的读回来，谁也不知道' },
      { id: 'backup.coverage-gaps', severity: 'warn', message: '1 个正在跑的服务备份不完整（没备到，或只备到一部分）：minio' },
    ],
    ...overrides,
  };
}

function render(data: any): string {
  return renderToStaticMarkup(createElement(BackupPanel, { data }));
}

describe('周期备份面板：渲染出来的东西', () => {
  it('第一屏就是那句判断，不是一排要人自己算的数字', () => {
    const html = render(panelData());
    expect(html).toContain('1 个目标本地就没备出来');
    expect(html).toContain('上一轮');
    expect(html).toContain('3 小时前');
    expect(html).toContain('约 3 小时后');
  });

  it('需要处理的目标摆在外面，正常的和备不了的各收成一行', () => {
    const html = render(panelData());
    expect(html).toContain('需要你管的');
    // 后端新加的一档必须自动落进这一组，而不是从界面上凭空消失（形状 2）。
    expect(html).toContain('产物不在了');
    expect(html).toContain('nacos');
    // 需要处理的两个直接可见。
    expect(html).toContain('redis');
    expect(html).toContain('mysql');
    // 收起来的那两组只露一句话，目标名不在第一屏（点开才有）。
    expect(html).toContain('2 个目标正常，最近一轮都有副本');
    expect(html).toContain('1 个服务这类还备不了');
    expect(html).not.toContain('postgres');
  });

  it('失败原因收进详情，不铺在第一屏', () => {
    // 用户原话：「减少一些字，异常情况让用户自己看详情……用户不知道重点在哪里」。
    const html = render(panelData());
    expect(html).not.toContain('NOAUTH Authentication required');
    expect(html).toContain('没备出来');
  });

  it('页脚只放一条最严重的体检结论，加一句文件数', () => {
    const html = render(panelData());
    expect(html).toContain('备份文件');
    expect(html).toContain('21 个');
    expect(html).toContain('从来没有做过一次恢复演练');
    // 第二条不上页脚——页脚是顺带一提，不是第二块结论区。
    expect(html).not.toContain('备份不完整');
  });

  it('一条记录都没有时给出下一步，不是一句「暂无数据」', () => {
    const html = render(panelData({
      targets: [],
      verdict: { tone: 'warn', headline: '这个项目还没有一条周期备份记录', subline: null },
      files: { count: 0, bytes: 0 },
    }));
    expect(html).toContain('这个项目还没有一条周期备份记录');
    expect(html).toContain('首轮在启动 10 分钟后');
    expect(html).not.toContain('暂无数据');
  });

  it('颜色一律走 token，不许出现写死的色值', () => {
    // 白天主题下的暗色字面量是这个仓库被反复指出过 10+ 次的问题。
    const source = fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/project-settings/BackupTab.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });
});

describe('周期备份 tab 的三处登记', () => {
  const page = fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/ProjectSettingsPage.tsx'), 'utf8');

  it('类型、左侧导航、面板三处都登记了', () => {
    // 少任何一处都不会报错，只会静默「点不进去」或「永远不显示」。
    expect(page).toMatch(/\|\s*'backup'/);
    expect(page).toContain("{ value: 'backup', label: '周期备份'");
    expect(page).toContain('<TabsContent value="backup">');
    expect(page).toContain('<BackupTab projectId={project.id} />');
  });
});
