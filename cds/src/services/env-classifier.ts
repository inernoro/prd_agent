/**
 * env-classifier.ts — TS 版 _classify_env_kind,与 cdscli 完全对齐。
 *
 * 用途:当 cds-compose.yml 没声明 x-cds-env-meta(常见的标准 docker-compose
 * 或 demo yml),`importCdsComposeFromFile` 需要一个 fallback 推断 envMeta。
 * 否则前端 EnvSetupDialog 收到 envMeta={} 时无法做三色分类显示,用户面对
 * 一堆 env 不知道哪个必填、哪个会自动填、哪个有默认值。
 *
 * SSOT: 与 .claude/skills/cds/cli/cdscli.py 的 _classify_env_kind 严格 1:1。
 * 改这里时同步改 Python 版,反之亦然。
 *
 * 判定优先级(高 → 低):
 *   1. is_password=true             → auto      (cdscli 自动生成强密码)
 *   2. value 含 ${VAR} 模板引用     → infra-derived  (CDS 推导;必须在 marker
 *                                                   检查之前,见 Bugbot 第十四轮 Bug 1)
 *   3. value 含 placeholder marker  → required   ("TODO" / "REPLACE_ME" / "请填写" 等)
 *   4. value 为空 + key 命中 secret → required   (PASSWORD/SECRET/TOKEN/KEY/...)
 *   5. value 为空(非 secret)        → auto       (应用通常有默认)
 *   6. value 是字面量                → auto       (配置默认)
 */

import type { EnvMeta } from '../types.js';

/** 占位符 marker(case-insensitive 匹配)。与 Python 端 _REQUIRED_VALUE_MARKERS 对齐。 */
const REQUIRED_VALUE_MARKERS = [
  'TODO',
  '<填写',
  '<your-',
  '<YOUR_',
  'REPLACE_ME',
  '请填写',
] as const;

/** Secret 关键词(key 命中 → 空值需用户填)。与 Python _SECRET_KEY_PATTERNS 对齐。 */
const SECRET_KEY_PATTERNS = [
  'PASSWORD',
  'SECRET',
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'OAUTH',
  'SMTP',
  'STRIPE',
  'TWILIO',
  'SENDGRID',
  'MAILGUN',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'AWS_ACCESS',
  'AWS_SECRET',
  'GOOGLE_CLIENT',
  'GITHUB_CLIENT',
] as const;

export interface ClassifyOptions {
  /** 是否密码类(cdscli 在 yaml 生成阶段标的) */
  isPassword?: boolean;
}

export function classifyEnvKind(
  key: string,
  value: string | null | undefined,
  opts: ClassifyOptions = {},
): EnvMeta {
  if (opts.isPassword) {
    return { kind: 'auto', hint: 'cdscli 自动生成的强密码' };
  }
  // 优先 ${VAR} 模板检查 — 必须在 marker 检查之前。否则 ${REPLACE_ME_TOKEN}
  // 含子串 "REPLACE_ME" 会被误归 required(Bugbot 第十四轮 Bug 1)。
  if (value && value.includes('${')) {
    return { kind: 'infra-derived', hint: '由 CDS 根据基础设施自动推导' };
  }
  if (value) {
    const upperVal = value.toUpperCase();
    if (REQUIRED_VALUE_MARKERS.some((m) => upperVal.includes(m.toUpperCase()))) {
      return { kind: 'required', hint: '请填写实际值' };
    }
  }
  if (!value) {
    const keyUpper = key.toUpperCase();
    if (SECRET_KEY_PATTERNS.some((p) => keyUpper.includes(p))) {
      return {
        kind: 'required',
        hint: `请填写 ${key}(密钥/凭据,可点「生成」按钮自动随机)`,
      };
    }
    return {
      kind: 'auto',
      hint: `${key}(空值;应用若有内置默认可不填,或在 CDS UI 补充)`,
    };
  }
  return { kind: 'auto', hint: '默认值,可在 CDS UI 修改' };
}

/**
 * 批量为一组 envVars 推断 envMeta。
 * 用于 importCdsComposeFromFile 的 fallback:当 cds-compose.yml 没有显式
 * x-cds-env-meta 段时,对每个 envVar 调 classifyEnvKind 生成 metadata。
 *
 * 已存在的 explicitMeta(如 yml 里手写的)优先,fallback 只填补缺失项 —
 * 这样用户可以局部覆盖 CDS 的推断(例如把某个误判 auto 的强制改成 required)。
 */
export function deriveEnvMetaForVars(
  envVars: Record<string, string>,
  explicitMeta: Record<string, EnvMeta> = {},
): Record<string, EnvMeta> {
  const result: Record<string, EnvMeta> = { ...explicitMeta };
  for (const [key, value] of Object.entries(envVars)) {
    if (key in result) continue; // explicit wins
    result[key] = classifyEnvKind(key, value);
  }
  return result;
}
