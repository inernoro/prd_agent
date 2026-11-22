import { designViewports, type DesignFrameworkCheck, type DesignFrameworkMeasurement,
  type DesignScreen, type FrameworkRevision } from '../shared/design-workspace.js';
import { designFrameworkRules } from '../shared/design-framework-rules.js';

export type DesignFrameworkProbe = (prototype: Buffer, screens: DesignScreen[], checkNestedScroll: boolean) => Promise<DesignFrameworkMeasurement[]>;

export async function checkDesignFramework(framework: string, baseline: FrameworkRevision, sourceCommit: string,
  prototype: Buffer, screens: DesignScreen[], probe?: DesignFrameworkProbe): Promise<DesignFrameworkCheck> {
  const rules = designFrameworkRules(baseline.material.rules ?? '');
  const responsiveRule = rules.get('R-07');
  const checksOverflow = responsiveRule?.method?.startsWith('自动') && responsiveRule.name.includes('375') && responsiveRule.name.includes('横向溢出');
  const checksNestedScroll = responsiveRule?.name.includes('只有表格、图表、代码块') === true && responsiveRule.name.includes('横向滚动');
  const phones = screens.filter(screen => screen.viewport === 'phone');
  const expected = new Set(phones.flatMap(screen => screen.themes.map(theme => `${screen.id}:phone-${theme}`)));
  const defaultRoutes = new Set<string>();
  const eligible = phones.filter(screen => {
    const alreadySeen = defaultRoutes.has(screen.route);
    defaultRoutes.add(screen.route);
    return !!screen.entryReadySelector || (!alreadySeen && !screen.entryActions?.length);
  });
  const eligibleIds = new Set(eligible.map(screen => screen.id));
  const measured = new Map<string, DesignFrameworkMeasurement>();
  if (eligible.length && probe && checksOverflow) {
    for (const measurement of await probe(prototype, eligible, checksNestedScroll)) {
      const key = `${measurement.screenId}:${measurement.slot}`;
      if (eligibleIds.has(measurement.screenId) && expected.has(key) && measurement.width === designViewports.phone.width
        && Number.isSafeInteger(measurement.contentWidth) && measurement.contentWidth >= measurement.width) {
        measured.set(key, measurement);
      }
    }
  }
  const measurements = [...measured.values()];
  const items: DesignFrameworkCheck['items'] = [];
  for (const [ruleId, rule] of rules) {
    if (ruleId !== 'R-07' || !checksOverflow) {
      items.push({ ruleId, name: rule.name, status: 'unverified', actual: '该规则需要人工核对或专用测量。' });
      continue;
    }
    const failed = measurements.find(row => row.contentWidth > row.width);
    const nestedFailure = checksNestedScroll && measurements.find(row => row.nestedScroll?.status === 'failed');
    const uncertain = checksNestedScroll && measurements.find(row => row.nestedScroll?.status === 'unverified');
    const measuredCount = checksNestedScroll ? measurements.filter(row => row.nestedScroll?.status === 'passed').length : measured.size;
    const complete = expected.size > 0 && expected.size === measuredCount;
    let status: DesignFrameworkCheck['items'][number]['status'] = 'unverified';
    let actual = '稿件尚未声明可测的手机画面。';
    if (failed) {
      status = 'failed';
      actual = `画面 ${failed.screenId} 的内容宽 ${failed.contentWidth}px，视口宽 ${failed.width}px。`;
    } else if (nestedFailure && nestedFailure.nestedScroll?.status === 'failed') {
      const region = nestedFailure.nestedScroll;
      status = 'failed';
      actual = `画面 ${nestedFailure.screenId}（${nestedFailure.slot}）的 ${region.element} 容器可横向滚动，内容宽 ${region.contentWidth}px，容器宽 ${region.width}px。`;
    } else if (complete) {
      status = 'passed';
      const scope = checksNestedScroll ? '均无整页溢出，且容器横向滚动符合规则。' : '均无横向溢出。';
      actual = `${measuredCount} 个手机画面与主题组合${scope}`;
    } else if (expected.size) {
      actual = `已测 ${measuredCount} / ${expected.size} 个手机画面与主题组合，需补实测。`;
      if (uncertain && uncertain.nestedScroll?.status === 'unverified') {
        const region = uncertain.nestedScroll;
        actual += ` 画面 ${uncertain.screenId}（${uncertain.slot}）的 ${region.element} 容器宽 ${region.width}px，内容宽 ${region.contentWidth}px，需核对容器用途。`;
      } else if (checksNestedScroll && measured.size > measuredCount) {
        actual += ` 已有 ${measured.size} 组整页宽度，需补容器测量。`;
      }
    }
    items.push({ ruleId, name: rule.name, status, actual, ...(measurements.length ? { measurements } : {}) });
  }
  return { framework, frameworkVersion: baseline.version, sourceCommit, items };
}
