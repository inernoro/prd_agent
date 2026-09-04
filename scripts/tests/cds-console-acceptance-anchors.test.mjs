import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const script = read('scripts/smoke/cds-console-acceptance.mjs');
const appShell = read('cds/web/src/components/layout/AppShell.tsx');

/** 把 PAGES 里的 key/anchor 逐条抠出来（只读源码，不执行——它会起浏览器）。 */
function pages() {
  const block = script.slice(script.indexOf('const PAGES = ['), script.indexOf('const VIEWPORTS = ['));
  return [...block.matchAll(/key:\s*'([^']+)'[\s\S]*?anchor:\s*'([^']+)'/g)].map((m) => ({ key: m[1], anchor: m[2] }));
}

/**
 * 外壳常驻文案：左侧 rail 的短标签。这些字在每条路由上都渲染，
 * 拿它们当锚点等于「路由渲不渲染都命中」。
 */
function shellLabels() {
  return new Set([...appShell.matchAll(/cds-rail-short">([^<{]+)</g)].map((m) => m[1].trim()));
}

/** PAGES 的 key 与页面组件文件名的对应关系。改路由时这张表要跟着改。 */
const PAGE_SOURCE = {
  'project-list': 'cds/web/src/pages/ProjectListPage.tsx',
  'branch-list': 'cds/web/src/pages/BranchListPage.tsx',
  'cds-settings': 'cds/web/src/pages/CdsSettingsPage.tsx',
  'release-center': 'cds/web/src/pages/ReleaseCenterPage.tsx',
};

test('CDS 控制台验收的锚点不许与外壳导航重名', () => {
  // 这条守的是同一个洞的 CDS 版：MAP 那边 /web-pages 的锚点写「网页托管」，
  // 而导航项 label 逐字相同，于是那条路由渲不渲染都命中，判据形同虚设。
  const labels = shellLabels();
  assert.ok(labels.size >= 8, `AppShell 只解析出 ${labels.size} 个导航标签，解析多半失效了`);

  const found = pages();
  assert.ok(found.length >= 4, `只解析出 ${found.length} 条锚点，解析多半失效了`);

  for (const { key, anchor } of found) {
    assert.ok(!labels.has(anchor), `锚点「${anchor}」(${key}) 与外壳导航项同名——路由不渲染也会命中`);
  }
});

test('CDS 控制台验收的锚点必须出现在它声称的那个页面组件里', () => {
  // 锚点写错字、或页面文案改了而锚点没跟着改，都会变成「等 25 秒然后假红」。
  // 这条让那种漂移在 CI 上当场红，而不是等第二天例程失败才发现。
  //
  // 注意这只是必要条件：源码里有这个字符串，不代表默认状态下一定渲染得出来
  // （predicate-and-wiring-discipline 形状 8）。真正的证明只有例程真的跑一遍。
  for (const { key, anchor } of pages()) {
    const src = PAGE_SOURCE[key];
    assert.ok(src, `PAGES 里的 ${key} 没登记对应页面组件——新增路由时要同步这张表`);
    const body = read(src);
    assert.ok(
      body.includes(anchor),
      `锚点「${anchor}」在 ${src} 里找不到——要么写错了，要么页面文案改了而锚点没跟着改`,
    );
  }
});

test('生产控制台上不许出现写操作：向导只走到步骤 04 的渲染为止', () => {
  // 步骤 04 的「生成我的上手包」会调 POST /api/projects/:id/agent-profile。
  // 这条守卫让「顺手把最后一步也点了」在 CI 上当场红，而不是在生产上留下垃圾数据。
  const block = script.slice(script.indexOf('const WIZARD_STEPS = ['), script.indexOf('async function checkWizardMobile'));
  const steps = [...block.matchAll(/id:\s*'(\d+)'[\s\S]*?advance:\s*(true|false)/g)].map((m) => ({ id: m[1], advance: m[2] === 'true' }));
  assert.ok(steps.length >= 4, `只解析出 ${steps.length} 个向导步骤，解析多半失效了`);

  const last = steps[steps.length - 1];
  assert.equal(last.id, '04', `向导最后一步应停在 04，实际是 ${last.id}`);
  assert.equal(last.advance, false, '步骤 04 不许 advance——那一步会往生产写 agent-profile');
  assert.ok(
    block.includes('生成我的上手包'),
    '步骤 04 的出口文案变了？改了要重新确认它仍然是那个写操作按钮',
  );
});
