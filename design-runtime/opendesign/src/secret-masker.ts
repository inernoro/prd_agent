// 本文件复制自 cds/src/services/secret-masker.ts，只保留设计执行服务实际用到的 maskSecrets 这一条链路
// （runtimeDiagnosticPreview 用它给诊断摘要脱敏）。第 4 阶段删除 CDS 旧实现前，两份判据须保持一致。

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
/**
 * Insert `_` at camelCase / PascalCase word boundaries so the SCREAMING_SNAKE
 * `(?:^|_)WORD(?:_|$)` patterns also fire on .NET-style config keys.
 *
 * The provenance endpoint surfaces keys like `Changelog__GitHubToken`,
 * `GitHubOAuth__ClientSecret`, `ApiKeyCrypto__LegacySecrets` — the sensitive
 * words (Token / Secret / Key) sit at camelCase boundaries that `_`-anchored
 * patterns never see, so those secrets were returned in plaintext. Normalizing
 * `GitHubToken` -> `Git_Hub_Token`, `ClientSecret` -> `Client_Secret`,
 * `ApiKeyCrypto` -> `Api_Key_Crypto` makes the existing patterns match. This
 * only ADDS boundaries, so SCREAMING_SNAKE keys are unchanged and nothing that
 * matched before stops matching.
 */
function withCamelBoundaries(key: string): string {
  return key
    // Keep the OAuth protocol prefix atomic. Without this, `OAuth` splits to
    // `O_Auth` and the AUTH pattern fires on a public `GitHubOAuth__ClientId`
    // — over-masking a non-secret identifier. `GitHubOAuth__ClientSecret` still
    // masks (via SECRET), so this only restores ClientId visibility.
    .replace(/OAuth/g, 'Oauth')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // fooBar -> foo_Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'); // APIKey -> API_Key
}

function isSensitiveKey(key: string): boolean {
  const normalized = withCamelBoundaries(key);
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key) || p.test(normalized));
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

  // Multi-line blocks first (#1448): a PEM private key body spans ~27 lines and
  // only the BEGIN line carries a `KEY=` prefix, so the line-mode pass below
  // masks the header and leaks every following line of the key body. Replace
  // the whole BEGIN..END span before splitting; an unterminated block (output
  // truncated by maxBuffer / timeout) is masked through to end of text.
  const lines = text.replace(PEM_PRIVATE_KEY_BLOCK, '***[masked]***').split('\n');
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
function maskLine(line: string): string {
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
    (match, prefix: string, key: string, sep: string, value: string) => {
      // Mask when the KEY name is sensitive OR the VALUE is a secret by its own
      // shape (URL creds / connection-string password / vendor token prefix).
      // The value-shape arm makes line-mode masking match maskEnvRecord, so a
      // log line like `NEUTRAL_A=ghp_...` or `DATABASE_URL=postgres://u:p@h/db`
      // — sensitive value under a non-sensitive key — is masked in log snapshots
      // / resource logs / container logs too (Codex PR #1008 review). Strip
      // surrounding quotes so the ^-anchored URL detector still matches.
      const bareValue = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
      if (isSensitiveKey(key) || looksLikeSecretBearingValue(bareValue)) {
        return `${prefix}${key}${sep}***[masked]***`;
      }
      return match;
    },
  );

  // Step 4: line-level secret scrub for what the KEY=VALUE pass structurally
  // cannot see. (a) The value regex truncates at the first `;` and its prefix
  // class excludes `;`, so a `;Password=` segment deeper in an ADO.NET/ODBC
  // connection string (e.g. `SQLSERVER_URL=Server=x;User Id=sa;Password=hunter2;`)
  // is never matched (Codex PR #1008 review). (b) Secrets not in KEY=VALUE form
  // at all — a bare `ghp_...` token or a `scheme://user:pass@` URL sitting in
  // free log text. These are prefix/structure-anchored so plain URLs, commit
  // SHAs, and ids are not touched.
  working = working.replace(CONN_STRING_PASSWORD_SEGMENT_GLOBAL, (_m, head: string) => `${head}***[masked]***`);
  working = working.replace(URL_CREDENTIALS_INLINE_GLOBAL, (_m, head: string) => `${head}***[masked]***@`);
  for (const re of SECRET_VALUE_PATTERNS_GLOBAL) {
    working = working.replace(re, '***[masked]***');
  }

  return working;
}

const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.\-]*:\/\/[^@/\s]*:[^@/\s]+@/i;

/**
 * Semicolon-delimited connection string carrying an inline password
 * (`Server=...;User Id=sa;Password=secret;...` — ADO.NET / SQL Server / ODBC).
 * These don't match the `scheme://user:pass@host` URL shape, and the key name
 * (`SQLSERVER_URL`, `DATABASE`, ...) is often not sensitive, so the password
 * segment leaked through the provenance endpoint. Precise `;password=`/`pwd=`
 * detection catches them without over-masking plain URLs.
 */
const CONN_STRING_WITH_PASSWORD = /(^|;)\s*(password|pwd)\s*=[^;]/i;

/**
 * Values that ARE a secret by their own shape, regardless of key name — so a
 * bare token stashed under a neutral key (`FOO=ghp_...`) is still masked
 * (defense in depth). Deliberately prefix/structure-anchored, NOT entropy-based,
 * so commit SHAs (40-hex), account ids (32-hex), and long public ids are never
 * caught — only unambiguous vendor secret shapes.
 */
// Whole PEM private-key span (BEGIN header through matching END footer, or to
// end of text when the footer never arrives). Covers RSA / EC / OPENSSH /
// ENCRYPTED / PKCS#8 headers via the optional `[A-Z ]+ ` label.
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}/, // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bgh[ousr]_[A-Za-z0-9]{20,}/, // gho_/ghu_/ghs_/ghr_
  /\bglpat-[A-Za-z0-9_-]{18,}/, // GitLab PAT
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bsk-[A-Za-z0-9]{20,}/, // OpenAI-style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bASIA[0-9A-Z]{16}\b/, // AWS temp access key id
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT (header.payload.sig)
];

// Global-flagged variants for line-mode scrubbing (maskLine step 4), where we
// replace every secret-shaped substring in a log line rather than test a single
// value. Kept in sync with SECRET_VALUE_PATTERNS by construction.
const SECRET_VALUE_PATTERNS_GLOBAL: RegExp[] = SECRET_VALUE_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'),
);
// Connection-string password segment (`;Password=secret`) anywhere on a line.
const CONN_STRING_PASSWORD_SEGMENT_GLOBAL = /((?:^|[\s;{,"'])(?:password|pwd)\s*=)([^\s;,"']+)/gi;
// Inline-credential URL password part (`scheme://user:PASS@`) anywhere on a line.
const URL_CREDENTIALS_INLINE_GLOBAL = /\b([a-z][a-z0-9+.\-]*:\/\/[^@/\s]*:)[^@/\s]+@/gi;

/**
 * Does a value carry inline credentials — URL (`scheme://user:pass@`),
 * connection-string (`...;Password=...`), or a recognizable vendor secret
 * shape (`ghp_...`, JWT, PEM key, ...)? Single SSOT for value-shape secret
 * detection used by response serialization.
 */
function looksLikeSecretBearingValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  return (
    URL_WITH_CREDENTIALS.test(value) ||
    CONN_STRING_WITH_PASSWORD.test(value) ||
    SECRET_VALUE_PATTERNS.some((p) => p.test(value))
  );
}
