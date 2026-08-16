/**
 * release-center-review-fixes.test.ts —— Codex 第二、三轮 review 的判定源。
 *
 * 每一段对应一条：预览地址不许凭空造、主目标默认值、试跑失败要说清楚、
 * 外发链接必须绝对化。都是纯函数，配一条接线守卫证明页面真的在用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolvePreviewUrl } from '../../web/src/lib/previewUrl';
import { canonicalEnvironments, defaultIsCanonical } from '../../web/src/lib/releaseEnvironments';
import { describeDryRunResult } from '../../web/src/lib/releaseDiagnosis';
import { runTone, statusLabel } from '../../web/src/pages/release-center/shared';
import { absoluteNoticeActionUrl, normalizeNoticeOrigin } from '../../src/services/notice-outbound-map.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../web/src', rel), 'utf8');

const BRANCH = { id: 'br_1', previewSlug: 'feature-x' };
const CONFIG = { previewDomain: 'miduo.org', rootDomains: ['miduo.org'], workerPort: 5500, mainDomain: 'app.miduo.org' };
const ORIGIN = { protocol: 'https:', hostname: 'cds.miduo.org' };

describe('resolvePreviewUrl 不为 port 模式编造地址', () => {
  it('port 模式返回空串，交给发布前检查拦下', () => {
    expect(resolvePreviewUrl('port', BRANCH, CONFIG, ORIGIN)).toBe('');
  });

  it('multi 模式仍按子域公式推导', () => {
    // 线上域名不补端口（hostWithPort 只给本机域名补），所以这里没有 :5500。
    expect(resolvePreviewUrl('multi', BRANCH, CONFIG, ORIGIN)).toBe('https://feature-x.miduo.org');
  });

  it('simple 模式走主域名', () => {
    expect(resolvePreviewUrl('simple', BRANCH, CONFIG, ORIGIN)).toBe('https://app.miduo.org');
  });

  it('port 模式绝不返回 multi 那条子域', () => {
    // 这才是问题的要害：那个地址语法合法、非空、能通过「产物非空」检查，
    // 然后作为 CDS_PREVIEW_URL 一路传进发布脚本——而它没有任何东西在监听。
    const multi = resolvePreviewUrl('multi', BRANCH, CONFIG, ORIGIN);
    expect(resolvePreviewUrl('port', BRANCH, CONFIG, ORIGIN)).not.toBe(multi);
  });
});

describe('StartReleaseDialog 为 port 模式现取端口（接线守卫）', () => {
  const source = read('pages/release-center/StartReleaseDialog.tsx');

  it('调用 preview-port 端点而不是把空串直接交出去', () => {
    expect(source).toContain('/preview-port');
    expect(source).toMatch(/previewMode !== 'port'/);
  });
});

describe('主目标默认值随环境而定', () => {
  const sections = [
    { environment: 'production', label: '生产', entries: [], disabledEntries: [], canonicalTargetId: 'rt_prod' },
    { environment: 'staging', label: '预发', entries: [], disabledEntries: [] },
  ];

  it('已有主目标的环境被收进集合', () => {
    expect(canonicalEnvironments(sections)).toEqual(new Set(['production']));
  });

  it('退化分组（后端没下发 environments）不参与判定', () => {
    const degraded = [{ environment: 'production', label: '发布目标', entries: [], disabledEntries: [], canonicalTargetId: 'rt_x', degraded: true }];
    expect(canonicalEnvironments(degraded).size).toBe(0);
  });

  it('该环境已有主目标 → 默认不勾（否则保存必被后端拒）', () => {
    expect(defaultIsCanonical('production', canonicalEnvironments(sections))).toBe(false);
  });

  it('该环境还没有主目标 → 默认勾上（省掉一次必然的勾选）', () => {
    expect(defaultIsCanonical('staging', canonicalEnvironments(sections))).toBe(true);
    expect(defaultIsCanonical('other', canonicalEnvironments(sections))).toBe(true);
  });

  it('第一个目标（空集合）默认就是主目标', () => {
    expect(defaultIsCanonical('production', new Set())).toBe(true);
  });
});

describe('试跑结论说清楚哪一项没过', () => {
  it('失败时给 error，而不是那条恒定的安全横幅', () => {
    const result = {
      ok: false,
      error: '发布前检查未通过：可发布产物',
      log: '本次只做检查、未发布\n  [fail] 可发布产物：缺少预览地址或 commit',
    };
    const text = describeDryRunResult(result);
    expect(text).toContain('可发布产物');
    expect(text).not.toBe('本次只做检查、未发布');
  });

  it('没有 error 时退到日志里的 fail 行', () => {
    const text = describeDryRunResult({
      ok: false,
      log: '本次只做检查、未发布\n  [fail] 发布目标：生产站点 已禁用',
    });
    expect(text).toContain('生产站点 已禁用');
  });

  it('两种都没有才用兜底文案', () => {
    expect(describeDryRunResult({ ok: false })).toBe('试跑未通过：发布前检查存在阻塞项');
  });

  it('成功与失败的文案必须能区分开', () => {
    const ok = describeDryRunResult({ ok: true, log: '本次只做检查、未发布' });
    const bad = describeDryRunResult({ ok: false, error: 'x', log: '本次只做检查、未发布' });
    expect(ok).not.toBe(bad);
    expect(ok).toContain('通过');
  });
});

describe('外发到 MAP 的链接必须是 CDS 自己的绝对地址', () => {
  it('裸域名补 https', () => {
    expect(normalizeNoticeOrigin('cds.miduo.org')).toBe('https://cds.miduo.org');
    expect(normalizeNoticeOrigin('https://cds.miduo.org/')).toBe('https://cds.miduo.org');
    expect(normalizeNoticeOrigin('')).toBe('');
    expect(normalizeNoticeOrigin(undefined)).toBe('');
  });

  it('相对路径拼成 CDS 的绝对地址', () => {
    expect(absoluteNoticeActionUrl('/release-center?target=t', 'cds.miduo.org'))
      .toBe('https://cds.miduo.org/release-center?target=t');
  });

  it('没有配 origin 就不给动作——宁可没有按钮，也不给一个必然点错的', () => {
    // 原样发相对路径的话，MAP 会按**自己**的 origin 展开，点开落到 MAP 的
    // /release-center，一个不存在的页面。
    expect(absoluteNoticeActionUrl('/release-center', undefined)).toBe('');
    expect(absoluteNoticeActionUrl('/release-center', '')).toBe('');
  });

  it('非相对路径一律不外发', () => {
    expect(absoluteNoticeActionUrl('https://evil.example/x', 'cds.miduo.org')).toBe('');
    expect(absoluteNoticeActionUrl('', 'cds.miduo.org')).toBe('');
  });
});

/**
 * 以下两段对应第四轮 review。两条都属于「证据表列的是全部环境的记录」这一个
 * 前提没有被下游遵守：一条把非终态当成功，一条把别的环境的记录挂到当前环境上。
 */

describe('证据表的状态判定不做 failed / success 二分', () => {
  it('在途状态既不是成功也不是失败', () => {
    // 原来整行按 isReleaseFailed 二分，于是 queued / running / healthchecking /
    // rollback_running 全落进「成功」那一档：绿点 + 文案「成功」。
    for (const status of ['queued', 'running', 'healthchecking', 'rollback_running']) {
      expect(runTone(status)).toBe('warn');
      expect(statusLabel(status)).not.toBe('发布成功');
    }
    expect(runTone('success')).toBe('ok');
    expect(runTone('rollback_success')).toBe('ok');
    expect(runTone('failed')).toBe('bad');
  });

  it('EvidenceSection 复用 shared 的映射，且回滚只给真正成功的版本（接线守卫）', () => {
    const source = read('pages/release-center/EvidenceSection.tsx');
    expect(source).toMatch(/import \{[^}]*runTone[^}]*\} from '\.\/shared'/);
    expect(source).toContain("run.status === 'success' || run.status === 'rollback_success'");
    // 「不是失败」不足以给出回滚入口——回滚到一个还没发完的版本是没有意义的。
    expect(source).not.toMatch(/!failed\s*\?[^]*回滚到此版本/);
  });
});

describe('回滚对话框挂在记录自己的环境上', () => {
  const page = read('pages/ReleaseCenterPage.tsx');

  it('归属解析只有一份，按 run.targetId 找回环境', () => {
    expect(page).toContain('const openRollbackForRun = (run: ReleaseRun): void => {');
    expect(page).toMatch(/openRollbackForRun[^]*rows\.find\(\(item\) => item\.target\.id === run\.targetId\)/);
    expect(page).toMatch(/openRollbackForRun[^]*没有找到这条记录对应的环境/);
  });

  it('没有任何 onRollback 回调把当前选中的环境和一条 run 一起递出去', () => {
    // 证据表列的是全部环境的记录。选中 A、点 B 的那条回滚时，对话框会标着 A、
    // 列 A 的候选版本，而 sourceRun 属于 B，后端按「版本不属于该环境」拒掉。
    const callbacks = page.match(/onRollback=\{[^}]*\}/g) || [];
    expect(callbacks.length).toBeGreaterThan(0);
    for (const cb of callbacks) {
      expect(cb).toContain('openRollbackForRun(run)');
      expect(cb).not.toContain('selectedRow');
    }
  });
});

/**
 * 第五轮 review。三条 P1/P2 归到同一类：**把「不是 X」当成「是 Y」**。
 * 一条把在途发布判成失败，一条把翻旧记录判成本次操作，一条把晚到的旧响应
 * 判成当前项目的数据。
 */

describe('全环境矩阵不把在途发布画成失败', () => {
  const fleet = fs.readFileSync(path.resolve(here, '../../web/src/lib/releaseFleet.ts'), 'utf8');
  const matrix = read('pages/release-center/FleetMatrix.tsx');

  it('lastRelease 带原始状态，而不是一个成功/失败的布尔', () => {
    // `ok: boolean` 的含义是「不是 success 就算失败」，于是每次正常发布的过程中
    // 生产那一行都在报红字「失败」。
    expect(fleet).toContain('status: string;');
    expect(fleet).not.toMatch(/^\s*ok: boolean;/m);
    expect(fleet).not.toMatch(/ok:\s*run\s*\?/);
  });

  it('没有 run 记录时不替它宣布成功', () => {
    // 原来那一档硬写 ok: true——只有一个历史时间戳、根本不知道成没成。
    expect(fleet).toContain("status: run?.status || ''");
  });

  it('单元格与结论句都走共享判定，不各写一套状态表', () => {
    expect(matrix).toMatch(/import \{[^}]*runTone[^}]*\} from '\.\/shared'/);
    expect(matrix).not.toContain("lastRelease.ok");
    expect(fleet).toMatch(/import \{[^}]*isReleaseTerminal[^}]*\}/);
    expect(fleet).toContain('!isReleaseTerminal(st)');
  });
});

describe('发布控制台把「翻旧记录」和「本次发布」分开', () => {
  const page = read('pages/ReleaseConsolePage.tsx');

  it('历史条目进 historyRun，不进 run', () => {
    // run 会作为 sessionRun 递给 buildConsoleStance。历史条目混进去的话，标题从
    // 「上次发布成功」变成现在时的「发布成功」，「这不是本次操作」的提醒消失。
    expect(page).toContain('const [historyRun, setHistoryRun] = useState<ReleaseRun | null>(null);');
    expect(page).toContain('setHistoryRun(item);');
    expect(page).not.toContain('setRun(item);');
  });

  it('站位判定只把本次会话发起的 run 当 sessionRun', () => {
    expect(page).toContain('sessionRun: run,');
    expect(page).toContain('latestRun: historyRun ?? row?.latestRun ?? null,');
  });

  it('真正发起发布时清掉历史选择', () => {
    const starts = page.match(/setHistoryRun\(null\);\n\s*setRun\(res\.run\);/g) || [];
    expect(starts.length).toBe(3);
  });
});

describe('自动发布规则丢弃切项目前的旧响应', () => {
  const source = read('pages/release-center/AutoRulesSection.tsx');

  it('按请求代次比对，过期响应既不写列表也不写错误', () => {
    // 晚到的 A 响应覆盖 B 的列表后，删除只带 jobId 过去——页面显示 B，删掉的是 A。
    expect(source).toContain('const reqSeq = useRef(0);');
    expect(source).toContain('const seq = ++reqSeq.current;');
    expect(source.match(/if \(seq !== reqSeq\.current\) return;/g) || []).toHaveLength(2);
    expect(source).toContain('if (seq === reqSeq.current) setLoading(false);');
  });

  it('切项目先清空列表，宁可空一瞬也不挂别人的规则', () => {
    expect(source).toMatch(/setJobs\(\[\]\);\s*\n\s*void load\(\);/);
  });
});
