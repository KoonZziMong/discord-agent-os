/**
 * llm.ts — LLM 클라이언트 추상화
 *
 * LLMClient 인터페이스를 통해 provider에 무관한 통일된 chat() API를 제공합니다.
 *
 * AnthropicClient   : 네이티브 Anthropic SDK.
 *                     일반 Tool → messages.create()
 *                     Computer Use Tool 포함 시 → beta.messages.create()
 * OpenAICompatClient: OpenAI SDK + baseUrl 스왑으로 OpenAI / Gemini / MiniMax 등 지원.
 *                     Beta 툴(Computer Use)은 필터링하여 제외합니다.
 *
 * ExecuteToolFn : 툴 실행 콜백 (agent.ts 주입)
 *                 스크린샷의 경우 이미지 content 배열을 반환할 수 있습니다.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AgentConfig } from './config';
import type { HistoryMessage } from './history';
import type { ToolResultContent } from './computer';
import { BETA_TOOL_TYPES, COMPUTER_USE_BETAS, type AnyTool } from './tools';

export type { ToolResultContent };

/** 툴 실행 콜백: 툴 이름, 입력, 툴호출 ID → 결과 (텍스트 또는 이미지) */
export type ExecuteToolFn = (name: string, input: unknown, id: string) => Promise<ToolResultContent>;

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
}

/** 모든 LLM 클라이언트가 구현해야 하는 인터페이스 */
export interface LLMClient {
  chat(
    system: string,
    messages: HistoryMessage[],
    tools: AnyTool[],
    executeTool: ExecuteToolFn,
  ): Promise<ChatResult>;
}

// ── 헬퍼 ──────────────────────────────────────────────────

function hasBetaTools(tools: AnyTool[]): boolean {
  return tools.some((t) => BETA_TOOL_TYPES.has((t as { type?: string }).type ?? ''));
}

// ── AnthropicClient ────────────────────────────────────────

/**
 * 네이티브 Anthropic SDK 클라이언트.
 *
 * Computer Use 툴이 포함되면 자동으로 beta.messages.create()로 전환합니다.
 * tool_result에 이미지 content가 오면 그대로 전달합니다 (스크린샷 지원).
 */
class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(
    system: string,
    messages: HistoryMessage[],
    tools: AnyTool[],
    executeTool: ExecuteToolFn,
  ): Promise<ChatResult> {
    const useBeta = hasBetaTools(tools);
    // HistoryMessage[]는 MessageParam[]과 구조 호환
    const msgBuffer = [...messages] as Anthropic.Beta.BetaMessageParam[];

    // ── 프롬프트 캐싱 ──
    // 시스템 프롬프트와 툴 정의를 캐싱하여 반복 호출 비용을 절감합니다.
    // 캐시 히트 시 입력 토큰 비용의 약 90%가 절감됩니다.
    // 주의: 캐시 prefix가 동일해야 히트합니다 (system + tools 순서 불변).
    const systemWithCache: Anthropic.Beta.BetaTextBlockParam[] = [{
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    }];

    // 툴 목록의 마지막 항목에 cache_control 마킹 (prefix 캐싱)
    const toolsWithCache = tools.length > 0
      ? tools.map((t, i) =>
          i === tools.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' as const } }
            : t,
        )
      : tools;

    let lastUsage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };

    for (let round = 0; round < 10; round++) {
      // ── API 호출 ──
      const betas: Anthropic.AnthropicBeta[] = useBeta
        ? [...COMPUTER_USE_BETAS, 'prompt-caching-2024-07-31']
        : ['prompt-caching-2024-07-31'];

      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemWithCache,
        messages: msgBuffer,
        ...(toolsWithCache.length > 0 ? { tools: toolsWithCache as Anthropic.Beta.BetaToolUnion[] } : {}),
        betas,
      });

      // ── usage 수집 ──
      const u = response.usage as unknown as Record<string, number>;
      lastUsage = {
        inputTokens: u['input_tokens'] ?? 0,
        outputTokens: u['output_tokens'] ?? 0,
        cacheRead: u['cache_read_input_tokens'] ?? 0,
        cacheWrite: u['cache_creation_input_tokens'] ?? 0,
      };

      // ── 텍스트 응답 ──
      if (response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find((b) => b.type === 'text');
        const text = textBlock ? (textBlock as { type: 'text'; text: string }).text : '(응답 없음)';
        return { text, usage: lastUsage };
      }

      // ── tool_use 실행 ──
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const b = block as { type: 'tool_use'; id: string; name: string; input: unknown };
        const result = await executeTool(b.name, b.input, b.id);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: b.id,
          // 문자열이면 그대로, 이미지 배열이면 배열 그대로 전달
          content: result as Anthropic.Beta.BetaToolResultBlockParam['content'],
        });
      }

      msgBuffer.push({
        role: 'assistant',
        content: response.content as Anthropic.Beta.BetaContentBlockParam[],
      });
      msgBuffer.push({ role: 'user', content: toolResults });
    }

    return { text: '(툴 실행 횟수 초과)', usage: lastUsage };
  }
}

// ── OpenAICompatClient ─────────────────────────────────────

/**
 * OpenAI SDK 기반 클라이언트.
 * Beta 컴퓨터유즈 툴은 OpenAI 호환 엔드포인트에서 지원되지 않으므로 필터링합니다.
 * 이미지 tool_result도 텍스트로 대체합니다.
 */
class OpenAICompatClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    this.model = model;
  }

  async chat(
    system: string,
    messages: HistoryMessage[],
    tools: AnyTool[],
    executeTool: ExecuteToolFn,
  ): Promise<ChatResult> {
    // Beta 툴 제외 — OpenAI 호환 엔드포인트는 Computer Use 미지원
    const regularTools = tools.filter((t): t is Anthropic.Tool => 'input_schema' in t);
    const openaiTools = anthropicToOpenAITools(regularTools);

    const msgBuffer: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam)),
    ];

    for (let round = 0; round < 10; round++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: msgBuffer,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      });

      const choice = response.choices[0];
      if (!choice) return { text: '(응답 없음)', usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 } };

      if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
        const u = response.usage;
        return {
          text: choice.message.content ?? '(응답 없음)',
          usage: { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
        };
      }

      msgBuffer.push({
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      });

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const input = JSON.parse(toolCall.function.arguments || '{}') as unknown;
        const result = await executeTool(toolCall.function.name, input, toolCall.id);
        // 이미지 결과는 텍스트로 대체
        const content = Array.isArray(result) ? '[이미지 결과 — OpenAI 호환 모드 미지원]' : result;
        msgBuffer.push({ role: 'tool', tool_call_id: toolCall.id, content });
      }
    }

    return { text: '(툴 실행 횟수 초과)', usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

// ── 변환 헬퍼 ─────────────────────────────────────────────

/** Anthropic Tool[] → OpenAI ChatCompletionTool[] */
function anthropicToOpenAITools(tools: Anthropic.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ── 팩토리 ────────────────────────────────────────────────

export function createLLMClient(cfg: AgentConfig): LLMClient {
  if (cfg.provider === 'anthropic' && !cfg.baseUrl) {
    return new AnthropicClient(cfg.apiKey, cfg.model);
  }
  return new OpenAICompatClient(cfg.apiKey, cfg.model, cfg.baseUrl);
}
