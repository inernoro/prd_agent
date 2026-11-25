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
      controlRows(group: Element) {
        const controls = Array.from(group.children).flatMap(child => {
          const control = child.matches('details') ? child.querySelector(':scope > summary')
            : child.matches('button, a[href], input, select, summary, [role="tab"], [role="button"], label:has(input)') ? child : undefined;
          if (!control || !dom.visible(control)) return [];
          const rectangle = control.getBoundingClientRect();
          return rectangle.width > 0 && rectangle.height > 0 ? [rectangle] : [];
        });
        if (controls.length < 2) return [];
        const layout = getComputedStyle(group);
        if (['flex', 'inline-flex'].includes(layout.display) && layout.flexDirection.startsWith('row') && layout.flexWrap === 'nowrap') {
          return [controls];
        }
        const rows: DOMRect[][] = [];
        for (const box of controls.sort((left, right) => left.top - right.top)) {
          const matching = rows.find(([first]) => Math.min(first.bottom, box.bottom) - Math.max(first.top, box.top) > 0);
          if (matching) matching.push(box);
          else rows.push([box]);
        }
        return rows.filter(row => row.length > 1);
      },
    };
    const head = dom.find('.dw-head--draft,.dw-head--v3,.dw-library-top,.dw-library-head,.dw-library-bar');
    const tabs = dom.find('.dw-tablinks');
    const tabControls = Array.from(tabs?.children ?? [])
      .filter(element => element.matches('button, a[href], [role=tab]') && dom.visible(element))
      .map(element => dom.read(element)!);
    const surface = dom.find('.dw-workspace,main');
    const activeDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter(element => dom.visible(element) && !element.closest('[aria-hidden="true"]')).at(-1);
    const layers = [
      dom.read(head), tabControls[0] ?? null, dom.read(surface),
      dom.read(activeDialog ?? dom.find('details[open] .dw-info-panel, .dw-skills[open] > .dw-skill-guide, .dw-overlay')),
      dom.read(dom.find('.dw-draft-footer, main > footer')),
    ];
    const headerRows = Array.from(document.querySelectorAll('.dw-tablinks, .dw-draft-actions, .dw-head-actions, .dw-library-bar .dw-tools'))
      .flatMap(group => dom.controlRows(group));
    const headerAlignment = headerRows.length ? Math.max(...headerRows.map(row => Math.max(dom.spread(row.map(box => box.top)),
      dom.spread(row.map(box => box.bottom)), dom.spread(row.map(box => box.height))))) : null;
    const modal = document.body.hasAttribute('data-scroll-locked') ? activeDialog : undefined;
    const regions = modal ? [modal, ...modal.querySelectorAll('*')] : Array.from(document.querySelectorAll('main,main *'));
    const scrolling = regions.filter(element => {
      const style = getComputedStyle(element);
      return ['scroll', 'auto'].includes(style.overflowY) && dom.visible(element) && element.scrollHeight > element.clientHeight + 1;
    });
    const width = document.documentElement.clientWidth;
    const content = document.documentElement.scrollWidth;
    const raw = { markdown: 0, html: 0, json: 0, credential: 0 };
    const readerBlocks = new Map<Element, { all: string; prose: string }>();
    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let scanned = 0;
    for (let node = textNodes.nextNode(); node && scanned < 90_000; node = textNodes.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, template, option, svg, .sr-only') || !dom.visible(parent)
        || parent.checkVisibility && !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const bookend = parent.closest('p, li, td, th, div, pre, summary, h1, h2, h3, h4, h5, h6') ?? parent;
      const block = readerBlocks.get(bookend) ?? { all: '', prose: '' };
      const text = (node.nodeValue ?? '').slice(0, 90_000 - scanned);
      scanned += text.length;
      block.all += text;
      block.prose += parent.closest('pre, code, kbd, samp') ? ' ' : text;
      readerBlocks.set(bookend, block);
    }
    for (const { all, prose } of readerBlocks.values()) {
      raw.markdown += Number(/^(?: {0,3}#{1,6}[ \t]| {0,3}[\x60~]{3}|\s*[-*+] \[[ xX]\])|\[[^\]\n]+\]\([^\n)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|[\x60][^\x60\n]+[\x60]/m.test(prose));
      raw.html += Number(/<\/?[a-z][\w-]*(?:\s+[^<>\n]*)?\s*\/?>/i.test(prose));
      raw.json += Number(/[\[{]\s*(?:\{\s*)?"[^"\n]+"\s*:/.test(prose));
      raw.credential += Number(/\bBearer[ \t]+\S{20,}|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[\w]{24,})\b/.test(all));
    }
    const textControls = Array.from((surface ?? document).querySelectorAll('button, summary, [role=tab]'))
      .filter(element => dom.visible(element) && !element.closest('[aria-hidden=true]'));
    const clippedControls = textControls.filter(element => {
      const label = element.querySelector('span') ?? element;
      const style = getComputedStyle(label);
      return label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1
        && ['clip', 'hidden'].includes(style.overflowX) && style.textOverflow !== 'ellipsis';
    }).length;
    const causeCards = Array.from(document.querySelectorAll<HTMLElement>('.dw-ac-cards > li')).filter(dom.visible);
    const causes = causeCards.map(element => {
      const title = element.querySelector('strong')?.cloneNode(true) as Element | undefined;
      title?.querySelectorAll('[aria-hidden=true]').forEach(node => node.remove());
      return { length: [...(title?.textContent?.trim() ?? '')].length,
        measurement: /\d+(?:[.,]\d+)?\s*(?:px|ms|rem)\b/i.test(element.innerText) };
    });
    const hero = dom.find('.dw-ac-hero');
    const methods = Array.from(document.querySelectorAll('.dw-ac-mcards > li')).filter(dom.visible);
    const overview = dom.find('.dw-ac-items:has(> [data-item="verdict"])');
    const overviewIssues: string[] = overview ? [] : ['缺少验收总览'];
    if (overview) {
      const order = ['verdict', 'goals', 'causes', 'trace', 'by-screen', 'methods', 'videos', 'steps'];
      const sections = Array.from(overview.children).filter(dom.visible).map(element => element.getAttribute('data-item') ?? '')
        .filter(item => order.includes(item));
      if (new Set(sections).size !== sections.length || sections.some((item, index) => index > 0
        && order.indexOf(item) < order.indexOf(sections[index - 1]))) overviewIssues.push('总览区块的顺序或数量不符');
      if (['verdict', 'trace', 'by-screen', 'methods', 'videos', 'steps'].some(item => !sections.includes(item))) {
        overviewIssues.push('总览缺少结论、追溯、画面、手段、演示或下一步');
      }
      const heroItems = Array.from(hero?.children ?? []).filter(dom.visible);
      const heroLabels = heroItems.map(element => element.textContent?.trim() ?? '');
      const totals = ['验收项', '通过', '不通过', '缺证据'].map(label =>
        heroLabels.flatMap(value => {
          const number = value.match(new RegExp('^' + label + '\\s+(\\d+)$'))?.[1];
          return number === undefined ? [] : [Number(number)];
        }));
      if (heroLabels.filter(label => ['已签收', '可以签收', '暂不能签收'].includes(label)).length !== 1
        || totals.some(matches => matches.length !== 1) || totals.slice(1).reduce((sum, [count]) => sum + count, 0) > totals[0][0]) {
        overviewIssues.push('结论或四项计数不完整，或计数超过验收项总数');
      }
      const heroBoxes = heroItems.map(element => element.getBoundingClientRect());
      if (heroBoxes.length > 1 && Math.max(...heroBoxes.map(box => box.top)) >= Math.min(...heroBoxes.map(box => box.bottom))) {
        overviewIssues.push('结论计数未显示在同一行');
      }
      const goals = Array.from(overview.querySelectorAll('.dw-ac-goals > li')).filter(dom.visible);
      const goalsPassed = goals.filter(goal => goal.getAttribute('data-state') === 'passed').length;
      const goalKpis = heroLabels.filter(text => text.startsWith('目标达成'));
      if (goalKpis.length !== Number(goals.length > 0) || goals.length > 0 && goalKpis[0] !== `目标达成 ${goalsPassed}/${goals.length}`) {
        overviewIssues.push('目标计数与目标清单不一致');
      }
      const invalidGoal = goals.some(goal => {
        const ruleStates = Array.from(goal.querySelectorAll('.dw-ac-goal-rule')).filter(dom.visible)
          .map(element => element.getAttribute('data-state'));
        const expected = !ruleStates.length ? 'elsewhere' : ruleStates.includes('failed') ? 'failed'
          : ruleStates.every(state => state === 'passed') ? 'passed' : 'missing';
        return !goal.querySelector('strong')?.textContent?.trim() || !goal.querySelector('small')?.textContent?.trim()
          || goal.getAttribute('data-state') !== expected || goal.querySelector(':scope > .dw-status')?.getAttribute('data-state') !== expected;
      });
      if (invalidGoal) overviewIssues.push('目标缺少完成条件，或目标结论与相应验收项不一致');
      const types = causeCards.map(element => element.getAttribute('data-cause'));
      if (types.some(type => !type) || new Set(types).size !== types.length || types.indexOf('preview') > 0) {
        overviewIssues.push('同类原因未归并，或预览根因未排首位');
      }
      const missingImpact = causeCards.some(element => {
        const count = element.querySelector('.dw-ac-impact > .dw-ac-affected');
        const effect = element.querySelector('.dw-ac-impact > .dw-ac-consequence');
        return !count || !dom.visible(count) || !/^\d+ (?:项|图位|个验收手段|条需求)$/.test(count.textContent?.trim() ?? '')
          || !effect || !dom.visible(effect) || !effect.textContent?.trim();
      });
      if (missingImpact) overviewIssues.push('有原因未在卡片上显示影响数量和后果');
      const missingCauseDetails = causeCards.some(element => {
        const owner = element.querySelector('.dw-ac-effect > small');
        const details = element.querySelector<HTMLDetailsElement>('.dw-ac-effect > details');
        const actions = Array.from(element.querySelectorAll('.dw-ac-cause-act :is(button, a[href])')).filter(dom.visible);
        return !owner || !dom.visible(owner) || !owner.textContent?.trim() || actions.length !== 1 || !actions[0].textContent?.trim()
          || !details || details.open || details.querySelector('summary')?.textContent?.trim() !== '看清单';
      });
      if (missingCauseDetails) overviewIssues.push('有原因缺少负责人、唯一处理入口或收起的「看清单」');
      const trace = Array.from(overview.querySelectorAll('.dw-ac-trace [data-stage]')).filter(dom.visible);
      if (trace.map(element => element.getAttribute('data-stage')).join(',') !== 'need,items,clauses') overviewIssues.push('需求追溯缺少条款、验收项或条款结论');
      const screenRows = Array.from(overview.querySelectorAll('.dw-ac-byscreen > li')).filter(dom.visible);
      const problems = screenRows.map(element => element.querySelectorAll('.dw-ac-dots :is([data-status=failed], [data-status=missing])').length);
      if (screenRows.length > 12 || problems.some((count, index) => index > 0 && count > problems[index - 1])) {
        overviewIssues.push('画面超过十二个，或未按问题数量排序');
      }
      const statuses = methods.map(element => element.getAttribute('data-status'));
      const inactive = statuses.findIndex(status => status === 'disabled' || status === 'not_applicable');
      if (inactive >= 0 && statuses.slice(inactive).some(status => status !== 'disabled' && status !== 'not_applicable')) {
        overviewIssues.push('已启用的验收手段未排在前面');
      }
    }
    const compare = ['对比左侧版本', '对比右侧版本'].map(label =>
      (dom.find('select[aria-label="' + label + '"]') as HTMLSelectElement | undefined)?.value);
    const feedback = Array.from(document.querySelectorAll('.dw-dl-items > li[data-item]')).filter(dom.visible)
      .map(element => element.getAttribute('data-item'));
    const cards = Array.from(document.querySelectorAll('.dw-card-grid .dw-design-card')).filter(dom.visible);
    const currentScreen = dom.find('.dw-frame')?.getAttribute('data-screen');
    const selectedStep = dom.find('.dw-sp-thumbs [aria-current=step]')?.getAttribute('data-screen');
    const stepNumber = Number(dom.find('[data-sec="flow"] h3 small')?.textContent?.split('/')[0] ?? 0);
    return {
      layers, tabControls, headerAlignment, width, content,
      vertical: scrolling.length + Number(!modal && document.documentElement.scrollHeight > innerHeight + 1),
      clippedControls, textControls: textControls.length, height: innerHeight,
      scrollHeight: Math.max(document.documentElement.scrollHeight, ...scrolling.map(element => element.scrollHeight)),
      raw,
      frame: dom.read(dom.find('.dw-frame')), title: dom.read(dom.find('.dw-crumb-draft strong,.dw-crumb-title strong')),
      currentStep: Boolean(currentScreen && selectedStep === currentScreen),
      stepNumber,
      causes, hero: Boolean(hero), methods: methods.length, overviewIssues,
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
  const distance = (reference: number[], box: number[]) => Math.max(...box.map((value, coordinate) => Math.abs(value - reference[coordinate])));
  const pixels = (value: number) => Math.round(value * 10) / 10;
  const sameTabCount = actual.tabControls.length === expected.tabControls.length;
  const deltas = actual.layers.map((actualBox, index) => {
    const reference = expected.layers[index];
    if (index === 1) {
      return sameTabCount ? pixels(Math.max(0, ...actual.tabControls.map((box, tab) => distance(expected.tabControls[tab], box)))) : null;
    }
    return actualBox && reference ? pixels(distance(reference, actualBox)) : actualBox === reference ? 0 : null;
  });
  const positions = regions.map((region, index) => {
    if (index === 1 && !sameTabCount) return `标签控件数不同，原型 ${expected.tabControls.length} 个，实现 ${actual.tabControls.length} 个`;
    if (actual.layers[index] === null && expected.layers[index] === null) return `${region}在两侧均未定位`;
    return `${region}${deltas[index] === null ? '只在一侧显示' : `偏差 ${deltas[index]} px`}`;
  }).join('，');
  const markers = Object.entries({ markdown: '原样 Markdown', html: '转义 HTML', json: '原样 JSON', credential: '疑似凭据' } as const)
    .flatMap(([key, label]) => {
      const count = actual.raw[key as keyof typeof actual.raw];
      return count ? [`${label} ${count} 处`] : [];
    });
  return {
    'V-01': {
      status: deltas.some(delta => delta === null || delta > 1) ? 'failed' : pixelDifference === 0 ? 'passed' : 'missing',
      evidence: `${positions}。相同视口像素差 ${pixelDifference.toFixed(2)}%。${pixelDifference > 0 ? '差异区域待按设计依据核对。' : ''}`,
    },
    'V-02': actual.headerAlignment !== null ? verdict(actual.headerAlignment <= 1,
      `各组同排页头控件顶边、底边和高度的最大差为 ${actual.headerAlignment.toFixed(1)} px。`) :
      { status: 'missing', evidence: '未定位可配对的同一行控件。' },
    'V-03': actual.clippedControls > 0 ? verdict(false, `扫描 ${actual.textControls} 个可见控件，${actual.clippedControls} 个出现文字裁切。`) :
      { status: 'missing', evidence: `扫描 ${actual.textControls} 个可见控件，文字裁切 0 处。浮层遮挡和断词待核对。` },
    'V-04': verdict(actual.content <= actual.width && actual.vertical <= 1,
      `文档可用宽度 ${actual.width} px，内容宽 ${actual.content} px，纵向滚动区 ${actual.vertical} 个。`),
    'V-05': markers.length ? verdict(false, `可见文本扫描发现 ${markers.join('、')}。`) :
      { status: 'missing', evidence: '可见文本扫描未发现未渲染的标记、JSON 或疑似凭据。内部编号及嵌入内容待核对。' },
    'V-06': { status: 'missing', evidence: '同数据图已生成，名称与徽标数量的逐处一致性待核对。' },
    'V-07': darkContrastCheck(actual.darkText, useDarkCapture),
    'V-08': { status: 'missing', evidence: `已取 ${actual.width} × ${actual.height} 的图。Windows 两档缩放与手机状态待关联。` },
    'V-09': { status: 'missing', evidence: '已进入当前声明的状态。待核对本版全部声明状态的同条件图证。', useSceneCoverage: true },
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
      const valid = value.causes.length <= 6 && value.causes.every(cause => cause.length > 0 && cause.length <= 30 && !cause.measurement);
      const text = `原因卡 ${value.causes.length} 张，验收手段 ${value.methods} 个，${value.hero ? '有' : '缺'}总览结论。`;
      const issues = [...value.overviewIssues];
      if (!valid) issues.push('原因卡超出数量或标题长度，或显示了测量原文');
      if (!value.hero || value.methods !== 8) issues.push('缺少结论或八种验收手段');
      if (issues.length) put(id, false, text + issues.join('。') + '。');
      else results[id] = { status: 'unverified', actual: text + '已检查区块和明细的组织。实际操作、目标数据来源及签收行为仍待复验。' };
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
