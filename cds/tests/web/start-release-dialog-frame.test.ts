/**
 * start-release-dialog-frame.test.ts —— 2026-07-30 发布弹窗返工（用户五张截图）的判定源。
 *
 * 五张截图对应五类缺陷，每类一段：
 * 1. 长内容把弹窗内容撑宽、右半屏被裁（「输入框不见了」「步骤 2/4/6 消失」）
 *    → Dialog 内层 grid 轨道钉死 minmax(0,1fr)，日志/脚本一律折行。
 * 2. 发布前检查内联整段脚本，「使劲拉才看到下一步」→ 长文案折叠 + frame 布局底栏常驻。
 * 3. 发布中还渲染表单壳 → 改静态摘要。
 * 4. 日志不跟最新 → ReleaseLogPane 吸底 + 离底暂停。
 * 5. 预览地址走前端公式、且不显示上线地址 → API SSOT 优先 + 两端地址都说清。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  branchPreviewUrls,
  collapseCheckMessage,
  releaseTargetPublicUrl,
  resolveReleaseSourceUrls,
  shouldFollowLog,
} from '../../web/src/lib/releaseDialogAddress';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../web/src', rel), 'utf8');

describe('branchPreviewUrls：CDS API 值是 SSOT', () => {
  it('previewUrls 全量透出（一个分支可以有多个公开入口）', () => {
    expect(branchPreviewUrls({
      id: 'prd-agent-main',
      previewUrl: 'https://main-prd-agent.miduo.org',
      previewUrls: ['https://main-prd-agent.miduo.org', 'https://main-prd-agent-llmgw-web.miduo.org/'],
    })).toEqual(['https://main-prd-agent.miduo.org', 'https://main-prd-agent-llmgw-web.miduo.org']);
  });

  it('previewUrls 缺席时退回单值 previewUrl；都缺时为空数组而不是编一个', () => {
    expect(branchPreviewUrls({ id: 'b', previewUrl: 'https://x.example.org' })).toEqual(['https://x.example.org']);
    expect(branchPreviewUrls({ id: 'b' })).toEqual([]);
    expect(branchPreviewUrls(undefined)).toEqual([]);
  });
});

describe('resolveReleaseSourceUrls：promote 钉死值 > API 值 > 公式兜底', () => {
  const branch = { id: 'b', previewUrl: 'https://api-says.example.org' };

  it('promote 带来的产物地址优先——那次发布验证过的就是它', () => {
    expect(resolveReleaseSourceUrls({ intentPreviewUrl: 'https://pinned.example.org', branch, fallbackUrl: 'https://formula.example.org' }))
      .toEqual(['https://pinned.example.org']);
  });

  it('普通发布用 API 值，公式只在 API 缺席时兜底', () => {
    expect(resolveReleaseSourceUrls({ branch, fallbackUrl: 'https://formula.example.org' }))
      .toEqual(['https://api-says.example.org']);
    expect(resolveReleaseSourceUrls({ branch: { id: 'b' }, fallbackUrl: 'https://formula.example.org' }))
      .toEqual(['https://formula.example.org']);
  });

  it('什么都没有就是空数组，交给发布前检查说话', () => {
    expect(resolveReleaseSourceUrls({ branch: { id: 'b' } })).toEqual([]);
  });
});

describe('releaseTargetPublicUrl：上线地址从 healthcheckUrl 剥 origin', () => {
  it('healthcheckUrl 是完整探测地址，剥出来的是站点入口', () => {
    expect(releaseTargetPublicUrl({ ssh: { healthcheckUrl: 'https://map.ebcone.net/api/version' } }))
      .toBe('https://map.ebcone.net');
  });

  it('缺失或畸形一律空串（显示「未配置」，不编造）', () => {
    expect(releaseTargetPublicUrl({ ssh: { healthcheckUrl: 'not-a-url' } })).toBe('');
    expect(releaseTargetPublicUrl({})).toBe('');
    expect(releaseTargetPublicUrl(undefined)).toBe('');
  });
});

describe('collapseCheckMessage：整段脚本不许常驻屏幕', () => {
  it('多行脚本折叠成首行摘要 + 完整内容', () => {
    const script = '#!/bin/sh\nset -eu\numask 077\n' + 'x'.repeat(500);
    const collapsed = collapseCheckMessage(script);
    expect(collapsed.summary).toBe('#!/bin/sh');
    expect(collapsed.detail).toBe(script);
    expect(collapsed.lineCount).toBe(4);
  });

  it('单行超长同样折叠，摘要截断', () => {
    const long = 'a'.repeat(300);
    const collapsed = collapseCheckMessage(long);
    expect(collapsed.summary.length).toBeLessThanOrEqual(161);
    expect(collapsed.detail).toBe(long);
  });

  it('普通短文案原样一行，没有 detail 也就没有展开按钮', () => {
    const collapsed = collapseCheckMessage('main 正在运行');
    expect(collapsed).toEqual({ summary: 'main 正在运行', lineCount: 1 });
  });
});

describe('shouldFollowLog：贴底才跟随，翻上去就停', () => {
  it('距底 ≤48px 视为在看最新', () => {
    expect(shouldFollowLog(952, 2000, 1000)).toBe(true);
    expect(shouldFollowLog(1000, 2000, 1000)).toBe(true);
  });

  it('翻上去超过阈值就暂停跟随', () => {
    expect(shouldFollowLog(500, 2000, 1000)).toBe(false);
  });
});

describe('接线守卫：判定真的被页面消费', () => {
  const dialogPrimitive = read('components/ui/dialog.tsx');
  const startDialog = read('pages/release-center/StartReleaseDialog.tsx');
  const sharedSource = read('pages/release-center/shared.tsx');
  const logDialog = read('pages/release-center/dialogs.tsx');

  it('Dialog 内层 grid 轨道钉死 minmax(0,1fr)——长内容不许把弹窗撑宽', () => {
    expect(dialogPrimitive).toContain("gridTemplateColumns: 'minmax(0, 1fr)'");
  });

  it('发布弹窗走 frame 布局：底栏在滚动区之外，不会被长内容推走', () => {
    expect(startDialog).toMatch(/<DialogContent\s+frame/);
    expect(startDialog).toContain('DialogBody');
  });

  it('来源地址走 resolveReleaseSourceUrls（API SSOT 优先），且展示上线地址', () => {
    expect(startDialog).toContain('resolveReleaseSourceUrls');
    expect(startDialog).toContain('releaseTargetPublicUrl');
    expect(startDialog).toContain('发布到（上线地址）');
  });

  it('发布前检查的长文案走 collapseCheckMessage 折叠', () => {
    expect(startDialog).toContain('collapseCheckMessage');
    expect(startDialog).toContain('展开完整内容');
  });

  it('发布中不再渲染分支下拉：运行态是静态摘要', () => {
    // 旧版靠 disabled 让下拉在发布中失效，但长日志一撑宽它就被裁掉一半。
    // 新版运行态压根不渲染表单，也就不存在 disabled 的下拉。
    expect(startDialog).not.toContain('disabled={Boolean(run)}');
  });

  it('两个弹窗共用 ReleaseLogPane：自动吸底 + 长行折行', () => {
    expect(sharedSource).toContain('function ReleaseLogPane');
    expect(sharedSource).toContain('shouldFollowLog');
    expect(sharedSource).toContain('whitespace-pre-wrap break-all');
    expect(sharedSource).toContain('回到最新');
    expect(startDialog).toContain('<ReleaseLogPane');
    expect(logDialog).toContain('<ReleaseLogPane');
    // 裸 <pre 只允许出现在「展开完整内容」的折叠详情里，日志一律走共享窗格。
    expect(logDialog).not.toMatch(/<pre[\s>]/);
  });

  it('分支选项类型声明了 previewUrl / previewUrls（API 下发的 SSOT 字段）', () => {
    const types = read('pages/release-center/types.ts');
    expect(types).toMatch(/previewUrl\?: string;[\s\S]{0,200}previewUrls\?: string\[\];/);
  });
});
