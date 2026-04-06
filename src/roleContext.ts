/**
 * roleContext.ts — 역할 채널 컨텍스트 캐시
 *
 * 봇 전용 핀에 "역할채널: {channelId}" 가 있으면 해당 채널의
 * 핀 메시지를 로드하여 system prompt에 주입합니다.
 *
 * 채널에 역할 설정이 없으면 역할 채널의 디폴트 봇 설정을 폴백으로 사용합니다.
 *
 * 역할 레이어 우선순위:
 *   1. 채널 핀에 역할 설정 없음 → config.role의 디폴트 역할 채널 내용 주입
 *   2. 채널 핀 역할 = 디폴트 역할 → 디폴트 핀 + 채널 디테일 누적
 *   3. 채널 핀 역할 ≠ 디폴트 역할 → 채널 역할 핀으로 완전 대체
 *   4. 채널에 여러 역할 → 모두 누적 주입
 */

import type { Client, Guild, TextChannel } from 'discord.js';
import { getChannelContext } from './channelContext';

// roleChannelId → 역할 채널 핀 전체 내용
const cache = new Map<string, string>();

// roleName → roleChannelId (길드 채널 목록에서 '역할' 카테고리 기준)
const roleChannelIdCache = new Map<string, string>();

/**
 * 핀 내용에서 "역할채널: {channelId}" 패턴으로 역할 채널 ID를 추출합니다.
 */
export function parseRoleChannelId(pinContent: string): string | null {
  const match = pinContent.match(/역할채널:\s*(\d+)/);
  return match ? match[1] : null;
}

/**
 * 핀 내용에서 "역할: {roleName}" 패턴으로 하네스 역할명을 추출합니다.
 * 여러 역할이 있을 경우 모두 반환합니다.
 * 예: "역할: orchestrator\n역할: developer" → ["orchestrator", "developer"]
 */
export function parseAgentRole(pinContent: string): string | null {
  const match = pinContent.match(/역할:\s*(\S+)/);
  return match ? match[1] : null;
}

export function parseAgentRoles(pinContent: string): string[] {
  const matches = [...pinContent.matchAll(/역할:\s*(\S+)/g)];
  return matches.map((m) => m[1]);
}

/**
 * 역할 채널 핀에서 CmdBot 전용 핀의 디폴트 봇 ID 목록을 파싱합니다.
 * 형식: "<@CmdBotId>\ndefault: <@botId1> <@botId2>"
 * → ["botId1", "botId2"]
 */
export function parseDefaultBots(pinContent: string): string[] {
  const defaultLine = pinContent.match(/default:\s*((?:<@!?\d+>\s*)+)/);
  if (!defaultLine) return [];
  const mentions = [...defaultLine[1].matchAll(/<@!?(\d+)>/g)];
  return mentions.map((m) => m[1]);
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
 * 역할명 → 채널ID 캐시를 무효화합니다. (역할 채널 구조 변경 시)
 */
export function invalidateRoleChannelIdCache(): void {
  roleChannelIdCache.clear();
}

/**
 * '역할' 카테고리에서 roleName에 해당하는 채널 ID를 반환합니다.
 * 결과는 메모리에 캐싱됩니다.
 */
export function getRoleChannelId(guild: Guild, roleName: string): string | null {
  if (roleChannelIdCache.has(roleName)) return roleChannelIdCache.get(roleName)!;

  const category = guild.channels.cache.find(
    (c) => c.type === 4 /* GuildCategory */ && c.name === '역할',
  );
  if (!category) return null;

  const ch = guild.channels.cache.find(
    (c) => c.parentId === category.id && c.type === 0 /* GuildText */ && c.name === roleName,
  );
  if (!ch) return null;

  roleChannelIdCache.set(roleName, ch.id);
  return ch.id;
}

/**
 * 역할 채널의 핀 메시지를 로드하여 캐시에 저장하고 반환합니다.
 * 캐시가 있으면 캐시를 반환합니다.
 * CmdBot 전용 핀(<@CmdBotId>로 시작)은 제외하고 역할 내용만 반환합니다.
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
      // CmdBot 전용 핀(default: 설정 핀)은 역할 내용에서 제외
      .filter((m) => !m.content.trimStart().match(/^<@!?\d+>\s*\ndefault:/))
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
 * 역할명으로 직접 역할 채널 내용을 반환합니다.
 * guild가 있을 때 사용 (디폴트 폴백 용도).
 */
export async function fetchRoleContentByName(
  client: Client,
  guild: Guild,
  roleName: string,
): Promise<string> {
  const channelId = getRoleChannelId(guild, roleName);
  if (!channelId) return '';
  return fetchRoleContent(client, channelId);
}

/**
 * 역할 채널의 CmdBot 핀에서 디폴트 봇 목록을 반환합니다.
 * @param cmdBotId CmdBot의 Discord User ID
 */
export async function getDefaultBotsForRole(
  client: Client,
  guild: Guild,
  roleName: string,
  cmdBotId: string,
): Promise<string[]> {
  const channelId = getRoleChannelId(guild, roleName);
  if (!channelId) return [];

  try {
    const channel = await client.channels.fetch(channelId) as TextChannel;
    if (!channel || !('messages' in channel)) return [];

    const pinned = await channel.messages.fetchPinned();
    for (const msg of pinned.values()) {
      const firstLine = msg.content.trimStart().match(/^<@!?(\d+)>/);
      if (firstLine && firstLine[1] === cmdBotId) {
        return parseDefaultBots(msg.content);
      }
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 지정된 채널의 컨텍스트에서 봇 전용 핀을 찾아 역할 내용을 반환합니다.
 *
 * 역할 레이어 로직:
 *   - 채널 핀에 역할 설정 없음 → defaultRole의 역할 채널 내용 반환
 *   - 채널 핀 역할 = defaultRole → 역할 채널 내용 + 채널 디테일 누적
 *   - 채널 핀 역할 ≠ defaultRole → 채널 역할 채널 내용으로 대체
 *   - 여러 역할 → 모두 누적
 *
 * @param client      Discord Client
 * @param botId       이 봇의 Discord user ID
 * @param channelId   현재 응답 채널 ID
 * @param defaultRole config.role (봇의 기본 역할명)
 * @param guild       Guild (역할 채널 탐색용, 없으면 폴백 불가)
 */
export async function getRoleContent(
  client: Client,
  botId: string,
  channelId: string,
  defaultRole?: string,
  guild?: Guild,
): Promise<string> {
  const ctx = getChannelContext(channelId);

  // 이 봇 전용 핀 찾기 (<@botId> 또는 <@!botId> 로 시작)
  const botPin = ctx.pins.find((pin) => {
    const m = pin.trimStart().match(/^<@!?(\d+)>/);
    return m && m[1] === botId;
  });

  // 채널 핀에서 역할 목록 파싱
  const channelRoles = botPin ? parseAgentRoles(botPin) : [];

  // 채널 핀의 추가 디테일 (역할채널/역할 라인 제외한 나머지)
  const channelDetail = botPin
    ? botPin
        .split('\n')
        .filter((line) => !line.match(/^<@!?\d+>/) && !line.match(/^역할(채널)?:/) )
        .join('\n')
        .trim()
    : '';

  // 케이스 1: 채널에 역할 설정 없음 → 디폴트 역할 폴백
  if (channelRoles.length === 0) {
    if (!defaultRole || !guild) return '';
    const content = await fetchRoleContentByName(client, guild, defaultRole);
    return content;
  }

  // 케이스 2~4: 채널에 역할 설정 있음
  const sections: string[] = [];

  for (const roleName of channelRoles) {
    // 역할 채널 ID 직접 참조가 있으면 우선 사용, 없으면 역할명으로 탐색
    let roleChannelId = botPin ? parseRoleChannelId(botPin) : null;
    if (!roleChannelId && guild) {
      roleChannelId = getRoleChannelId(guild, roleName);
    }

    const roleContent = roleChannelId
      ? await fetchRoleContent(client, roleChannelId)
      : guild ? await fetchRoleContentByName(client, guild, roleName) : '';

    if (roleContent) {
      // 디폴트 역할과 같으면 누적, 다르면 대체 (결과는 동일하게 sections에 추가)
      const label = channelRoles.length > 1 ? `## 역할: ${roleName}\n` : '';
      sections.push(label + roleContent);
    }
  }

  // 채널 디테일이 있으면 마지막에 추가
  if (channelDetail) {
    sections.push(`## 채널 추가 지시\n${channelDetail}`);
  }

  return sections.join('\n\n---\n\n');
}
