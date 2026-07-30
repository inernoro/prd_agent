// 老手轨：一行拿走接入所需的两件事。
//
// 熟人不需要「三步走」，他只要 Base URL 和知道自己那把密钥还在。此前这两样只能
// 从教程页一路读下去才能拼出来，于是熟人嫌啰嗦、每次都得翻。本组件把它压成一行。
//
// 边界：密钥明文只在签发那一刻存在（服务端不留），所以这里只展示前缀掩码，
// 复制按钮复制的是 Base URL——把复制说成「复制密钥」是骗人。
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';
import { usePrimaryServiceKey } from '@/lib/onboarding';
import { GAP, INSET_BLOCK } from '@/lib/surface';
import { HINT_TEXT, MONO_META } from '@/lib/typography';

/**
 * Base URL 的取法与 Quickstart 页一致：优先构建期注入的 serving 地址，
 * 否则回落到当前控制台源站。**不硬编码域名**——控制台会部署在多个入口下。
 */
function resolveServingBaseUrl() {
  const configured = (import.meta.env.VITE_LLMGW_SERVING_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return new URL(window.location.href).origin;
}

export function AccessSnippetBar() {
  const { loading, canRead, keyPrefix } = usePrimaryServiceKey();
  const [copied, setCopied] = useState(false);
  const baseUrl = resolveServingBaseUrl();

  // 读不到密钥列表的角色（viewer / billing）本来也不接入，整行隐身。
  if (!canRead || loading) return null;

  const copyBaseUrl = async () => {
    await navigator.clipboard.writeText(baseUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div style={{ ...INSET_BLOCK, display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
      <span style={HINT_TEXT}>地址</span>
      <code style={{ ...MONO_META, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={baseUrl}>{baseUrl}</code>
      <span style={HINT_TEXT}>密钥</span>
      {keyPrefix ? (
        <code style={MONO_META}>{`${keyPrefix}${'•'.repeat(6)}`}</code>
      ) : (
        <Link className="lg-secondary-link" to="/service-keys">签发密钥</Link>
      )}
      <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => void copyBaseUrl()}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制地址'}
      </Button>
    </div>
  );
}
