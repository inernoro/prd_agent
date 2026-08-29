import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 接线守卫：每日体检的**事实来源**这一段，删掉不会红，只会静默变错。
 *
 * 判定逻辑在 platform-daily-health 里，是纯函数、有一整个文件的回归。但判定再对，
 * 喂进去的事实错了照样出错误结论——而喂事实这一段全在 index.ts 里，没有任何用例
 * 覆盖得到（它跑在定时器里、依赖 docker）。2026-08-25 Codex review 连着抓到两条
 * 就出在这里：
 *
 *   1. 事实映射漏了 firewallBlocked。暴露面自检特意把「绑全网卡但被宿主防火墙挡着」
 *      降到 warn，因为说「任何人扫到就能直接读写」当场就能被验伪；映射把这一位丢了，
 *      体检那边又判回 critical，把假话原样说出去（形状 6：读到的不是生效的那个值）。
 *   2. 暴露面自检在「一个数据面容器都没认出来」时直接早退，于是
 *      lastInfraExposureReport 永远是 null，体检的首检守卫天天跳过——连备份新鲜度、
 *      恢复演练这些跟容器无关的项也一起被跳掉，而且这类部署每轮都一样，
 *      **永远等不到第一次结论**（形状 1：判据把「空结果」和「还没跑」混成一件事）。
 *
 * 所以这里钉源码。红绿闭环验过：把这两处改回事故写法，对应用例会红。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relativePath), 'utf8');
}

/**
 * 窗口化：拿全文 contains 断言是假绿——把这一行从映射里摘掉、别处还留着同名字段，
 * 守卫照样通过。照抄 release-observability-wiring-guard 的写法。
 */
function windowAfter(source: string, anchor: string, size: number): string {
  const at = source.indexOf(anchor);
  expect(at, `未找到接线锚点：${anchor}`).toBeGreaterThan(-1);
  return source.slice(at, at + size);
}

/**
 * 剥掉注释再断言。**「这段代码里不许出现 X」这类负向断言必须用它。**
 *
 * 否则守卫会被自己要防的那段事故写法的**说明文字**触发：修好之后，注释里通常正要
 * 写清楚「原来错在 `X`」，于是守卫永远红，下一个人只好把断言删掉或改宽——一条会
 * 误报的守卫最后一定被拆掉。这本身就是形状 6 的缩影：判据读的不是真正生效的那个东西。
 *
 * **顺序是 `windowAfter(codeOnly(src), …)`，不是 `codeOnly(windowAfter(src, …))`。**
 * 后者把注释也算进窗口长度：给被守的那段多写几行说明，窗口就在同样的字符数里
 * 装不下那么多代码，守卫当场报「少了 failedTargets」——而代码一个字都没改。
 * 先剥注释再取窗口，窗口量的才是真代码。
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

describe('每日体检的事实来源接线守卫', () => {
  it('事实映射把防火墙状态一起带过去了', () => {
    const source = read('src/index.ts');
    // 锚在映射本身，不是文件里随便哪处提到 firewallBlocked 的地方。
    const mapping = windowAfter(source, 'const infra: HealthInfraFact[] = exposure.findings.map(', 900);
    expect(
      mapping,
      '事实映射必须带 firewallBlocked：只传原始绑定的话，被防火墙挡住的库会被体检'
      + '重新判成 critical，并说出一句当场可以验伪的话',
    ).toContain('firewallBlocked: f.firewallBlocked');
    // 顺带钉住另外两位，防止「加新字段时顺手重排把旧的挤掉」。
    expect(mapping).toContain('publiclyPublished: f.publiclyPublished');
    expect(mapping).toContain('authenticated: f.authenticated');
  });

  it('「跑着但没发布端口」的那批也要接进事实', () => {
    const source = read('src/index.ts');
    // 锚在合并那一段本身，不是文件里随便哪处提到 internalOnly 的地方。
    const merge = windowAfter(source, 'for (const svc of exposure.internalOnly)', 400);
    expect(
      merge,
      'findings 是按暴露面筛过的清单，不是完整台账。只喂它进去，'
      + '「内网但无口令」那一整档永远不会响——一台纯内网的老库可以一直无声地没有口令',
    ).toContain('publiclyPublished: false');
    expect(merge).toContain('authenticated: svc.authenticated');
  });

  it('豁免倒计时从台账取，不从运行态事实取', () => {
    const source = read('src/index.ts');
    expect(
      source,
      '豁免是配置层的事实。挂回运行态事实上的话，覆盖面会被暴露面那层筛子卡住，'
      + '纯内网或当前停着的库到期前不会有任何提示',
    ).toContain('infraExemptions: exemptions');
    // 台账必须来自完整的 infra 服务清单，而不是 exposure 里那份。
    const ledger = windowAfter(source, 'const exemptions: InfraExemptionFact[] = [];', 300);
    expect(ledger).toContain('stateService.getInfraServices()');
  });

  /**
   * 台账里存的是**未展开的模板**，判据必须读展开后的值（台账 E75）。
   *
   * `InfraService.env` / `command` 里，值经常就是字面的 `${CDS_MYSQL_PASSWORD}`，
   * 到启动容器那一刻才解析——线上现在就有四个项目这样存着。拿生值去判认证，
   * 判据看到的是一串 `${...}`：它当然「有值」，于是每一台模板式配置的库都被判成
   * 「配了认证」，而它到底配没配，这条体检从来没真的看过（形状 6）。
   *
   * 这条守卫钉的是「取的是哪个时刻的值」，删掉不会红——判据本身照跑，只是永远
   * 得出好消息。
   */
  it('豁免判定读的是展开后的值，不是台账里的模板', () => {
    const source = read('src/index.ts');
    const loop = windowAfter(source, 'const exemptions: InfraExemptionFact[] = [];', 1_800);
    expect(
      loop,
      'env 必须先过 resolveEnvTemplates：直接送台账里的 `${...}` 进去，'
      + '认证判据会把每一台模板式配置的库都判成「已配认证」',
    ).toContain('env: resolveEnvTemplates(');
    expect(
      loop,
      'command / entrypoint 同理：redis 的认证判据只认启动参数，'
      + '送进去的若是未展开模板，等于判据从来没看过真正的启动命令',
    ).toContain('command: resolveCommandTemplate(');
    expect(loop).toContain('entrypoint: resolveCommandTemplate(');
    // 解析要用这台服务所属项目的变量，不是随便一份：变量是项目级的，
    // 拿错项目的解出来是空值，等于没解析（cross-project-isolation：标识要带作用域）。
    expect(
      loop,
      '模板解析要用这台服务所属项目的变量表',
    ).toContain("stateService.getCustomEnv(service.projectId || 'default')");
  });

  /**
   * 认证判据收敛成「只认启动参数」（台账 E81）之后，采集侧就得把启动参数**采全**。
   *
   * 原来只取 `.Config.Cmd`。memcached / nats 这类预设把 entrypoint 覆盖成 `sh`、
   * 真正的认证参数在 `-c '...'` 那段里——只读 Cmd 等于只看到半条命令。
   * 以前「env 里有口令也算认证」把这半条盖住了，现在盖不住，缺的那半条会直接
   * 变成假警报。判据只能读真正生效的那个东西（形状 6）。
   */
  it('暴露面自检把 Entrypoint 和 Cmd 一起采下来', () => {
    const source = read('src/index.ts');
    const inspect = windowAfter(source, "docker inspect --format '{{.Name}}", 300);
    expect(
      inspect,
      '只取 Cmd 会漏掉 entrypoint 被覆盖成 sh 的那批预设，认证参数全在那半条里',
    ).toContain('{{json .Config.Entrypoint}}');
    // 采下来还要真的并进判据的输入，不能只取不用（形状 2：建了一半）。
    const merge = windowAfter(source, 'let args: string[] = [];', 400);
    expect(merge, 'Entrypoint 采下来必须并进 args').toContain('...entrypoint');
    expect(merge).toContain('...cmd');
  });

  /**
   * 「这一轮跑完了」与「这一轮备全了」必须分开存（真机事故，2026-08-28）。
   *
   * 落盘那一行原来是 `completedAt: coverageComplete ? completedAt : null`：只要有一个
   * 目标没成，完成时间就被抹空。线上恰好长期有两个目标失败（redis / cds-state-mongo），
   * 于是每一轮都把时间抹掉，读它的两处判据只能说「读不到上一轮周期备份的结果——不确定
   * 备份到底有没有在跑」，而备份**每 6 小时就在跑、还留着完整的成败清单**。
   *
   * 一个字段回答两个问题，就必然在某一端说假话（形状 1）。更糟的是这盏灯从此废了：
   * 备份哪天真的整个停掉，报出来的还是同一句话——既不能证明有问题、也不能证明没问题。
   *
   * 这两条守卫钉源码，因为落盘与读盘都跑在定时器里、依赖 docker 与真实文件系统，
   * 纯函数用例够不着。红绿闭环验过：改回事故写法，对应用例会红。
   */
  it('落盘时完成时间不被「备全没备全」绑架', () => {
    const source = read('src/index.ts');
    const write = windowAfter(codeOnly(source), 'const allCoverageGaps = [...coverageGaps,', 2_400);
    expect(
      /completedAt:\s*coverageComplete\s*\?/.test(write),
      '完成时间只回答「跑没跑」。按 coverageComplete 抹空，会让一个长期部分失败的部署'
      + '天天被报成「读不到备份结果」，而它其实每轮都在跑',
    ).toBe(false);
    expect(write, '失败目标要留名字，否则拆开两个事实之后没人接住「一直没备成」').toContain('failedTargets:');
  });

  it('读盘时不许再抹一次空（同一个判据别抄两份）', () => {
    const source = read('src/index.ts');
    const reader = windowAfter(codeOnly(source), 'function readBackupHealth()', 1_600);
    expect(
      /coverageComplete\s*===\s*false/.test(reader),
      '同一个「把跑没跑和备没备全混成一件事」的判据曾经被抄了两份（形状 3）。'
      + '只修落盘那一处不够——基础设施健康那两条仍会报「备份时间未知，可能没有可恢复副本」',
    ).toBe(false);
  });

  it('体检的事实里带上两类失败目标', () => {
    const source = read('src/index.ts');
    const facts = windowAfter(source, "// 事实三：备份。", 2_400);
    expect(facts, '失败目标要从落盘结果读出来').toContain('value.failedTargets');
    expect(
      facts,
      '「本地备成了、只是离机没上去」要单独读。合进 failedTargets 会说成「手上没有新副本」，'
      + '把运维支去找一份其实存在的本地备份',
    ).toContain('value.offsiteOnlyTargets');
    expect(
      source,
      '读出来还要真的喂进判定（形状 2：建了一半）',
    ).toContain('backup: { lastCompletedAt, coverageGaps, failedTargets, offsiteOnlyTargets }');
  });

  /**
   * 「本地备份最近一次成功」这个看门狗信号不许被同轮其它目标的成功刷绿（Codex review P1）。
   *
   * 上一轮把落盘的 completedAt 改成「每轮都写」是对的——每日体检要的就是「还在跑吗」。
   * 但基础设施看门狗读的是同一个值、渲染成「本地备份」，于是一个本地导出连续失败
   * 几天的目标（真机上那个拿不到认证凭据的 redis）会被刷成绿灯。治好一个消费者的
   * 假警报、同时给另一个造了假绿灯，不叫修好。
   *
   * 所以落盘必须有第三个时间戳 localVerifiedAt，且看门狗必须读它。
   */
  /**
   * 落盘时两类失败必须分开装（Codex review P2）。
   *
   * 这条守卫是被红绿闭环逼出来的：把 `localFailures` 改回 `failed`（两类又合成一类），
   * 纯函数用例和其它守卫**全绿**——因为拆分发生在落盘那一步，跑在定时器里、依赖真实
   * 文件系统，用例够不着。判据「改动删掉后测试仍全绿就需要一条守卫」正是说这个。
   */
  it('落盘时把「本地就没成」和「只是离机没上去」分开装', () => {
    const source = read('src/index.ts');
    const write = windowAfter(codeOnly(source), 'const allCoverageGaps = [...coverageGaps,', 3_000);
    expect(
      /localFailures\s*=\s*failed\.filter\(\(outcome\)\s*=>\s*!outcome\.localOnly\)/.test(write),
      '本地失败要把 localOnly 那批排掉：它们的本地副本已过校验并转正，就在盘上',
    ).toBe(true);
    expect(
      /offsiteOnlyFailures\s*=\s*failed\.filter\(\(outcome\)\s*=>\s*outcome\.localOnly\)/.test(write),
      '离机没上去的那批要单独成一列，否则它们要么被说成「没有新副本」、要么彻底消失',
    ).toBe(true);
    expect(write, '两列都要落盘').toContain('offsiteOnlyTargets:');
    // 失败原因要留给用户点开看，但**必须过一遍脱敏**：原文是 docker exec 的合并输出，
    // 可能带着容器 env 打出来的口令，而这份文件会经备份面板端点回到浏览器。
    expect(
      /reason: backupFailureReason\(outcome\.error\)/.test(write),
      '失败原因要走 backupFailureReason（脱敏 + 截尾），不许把 outcome.error 原样落盘',
    ).toBe(true);
    expect(
      /reason: outcome\.error/.test(write),
      '原样落盘等于把口令换个地方泄漏',
    ).toBe(false);
    // 身份带项目：真机一轮里有六个叫 redis 的目标，裸 id 的告警路由不到人。
    expect(write, '失败目标要带 projectId').toContain('projectId: outcome.projectId');
  });

  it('看门狗的「本地备份」读 localVerifiedAt，不读每轮都前进的 completedAt', () => {
    const source = read('src/index.ts');
    const write = windowAfter(codeOnly(source), 'const allCoverageGaps = [...coverageGaps,', 2_800);
    expect(write, '落盘要单独记「本地全成」的时刻').toContain('localVerifiedAt:');
    expect(
      /localVerifiedAt:\s*localFailures\.length === 0/.test(write),
      '它只有在本轮本地一个都没失败时才前进；离机没上去（localOnly）不算本地失败',
    ).toBe(true);

    const reader = windowAfter(codeOnly(source), 'function readBackupHealth()', 1_800);
    expect(
      /localVerifiedAt:\s*value\.localVerifiedAt/.test(reader),
      '看门狗这一路必须取 localVerifiedAt。取 completedAt 会让本地连续失败的目标被刷绿',
    ).toBe(true);
    expect(
      source,
      '取到了还要真的接进看门狗的输入（形状 2）',
    ).toContain('backupCompletedAt: backup.localVerifiedAt');
  });

  it('暴露面自检不许在「没认出容器」时早退', () => {
    const source = read('src/index.ts');
    expect(
      /rows\.length === 0\)\s*return/.test(source),
      '「一个数据面容器都没认出来」是检查完了的结果，不是没检查。早退会让'
      + ' lastInfraExposureReport 永远停在 null，于是这类部署天天跳过每日体检',
    ).toBe(false);
  });

  it('空容器集也要走到报告赋值这一步', () => {
    const source = read('src/index.ts');
    const audit = windowAfter(source, 'const rows: Array<{ name: string; image: string;', 6_500);
    // 判据是「rows 为空时只跳过为它们做的 inspect 与防火墙探测」，
    // 而不是跳过整轮——所以这两处必须是条件执行，报告赋值必须在条件之外。
    expect(audit, 'inspect 与防火墙探测应当只在有容器时才跑').toContain('if (rows.length > 0)');
    expect(audit, '无论有没有容器都要产出报告并赋值').toContain('lastInfraExposureReport = report');
  });
});
