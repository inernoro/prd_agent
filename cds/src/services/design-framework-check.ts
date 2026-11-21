import { designViewports, type DesignFrameworkCheck, type DesignFrameworkMeasurement,
  type DesignScreen, type FrameworkRevision } from '../shared/design-workspace.js';
import { designFrameworkRules } from '../shared/design-framework-rules.js';

export type DesignFrameworkProbe = (prototype: Buffer, screens: DesignScreen[]) => Promise<DesignFrameworkMeasurement[]>;

export async function checkDesignFramework(framework: string, baseline: FrameworkRevision, sourceCommit: string,
  prototype: Buffer, screens: DesignScreen[], probe?: DesignFrameworkProbe): Promise<DesignFrameworkCheck> {
  const rules = designFrameworkRules(baseline.material.rules ?? '');
  const responsiveRule = rules.get('R-07');
  const checksOverflow = responsiveRule?.method?.startsWith('自动') && responsiveRule.name.includes('375') && responsiveRule.name.includes('横向溢出');
  const phones = screens.filter(screen => screen.viewport === 'phone');
  const expected = new Set(phones.flatMap(screen => screen.themes.map(theme => `${screen.id}:phone-${theme}`)));
  const measured = new Map<string, DesignFrameworkMeasurement>();
  if (expected.size && probe && checksOverflow) {
    for (const measurement of await probe(prototype, phones)) {
      const key = `${measurement.screenId}:${measurement.slot}`;
      if (expected.has(key) && measurement.width === designViewports.phone.width
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
    const complete = expected.size > 0 && expected.size === measured.size;
    const status = failed ? 'failed' : complete ? 'passed' : 'unverified';
    const actual = failed ? `画面 ${failed.screenId} 的内容宽 ${failed.contentWidth}px，视口宽 ${failed.width}px。`
      : complete ? `${measured.size} 个手机画面与主题组合均无横向溢出。`
        : expected.size ? `已测 ${measured.size} / ${expected.size} 个手机画面与主题组合，需补实测。`
          : '稿件尚未声明可测的手机画面。';
    items.push({ ruleId, name: rule.name, status, actual, ...(measurements.length ? { measurements } : {}) });
  }
  return { framework, frameworkVersion: baseline.version, sourceCommit, items };
}
