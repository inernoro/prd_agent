import { designViewports, type DesignFrameworkCheck, type DesignFrameworkMeasurement,
  type DesignScreen, type FrameworkRevision } from '../shared/design-workspace.js';

export type DesignFrameworkProbe = (prototype: Buffer, screens: DesignScreen[]) => Promise<DesignFrameworkMeasurement[]>;

function frameworkRules(markdown: string) {
  const rules = new Map<string, { name: string; overflow: boolean }>();
  for (const line of markdown.split(/\r?\n/)) {
    const row = line.match(/^\s*\|\s*(R[-_]\d+)\s*\|\s*(.+?)\s*(?<!\\)\|\s*(.+?)\s*\|\s*$/);
    if (row) {
      const [, id, description, method] = row;
      const name = description.replace(/\\\|/g, '|');
      rules.set(id, { name, overflow: id === 'R-07' && method.startsWith('自动') && name.includes('375') && name.includes('横向溢出') });
      continue;
    }
    const heading = line.match(/^#{2,4}\s+(R[-_]\d+)\s*[·—:：]?\s*(.+)$/);
    if (heading && !rules.has(heading[1])) rules.set(heading[1], { name: heading[2], overflow: false });
  }
  return rules;
}

export async function checkDesignFramework(framework: string, baseline: FrameworkRevision, sourceCommit: string,
  prototype: Buffer, screens: DesignScreen[], probe?: DesignFrameworkProbe): Promise<DesignFrameworkCheck> {
  const rules = frameworkRules(baseline.material.rules ?? '');
  const phones = screens.filter(screen => screen.viewport === 'phone');
  const expected = new Set(phones.flatMap(screen => screen.themes.map(theme => `${screen.id}:phone-${theme}`)));
  const measured = new Map<string, DesignFrameworkMeasurement>();
  if (expected.size && probe && [...rules.values()].some(rule => rule.overflow)) {
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
    if (!rule.overflow) {
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
