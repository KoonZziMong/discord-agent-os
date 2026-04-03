/**
 * roleContext.ts — 역할 채널 컨텍스트 캐시
 *
 * 봇 전용 핀에 "역할채널: {channelId}" 가 있으면 해당 채널의
 * 핀 메시지를 로드하여 system prompt에 주입합니다.
 *
 * 사용 방법:
 *   핀 메시지 예시:
 *     <@1488036292280320140>
 *     역할채널: 1234567890123456789
 *     기타 봇별 지시사항...
 *
 * 동작:
 *   - 봇이 응답할 채널의 컨텍스트에서 자신의 전용 핀을 찾습니다
 *   - 해당 핀 안에 "역할채널: {id}" 가 있으면 그 채널의 핀을 로드합니다
 *   - 역할 채널 내용은 캐시됩니다 (ChannelPinsUpdate 시 무효화)
 */

import type { Client, TextChannel } from 'discord.js';
import { getChannelContext } from './channelContext';

// roleChannelId → 역할 채널 핀 전체 내용
const cache = new Map<string, string>();

/**
 * 핀 내용에서 "역할채널: {channelId}" 패턴으로 역할 채널 ID를 추출합니다.
 */
export function parseRoleChannelId(pinContent: string): string | null {
  const match = pinContent.match(/역할채널:\s*(\d+)/);
  return match ? match[1] : null;
}

/**
 * 역할 채널 ID가 캐시에 존재하는지 확인합니다. (갱신 필요 여부 판단용)
 */
export function isRoleChannelCached(roleChannelId: string): boolean {
  return cache.has(roleChannelId);
}

/**
 * 역할 채널 캐시를 무효화합니다.
 * 역할 채널의 핀이 변경될 때 index.ts에서 호출합니다.
 */
export function invalidateRoleCache(roleChannelId: string): void {
  cache.delete(roleChannelId);
}

/**
 * 역할 채널의 핀 메시지를 로드하여 캐시에 저장하고 반환합니다.
 * 캐시가 있으면 캐시를 반환합니다.
 */
export async function fetchRoleContent(client: Client, roleChannelId: string): Promise<string> {
  if (cache.has(roleChannelId)) return cache.get(roleChannelId)!;

  try {
    const channel = await client.channels.fetch(roleChannelId) as TextChannel;
    if (!channel || !('messages' in channel)) return '';

    const pinned = await channel.messages.fetchPinned();
    const content = [...pinned.values()]
      .reverse()
      .filter((m) => m.content.trim().length > 0)
      .map((m) => m.content)
      .join('\n\n---\n\n');

    cache.set(roleChannelId, content);
    console.log(`[roleContext] 역할 채널 로드 완료 (${roleChannelId}, ${content.length}자)`);
    return content;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[roleContext] 역할 채널 로드 실패 (${roleChannelId}): ${msg}`);
    return '';
  }
}

/**
 * 지정된 채널의 컨텍스트에서 봇 전용 핀을 찾아 역할 내용을 반환합니다.
 *
 * @param client     Discord Client (채널 조회용)
 * @param botId      이 봇의 Discord user ID
 * @param channelId  현재 응답 채널 ID — 이 채널의 핀에서 역할채널 참조를 탐색
 */
export async function getRoleContent(
  client: Client,
  botId: string,
  channelId: string,
): Promise<string> {
  const ctx = getChannelContext(channelId);

  // 이 봇 전용 핀 찾기 (<@botId> 또는 <@!botId> 로 시작)
  const botPin = ctx.pins.find((pin) => {
    const m = pin.trimStart().match(/^<@!?(\d+)>/);
    return m && m[1] === botId;
  });

  if (!botPin) return '';

  const roleChannelId = parseRoleChannelId(botPin);
  if (!roleChannelId) return '';

  return fetchRoleContent(client, roleChannelId);
}
