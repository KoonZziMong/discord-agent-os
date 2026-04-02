/**
 * router.ts — Discord 메시지 라우팅
 *
 * 라우팅 규칙:
 *   1. 봇 자신의 메시지 → 무시
 *   2. 협력 채널       → agents[0]의 봇만 collaboration.handle() 호출 (중복 방지)
 *   3. 그 외 채널      → 멘션된 봇만 응답 (@에이전트 멘션 기반)
 *   4. 명령어(!페르소나, !도움말) → AI 호출 없이 즉시 응답
 */
import { Message, Client, TextChannel } from 'discord.js';
import type { Agent } from './agent';
import type { AppConfig } from './config';
import { handle as handleCollab } from './collaboration';
import { load } from './persona';
import { sendSplit } from './utils';
import * as history from './history';
import { loadChannelContext, getChannelContext } from './channelContext';

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

async function handleCommand(cmd: 'persona' | 'help', agent: Agent, message: Message, appCfg: AppConfig): Promise<void> {
  const channel = message.channel as TextChannel;

  if (cmd === 'persona') {
    const content = load(agent.config.personaFile);
    await sendSplit(channel, `**${agent.name}의 현재 페르소나**\n\`\`\`markdown\n${content}\n\`\`\``);
    return;
  }

  if (cmd === 'help') {
    const cmds = appCfg.commands;
    const taskPrefixes = cmds.task.map((p) => `\`${p}\``).join(' / ');
    const personaPrefixes = cmds.persona.map((p) => `\`${p}\``).join(' / ');
    const helpPrefixes = cmds.help.map((p) => `\`${p}\``).join(' / ');
    const agentNames = appCfg.agents.map((a) => `@${a.name}`);

    const help = [
      `**${agent.name} 사용 가이드**`,
      '',
      `→ ${taskPrefixes} <목표> — AI가 자동으로 작업을 수행합니다`,
      `→ ${personaPrefixes} — 현재 페르소나 확인`,
      `→ ${helpPrefixes} — 이 메시지 표시`,
      '',
      '**협력 채널**',
      `→ ${agentNames.join(', ')} 멘션 — 해당 에이전트 지목`,
      '→ 멘션 없이 메시지 — 모든 에이전트 순차 응답',
    ].join('\n');
    await channel.send(help);
    return;
  }
}

export function createRouter(agents: Agent[], appCfg: AppConfig, primaryClient: Client) {
  return async function handle(message: Message, sourceClient: Client): Promise<void> {
    // 봇 자신의 메시지 무시
    if (message.author.bot) return;

    const channelId = message.channelId;

    // 협력 채널 — primaryClient 하나만 처리 (중복 응답 방지)
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

    // 멘션된 에이전트 찾기 — 이 sourceClient가 멘션된 봇인지 확인
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

    // 명령어 처리
    if (cmds.persona.includes(trimmed)) {
      await handleCommand('persona', mentionedAgent, message, appCfg);
      return;
    }
    if (cmds.help.includes(trimmed)) {
      await handleCommand('help', mentionedAgent, message, appCfg);
      return;
    }

    // 태스크 목표
    const taskPrefix = cmds.task.find((p) => trimmed.startsWith(p + ' '));
    if (taskPrefix) {
      const goal = trimmed.slice(taskPrefix.length).trim();
      if (goal) {
        await mentionedAgent.startTaskGraph(message, goal);
        return;
      }
    }

    // 히스토리에 유저 메시지 추가 (채널이 초기화되지 않은 경우 자동 무시)
    history.addMessage(channelId, {
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      content: message.content,
    });

    const services = extractToolServices(message, appCfg.toolBots);
    await mentionedAgent.respond(message, 'chat', services);
  };
}
