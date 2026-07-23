import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  AudioLines,
  Bot,
  Boxes,
  Cloud,
  FlaskConical,
  Image,
  MessagesSquare,
  Network,
  Workflow,
} from 'lucide-react';
import type { SimpleIcon } from 'simple-icons';
import {
  siAlibabacloud,
  siAnthropic,
  siBytedance,
  siCloudflare,
  siDigitalocean,
  siGoogle,
  siGooglegemini,
  siHuggingface,
  siMeta,
  siMistralai,
  siOpenai,
  siOpenrouter,
} from 'simple-icons';

type IconRule = {
  match: RegExp;
  icon?: LucideIcon;
  brand?: SimpleIcon | 'deepseek';
  tone: string;
};

const MODEL_ICON_RULES: IconRule[] = [
  { match: /(image|dall-e|imagen|banana|flux|sdxl|vision)/i, icon: Image, tone: 'violet' },
  { match: /(audio|speech|whisper|tts|voice)/i, icon: AudioLines, tone: 'amber' },
  { match: /(embed|rerank|vector)/i, icon: Workflow, tone: 'cyan' },
  { match: /deepseek/i, brand: 'deepseek', tone: 'brand' },
  { match: /(gpt|openai|o1|o3|o4)/i, brand: siOpenai, tone: 'brand' },
  { match: /claude/i, brand: siAnthropic, tone: 'brand' },
  { match: /gemini/i, brand: siGooglegemini, tone: 'brand' },
  { match: /(qwen|tongyi)/i, brand: siAlibabacloud, tone: 'brand' },
  { match: /(doubao|seedance|seedream)/i, brand: siBytedance, tone: 'brand' },
  { match: /(llama|meta)/i, brand: siMeta, tone: 'brand' },
  { match: /mistral/i, brand: siMistralai, tone: 'brand' },
  { match: /huggingface/i, brand: siHuggingface, tone: 'brand' },
  { match: /chat/i, icon: MessagesSquare, tone: 'blue' },
];

const PROVIDER_ICON_RULES: IconRule[] = [
  { match: /openrouter/i, brand: siOpenrouter, tone: 'brand' },
  { match: /digitalocean/i, brand: siDigitalocean, tone: 'brand' },
  { match: /cloudflare/i, brand: siCloudflare, tone: 'brand' },
  { match: /(google|gemini|vertex)/i, brand: siGoogle, tone: 'brand' },
  { match: /(anthropic|claude)/i, brand: siAnthropic, tone: 'brand' },
  { match: /(alibaba|aliyun|阿里云|百炼)/i, brand: siAlibabacloud, tone: 'brand' },
  { match: /(bytedance|火山|字节)/i, brand: siBytedance, tone: 'brand' },
  { match: /openai/i, brand: siOpenai, tone: 'brand' },
  { match: /(silicon|硅基)/i, icon: Workflow, tone: 'green' },
  { match: /(apiyi|api-yi)/i, icon: Bot, tone: 'blue' },
  { match: /(dry-run|stub|mock)/i, icon: FlaskConical, tone: 'amber' },
];

function resolveIcon(value: string | null | undefined, rules: IconRule[], fallback: IconRule): IconRule {
  const normalized = value?.trim() ?? '';
  return rules.find((rule) => rule.match.test(normalized)) ?? fallback;
}

type EntityIconSize = 'sm' | 'lg';

function EntityIcon({ rule, label, size = 'sm' }: { rule: IconRule; label: string; size?: EntityIconSize }) {
  const pixelSize = size === 'lg' ? 26 : 13;
  return (
    <span className={`lg-log-entity-icon lg-log-entity-icon-${rule.tone} lg-log-entity-icon-${size}`} aria-hidden="true" title={label}>
      {rule.brand === 'deepseek' ? <DeepSeekMark size={pixelSize} /> : rule.brand ? <SimpleBrandMark icon={rule.brand} size={pixelSize} /> : rule.icon ? (() => {
        const Icon = rule.icon;
        return <Icon size={pixelSize} strokeWidth={1.9} />;
      })() : null}
    </span>
  );
}

function SimpleBrandMark({ icon, size }: { icon: SimpleIcon; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={icon.title}>
      <path fill={`#${icon.hex}`} d={icon.path} />
    </svg>
  );
}

function DeepSeekMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 510" role="img" aria-label="DeepSeek">
      <path fill="#4D6BFE" d="M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-6.647 6.858-14.219 11.451-23.761 10.962-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-11.141-4.899-16.742-10.227-19.821-21.82-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082l-4.186 13.105c-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-16.496-15.981-31.117-33.984-51.707-46.111-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-16.067.061-30.594 6.246-49.614 12.919-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676z" />
    </svg>
  );
}

export function ModelEntityIcon({ model, size }: { model?: string | null; size?: EntityIconSize }) {
  return <EntityIcon rule={resolveIcon(model, MODEL_ICON_RULES, { match: /.*/, icon: Boxes, tone: 'neutral' })} label={model || '模型'} size={size} />;
}

export function ProviderEntityIcon({ provider, size }: { provider?: string | null; size?: EntityIconSize }) {
  return <EntityIcon rule={resolveIcon(provider, PROVIDER_ICON_RULES, { match: /.*/, icon: Cloud, tone: 'neutral' })} label={provider || 'Provider'} size={size} />;
}

export function AppEntityIcon({ size }: { size?: EntityIconSize } = {}) {
  return <EntityIcon rule={{ match: /.*/, icon: AppWindow, tone: 'blue' }} label="App" size={size} />;
}

export function SessionEntityIcon() {
  return <EntityIcon rule={{ match: /.*/, icon: Network, tone: 'cyan' }} label="会话" />;
}
