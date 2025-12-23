/**
 * 平台标签颜色系统
 * 根据平台名称分配专属颜色，便于用户快速识别不同平台
 */

export type PlatformTone =
  | 'silicon'    // 硅基流动 - 青色
  | 'volcano'    // 火山引擎 - 橙红色
  | 'weiwei'     // 薇薇安 - 粉色
  | 'deepseek'   // DeepSeek - 蓝紫色
  | 'openai'     // OpenAI - 绿色
  | 'anthropic'  // Anthropic/Claude - 橙色
  | 'google'     // Google/Gemini - 蓝色
  | 'qwen'       // Qwen/阿里/通义 - 橙黄色
  | 'zhipu'      // 智谱/GLM - 蓝绿色
  | 'baidu'      // 百度/文心 - 红色
  | 'moonshot'   // 月之暗面/Kimi - 深蓝色
  | 'minimax'    // MiniMax - 紫色
  | 'yi'         // 零一万物/Yi - 靛蓝色
  | 'stepfun'    // 阶跃星辰 - 青绿色
  | 'groq'       // Groq - 橙色
  | 'mistral'    // Mistral - 蓝色
  | 'cohere'     // Cohere - 紫红色
  | 'together'   // Together AI - 绿色
  | 'fireworks'  // Fireworks - 红橙色
  | 'replicate'  // Replicate - 紫色
  | 'huggingface'// HuggingFace - 黄色
  | 'azure'      // Azure OpenAI - 蓝色
  | 'aws'        // AWS Bedrock - 橙色
  | 'default';   // 默认 - 灰色

/**
 * 根据平台名称获取对应的颜色调性
 */
export function getPlatformTone(platformName: string | null | undefined): PlatformTone {
  const name = (platformName ?? '').trim().toLowerCase();
  
  // 硅基流动
  if (name.includes('硅基') || name.includes('silicon') || name.includes('siliconflow')) return 'silicon';
  
  // 火山引擎
  if (name.includes('火山') || name.includes('volcano') || name.includes('volces') || name.includes('doubao') || name.includes('豆包')) return 'volcano';
  
  // 薇薇安
  if (name.includes('薇薇安') || name.includes('weiwei') || name.includes('vivi') || name.includes('aihubmix')) return 'weiwei';
  
  // DeepSeek
  if (name.includes('deepseek') || name.includes('深度求索')) return 'deepseek';
  
  // OpenAI
  if (name.includes('openai') && !name.includes('azure')) return 'openai';
  
  // Anthropic/Claude
  if (name.includes('anthropic') || name.includes('claude')) return 'anthropic';
  
  // Google/Gemini
  if (name.includes('google') || name.includes('gemini') || name.includes('vertex')) return 'google';
  
  // Qwen/阿里/通义
  if (name.includes('qwen') || name.includes('通义') || name.includes('阿里') || name.includes('dashscope') || name.includes('alibaba')) return 'qwen';
  
  // 智谱/GLM
  if (name.includes('智谱') || name.includes('zhipu') || name.includes('glm') || name.includes('chatglm')) return 'zhipu';
  
  // 百度/文心
  if (name.includes('百度') || name.includes('baidu') || name.includes('文心') || name.includes('ernie') || name.includes('wenxin')) return 'baidu';
  
  // 月之暗面/Kimi
  if (name.includes('月之暗面') || name.includes('moonshot') || name.includes('kimi')) return 'moonshot';
  
  // MiniMax
  if (name.includes('minimax') || name.includes('abab')) return 'minimax';
  
  // 零一万物/Yi
  if (name.includes('零一') || name.includes('yi-') || name.includes('01.ai') || name.includes('lingyiwanwu')) return 'yi';
  
  // 阶跃星辰
  if (name.includes('阶跃') || name.includes('stepfun') || name.includes('step-')) return 'stepfun';
  
  // Groq
  if (name.includes('groq')) return 'groq';
  
  // Mistral
  if (name.includes('mistral')) return 'mistral';
  
  // Cohere
  if (name.includes('cohere')) return 'cohere';
  
  // Together AI
  if (name.includes('together')) return 'together';
  
  // Fireworks
  if (name.includes('fireworks')) return 'fireworks';
  
  // Replicate
  if (name.includes('replicate')) return 'replicate';
  
  // HuggingFace
  if (name.includes('huggingface') || name.includes('hugging face') || name.includes('hf-')) return 'huggingface';
  
  // Azure OpenAI
  if (name.includes('azure')) return 'azure';
  
  // AWS Bedrock
  if (name.includes('aws') || name.includes('bedrock') || name.includes('amazon')) return 'aws';
  
  return 'default';
}

/**
 * 平台标签样式
 */
export function platformChipStyle(tone: PlatformTone): React.CSSProperties {
  switch (tone) {
    // 硅基流动 - 青色
    case 'silicon':
      return { background: 'rgba(6, 182, 212, 0.12)', border: '1px solid rgba(6, 182, 212, 0.28)', color: 'rgba(6, 182, 212, 0.95)' };
    
    // 火山引擎 - 橙红色
    case 'volcano':
      return { background: 'rgba(249, 115, 22, 0.12)', border: '1px solid rgba(249, 115, 22, 0.28)', color: 'rgba(249, 115, 22, 0.95)' };
    
    // 薇薇安 - 粉色
    case 'weiwei':
      return { background: 'rgba(236, 72, 153, 0.12)', border: '1px solid rgba(236, 72, 153, 0.28)', color: 'rgba(236, 72, 153, 0.95)' };
    
    // DeepSeek - 蓝紫色
    case 'deepseek':
      return { background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.28)', color: 'rgba(99, 102, 241, 0.95)' };
    
    // OpenAI - 绿色
    case 'openai':
      return { background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16, 185, 129, 0.28)', color: 'rgba(16, 185, 129, 0.95)' };
    
    // Anthropic/Claude - 橙色
    case 'anthropic':
      return { background: 'rgba(251, 146, 60, 0.12)', border: '1px solid rgba(251, 146, 60, 0.28)', color: 'rgba(251, 146, 60, 0.95)' };
    
    // Google/Gemini - 蓝色
    case 'google':
      return { background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.28)', color: 'rgba(59, 130, 246, 0.95)' };
    
    // Qwen/阿里 - 橙黄色
    case 'qwen':
      return { background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.28)', color: 'rgba(245, 158, 11, 0.95)' };
    
    // 智谱/GLM - 蓝绿色
    case 'zhipu':
      return { background: 'rgba(20, 184, 166, 0.12)', border: '1px solid rgba(20, 184, 166, 0.28)', color: 'rgba(20, 184, 166, 0.95)' };
    
    // 百度/文心 - 红色
    case 'baidu':
      return { background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.28)', color: 'rgba(239, 68, 68, 0.95)' };
    
    // 月之暗面/Kimi - 深蓝色
    case 'moonshot':
      return { background: 'rgba(79, 70, 229, 0.12)', border: '1px solid rgba(79, 70, 229, 0.28)', color: 'rgba(79, 70, 229, 0.95)' };
    
    // MiniMax - 紫色
    case 'minimax':
      return { background: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.28)', color: 'rgba(168, 85, 247, 0.95)' };
    
    // 零一万物/Yi - 靛蓝色
    case 'yi':
      return { background: 'rgba(67, 56, 202, 0.12)', border: '1px solid rgba(67, 56, 202, 0.28)', color: 'rgba(67, 56, 202, 0.95)' };
    
    // 阶跃星辰 - 青绿色
    case 'stepfun':
      return { background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.28)', color: 'rgba(34, 197, 94, 0.95)' };
    
    // Groq - 橙色
    case 'groq':
      return { background: 'rgba(234, 88, 12, 0.12)', border: '1px solid rgba(234, 88, 12, 0.28)', color: 'rgba(234, 88, 12, 0.95)' };
    
    // Mistral - 蓝色
    case 'mistral':
      return { background: 'rgba(37, 99, 235, 0.12)', border: '1px solid rgba(37, 99, 235, 0.28)', color: 'rgba(37, 99, 235, 0.95)' };
    
    // Cohere - 紫红色
    case 'cohere':
      return { background: 'rgba(219, 39, 119, 0.12)', border: '1px solid rgba(219, 39, 119, 0.28)', color: 'rgba(219, 39, 119, 0.95)' };
    
    // Together AI - 绿色
    case 'together':
      return { background: 'rgba(22, 163, 74, 0.12)', border: '1px solid rgba(22, 163, 74, 0.28)', color: 'rgba(22, 163, 74, 0.95)' };
    
    // Fireworks - 红橙色
    case 'fireworks':
      return { background: 'rgba(220, 38, 38, 0.12)', border: '1px solid rgba(220, 38, 38, 0.28)', color: 'rgba(220, 38, 38, 0.95)' };
    
    // Replicate - 紫色
    case 'replicate':
      return { background: 'rgba(147, 51, 234, 0.12)', border: '1px solid rgba(147, 51, 234, 0.28)', color: 'rgba(147, 51, 234, 0.95)' };
    
    // HuggingFace - 黄色
    case 'huggingface':
      return { background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.28)', color: 'rgba(234, 179, 8, 0.95)' };
    
    // Azure OpenAI - 蓝色
    case 'azure':
      return { background: 'rgba(0, 120, 212, 0.12)', border: '1px solid rgba(0, 120, 212, 0.28)', color: 'rgba(0, 120, 212, 0.95)' };
    
    // AWS Bedrock - 橙色
    case 'aws':
      return { background: 'rgba(255, 153, 0, 0.12)', border: '1px solid rgba(255, 153, 0, 0.28)', color: 'rgba(255, 153, 0, 0.95)' };
    
    // 默认 - 灰色
    default:
      return { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--text-muted)' };
  }
}

/**
 * 平台标签组件 Props
 */
export interface PlatformLabelProps {
  name: string | null | undefined;
  className?: string;
  showIcon?: boolean;
}

