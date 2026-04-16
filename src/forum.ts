/**
 * forum.ts — 포럼 채널 생성 및 목표 게시물(thread) CRUD 기능
 *
 * Discord 포럼 채널을 활용하여 목표(goal)를 게시물(thread)로 관리합니다.
 * - 포럼 채널 생성: createForumChannel()
 * - 목표 thread 생성: createGoalThread()
 * - thread에 진행 메시지 추가: appendToThread()
 * - thread 조회: findGoalThread()
 */

import {
  Guild,
  ChannelType,
  ForumChannel,
  ThreadChannel,
  PermissionFlagsBits,
  CategoryChannel,
  ForumLayoutType,
} from 'discord.js';

/** 포럼 채널 기본 이름 */
export const FORUM_CHANNEL_NAME = 'goals';

/** 포럼 채널 생성 옵션 */
export interface CreateForumChannelOptions {
  /** 채널 이름 (기본값: 'goals') */
  name?: string;
  /** 채널 설명 */
  topic?: string;
  /** 채널을 배치할 카테고리 ID (없으면 최상위 생성) */
  categoryId?: string;
  /** 슬로우 모드(초) */
  rateLimitPerUser?: number;
}

/** 목표 thread 생성 옵션 */
export interface CreateGoalThreadOptions {
  /** 목표 요약 (thread 제목으로 사용) */
  goalSummary: string;
  /** 목표 상세 내용 */
  goalDetail: string;
  /** 작업 시작 일시 */
  startedAt?: Date | string;
  /** 요청자 Discord ID 또는 표시 이름 */
  requestedBy?: string;
  /** 태그 이름 목록 (포럼 채널의 가용 태그 중 일치하는 것을 적용) */
  tagNames?: string[];
}

/**
 * 포럼 채널 생성
 *
 * 지정한 Guild에 포럼 타입 채널을 생성합니다.
 * 이미 같은 이름의 포럼 채널이 존재하면 해당 채널을 반환합니다.
 */
export async function createForumChannel(
  guild: Guild,
  options: CreateForumChannelOptions = {},
): Promise<ForumChannel> {
  const channelName = options.name ?? FORUM_CHANNEL_NAME;
  const topic = options.topic ?? '목표(Goal) 추적 및 작업 문서화 채널입니다.';

  // 이미 존재하는 포럼 채널 확인 (categoryId가 있으면 해당 카테고리 내에서만 탐색)
  const existing = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildForum &&
      ch.name === channelName &&
      (options.categoryId ? ch.parentId === options.categoryId : true),
  ) as ForumChannel | undefined;
  if (existing) return existing;

  // 카테고리 처리
  let parent: CategoryChannel | null = null;
  if (options.categoryId) {
    const fetched = guild.channels.cache.get(options.categoryId);
    if (fetched?.type === ChannelType.GuildCategory) {
      parent = fetched as CategoryChannel;
    }
  }

  // 포럼 채널 생성
  const forumChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildForum,
    topic,
    parent: parent ?? undefined,
    rateLimitPerUser: options.rateLimitPerUser ?? 0,
    defaultForumLayout: ForumLayoutType.ListView,
    availableTags: [
      { name: '🔵 진행중', moderated: false },
      { name: '✅ 완료', moderated: false },
      { name: '❌ 실패', moderated: false },
      { name: '⏸️ 보류', moderated: false },
    ],
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionFlagsBits.SendMessages],
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      },
    ],
  });

  return forumChannel as ForumChannel;
}

/**
 * 목표(goal)에 대한 포럼 thread(게시물) 생성
 *
 * 포럼 채널에 새 thread를 생성하고 목표 상세 정보를 첫 메시지로 작성합니다.
 */
export async function createGoalThread(
  forumChannel: ForumChannel,
  options: CreateGoalThreadOptions,
): Promise<ThreadChannel> {
  const { goalSummary, goalDetail, startedAt, requestedBy, tagNames = [] } = options;

  // 날짜 포맷
  const dateStr = formatDate(startedAt ? new Date(startedAt) : new Date());

  // 첫 메시지 본문 구성
  const content = buildGoalMessage({ goalSummary, goalDetail, startedAt: dateStr, requestedBy });

  // 태그 매칭 (포럼 채널의 가용 태그 중 이름이 일치하는 것)
  const appliedTagIds = forumChannel.availableTags
    .filter((tag) => tagNames.includes(tag.name))
    .map((tag) => tag.id);

  // 기본 태그 '🔵 진행중' 자동 적용
  const defaultTag = forumChannel.availableTags.find((t) => t.name === '🔵 진행중');
  if (defaultTag && !appliedTagIds.includes(defaultTag.id)) {
    appliedTagIds.unshift(defaultTag.id);
  }

  // thread 생성
  const thread = await forumChannel.threads.create({
    name: goalSummary.slice(0, 100), // Discord 제한: 최대 100자
    message: { content },
    appliedTags: appliedTagIds,
  });

  return thread;
}

/**
 * 기존 thread에 진행 메시지 추가 (append)
 *
 * 오케스트레이터가 작업 진행 중에 상태 업데이트·결과를 해당 thread에 남깁니다.
 */
export async function appendToThread(
  thread: ThreadChannel,
  content: string,
): Promise<import('discord.js').Message> {
  // thread가 보관처리(archived)된 경우 재활성화
  if (thread.archived) {
    await thread.setArchived(false);
  }
  return thread.send(content);
}

/**
 * goalId(thread ID)로 포럼 채널에서 thread 조회
 */
export async function findGoalThread(
  forumChannel: ForumChannel,
  threadId: string,
): Promise<ThreadChannel | null> {
  // 활성 thread 캐시에서 검색
  const active = forumChannel.threads.cache.get(threadId);
  if (active) return active as ThreadChannel;

  // Discord API로 활성 thread 목록 갱신 후 재검색
  const fetched = await forumChannel.threads.fetchActive();
  const found = fetched.threads.get(threadId);
  if (found) return found as ThreadChannel;

  // 보관된 thread에서도 검색
  const archived = await forumChannel.threads.fetchArchived({ limit: 100 });
  return (archived.threads.get(threadId) as ThreadChannel) ?? null;
}

// ── 내부 유틸 ────────────────────────────────────────────────────────────────

/** 목표 게시물 본문 메시지 생성 */
function buildGoalMessage(params: {
  goalSummary: string;
  goalDetail: string;
  startedAt: string;
  requestedBy?: string;
}): string {
  const lines: string[] = [
    `## 🎯 ${params.goalSummary}`,
    '',
    '### 📋 상세 내용',
    params.goalDetail,
    '',
    '---',
    `📅 **수행 일시:** ${params.startedAt}`,
  ];
  if (params.requestedBy) {
    lines.push(`👤 **요청자:** ${params.requestedBy}`);
  }
  lines.push('', '> _이 게시물은 DiscordAgentOS가 자동으로 생성했습니다._');
  return lines.join('\n');
}

/** Date → 한국어 포맷 (예: 2025. 01. 23. 14:30:00) */
function formatDate(date: Date): string {
  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}
