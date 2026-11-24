import { describe, expect, it } from 'vitest';
import {
  collapseRepeats,
  condenseHeadline,
  diagnoseReleaseFailure,
  explainGateCheck,
  extractGateReports,
  isNoiseLine,
  parseCheckDetail,
  pickGateReport,
  scanJsonObjects,
  type ReleaseDiagnosisLogLike,
} from '../../web/src/lib/releaseDiagnosis.js';

/**
 * 用例数据照抄 2026-07-29 那次真实失败（rel_3c72935be772e798）的形状：
 * 门禁 JSON 由 `json.dumps(indent=2)` 打到 stdout，被 CDS 逐行存进日志；
 * 真正的判据是 gateway_route_self_test 的 status=401，而 stderr 里只有一堆 WARN。
 */
function gateReportLines(): string[] {
  const report = {
    generatedAt: '2026-07-29T08:07:11Z',
    verdict: 'fail',
    mode: 'http-full',
    checks: [
      { name: 'map_health', ok: true, detail: JSON.stringify({ status: 200 }) },
      { name: 'gateway_key_configured', ok: true, detail: 'keyEnv=LLMGW_GATE_KEY' },
      {
        name: 'gateway_route_self_test',
        ok: false,
        detail: JSON.stringify({
          status: 401,
          keyEnv: 'LLMGW_GATE_KEY',
          selfTestStatus: '',
          total: null,
          passed: null,
          protocols: [],
          missingProtocols: ['claude-compatible', 'gemini-compatible', 'gw-native', 'openai-compatible'],
        }),
      },
      { name: 'disk_guard', ok: true, detail: 'availableMB=6867' },
    ],
  };
  return JSON.stringify(report, null, 2).split('\n');
}

function logsOf(lines: string[], level: ReleaseDiagnosisLogLike['level'] = 'info'): ReleaseDiagnosisLogLike[] {
  return lines.map((message) => ({ level, message }));
}

describe('releaseDiagnosis · JSON 扫描', () => {
  it('抓得到顶格起行的 JSON 对象，忽略半截 JSON', () => {
    const text = [
      'Preparing worktree (detached HEAD 307301a)',
      '{',
      '  "a": 1',
      '}',
      '{ "broken": ',
    ].join('\n');
    expect(scanJsonObjects(text)).toEqual([{ a: 1 }]);
  });

  it('字符串里的花括号不会把配平算错', () => {
    const text = '{\n  "msg": "a } b {",\n  "n": 2\n}';
    expect(scanJsonObjects(text)).toEqual([{ msg: 'a } b {', n: 2 }]);
  });

  it('不认缩进在日志前缀之后的 JSON 片段（避免每行都触发回溯扫描）', () => {
    // 真实门禁报告一定是顶格打印的；带前缀的花括号一律跳过。
    const text = 'INFO ssh: {"checks":[{"name":"x","ok":true}]}';
    expect(scanJsonObjects(text)).toEqual([]);
  });
});

describe('releaseDiagnosis · 门禁报告解析', () => {
  it('从多行日志里还原出完整门禁报告', () => {
    const reports = extractGateReports(gateReportLines().join('\n'));
    expect(reports).toHaveLength(1);
    expect(reports[0].totalCount).toBe(4);
    expect(reports[0].passCount).toBe(3);
    expect(reports[0].failCount).toBe(1);
    expect(reports[0].verdict).toBe('fail');
  });

  it('checks 里缺 name 或 ok 不是布尔时整份不认，绝不半信半疑地渲染', () => {
    expect(extractGateReports('{\n "checks": [{"name": "x"}]\n}')).toEqual([]);
    expect(extractGateReports('{\n "checks": [{"ok": true}]\n}')).toEqual([]);
    expect(extractGateReports('{\n "checks": [{"name":"x","ok":"true"}]\n}')).toEqual([]);
  });

  it('多份报告时挑卡住这次发布的那一份（最后一份失败的）', () => {
    const pass = { verdict: 'pass', checks: [{ name: 'a', ok: true, detail: '' }] };
    const fail = { verdict: 'fail', checks: [{ name: 'b', ok: false, detail: '' }] };
    const text = [JSON.stringify(pass, null, 2), JSON.stringify(fail, null, 2), JSON.stringify(pass, null, 2)].join('\n');
    const picked = pickGateReport(extractGateReports(text));
    expect(picked?.checks[0].name).toBe('b');
  });

  it('全通过时取最后一份', () => {
    const first = { verdict: 'pass', checks: [{ name: 'a', ok: true, detail: '' }] };
    const second = { verdict: 'pass', checks: [{ name: 'z', ok: true, detail: '' }] };
    const text = [JSON.stringify(first, null, 2), JSON.stringify(second, null, 2)].join('\n');
    expect(pickGateReport(extractGateReports(text))?.checks[0].name).toBe('z');
  });
});

describe('releaseDiagnosis · detail 解析', () => {
  it('JSON detail 解析成键值对，空值被剔除', () => {
    const fields = parseCheckDetail(JSON.stringify({ status: 401, keyEnv: 'K', selfTestStatus: '', total: null }));
    expect(fields).toEqual([
      { key: 'status', value: '401' },
      { key: 'keyEnv', value: 'K' },
    ]);
  });

  it('数组 detail 值拼成一行而不是 [object Object]', () => {
    const fields = parseCheckDetail(JSON.stringify({ missingProtocols: ['a', 'b'] }));
    expect(fields).toEqual([{ key: 'missingProtocols', value: 'a, b' }]);
  });

  it('裸文本 detail 也能拆出 key=value', () => {
    expect(parseCheckDetail('status=401 · keyEnv=LLMGW_GATE_KEY')).toEqual([
      { key: 'status', value: '401' },
      { key: 'keyEnv', value: 'LLMGW_GATE_KEY' },
    ]);
  });

  it('完全无结构的 detail 返回空数组，交给 UI 原样展示', () => {
    expect(parseCheckDetail('rollout ledger completion is not required')).toEqual([]);
  });
});

describe('releaseDiagnosis · 人话解释', () => {
  it('401 + keyEnv 说清是密钥不被认，不是网络不通', () => {
    const hint = explainGateCheck({
      name: 'gateway_route_self_test',
      ok: false,
      detail: '',
      fields: [{ key: 'status', value: '401' }, { key: 'keyEnv', value: 'LLMGW_GATE_KEY' }],
    });
    expect(hint).toContain('LLMGW_GATE_KEY');
    expect(hint).toContain('401');
  });

  it('信号不明确时闭嘴，不给一句放之四海皆准的废话', () => {
    expect(explainGateCheck({ name: 'x', ok: false, detail: 'boom', fields: [] })).toBeUndefined();
  });
});

describe('releaseDiagnosis · 噪音识别', () => {
  it('认得出 context canceled 与镜像预热超时', () => {
    expect(isNoiseLine('context canceled')).toBe(true);
    expect(isNoiseLine('WARN: api image warmup skipped or timed out after 30s')).toBe(true);
  });

  it('普通 WARN 不算噪音——把所有 WARN 当噪音等于关掉一整类真实告警', () => {
    expect(isNoiseLine('WARN: --commit 发布默认忽略 PRD_AGENT_IMAGE 覆盖')).toBe(false);
  });
});

describe('releaseDiagnosis · 端到端诊断', () => {
  const logs: ReleaseDiagnosisLogLike[] = [
    ...logsOf(['Preparing worktree (detached HEAD 307301a)']),
    ...logsOf(['context canceled'], 'warn'),
    ...logsOf(['WARN: api image warmup skipped or timed out after 30s'], 'warn'),
    ...logsOf(gateReportLines()),
    ...logsOf(['LLM Gateway production stage failed; appending failed evidence'], 'error'),
  ];

  it('结论指名道姓说出未通过的检查项', () => {
    const diagnosis = diagnoseReleaseFailure(logs);
    expect(diagnosis.headline).toContain('gateway_route_self_test');
    expect(diagnosis.headline).toContain('未通过 1 项');
    expect(diagnosis.failedChecks.map((check) => check.name)).toEqual(['gateway_route_self_test']);
  });

  it('结论有了也照样保留原始证据：error 行与噪音行都在', () => {
    const diagnosis = diagnoseReleaseFailure(logs);
    expect(diagnosis.errorGroups.map((group) => group.text)).toContain(
      'LLM Gateway production stage failed; appending failed evidence',
    );
    expect(diagnosis.noiseGroups.map((group) => group.text)).toEqual([
      'context canceled',
      'WARN: api image warmup skipped or timed out after 30s',
    ]);
  });

  it('未通过项的 401 判据被解析出来，供表格逐字段展示', () => {
    const diagnosis = diagnoseReleaseFailure(logs);
    const fields = diagnosis.failedChecks[0].fields;
    expect(fields).toContainEqual({ key: 'status', value: '401' });
    expect(fields).toContainEqual({ key: 'keyEnv', value: 'LLMGW_GATE_KEY' });
    expect(diagnosis.humanHint).toContain('401');
  });

  it('没有门禁报告时退化成 error 行，绝不编一个结论', () => {
    const diagnosis = diagnoseReleaseFailure([
      { level: 'warn', message: 'context canceled' },
      { level: 'error', message: 'ssh: connect: connection refused' },
    ]);
    expect(diagnosis.report).toBeUndefined();
    expect(diagnosis.headline).toBe('ssh: connect: connection refused');
  });

  it('既没有报告也没有 error 行时如实说提不出判据', () => {
    const diagnosis = diagnoseReleaseFailure([{ level: 'info', message: 'done' }]);
    expect(diagnosis.headline).toContain('未能从日志中提取到结构化判据');
  });

  it('error 行去重且保序，不把同一句刷屏成八条', () => {
    const diagnosis = diagnoseReleaseFailure([
      { level: 'error', message: 'boom' },
      { level: 'error', message: 'boom' },
      { level: 'error', message: 'later' },
    ]);
    expect(diagnosis.errorGroups).toEqual([
      { text: 'boom', count: 2, variants: ['boom'] },
      { text: 'later', count: 1, variants: ['later'] },
    ]);
  });
});

/**
 * 止血三条的守卫（2026-08-12）。
 *
 * 样本形状照抄 rel_9759ead9be9405e3：远端执行器把一句人话和几十行 stderr
 * 拼成**一条** error 丢回来，于是「一句话结论」的位置被灌进 1418 个字符。
 * 三条断言分别钉住：结论单行化、噪音归并、以及归并不许吃掉差异。
 */
describe('releaseDiagnosis · 结论位不许装整段日志', () => {
  const sshFailure = [
    '执行项目发布命令失败: ssh exec exit=22',
    '--- stderr(tail) --- ... [truncated, kept last 19 lines / 1418 chars]',
    'Warning: Problem (retrying all errors). Will retry in 2 seconds. 4 retries left.',
    'curl: (22) The requested URL returned error: 404',
    '--- stdout(tail) --- Downloading immutable admin artifact with resume: https://example.invalid/a.zip',
  ].join('\n');

  it('切掉 stderr 尾巴，只留标记之前的第一句', () => {
    expect(condenseHeadline(sshFailure)).toBe('执行项目发布命令失败: ssh exec exit=22');
  });

  it('没有尾巴标记的超长单行也被截断，且恒为单行', () => {
    const long = `无法连接目标机：${'诊断信息'.repeat(60)}`;
    const headline = condenseHeadline(long);
    expect(headline.length).toBeLessThanOrEqual(96);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline).not.toContain('\n');
  });

  it('复合 error 进 diagnose 之后，headline 是一句话而不是一堵墙', () => {
    const diagnosis = diagnoseReleaseFailure([{ level: 'error', message: sshFailure }]);
    expect(diagnosis.headline).toBe('执行项目发布命令失败: ssh exec exit=22');
    expect(diagnosis.headline).not.toContain('curl');
    // 原文一个字没丢：完整 error 仍在 error 行区块里
    expect(diagnosis.errorGroups[0].text).toContain('curl: (22)');
  });

  it('结论短于上限时原样保留，不画蛇添足加省略号', () => {
    expect(condenseHeadline('ssh: connect: connection refused')).toBe('ssh: connect: connection refused');
  });
});

describe('releaseDiagnosis · 重复行归并', () => {
  it('只有倒计时不同的重试播报归成一组并计数', () => {
    const retries = [4, 3, 2, 1].map(
      (left) => `Warning: Problem (retrying all errors). Will retry in 2 seconds. ${left} retries left.`,
    );
    const groups = collapseRepeats(retries, 6);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(4);
    expect(groups[0].text).toContain('4 retries left');
  });

  it('归并只压重复不压差异：同组里不同的原文照样留着', () => {
    const groups = collapseRepeats(
      [
        'curl: (22) The requested URL returned error: 404',
        'curl: (22) The requested URL returned error: 404',
        'curl: (22) The requested URL returned error: 500',
      ],
      6,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].variants).toEqual([
      'curl: (22) The requested URL returned error: 404',
      'curl: (22) The requested URL returned error: 500',
    ]);
  });

  it('curl 的重试播报算噪音，但真正报错的那一行不算', () => {
    expect(isNoiseLine('Warning: Problem (retrying all errors). Will retry in 2 seconds. 3 retries left.')).toBe(true);
    expect(isNoiseLine('curl: (22) The requested URL returned error: 404')).toBe(false);
  });

  /**
   * 2026-08-12 自测截图抓到的真实缺陷：复合 error 里顺带含着 curl 的重试播报，
   * 按子串判定就把**真正的失败原因**整条标成「不是失败原因」摆进噪音栏。
   */
  it('多行复合消息不算噪音行，哪怕里面含着噪音措辞', () => {
    const composite = [
      '执行项目发布命令失败: ssh exec exit=22',
      'Warning: Problem (retrying all errors). Will retry in 2 seconds. 4 retries left.',
    ].join('\n');
    expect(isNoiseLine(composite)).toBe(false);
    const diagnosis = diagnoseReleaseFailure([{ level: 'error', message: composite }]);
    expect(diagnosis.noiseGroups).toEqual([]);
    expect(diagnosis.errorGroups[0].text).toContain('ssh exec exit=22');
  });

  it('error 级永远不进噪音栏——那一栏写着「它不是失败原因」', () => {
    const diagnosis = diagnoseReleaseFailure([
      { level: 'error', message: 'context canceled' },
    ]);
    expect(diagnosis.noiseGroups).toEqual([]);
    expect(diagnosis.errorGroups.map((group) => group.text)).toEqual(['context canceled']);
  });

  it('限的是组数不是行数：超限的新形状被丢弃，已有组照常继续计数', () => {
    const groups = collapseRepeats(['a 1', 'b 1', 'a 2', 'c 1'], 2);
    expect(groups.map((group) => group.text)).toEqual(['a 1', 'b 1']);
    expect(groups[0].count).toBe(2);
  });
});
