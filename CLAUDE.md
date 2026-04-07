# discord-ai-team — Claude Code 가이드

## 하네스 엔지니어링 행동 원칙 (최우선 적용)

이 프로젝트의 모든 AI 에이전트는 아래 원칙을 시스템 프롬프트보다 우선하여 따릅니다.

### 역할 충실 원칙
- **자신의 역할만 수행한다.** Planner는 계획만, Developer는 구현만, Reviewer는 리뷰만 수행합니다.
- **역할을 절대 위임하지 않는다.** "나 대신 해줘", "이건 네가 해"는 금지입니다. 자신의 역할 범위 밖의 일은 Orchestrator에게 에스컬레이션합니다.
- **역할 외 작업이 필요하면 즉시 보고한다.** 혼자 해결하려다 범위를 이탈하지 않습니다.

### 정직 원칙
- **추측하지 않는다.** 확인되지 않은 사실을 기정사실처럼 말하지 않습니다. 모를 때는 "모른다"고 합니다.
- **무조건 동의하지 않는다.** 요청이 역할 범위 밖이거나 잘못된 판단이면 이유를 들어 이의를 제기합니다.
- **완료되지 않은 작업을 완료라고 하지 않는다.** 부분 완료는 부분 완료라고 명확히 보고합니다.

### 실행 원칙
- **완료 조건(Done Criteria)을 반드시 충족한 후 APPROVED 응답을 반환한다.**
- **실패는 즉시 에스컬레이션한다.** 2회 시도 후 실패 시 BLOCKED/FAILED로 Orchestrator에 보고합니다.
- **가정 없이 실행한다.** 필요한 정보가 없으면 추측 대신 질문합니다.
- **[AGENT_MSG] 프로토콜을 준수한다.** 응답 형식, cycleId, turn, from/to 필드를 정확히 기재합니다.

### 컨텍스트 원칙
- **채널 핀과 역할 핀을 항상 먼저 확인한다.** 지시보다 핀이 우선입니다.
- **이전 턴의 결과를 인지하고 응답한다.** 히스토리 없이 새로 시작하지 않습니다.
- **turn 한도를 의식한다.** turn >= 10이면 최대한 빠르게 마무리합니다.

---

## 프로젝트 개요

**discord-ai-team** — Discord 위에서 동작하는 멀티 에이전트 AI 오케스트레이션 시스템.

복수의 AI 봇(찌몽/아루/센세 등)이 각자 독립 채널에서 운영되며, 협력 채널에서 Orchestrator 지휘 아래 팀으로 작업합니다. [AGENT_MSG] 봉투 프로토콜로 봇 간 통신하며, turn 한도·rate-limit·루프 감지로 무한 실행을 방지합니다.

- **레포**: https://github.com/KoonZziMong/discord-agent-os
- **진입점**: `src/index.ts`
- **설정**: `data/config.json` 단일 파일 (.env 미사용)
- **언어/런타임**: TypeScript strict, Node.js + ts-node
- **주요 라이브러리**: discord.js v14, @anthropic-ai/sdk, openai, express

### 주요 명령어

| 명령어 | 설명 |
|---|---|
| `npm start` | 개발 실행 (ts-node) |
| `npm run build` | TypeScript 컴파일 |
| `npm run prod` | pm2 프로덕션 실행 |
| `npx tsc --noEmit` | 타입 체크 |

---

## 문서 목록

| 문서 | 경로 | 내용 |
|---|---|---|
| 아키텍처 | `docs/ARCHITECTURE.md` | 모듈 맵, [AGENT_MSG] 프로토콜, 라우팅 흐름, 파이프라인 |
| 시작 가이드 | `docs/getting-started.md` | 설치, Discord 봇 생성, 초기 구조 설정 |
| 개발 가이드 | `docs/development.md` | 코드 컨벤션, 브랜치 전략, 개발 명령어 |
| API 명세 | `docs/api.md` | AgentConfig / AppConfig / CommandsConfig 타입 |
| 기여 가이드 | `docs/contributing.md` | 새 역할 추가법, PR 가이드 |
| 슬래시 커맨드 | `docs/COMMANDS.md` | /role /project /channel /github /task /status |
| AI 에이전트 가이드 | `docs/CLAUDE.md` | 아키텍처 요약, 개발 규칙 (간결 버전) |

---

## 핵심 구조 요약

```
src/
  index.ts          — 진입점 (봇 초기화, 이벤트 바인딩)
  agent.ts          — Agent 클래스 (LLM 응답, 툴 실행, TaskGraph)
  router.ts         — 메시지 라우팅 (유저/봇/하네스 분기)
  agentProtocol.ts  — [AGENT_MSG] 프로토콜, CycleState
  llm.ts            — LLM 클라이언트 (Anthropic / OpenAI 호환)
  roleContext.ts    — 역할 컨텍스트 3단계 로딩 (글로벌/프로젝트/채널)
  config.ts         — AgentConfig / AppConfig / CommandsConfig

commands/           — CmdBot 슬래시 커맨드 (AI 파이프라인과 무관)
data/
  config.json       — 봇 설정 (토큰·API 키 포함 — 절대 커밋 금지)
  tasks/            — TaskGraph JSON 영속화
  proposals/        — 역할 핀 업데이트 제안
```

### 메시지 라우팅

```
유저 메시지
  ├─ !목표 <goal>  → respond() — 오케스트레이터 LLM이 팀에 [AGENT_MSG] 위임
  ├─ !자율 <goal>  → startTaskGraph() — 단독 자동 파이프라인 실행
  └─ @멘션 대화    → respond()

봇 메시지
  ├─ [AGENT_MSG]  → handleHarnessMessage() — 하네스 라우팅
  └─ 봇 @멘션     → respondInCollab() (자기 멘션 제외)
```

### 역할 컨텍스트 3단계

1. `ROLE` 카테고리 채널 핀 → 글로벌 역할 정의
2. 프로젝트 카테고리 내 `role` 채널 핀 → 프로젝트 커스텀 지침
3. 현재 채널의 봇 멘션 핀 → 채널 개별 설정

### 주의사항

- `data/config.json` 절대 출력하거나 커밋하지 말 것
- `dist/` 빌드 결과물 — 직접 수정 금지
- `commands/` JS 슬래시 커맨드 — AI 파이프라인과 무관, 독립적으로 테스트
- `autonomousRoleUpdates: false`(기본값) — 역할 핀 변경은 유저 컨펌 필요
