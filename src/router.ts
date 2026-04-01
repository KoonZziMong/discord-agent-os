/**
 * router.ts — Discord 메시지 라우팅
 *
 * 3개 봇 모두 서버의 모든 메시지를 수신하므로,
 * 이 모듈에서 "누가 처리할지"를 결정합니다.
 *
 * 라우팅 규칙:
 *   1. 봇 자신의 메시지 → 무시
 *   2. 협력 채널       → 대표 봇(찌몽)만 collaboration.handle() 호출
 *                        (나머지 봇은 스킵 → 중복 응답 방지)
 *   3. 대화/설정 채널  → 해당 채널 담당 에이전트의 봇만 처리
 *                        (다른 봇은 botUserId 불일치로 스킵)
 *   4. 명령어(!페르소나, !도움말) → AI 호출 없이 즉시 응답
 *   5. 기타 채널       → 무시
 */
import { Message, Client, TextChannel } from 'discord.js';
import type { Agent } from './agent';
import type { AppConfig } from './config';
import { handle as handleCollab } from './collaboration';
import { load } from './persona';
import { sendSplit } from './utils';
import * as history from './history';

/**
 * 메시지에서 @툴봇 멘션을 찾아 활성화할 서비스 목록을 반환합니다.
 * toolBots: { 봇username → MCP서버명 or "computer" }
 * user.username 기준으로 조회하므로 봇 User ID 대신 이름으로 매핑합니다.
 */
function extractToolServices(message: Message, toolBots: Record<string, string>): string[] {
  const services: string[] = [];
  for (const user of message.mentions.users.values()) {
    const service = toolBots[user.username];
    if (service) services.push(service);
  }
  return services;
}

const COMMANDS: Record<string, string> = {
  '!페르소나': '페르소나',
  '!persona': '페르소나',
  '!도움말': '도움말',
  '!help': '도움말',
};

async function handleCommand(cmd: string, agent: Agent, message: Message): Promise<void> {
  const channel = message.channel as TextChannel;

  if (cmd === '페르소나') {
    const content = load(agent.config.personaFile);
    await sendSplit(channel, `**${agent.name}의 현재 페르소나**\n\`\`\`markdown\n${content}\n\`\`\``);
    return;
  }

  if (cmd === '도움말') {
    const help = [
      `**${agent.name} 사용 가이드**`,
      '',
      '**대화 채널** (`#대화-*`)',
      '→ 자유롭게 대화하세요.',
      '→ `!페르소나` — 현재 페르소나 확인',
      '→ `!도움말` — 이 메시지 표시',
      '',
      '**설정 채널** (`#설정-*`)',
      '→ 자연어로 지시하면 페르소나가 수정됩니다.',
      '→ 예시: `앞으로 답변할 때 항상 예시 코드를 포함해줘`',
      '→ `!페르소나` — 현재 페르소나 확인',
      '',
      '**협력 채널** (`#협력-*`)',
      '→ `@찌몽 질문` — 특정 에이전트 지목',
      '→ `@찌몽 @아루 질문` — 복수 에이전트 지목 (순서대로 응답)',
      '→ 멘션 없이 메시지 — 전체(찌몽→아루→센세) 순차 응답',
    ].join('\n');
    await channel.send(help);
    return;
  }
}

export function createRouter(agents: Agent[], appCfg: AppConfig, primaryClient: Client) {
  // 채널 ID → {에이전트, 모드} 매핑
  const channelMap = new Map<string, { agent: Agent; mode: 'chat' | 'config' }>();

  for (const agent of agents) {
    channelMap.set(agent.config.chatChannel, { agent, mode: 'chat' });
    channelMap.set(agent.config.configChannel, { agent, mode: 'config' });
  }

  return async function handle(message: Message, sourceClient: Client): Promise<void> {
    // 봇 자신의 메시지 무시
    if (message.author.bot) return;

    const channelId = message.channelId;

    // 협력 채널 — 대표 봇(primaryClient)만 처리하여 중복 방지
    if (channelId === appCfg.collabChannel) {
      if (sourceClient.user?.id !== primaryClient.user?.id) return;
      // 유저 메시지를 히스토리에 추가
      history.addMessage(channelId, {
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.username,
        content: message.content,
      });
      const services = extractToolServices(message, appCfg.toolBots);
      await handleCollab(message, agents, appCfg.collabChannel, services);
      return;
    }

    // 개별/설정 채널
    const entry = channelMap.get(channelId);
    if (!entry) return;

    // 해당 채널 담당 에이전트의 봇인지 확인
    if (sourceClient.user?.id !== entry.agent.botUserId) return;

    // 명령어 처리 (!페르소나, !도움말 등)
    const trimmed = message.content.trim();
    const cmd = COMMANDS[trimmed];
    if (cmd) {
      await handleCommand(cmd, entry.agent, message);
      return;
    }

    // 태스크 목표 감지 (!목표 <goal> 또는 !task <goal>)
    const goalMatch = trimmed.match(/^(?:!목표|!task)\s+(.+)/s);
    if (goalMatch && entry.mode === 'chat') {
      const goal = goalMatch[1].trim();
      await entry.agent.startTaskGraph(message, goal);
      return;
    }

    // 유저 메시지를 히스토리에 추가 (설정 채널은 addMessage가 자동으로 무시)
    history.addMessage(channelId, {
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      content: message.content,
    });

    const services = extractToolServices(message, appCfg.toolBots);
    await entry.agent.respond(message, entry.mode, services);
  };
}
