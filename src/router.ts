/**
 * router.ts — Discord 메시지 라우팅
 *
 * 라우팅 규칙:
 *   1. 봇 메시지:
 *      - [AGENT_MSG] 봉투를 가진 알려진 에이전트 봇 메시지 → 하네스 라우팅
 *      - 그 외 봇 메시지 → 무시
 *   2. 협력 채널 (유저 메시지) → collaboration.handle() 호출
 *   3. 그 외 채널 (유저 메시지) → 멘션된 봇만 응답 (@에이전트 멘션 기반)
 *   4. 명령어(!페르소나, !도움말) → AI 호출 없이 즉시 응답
 *
 * 하네스 라우팅:
 *   - [AGENT_MSG] 헤더의 `to` 필드로 대상 에이전트를 결정
 *   - 사이클 상태(CycleState)로 turn 한도·루프·rate-limit 제어
 *   - turn >= TURN_WARNING_THRESHOLD: 경고 메시지
 *   - turn >= maxTurnsPerCycle: 라우팅 중단, 유저에게 보고
 */
import { Message, Client, TextChannel } from 'discord.js';
import type { Agent } from './agent';
import type { AppConfig } from './config';
import { handle as handleCollab } from './collaboration';
import { load } from './persona';
import { sendSplit } from './utils';
import * as history from './history';
import { loadChannelContext, getChannelContext } from './channelContext';
import {
  isAgentMessage,
  parseAgentMessage,
  createCycleState,
  checkRateLimit,
  detectLoop,
  parseTeamManifest,
  TURN_WARNING_THRESHOLD,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_BOT_MESSAGES_PER_MINUTE,
} from './agentProtocol';
import type { CycleState } from './agentProtocol';

// ── 사이클 상태 인메모리 저장 ──────────────────────────────────

// cycleId → CycleState
const activeCycles = new Map<string, CycleState>();

// 채널별 연속 봇 메시지 카운터 (루프 방지)
// channelId → 연속 봇 메시지 수
const botTurnCounter = new Map<string, number>();
const MAX_CONSECUTIVE_BOT_TURNS = 100;

// ── 유틸 ──────────────────────────────────────────────────────

/**
 * 메시지에서 @툴봇 멘션을 찾아 활성화할 서비스 목록을 반환합니다.
 */
function extractToolServices(message: Message, toolBots: Record<string, string>): string[] {
  const services: string[] = [];
  for (const user of message.mentions.users.values()) {
    const service = toolBots[user.username];
    if (service) services.push(service);
  }
  return services;
}

async function handleCommand(
  cmd: 'persona' | 'help',
  agent: Agent,
  message: Message,
  appCfg: AppConfig,
): Promise<void> {
  const channel = message.channel as TextChannel;

  if (cmd === 'persona') {
    const content = load(agent.config.personaFile);
    await sendSplit(channel, `**${agent.name}의 현재 페르소나**\n\`\`\`markdown\n${content}\n\`\`\``);
    return;
  }

  if (cmd === 'help') {
    const cmds = appCfg.commands;
    const taskPrefixes = cmds.task.map((p) => `\`${p}\``).join(' / ');
    const autonomousPrefixes = cmds.autonomous.map((p) => `\`${p}\``).join(' / ');
    const personaPrefixes = cmds.persona.map((p) => `\`${p}\``).join(' / ');
    const helpPrefixes = cmds.help.map((p) => `\`${p}\``).join(' / ');
    const agentNames = appCfg.agents.map((a) => `@${a.name}`);

    const help = [
      `**${agent.name} 사용 가이드**`,
      '',
      `→ ${taskPrefixes} <목표> — 오케스트레이터가 팀에 위임하여 수행합니다`,
      `→ ${autonomousPrefixes} <목표> — 단독 에이전트 자동 파이프라인으로 수행합니다`,
      `→ ${personaPrefixes} — 현재 페르소나 확인`,
      `→ ${helpPrefixes} — 이 메시지 표시`,
      '',
      '**협력 채널**',
      `→ ${agentNames.join(', ')} 멘션 — 해당 에이전트 지목`,
    ].join('\n');
    await channel.send(help);
    return;
  }
}

// ── 하네스 라우팅 ─────────────────────────────────────────────

/**
 * [AGENT_MSG] 봉투 메시지를 처리합니다.
 * - 사이클 상태 갱신 (turn 카운트, rate-limit, 루프 감지)
 * - to 필드에 해당하는 에이전트에게 메시지를 전달
 */
async function handleHarnessMessage(
  message: Message,
  agents: Agent[],
  appCfg: AppConfig,
  primaryClient: Client,
): Promise<void> {
  const parsed = parseAgentMessage(message.content);
  if (!parsed) return;

  const { header, body } = parsed;
  const channelId = message.channelId;
  const channel = message.channel as TextChannel;

  // 팀 매니페스트에서 turn 한도 조회 (없으면 기본값)
  const ctx = getChannelContext(channelId);
  const manifest = parseTeamManifest(ctx.pins);
  const maxTurns = manifest?.maxTurnsPerCycle ?? DEFAULT_MAX_TURNS;
  const maxBotMsgs = manifest?.maxBotMessagesPerMinute ?? DEFAULT_MAX_BOT_MESSAGES_PER_MINUTE;

  // 사이클 상태 가져오기 또는 생성
  let cycle = activeCycles.get(header.cycleId);
  if (!cycle) {
    cycle = createCycleState(header.cycleId, header.goalId, channelId);
  }

  // Rate-limit 체크
  const { exceeded, updatedState: afterRate } = checkRateLimit(cycle, maxBotMsgs);
  cycle = afterRate;
  activeCycles.set(header.cycleId, cycle);

  if (exceeded) {
    console.warn(`[하네스] rate-limit 초과 (cycleId: ${header.cycleId})`);
    await channel.send(
      `⚠️ **[하네스 경고]** 봇 메시지 분당 한도(${maxBotMsgs}개) 초과 — 30초간 라우팅 중단합니다.`,
    );
    await new Promise((r) => setTimeout(r, 30_000));
    return;
  }

  // Turn 한도 체크
  if (header.turn >= maxTurns) {
    console.warn(`[하네스] turn 한도 도달 (cycleId: ${header.cycleId}, turn: ${header.turn})`);
    activeCycles.delete(header.cycleId);
    await channel.send(
      `🛑 **[하네스 중단]** 최대 turn(${maxTurns}) 도달 — 사이클 \`${header.cycleId}\` 종료.\n` +
      `> 마지막 from: \`${header.from}\` → to: \`${header.to}\`\n` +
      '유저가 직접 다음 단계를 지시해 주세요.',
    );
    return;
  }

  // Turn 경고
  if (header.turn >= TURN_WARNING_THRESHOLD) {
    await channel.send(
      `-# ⚠️ [하네스] turn ${header.turn}/${maxTurns} — 목표를 빠르게 마무리하세요.`,
    );
  }

  // 루프 감지 (동일 from→to 조합 3회 이상)
  if (detectLoop(cycle, header.from, header.to)) {
    console.warn(`[하네스] 루프 감지 (${header.from} → ${header.to})`);
    activeCycles.delete(header.cycleId);
    await channel.send(
      `🔁 **[하네스 루프 감지]** \`${header.from} → ${header.to}\` 반복이 감지되었습니다.\n` +
      '사이클이 종료되었습니다. 유저가 직접 개입해 주세요.',
    );
    return;
  }

  // 사이클 상태 갱신
  cycle = {
    ...cycle,
    turn: Math.max(cycle.turn, header.turn),
    visitedPairs: [...cycle.visitedPairs, `${header.from}:${header.to}`],
  };
  activeCycles.set(header.cycleId, cycle);

  // SYSTEM_USER 대상 → 유저 채널에 그대로 출력 (라우팅 없음)
  if (header.to === 'SYSTEM_USER') {
    // 이미 봇이 채널에 메시지를 보냈으므로 추가 처리 불필요
    // (CONFIRM_REQUEST는 봇이 직접 send한 메시지임)
    return;
  }

  // 대상 에이전트 찾기
  const targetAgent = agents.find((a) => (a.config.role ?? a.id) === header.to);
  if (!targetAgent) {
    console.warn(`[하네스] 대상 에이전트 없음 (to: ${header.to})`);
    return;
  }

  // 히스토리에 봇 메시지 추가 (다음 에이전트가 컨텍스트로 참조)
  history.addMessage(channelId, {
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
  });

  console.log(
    `[하네스] turn ${header.turn} | ${header.from} → ${targetAgent.name} (${header.type})`,
  );

  // 대상 에이전트 응답 (협력 채널 방식으로 — 응답을 채널에 전송)
  const agentChannel = await targetAgent.botClient.channels
    .fetch(channelId)
    .catch(() => null) as TextChannel | null;

  if (!agentChannel) {
    console.warn(`[하네스] 에이전트 채널 접근 실패 (${channelId})`);
    return;
  }

  // 에이전트가 봉투 메시지를 이해할 수 있도록 body를 전달
  // respondInCollab은 히스토리 기반으로 응답 → 봉투 포함 전체 메시지가 히스토리에 있음
  try {
    const responseText = await targetAgent.respondInCollab(channelId);
    history.addMessage(channelId, {
      authorId: targetAgent.id,
      authorName: targetAgent.name,
      content: responseText,
    });
    await sendSplit(agentChannel, responseText);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[하네스] 에이전트 응답 오류 (${targetAgent.name}): ${msg}`);
    await agentChannel.send(`❌ ${targetAgent.name} 응답 오류: ${msg.slice(0, 100)}`).catch(() => {});
  }
}

// ── 라우터 팩토리 ─────────────────────────────────────────────

export function createRouter(agents: Agent[], appCfg: AppConfig, primaryClient: Client) {
  const agentIds = new Set(agents.map((a) => a.id));

  return async function handle(message: Message, sourceClient: Client): Promise<void> {
    // ── 봇 메시지 처리 ──────────────────────────────────────
    if (message.author.bot) {
      // primaryClient 하나만 처리 (중복 방지)
      if (sourceClient.user?.id !== primaryClient.user?.id) return;

      if (agentIds.has(message.author.id)) {
        // [AGENT_MSG] 봉투 → 하네스 라우팅 (기존)
        if (isAgentMessage(message.content)) {
          await handleHarnessMessage(message, agents, appCfg, primaryClient);
          return;
        }

        // 봇 @멘션 → 멘션된 봇들에게 병렬 전달 (자기 자신 제외 — 상태 메시지가 goal을 echo할 때 자기 멘션 방지)
        const mentionedAgents = agents.filter((a) => message.mentions.users.has(a.id) && a.id !== message.author.id);
        if (mentionedAgents.length > 0) {
          const chId = message.channelId;
          const turns = (botTurnCounter.get(chId) ?? 0) + 1;

          if (turns > MAX_CONSECUTIVE_BOT_TURNS) {
            console.warn(`[라우터] 연속 봇 턴 한도 초과 (채널: ${chId}) — 라우팅 중단`);
            const ch = message.channel as TextChannel;
            await ch.send(
              `🛑 **[봇 루프 방지]** 연속 봇 메시지가 ${MAX_CONSECUTIVE_BOT_TURNS}회를 초과했습니다. 유저가 직접 개입해 주세요.`,
            );
            botTurnCounter.delete(chId);
            return;
          }

          botTurnCounter.set(chId, turns);
          history.addMessage(chId, {
            authorId: message.author.id,
            authorName: message.member?.displayName ?? message.author.username,
            content: message.content,
          });

          console.log(`[라우터] 봇 멘션 라우팅: ${message.author.username} → [${mentionedAgents.map((a) => a.name).join(', ')}] (turn ${turns}) — 병렬 실행`);

          // 멘션된 모든 봇 병렬 응답
          await Promise.all(mentionedAgents.map(async (agent) => {
            const agentCh = await agent.botClient.channels.fetch(chId).catch(() => null) as TextChannel | null;
            if (!agentCh) return;
            try {
              const responseText = await agent.respondInCollab(chId);
              history.addMessage(chId, {
                authorId: agent.id,
                authorName: agent.name,
                content: responseText,
              });
              await sendSplit(agentCh, responseText);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[라우터] 봇 멘션 응답 오류 (${agent.name}): ${msg}`);
            }
          }));
        }
      }
      return;
    }

    // 유저 메시지가 오면 해당 채널의 봇 턴 카운터 리셋
    botTurnCounter.delete(message.channelId);

    const channelId = message.channelId;

    // ── 협력 채널 (유저 메시지) ─────────────────────────────
    if (channelId === appCfg.collabChannel) {
      if (sourceClient.user?.id !== primaryClient.user?.id) return;
      history.addMessage(channelId, {
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.username,
        content: message.content,
      });
      const services = extractToolServices(message, appCfg.toolBots);
      await handleCollab(message, agents, appCfg.collabChannel, services);
      return;
    }

    // ── 그 외 채널 (유저 메시지) ────────────────────────────
    const mentionedAgent = agents.find(
      (a) => a.botClient === sourceClient && message.mentions.users.has(a.id),
    );
    if (!mentionedAgent) return;

    // 처음 방문하는 채널이면 채널 컨텍스트 자동 로드
    const ctx = getChannelContext(channelId);
    if (ctx.topic === '' && ctx.pins.length === 0) {
      await loadChannelContext(message.channel as TextChannel).catch(() => {});
    }

    const trimmed = message.content.trim();
    const cmds = appCfg.commands;

    if (cmds.persona.includes(trimmed)) {
      await handleCommand('persona', mentionedAgent, message, appCfg);
      return;
    }
    if (cmds.help.includes(trimmed)) {
      await handleCommand('help', mentionedAgent, message, appCfg);
      return;
    }

    // !목표 / !task → 오케스트레이터 LLM이 Role 핀에 따라 팀 위임 처리
    // 목표 텍스트를 히스토리에 추가 후 respond() 호출 → [AGENT_MSG]로 planner/developer 등에 위임
    // (단독 에이전트로 자동 파이프라인 실행이 필요하면 !자율 명령 사용)
    const taskPrefix = cmds.task.find((p) => trimmed.startsWith(p + ' '));
    if (taskPrefix) {
      // Discord 봇 멘션(<@id>) 제거 — 목표 텍스트가 상태 메시지로 echo될 때 재라우팅 방지
      const goal = trimmed.slice(taskPrefix.length).trim().replace(/<@!?\d+>/g, '').trim();
      if (goal) {
        history.addMessage(channelId, {
          authorId: message.author.id,
          authorName: message.member?.displayName ?? message.author.username,
          content: goal,
        });
        const services = extractToolServices(message, appCfg.toolBots);
        await mentionedAgent.respond(message, 'chat', services);
        return;
      }
    }

    // !자율 / !pipeline → 단독 에이전트 자동 파이프라인 (LLM 위임 없이 내부 실행)
    const autonomousPrefix = cmds.autonomous?.find((p) => trimmed.startsWith(p + ' '));
    if (autonomousPrefix) {
      const goal = trimmed.slice(autonomousPrefix.length).trim().replace(/<@!?\d+>/g, '').trim();
      if (goal) {
        await mentionedAgent.startTaskGraph(message, goal);
        return;
      }
    }

    history.addMessage(channelId, {
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      content: message.content,
    });

    const services = extractToolServices(message, appCfg.toolBots);
    await mentionedAgent.respond(message, 'chat', services);
  };
}

/**
 * 완료된 사이클을 인메모리에서 제거합니다.
 * task/runner.ts의 사이클 완료 시점에 호출합니다.
 */
export function closeCycle(cycleId: string): void {
  activeCycles.delete(cycleId);
}

/**
 * 현재 활성 사이클 목록을 반환합니다. (디버깅/관리 UI용)
 */
export function getActiveCycles(): CycleState[] {
  return [...activeCycles.values()];
}
