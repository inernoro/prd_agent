/**
 * Secret masking helper for container exec / log output.
 *
 * Background: `POST /branches/:id/container-exec` and `POST /branches/:id/container-logs`
 * stream `docker exec` / `docker logs` output back to the API caller. If the
 * caller is the cdscli or an AI Agent (most common case during onboarding /
 * UAT), the output ends up in the AI's transcript or in CI logs — which means
 * any container env var like `GITHUB_PAT=...`, `MYSQL_ROOT_PASSWORD=...`,
 * `JWT_SECRET=...`, etc. that happens to appear in the output would be leaked.
 *
 * This is a HIGH severity finding from the 2026-05-02 onboarding UAT (F15).
 *
 * The masker covers two common shapes:
 *
 *   1. KEY=VALUE shell exports (`env`, `printenv`, build logs that echo env)
 *      — matched against a whitelist of well-known sensitive key names so
 *        normal config like `LOG_LEVEL=info` or `NODE_ENV=production` is
 *        never mangled.
 *   2. HTTP auth headers (`Authorization: Bearer <token>`,
 *      `Authorization: Basic <b64>`) — matched generically since they are
 *        always sensitive regardless of context.
 *
 * The replacement is `***[masked]***` — a 1-token marker so the operator can
 * still tell that *something* was filtered without seeing the secret. This is
 * deliberately not the empty string (which would let an attacker probe for
 * "is the masker active here?" by counting characters).
 *
 * Admins / debugging cases can opt out by passing `mask: false` (the route
 * layer maps `?unmask=1` query string → `mask: false`). This is a manual
 * escalation path — by default any output that flows to an API consumer is
 * masked.
 */

/**
 * Whitelist of sensitive env var names. Each entry is matched
 * case-insensitively against the key portion of `KEY=value` patterns.
 *
 * Add a new entry here when a new infra service is integrated. We keep this
 * list centralized rather than inlining names at each call site so the
 * coverage audit is a single grep.
 *
 * Patterns are deliberately broad — substring match — because real-world env
 * names have many variants (`MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`,
 * `MYSQL_PWD`, `DATABASE_PASSWORD`, ...). Better to over-mask than leak.
 */
/**
 * Underscore-friendly word boundary helper. In env var names (`GITHUB_PAT`,
 * `MYSQL_ROOT_PASSWORD`), `_` is a regex word char so `\b` never fires
 * around it. We instead use `(^|_)` / `(_|$)` which behaves like a true
 * boundary for SCREAMING_SNAKE keys.
 *
 * Sensitive substrings to look for. Each entry is a regex source string;
 * `isSensitiveKey` runs each one with the underscore-aware boundary applied.
 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  // Tokens / API keys
  /(?:^|_)TOKEN(?:_|$)/i,
  /(?:^|_)API_?KEYS?(?:_|$)/i,
  /(?:^|_)SECRETS?(?:_|$)/i,
  /(?:^|_)PAT(?:_|$)/i, // GitHub Personal Access Token (e.g. GITHUB_PAT)
  /(?:^|_)PRIVATE_?KEYS?(?:_|$)/i,
  /(?:^|_)ACCESS_?KEYS?(?:_|$)/i, // R2_ACCESS_KEY, AWS_ACCESS_KEY
  /(?:^|_)SECRET_?KEYS?(?:_|$)/i,
  /(?:^|_)KEYS?(?:_|$)/i, // last fallback (catches lone XYZ_KEY)
  // Passwords / credentials
  /(?:^|_)PASSWORDS?(?:_|$)/i,
  /(?:^|_)PWD(?:_|$)/i,
  /(?:^|_)PASSPHRASES?(?:_|$)/i,
  /(?:^|_)CREDENTIALS?(?:_|$)/i,
  /(?:^|_)AUTH(?:_|$)/i,
  // Specific high-value secrets
  /(?:^|_)JWT(?:_|$)/i, // JWT_SECRET, JWT_KEY
  /(?:^|_)CLIENT_SECRET(?:_|$)/i,
  /(?:^|_)WEBHOOK(?:_|$)/i, // SMTP / webhook URLs often contain creds
  /(?:^|_)SMTP_(?:PASSWORD|USER|PASS|HOST|URL)(?:_|$)/i,
];

/**
 * Tests whether a key name (left side of `KEY=value`) looks sensitive.
 * Used by the line-by-line masker.
 *
 * Exported for unit tests so we can verify the pattern coverage directly
 * without going through full string masking.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Mask sensitive content in arbitrary text output.
 *
 * Operates line-by-line so that:
 *   - A single bad line doesn't poison the rest of the buffer
 *   - Multi-line `env` output (the most common leak vector) is handled cleanly
 *   - Stack traces / build logs that incidentally contain a `XXX_TOKEN=abc`
 *     line still have everything else preserved
 *
 * Returns the input unchanged when `mask` is false (admin escalation path).
 * Always returns a string even if input was empty.
 */
export function maskSecrets(input: string | null | undefined, opts: { mask?: boolean } = {}): string {
  const text = input ?? '';
  if (opts.mask === false) return text;
  if (!text) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(maskLine(line));
  }
  return out.join('\n');
}

/**
 * Mask a single line. Pulled out so the line-mode logic can be unit-tested
 * in isolation, and so streaming consumers (e.g. `docker logs -f`) that
 * receive partial lines can call this directly with each chunk.
 */
export function maskLine(line: string): string {
  let working = line;

  // Step 1: HTTP Authorization headers — always sensitive regardless of key.
  // Run BEFORE the KEY=VALUE pass so a generic `token: Bearer xxx` log line
  // doesn't get half-eaten by the env regex. Match case-insensitively.
  // Replace the value with the masked marker but keep the scheme so callers
  // debugging "what type of auth is this endpoint expecting?" still get an
  // answer.
  working = working.replace(
    /\b(Authorization\s*:\s*)(Bearer|Basic|Token|ApiKey)\s+\S+/gi,
    (_m, header: string, scheme: string) => `${header}${scheme} ***[masked]***`,
  );

  // Step 2: Bare `Bearer <token>` / `Basic <token>` patterns (when the
  // header was already split off by the logger). Don't touch the literal
  // word "Bearer" / "Basic" alone — only when followed by a non-empty token.
  // The 8+ char minimum avoids false-positives on short words like
  // "Token EOF" in source comments.
  working = working.replace(
    /\b(Bearer|Basic|ApiKey)\s+[A-Za-z0-9._\-+/=]{8,}/g,
    (_m, scheme: string) => `${scheme} ***[masked]***`,
  );

  // Step 3: KEY=VALUE patterns (env exports / printenv / build logs).
  // Capture pieces so we can reconstitute the prefix verbatim:
  //   - leading whitespace / quote / brace (preserved)
  //   - KEY name (matched against the sensitive whitelist)
  //   - = / : separator + value (replaced with ***[masked]***)
  //
  // The regex is intentionally tolerant about the value side — we accept
  // anything that's not a whitespace boundary, and stop at the first
  // un-quoted whitespace. If the value itself was quoted ("foo bar"), we
  // mask the whole thing in one shot.
  working = working.replace(
    /(^|[\s"'{,])([A-Za-z_][A-Za-z0-9_]*)(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]*)/g,
    (match, prefix: string, key: string, sep: string, _value: string) => {
      if (isSensitiveKey(key)) {
        return `${prefix}${key}${sep}***[masked]***`;
      }
      return match;
    },
  );

  return working;
}

/**
 * Convenience wrapper for object payloads. Walks string properties recursively
 * and masks each one. Non-string values pass through untouched.
 *
 * Used by route handlers that wrap exec output in `{ stdout, stderr }`-shaped
 * JSON envelopes — those need each leaf string masked, not the JSON serialized
 * form (which would be unreadable after mangling).
 */
export function maskSecretsInObject<T>(obj: T, opts: { mask?: boolean } = {}): T {
  if (opts.mask === false) return obj;
  return walk(obj) as T;

  function walk(value: unknown): unknown {
    if (typeof value === 'string') return maskSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = walk(v);
      }
      return result;
    }
    return value;
  }
}

/**
 * Env-record masking for response serialization (branch extraProfiles, build-profile
 * overrides, trace dumps). Distinct from the line-oriented `maskSecrets()` above: this
 * masks a `Record<string,string>` value when EITHER
 *   - the KEY name looks sensitive (secret/password/token/key/credential), OR
 *   - the VALUE is a connection string carrying inline credentials
 *     (`scheme://user:pass@host`) — covers DATABASE_URL / MONGODB_URI / REDIS_URL etc.
 *     whose key names don't match the sensitive list but whose value still leaks a
 *     password (Codex P2 "Mask URL-style secrets in extra service env").
 * Marker defaults to `***` so a GET→edit→PUT round-trip is recognized as a mask
 * sentinel and restored to the stored value (see mergeExtraEnv).
 */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.\-]*:\/\/[^@/\s]*:[^@/\s]+@/i;

/**
 * Does a value look like a connection string carrying inline credentials
 * (`scheme://user:pass@host`)? Exported so the container-exec literal-value
 * masking path can reuse the SAME URL detection that maskEnvRecord uses for
 * response serialization — otherwise `echo $DATABASE_URL` leaks the raw string
 * even though GET responses mask it (Codex P2).
 */
export function looksLikeUrlWithCredentials(value: string): boolean {
  return typeof value === 'string' && URL_WITH_CREDENTIALS.test(value);
}

export function maskEnvRecord(env: Record<string, string>, marker = '***'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    // 复用 isSensitiveKey 的完整敏感 key 覆盖（含 WEBHOOK / SMTP_* / AUTH / JWT / PAT / *_KEY 等），
    // 而非早期窄正则 secret|password|token|key|credential —— 否则 WEBHOOK_URL / SLACK_WEBHOOK / SMTP_URL /
    // AUTH_URL 这类存密钥 URL 的 key 名不命中、值又非 user:pass@ 形态时会原样泄露给任何能查看分支的调用方
    // （Codex P1「Mask webhook-style env secrets in extra services」）。叠加值为含内联凭据 URL 的兜底。
    const sensitive = isSensitiveKey(k) || (typeof v === 'string' && URL_WITH_CREDENTIALS.test(v));
    out[k] = sensitive ? marker : v;
  }
  return out;
}

/**
 * View-safe shallow copy of a branch: mask every extraProfiles[].env AND any
 * profileOverrides[<extra-profile-id>].env, leave all other fields as-is. SSOT for "redact
 * branch-local extra-service secrets in any serialization" — used by branch list/detail/SSE
 * serializers AND the full-state broadcaster (Codex P1 "Redact extraProfiles before state-stream
 * broadcasts" + "Mask extra-profile override env in branch views"). Generic so it does not pull
 * the BranchEntry/BuildProfile types into this leaf module.
 */
export function maskBranchExtraProfilesEnv<
  T extends {
    extraProfiles?: Array<{ id?: string; env?: Record<string, string> }>;
    profileOverrides?: Record<string, { env?: Record<string, string> }>;
  },
>(branch: T): T {
  if (!branch.extraProfiles) return branch;
  const extraIds = new Set(branch.extraProfiles.map((p) => p.id).filter((x): x is string => !!x));
  const out: T = {
    ...branch,
    extraProfiles: branch.extraProfiles.map((p) => (p.env ? { ...p, env: maskEnvRecord(p.env) } : p)),
  };
  // 额外服务的 PUT /profile-overrides 把 env 存进 branch.profileOverrides[<extraId>]，分支序列化若不连这里
  // 一起脱敏，/branches、/branches/:id、分支流仍吐 override 明文（profile-overrides 响应已脱敏，唯独分支视图漏）。
  if (branch.profileOverrides && extraIds.size > 0) {
    let changed = false;
    const maskedOv: Record<string, { env?: Record<string, string> }> = {};
    for (const [pid, ov] of Object.entries(branch.profileOverrides)) {
      if (extraIds.has(pid) && ov?.env) {
        maskedOv[pid] = { ...ov, env: maskEnvRecord(ov.env) };
        changed = true;
      } else {
        maskedOv[pid] = ov;
      }
    }
    if (changed) (out as { profileOverrides?: unknown }).profileOverrides = maskedOv;
  }
  return out;
}

/**
 * Resolve the "should we mask?" decision for an Express request.
 *
 * Default: ALWAYS mask. The only way to opt out is to pass `?unmask=1` on the
 * URL — which is logged via the activity stream and audit middleware so an
 * admin retracing the call can see who unmasked what.
 *
 * Future hardening: gate `?unmask=1` behind admin role check. For now we trust
 * the caller is project-key authenticated (the route is already auth-gated by
 * the auth middleware in server.ts) but emit no extra check — any caller with
 * a project key can already see container env via separate endpoints.
 */
export function shouldMask(req: { query?: Record<string, unknown> }): boolean {
  const q = req.query?.unmask;
  if (q === '1' || q === 'true') return false;
  return true;
}
