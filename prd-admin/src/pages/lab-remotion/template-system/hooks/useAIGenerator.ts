/**
 * AI 参数生成器 Hook
 * 用于在 React 组件中调用 AI 生成视频参数
 */
import { useState, useCallback } from 'react';
import { z } from 'zod';
import { TemplateDefinition, AIGeneratedProps } from '../types';
import {
  buildSystemPrompt,
  parseAIResponse,
  AIGeneratorConfig,
} from '../ai-generator';

export interface UseAIGeneratorState<T = Record<string, unknown>> {
  isGenerating: boolean;
  progress: string;
  result: AIGeneratedProps<T> | null;
  error: string | null;
}

export interface UseAIGeneratorReturn<T = Record<string, unknown>> extends UseAIGeneratorState<T> {
  generate: (userInput: string) => Promise<AIGeneratedProps<T> | null>;
  reset: () => void;
}

/**
 * AI 参数生成器 Hook
 *
 * @param template 目标模板定义
 * @param config AI 配置（可选，不提供时使用模拟模式）
 */
export function useAIGenerator<T = Record<string, unknown>>(
  template: TemplateDefinition<z.ZodObject<any>> | null,
  config?: AIGeneratorConfig
): UseAIGeneratorReturn<T> {
  const [state, setState] = useState<UseAIGeneratorState<T>>({
    isGenerating: false,
    progress: '',
    result: null,
    error: null,
  });

  const generate = useCallback(
    async (userInput: string): Promise<AIGeneratedProps<T> | null> => {
      if (!template) {
        setState((prev) => ({
          ...prev,
          error: '请先选择模板',
        }));
        return null;
      }

      setState({
        isGenerating: true,
        progress: '正在分析您的需求...',
        result: null,
        error: null,
      });

      try {
        let result: AIGeneratedProps<T> | null = null;

        if (config?.apiEndpoint) {
          // 真实 API 调用
          result = await callRealAPI<T>(userInput, template, config);
        } else {
          // 模拟模式：智能解析用户输入
          result = await simulateAIGeneration<T>(userInput, template);
        }

        if (result) {
          setState({
            isGenerating: false,
            progress: '',
            result,
            error: null,
          });
        } else {
          setState({
            isGenerating: false,
            progress: '',
            result: null,
            error: '无法解析 AI 响应，请重试',
          });
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '生成失败';
        setState({
          isGenerating: false,
          progress: '',
          result: null,
          error: errorMessage,
        });
        return null;
      }
    },
    [template, config]
  );

  const reset = useCallback(() => {
    setState({
      isGenerating: false,
      progress: '',
      result: null,
      error: null,
    });
  }, []);

  return {
    ...state,
    generate,
    reset,
  };
}

/**
 * 调用真实 API
 */
async function callRealAPI<T>(
  userInput: string,
  template: TemplateDefinition<z.ZodObject<any>>,
  config: AIGeneratorConfig
): Promise<AIGeneratedProps<T> | null> {
  const systemPrompt = buildSystemPrompt(template);

  const response = await fetch(config.apiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      model: config.model || 'gpt-4o',
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  const data = await response.json();
  const aiContent = data.choices?.[0]?.message?.content || data.content || '';

  return parseAIResponse<T>(aiContent, template);
}

/**
 * 模拟 AI 生成（用于演示和测试）
 * 通过简单的规则从用户输入中提取信息
 */
async function simulateAIGeneration<T>(
  userInput: string,
  template: TemplateDefinition<z.ZodObject<any>>
): Promise<AIGeneratedProps<T>> {
  // 模拟网络延迟
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const extractedParams: Record<string, unknown> = {};
  const suggestions: string[] = [];

  // 根据模板 ID 使用不同的提取策略
  if (template.id === 'conference-opening') {
    // 提取活动名称
    const eventNameMatch = userInput.match(
      /(?:为|给|创建|制作)?(?:.*?)(?:的)?(.+?(?:大会|峰会|发布会|会议|活动|论坛|庆典))/
    );
    if (eventNameMatch) {
      extractedParams.eventName = eventNameMatch[1].trim();
    } else if (userInput.includes('大会') || userInput.includes('会议')) {
      extractedParams.eventName = '年度技术大会';
    }

    // 提取副标题/主题
    const themeMatch = userInput.match(/主题[是为：:「」""]?([^，,。.]+)/);
    if (themeMatch) {
      extractedParams.eventSubtitle = themeMatch[1].trim().replace(/[「」""]/g, '');
    }

    // 提取演讲者
    const speakers: Array<{ name: string; title?: string }> = [];

    // 匹配包含演讲者信息的文本
    const speakerMatches = userInput.match(
      /(?:有|包括|嘉宾[是为：:]?|演讲[者人][是为：:]?|邀请了?)([^。.]+)/
    );

    if (speakerMatches) {
      const speakerStr = speakerMatches[1];
      // 按中文顿号、逗号分割
      const speakerParts = speakerStr.split(/[、，,]/);

      for (const part of speakerParts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // 尝试提取姓名和职位
        const nameTitle = trimmed.match(
          /^([^\s（()]+?)(?:（|\()?([A-Za-z]+|总裁|总监|经理|主任|院长|教授|专家|创始人|联合创始人|董事长)?(?:）|\))?$/
        );

        if (nameTitle) {
          const name = nameTitle[1];
          const title = nameTitle[2];
          // 过滤掉明显不是人名的词
          if (name.length >= 2 && name.length <= 4 && !name.match(/^(三|四|五|六|七|八|九|十)$/)) {
            speakers.push({
              name,
              title: title || undefined,
            });
          }
        }
      }
    }

    if (speakers.length > 0) {
      extractedParams.speakers = speakers;
    }

    // 提取公司名称
    const companyMatch = userInput.match(/([^\s]+?(?:公司|集团|科技|网络|互联网|软件))/);
    if (companyMatch) {
      extractedParams.companyName = companyMatch[1];
    }

    // 提取日期
    const dateMatch = userInput.match(
      /(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|\d{4}[-/]\d{1,2}[-/]\d{1,2})/
    );
    if (dateMatch) {
      extractedParams.eventDate = dateMatch[1];
    }

    // 生成建议
    if (!extractedParams.eventName) {
      suggestions.push('建议添加具体的活动名称');
    }
    if (!extractedParams.speakers || (extractedParams.speakers as Array<unknown>).length === 0) {
      suggestions.push('可以添加演讲嘉宾信息，让视频更加个性化');
    }
    if (!extractedParams.companyName) {
      suggestions.push('添加公司名称可以增强品牌展示效果');
    }
  }

  // 合并默认值和提取的参数
  const mergedParams = {
    ...template.defaultProps,
    ...extractedParams,
  };

  // 计算信心度
  const filledFieldsCount = Object.keys(extractedParams).length;
  const totalFieldsCount = Object.keys(template.fieldMeta).length;
  const confidence = Math.min(0.9, 0.5 + (filledFieldsCount / totalFieldsCount) * 0.5);

  return {
    templateId: template.id,
    props: mergedParams as T,
    confidence,
    suggestions:
      suggestions.length > 0
        ? suggestions
        : ['参数已根据您的描述自动填充，您可以在右侧表单中进一步调整'],
  };
}

export default useAIGenerator;
