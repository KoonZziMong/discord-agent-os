/**
 * collaboration.ts — 협력 채널 오케스트레이터
 *
 * 협력 채널(#협력-찌몽아루센세)에서 여러 에이전트가 순차적으로 응답하는 흐름을 관리합니다.
 *
 * 멘션 기반 라우팅:
 *   @찌몽              → 찌몽만 응답
 *   @찌몽 @아루        → 찌몽 → 아루 순서로 응답
 *   멘션 없음          → 찌몽 → 아루 → 센세 전체 순차 응답
 *
 * 히스토리 흐름:
 *   유저 메시지     : router.ts에서 history.addMessage() 완료 후 호출됨
 *   에이전트 응답   : 각 에이전트 응답 후 history.addMessage() 추가
 *   → 다음 에이전트는 앞선 응답이 포함된 히스토리를 자동으로 참조합니다.
 */
import { Message, TextChannel } from 'discord.js';
import type { Agent } from './agent';
import * as history from './history';
import { sendSplit, delay, keepTyping } from './utils';

export async function handle(
  message: Message,
  agents: Agent[],
  collabChannelId: string,
  toolServices: string[] = [],
): Promise<void> {
  // 에이전트 봇 ID 기준으로 대상 필터링 (툴봇 멘션은 toolServices로 분리됨)
  const agentUserIds = agents.map((a) => a.botUserId);
  const mentionedIds = [...message.mentions.users.keys()].filter((id) =>
    agentUserIds.includes(id),
  );

  const targetAgents =
    mentionedIds.length > 0
      ? agents.filter((a) => mentionedIds.includes(a.botUserId))
      : agents;

  if (targetAgents.length === 0) return;

  const order = targetAgents.map((a) => a.name).join(' → ');
  console.log(`[협력] ${order} (${message.author.username})`);
  const collabStart = Date.now();

  for (let i = 0; i < targetAgents.length; i++) {
    const agent = targetAgents[i];

    const agentChannel = await agent.botClient.channels.fetch(collabChannelId) as TextChannel;

    console.log(`[협력] ${agent.name} 응답 중...`);
    const agentStart = Date.now();

    const stopTyping = keepTyping(agentChannel);
    try {
      // 히스토리에는 유저 메시지 + 앞선 에이전트 응답이 이미 포함되어 있음
      const responseText = await agent.respondInCollab(collabChannelId, toolServices);

      // 이 에이전트 응답을 히스토리에 추가 → 다음 에이전트가 참조
      history.addMessage(collabChannelId, {
        authorId: agent.botUserId,
        authorName: agent.name,
        content: responseText,
      });

      stopTyping();
      await sendSplit(agentChannel, responseText);
      console.log(`[협력] ${agent.name} 완료 (${((Date.now() - agentStart) / 1000).toFixed(1)}s)`);
    } catch (err: unknown) {
      stopTyping();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[협력] ${agent.name} 오류: ${msg.slice(0, 80)}`);
      await agentChannel.send(`❌ ${agent.name} 응답 오류: ${msg.slice(0, 100)}`).catch(() => {});
    }

    if (i < targetAgents.length - 1) {
      await delay(1000);
    }
  }

  console.log(`[협력] 전체 완료 (${((Date.now() - collabStart) / 1000).toFixed(1)}s)`);
}
