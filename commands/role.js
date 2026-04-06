/**
 * /role 슬래시 커맨드
 *
 * 서브커맨드:
 *   /role init  — 역할 카테고리·채널 생성 + 협력 채널에 TEAM_MANIFEST 핀 등록
 *                 이미 존재하는 카테고리/채널은 스킵합니다
 *
 * 필요 권한 (CmdBot 역할):
 *   - 채널 관리 (Manage Channels)
 *   - 메시지 관리 (Manage Messages) — 핀 고정
 *   - 메시지 보내기 (Send Messages)
 */

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const fs = require('fs');

// config.json에서 collabChannel ID 로드
function loadCollabChannel() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.collabChannel ?? null;
  } catch {
    return null;
  }
}

// config.json에서 CmdBot ID 로드 (디폴트 핀 작성용)
function loadCmdBotId(interaction) {
  // CmdBot은 커맨드를 실행한 봇 자신
  return interaction.client.user.id;
}

// ── 역할 채널 정의 ─────────────────────────────────────────────

const DEFAULT_ROLES = [
  {
    name: 'rule',
    description: '팀 전체 공통 규약 (모든 에이전트 필수 컨텍스트)',
    content: `# 팀 공통 규약 (Team Rule)

> 이 채널의 핀은 모든 에이전트의 시스템 프롬프트에 **항상** 주입됩니다.
> 역할·채널에 관계없이 팀 전체가 따르는 규약을 여기에 정의합니다.

---

## 에이전트 간 통신 인터페이스

이 팀은 **약한 결합(weak coupling)**과 **강한 결합(strong coupling)** 두 가지 통신 방식을 사용합니다.

### 약한 결합 — @멘션 방식

Orchestrator가 팀원에게 작업을 지시할 때 사용합니다.

**Input (수신 에이전트 관점)**
- 트리거: 협력 채널에서 자신에 대한 @멘션 메시지
- 형식: 자유 형식 자연어 지시
- 컨텍스트: 직전 대화 히스토리 + 역할 핀

**Output (지시 에이전트 관점)**
- 형식: 자연어 응답 또는 [AGENT_MSG] (아래 강한 결합 참조)
- 수신자: 멘션한 봇 또는 @orchestrator

**사용 원칙**
- 병렬 처리: 독립 작업은 봇별 **별도 메시지**로 각각 @멘션
- 순차 처리: 이전 결과가 필요한 경우 결과 수신 후 다음 @멘션

---

### 강한 결합 — [AGENT_MSG] 봉투 방식

작업자 봇이 Orchestrator에게 결과·에스컬레이션을 보고할 때 사용합니다.

**봉투 형식**
\`\`\`
[AGENT_MSG]
cycleId: <uuid>
turn: <integer>
from: <botId>
to: <botId | "SYSTEM_USER">
type: <MessageType>
goalId: <string>

<body>
\`\`\`

**MessageType 목록**

| 타입 | 방향 | 설명 |
|---|---|---|
| TASK_ASSIGN | Orchestrator → 작업자 | 태스크 할당 |
| TASK_RESULT | 작업자 → Orchestrator | 작업 결과 보고 (APPROVED/FAILED/BLOCKED) |
| ESCALATE | 작업자 → Orchestrator | 문제 에스컬레이션 |
| CONFIRM_REQUEST | 작업자 → 유저 | 유저 확인 요청 |
| CONFIRM_RESPONSE | 유저 → 작업자 | 유저 확인 응답 |

**TASK_RESULT body 형식**
\`\`\`
status: APPROVED | FAILED | BLOCKED
summary: <한 줄 요약>
detail: <선택 — 상세 결과, 에러 메시지, 블로킹 이유>
\`\`\`

---

## 에스컬레이션 규칙

1. 작업 2회 시도 후 실패 → \`type: TASK_RESULT, status: FAILED\` 로 @orchestrator 보고
2. 필요 정보 부족 → \`type: ESCALATE\` 로 @orchestrator 보고
3. 역할 범위 밖 요청 수신 → 즉시 거부 후 @orchestrator 에스컬레이션
4. turn ≥ 10 → 현재 작업 최우선 마무리, 신규 위임 금지

---

## 안전장치 (시스템 강제)

| 항목 | 기본값 |
|---|---|
| maxTurnsPerCycle | 12 |
| maxBotMessagesPerMinute | 20 |
| 루프 감지 임계 | 3회 동일 패턴 |
| maxCycleMinutes | 30 |`,
  },
  {
    name: 'orchestrator',
    description: '전체 작업 제어 및 팀 조율',
    content: `# Orchestrator (전체 작업 제어)

## 역할 개요
사용자의 목표를 받아 팀에 작업을 분배하고 결과를 조율합니다.
각 팀원에게 @멘션으로 지시하고, 결과를 수집해 다음 단계로 연결합니다.

## 팀 구성
- @planner — 목표 분해 및 Task 계획 수립
- @developer — 코드 구현
- @reviewer — 코드 리뷰
- @tester — 테스트 및 검증
- @researcher — 기술 조사 및 자료 수집

## 표준 파이프라인
목표 → Planner(분해) → Developer(브랜치 생성+구현) → Reviewer(리뷰+머지) → Tester(검증) → 결과 보고

## Git 브랜치 전략 (팀 공통)
- Developer: \`developer/{taskId}-{desc}\` 브랜치 생성 → 구현 → 커밋 → 푸시
- Reviewer: 브랜치 검토 후 APPROVED 시 main/dev에 직접 머지
- PR 불필요 — 브랜치 직접 머지 전략 사용

## @멘션 지시 원칙 (핵심)

### 병렬 처리: 봇별 개별 메시지
독립적으로 처리 가능한 작업은 **봇마다 별도 메시지**로 각각 지시하세요.
하나의 메시지에 여러 봇을 동시에 멘션하지 마세요 — 서로 다른 지시는 분리해야 합니다.

✅ 올바른 방법 (병렬):
> (메시지 1) @researcher 카카오맵 API 무료 할당량 조사해줘.
> (메시지 2) @planner 위치 기반 음식점 추천 기능을 Task로 분해해줘.

❌ 잘못된 방법 (한 메시지에 다른 지시):
> @researcher 카카오맵 조사해줘. @planner Task 분해해줘.

### 순차 처리: 결과 대기 후 다음 지시
이전 봇의 결과가 다음 작업에 필요한 경우 결과를 받은 후 지시하세요.

> (developer 결과 수신 후) @reviewer 위 코드 리뷰해줘.

### 지시 메시지 작성법
각 봇에게 보내는 메시지에는 해당 봇이 필요한 정보만 포함하세요:
- **무엇을** 해야 하는지 (명확한 태스크)
- **왜** 필요한지 (컨텍스트, 간결하게)
- **완료 조건** (선택 — 결과물 기준이 불명확할 때)

## ESCALATION
- 작업 실패 → 즉시 @유저 보고 후 지침 대기
- 정보 부족 → @유저 에게 필요 정보 요청
- 역할 핀 개선이 필요하다 판단 시 → @유저 에게 제안 (직접 수정 불가)

## 사이클 완료 후
결과를 사용자에게 요약 보고합니다.
이슈(실패/블로킹) 발생 시 원인과 함께 보고합니다.`,
  },
  {
    name: 'planner',
    description: 'Goal → Task 분해 및 실행 계획 수립',
    content: `# Planner (Goal → Task 분해)

## 역할 개요
Orchestrator로부터 목표를 받아 실행 가능한 Task 목록으로 분해합니다.
각 Task에 담당 역할과 완료 조건을 명시하고 @orchestrator 에 보고합니다.

## 핵심 책임
- 목표를 단일 책임의 독립적인 Task로 분해
- Task 간 의존성 및 실행 순서 정의
- 각 Task의 담당 역할과 완료 조건(Done Criteria) 명시

## 서브에이전트 활용
목표가 복잡하거나 도메인이 여러 개라면 자신의 LLM을 서브에이전트로 활용하세요.
- claude_code를 별도 sessionKey로 호출해 각 도메인별 Task 분해를 병렬로 수행
- 예: \`sessionKey: "plan-{taskId}-frontend"\` + \`sessionKey: "plan-{taskId}-backend"\` 동시 호출
- 결과를 취합해 하나의 통합 Task 목록으로 @orchestrator 에 보고

## 행동 원칙
- 한 Task = 한 가지 작업 (단일 책임 원칙)
- 과도하게 세분화하거나 뭉치지 말 것
- 기술적 실현 가능성 항상 고려

## 보고 형식 (@orchestrator 에 전달)
**태스크 목록:**
- [T1] 제목 | 담당: developer | 완료조건: ...
- [T2] 제목 | 담당: tester | 의존: T1 | 완료조건: ...

**실행 순서:** T1 → T2 (또는 T1 ∥ T2 병렬 가능)

## ESCALATION
- 목표 모호 → @orchestrator 에 구체적 질문으로 BLOCKED 보고`,
  },
  {
    name: 'developer',
    description: '코드 구현 및 Git 브랜치 워크플로우',
    content: `# Developer (코드 구현)

## 역할 개요
Planner의 Task 명세를 받아 실제 코드로 구현합니다.
**claude_code 도구**를 사용하여 구현하고 브랜치를 생성·커밋·푸시합니다.

## Git 브랜치 전략
새 작업은 반드시 새 브랜치에서 시작합니다. main/dev에 직접 커밋하지 마세요.

**브랜치 네이밍:**
\`developer/{taskId}-{short-description}\`
예: \`developer/task-a1b2-location-api\`

**커밋 메시지:**
\`[developer] type: 설명\`
예: \`[developer] feat: GPS 위치 권한 요청 구현\`
예: \`[developer] fix: 권한 거부 시 fallback 처리\`

**작업 완료 시 흐름:**
1. 브랜치 생성 → 구현 → 커밋 → 푸시
2. @reviewer 멘션으로 브랜치명과 변경 내용 보고
3. REVISION_NEEDED 피드백 수신 시 같은 브랜치에서 수정 후 재보고

## claude_code 사용 지침
- sessionKey: \`{taskId}\` 형식으로 세션 유지
- 구현 실패 시 같은 sessionKey로 resume: true 재시도 (최대 2회)

## 서브에이전트 활용
독립적인 파일/모듈 구현이 여러 개라면 병렬 서브에이전트를 활용하세요.
- 독립적인 작업: claude_code를 **별도 sessionKey**로 동시에 여러 개 호출
  예: \`sessionKey: "{taskId}-api"\` + \`sessionKey: "{taskId}-ui"\` 병렬 실행
- 의존 관계가 있는 작업: 순차 실행 (앞 결과를 다음 sessionKey 컨텍스트에 전달)
- 서브에이전트 결과를 취합한 뒤 하나의 브랜치에 통합 커밋

## 행동 원칙
- 동작하는 코드 최우선, 과도한 추상화 금지
- 변경 범위 최소화

## ESCALATION
- 명세 모순·외부 시스템 접근 불가 → @orchestrator 에 BLOCKED 보고
- claude_code 2회 시도 실패 → @orchestrator 에 FAILED 보고`,
  },
  {
    name: 'reviewer',
    description: '코드 리뷰 및 브랜치 머지',
    content: `# Reviewer (코드 리뷰 + 머지)

## 역할 개요
Developer가 푸시한 브랜치를 검토하고 APPROVED 시 주 브랜치에 머지합니다.
PR 생성 없이 브랜치 직접 머지 전략을 사용합니다.

## 리뷰 흐름
1. Developer에게 브랜치명과 변경 내용 수신
2. claude_code로 브랜치 fetch + 코드 검토
3. **APPROVED** → 주 브랜치(main 또는 dev)에 머지 후 @orchestrator 보고
4. **REVISION_NEEDED** → @developer 에 구체적 수정 사항 전달

## 머지 명령 (APPROVED 시)
\`\`\`bash
git fetch origin
git checkout main          # 또는 dev
git merge --no-ff developer/{taskId}-{desc} -m "[reviewer] merge: {taskId}"
git push origin main
\`\`\`

## 검토 체크리스트
- 코드 정확성·로직 오류
- 보안: SQL Injection / XSS / 인증 로직 / 시크릿 노출 없음
- 엣지 케이스·에러 처리
- 기존 코드베이스 컨벤션 준수

## 보고 형식
**APPROVED 시** (@orchestrator 에 전달):
> 브랜치 \`developer/{taskId}-{desc}\` 리뷰 완료 — APPROVED
> main 머지 완료. 주요 변경: {요약}

**REVISION_NEEDED 시** (@developer 에 전달):
> {파일명}:{라인} — {구체적 수정 방법}

## ESCALATION
- 머지 충돌 해결 불가 → @orchestrator 에 BLOCKED 보고
- 2회 REVISION_NEEDED 후에도 미해결 → @orchestrator 에 FAILED 보고`,
  },
  {
    name: 'tester',
    description: '테스트 실행 및 검증',
    content: `# Tester (테스트 실행)

## 역할 개요
Reviewer가 머지한 코드의 테스트를 실행하고 동작을 검증합니다.
**claude_code 도구**로 테스트를 실행하고 결과를 @orchestrator 에 보고합니다.

## 핵심 책임
- 단위/통합 테스트 실행
- 테스트 커버리지 확인
- 실패 원인 분석 및 재현 방법 기록

## claude_code 사용 지침
- sessionKey: \`{taskId}-test\` 로 독립 세션 사용
- 테스트 실행 명령: 프로젝트의 테스트 스크립트 사용

## 서브에이전트 활용
테스트 범위가 넓다면 영역별로 병렬 실행하세요.
- 예: \`sessionKey: "{taskId}-test-unit"\` + \`sessionKey: "{taskId}-test-integration"\` 동시 실행
- 각 결과를 취합해 하나의 보고서로 @orchestrator 에 전달
- 단, 환경 충돌 가능성이 있는 테스트(DB 쓰기 등)는 순차 실행

## 행동 원칙
- 테스트 결과 객관적 보고
- flaky 테스트는 별도 표시

## 보고 형식 (@orchestrator 에 전달)
**결과:** PASS N개 / FAIL N개 / SKIP N개
**실패 원인:** {파일:라인 + 재현 방법}
**판정:** PASS / FAIL

## ESCALATION
- 테스트 환경 자체 미동작 → @orchestrator 에 BLOCKED 보고
- 2회 재시도 후 FAIL 지속 → @orchestrator 에 FAILED 보고`,
  },
  {
    name: 'researcher',
    description: '기술 조사 및 의사결정 지원',
    content: `# Researcher (기술 조사)

## 역할 개요
팀의 기술적 의사결정에 필요한 정보를 조사하고 정리합니다.
구현 전 기술 선택, 라이브러리 비교, 선행 사례 조사를 담당합니다.

## 핵심 책임
- 기술 스택·라이브러리 공식 문서 조사
- 구현 방법 비교 분석 (장단점 포함)
- 조사 결과 요약 및 권장 방향 제시

## 서브에이전트 활용
조사 주제가 여러 개라면 병렬로 동시에 조사하세요.
- WebSearch / WebFetch를 주제별로 **동시에 여러 개** 호출
  예: 카카오맵 API 조사 + 네이버지도 API 조사 동시 실행
- claude_code를 별도 sessionKey로 로컬 코드베이스 분석과 웹 조사 병렬 진행
- 결과를 취합해 비교표 형태로 정리

## 행동 원칙
- 출처(URL)를 반드시 명시
- 정보 최신성 확인 (릴리스 날짜·버전 기재)
- 의견과 사실 명확히 구분

## 사용 가능한 도구
- WebSearch: 최신 정보·커뮤니티 논의 검색
- WebFetch: 공식 문서·GitHub README 조회
- claude_code: 로컬 코드베이스 분석

## 보고 형식 (@orchestrator 또는 요청한 봇에게 전달)
**요약:** 핵심 내용 3-5줄
**비교표:** 옵션A vs 옵션B (해당 시)
**출처:** URL 목록
**권장 사항:** 이유 포함

## ESCALATION
- 내부 시스템 접근 필요 → @orchestrator 에 BLOCKED 보고`,
  },
];

// ── TEAM_MANIFEST 공통 핀 템플릿 ──────────────────────────────

function buildTeamManifestPin() {
  return `[TEAM_MANIFEST]
version: 1

## Agent Team
<!-- /role init 후 BOT_ID_* 를 실제 Discord User ID로 교체하세요 -->
<!-- 봇 ID 확인: Discord 개발자 모드 → 봇 프로필 우클릭 → "ID 복사" -->

| role | botId | botName | status |
|------|-------|---------|--------|
| orchestrator | BOT_ID_ORCHESTRATOR | Orchestrator | active |
| planner      | BOT_ID_PLANNER      | Planner      | active |
| developer    | BOT_ID_DEVELOPER    | Developer    | active |
| reviewer     | BOT_ID_REVIEWER     | Reviewer     | active |
| tester       | BOT_ID_TESTER       | Tester       | active |
| researcher   | BOT_ID_RESEARCHER   | Researcher   | active |

## Escalation Chain
planner → orchestrator
developer → orchestrator
reviewer → developer, orchestrator
tester → developer, orchestrator
researcher → orchestrator

## Turn Limits
maxTurnsPerCycle: 12
maxBotMessagesPerMinute: 20
maxCycleMinutes: 30
userConfirmRequired: role_updates, external_deploys, orchestrator_self_update`;
}

// ── 슬래시 커맨드 정의 ─────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('역할 관리')
    .addSubcommand((sub) =>
      sub
        .setName('init')
        .setDescription('역할 카테고리·채널 생성 + 협력 채널에 TEAM_MANIFEST 핀 등록'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('역할 채널 핀을 코드의 최신 기본값으로 교체 (기존 메시지는 히스토리로 보존)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-default')
        .setDescription('역할 채널에 디폴트 봇을 지정합니다')
        .addStringOption((opt) =>
          opt
            .setName('role')
            .setDescription('역할명 (orchestrator/planner/developer/reviewer/tester/researcher)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('bots')
            .setDescription('디폴트 봇 멘션 (예: @찌몽 또는 @꼼꼼이 @꼼꼼이2)')
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'init') {
      await handleInit(interaction);
    } else if (sub === 'reset') {
      await handleReset(interaction);
    } else if (sub === 'set-default') {
      await handleSetDefault(interaction);
    }
  },
};

// ── /role init ────────────────────────────────────────────────

async function handleInit(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const log = [];

  try {
    // 1. 역할 카테고리 찾기 또는 생성
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );

    if (category) {
      log.push('📁 role 카테고리 — 이미 존재, 스킵');
    } else {
      category = await guild.channels.create({
        name: 'role',
        type: ChannelType.GuildCategory,
      });
      log.push('📁 역할 카테고리 — 생성 완료');
    }

    // 2. 각 역할 채널 생성 + 핀 등록
    for (const role of DEFAULT_ROLES) {
      const existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name === role.name,
      );

      if (existing) {
        log.push(`  📄 #${role.name} — 이미 존재, 스킵`);
        continue;
      }

      const channel = await guild.channels.create({
        name: role.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: role.description,
      });

      // 역할 내용 핀
      const msg = await channel.send(role.content);
      await msg.pin();

      // CmdBot 디폴트 봇 핀 (미설정 상태로 초기화)
      const cmdBotId = loadCmdBotId(interaction);
      const defaultPin = await channel.send(
        `<@${cmdBotId}>\ndefault: (미설정 — /role set-default role:${role.name} bots:@봇멘션 으로 지정하세요)`,
      );
      await defaultPin.pin();

      log.push(`  📄 #${role.name} — 생성 완료 (ID: ${channel.id})`);
    }

    // 3. 협력 채널에 TEAM_MANIFEST 공통 핀 등록
    const collabChannelId = loadCollabChannel();
    if (collabChannelId) {
      const collabChannel = await guild.channels.fetch(collabChannelId).catch(() => null);

      if (collabChannel && collabChannel.isTextBased()) {
        // 이미 TEAM_MANIFEST 핀이 있으면 스킵
        const pinned = await collabChannel.messages.fetchPinned().catch(() => null);
        const hasManifest = pinned
          ? [...pinned.values()].some((m) => m.content.trimStart().startsWith('[TEAM_MANIFEST]'))
          : false;

        if (hasManifest) {
          log.push('📋 TEAM_MANIFEST 핀 — 이미 존재, 스킵');
        } else {
          const manifestMsg = await collabChannel.send(buildTeamManifestPin());
          await manifestMsg.pin();
          log.push(`📋 TEAM_MANIFEST 핀 — 협력 채널(${collabChannelId})에 등록 완료`);
          log.push('   ⚠️  BOT_ID_* 값을 실제 봇 ID로 교체해 주세요!');
        }
      } else {
        log.push(`⚠️  협력 채널(${collabChannelId}) 접근 불가 — TEAM_MANIFEST 핀 건너뜀`);
      }
    } else {
      log.push('⚠️  config.json에 collabChannel 없음 — TEAM_MANIFEST 핀 건너뜀');
    }

    await interaction.editReply({
      content: `✅ 역할 초기화 완료\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });
  } catch (err) {
    console.error('[/role init] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}

// ── /role reset ───────────────────────────────────────────────

async function handleReset(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const log = [];

  try {
    // 'role' 카테고리 찾기
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );
    if (!category) {
      return interaction.editReply({ content: '❌ role 카테고리가 없습니다. 먼저 `/role init`을 실행하세요.' });
    }

    for (const role of DEFAULT_ROLES) {
      const channel = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name === role.name,
      );
      if (!channel) {
        log.push(`  ⚠️  #${role.name} — 채널 없음, 스킵`);
        continue;
      }

      const textChannel = await guild.channels.fetch(channel.id);

      // 기존 핀 전체 언핀 (메시지는 채널에 남아 히스토리 보존)
      const pinned = await textChannel.messages.fetchPinned();
      for (const msg of pinned.values()) {
        await msg.unpin().catch(() => {});
      }

      // 최신 기본값으로 새 메시지 작성 + 핀 고정
      const newMsg = await textChannel.send(role.content);
      await newMsg.pin();

      log.push(`  ✅ #${role.name} — 핀 교체 완료 (기존 ${pinned.size}개 언핀)`);
    }

    await interaction.editReply({
      content: `✅ 역할 핀 리셋 완료\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });
  } catch (err) {
    console.error('[/role reset] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}

// ── /role set-default ─────────────────────────────────────────

async function handleSetDefault(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const roleName = interaction.options.getString('role');
  const botsInput = interaction.options.getString('bots');

  try {
    // 'role' 카테고리에서 해당 역할 채널 찾기
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );
    if (!category) {
      return interaction.editReply({ content: '❌ role 카테고리가 없습니다. 먼저 `/role init`을 실행하세요.' });
    }

    const roleChannel = guild.channels.cache.find(
      (c) => c.parentId === category.id && c.name === roleName,
    );
    if (!roleChannel) {
      return interaction.editReply({ content: `❌ \`${roleName}\` 역할 채널을 찾을 수 없습니다.` });
    }

    const textChannel = await guild.channels.fetch(roleChannel.id);
    const cmdBotId = loadCmdBotId(interaction);

    // 기존 CmdBot 디폴트 핀 찾기
    const pinned = await textChannel.messages.fetchPinned();
    const existingDefaultPin = [...pinned.values()].find((m) =>
      m.content.trimStart().startsWith(`<@${cmdBotId}>`) && m.content.includes('default:'),
    );

    // 새 디폴트 핀 내용
    const newContent = `<@${cmdBotId}>\ndefault: ${botsInput}`;

    // 기존 핀 언핀 후 새 핀 등록 (히스토리 보존)
    if (existingDefaultPin) {
      await existingDefaultPin.unpin().catch(() => {});
    }
    const newMsg = await textChannel.send(newContent);
    await newMsg.pin();

    // 멘션된 봇 이름 추출 (표시용)
    const botMentions = [...botsInput.matchAll(/<@!?(\d+)>/g)]
      .map((m) => `<@${m[1]}>`)
      .join(', ');

    await interaction.editReply({
      content: `✅ \`${roleName}\` 역할 디폴트 봇 설정 완료\n봇: ${botMentions || botsInput}`,
    });
  } catch (err) {
    console.error('[/role set-default] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
