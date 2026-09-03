import { describe, expect, it } from 'vitest';
import {
  deriveOverviewState,
  isTransitioning,
  overviewCopy,
  type OverviewFacts,
  type OverviewState,
} from '@/lib/overview-state';

/**
 * 总览判断句的状态表（台账 D11）。
 *
 * 这一片文案连续六轮 review 都在报「同屏两句话互相矛盾」，每一轮的修法都是给某处
 * 三元表达式再加一个条件；第六轮时判断句已经是五层嵌套、内含一层三元，新分岔藏在
 * 哪一层没人看得出来。D11 要求换写法：事实先归约成有限状态，再由状态查表出文案。
 *
 * 换了写法就必须能穷举——这个文件把八档全部钉住，并且用**旧写法本身**当反例，
 * 证明这里的不变量不是「怎么写都绿」（predicate-and-wiring-discipline 形状 4b）。
 */

const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  lifecycle: undefined,
  running: false,
  serviceCount: 0,
  readyCount: 0,
  badCount: 0,
  entryCount: 0,
  metricsReady: true,
  ...over,
});

describe('生命周期归约', () => {
  it('只有 building / starting / restarting 算在途', () => {
    expect(['building', 'starting', 'restarting'].every(isTransitioning)).toBe(true);
    expect(['running', 'stopped', 'ready', 'failed', 'unknown'].some(isTransitioning)).toBe(false);
  });

  it('缺省 lifecycle 视为不在途（老调用方行为不变）', () => {
    expect(isTransitioning(undefined)).toBe(false);
  });
});

describe('事实 → 状态（八档全覆盖）', () => {
  const cases: Array<[OverviewState, OverviewFacts]> = [
    ['broken', facts({ running: true, serviceCount: 3, readyCount: 2, badCount: 1 })],
    ['failed', facts({ lifecycle: 'error', serviceCount: 0 })],
    ['provisioning', facts({ lifecycle: 'building', serviceCount: 0 })],
    ['unconfigured', facts({ running: true, serviceCount: 0 })],
    ['redeploying', facts({ lifecycle: 'building', serviceCount: 2, readyCount: 2 })],
    ['deploying', facts({ lifecycle: 'starting', serviceCount: 2, readyCount: 1 })],
    ['healthy', facts({ running: true, serviceCount: 2, readyCount: 2 })],
    ['partial', facts({ running: true, serviceCount: 3, readyCount: 1 })],
    ['stopped', facts({ running: false, serviceCount: 2, readyCount: 0 })],
  ];

  it.each(cases)('归约到 %s', (expected, f) => {
    expect(deriveOverviewState(f)).toBe(expected);
  });

  it('九档一个不少，且这张表真的覆盖了全部档位', () => {
    const covered = new Set(cases.map(([s]) => s));
    const produced = new Set(cases.map(([, f]) => deriveOverviewState(f)));
    expect(covered.size).toBe(9);
    expect([...produced].sort()).toEqual([...covered].sort());
  });

  /**
   * webhook 派发失败会把刚建出来的空分支置成 error（Codex P2，核对属实）。
   * 有服务时不改判：那时每个服务自己的状态更具体，也更新。
   */
  it('分支级 error：没有服务时单独成档，有服务时仍由服务状态说了算', () => {
    expect(deriveOverviewState(facts({ lifecycle: 'error', serviceCount: 0 }))).toBe('failed');
    expect(deriveOverviewState(facts({ lifecycle: 'error', serviceCount: 2, readyCount: 0 }))).toBe('stopped');
    expect(deriveOverviewState(facts({
      lifecycle: 'error', serviceCount: 2, readyCount: 1, badCount: 1,
    })), '有具体的异常服务时，broken 更具体').toBe('broken');
  });

  it('异常优先级最高：不管在跑还是在途，有 error 就是 broken', () => {
    for (const lifecycle of [undefined, 'building', 'starting', 'restarting', 'running']) {
      for (const running of [true, false]) {
        expect(deriveOverviewState(facts({
          lifecycle, running, serviceCount: 2, readyCount: 2, badCount: 1,
        }))).toBe('broken');
      }
    }
  });
});

/** 逐一枚举出真实可能的事实组合，供不变量断言遍历。 */
const allFacts = (): OverviewFacts[] => {
  const out: OverviewFacts[] = [];
  // 分支生命周期的完整枚举（见 cds/src/types.ts 的 BranchEntry.status）+ 缺省
  for (const lifecycle of [
    undefined, 'idle', 'building', 'starting', 'running', 'restarting', 'stopping', 'stopped', 'error',
  ]) {
    for (const running of [true, false]) {
      for (const serviceCount of [0, 1, 3]) {
        for (let readyCount = 0; readyCount <= serviceCount; readyCount += 1) {
          for (const badCount of [0, 1]) {
            if (badCount > serviceCount - readyCount) continue;
            for (const entryCount of [0, 2]) {
              for (const metricsReady of [true, false]) {
                out.push({ lifecycle, running, serviceCount, readyCount, badCount, entryCount, metricsReady });
              }
            }
          }
        }
      }
    }
  }
  return out;
};

/** 判断句里那个「还有 N 个服务没起来 / 还没起来」的 N。没这句就是 undefined。 */
const claimedMissing = (verdict: string): number | undefined => {
  const m = /(\d+) 个服务(?:没起来|还没起来)/.exec(verdict);
  return m ? Number(m[1]) : undefined;
};

describe('不变量：判断句不许说假话', () => {
  const combos = allFacts();

  it('组合表本身不是空的，且九档全被走到（空遍历、漏档都必然绿）', () => {
    expect(combos.length).toBeGreaterThan(200);
    expect(new Set(combos.map((f) => deriveOverviewState(f))).size).toBe(9);
  });

  it('判断句从不宣称「0 个服务没起来」', () => {
    for (const f of combos) {
      expect(claimedMissing(overviewCopy(f).verdict), JSON.stringify(f)).not.toBe(0);
    }
  });

  it('判断句宣称的缺口数就是真实缺口数', () => {
    for (const f of combos) {
      const n = claimedMissing(overviewCopy(f).verdict);
      if (n !== undefined) expect(n, JSON.stringify(f)).toBe(f.serviceCount - f.readyCount);
    }
  });

  it('一个服务都没配的时候，判断句不谈服务起没起来', () => {
    for (const f of combos.filter((x) => x.serviceCount === 0)) {
      expect(claimedMissing(overviewCopy(f).verdict), JSON.stringify(f)).toBeUndefined();
    }
  });

  it('色调：bad 当且仅当有异常，ok 当且仅当在跑且全就绪', () => {
    for (const f of combos) {
      const { tone, state } = overviewCopy(f);
      expect(tone === 'bad', JSON.stringify(f)).toBe(state === 'broken' || state === 'failed');
      expect(tone === 'ok', JSON.stringify(f)).toBe(state === 'healthy');
    }
  });

  it('入口卡只在 healthy 时说「服务已就绪」，只在 redeploying 时说「正在部署」', () => {
    for (const f of combos) {
      const { state, entryLabel } = overviewCopy(f);
      expect(entryLabel.includes('服务已就绪'), JSON.stringify(f)).toBe(state === 'healthy');
      expect(entryLabel.includes('正在部署'), JSON.stringify(f)).toBe(state === 'redeploying');
    }
  });

  it('骨架屏注解：有容器在跑就交回骨架屏，只在快照没回来时插一句', () => {
    for (const f of combos.filter((x) => x.readyCount > 0)) {
      const note = overviewCopy(f).skeletonNote;
      expect(note, JSON.stringify(f)).toBe(f.metricsReady ? undefined : '正在读取指标…');
    }
  });

  it('一个容器都没起来时，注解必须说清为什么没有曲线', () => {
    for (const f of combos.filter((x) => x.readyCount === 0)) {
      expect(overviewCopy(f).skeletonNote, JSON.stringify(f)).toBeTruthy();
    }
  });
});

describe('反例：旧写法会被上面的不变量抓住（形状 4b 自证）', () => {
  /**
   * 被替换掉的那串嵌套三元，一字不改地搬进测试。它只在这里存在——用来证明上面
   * 那几条不变量不是「怎么写都绿」。它一旦通过，说明不变量已经失效，该修的是不变量。
   */
  const legacyVerdict = (f: OverviewFacts): string => {
    const transitioning = isTransitioning(f.lifecycle);
    const allServicesReady = f.running && f.serviceCount > 0 && f.readyCount === f.serviceCount;
    return f.badCount > 0
      ? `有 ${f.badCount} 个服务异常，${f.entryCount > 0 ? '入口可能打不开' : '分支未就绪'}`
      : allServicesReady
        ? '一切正常，可以直接验收'
        : f.running
          ? `还有 ${f.serviceCount - f.readyCount} 个服务没起来`
          : transitioning
            ? (f.serviceCount - f.readyCount > 0
              ? `正在部署，${f.serviceCount - f.readyCount} 个服务还没起来`
              : '正在部署，当前服务仍在运行')
            : '分支未运行';
  };

  it('旧写法在「在跑但一个服务都没配」时会说「还有 0 个服务没起来」', () => {
    const f = facts({ running: true, serviceCount: 0 });
    expect(legacyVerdict(f)).toBe('还有 0 个服务没起来');
    expect(claimedMissing(legacyVerdict(f))).toBe(0);
    // 新写法在同一份事实上不再谈服务起没起来
    expect(claimedMissing(overviewCopy(f).verdict)).toBeUndefined();
    expect(overviewCopy(f).verdict).toBe('尚未配置服务');
  });

  it('旧写法在「在跑 + 有异常 + 已被 running 分支盖住」之外，还会漏掉在途的 0 缺口', () => {
    // 在途、服务全就绪：旧写法要靠内层三元兜住，任何一次改写把它压平就会再次说假话。
    const f = facts({ lifecycle: 'building', serviceCount: 2, readyCount: 2 });
    expect(claimedMissing(legacyVerdict(f))).toBeUndefined();
    expect(overviewCopy(f).verdict).toBe('正在部署，当前服务仍在运行');
  });

  it('把旧写法喂给不变量，「不许说 0 个」这条会红', () => {
    const violations = allFacts().filter((f) => claimedMissing(legacyVerdict(f)) === 0);
    expect(violations.length, '不变量抓不到旧写法，说明它已经失效').toBeGreaterThan(0);
  });
});
