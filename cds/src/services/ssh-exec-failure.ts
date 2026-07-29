/**
 * SSH 非零退出 → Error.message 的唯一构造源。
 *
 * 为什么要有这个模块：
 *   2026-07-29 16:07 的 rel_3c72935be772e798 发布失败，门禁挂在 gateway_route_self_test
 *   （ok=false / status=401）。但用户在发布中心什么都看不见——因为判据那段 JSON 是
 *   scripts/llmgw-prod-preflight.py 用 print() 写到 **stdout** 的，而当时的失败摘要写成
 *   `stderr.slice(0, 500)`：stdout 被整段丢弃，stderr 在 set -eu 下几乎是空的，
 *   于是摘要退化成一句 `ssh exec exit=1 stderr=`，等于没有诊断。
 *
 *   同一份手拼写法在 release-service 与 sidecar-deployer 各写了一遍（判据分裂），
 *   所以这里抽成 leaf 模块（零 IO、零依赖，两边都能引且不成环），并由守卫测试钉住
 *   「不许再出现第三份 stderr.slice(0, N)」。
 *
 * 三条纪律：
 *   1. stdout 与 stderr 都要——判据可能落在任何一边；
 *   2. 取尾不取头——失败原因永远在输出末尾，头部往往是无关的预热噪音；
 *   3. 截断必须显式标注——静默切掉会让读的人以为「就这么多」。
 */

/**
 * 单条失败消息的字符预算。
 *
 * 必须 **严格小于** release-service.ts 的 sanitizeFailureSummary 里那个 2 * 1024 的
 * 头截断上限（`.slice(0, 2 * 1024)`）。那一刀是从**头**切的：预算一旦超过它，
 * 这里辛辛苦苦保下来的尾部判据会在下游被原样切掉，等于白改。
 * 改这个值之前先去看 sanitizeFailureSummary，两者是硬耦合。
 */
export const SSH_EXEC_FAILURE_MAX_CHARS = 1800;

const STDERR_MARKER = '--- stderr(tail) ---';
const STDOUT_MARKER = '--- stdout(tail) ---';
const EMPTY_MARKER = '(no output captured)';

/** 截断标记本身也占预算；留出这点余量，免得「标注截断」这件事把预算再撑爆一次。 */
const TRUNCATION_MARKER_RESERVE = 80;

/**
 * 脱敏前先把每条流裁到这个窗口。
 *
 * 不是为了省内存，是为了防超时：PEM 那条正则用的是惰性量词，在几 MB 的 stdout 上
 * 回溯代价接近平方级——而发布脚本的 stdout 动辄就是几 MB。最终只留 1800 字符，
 * 32K 之外的内容无论如何都活不到输出，先裁掉纯赚。
 */
const MASK_INPUT_WINDOW = 32 * 1024;

/**
 * 裁窗口时可能把一段 PEM 从中间切开，只剩尾巴——BEGIN 标记没了，
 * 上面那条成对匹配的正则就盖不住剩下的密钥材料。所以裁完先看有没有
 * 「孤儿 END」，有就把它连同它前面的残段一起丢掉。
 */
function dropOrphanPrivateKeyTail(text: string): string {
  const end = /-----END [^-]*PRIVATE KEY-----/.exec(text);
  if (!end) return text;
  const begin = /-----BEGIN [^-]*PRIVATE KEY-----/.exec(text);
  if (begin && begin.index < end.index) return text;
  return text.slice(end.index + end[0].length);
}

function clipForMasking(text: string): string {
  const raw = String(text ?? '');
  if (raw.length <= MASK_INPUT_WINDOW) return raw;
  return dropOrphanPrivateKeyTail(raw.slice(-MASK_INPUT_WINDOW));
}

/**
 * 脱敏。放在格式化内部而不是交给调用方，是因为这条消息最终会被 failRun 原样写进
 * run.errorMessage 并落进 state.json —— 那条路径**不过** maskLog，指望每个调用方
 * 记得脱敏就是在赌运气。sidecar 的 bootstrap stdout 里出现凭据的概率尤其高。
 *
 * 相对 release-service 的 maskLog 扩了一条：`*_KEY=` 前缀族（GW_KEY / LLMGW_GATE_KEY /
 * API_KEY 都属于它），原来的白名单只盖 PRIVATE_KEY，这几个一个都盖不到。
 */
export function maskSshExecSecrets(text: string): string {
  return String(text ?? '')
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, '***PRIVATE_KEY***')
    // `_KEY` 前缀那一段的长度上界不是洁癖：写成 `[A-Za-z0-9_]*_KEY` 的话，
    // 一整行没有下划线的长文本会让引擎在每个起始位置都扫到行尾找 `_KEY`，
    // 在几十 KB 的单行输出上就是平方级开销。环境变量名不会超过 64 字符。
    .replace(/(TOKEN|SECRET|PASSWORD|PRIVATE_?KEY|[A-Za-z][A-Za-z0-9_]{0,64}_KEY)=([^\s]+)/gi, '$1=***');
}

function normalize(text: string): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * 按行从**末尾**往前取，直到用满预算。
 * 之所以按行而不是按字符：截断点落在半行中间会把 JSON / 堆栈切成读不懂的碎片。
 */
function tailWithinBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;

  const lines = text.split('\n');
  const bodyBudget = Math.max(0, budget - TRUNCATION_MARKER_RESERVE);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (used + cost > bodyBudget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  if (kept.length === 0) {
    // 末行本身就比预算长（比如整段 JSON 压在一行里）：退化为按字符取尾，
    // 至少保住最靠近失败点的那一段，而不是整行丢掉。
    if (bodyBudget <= 0) return '';
    const lastLine = lines[lines.length - 1].slice(-bodyBudget);
    kept.push(lastLine);
    used = lastLine.length;
  }
  return `... [truncated, kept last ${kept.length} lines / ${used} chars]\n${kept.join('\n')}`;
}

/**
 * 构造 SSH 非零退出的失败消息。
 *
 * 首行恒为 `ssh exec exit=<code>`，且 `<code>` 之后必须紧跟换行/空白——
 * release-service.ts 的 release.script.missing 规则用 `/ssh exec exit=4[12]\b/` 做匹配，
 * 首行格式一变（比如后面直接贴数字或字母）那条 `\b` 边界就会失配，
 * 41/42 的「脚本缺失/不可执行」会从「配置问题、不可重试」掉回泛化分类。
 */
export function formatSshExecFailure(input: {
  exitCode: number;
  stdout: string;
  stderr: string;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? SSH_EXEC_FAILURE_MAX_CHARS;
  const header = `ssh exec exit=${input.exitCode}`;
  const err = normalize(maskSshExecSecrets(clipForMasking(input.stderr)));
  const out = normalize(maskSshExecSecrets(clipForMasking(input.stdout)));

  if (!err && !out) return `${header}\n${EMPTY_MARKER}`;

  // 正文额度 = 总预算 - 首行 - 用得上的分段标记。多扣一个字符当安全垫。
  let bodyBudget = maxChars - header.length - 1;
  if (err) bodyBudget -= STDERR_MARKER.length + 2;
  if (out) bodyBudget -= STDOUT_MARKER.length + 2;
  bodyBudget = Math.max(0, bodyBudget);

  let errBudget = 0;
  let outBudget = 0;
  if (!out) {
    errBudget = bodyBudget;
  } else if (!err) {
    // stderr 空时 stdout 吃满全额——这正是本次 401 判据的场景，
    // 平均切两半会让判据 JSON 白白少一半。
    outBudget = bodyBudget;
  } else {
    const half = Math.floor(bodyBudget / 2);
    errBudget = Math.min(err.length, half);
    outBudget = Math.min(out.length, bodyBudget - errBudget);
    // 一段没用满的额度让给另一段。
    errBudget = Math.min(err.length, bodyBudget - outBudget);
  }

  const parts = [header];
  if (err) parts.push(`${STDERR_MARKER}\n${tailWithinBudget(err, errBudget)}`);
  if (out) parts.push(`${STDOUT_MARKER}\n${tailWithinBudget(out, outBudget)}`);
  return parts.join('\n');
}
