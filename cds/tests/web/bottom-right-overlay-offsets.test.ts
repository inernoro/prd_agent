/**
 * 全局入口与提醒不重叠守卫。
 *
 * 用户可主动触发的「提交缺陷」固定在左侧导航；普通被动消息进入顶部信息中心。
 * 授权申请是唯一双入口：信息中心保留一份，同时右下角必须直接出现决策卡。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bottomRightToastStyle } from '../../web/src/lib/overlayOffsets.js';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

const TOAST_PAGES = [
  'pages/ProjectListPage.tsx',
  'pages/BranchListPage.tsx',
  'pages/BranchDetailPage.tsx',
  'pages/ProjectSettingsPage.tsx',
  'pages/BranchTopologyPage.tsx',
  'pages/CdsSettingsPage.tsx',
];

function readWeb(relative: string): string {
  return fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('全局操作与信息中心', () => {
  const shell = readWeb('components/layout/AppShell.tsx');
  const bugDialog = stripComments(readWeb('components/BugReportDialog.tsx'));
  const informationCenter = readWeb('components/SiteNoticeInbox.tsx');
  const css = readWeb('index.css');

  it('提交缺陷固定在接入 Agent 后方，并通过全局事件打开弹窗', () => {
    const footerIndex = shell.indexOf('<div className="cds-rail-footer">');
    const agentIndex = shell.indexOf('aria-label="接入 Agent"', footerIndex);
    const bugIndex = shell.indexOf('aria-label="提交缺陷"', footerIndex);
    const settingsIndex = shell.indexOf('aria-label="CDS 系统设置"', footerIndex);

    expect(agentIndex).toBeGreaterThan(footerIndex);
    expect(bugIndex).toBeGreaterThan(agentIndex);
    expect(settingsIndex).toBeGreaterThan(bugIndex);
    expect(shell).toContain('new Event(OPEN_BUG_REPORT_EVENT)');
    expect(bugDialog).not.toMatch(/fixed bottom-[^\s]+ right-[^\s]+/);
    expect(bugDialog).not.toContain('useOverlayDock');
  });

  it('普通提醒在信息中心聚合，授权申请同时保留右下角决策浮窗', () => {
    expect(shell).toContain('<SiteNoticeInbox />');
    expect(shell).toContain('id="cds-information-center-host"');
    expect(informationCenter).toContain('<AccessRequestInbox placement="floating" onCountChange={handleAccessCount} />');
    expect(informationCenter).toContain('<AccessRequestInbox />');
    expect(informationCenter).toContain('<PendingImportInbox onCountChange={handleImportCount} />');
    expect(informationCenter).toContain('<GlobalUpdateBadge onCountChange={handleUpdateCount} />');
    expect(informationCenter).toContain('<CommitInbox onCountChange={handleCommitCount} />');
    expect(shell).not.toContain('cds-bottom-docks');
    expect(css).not.toContain('.cds-bottom-docks');
    expect(css).not.toContain('.cds-global-action-stack');
    expect(css).not.toContain('.cds-bottom-left-dock');
    const access = readWeb('components/AccessRequestInbox.tsx');
    expect(access).toContain('data-testid="cds-access-request-floating"');
    expect(access).toContain('fixed bottom-[84px] right-5');
    expect(access).toContain('createPortal');
  });

  it('信息中心宿主通过共享 hook 解析，不在 render 期直接查询', () => {
    const hook = readWeb('lib/useOverlayDock.ts');
    expect(informationCenter).toContain("useOverlayDock('#cds-information-center-host')");
    expect(hook).toMatch(/useEffect\([\s\S]*querySelector/);
    expect(hook).toContain('MutationObserver');
  });

  it('无 AppShell 页面上的 Agent 接入入口仍保持独立定位', () => {
    expect(css).toMatch(/\.cds-agent-access-floating\s*\{[^}]*position: fixed/);
    expect(readWeb('components/GlobalAgentAccess.tsx')).not.toContain('useOverlayDock');
  });
});

describe('页面级 toast', () => {
  it('使用右下角标准留白，不再为已移除的缺陷浮标预留高度', () => {
    expect(bottomRightToastStyle).toEqual({ bottom: '20px', right: '20px' });
  });
});

describe.each(TOAST_PAGES)('%s 的操作反馈 toast', (relative) => {
  const source = readWeb(relative);

  it('不直接重复声明右下角定位值', () => {
    expect(source).not.toMatch(/fixed bottom-5 right-5/);
  });

  it('使用共享的 bottomRightToastStyle', () => {
    expect(source).toContain("import { bottomRightToastStyle } from '@/lib/overlayOffsets';");
    expect(source).toContain('style={bottomRightToastStyle}');
  });
});
