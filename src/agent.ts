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
import { runClaudeCode, hasClaudeCodeSession } from './claude-code';
import { sendSplit, getErrorMessage, delay, keepTyping } from './utils';
import { planTasks } from './task/planner';
import { TaskGraph } from './task/graph';
import { runTaskGraph } from './task/runner';
import type { Task } from './task/types';
import { executeWorkflow } from './agentGraph/executor';
import { getRoleContent } from './roleContext';
import { runRetrospective } from './retrospective';
import { serializeAgentMessage, parseAgentMessage } from './agentProtocol';
import * as taskWaiter from './taskWaiter';

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
    const startedAt = Date.now();

    const MAX_ATTEMPTS = 3; // 최초 1회 + 재시도 최대 2회
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const stopTyping = keepTyping(channel);
      console.log(`${label} ${modeTag}${toolTag} 응답 중... (${message.author.username})${attempt > 1 ? ` [재시도 ${attempt - 1}]` : ''}`);
      try {
        const systemPrompt = await this.buildSystemPrompt(mode, message.channelId);
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
        return;

      } catch (err: unknown) {
        stopTyping();
        const { message: errMsg, retryAfter } = getErrorMessage(err);
        console.warn(`${label} 오류: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
        if (retryAfter && attempt < MAX_ATTEMPTS) {
          console.log(`${label} ${retryAfter / 1000}초 후 재시도... (${attempt}/${MAX_ATTEMPTS - 1})`);
          await delay(retryAfter);
          continue;
        }
        await channel.send(errMsg).catch(() => {});
        return;
      }
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
    const systemPrompt = await this.buildSystemPrompt('chat', collabChannelId);
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

      // 4. 회고 — 사이클 완료 후 이슈 분석 및 역할 핀 개선 제안 (Phase 1: 유저 컨펌)
      if (graph.isComplete() || graph.hasFailed()) {
        const systemPrompt = await this.buildSystemPrompt('chat', message.channelId);
        runRetrospective({
          graph: graph.data,
          llm: this.llm,
          client: this.botClient,
          agentSystemPrompt: systemPrompt,
          channel,
          userId: message.author.id,
        }).catch((err: unknown) => {
          console.warn(`[${this.name}] 회고 실패:`, err instanceof Error ? err.message : err);
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] 태스크 그래프 오류:`, msg);
      await channel.send(`❌ 태스크 실행 중 오류: ${msg.slice(0, 200)}`).catch(() => {});
    }
  }

  /**
   * 단일 태스크를 실행합니다.
   * 역할 봇이 config에 등록되어 있으면 [AGENT_MSG] TASK_ASSIGN으로 위임합니다.
   * 역할 봇이 없으면 내부 워크플로우(executeWorkflow)로 폴백합니다.
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

    // 역할 봇 탐색 (자신 제외 — 오케스트레이터가 자기한테 위임하는 것 방지)
    const hasRoleBot = this.appCfg.agents.some(
      (a) => a.role === enrichedTask.role && a.id !== this.id,
    );

    if (hasRoleBot) {
      return this.delegateTask(enrichedTask, graph.data.id, channelId);
    }

    // 역할 봇 없음 → 내부 워크플로우 폴백
    console.log(`[${this.name}] 역할 봇 없음(${enrichedTask.role}) — 내부 워크플로우로 폴백`);
    const workflow = await executeWorkflow(
      enrichedTask,
      graph.data.id,
      channelId,
      this.llm,
      this.name,
      await this.buildSystemPrompt('chat', channelId),
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

  /**
   * 태스크를 해당 역할 봇에게 [AGENT_MSG] TASK_ASSIGN으로 위임합니다.
   * 봇의 응답(TASK_RESULT)을 taskWaiter로 대기하다가 결과를 반환합니다.
   */
  private async delegateTask(
    task: Task,
    graphId: string,
    channelId: string,
  ): Promise<string> {
    const waiterKey = `${graphId}/${task.id}`;
    const cycleId = `${graphId}-${task.id}`;
    const TIMEOUT_MS = 15 * 60 * 1000; // 15분

    const envelope = serializeAgentMessage(
      {
        cycleId,
        turn: 1,
        from: this.id,
        to: task.role,        // router: agents.find(a => a.config.role === header.to)
        type: 'TASK_ASSIGN',
        goalId: waiterKey,
      },
      [
        `## 태스크 정보`,
        `**제목:** ${task.title}`,
        ``,
        task.description,
        ``,
        `---`,
        `완료 후 \`[AGENT_MSG] type: TASK_RESULT\` 형식으로 결과를 보고하세요.`,
        `(봉투 형식은 팀 공통 규약 참조)`,
      ].join('\n'),
    );

    const channel = await this.botClient.channels.fetch(channelId).catch(() => null) as TextChannel | null;
    if (!channel) throw new Error(`채널 접근 불가 (delegateTask): ${channelId}`);

    // 대기 등록 먼저 → 메시지 전송 (race condition 방지)
    const resultPromise = taskWaiter.register(waiterKey, TIMEOUT_MS);
    await channel.send(envelope);
    console.log(`[${this.name}] ➡️  태스크 위임: [${task.id}] ${task.title} → ${task.role}`);

    const resultText = await resultPromise;

    // 응답이 [AGENT_MSG] TASK_RESULT 형식이면 status 확인
    const parsed = parseAgentMessage(resultText);
    if (parsed?.header.type === 'TASK_RESULT') {
      if (parsed.header.status === 'FAILED' || parsed.header.status === 'BLOCKED') {
        throw new Error(parsed.body.slice(0, 300) || `태스크 ${parsed.header.status}: ${task.title}`);
      }
      return parsed.body || resultText;
    }
    return resultText;
  }

  // ── 내부 메서드 ────────────────────────────────────────────

  /**
   * services 목록을 기반으로 API에 전달할 툴 배열을 구성합니다.
   * - 빈 배열 → [] (순수 대화, 툴 없음)
   * - "computer" → Anthropic Computer Use Beta 툴 (config.computerUse: true 필요)
   * - 그 외 → 해당 MCP 서버 툴
   */
  private buildChatTools(services: string[]): AnyTool[] {
    const tools: AnyTool[] = [];

    // orchestrator는 claude_code 툴 없음 — 구현은 팀원에게 위임하는 역할
    if (this.config.role !== 'orchestrator') {
      tools.push(CLAUDE_CODE_TOOL);
    }

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

  private async buildSystemPrompt(mode: 'chat' | 'config', channelId?: string): Promise<string> {
    const personaContent = persona.load(this.config.personaFile);
    const base = `당신은 ${this.name}입니다.\n\n${personaContent}`;

    // 채널 토픽 + 핀 메시지 컨텍스트
    const channelCtxBlock = channelId
      ? buildContextBlock(getChannelContext(channelId), this.id)
      : '';

    // 역할 채널 컨텍스트
    // - 채널 핀에 역할 설정 있으면 해당 역할 채널 내용 주입 (여러 역할이면 모두 누적)
    // - 채널 핀에 역할 설정 없으면 config.role 디폴트 역할 채널 내용 폴백
    let roleBlock = '';
    if (channelId) {
      const guild = this.botClient.guilds.cache.first() ?? null;
      const roleContent = await getRoleContent(
        this.botClient,
        this.id,
        channelId,
        this.config.role,
        guild ?? undefined,
      );
      if (roleContent) {
        roleBlock = '\n\n---\n## 나의 역할\n' + roleContent;
      }
    }

    const isOrchestrator = this.config.role === 'orchestrator';
    const common =
      '\n\n---\n' +
      '## 응답 규칙\n' +
      '- 응답 앞에 자신의 이름을 절대 붙이지 마세요. (예: "[찌몽] ..." 형태 금지)\n' +
      '- Discord가 자동으로 봇 이름을 표시하므로 불필요합니다.\n' +
      (isOrchestrator
        ? '- 오케스트레이터는 도구를 직접 실행하지 않습니다. 모든 실행 작업은 팀원에게 @멘션으로 위임하세요.'
        : '- 코드 작성·수정·실행·테스트가 필요한 작업은 반드시 claude_code 도구를 사용하세요.\n' +
          '- claude_code 사용이 불가능하거나 실패한 경우에는 LLM으로 직접 응답하되, ' +
          '응답 말미에 "[⚠️ claude_code 미사용]" 태그와 함께 사용하지 못한 이유를 간략히 명시하세요.');

    if (mode === 'config') {
      return (
        base + channelCtxBlock + roleBlock + common +
        '\n\n---\n' +
        '## 설정 채널 지시사항\n' +
        '사용자가 이 채널에서 내리는 지시는 당신의 페르소나·규칙·기억을 수정하는 명령입니다.\n' +
        '지시에 따라 반드시 update_persona 도구를 사용하여 페르소나 파일을 수정하고, ' +
        '수정 완료 후 어떤 내용을 어떻게 변경했는지 한국어로 확인 메시지를 보내세요.'
      );
    }
    return base + channelCtxBlock + roleBlock + common;
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
      const storeKey = input.sessionKey ?? channelId;
      // LLM이 resume을 명시하지 않으면, 기존 세션이 있을 경우 자동으로 이어서 실행합니다.
      const shouldResume = input.resume ?? hasClaudeCodeSession(storeKey);
      console.log(`[${this.name}] 🤖 Claude Code 실행 중... (resume: ${shouldResume}, key: ${storeKey})`);
      const result = await runClaudeCode({
        task: input.task,
        workdir: input.workdir,
        resume: shouldResume,
        channelId,
        sessionKey: input.sessionKey,
      });
      console.log(`[${this.name}] 🤖 Claude Code 완료 (session: ${result.sessionId ?? 'none'})`);
      // sessionId를 결과에 포함시켜 LLM이 세션 존재를 인지하고 다음 호출에서 resume: true를 사용할 수 있게 합니다.
      const sessionNote = result.sessionId
        ? `\n\n[claude_code_session: ${result.sessionId}]`
        : '';
      return result.text + sessionNote;
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
