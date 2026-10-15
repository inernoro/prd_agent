import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMapLoginTarget, openGatewayLogicalModelDetails, selectGatewayImageLogicalModel, validateMapLoginSnapshot } from '../../e2e/utils/stableSmokeUiContract.mjs';
import { createStableSmokeVisualEvidence } from '../../e2e/utils/stableSmokeVisualEvidence.mjs';

const passwordSnapshot = { headingCount: 1, hasBrand: true, usernameCount: 1, passwordCount: 1, submitCount: 1, ssoCount: 0 };

test('登录页不依赖已删除的 login-card；账号表单和仅SSO均可核验，残缺入口变红', async () => {
  assert.deepEqual(validateMapLoginSnapshot(passwordSnapshot), { authenticationMethods: ['password'] });
  assert.deepEqual(validateMapLoginSnapshot({ ...passwordSnapshot, usernameCount: 0, passwordCount: 0, submitCount: 0, ssoCount: 1 }), { authenticationMethods: ['sso'] });
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, headingCount: 2 }), /唯一/);
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, passwordCount: 0 }), /完整表单/);
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, usernameCount: 0, passwordCount: 0, submitCount: 0 }), /没有可用/);
  const target = { waitFor: async () => {}, count: async () => 1, evaluate: async () => passwordSnapshot };
  const page = {
    url: () => 'https://fixture.test/login', locator: () => ({}),
    getByRole: (role, options) => {
      assert.equal(role, 'heading'); assert.deepEqual(options, { name: '欢迎回来', exact: true });
      return { and: () => ({ waitFor: async () => {}, count: async () => 1, locator: (selector) => { assert.match(selector, /ancestor::div/); return target; } }) };
    },
    getByTestId: () => { throw Error('旧 login-card 不再是部署合同'); },
  };
  assert.equal((await getMapLoginTarget(page)).target, target);
  await assert.rejects(() => getMapLoginTarget({ ...page, url: () => 'https://fixture.test/' }), /真实登录页/);
});

test('真实LoginCard的SSO使用href井号与点击桥接，按显式可用属性识别而不是误判为坏链接', async () => {
  const originalStyle = globalThis.getComputedStyle;
  const visibleNode = (textContent) => ({ textContent, title: textContent, getBoundingClientRect: () => ({ width: 100, height: 30 }) });
  const element = {
    textContent: 'MAP Admin 欢迎回来 米多星球登录',
    querySelectorAll: (selector) => selector === 'h1' ? [visibleNode('欢迎回来')]
      : selector === 'a[href][aria-disabled="false"]' ? [visibleNode('米多星球登录')] : [],
  };
  const target = { waitFor: async () => {}, count: async () => 1, evaluate: async (probe) => probe(element) };
  const page = {
    url: () => 'https://fixture.test/login', locator: () => ({}),
    getByRole: () => ({ and: () => ({ waitFor: async () => {}, count: async () => 1, locator: () => target }) }),
  };
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    assert.deepEqual((await getMapLoginTarget(page)).authenticationMethods, ['sso']);
  } finally {
    if (originalStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalStyle;
  }
});

function model(publicId, overrides = {}) {
  return { id: publicId, publicId, modelType: 'generation', enabled: true, offerings: [{ enabled: true }], ...overrides };
}

test('图片模型来自真实API身份，不硬编码 default-generation、不用停用或无Offering配置顶替', () => {
  const selected = model('peach.v2+real', { isDefaultForType: true });
  assert.equal(selectGatewayImageLogicalModel([model('default-generation', { enabled: false }), model('other'), selected]), selected);
  assert.throws(() => selectGatewayImageLogicalModel([model('default-generation', { offerings: [] })]), /未找到/);
  assert.throws(() => selectGatewayImageLogicalModel([model('a', { modelType: 'chat' })]), /未找到/);
  assert.throws(() => selectGatewayImageLogicalModel([model('same'), model('same')]), /publicId 重复/);
});

function gatewayPage({ layout = 'inline', publicId = 'peach.v2+real', ids = ['peachXv2real', 'peach.v2+real-old', 'peach.v2+real'], detailIdentity = publicId, routes = 1, searchCount } = {}) {
  const calls = [];
  let expanded = false;
  let query = '';
  const node = (count = 1) => ({
    count: async () => count,
    waitFor: async () => { assert.ok(count > 0, 'required UI node missing'); },
  });
  const routeDetails = { ...node(routes), first: () => node(routes) };
  const detail = {
    ...node(), locator: (selector) => {
      if (selector === '.lg-logical-model-route-detail') return routeDetails;
      assert.equal(selector, 'header code');
      return { filter: ({ hasText }) => node(hasText.test(detailIdentity) ? 1 : 0) };
    }, getByRole: (role, options) => {
      assert.equal(role, 'button'); assert.equal(options.name, '上游线路');
      return { ...node(), getAttribute: async () => 'true' };
    },
  };
  const list = {
    ...node(), and: () => list,
    getByRole: (role, options) => {
      if (role === 'combobox') return { ...node(), selectOption: async value => { assert.equal(value, ''); calls.push('filter:all'); } };
      assert.equal(role, 'searchbox'); assert.equal(options.name, '搜索模型名称或公开标识');
      return { ...node(searchCount ?? (layout === 'collection-pane' ? 1 : 0)), fill: async value => { query = value; calls.push(`search:${value}`); } };
    },
    locator: (selector) => {
      assert.equal(selector, '.lg-logical-model-grid:not(.lg-logical-model-heading)');
      return { filter: ({ has }) => {
        const matching = ids.filter(id => (!query || id.includes(query)) && has.idRegex.test(has.legacy ? `${id} · 所有应用` : id));
        const row = {
          ...node(matching.length), locator: selector => { assert.equal(selector, '..'); return detail; },
          getByRole: (role, options) => {
            assert.equal(role, 'button'); assert.equal(options.exact, true);
            const actual = expanded ? '收起' : layout === 'collection-pane' ? '查看' : '展开';
            return { ...node(options.name === actual ? matching.length : 0),
              click: async () => { assert.equal(options.name, actual); expanded = true; calls.push(`open:${matching[0]}`); },
              getAttribute: async name => { assert.equal(name, 'aria-expanded'); return expanded ? 'true' : 'false'; },
            };
          },
        };
        return row;
      } };
    },
  };
  return {
    calls,
    page: {
      url: () => 'https://fixture.test/logical-models',
      locator: selector => {
        if (selector === '.lg-logical-model-list') return list;
        if (selector === ':visible') return {};
        assert.equal(selector, 'code'); return { filter: ({ hasText }) => ({ idRegex: hasText }) };
      },
      getByText: regex => ({ idRegex: regex, legacy: true }),
      getByRole: (role, options) => { assert.equal(role, 'complementary'); assert.equal(options.name, '清单详情'); return detail; },
    },
  };
}

test('65347c 行内展开与新清单详情各走真实按钮，publicId精确匹配不误点前缀或正则近似行', async () => {
  for (const layout of ['inline', 'collection-pane']) {
    const fixture = gatewayPage({ layout });
    const result = await openGatewayLogicalModelDetails(fixture.page, model('peach.v2+real'));
    assert.equal(result.publicId, 'peach.v2+real'); assert.equal(result.layout, layout);
    assert.deepEqual(fixture.calls, layout === 'inline'
      ? ['open:peach.v2+real'] : ['search:peach.v2+real', 'filter:all', 'open:peach.v2+real']);
  }
});

test('模型重复、详情张冠李戴、空Offering和重复搜索入口都变红，不退到第一行或整页', async () => {
  const duplicate = gatewayPage({ ids: ['peach.v2+real', 'peach.v2+real'] });
  await assert.rejects(() => openGatewayLogicalModelDetails(duplicate.page, model('peach.v2+real')), /唯一/);
  const wrong = gatewayPage({ layout: 'collection-pane', detailIdentity: 'default-generation' });
  await assert.rejects(() => openGatewayLogicalModelDetails(wrong.page, model('peach.v2+real')), /missing/);
  const empty = gatewayPage({ routes: 0 });
  await assert.rejects(() => openGatewayLogicalModelDetails(empty.page, model('peach.v2+real')), /missing/);
  const ambiguous = gatewayPage({ layout: 'collection-pane', searchCount: 2 });
  await assert.rejects(() => openGatewayLogicalModelDetails(ambiguous.page, model('peach.v2+real')), /搜索入口重复/);
});

test('REC-006保留真实局部主题门禁：暗色计划配浅色测量必须红，不靠metadata迁就', async () => {
  const parent = process.env.STABLE_SMOKE_UI_CONTRACT_TMP || tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'ui-contract-theme-'));
  const outputPath = join(root, 'evidence');
  const planPath = join(root, 'plan.json');
  const slotId = 'CDS-VISUAL-RECORDING-AUDIO-02';
  const slot = { slotId, environment: 'cds', module: '录音', primaryState: '录音', coverageStates: ['录音'],
    testType: '视觉', theme: 'dark', viewportClass: 'desktop', methodAnchor: '#recording',
    breadcrumb: 'CDS → 首页 → 知识库 → 录音', pageOrigin: 'https://fixture.test', entryPath: '/document-store', expectedProof: '局部录音面板真实暗色可读' };
  const runId = 'stsmk-ui-contract-test';
  const commit = 'a'.repeat(40);
  writeFileSync(planPath, JSON.stringify({ runId, commit, captureStartedAt: '2026-01-01T00:00:00Z', slots: [slot] }));
  const environment = { STABLE_SMOKE_ENVIRONMENT: 'cds', STABLE_SMOKE_RUN_ID: runId, STABLE_SMOKE_COMMIT: commit,
    STABLE_SMOKE_VISUAL_PLAN: planPath, STABLE_SMOKE_VISUAL_OUTPUT: outputPath };
  const target = { waitFor: async () => {}, count: async () => 1 };
  const page = { url: () => 'https://fixture.test/document-store' };
  let actualTheme = 'light';
  const capture = createStableSmokeVisualEvidence({ environment, harnessLoader: async () => ({
    box: async () => {}, clearBoxes: async () => {},
    shot: async (_page, output, name, caption, options) => {
      assert.equal(options.themeTarget, target);
      const { themeTarget: _target, ...metadata } = options;
      const path = join(output, `${name}.png`); writeFileSync(path, 'isolated fixture');
      return { ...metadata, name, caption, path, theme: actualTheme, themeProbe: 'target', viewportClass: 'desktop',
        pageOrigin: slot.pageOrigin, pagePath: slot.entryPath, automatedStatus: '通过', capturedAt: new Date().toISOString() };
    },
  }) });
  try {
    await assert.rejects(() => capture(page, undefined, { slotId, target, themeTarget: target }), /theme 不一致.*dark.*light/);
    assert.equal(existsSync(join(outputPath, 'manifest.json')), false);
    actualTheme = 'dark';
    const result = await capture(page, undefined, { slotId, target, themeTarget: target });
    assert.equal(result.record.theme, 'dark');
    assert.equal(JSON.parse(readFileSync(join(outputPath, 'manifest.json'), 'utf8'))[0].themeProbe, 'target');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
