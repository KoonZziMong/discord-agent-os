/**
 * history.ts — 인메모리 대화 히스토리 관리
 *
 * SQLite DB 없이 Discord API에서 직접 로드하여 메모리에 유지합니다.
 *
 * 기동 시: loadFromDiscord()로 채널별 최근 N개 로드
 * 수신 시: addMessage()로 리스트에 추가 (limit 초과 시 오래된 것 제거)
 * API 호출 시: getHistory()로 Claude 포맷 변환 반환
 *
 * 설정 채널은 히스토리 불필요 → loadFromDiscord() 호출 안 함
 * → addMessage() 호출 시 채널이 없으면 자동으로 무시됩니다.
 */
import type { TextChannel } from 'discord.js';

// ── 타입 ──────────────────────────────────────────────────

export interface StoredMessage {
  authorId: string;    // Discord User ID
  authorName: string;  // 표시 이름
  content: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChannelStore {
  messages: StoredMessage[];
  limit: number;
}

// ── 저장소 ────────────────────────────────────────────────

const channelStore = new Map<string, ChannelStore>();

// ── 공개 함수 ─────────────────────────────────────────────

/**
 * Discord API에서 채널의 최근 메시지를 로드합니다.
 * 봇 기동 시 채널별 1회 호출합니다.
 */
export async function loadFromDiscord(channel: TextChannel, limit: number): Promise<void> {
  const fetched = await channel.messages.fetch({ limit });

  // Discord는 최신순 반환 → 역순으로 정렬 (오래된 것부터)
  const ordered = [...fetched.values()].reverse();

  const messages: StoredMessage[] = ordered
    .filter((msg) => !msg.system && msg.content.trim().length > 0)
    .map((msg) => ({
      authorId: msg.author.id,
      authorName: msg.member?.displayName ?? msg.author.username,
      content: msg.content,
    }));

  channelStore.set(channel.id, { messages, limit });
  console.log(`  📜 [#${channel.name}] 히스토리 ${messages.length}개 로드`);
}

/**
 * 채널에 메시지를 추가합니다.
 * 채널이 초기화되지 않은 경우 기본 limit으로 자동 초기화합니다.
 * limit 초과 시 가장 오래된 메시지를 제거합니다.
 */
export function addMessage(channelId: string, msg: StoredMessage, defaultLimit = 20): void {
  let store = channelStore.get(channelId);
  if (!store) {
    store = { messages: [], limit: defaultLimit };
    channelStore.set(channelId, store);
  }

  store.messages.push(msg);
  if (store.messages.length > store.limit) {
    store.messages.shift();
  }
}

/**
 * 채널 히스토리를 Claude API 포맷으로 반환합니다.
 *
 * @param agentBotUserId  이 에이전트의 Discord Bot User ID
 * @param isCollab        협력 채널 여부
 *                        true  → 타인 메시지에 "[이름] " 프리픽스 추가
 *                        false → 원본 content 그대로
 *
 * 변환 규칙:
 *   authorId === agentBotUserId → role: "assistant"
 *   그 외                       → role: "user"
 *
 * Claude API는 user/assistant 교대를 요구하므로
 * 연속된 같은 role 메시지는 하나로 합칩니다.
 */
export function getHistory(
  channelId: string,
  agentBotUserId: string,
  isCollab: boolean,
): HistoryMessage[] {
  const store = channelStore.get(channelId);
  if (!store) return [];

  const raw: HistoryMessage[] = store.messages.map((msg) => {
    if (msg.authorId === agentBotUserId) {
      return { role: 'assistant' as const, content: msg.content };
    }
    const content = isCollab ? `[${msg.authorName}] ${msg.content}` : msg.content;
    return { role: 'user' as const, content };
  });

  const merged = mergeConsecutiveRoles(raw);

  // Anthropic API는 마지막 메시지가 반드시 user여야 합니다.
  // assistant로 끝나는 경우(봇이 자기 메시지에 응답하려는 경쟁 조건 등) 해당 메시지를 제거합니다.
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop();
  }

  return merged;
}

// ── 내부 헬퍼 ─────────────────────────────────────────────

/**
 * 연속된 같은 role의 메시지를 하나로 합칩니다.
 * (splitMessage로 나뉜 봇 응답, 연속 유저 메시지 등 대응)
 */
function mergeConsecutiveRoles(messages: HistoryMessage[]): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content;
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  return merged;
}
