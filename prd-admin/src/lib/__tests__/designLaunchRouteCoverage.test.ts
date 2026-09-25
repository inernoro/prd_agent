/**
 * 「用这份内容生成」入口的路由守卫。
 *
 * 入口一多，最容易出的错不是哪颗按钮写错，而是**某个入口指向一条没人注册、
 * 或注册了却没人消费深链的路由**：页面照常渲染、测试照常绿，用户点过去落到 404
 * 或一张不认识来源的空工作台（predicate-and-wiring-discipline 形状 2）。
 *
 * 所以这里锁三件事：
 *   1. 每个生成目标的落点路由都在 NAV_REGISTRY 里真实注册；
 *   2. 落点页真的解析深链（parseDesignArtifactLaunch）；
 *   3. 深链只由一处构造——任何页面都不许手拼 `designTarget=` 或绕过共享入口直接调构造函数，
 *      否则 1、2 核对的那一处就不再是全部入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_REGISTRY } from '@/app/navRegistry';
import {
  DESIGN_ARTIFACT_TARGETS,
  designArtifactLaunchPathname,
  type DesignArtifactTarget,
} from '@/lib/designArtifactLaunch';
import { buildGenerateLaunchPath } from '@/components/design-launch/designLaunchAgents';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 每个目标由哪个文件消费深链。Record 保证新增目标时必须在这里登记消费方。 */
const LAUNCH_CONSUMERS: Record<DesignArtifactTarget, string> = {
  'web-page': 'pages/WebPagesPage.tsx',
  'html-ppt': 'pages/md-to-ppt-agent/sessionContext.ts',
};

/** 允许直接调用深链构造函数的文件：定义处 + 共享入口。 */
const BUILDER_ALLOWLIST = new Set([
  'lib/designArtifactLaunch.ts',
  'components/design-launch/designLaunchAgents.ts',
]);

/** 必须挂着共享入口的页面：删掉任何一处接线，这里会红。 */
const REQUIRED_ENTRY_SURFACES = [
  'pages/document-store/DocumentStorePage.tsx',
  'pages/document-store/RecordingResultPage.tsx',
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === '__tests__' || item.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(item.name) && !/\.test\.(ts|tsx)$/.test(item.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = listSourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

describe('生成入口不指向幻影路由', () => {
  it.each([...DESIGN_ARTIFACT_TARGETS])('%s 的落点路由已在 NAV_REGISTRY 注册', (target) => {
    const pathname = designArtifactLaunchPathname(target);
    const built = buildGenerateLaunchPath(target, { storeId: 's', entryId: 'e', title: 't' });
    expect(built.slice(0, built.indexOf('?'))).toBe(pathname);
    const entry = NAV_REGISTRY.find((item) => item.path === pathname);
    expect(entry, `${target} 指向 ${pathname}，但它没有在 NAV_REGISTRY 注册`).toBeDefined();
    expect(entry?.element).toBeTruthy();
  });

  it.each([...DESIGN_ARTIFACT_TARGETS])('%s 的落点页真的解析深链', (target) => {
    const consumer = sources.find((file) => file.rel === LAUNCH_CONSUMERS[target]);
    expect(consumer, `找不到 ${target} 的深链消费方 ${LAUNCH_CONSUMERS[target]}`).toBeDefined();
    expect(consumer?.text).toContain('parseDesignArtifactLaunch(');
  });
});

describe('深链只有一处构造', () => {
  it('除定义处与共享入口外，没有文件直接调用深链构造函数', () => {
    const offenders = sources
      .filter((file) => !BUILDER_ALLOWLIST.has(file.rel) && file.text.includes('buildDesignArtifactLaunchPath('))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('没有文件手拼 designTarget 查询参数', () => {
    const offenders = sources
      .filter((file) => file.rel !== 'lib/designArtifactLaunch.ts' && /designTarget=/.test(file.text))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it.each(REQUIRED_ENTRY_SURFACES)('%s 挂着共享的生成入口', (rel) => {
    const file = sources.find((item) => item.rel === rel);
    expect(file).toBeDefined();
    expect(file?.text).toContain('<GenerateFromContentDialog');
  });
});

describe('共享生成弹窗在窄屏可用', () => {
  it('走 ResponsiveDialog（窄屏换底部面板），不直接用居中 Dialog', () => {
    // 居中 Dialog 的标题区不收缩，长描述会把弹窗撑出 390px 视口、关闭按钮落到屏幕外
    const dialog = sources.find((file) => file.rel === 'components/design-launch/GenerateFromContentDialog.tsx');
    expect(dialog).toBeDefined();
    expect(dialog?.text).toContain("from '@/components/ui/ResponsiveDialog'");
    expect(dialog?.text).not.toMatch(/<Dialog\b/);
  });
});

describe('录音页生成入口接上了页内校对状态', () => {
  it('跟读组件上报校对状态，且它进了生成挡板', () => {
    // 删掉任一端，挡板照常绿、生成照常能点——带走的却是还没存上去的旧正文
    const page = sources.find((file) => file.rel === 'pages/document-store/RecordingResultPage.tsx');
    expect(page?.text).toContain('onEditActivityChange={setTranscriptEditActivity}');
    expect(page?.text).toContain('editActivity: transcriptEditActivity');
    expect(page?.text).toContain('reorganizing: running !== null || launchingStyle !== null');
  });
});
