/**
 * 绑仓库前那句打断文案，必须按「兄弟项目划没划构建范围」分档说话。
 *
 * 2026-09-02 Codex P2：原文一律说成「每个项目每次推送都会建分支、都会构建」，
 * 而本 PR 的分发器明明会跳过范围不匹配的项目。这句话出现在用户按下确认的前一秒，
 * 说过头就是拿夸大的后果吓他，属于 expectation-management 里「没料到会这样」的反面
 * ——只不过方向反了：说得比真实情况更糟，同样是让预期失准。
 *
 * 源码扫描证明不了这件事（三档文案都写在同一个三元里，扫描全都能命中），
 * 所以这里真的渲染一遍，断言屏幕上出现的是哪一档。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepoSharingConfirmBody } from '../../web/src/components/project/RepoSharing.js';

function render(props: {
  siblings: Array<{ id: string; name: string; scoped?: boolean }>;
  siblingCount?: number;
}): string {
  return renderToStaticMarkup(
    createElement(RepoSharingConfirmBody, { repoFullName: 'octocat/monorepo', ...props }),
  );
}

describe('绑仓库确认文案按范围分档', () => {
  it('兄弟都划了范围：说「只在被改到时才重建」，不吓人', () => {
    const html = render({ siblings: [{ id: 'p1', name: 'MAP', scoped: true }] });
    expect(html).toContain('只在被改到时才重建');
    expect(html).not.toContain('各自构建一遍');
  });

  it('兄弟都没划范围：维持原来那句「各自建分支、各自构建一遍」', () => {
    const html = render({ siblings: [{ id: 'p1', name: 'MAP', scoped: false }] });
    expect(html).toContain('各自构建一遍');
    expect(html).not.toContain('只在被改到时才重建（它们都划了构建范围）');
  });

  it('混着：分别点名谁每次重建、谁只在被改到时重建', () => {
    const html = render({
      siblings: [
        { id: 'p1', name: 'MAP', scoped: false },
        { id: 'p2', name: 'CDS Self', scoped: true },
      ],
    });
    expect(html).toContain('MAP 每次都会重建');
    expect(html).toContain('CDS Self 只在被改到时才重建');
  });

  it('拿不到明细（机器凭据只有计数）：不冒充知道范围，话仍然说得完整', () => {
    const html = render({ siblings: [], siblingCount: 2 });
    expect(html).toContain('2 个别的项目');
    expect(html).toContain('各自判断要不要建分支');
    // 一个名字都没有时，不许凭空断言「它们都划了/都没划范围」
    expect(html).not.toContain('都划了构建范围');
    expect(html).not.toContain('都没划构建范围');
  });
});
