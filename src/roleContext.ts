/**
 * roleContext.ts — 역할 채널 컨텍스트 캐시
 *
 * 봇 전용 핀에 "역할채널: {channelId}" 가 있으면 해당 채널의
 * 핀 메시지를 로드하여 system prompt에 주입합니다.
 *
 * 채널에 역할 설정이 없으면 역할 채널의 디폴트 봇 설정을 폴백으로 사용합니다.
 *
 * ## 역할 컨텍스트 로딩 순서 (Step 0 ~ 3)
 *
 * Step 0 — ROLE 카테고리의 'rule' 채널 (팀 공통 규약)
 *   역할·채널 관계없이 모든 에이전트에 항상 주입합니다.
 *   약한/강한 결합 인터페이스, 에스컬레이션 규칙 등 팀 전체 규약 정의.
 *
 * Step 1 — ROLE 카테고리 채널 (role/developer 등)
 *   모든 프로젝트에 공통 적용되는 글로벌 역할 정의.
 *   `/role init`으로 생성, `/role reset`으로 초기화.
 *
 * Step 2 — 현재 채널의 카테고리 안 "role" 채널 (프로젝트A/role)
 *   이 프로젝트(카테고리)에만 적용되는 커스텀 지침.
 *   직접 생성 후 핀 작성, 또는 회고를 통해 자동 제안됨.
 *
 * Step 3 — 현재 채널의 봇 멘션 핀 (<@botId> 형식)
 *   이 채널에만 적용되는 개별 설정. `/channel setup`으로 관리.
 *
 * 역할 레이어 우선순위 (기존):
 *   1. 채널 핀에 역할 설정 없음 → config.role의 디폴트 역할 채널 내용 주입
 *   2. 채널 핀 역할 = 디폴트 역할 → 디폴트 핀 + 채널 디테일 누적
 *   3. 채널 핀 역할 ≠ 디폴트 역할 → 채널 역할 핀으로 완전 대체
 *   4. 채널에 여러 역할 → 모두 누적 주입
 */

import type { Client, Guild } from 'discord.js';
import { getChannelContext, getContextItems, ensureLoaded } from './channelContext';

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
 * 역할명 → 채널ID 캐시를 무효화합니다. (역할 채널 구조 변경 시)
 */
export function invalidateRoleChannelIdCache(): void {
  roleChannelIdCache.clear();
}

/**
 * 현재 채널이 속한 카테고리 안의 "role" 채널 ID를 반환합니다. (Step 2)
 *
 * - 현재 채널의 parentId(카테고리)를 구함
 * - 같은 카테고리 안에서 이름이 "role"인 텍스트 채널을 찾아 반환
 * - ROLE 카테고리 자체에 속한 채널이면 null (step 1과 중복 방지)
 * - 결과는 `cat:{categoryId}` 키로 캐싱됩니다.
 */
export function getCategoryRoleChannelId(guild: Guild, currentChannelId: string): string | null {
  const currentChannel = guild.channels.cache.get(currentChannelId);
  if (!currentChannel || !currentChannel.parentId) return null;

  const categoryId = currentChannel.parentId;

  // 현재 채널이 ROLE 카테고리 소속이면 step 2 없음 (순환 방지)
  const roleCategory = guild.channels.cache.find(
    (c) => c.type === 4 /* GuildCategory */ && c.name.toLowerCase() === 'role',
  );
  if (roleCategory && categoryId === roleCategory.id) return null;

  const cacheKey = `cat:${categoryId}`;
  if (roleChannelIdCache.has(cacheKey)) return roleChannelIdCache.get(cacheKey)!;

  const roleChannel = guild.channels.cache.find(
    (c) => c.parentId === categoryId && c.type === 0 /* GuildText */ && c.name.toLowerCase() === 'role',
  );

  const result = roleChannel?.id ?? null;
  if (result) roleChannelIdCache.set(cacheKey, result);
  return result;
}

/**
 * '역할' 카테고리에서 roleName에 해당하는 채널 ID를 반환합니다.
 * 결과는 메모리에 캐싱됩니다.
 */
export function getRoleChannelId(guild: Guild, roleName: string): string | null {
  if (roleChannelIdCache.has(roleName)) return roleChannelIdCache.get(roleName)!;

  const category = guild.channels.cache.find(
    (c) => c.type === 4 /* GuildCategory */ && c.name.toLowerCase() === 'role',
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
 * ROLE 카테고리 내 모든 역할 채널 이름을 반환합니다. (오케스트레이터용)
 */
function getAllRoleNames(guild: Guild): string[] {
  const category = guild.channels.cache.find(
    (c) => c.type === 4 /* GuildCategory */ && c.name.toLowerCase() === 'role',
  );
  if (!category) return [];
  return [...guild.channels.cache
    .filter((c) => c.parentId === category.id && c.type === 0 /* GuildText */)
    .values()]
    .map((c) => c.name);
}

/**
 * 지정된 채널의 컨텍스트에서 역할 내용을 조립하여 반환합니다.
 *
 * 모든 채널(현재 채널, role 채널, rule 채널)에 getContextItems()를 동일하게 적용합니다.
 *
 * ## 로딩 순서
 *   Step 0: ROLE 카테고리 'rule' 채널 (팀 공통 규약 — 항상 주입)
 *   Step 1: ROLE 카테고리 역할 채널 (글로벌 역할 정의)
 *            오케스트레이터는 모든 역할 채널을 로드합니다.
 *   Step 2: 현재 채널 카테고리의 "role" 채널 (프로젝트 커스텀 지침)
 *
 * @param client        Discord Client
 * @param botId         이 봇의 Discord user ID
 * @param channelId     현재 응답 채널 ID
 * @param defaultRole   config.role (봇의 기본 역할명, 채널 핀에 역할 없을 때 폴백)
 * @param guild         Guild (역할 채널 탐색용)
 * @param isOrchestrator 오케스트레이터 여부 (true면 Step 1에서 전체 역할 로드)
 */
export async function getRoleContent(
  client: Client,
  botId: string,
  channelId: string,
  defaultRole?: string,
  guild?: Guild,
  isOrchestrator = false,
): Promise<string> {
  const sections: string[] = [];

  // Step 0: rule 채널 (모든 에이전트 공통, 항상 주입)
  if (guild) {
    const ruleChannelId = getRoleChannelId(guild, 'rule');
    if (ruleChannelId) {
      await ensureLoaded(client, ruleChannelId);
      const items = getContextItems(ruleChannelId, botId)
        .filter((item) => !item.trimStart().startsWith('[GEMMA_ROUTER]'));
      if (items.length > 0) sections.push(`## 팀 공통 규칙\n${items.join('\n\n---\n\n')}`);
    }
  }

  // 현재 채널 봇 전용 핀에서 역할 목록 파싱 (Step 1 대상 결정용)
  const ctx = getChannelContext(channelId);
  const botPin = ctx.pins.find((pin) => {
    const m = pin.trimStart().match(/^<@!?(\d+)>/);
    return m && m[1] === botId;
  });
  const channelRoles = botPin ? parseAgentRoles(botPin) : [];

  // Step 1: ROLE 카테고리 역할 채널
  if (guild) {
    let roleNames: string[];
    if (isOrchestrator) {
      roleNames = getAllRoleNames(guild).filter((n) => n !== 'rule');
    } else if (channelRoles.length > 0) {
      roleNames = channelRoles;
    } else if (defaultRole) {
      roleNames = [defaultRole];
    } else {
      roleNames = [];
    }

    for (const roleName of roleNames) {
      // 핀에 역할채널 ID가 직접 명시된 경우 우선 사용, 없으면 역할명으로 탐색
      let roleChannelId = botPin ? parseRoleChannelId(botPin) : null;
      if (!roleChannelId) roleChannelId = getRoleChannelId(guild, roleName);
      if (!roleChannelId) continue;

      await ensureLoaded(client, roleChannelId);
      const items = getContextItems(roleChannelId, botId);
      if (items.length > 0) {
        const label = roleNames.length > 1 ? `## 역할: ${roleName}\n` : '';
        sections.push(label + items.join('\n\n---\n\n'));
      }
    }
  }

  // Step 2: 현재 채널 카테고리의 "role" 채널 (프로젝트 커스텀 지침)
  if (guild) {
    const catRoleChannelId = getCategoryRoleChannelId(guild, channelId);
    if (catRoleChannelId) {
      await ensureLoaded(client, catRoleChannelId);
      const items = getContextItems(catRoleChannelId, botId);
      if (items.length > 0) sections.push(`## 프로젝트 커스텀 지시\n${items.join('\n\n---\n\n')}`);
    }
  }

  return sections.join('\n\n---\n\n');
}
