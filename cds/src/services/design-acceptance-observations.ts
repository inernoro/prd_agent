import type { Page } from 'playwright';
import type { DesignRule, DesignTheme } from '../shared/design-workspace.js';
import type { DesignVisualCheck, DesignVisualChecks } from '../shared/design-visual.js';
import { measureDesignTextContrast } from './design-text-contrast.js';

export async function measureDesignPage(page: Page, theme?: DesignTheme) {
  const layout = await page.evaluate(() => {
    const dom = {
      visible(element: Element) {
        return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
          && (!element.checkVisibility || element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }));
      },
      find(selector: string) {
        return Array.from(document.querySelectorAll(selector)).find(dom.visible);
      },
      read(element?: Element) {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(value => Math.round(value * 10) / 10);
      },
      spread(numbers: number[]) {
        return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : 0;
      },
      columns(element?: Element) {
        return element ? getComputedStyle(element).gridTemplateColumns.split(' ').length : 0;
      },
    };
    const head = dom.find('.dw-head--draft,.dw-head--v3,.dw-library-top,.dw-library-head,.dw-library-bar');
    const tabs = dom.find('.dw-tablinks');
    const surface = dom.find('.dw-workspace,main');
    const layers = [
      dom.read(head), dom.read(tabs), dom.read(surface),
      dom.read(dom.find('[role=dialog], details[open] .dw-info-panel, .dw-skills[open] > .dw-skill-guide, .dw-overlay')),
      dom.read(dom.find('.dw-draft-footer, main > footer')),
    ];
    const headerControls = Array.from(document.querySelectorAll('.dw-tablinks > button,.dw-draft-actions > *, .dw-head-actions > *')).filter(dom.visible);
    const controls = headerControls.map(element => element.getBoundingClientRect());
    const headerAlignment = controls.length > 1 ? Math.max(dom.spread(controls.map(box => box.top)),
      dom.spread(controls.map(box => box.bottom)), dom.spread(controls.map(box => box.height))) : null;
    const scrolling = Array.from(document.querySelectorAll('main,main *')).filter(element => {
      const style = getComputedStyle(element);
      return ['scroll', 'auto'].includes(style.overflowY) && dom.visible(element) && element.scrollHeight > element.clientHeight + 1;
    });
    const width = document.documentElement.clientWidth;
    const content = document.documentElement.scrollWidth;
    const body = surface instanceof HTMLElement ? surface.innerText.slice(0, 90_000) : '';
    const textControls = Array.from((surface ?? document).querySelectorAll('button, summary, [role=tab]'))
      .filter(element => dom.visible(element) && !element.closest('[aria-hidden=true]'));
    const clippedControls = textControls.filter(element => {
      const label = element.querySelector('span') ?? element;
      const style = getComputedStyle(label);
      return label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1
        && ['clip', 'hidden'].includes(style.overflowX) && style.textOverflow !== 'ellipsis';
    }).length;
    const causeCards = Array.from(document.querySelectorAll('.dw-ac-cards > li')).filter(dom.visible);
    const causeNames = causeCards.map(element => element.querySelector('strong')?.textContent ?? '');
    const compare = ['对比左侧版本', '对比右侧版本'].map(label =>
      (dom.find('select[aria-label="' + label + '"]') as HTMLSelectElement | undefined)?.value);
    const feedback = Array.from(document.querySelectorAll('.dw-dl-items > li[data-item]')).filter(dom.visible)
      .map(element => element.getAttribute('data-item'));
    const cards = Array.from(document.querySelectorAll('.dw-card-grid .dw-design-card')).filter(dom.visible);
    const currentScreen = dom.find('.dw-frame')?.getAttribute('data-screen');
    const selectedStep = dom.find('.dw-sp-thumbs [aria-current=step]')?.getAttribute('data-screen');
    const stepNumber = Number(dom.find('[data-sec="flow"] h3 small')?.textContent?.split('/')[0] ?? 0);
    return {
      layers, headerAlignment, width, content, vertical: scrolling.length + Number(document.documentElement.scrollHeight > innerHeight + 1),
      clippedControls, textControls: textControls.length, height: innerHeight,
      scrollHeight: Math.max(document.documentElement.scrollHeight, ...scrolling.map(element => element.scrollHeight)),
      raw: body.split('\n').filter(line => /^\s*(?:#{1,6}\s+|\{\s*"\w+"\s*:|Bearer\s+\S{20,})/.test(line)).length,
      frame: dom.read(dom.find('.dw-frame')), title: dom.read(dom.find('.dw-crumb-draft strong,.dw-crumb-title strong')),
      currentStep: Boolean(currentScreen && selectedStep === currentScreen),
      stepNumber,
      causes: causeNames.map(name => ({ length: [...name].length, measurement: /\d+(\.\d+)?\s*(px|ms)\b/.test(name) })),
      hero: Boolean(dom.find('.dw-ac-hero')), methods: document.querySelectorAll('.dw-ac-mcards > li').length,
      compare, feedback,
      columns: dom.columns(dom.find('.dw-card-grid:has(.dw-design-card)')), frameworkColumns: dom.columns(dom.find('.dw-fw-strip > div')),
      clippedCards: cards.filter(element => element.scrollWidth > element.clientWidth + 1).length,
    };
  });
  const darkText = theme === 'dark' ? await measureDesignTextContrast(page)
    .catch(() => ({ measured: 0, low: 0, unknown: 1, media: 0, lowest: null })) : undefined;
  return { ...layout, ...(darkText ? { darkText } : {}) };
}

type Observation = Awaited<ReturnType<typeof measureDesignPage>>;
const verdict = (passed: boolean, evidence: string): DesignVisualCheck => ({ status: passed ? 'passed' : 'failed', evidence });

function darkContrastCheck(contrast: Observation['darkText'], useDarkCapture: boolean): DesignVisualCheck {
  if (!contrast) return useDarkCapture
    ? { status: 'missing', evidence: '待核对同一画面和视口的深色实拍。', useDarkCapture: true }
    : { status: 'missing', evidence: '此图位尚无深色正文测量。' };
  const measured = `深色正文实测 ${contrast.measured} 处，${contrast.low} 处低于 4.5。最低 ${contrast.lowest?.toFixed(2) ?? '未测得'}。`;
  const pending = `另有 ${contrast.unknown} 处正文和 ${contrast.media} 处图片或嵌入画面待核对。`;
  if (contrast.low) return { status: 'failed', evidence: measured + pending };
  if (!contrast.measured || contrast.unknown || contrast.media) return { status: 'missing', evidence: measured + pending };
  return { status: 'passed', evidence: measured + '当前可视区域的正文背景均已核对。' };
}

export function compareDesignObservations(expected: Observation, actual: Observation, pixelDifference: number, useDarkCapture = false): DesignVisualChecks {
  const regions = ['页头', '标签', '主体', '浮层', '底部'];
  const deltas = actual.layers.map((actualBox, index) => {
    const reference = expected.layers[index];
    return actualBox && reference ? Math.round(Math.max(...actualBox.map((value, coordinate) =>
      Math.abs(value - reference[coordinate]))) * 10) / 10 : actualBox === reference ? 0 : null;
  });
  const positions = regions.map((region, index) => actual.layers[index] === null && expected.layers[index] === null
    ? `${region}在两侧均未定位` : `${region}${deltas[index] === null ? '只在一侧显示' : `偏差 ${deltas[index]} px`}`).join('，');
  return {
    'V-01': {
      status: deltas.some(delta => delta === null || delta > 1) ? 'failed' : pixelDifference === 0 ? 'passed' : 'missing',
      evidence: `${positions}。相同视口像素差 ${pixelDifference.toFixed(2)}%。${pixelDifference > 0 ? '差异区域待按设计依据核对。' : ''}`,
    },
    'V-02': actual.headerAlignment !== null ? verdict(actual.headerAlignment <= 1,
      `同一行页头按钮顶边、底边和高度的最大差为 ${actual.headerAlignment.toFixed(1)} px。`) :
      { status: 'missing', evidence: '未定位可配对的同一行控件。' },
    'V-03': actual.clippedControls > 0 ? verdict(false, `扫描 ${actual.textControls} 个可见控件，${actual.clippedControls} 个出现文字裁切。`) :
      { status: 'missing', evidence: `扫描 ${actual.textControls} 个可见控件，文字裁切 0 处。浮层遮挡和断词待核对。` },
    'V-04': verdict(actual.content <= actual.width && actual.vertical <= 1,
      `文档可用宽度 ${actual.width} px，内容宽 ${actual.content} px，纵向滚动区 ${actual.vertical} 个。`),
    'V-05': actual.raw ? verdict(false, `主体扫描发现 ${actual.raw} 行疑似原样 Markdown、JSON 或凭据。`) :
      { status: 'missing', evidence: '文本扫描未发现 Markdown、JSON 或凭据前缀。内部编号和转义内容待核对。' },
    'V-06': { status: 'missing', evidence: '同数据图已生成，名称与徽标数量的逐处一致性待核对。' },
    'V-07': darkContrastCheck(actual.darkText, useDarkCapture),
    'V-08': { status: 'missing', evidence: `已取 ${actual.width} × ${actual.height} 的图。Windows 两档缩放与手机状态待关联。` },
    'V-09': { status: 'missing', evidence: '已进入当前声明的状态。空、加载、异常和权限场景的覆盖待核对。' },
    'V-10': actual.scrollHeight > actual.height * 10 ? verdict(false, `内容高 ${actual.scrollHeight} px，超过当前视口的十屏。`) :
      { status: 'missing', evidence: `内容高 ${actual.scrollHeight} px，当前视口高 ${actual.height} px，长标题与数据规模覆盖待核对。` },
  };
}

export function observeDesignRules(rules: DesignRule[], value: Observation) {
  const results: Record<string, { status: 'passed' | 'failed' | 'unverified'; actual: string }> = {};
  const put = (id: string, ok: boolean, actual: string) => { results[id] = { status: ok ? 'passed' : 'failed', actual }; };
  for (const rule of rules) {
    const { id, screenId } = rule;
    const head = value.layers[0];
    if (screenId === 'dsn-preview' && id === 'A-03' && head) {
      const text = `页头高 ${head[3]} px，同排控件边缘高度差 ${value.headerAlignment ?? '未测得'}，标题${value.title ? '位于' : '未出现在'}面包屑。`;
      if (head[3] > 48 || !value.title) put(id, false, text);
      else results[id] = { status: 'unverified', actual: text + '画布工具的相对位置仍待核对。' };
    } else if (screenId === 'dsn-diff-base' && id === 'A-34') {
      const text = `画布版本选择测得左 V${value.compare[0] || '未找到'}、右 V${value.compare[1] || '未找到'}，预期左 V2、右 V4。`;
      if (value.compare[0] !== '2' || value.compare[1] !== '4') put(id, false, text);
      else results[id] = { status: 'unverified', actual: text + '快捷入口和变化计数仍待核对。' };
    } else if (screenId === 'dsn-long' && id === 'A-26' && head) {
      const text = `1280 宽下页头高 ${head[3]} px，面包屑标题宽 ${value.title?.[2] ?? 0} px。`;
      if (head[3] > 48 || (value.title?.[2] ?? 0) < 160) put(id, false, text);
      else results[id] = { status: 'unverified', actual: text + '缩放与标题全文仍待核对。' };
    } else if (screenId === 'dsn-delivery-thread' && id === 'A-39') {
      const text = `反馈前两项依次为 ${value.feedback.slice(0, 2).join('、') || '未找到'}，预期诉求和完成标准。`;
      if (value.feedback[0] !== 'ask' || value.feedback[1] !== 'done') put(id, false, text);
      else results[id] = { status: 'unverified', actual: text + '历史、回复和处理确认仍待核对。' };
    } else if (screenId === 'design-m' && id === 'A-46') {
      const row = `稿件 ${value.columns} 列，框架 ${value.frameworkColumns} 列，文档横向溢出 ${value.content - value.width} px，${value.clippedCards} 张稿件卡超宽。`;
      if (value.columns !== 2 || value.frameworkColumns > 1 || value.content > value.width || value.clippedCards > 0) put(id, false, row);
      else results[id] = { status: 'unverified', actual: row + '状态和日期的断行仍待核对。' };
    } else if (screenId === 'dsn-open-m' && id === 'A-72' && value.frame) {
      const [, , width, height] = value.frame;
      const startsAtFirst = !rule.expected?.includes('demoIndex') || value.stepNumber === 1;
      put(id, width < height && height >= 360 && value.currentStep && startsAtFirst,
        `默认画布 ${width} × ${height} px，演示显示第 ${value.stepNumber} 步，当前画面${value.currentStep ? '已' : '未'}高亮。`);
    } else if (screenId === 'dsn-accept' && id === 'A-64') {
      const valid = value.causes.length <= 6 && value.causes.every(cause => cause.length <= 30 && !cause.measurement);
      const text = `原因卡 ${value.causes.length} 张，验收手段 ${value.methods} 个，${value.hero ? '有' : '缺'}总览结论。`;
      if (!valid || !value.hero || value.methods !== 8) put(id, false, text);
      else results[id] = { status: 'unverified', actual: text + '六区顺序和操作行为仍待复核。' };
    } else if (rule.probe?.type === 'horizontal-overflow') {
      const fits = value.content <= value.width + (rule.probe.tolerance ?? 0);
      const text = `文档宽 ${value.width} px，内容宽 ${value.content} px。`;
      if (fits && rule.expected?.includes('overflowCount')) {
        results[id] = { status: 'unverified', actual: text + '容器溢出与内部布局尚待测量。' };
      } else put(id, fits, text);
    } else {
      results[id] = { status: 'unverified', actual: id === 'A-70'
        ? '已生成浏览器图证。需在真机 iPhone Safari 运行五次刷新。'
        : '已生成同条件图证。这条规则尚无完整的程序检查，继续核对验收标准。' };
    }
  }
  return results;
}
