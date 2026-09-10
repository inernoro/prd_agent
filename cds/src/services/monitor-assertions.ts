/**
 * monitor-assertions — 监控判据的唯一比较引擎。
 *
 * 存活监控问「通不通」，功能监控问「返回的东西对不对」。后者需要在一次响应上
 * 判多条（生成成功吗、尺寸对吗、够快吗），但**比较本身必须只有一份实现**：
 * health-json 与功能监控各写一套，迟早在「0 与 '0' 算不算相等」这种地方分叉，
 * 表现为同一个值在两种监控里判出相反结论（predicate-and-wiring-discipline 形状 3）。
 *
 * 判据刻意是结构化三元组（path / op / value），不是可解析的表达式：
 * 自由文本判据一旦开口，下一轮就会被要求加同义词、嵌套和函数调用
 * （CLAUDE.md 5.5 点名的熔断条件）。
 */

export const ASSERT_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'absent'] as const;
export type AssertOp = (typeof ASSERT_OPS)[number];

/** 不需要 value 的运算——校验时不该逼调用方填一个没意义的期望值。 */
export const VALUELESS_OPS: ReadonlyArray<AssertOp> = ['exists', 'absent'];

export interface MonitorAssertion {
  /** 点分路径，支持数组下标：`image.width`、`data.images.0.url` */
  path: string;
  op: AssertOp;
  /** exists / absent 不需要 */
  value?: string;
}

export interface AssertionResult {
  path: string;
  op: AssertOp;
  expected?: string;
  /** 实际读到的值（缺失为 undefined）——失败信息里必须带上它，否则排障还得自己再打一次 */
  actual?: string;
  ok: boolean;
  err?: string;
}

/**
 * 按点分路径取值。
 *
 * 只做取值，不求值：路径里没有函数、没有通配、没有条件——那些正是自由文本判据的入口。
 * 取不到返回 undefined，**调用方必须把「取不到」当失败**，不是当通过：
 * 判据指向一个不存在的字段，说明接口和判据已经对不上了。
 */
export function readPath(doc: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 数字与数字字符串归一，免得 0 与 "0" 因为类型不同被判成不等——那是纯粹的假故障。 */
function normalizeScalar(v: string): string {
  return Number.isFinite(Number(v)) && v.trim() !== '' ? String(Number(v)) : v;
}

/**
 * 比较一个观测值。这是全系统唯一一处「判据成不成立」的定义。
 */
export function compareValue(
  actual: unknown,
  op: AssertOp,
  expected: string | undefined,
): { ok: boolean; err?: string } {
  const missing = actual === undefined || actual === null;

  if (op === 'exists') {
    return missing ? { ok: false, err: '字段不存在' } : { ok: true };
  }
  if (op === 'absent') {
    return missing ? { ok: true } : { ok: false, err: `字段存在（值 ${String(actual)}），期望不存在` };
  }
  if (missing) {
    return { ok: false, err: '字段不存在，无法比较' };
  }

  const observed = String(actual);
  const want = expected ?? '';

  if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    const a = Number(observed);
    const b = Number(want);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { ok: false, err: `${observed} 或 ${want} 不是数字，无法做大小比较` };
    }
    const ok = op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
    return ok ? { ok: true } : { ok: false, err: `实际 ${observed}，期望 ${op} ${want}` };
  }

  const same = normalizeScalar(observed) === normalizeScalar(want);
  const ok = op === 'eq' ? same : !same;
  return ok
    ? { ok: true }
    : { ok: false, err: `实际 ${observed}，期望${op === 'eq' ? '等于' : '不等于'} ${want}` };
}

/**
 * 在一份响应上逐条求值。
 *
 * **全部跑完再回**，不短路：一次观测要能一眼看出「四条里哪一条挂了」，
 * 短路只报第一条会让人以为后面的都没问题，而下一轮修完第一条又冒出第二条。
 */
export function evaluateAssertions(doc: unknown, assertions: ReadonlyArray<MonitorAssertion>): {
  ok: boolean;
  results: AssertionResult[];
} {
  const results = assertions.map((a) => {
    const actual = readPath(doc, a.path);
    const verdict = compareValue(actual, a.op, a.value);
    return {
      path: a.path,
      op: a.op,
      ...(a.value === undefined ? {} : { expected: a.value }),
      ...(actual === undefined || actual === null ? {} : { actual: String(actual) }),
      ok: verdict.ok,
      ...(verdict.err ? { err: verdict.err } : {}),
    };
  });
  return { ok: results.every((r) => r.ok), results };
}

/** 一句人话概括这次判定，给通知正文与列表用。 */
export function describeAssertionFailure(results: ReadonlyArray<AssertionResult>): string {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return '';
  const first = failed[0];
  const head = `${first.path} ${first.err || '不满足判据'}`;
  return failed.length === 1 ? head : `${head}（另有 ${failed.length - 1} 条未通过）`;
}
