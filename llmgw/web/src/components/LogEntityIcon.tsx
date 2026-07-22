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
  Route,
  Workflow,
} from 'lucide-react';

type IconRule = {
  match: RegExp;
  icon: LucideIcon;
  tone: string;
};

const MODEL_ICON_RULES: IconRule[] = [
  { match: /(image|dall-e|imagen|banana|flux|sdxl|vision)/i, icon: Image, tone: 'violet' },
  { match: /(audio|speech|whisper|tts|voice)/i, icon: AudioLines, tone: 'amber' },
  { match: /(embed|rerank|vector)/i, icon: Workflow, tone: 'cyan' },
  { match: /(chat|gpt|claude|deepseek|qwen|gemini|llama|mistral)/i, icon: MessagesSquare, tone: 'blue' },
];

const PROVIDER_ICON_RULES: IconRule[] = [
  { match: /openrouter/i, icon: Route, tone: 'violet' },
  { match: /(silicon|硅基)/i, icon: Workflow, tone: 'green' },
  { match: /(openai|apiyi|api-yi)/i, icon: Bot, tone: 'blue' },
  { match: /(dry-run|stub|mock)/i, icon: FlaskConical, tone: 'amber' },
];

function resolveIcon(value: string | null | undefined, rules: IconRule[], fallback: IconRule): IconRule {
  const normalized = value?.trim() ?? '';
  return rules.find((rule) => rule.match.test(normalized)) ?? fallback;
}

function EntityIcon({ rule, label }: { rule: IconRule; label: string }) {
  const Icon = rule.icon;
  return (
    <span className={`lg-log-entity-icon lg-log-entity-icon-${rule.tone}`} aria-hidden="true" title={label}>
      <Icon size={13} strokeWidth={1.9} />
    </span>
  );
}

export function ModelEntityIcon({ model }: { model?: string | null }) {
  return <EntityIcon rule={resolveIcon(model, MODEL_ICON_RULES, { match: /.*/, icon: Boxes, tone: 'neutral' })} label="模型" />;
}

export function ProviderEntityIcon({ provider }: { provider?: string | null }) {
  return <EntityIcon rule={resolveIcon(provider, PROVIDER_ICON_RULES, { match: /.*/, icon: Cloud, tone: 'neutral' })} label="Provider" />;
}

export function AppEntityIcon() {
  return <EntityIcon rule={{ match: /.*/, icon: AppWindow, tone: 'blue' }} label="App" />;
}

export function SessionEntityIcon() {
  return <EntityIcon rule={{ match: /.*/, icon: Network, tone: 'cyan' }} label="会话" />;
}
