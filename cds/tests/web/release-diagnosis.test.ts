import { describe, expect, it } from 'vitest';
import {
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
    expect(diagnosis.errorLines).toContain('LLM Gateway production stage failed; appending failed evidence');
    expect(diagnosis.noiseLines).toEqual([
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
    expect(diagnosis.errorLines).toEqual(['boom', 'later']);
  });
});
