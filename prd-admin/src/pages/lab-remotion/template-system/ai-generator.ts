/**
 * AI 参数生成器
 * 将用户的一句话描述转换为模板所需的 JSON 参数
 */
import { z } from 'zod';
import { TemplateDefinition, AIGeneratedProps } from './types';

/**
 * 根据模板 Schema 生成 AI System Prompt
 */
export function buildSystemPrompt(template: TemplateDefinition): string {
  const schemaShape = template.schema.shape;
  const fieldDescriptions: string[] = [];

  // 遍历 schema 字段，生成字段说明
  for (const [key, zodType] of Object.entries(schemaShape)) {
    const meta = template.fieldMeta[key];
    const zodObj = zodType as z.ZodTypeAny;

    let typeDesc = getZodTypeDescription(zodObj);
    let fieldDesc = `- ${key}`;

    if (meta) {
      fieldDesc += ` (${meta.label})`;
      if (meta.description) {
        fieldDesc += `: ${meta.description}`;
      }
      if (meta.placeholder) {
        fieldDesc += ` 示例: ${meta.placeholder}`;
      }
    }

    fieldDesc += ` [${typeDesc}]`;

    // 检查是否可选
    const zodDef = zodObj._def as unknown as Record<string, unknown> | undefined;
    if (zodObj.isOptional?.() || zodDef?.typeName === 'ZodOptional') {
      fieldDesc += ' (可选)';
    }

    fieldDescriptions.push(fieldDesc);
  }

  return `你是一个专业的视频内容策划师。你的任务是根据用户的描述，提取信息并填充视频模板参数。

## 当前模板信息

**模板名称**: ${template.name}
**模板描述**: ${template.description}
**使用场景**: ${template.aiPromptHint}

## 模板参数字段

${fieldDescriptions.join('\n')}

## 输出要求

1. 仔细分析用户的描述，提取所有相关信息
2. 将信息映射到对应的模板字段
3. 对于用户未提及的可选字段，可以根据上下文合理推断或使用默认值
4. 对于必填字段，如果用户未提及，请基于上下文生成合理的内容

## 输出格式

请以 JSON 格式输出，结构如下：
\`\`\`json
{
  "params": {
    // 模板参数
  },
  "confidence": 0.85,  // 0-1 之间的信心度
  "suggestions": ["建议1", "建议2"]  // 可选的改进建议
}
\`\`\`

## 示例

用户输入: "${template.exampleUserInput}"

你应该输出符合上述格式的 JSON，其中 params 包含从用户描述中提取的所有相关字段。`;
}

/**
 * 获取 Zod 类型的描述
 */
function getZodTypeDescription(zodType: z.ZodTypeAny): string {
  // 使用 unknown 类型断言访问 Zod 内部属性
  const def = zodType._def as unknown as Record<string, unknown>;

  if (!def) return 'unknown';

  const typeName = def.typeName as string | undefined;

  switch (typeName) {
    case 'ZodString':
      return '字符串';
    case 'ZodNumber':
      return '数字';
    case 'ZodBoolean':
      return '布尔值';
    case 'ZodArray':
      return '数组';
    case 'ZodObject':
      return '对象';
    case 'ZodOptional':
      return getZodTypeDescription(def.innerType as z.ZodTypeAny) + ' (可选)';
    case 'ZodDefault':
      return getZodTypeDescription(def.innerType as z.ZodTypeAny);
    default:
      return typeName || 'unknown';
  }
}

/**
 * 解析 AI 响应，提取 JSON 参数
 */
export function parseAIResponse<T>(
  response: string,
  template: TemplateDefinition<z.ZodObject<any>>
): AIGeneratedProps<T> | null {
  try {
    // 尝试从响应中提取 JSON
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    let jsonStr = jsonMatch ? jsonMatch[1] : response;

    // 如果没有找到 code block，尝试直接解析整个响应
    if (!jsonMatch) {
      // 尝试找到 JSON 对象
      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }
    }

    const parsed = JSON.parse(jsonStr);

    // 验证结构
    if (!parsed.params) {
      console.warn('AI response missing params field');
      return null;
    }

    // 使用 Zod schema 验证并设置默认值
    const validationResult = template.schema.safeParse({
      ...template.defaultProps,
      ...parsed.params,
    });

    if (!validationResult.success) {
      console.warn('AI generated params validation failed:', validationResult.error);
      // 即使验证失败，也返回合并后的结果，让用户可以手动修正
      return {
        templateId: template.id,
        props: {
          ...template.defaultProps,
          ...parsed.params,
        } as T,
        confidence: parsed.confidence || 0.5,
        suggestions: [
          ...(parsed.suggestions || []),
          '部分参数可能需要手动调整',
        ],
      };
    }

    return {
      templateId: template.id,
      props: validationResult.data as T,
      confidence: parsed.confidence || 0.8,
      suggestions: parsed.suggestions || [],
    };
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return null;
  }
}

/**
 * 生成用于预览的示例参数
 */
export function generateSampleParams<T>(
  template: TemplateDefinition<z.ZodObject<any>>
): T {
  return template.defaultProps as T;
}

/**
 * AI 生成器配置
 */
export interface AIGeneratorConfig {
  apiEndpoint: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 调用 AI 生成参数（前端版本，使用 fetch）
 * 注意：实际项目中应该通过后端 API 代理调用，避免暴露 API Key
 */
export async function generateParamsWithAI<T>(
  userInput: string,
  template: TemplateDefinition<z.ZodObject<any>>,
  config: AIGeneratorConfig
): Promise<AIGeneratedProps<T> | null> {
  const systemPrompt = buildSystemPrompt(template);

  try {
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
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const aiContent = data.choices?.[0]?.message?.content || data.content || '';

    return parseAIResponse<T>(aiContent, template);
  } catch (error) {
    console.error('AI generation failed:', error);
    return null;
  }
}

/**
 * 流式生成（用于显示进度）
 */
export async function* streamGenerateParams<T>(
  userInput: string,
  template: TemplateDefinition<z.ZodObject<any>>,
  config: AIGeneratorConfig & { streamEndpoint?: string }
): AsyncGenerator<{ type: 'progress' | 'complete' | 'error'; data: any }> {
  const systemPrompt = buildSystemPrompt(template);

  yield { type: 'progress', data: { message: '正在分析您的需求...' } };

  try {
    const response = await fetch(config.streamEndpoint || config.apiEndpoint, {
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
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    yield { type: 'progress', data: { message: '正在生成视频参数...' } };

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullContent += chunk;

      yield { type: 'progress', data: { message: '正在解析参数...', partial: chunk } };
    }

    const result = parseAIResponse<T>(fullContent, template);

    if (result) {
      yield { type: 'complete', data: result };
    } else {
      yield { type: 'error', data: { message: '无法解析 AI 响应' } };
    }
  } catch (error) {
    yield {
      type: 'error',
      data: {
        message: error instanceof Error ? error.message : '生成失败',
        error
      }
    };
  }
}
