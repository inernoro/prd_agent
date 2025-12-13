import { CSSProperties } from 'react';
import openaiIcon from '../../assets/model-icons/openai.svg';
import anthropicIcon from '../../assets/model-icons/anthropic.svg';
import googleIcon from '../../assets/model-icons/google.svg';
import deepseekIcon from '../../assets/model-icons/deepseek.svg';
import qwenIcon from '../../assets/model-icons/qwen.svg';
import zhipuIcon from '../../assets/model-icons/zhipu.svg';
import moonshotIcon from '../../assets/model-icons/moonshot.svg';
import doubaoIcon from '../../assets/model-icons/doubao.svg';
import baiduIcon from '../../assets/model-icons/baidu.svg';
import bytedanceIcon from '../../assets/model-icons/bytedance.svg';
import mistralIcon from '../../assets/model-icons/mistral.svg';
import metaIcon from '../../assets/model-icons/meta.svg';
import tencentIcon from '../../assets/model-icons/tencent.svg';

const MODEL_ICONS: Record<string, string> = {
  openai: openaiIcon,
  anthropic: anthropicIcon,
  google: googleIcon,
  gemini: googleIcon,
  deepseek: deepseekIcon,
  qwen: qwenIcon,
  alibaba: qwenIcon,
  zhipu: zhipuIcon,
  chatglm: zhipuIcon,
  moonshot: moonshotIcon,
  kimi: moonshotIcon,
  doubao: doubaoIcon,
  bytedance: bytedanceIcon,
  baidu: baiduIcon,
  wenxin: baiduIcon,
  mistral: mistralIcon,
  meta: metaIcon,
  llama: metaIcon,
  tencent: tencentIcon,
  hunyuan: tencentIcon,
};

const FALLBACK_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97706',
  google: '#4285f4',
  gemini: '#4285f4',
  deepseek: '#0066ff',
  qwen: '#6366f1',
  alibaba: '#ff6a00',
  zhipu: '#2563eb',
  chatglm: '#2563eb',
  moonshot: '#8b5cf6',
  kimi: '#8b5cf6',
  doubao: '#3b82f6',
  bytedance: '#fe2c55',
  baidu: '#2932e1',
  wenxin: '#2932e1',
  mistral: '#f7931e',
  meta: '#0668e1',
  llama: '#0668e1',
  tencent: '#1877f2',
  hunyuan: '#1877f2',
};

function getProviderKey(modelName: string): string | null {
  const lowerName = modelName.toLowerCase();
  
  // 精确匹配
  if (MODEL_ICONS[lowerName]) return lowerName;
  
  // 关键词匹配
  const keywords: [string, string][] = [
    ['gpt', 'openai'],
    ['o1', 'openai'],
    ['openai', 'openai'],
    ['claude', 'anthropic'],
    ['anthropic', 'anthropic'],
    ['gemini', 'google'],
    ['google', 'google'],
    ['deepseek', 'deepseek'],
    ['qwen', 'qwen'],
    ['alibaba', 'alibaba'],
    ['zhipu', 'zhipu'],
    ['chatglm', 'chatglm'],
    ['glm', 'zhipu'],
    ['moonshot', 'moonshot'],
    ['kimi', 'kimi'],
    ['doubao', 'doubao'],
    ['bytedance', 'bytedance'],
    ['baidu', 'baidu'],
    ['wenxin', 'wenxin'],
    ['ernie', 'baidu'],
    ['mistral', 'mistral'],
    ['llama', 'llama'],
    ['meta', 'meta'],
    ['tencent', 'tencent'],
    ['hunyuan', 'hunyuan'],
  ];
  
  for (const [keyword, provider] of keywords) {
    if (lowerName.includes(keyword)) return provider;
  }
  
  return null;
}

interface Props {
  modelName: string;
  displayName?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function ModelIcon({ modelName, displayName, size = 32, className, style }: Props) {
  const providerKey = getProviderKey(modelName);
  const icon = providerKey ? MODEL_ICONS[providerKey] : null;
  const bgColor = providerKey ? FALLBACK_COLORS[providerKey] : 'var(--accent)';
  
  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...style,
  };
  
  if (icon) {
    return (
      <div className={className} style={{ ...containerStyle, background: 'var(--bg-card)', padding: size * 0.15 }}>
        <img 
          src={icon} 
          alt={displayName || modelName}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  
  // Fallback: 显示首字母
  const initial = (displayName || modelName || '?').charAt(0).toUpperCase();
  return (
    <div 
      className={className}
      style={{ 
        ...containerStyle, 
        background: bgColor,
        color: '#fff',
        fontSize: size * 0.4,
        fontWeight: 700,
      }}
    >
      {initial}
    </div>
  );
}
