import { ArrowRight, Zap } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';

type GatewayLocation = Pick<Location, 'hostname' | 'protocol'>;

export function resolveGatewayConsoleHref(location: GatewayLocation = window.location): string | null {
  const previewSuffix = '.miduo.org';
  if (!location.hostname.endsWith(previewSuffix)) return '/llmgw/';

  if (location.hostname.endsWith(`-llmgw-web${previewSuffix}`)) return '/';

  const previewSlug = location.hostname.slice(0, -previewSuffix.length);
  const serviceLabel = `${previewSlug}-llmgw-web`;
  if (serviceLabel.length > 63) return null;
  return `${location.protocol}//${serviceLabel}${previewSuffix}/`;
}

/**
 * CompatibilityStack — 幕 7 · 模型兼容性矩阵
 *
 * 灰度 text-only logo 网格（避免真实 logo 侵权 + 对齐 Linear 极简风）。
 * 鼠标 hover 时单卡片亮起。
 */

const PROVIDERS = [
  { name: 'OpenAI', region: 'US' },
  { name: 'Anthropic', region: 'US' },
  { name: 'Google Gemini', region: 'US' },
  { name: 'xAI Grok', region: 'US' },
  { name: 'Meta Llama', region: 'US' },
  { name: 'Mistral', region: 'FR' },
  { name: 'DeepSeek', region: 'CN' },
  { name: 'Moonshot Kimi', region: 'CN' },
  { zh: '阿里通义', en: 'Alibaba Qwen', region: 'CN' },
  { zh: '智谱 GLM', en: 'Zhipu GLM', region: 'CN' },
  { zh: '百度文心', en: 'Baidu ERNIE', region: 'CN' },
  { zh: '字节豆包', en: 'ByteDance Doubao', region: 'CN' },
] as const;

export function CompatibilityStack() {
  const { t, lang } = useLanguage();
  const titleParts = t.compat.title.split('\n');
  const gatewayConsoleHref = resolveGatewayConsoleHref();

  const getProviderName = (p: (typeof PROVIDERS)[number]) =>
    'name' in p ? p.name : lang === 'en' ? p.en : p.zh;

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-16 md:mb-20">
          <SectionHeader
            Icon={Zap}
            eyebrow={t.compat.eyebrow}
            accent="#60a5fa"
            title={
              <>
                {titleParts[0]}
                {titleParts.length > 1 && (
                  <>
                    <br className="sm:hidden" />
                    <span className="hidden sm:inline"> </span>
                    {titleParts[1]}
                  </>
                )}
              </>
            }
            subtitle={t.compat.subtitle}
          />
        </div>

        {/* Provider grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {PROVIDERS.map((p, i) => {
            const displayName = getProviderName(p);
            return (
              <Reveal key={displayName} delay={(i % 6) * 40} offset={18}>
                <ProviderTile name={displayName} region={p.region} />
              </Reveal>
            );
          })}
        </div>

        {/* Footer note */}
        <div className="mt-12 text-center text-[11px] text-white/35">
          {t.compat.footer}
        </div>
        {gatewayConsoleHref ? (
          <div className="mt-6 flex justify-center">
            <a
              href={gatewayConsoleHref}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 py-2.5 text-[13px] font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/[0.08] hover:text-white"
            >
              {t.compat.action}
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderTile({ name, region }: { name: string; region: string }) {
  return (
    <div
      className="group relative px-4 py-5 rounded-xl border border-white/[0.06] bg-white/[0.015] transition-all duration-300 hover:bg-white/[0.04] hover:border-white/15 cursor-default"
    >
      <div
        className="text-[13.5px] text-white/60 group-hover:text-white/95 transition-colors font-medium"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em' }}
      >
        {name}
      </div>
      <div
        className="mt-1 text-[9px] text-white/25 group-hover:text-white/45 transition-colors uppercase"
        style={{ letterSpacing: '0.18em' }}
      >
        {region}
      </div>
    </div>
  );
}
