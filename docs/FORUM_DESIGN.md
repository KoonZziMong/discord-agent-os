# Discord Forum 채널 설계 문서

> **문서 목적:** DiscordAgentOS에서 사용할 Forum 채널의 네이밍, 게시물 구조, 태그 체계, 업데이트 포맷을 정의합니다.

---

## 1. 포럼 채널 네이밍 비교 분석

### 후보 목록

| 후보 | 직관성 | 에이전트 적합성 | Discord 친화성 | 충돌 위험 | 평가 |
|------|--------|----------------|---------------|-----------|------|
| `goals` | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 없음 | ✅ **권장** |
| `missions` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | 없음 | 차선책 |
| `tasks` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | 없음 | 차선책 |
| `logs` | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | 없음 | 보통 |
| `journal` | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | 없음 | 부적합 |
| `worklog` | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | 없음 | 부적합 |
| `docs` | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | 없음 | 부적합 |
| `threads` | ⭐⭐ | ⭐⭐ | ⭐ | ⚠️ Discord 내부 용어 | ❌ 금지 |
| `goles` | ⭐ | ⭐ | ⭐ | — | ❌ 오타 |

### 권장 네이밍: `goals`

**선택 이유:**
- **목적 명확성:** 오케스트레이터가 수행하는 단위가 "목표(goal)" 이므로 채널명과 개념이 1:1 대응
- **에이전트 친화성:** `goalId` 필드명과 자연스럽게 연결됨 (예: `goals` 채널의 `#a0cf1e0c` 스레드)
- **직관성:** 외부 사용자·개발자가 채널 목적을 즉시 이해 가능
- **충돌 없음:** Discord 예약어·내부 용어와 겹치지 않음

---

## 2. 포럼 채널 게시물(Thread) 구조 설계

### 2-1. 게시물 제목 템플릿

```
[{goalId 앞 8자}] {목표 한줄 요약}
```

**예시:**
```
[a0cf1e0c] 사용자 로그인 기능 구현
[3f2b9d1a] 데이터베이스 스키마 마이그레이션
```

**규칙:**
- `goalId`는 UUID 앞 8자리만 사용 (가독성)
- 요약은 40자 이내 권장
- 언어: 요청 언어 따름 (기본 한국어)

---

### 2-2. 게시물 본문 템플릿 (최초 생성 시)

```markdown
## 🎯 목표
{사용자가 전달한 goal 전체 내용}

## 📋 작업 계획
{orchestrator가 분해한 태스크 목록 — 사이클 시작 후 업데이트}

- [ ] T1: {태스크 설명} → {담당 에이전트}
- [ ] T2: {태스크 설명} → {담당 에이전트}
- [ ] T3: {태스크 설명} → {담당 에이전트}

## 🔄 진행 상황

| 태스크 ID | 담당 에이전트 | 상태 | 요약 |
|-----------|--------------|------|------|
| T1 | researcher | 🟡 in-progress | 조사 중 |
| T2 | developer | ⚪ pending | 대기 |

## 📝 결정 사항 및 메모
{추가 컨텍스트, 아키텍처 결정, 주의사항 등}

---
> 🤖 *cycleId: `{cycleId}`*
> 📅 *생성: {ISO 8601 timestamp}*
> 🔁 *최종 업데이트: {ISO 8601 timestamp}*
```

---

### 2-3. 태그(Tag) 구성

Discord Forum 채널의 `availableTags`로 사전 등록할 태그 목록:

| 태그명 | 이모지 | Discord 색상 | 의미 | 전환 조건 |
|--------|--------|-------------|------|-----------|
| `pending` | ⚪ | 기본(회색) | 사이클 시작 대기 | 초기 생성 시 |
| `in-progress` | 🟡 | 노랑 | 사이클 진행 중 | orchestrator가 작업 분배 시작 시 |
| `blocked` | 🔴 | 빨강 | 블로킹 상태 | ESCALATE 발생 또는 BLOCKED 보고 시 |
| `done` | 🟢 | 초록 | 목표 완료 | 모든 태스크 APPROVED 시 |
| `failed` | 🟠 | 주황 | 실패/중단 | 복구 불가 FAILED 또는 timeout 시 |

**태그 전환 규칙:**
- 하나의 게시물에 **태그 1개만** 적용 (상태 명확성 유지)
- 태그 변경은 orchestrator가 직접 수행
- `blocked` → `in-progress` 재전환: 블로킹 해소 후 orchestrator가 수동 처리

---

### 2-4. 오케스트레이터 업데이트 포맷

사이클 진행 중 orchestrator가 Thread 내 **후속 메시지**로 상태를 업데이트합니다.

#### 태스크 할당 시 (TASK_ASSIGN)
```markdown
### 📤 태스크 할당 — Turn {turn}
**시각:** {timestamp}
**대상:** @{에이전트명}
**태스크:** {taskId} — {태스크 한줄 설명}
```

#### 태스크 결과 수신 시 (TASK_RESULT)
```markdown
### 📥 태스크 완료 — Turn {turn}
**시각:** {timestamp}
**태스크:** {taskId}
**담당:** {에이전트명}
**상태:** ✅ APPROVED | ❌ FAILED | 🚫 BLOCKED
**요약:** {summary}

{detail — 선택적, FAILED/BLOCKED 시 필수}
```

#### 에스컬레이션 시 (ESCALATE)
```markdown
### ⚠️ 에스컬레이션 — Turn {turn}
**시각:** {timestamp}
**발생 에이전트:** {에이전트명}
**사유:** {에스컬레이션 사유}
**조치:** {orchestrator 조치 내용}
```

#### 사이클 종료 시
```markdown
### 🏁 사이클 종료 — {COMPLETED | FAILED | TIMEOUT}
**시각:** {timestamp}
**총 Turn:** {n}
**결과 요약:** {전체 목표 달성 여부 및 결과 요약}
```

---

## 3. Discord.js v14 구현 참고

> **검증 환경:** discord.js v14.25.1 (2026-04-08)

### Discord API 권한 요약

| 권한 | PermissionFlagsBits 키 | 용도 |
|------|------------------------|------|
| `ViewChannel` | `ViewChannel` | 채널 읽기 (기본) |
| `ManageChannels` | `ManageChannels` | Forum 채널 생성/수정 |
| `ManageThreads` | `ManageThreads` | 태그 변경, 스레드 잠금/삭제 |
| `CreatePublicThreads` | `CreatePublicThreads` | 게시물(thread) 생성 |
| `SendMessagesInThreads` | `SendMessagesInThreads` | 스레드 내 메시지 전송 |
| `ReadMessageHistory` | `ReadMessageHistory` | 기존 메시지 읽기 |

**최소 필요 권한 (봇 기준):** `ViewChannel` + `CreatePublicThreads` + `SendMessagesInThreads` + `ManageThreads`

---

### Forum 채널 타입
```typescript
// ⚠️ discord.js v14에서 실제 export 이름은 ForumChannel (GuildForumChannel 아님)
import { ForumChannel, ChannelType } from 'discord.js';

// 채널 조회
const forumChannel = guild.channels.cache.find(
  ch => ch.name === 'goals' && ch.type === ChannelType.GuildForum
) as ForumChannel;
```

### 태그 사전 등록
```typescript
// 채널 생성 시 또는 수정 시 availableTags 설정
await forumChannel.edit({
  availableTags: [
    { name: 'pending',     moderated: false },
    { name: 'in-progress', moderated: false },
    { name: 'blocked',     moderated: false },
    { name: 'done',        moderated: false },
    { name: 'failed',      moderated: false },
  ],
});
```

### 게시물(Thread) 생성

`GuildForumThreadManager.create()` 전체 파라미터:

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `name` | `string` | ✅ | 스레드 제목 |
| `message` | `GuildForumThreadMessageCreateOptions \| MessagePayload` | ✅ | 첫 번째 메시지 (없으면 에러) |
| `appliedTags` | `Snowflake[]` | ❌ | 적용할 태그 ID 배열 |
| `autoArchiveDuration` | `ThreadAutoArchiveDuration` | ❌ | 자동 아카이브 기간 (기본: 채널 설정값) |
| `rateLimitPerUser` | `number` | ❌ | 슬로우모드 초 (0 = 해제) |
| `reason` | `string` | ❌ | 감사 로그 사유 |

```typescript
import { ThreadAutoArchiveDuration } from 'discord.js';

const tag = forumChannel.availableTags.find(t => t.name === 'pending');

const thread = await forumChannel.threads.create({
  name: `[${goalId.slice(0, 8)}] ${goalSummary}`,
  message: {
    content: buildInitialBody({ cycleId, goalId, goalContent }),
  },
  appliedTags: tag ? [tag.id] : [],
  autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  reason: `Goal cycle ${cycleId} started`,
});
```

### 태그 업데이트
```typescript
// ThreadChannel.setAppliedTags() 사용 (edit()의 래퍼)
const doneTag = forumChannel.availableTags.find(t => t.name === 'done');
await thread.setAppliedTags(doneTag ? [doneTag.id] : []);
```

---

## 4. 채널 초기화 체크리스트

- [ ] 서버에 `goals` 이름의 Forum 채널 생성 (`ChannelType.GuildForum = 15`)
- [ ] `availableTags` 5개 등록 (pending / in-progress / blocked / done / failed)
- [ ] 봇에 `ViewChannel` + `CreatePublicThreads` + `SendMessagesInThreads` + `ManageThreads` 권한 부여
- [ ] `data/config.json`에 `goalForumChannelId` 필드 추가

---

*최초 작성: 2026-04-07*
*최종 업데이트: 2026-04-08 — Discord.js v14.25.1 검증, ForumChannel API 정확도 수정*
*작성자: Researcher Agent (DiscordAgentOS)*
