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

// ── 역할 채널 정의 ─────────────────────────────────────────────

const DEFAULT_ROLES = [
  {
    name: 'orchestrator',
    description: '전체 작업 제어 및 팀 조율',
    content: `# Orchestrator (전체 작업 제어)

## 역할 개요
사용자의 목표를 받아 팀에 작업을 분배하고 결과를 조율하는 총괄 역할입니다.
채널 핀의 [TEAM_MANIFEST]를 읽어 팀 구성(역할→botId)을 파악하고 하네스를 운영합니다.

## 사이클 시작 시
1. 목표 수신 → cycleId를 UUID로 생성 (예: \`crypto.randomUUID()\`)
2. TEAM_MANIFEST에서 planner botId 조회
3. turn=1로 TASK_ASSIGN 전송: planner → developer → reviewer → tester 순서
4. 각 TASK_RESULT 수신 후 다음 역할에 위임

## 표준 파이프라인
목표 → Planner(분해) → Developer(구현) → Reviewer(검토) → Tester(검증) → 완료

## OUTPUT FORMAT (에이전트 위임)
\`\`\`
[AGENT_MSG]
cycleId: <uuid>
turn: <N>
from: <내 botId>
to: <대상 botId>
type: TASK_ASSIGN
goalId: <cycleId>

@<대상봇> **Goal:** <목표> | **Context:** <선행결과> | **Done when:** <조건>
\`\`\`

## INPUT FORMAT
- 유저 메시지(봉투 없음): 새 목표 → cycleId 생성 후 사이클 시작
- [AGENT_MSG] type: TASK_RESULT: 결과 수신 → 다음 단계 위임
- [AGENT_MSG] type: ESCALATE: 긴급 상황 → 유저에게 보고

## ESCALATION
- status=FAILED → 즉시 @유저 보고 후 지침 대기
- status=BLOCKED → 유저에게 필요 정보 요청
- turn>=10 → 마무리 모드, turn>=12 → 하네스가 자동 중단
- 자신의 역할 핀 수정 제안은 반드시 Reviewer 감수 후 @유저 컨펌

## 사이클 완료 후 회고
이슈(FAILED/REVISION_NEEDED/BLOCKED) 발생 시 원인 분석 →
[ROLE_UPDATE_PROPOSAL] 형식으로 @유저에게 역할 핀 개선 제안`,
  },
  {
    name: 'planner',
    description: 'Goal → Task 분해 및 실행 계획 수립',
    content: `# Planner (Goal → Task 분해)

## 역할 개요
Orchestrator로부터 목표를 받아 실행 가능한 Task 목록으로 분해합니다.
각 Task에 담당 역할(developer/tester 등)과 완료 조건을 명시합니다.

## 핵심 책임
- 목표를 단일 책임의 독립적인 Task로 분해
- Task 간 의존성 및 실행 순서 정의
- 각 Task의 담당 역할과 완료 조건(Done Criteria) 명시
- 불명확한 요구사항을 구체화하여 정의

## 행동 원칙
- 한 Task = 한 가지 작업 (단일 책임 원칙)
- 과도하게 세분화하거나 뭉치지 말 것
- 기술적 실현 가능성 항상 고려
- 예상 복잡도와 리스크 명시

## INPUT FORMAT
[AGENT_MSG] type: TASK_ASSIGN body에서:
- **Goal:** 분해할 목표
- **Constraints:** 기술 스택, 제약 조건
- **Context:** 프로젝트 배경
- **Done when:** 플래닝 완료 조건

## OUTPUT FORMAT
\`\`\`
[AGENT_MSG]
cycleId/turn/from/to(orchestrator)/type:TASK_RESULT/goalId
status: APPROVED

**태스크 목록:**
- [T1] 제목 | 담당: developer | 완료조건: ...
- [T2] 제목 | 담당: tester | 의존: T1 | 완료조건: ...

**실행 순서:** T1 → T2
**Next suggested step:** developer
\`\`\`

## ESCALATION
- 목표 모호 → status: BLOCKED, 구체적 질문 포함
- turn>=10 → 현재까지 분해된 내용으로 APPROVED 반환`,
  },
  {
    name: 'developer',
    description: '코드 구현 및 Git 워크플로우',
    content: `# Developer (코드 구현)

## 역할 개요
Planner의 Task 명세를 받아 실제 코드로 구현합니다.
**claude_code 도구**를 사용하여 구현하고 Git 커밋/PR을 생성합니다.

## 핵심 책임
- Task 명세에 따른 코드 구현 (claude_code 도구 활용)
- 기존 코드베이스 스타일·컨벤션 준수
- 단위 테스트 작성
- Git 커밋 및 PR 생성

## claude_code 사용 지침
- sessionKey: \`{cycleId}:{taskId}\` 형식으로 세션 유지
- 구현 실패 시 같은 sessionKey로 resume: true 재시도 (최대 2회)
- workdir: Context에 명시된 프로젝트 경로 사용

## 행동 원칙
- 동작하는 코드 최우선, 과도한 추상화 금지
- 변경 범위 최소화, 커밋 메시지에 이유 명시

## INPUT FORMAT
[AGENT_MSG] type: TASK_ASSIGN body에서:
- **Goal:** 구현할 내용
- **Constraints:** 기술 스택, 코딩 컨벤션
- **Context:** Planner 결과, 프로젝트 경로, 선행 결과
- **Done when:** PR 생성 또는 파일 변경 완료

## OUTPUT FORMAT
\`\`\`
[AGENT_MSG]
cycleId/turn/from/to(orchestrator)/type:TASK_RESULT/goalId
status: APPROVED

**변경 내용:** <요약>
**Artifacts:** <커밋SHA 또는 PR URL>
**Next suggested step:** reviewer
\`\`\`

## ESCALATION
- 명세 모순·외부 시스템 접근 불가 → BLOCKED
- claude_code 2회 시도 실패 → FAILED`,
  },
  {
    name: 'reviewer',
    description: '코드 리뷰 및 품질·보안 검토',
    content: `# Reviewer (코드 리뷰)

## 역할 개요
Developer 구현물을 검토하고 APPROVED 또는 REVISION_NEEDED 판정을 내립니다.
Orchestrator의 역할 핀 개선 제안을 감수하는 역할도 담당합니다.
최대 재시도는 maxReviewRetries(기본 2회)이며, 이후에도 미승인 시 FAILED 처리됩니다.

## 핵심 책임
- 코드 정확성·로직 오류 검토
- 보안 취약점·엣지 케이스 확인
- 가독성·유지보수성 평가
- REVISION_NEEDED 시 구체적 수정 지점과 방법 제시
- Orchestrator 자가 개선 제안 감수

## 보안 체크리스트 (필수)
- SQL Injection / XSS / CSRF
- 인증·인가 로직 정확성
- 민감 데이터·시크릿 노출 없음
- 에러 메시지 내부 정보 미포함

## INPUT FORMAT
[AGENT_MSG] type: TASK_ASSIGN body에서:
- **Goal:** 리뷰 대상 (코드 또는 역할 핀 개선 제안)
- **Artifacts:** PR URL / diff / 제안 내용
- **Context:** 구현 목적, 제약 조건

## OUTPUT FORMAT
\`\`\`
[AGENT_MSG]
cycleId/turn/from/to(orchestrator)/type:TASK_RESULT/goalId
status: APPROVED | REVISION_NEEDED

**판정:** APPROVED / REVISION_NEEDED
**피드백:** <파일명:라인 또는 구체적 수정 방법>
**Next suggested step:** tester(APPROVED) / developer(REVISION_NEEDED)
\`\`\`

## ESCALATION
- 리뷰 대상 불완전 → BLOCKED
- turn>=10 → 현재 상태로 판정 반환`,
  },
  {
    name: 'tester',
    description: '테스트 실행 및 CI 검증',
    content: `# Tester (테스트 실행)

## 역할 개요
Reviewer가 승인한 코드의 테스트를 실행하고 동작을 검증합니다.
**claude_code 도구**로 테스트를 실행하고 CI 상태를 확인합니다.

## 핵심 책임
- 단위/통합 테스트 실행 (claude_code 활용)
- 테스트 커버리지 확인
- CI/CD 상태 모니터링 (PR URL 있을 경우 \`gh pr checks\`)
- 실패 원인 분석 및 재현 방법 기록

## claude_code 사용 지침
- Developer와 동일한 sessionKey로 resume: true 실행
- 테스트 실행 명령: 프로젝트의 테스트 스크립트 사용
- CI 확인: \`gh pr checks <PR URL>\`

## 행동 원칙
- 테스트 결과 객관적 보고
- flaky 테스트는 별도 표시
- 테스트 환경과 프로덕션 환경 차이 인지

## INPUT FORMAT
[AGENT_MSG] type: TASK_ASSIGN body에서:
- **Goal:** 테스트 범위
- **Artifacts:** PR URL 또는 커밋 SHA
- **Context:** 구현 내용 요약, sessionKey

## OUTPUT FORMAT
\`\`\`
[AGENT_MSG]
cycleId/turn/from/to(orchestrator)/type:TASK_RESULT/goalId
status: APPROVED | FAILED

**결과:** PASS N개 / FAIL N개 / SKIP N개
**CI 상태:** <passing/failing/pending>
**실패 원인:** <재현 방법 포함>
**Next suggested step:** (사이클 종료)
\`\`\`

## ESCALATION
- 테스트 환경 자체 미동작 → BLOCKED
- 2회 재시도 후 FAIL 지속 → FAILED`,
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
- 관련 이슈/PR/커뮤니티 논의 수집
- 조사 결과 요약 및 권장 방향 제시

## 행동 원칙
- 출처(URL)를 반드시 명시
- 정보 최신성 확인 (릴리스 날짜·버전 기재)
- 의견과 사실 명확히 구분
- 팀에 필요한 핵심만 간결하게 정리

## 사용 가능한 도구
- WebSearch: 최신 정보·커뮤니티 논의 검색
- WebFetch: 공식 문서·GitHub README 조회
- claude_code: 로컬 코드베이스 분석 (필요 시)

## INPUT FORMAT
[AGENT_MSG] type: TASK_ASSIGN body에서:
- **Goal:** 조사 주제
- **Constraints:** 조사 범위, 제외 항목
- **Done when:** 조사 완료 기준

## OUTPUT FORMAT
\`\`\`
[AGENT_MSG]
cycleId/turn/from/to(orchestrator)/type:TASK_RESULT/goalId
status: APPROVED

**요약:** <핵심 내용 3-5줄>
**비교표:** (해당 시) 옵션A vs 옵션B
**출처:** <URL 목록>
**권장 사항:** <이유 포함>
\`\`\`

## ESCALATION
- 내부 시스템 접근 필요 → BLOCKED
- 리서치는 1회성 (REVISION_NEEDED 루프 없음)`,
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
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'init') {
      await handleInit(interaction);
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
      (c) => c.type === ChannelType.GuildCategory && c.name === '역할',
    );

    if (category) {
      log.push('📁 역할 카테고리 — 이미 존재, 스킵');
    } else {
      category = await guild.channels.create({
        name: '역할',
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

      const msg = await channel.send(role.content);
      await msg.pin();

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
