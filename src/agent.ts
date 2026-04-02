/**
 * agent.ts — AI 에이전트 클래스
 *
 * 각 Discord 봇(찌몽/아루/센세)은 이 Agent 클래스의 인스턴스입니다.
 * 에이전트마다 독립된 페르소나, LLMClient, AgentMCPManager를 가집니다.
 *
 * 대화 히스토리는 history.ts(인메모리)에서 관리합니다.
 *   - 유저 메시지: router.ts에서 수신 시 history.addMessage() 호출
 *   - 봇 응답: respond()/respondInCollab() 완료 후 history.addMessage() 호출
 *
 * 툴 활성화 방식:
 *   - services 파라미터로 사용할 MCP 서버 이름 목록을 전달합니다.
 *   - 빈 배열이면 툴 없이 순수 대화 (토큰 절감)
 *   - "computer" 서비스는 Anthropic Computer Use Beta 툴을 활성화합니다.
 *   - router.ts에서 @툴봇 멘션을 파싱하여 services를 결정합니다.
 */

import { Client, Message, TextChannel } from 'discord.js';
import type { AgentConfig, AppConfig } from './config';
import { createLLMClient, type LLMClient, type ToolResultContent } from './llm';
import { AgentMCPManager } from './mcp';
import { computerAction, executeBash, executeTextEditor } from './computer';
import * as history from './history';
import * as persona from './persona';
import { getChannelContext, buildContextBlock } from './channelContext';
import { CONFIG_TOOLS, CHAT_TOOLS, COMPUTER_USE_TOOLS, CLAUDE_CODE_TOOL, type AnyTool } from './tools';
import { runClaudeCode } from './claude-code';
import { sendSplit, getErrorMessage, delay, keepTyping } from './utils';
import { planTasks } from './task/planner';
import { TaskGraph } from './task/graph';
import { runTaskGraph } from './task/runner';
import type { Task } from './task/types';
import { executeWorkflow } from './agentGraph/executor';

export class Agent {
  readonly id: string;
  readonly name: string;
  config: AgentConfig;
  appCfg: AppConfig;         // 전역 설정 참조 (maxReviewRetries 등)
  botClient: Client;

  private llm: LLMClient;
  readonly mcpManager: AgentMCPManager;

  constructor(cfg: AgentConfig, botClient: Client, appCfg: AppConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.config = cfg;
    this.appCfg = appCfg;
    this.botClient = botClient;
    this.llm = createLLMClient(cfg);
    this.mcpManager = new AgentMCPManager(cfg.id, cfg.mcpTokens);
  }

  /** 관리 웹 UI에서 설정을 변경할 때 호출됩니다. 즉시 적용 가능한 항목을 갱신합니다. */
  updateConfig(next: AgentConfig): void {
    const llmChanged =
      this.config.provider !== next.provider ||
      this.config.model !== next.model ||
      this.config.apiKey !== next.apiKey ||
      this.config.baseUrl !== next.baseUrl;

    this.config = next;
    if (llmChanged) {
      this.llm = createLLMClient(next);
      console.log(`[${this.name}] LLM 교체: ${next.provider}/${next.model}`);
    }
  }

  // ── 공개 메서드 ────────────────────────────────────────────

  /**
   * 개별/설정 채널에서 메시지를 받아 응답합니다.
   *
   * 유저 메시지는 router.ts에서 history에 이미 추가된 상태로 호출됩니다.
   * history.getHistory()로 유저 메시지 포함 전체 히스토리를 가져와 API 호출합니다.
   */
  async respond(message: Message, mode: 'chat' | 'config', services: string[] = []): Promise<void> {
    const channel = message.channel as TextChannel;

    const label = `[${this.name}]`;
    const modeTag = mode === 'config' ? '설정' : '대화';
    const toolTag = services.length > 0 ? ` +[${services.join(',')}]` : '';
    console.log(`${label} ${modeTag}${toolTag} 응답 중... (${message.author.username})`);
    const startedAt = Date.now();

    const stopTyping = keepTyping(channel);
    try {
      const systemPrompt = this.buildSystemPrompt(mode, message.channelId);
      // 유저 메시지는 router.ts에서 이미 추가됨 → 히스토리에 포함되어 있음
      const historyMessages = history.getHistory(message.channelId, this.id, false);
      const tools = mode === 'config' ? CONFIG_TOOLS : this.buildChatTools(services);

      const { text: responseText, usage } = await this.llm.chat(
        systemPrompt,
        historyMessages,
        tools,
        (name, input, id) => this.executeTool(name, input, id, message.channelId),
      );

      history.addMessage(message.channelId, {
        authorId: this.id,
        authorName: this.name,
        content: responseText,
      });

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const cacheInfo = usage.cacheRead > 0
        ? ` | cache read: ${usage.cacheRead.toLocaleString()}`
        : usage.cacheWrite > 0 ? ` | cache write: ${usage.cacheWrite.toLocaleString()}` : '';
      console.log(`${label} 완료 (${elapsed}s) 📊 in: ${usage.inputTokens.toLocaleString()} / out: ${usage.outputTokens.toLocaleString()}${cacheInfo}`);

      stopTyping();
      const usageLine = `-# 📊 in ${usage.inputTokens.toLocaleString()} · out ${usage.outputTokens.toLocaleString()}${usage.cacheRead > 0 ? ' · ⚡캐시' : ''}`;
      await sendSplit(channel, `${responseText}\n${usageLine}`);

    } catch (err: unknown) {
      stopTyping();
      const { message: errMsg, retryAfter } = getErrorMessage(err);
      console.warn(`${label} 오류: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      if (retryAfter) {
        console.log(`${label} ${retryAfter / 1000}초 후 재시도...`);
        await delay(retryAfter);
        try {
          await this.respond(message, mode, services);
          return;
        } catch { /* 재시도도 실패하면 에러 메시지 전송 */ }
      }
      await channel.send(errMsg).catch(() => {});
    }
  }

  /**
   * 협력 채널에서 응답 텍스트를 생성하여 반환합니다.
   * Discord 전송은 collaboration.ts가 담당합니다.
   *
   * 유저 메시지 및 앞선 에이전트 응답은 history에 이미 추가된 상태입니다.
   * history.getHistory()로 협력 채널 전체 맥락을 가져와 API 호출합니다.
   */
  async respondInCollab(
    collabChannelId: string,
    services: string[] = [],
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt('chat', collabChannelId);
    const historyMessages = history.getHistory(collabChannelId, this.id, true);

    const { text } = await this.llm.chat(
      systemPrompt,
      historyMessages,
      this.buildChatTools(services),
      (name, input, id) => this.executeTool(name, input, id, collabChannelId),
    );
    return text;
  }

  // ── Task Graph ────────────────────────────────────────────

  /**
   * 재시작 후 미완료 그래프를 이어서 실행합니다.
   * index.ts 기동 시 loadIncompleteGraphs()로 감지된 그래프에 호출됩니다.
   */
  async resumeTaskGraph(graph: TaskGraph, channel: TextChannel): Promise<void> {
    graph.resetForResume();
    console.log(`[${this.name}] 🔄 태스크 그래프 재개: ${graph.data.id}`);
    await channel.send(`🔄 **[재개]** 봇 재시작으로 중단된 작업을 이어서 실행합니다.\n> ${graph.data.goal}`);
    await runTaskGraph(
      graph,
      channel,
      (task) => this.executeTask(task, graph, graph.data.channelId),
    );
  }

  /**
   * 사용자의 목표를 Task Graph로 분해하고 순차 실행합니다.
   * router.ts에서 `!목표 <goal>` 명령 감지 시 호출됩니다.
   */
  async startTaskGraph(message: Message, goal: string): Promise<void> {
    const channel = message.channel as TextChannel;

    try {
      await channel.send(`🤔 **목표 분석 중...**\n> ${goal}`);

      // 1. LLM으로 태스크 분해
      const taskInputs = await planTasks(goal, this.llm);

      // 2. TaskGraph 생성 (파일에 저장됨)
      const graph = TaskGraph.create(goal, message.channelId, this.id, taskInputs);
      console.log(`[${this.name}] 태스크 그래프 생성: ${graph.data.id} (${taskInputs.length}개)`);

      // 3. 순차 실행
      await runTaskGraph(
        graph,
        channel,
        (task) => this.executeTask(task, graph, message.channelId),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] 태스크 그래프 오류:`, msg);
      await channel.send(`❌ 태스크 실행 중 오류: ${msg.slice(0, 200)}`).catch(() => {});
    }
  }

  /**
   * 단일 태스크를 실행합니다.
   * 선행 태스크 결과를 컨텍스트로 포함하여 claude_code에 위임합니다.
   */
  private async executeTask(task: Task, graph: TaskGraph, channelId: string): Promise<string> {
    // 선행 태스크 결과를 task description에 포함
    const priorResults = task.dependencies
      .map((depId) => {
        const dep = graph.data.tasks.find((t) => t.id === depId);
        return dep?.result
          ? `### [${dep.id}] ${dep.title} 결과\n${dep.result.slice(0, 500)}`
          : null;
      })
      .filter((r): r is string => r !== null)
      .join('\n\n');

    const enrichedTask: Task = priorResults
      ? { ...task, description: `${task.description}\n\n## 선행 작업 결과\n${priorResults}` }
      : task;

    // Phase 2+3: Agent Workflow 파이프라인 (planner→developer→reviewer→tester)
    const workflow = await executeWorkflow(
      enrichedTask,
      graph.data.id,
      channelId,
      this.llm,
      this.name,
      this.buildSystemPrompt('chat', channelId),
      runClaudeCode,
      this.config.githubRepo,
      this.appCfg.maxReviewRetries,
    );

    return [
      workflow.devResult.slice(0, 400),
      `\n**테스트:** ${workflow.testResult.slice(0, 200)}`,
      workflow.approved ? '' : '\n⚠️ 리뷰 미승인 상태로 완료',
    ].filter(Boolean).join('\n');
  }

  // ── 내부 메서드 ────────────────────────────────────────────

  /**
   * services 목록을 기반으로 API에 전달할 툴 배열을 구성합니다.
   * - 빈 배열 → [] (순수 대화, 툴 없음)
   * - "computer" → Anthropic Computer Use Beta 툴 (config.computerUse: true 필요)
   * - 그 외 → 해당 MCP 서버 툴
   */
  private buildChatTools(services: string[]): AnyTool[] {
    // claude_code 툴은 항상 포함 (개발 작업 판단은 에이전트가 자율적으로)
    const tools: AnyTool[] = [CLAUDE_CODE_TOOL];

    if (services.length === 0) return tools;

    const mcpServices = services.filter((s) => s !== 'computer');
    if (mcpServices.length > 0) {
      tools.push(...this.mcpManager.getMcpToolsByServices(mcpServices));
    }

    if (services.includes('computer') && this.config.computerUse) {
      tools.push(...COMPUTER_USE_TOOLS);
    }

    return tools;
  }

  private buildSystemPrompt(mode: 'chat' | 'config', channelId?: string): string {
    const personaContent = persona.load(this.config.personaFile);
    const base = `당신은 ${this.name}입니다.\n\n${personaContent}`;

    // 채널 토픽 + 핀 메시지 컨텍스트
    const channelCtxBlock = channelId
      ? buildContextBlock(getChannelContext(channelId))
      : '';

    const common =
      '\n\n---\n' +
      '## 응답 규칙\n' +
      '- 응답 앞에 자신의 이름을 절대 붙이지 마세요. (예: "[찌몽] ..." 형태 금지)\n' +
      '- Discord가 자동으로 봇 이름을 표시하므로 불필요합니다.';

    if (mode === 'config') {
      return (
        base + channelCtxBlock + common +
        '\n\n---\n' +
        '## 설정 채널 지시사항\n' +
        '사용자가 이 채널에서 내리는 지시는 당신의 페르소나·규칙·기억을 수정하는 명령입니다.\n' +
        '지시에 따라 반드시 update_persona 도구를 사용하여 페르소나 파일을 수정하고, ' +
        '수정 완료 후 어떤 내용을 어떻게 변경했는지 한국어로 확인 메시지를 보내세요.'
      );
    }
    return base + channelCtxBlock + common;
  }

  /**
   * 단일 tool_use를 실행하고 결과를 반환합니다.
   * llm.ts의 chat()에서 executeTool 콜백으로 호출됩니다.
   */
  private async executeTool(
    toolName: string,
    toolInput: unknown,
    _toolUseId: string,
    channelId = '',
  ): Promise<ToolResultContent> {
    if (toolName === 'claude_code') {
      const input = toolInput as { task: string; workdir?: string; resume?: boolean; sessionKey?: string };
      console.log(`[${this.name}] 🤖 Claude Code 실행 중... (resume: ${input.resume ?? false}, key: ${input.sessionKey ?? channelId})`);
      const result = await runClaudeCode({
        task: input.task,
        workdir: input.workdir,
        resume: input.resume ?? false,
        channelId,
        sessionKey: input.sessionKey,
      });
      console.log(`[${this.name}] 🤖 Claude Code 완료 (session: ${result.sessionId ?? 'none'})`);
      return result.text;
    }

    if (toolName === 'update_persona') {
      const input = toolInput as {
        action: 'append_rule' | 'update_memory' | 'replace_section';
        content: string;
        section?: string;
      };
      persona.update(this.config.personaFile, input.action, input.content, input.section);
      return `페르소나 파일 수정 완료 (action: ${input.action})`;
    }

    if (toolName === 'computer') {
      return computerAction(toolInput as Parameters<typeof computerAction>[0]);
    }

    if (toolName === 'bash') {
      const { command } = toolInput as { command: string };
      return executeBash(command);
    }

    if (toolName === 'str_replace_editor') {
      return executeTextEditor(toolInput as Parameters<typeof executeTextEditor>[0]);
    }

    return this.mcpManager.callMcpTool(toolName, toolInput);
  }
}
