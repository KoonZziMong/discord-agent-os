/**
 * channelContext.ts — 채널 컨텍스트 인메모리 캐시
 *
 * Discord 채널의 토픽과 핀 메시지를 메모리에 유지합니다.
 * 봇 기동 시 전체 채널을 로드하고, 이벤트로 갱신합니다.
 *
 * 용도:
 *   - 채널 토픽   : 채널에 대한 짧은 메타 정보
 *   - 핀 메시지   : CLAUDE.md처럼 LLM system prompt에 주입할 컨텍스트/지시사항
 *
 * 사용 방법:
 *   - 기동 시     : loadChannelContext(channel) 호출
 *   - LLM 호출 시 : getChannelContext(channelId) → topic + pins 반환
 *   - 이벤트 갱신 : updateTopic(), refreshPins()
 */

import type { TextChannel } from 'discord.js';

export interface ChannelContext {
  topic: string;       // 채널 토픽 (없으면 빈 문자열)
  pins: string[];      // 핀된 메시지 본문 목록 (오래된 것부터)
}

const cache = new Map<string, ChannelContext>();

/**
 * 채널 토픽과 핀 메시지를 로드하여 캐시에 저장합니다.
 * 기동 시 채널별 1회 호출합니다.
 */
export async function loadChannelContext(channel: TextChannel): Promise<void> {
  const topic = channel.topic ?? '';

  let pins: string[] = [];
  try {
    const pinned = await channel.messages.fetchPinned();
    // Discord는 최신순 반환 → 역순(오래된 것부터)
    pins = [...pinned.values()]
      .reverse()
      .filter((m) => m.content.trim().length > 0)
      .map((m) => m.content);
  } catch {
    // 핀 조회 실패 시 빈 배열 유지
  }

  cache.set(channel.id, { topic, pins });
}

/**
 * 캐시된 채널 컨텍스트를 반환합니다.
 * 캐시가 없으면 빈 컨텍스트를 반환합니다.
 */
export function getChannelContext(channelId: string): ChannelContext {
  return cache.get(channelId) ?? { topic: '', pins: [] };
}

/**
 * 채널 토픽을 갱신합니다. (ChannelUpdate 이벤트 시 호출)
 */
export function updateTopic(channelId: string, newTopic: string): void {
  const existing = cache.get(channelId);
  if (existing) {
    existing.topic = newTopic;
  } else {
    cache.set(channelId, { topic: newTopic, pins: [] });
  }
}

/**
 * 채널 핀 목록을 다시 로드합니다. (ChannelPinsUpdate, MessageUpdate 이벤트 시 호출)
 */
export async function refreshPins(channel: TextChannel): Promise<void> {
  try {
    const pinned = await channel.messages.fetchPinned();
    const pins = [...pinned.values()]
      .reverse()
      .filter((m) => m.content.trim().length > 0)
      .map((m) => m.content);

    const existing = cache.get(channel.id);
    if (existing) {
      existing.pins = pins;
    } else {
      cache.set(channel.id, { topic: channel.topic ?? '', pins });
    }
  } catch {
    // 갱신 실패 시 기존 캐시 유지
  }
}

/**
 * 컨텍스트를 system prompt에 주입할 텍스트로 변환합니다.
 * 토픽과 핀이 모두 없으면 빈 문자열을 반환합니다.
 */
export function buildContextBlock(ctx: ChannelContext): string {
  const parts: string[] = [];

  if (ctx.topic) {
    parts.push(`## 채널 토픽\n${ctx.topic}`);
  }

  if (ctx.pins.length > 0) {
    parts.push(`## 채널 지시사항\n${ctx.pins.join('\n\n---\n\n')}`);
  }

  if (parts.length === 0) return '';

  return '\n\n---\n' + parts.join('\n\n');
}
