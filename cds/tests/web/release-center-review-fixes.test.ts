/**
 * release-center-review-fixes.test.ts —— Codex 第二、三轮 review 的判定源。
 *
 * 每一段对应一条：预览地址不许凭空造、主目标默认值、试跑失败要说清楚、
 * 外发链接必须绝对化。都是纯函数，配一条接线守卫证明页面真的在用。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolvePreviewUrl } from '../../web/src/lib/previewUrl';
import { canonicalEnvironments, defaultIsCanonical } from '../../web/src/lib/releaseEnvironments';
import { isShownRunCurrent, planRollbackToVersion, resolveFleetRowAction } from '../../web/src/lib/releaseConsoleState';
import { describeDryRunResult } from '../../web/src/lib/releaseDiagnosis';
import { runTone, statusLabel } from '../../web/src/pages/release-center/shared';
import { FleetMatrix } from '../../web/src/pages/release-center/FleetMatrix';
import { EnvConfigSection } from '../../web/src/pages/release-center/EnvConfigSection';
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

  /**
   * 判据是「每一条都清」，不是「一共有几条」。
   *
   * 原来断言的是恰好 3 条——加一条新的发起路径（回滚到指定版本）就会误红，
   * 而行为完全正确。数量不是不变量，「接管主屏之前先清掉历史选择」才是。
   */
  it('每一条发起路径都在接管主屏前清掉历史选择', () => {
    const takeovers = [...page.matchAll(/setRun\(res\.run\);/g)];
    expect(takeovers.length).toBeGreaterThanOrEqual(3);
    for (const match of takeovers) {
      const before = page.slice(Math.max(0, match.index! - 120), match.index!);
      expect(before, `第 ${page.slice(0, match.index).split('\n').length} 行的 setRun(res.run) 之前没有清 historyRun`)
        .toContain('setHistoryRun(null);');
    }
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

/**
 * 第六轮。前两条与第五轮的 EvidenceSection / AutoRulesSection 是**同一个形状**在
 * 控制台页的另一处——修一处不横扫同类，下一轮照样被指出来。所以这次连带把
 * 控制台的历史轨与项目切换一起收了。
 */
describe('发布控制台：切项目后丢弃旧响应', () => {
  const page = read('pages/ReleaseConsolePage.tsx');

  it('判据只有一份，所有项目级请求共用', () => {
    // 挂在 B 名下却列着 A 的环境时，重试/回滚/取消/发布都按 A 的 id 发出去；
    // 分支列表错配还会被后端的项目一致性预检拒掉，发布卡死到手动刷新。
    expect(page).toContain('const isStaleProject = useCallback((p: string): boolean => currentProject.current !== p, []);');
  });

  /**
   * 这一条是**清单式**的：前两轮 review 各抓到一处漏网的项目级请求（先是 center，
   * 再是 branches），一处一处补必然还会漏第三处。所以这里不点名某一处，而是扫出
   * 文件里全部带 `?project=` 的请求，逐个要求它有 staleness 判据。
   */
  it('每一个带 project 的请求都过闸——不许有漏网的', () => {
    const lines = page.split('\n');
    const requests = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => /apiRequest</.test(line) && /project=\$\{encodeURIComponent/.test(line));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const { line, idx } of requests) {
      // 「附近有一句 isStaleProject」不够——写在 catch 里、写在 setXxx 之后都算
      // 「有」，而成功路径照样会把旧项目的数据写进去。判据必须**先于**这条请求
      // 之后的第一次状态写入。
      const window = lines.slice(idx, idx + 12);
      const guardAt = window.findIndex((l) => l.includes('isStaleProject('));
      const writeAt = window.findIndex((l) => /\bset[A-Z]\w*\(/.test(l));
      const where = `第 ${idx + 1} 行：${line.trim()}`;
      expect(guardAt, `${where} —— 请求之后没有过期判据`).toBeGreaterThanOrEqual(0);
      expect(writeAt, `${where} —— 没找到状态写入，用例的窗口可能失效了`).toBeGreaterThanOrEqual(0);
      expect(guardAt, `${where} —— 过期判据排在状态写入之后，等于没有`).toBeLessThan(writeAt);
    }
  });

  it('切项目时把上一个项目的数据清空，宁可空一瞬', () => {
    expect(page).toMatch(/setProjectId\(item\.id\);\s*setCenter\(null\);\s*setBranches\(\[\]\);/);
  });
});

describe('发布控制台历史轨不把在途当成功', () => {
  const page = read('pages/ReleaseConsolePage.tsx');

  it('状态走 shared 映射，不再是「非失败非线上即成功」', () => {
    expect(page).toMatch(/import \{[^}]*runTone[^}]*\} from '\.\/release-center\/shared'/);
    expect(page).not.toContain("{itemFailed ? '失败' : live ? '线上' : '成功'}");
    expect(page).toContain("live ? '线上' : statusLabel(item.status)");
  });

  it('回滚只给真正发完的版本', () => {
    expect(page).toContain("const itemDone = item.status === 'success' || item.status === 'rollback_success';");
    expect(page).toContain('{itemDone && itemRow?.canRollback && !live ? (');
    expect(page).not.toContain('{!itemFailed && itemRow?.canRollback');
  });
});

/**
 * 翻看历史记录时，页面不许把它说成「环境当前那一版」（Codex review P2，2026-08-16）。
 *
 * 「看日志」会把 `shown` 指到一条历史 run 上，而终态结论条和回滚按钮说的都是
 * 当前环境——于是翻一条三天前的成功记录，屏幕上写着「已切到 abc1234」，
 * 线上跑的其实是后来那一版；「回滚」也变成撤销一条早已不是当前版本的发布。
 */
describe('isShownRunCurrent 区分「当前那一版」与「翻出来看的历史」', () => {
  it('本次会话自己发起的那条永远算当前', () => {
    // 刚发完时 center 还没刷回来，只按 latestRun 判会把自己刚发的那版说成历史。
    expect(isShownRunCurrent({
      shownReleaseId: 'rel_new', sessionReleaseId: 'rel_new', latestReleaseId: 'rel_old',
    })).toBe(true);
  });

  it('等于目标最新那条时算当前', () => {
    expect(isShownRunCurrent({ shownReleaseId: 'rel_latest', latestReleaseId: 'rel_latest' })).toBe(true);
  });

  it('翻出来的旧记录不算当前', () => {
    expect(isShownRunCurrent({ shownReleaseId: 'rel_old', latestReleaseId: 'rel_latest' })).toBe(false);
  });

  it('什么都没选时不算当前，别把空当成成功', () => {
    expect(isShownRunCurrent({ latestReleaseId: 'rel_latest' })).toBe(false);
    expect(isShownRunCurrent({ shownReleaseId: '   ', latestReleaseId: 'rel_latest' })).toBe(false);
  });

  /**
   * 空 id 之间不许相等：三个字段都缺时 `'' === ''` 会把「什么都没有」判成当前，
   * 于是空状态也能挂上一句「已切到」。
   */
  it('两边都空不算相等', () => {
    expect(isShownRunCurrent({ shownReleaseId: '', sessionReleaseId: '', latestReleaseId: '' })).toBe(false);
  });
});

describe('发布控制台的「已切到」必须挂在当前那一版上（接线守卫）', () => {
  const page = read('pages/ReleaseConsolePage.tsx');

  it('判据取自 lib，不在页面里另写一份', () => {
    expect(page).toContain('isShownRunCurrent({');
    // 页面自己拿 releaseId 手搓一遍比较 = 判据分裂，下次只会改一边
    expect(page).not.toMatch(/shown\.releaseId === (run|row)\?\./);
  });

  /**
   * 不点名某一处，而是扫出每一句宣称「已切到」的文案，逐个要求它被
   * shownIsCurrent 分流过——只补当前这一处，下一处照样会漏。
   */
  it('每一句「已切到」都被 shownIsCurrent 分流', () => {
    const lines = page.split('\n');
    const isComment = (l: string): boolean => {
      const t = l.trim();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    };
    const claims = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.includes('已切到') && !isComment(line));
    expect(claims.length).toBeGreaterThanOrEqual(1);
    for (const { line, idx } of claims) {
      const window = lines.slice(Math.max(0, idx - 6), idx + 1).join('\n');
      expect(window, `第 ${idx + 1} 行：${line.trim()} —— 没有被 shownIsCurrent 分流`)
        .toContain('shownIsCurrent');
    }
  });

  it('回滚按钮同样只出现在当前那一版上', () => {
    expect(page).toContain('{!failed && shownIsCurrent && row?.canRollback ? (');
  });
});

/**
 * 「回滚到此版本」必须真的回滚到那一版（Codex review P1，2026-08-16）。
 *
 * 回滚接口有两个 id：路径上的 `:id` 是「从哪一版退下来」，body 的 `targetReleaseId`
 * 是「退到哪一版」。历史列表原来把被点的那条当成 `:id` 且不传 targetReleaseId，
 * 后端于是按那条的 previousReleaseId 选落点——点 B 发的是 B 之前那一版 A。
 */
describe('planRollbackToVersion 分清「从哪退」与「退到哪」', () => {
  it('从当前线上那一版退到被点的那一版', () => {
    expect(planRollbackToVersion({ targetReleaseId: 'rel_b', currentReleaseId: 'rel_live' }))
      .toEqual({ from: 'rel_live', targetReleaseId: 'rel_b' });
  });

  it('当前版本取不到时退回该环境最新那条', () => {
    expect(planRollbackToVersion({ targetReleaseId: 'rel_b', latestReleaseId: 'rel_latest' }))
      .toEqual({ from: 'rel_latest', targetReleaseId: 'rel_b' });
  });

  /** 省略 targetReleaseId 等于把落点交给后端猜，而猜错就是往生产发错版本。 */
  it('两个 id 缺任何一个都报错，不省略参数硬发', () => {
    expect(planRollbackToVersion({ targetReleaseId: 'rel_b' })).toHaveProperty('error');
    expect(planRollbackToVersion({ currentReleaseId: 'rel_live' })).toHaveProperty('error');
  });

  it('点的就是当前版本时不发请求', () => {
    expect(planRollbackToVersion({ targetReleaseId: 'rel_live', currentReleaseId: 'rel_live' }))
      .toHaveProperty('error');
  });
});

describe('发布控制台回滚请求走 plan（接线守卫）', () => {
  const page = read('pages/ReleaseConsolePage.tsx');

  it('历史列表的按钮调 rollbackToVersion，不复用「撤销当前版本」', () => {
    expect(page).toContain('void rollbackToVersion(item, itemRow)');
    expect(page).not.toContain('onClick={() => void rollbackRun(item)}');
  });

  it('请求路径与 body 都取自 plan，不在页面里手搓 id', () => {
    expect(page).toContain('planRollbackToVersion({');
    expect(page).toContain('encodeURIComponent(plan.from)');
    expect(page).toContain('body: { targetReleaseId: plan.targetReleaseId }');
  });
});

/**
 * 「提升版本」必须走本页那套带 expectedCommitSha 的确认弹窗（Codex review P1，2026-08-16）。
 *
 * 原来三个动作一律 navigate 到控制台，intent=promote 在路上被丢掉：控制台收不到
 * 候选 sha，只会按它自己默认选中的分支发一版——按钮写着「提升版本」，发的是别的东西。
 */
describe('resolveFleetRowAction 把提升留在本页', () => {
  it('有候选时留本页走提升', () => {
    expect(resolveFleetRowAction('promote', true)).toEqual({ kind: 'promote' });
  });

  it('候选没了就退回普通发布，不假装能提升', () => {
    expect(resolveFleetRowAction('promote', false)).toEqual({ kind: 'navigate' });
  });

  it('发布与回滚照常跳控制台，回滚带上 intent', () => {
    expect(resolveFleetRowAction('deploy', false)).toEqual({ kind: 'navigate' });
    expect(resolveFleetRowAction('rollback', false)).toEqual({ kind: 'navigate', intent: 'rollback' });
    // 有候选也不影响回滚——两个动作各走各的
    expect(resolveFleetRowAction('rollback', true)).toEqual({ kind: 'navigate', intent: 'rollback' });
  });
});

describe('发布中心矩阵的提升动作（接线守卫）', () => {
  const page = read('pages/ReleaseCenterPage.tsx');
  const matrix = read('pages/release-center/FleetMatrix.tsx');

  it('提升走 startPromotion，不再 navigate 到控制台', () => {
    expect(page).toContain('resolveFleetRowAction(intent,');
    expect(page).toContain('void startPromotion(promoteRow)');
    // 原来的写法：三个动作一律 navigate，intent 只用来决定要不要带 rollback
    expect(page).not.toContain("navigate(consoleHref(envId, intent === 'rollback' ? 'rollback' : undefined))");
  });

  it('startPromotion 钉死候选 commit——提升的全部意义就在这一行', () => {
    expect(page).toContain('expectedCommitSha: row.promotion.commitSha');
  });

  it('矩阵不再声称「所有动作都跳控制台」——提升是例外', () => {
    expect(matrix).not.toContain('所有动作都跳发布控制台');
  });
});

/**
 * 候选已经不是分支 tip 时后端必然拒发，按钮不能还亮着让人点一次才知道。
 * 这一段真渲染一遍矩阵，断言的是 DOM 上的 disabled 与 title，不是源码里出现过某个变量名。
 */
describe('矩阵对不可执行的提升候选给出禁用与原因（渲染）', () => {
  const baseEnv = {
    id: 'rt_prod',
    name: '生产站点',
    host: '10.0.0.1',
    type: 'production' as const,
    isPrimary: true,
    enabled: true,
    liveSha: 'aaaaaaa',
    behindMain: 2,
    health: 'healthy' as const,
    availability24h: 99.9,
    lastRelease: null,
    canRollback: true,
    promotableSha: 'bbbbbbbbbb',
    promotableExecutable: true,
    promotableBlockedReason: null as string | null,
    dora: null,
  };
  const renderMatrix = (env: typeof baseEnv): string => renderToStaticMarkup(createElement(FleetMatrix, {
    envs: [env],
    sort: 'severity' as const,
    onSort: () => {},
    nowMs: Date.parse('2026-08-16T20:00:00Z'),
    wide: true,
    onInspect: () => {},
    onExecute: () => {},
  }));

  it('可执行时按钮是亮的', () => {
    const html = renderMatrix(baseEnv);
    expect(html).toContain('提升版本');
    // 只有停用/不可执行才会带 disabled；这一档不该有
    expect(html).not.toContain('disabled=""');
  });

  it('不可执行时按钮禁用，并把原因挂到 title 上', () => {
    const html = renderMatrix({
      ...baseEnv,
      promotableExecutable: false,
      promotableBlockedReason: '源环境那一版已不是分支 tip',
    });
    expect(html).toContain('disabled=""');
    expect(html).toContain('源环境那一版已不是分支 tip');
  });

  it('没有原因文案时也不能让按钮亮着', () => {
    const html = renderMatrix({ ...baseEnv, promotableExecutable: false });
    expect(html).toContain('disabled=""');
    expect(html).toContain('这个候选版本现在提升不了');
  });
});

/**
 * 发布模式在环境配置卡里是只读的（Codex 第十轮 P1）。
 *
 * 后端 `validateReleaseStrategy` 对两种 generated 模式各有必填字段，而这张表单
 * 一个都没有。之前那个三选下拉里有两个选项点了必然 400——三分之二的选项是坏的。
 * 现在只显示当前模式 + 一个去站点向导的出口（向导有完整字段）。
 */
describe('EnvConfigSection 不提供必然失败的模式切换', () => {
  const rowWith = (strategy: { mode: 'existing-script' | 'generated-compose' | 'generated-static'; command?: string }) => ({
    target: {
      id: 'tgt_1',
      projectId: 'prd-agent',
      name: '生产',
      type: 'ssh',
      isEnabled: true,
      strategy,
      ssh: {
        host: '10.0.0.5', port: 22, user: 'root', privateKeyRef: 'key_1',
        appPath: '/opt/prd-agent', deployCommand: './fast.sh', healthcheckUrl: 'https://app.miduo.org/healthz',
      },
    },
    currentVersion: 'v1', currentCommit: 'abc1234', healthStatus: 'ok', canRollback: true,
  });

  const render = (strategy: Parameters<typeof rowWith>[0]): string => renderToStaticMarkup(createElement(EnvConfigSection, {
    row: rowWith(strategy) as never,
    onSaved: () => {},
    onReload: () => {},
    onConfigure: () => {},
  }));

  it('generated 模式的目标显示模式名，但没有可切换的下拉', () => {
    const html = render({ mode: 'generated-compose' });
    expect(html).toContain('生成的 Compose');
    // 这才是要害：下拉一旦存在，另外两个选项保存时必然被后端 400 打回。
    expect(html).not.toContain('<select');
  });

  it('existing-script 目标同样只读，并给出去向导的出口', () => {
    const html = render({ mode: 'existing-script', command: './fast.sh' });
    expect(html).toContain('项目现有脚本');
    expect(html).not.toContain('<select');
    expect(html).toContain('改用其他模式');
  });
});

describe('发布中心把向导入口接给了环境配置卡（接线守卫）', () => {
  const source = read('pages/ReleaseCenterPage.tsx');

  it('EnvConfigSection 拿到 onConfigure，否则那个出口是死的', () => {
    expect(source).toMatch(/onConfigure=\{\(\) => openConfigureWizard\(selectedRow\.target\)\}/);
  });
});
