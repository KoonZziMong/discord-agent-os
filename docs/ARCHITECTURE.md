# 시스템 아키텍처

## 1. 개요

discord-agent-os는 Discord 서버 위에서 동작하는 멀티 에이전트 AI 시스템입니다.
복수의 AI 봇(찌몽/아루/센세 등)이 각자 독립 채널에서 운영되며, 협력 채널에서 오케스트레이터 지휘 아래 함께 작업합니다.

```
Discord 사용자
    │
    ├─ 메시지 (@멘션, !목표, !자율)
    │       └─→ AI 봇 (찌몽 / 아루 / 센세 ...)
    │                   │
    │                   ├─ 일반 대화 → LLM 응답
    │                   ├─ !목표 → 오케스트레이터가 팀에 [AGENT_MSG] 위임
    │                   └─ !자율 → 단독 자동 파이프라인 실행
    │
    └─ 슬래시 커맨드 (/task, /github, /status, /role, /project, /channel)
            └─→ CmdBot (전담 처리)
```

## 2. 봇 구성

단일 Node.js 프로세스에서 복수의 Discord 클라이언트가 동시 실행됩니다.

| 봇 유형 | 역할 | 인텐트 |
|---|---|---|
| AI 봇 (찌몽 / 아루 / 센세 등) | 대화 응답, Task Graph 실행, 하네스 참여 | Guilds, GuildMessages, MessageContent |
| CmdBot | 슬래시 커맨드 전담 처리 | Guilds |

AI 봇과 CmdBot을 분리하는 이유: Discord는 봇 계정 단위로 슬래시 커맨드를 등록하므로, AI 봇에 직접 등록하면 서버에 동일 커맨드가 중복 노출됩니다.

## 3. 모듈 맵

### `src/` 핵심 모듈

| 파일 | 역할 |
|---|---|
| `index.ts` | 진입점 — 봇 초기화, 이벤트 바인딩, graceful shutdown |
| `agent.ts` | Agent 클래스 — 대화 응답, 툴 실행, TaskGraph 관리 |
| `router.ts` | Discord 메시지 라우팅 (유저/봇 메시지 분기, 하네스 라우팅) |
| `collaboration.ts` | 협력 채널 오케스트레이터 (멘션 기반 순차 응답) |
| `agentProtocol.ts` | 봇 간 통신 프로토콜 ([AGENT_MSG] 봉투, 팀 매니페스트, 사이클 상태) |
| `llm.ts` | LLM 클라이언트 추상화 (Anthropic / OpenAI 호환, 프롬프트 캐싱) |
| `mcp.ts` | 봇별 MCP 서버 관리 (Claude Desktop config 읽기, subprocess 실행) |
| `tools.ts` | 툴 정의 (update_persona, claude_code, Computer Use) |
| `claude-code.ts` | Claude Code CLI 연동 및 세션 관리 |
| `history.ts` | 채널별 인메모리 대화 히스토리 |
| `channelContext.ts` | 채널 토픽 + 핀 메시지 캐시 (system prompt 주입) |
| `roleContext.ts` | 역할 채널 컨텍스트 3단계 로딩 (글로벌/프로젝트/채널) |
| `roleProposals.ts` | 역할 핀 업데이트 제안 관리 (파일 영속화, TTL 24h) |
| `retrospective.ts` | 사이클 완료 후 회고 및 역할 핀 개선 제안 생성 |
| `config.ts` | 설정 로드/저장 (`data/config.json`) |
| `persona.ts` | 페르소나 파일 로드/수정 |
| `computer.ts` | macOS Computer Use 구현 |
| `utils.ts` | 공통 유틸리티 (sendSplit, keepTyping, delay, getErrorMessage) |

### `src/task/` — Task Graph

| 파일 | 역할 |
|---|---|
| `types.ts` | Task / TaskGraphData 타입 정의 |
| `graph.ts` | TaskGraph 클래스 — 상태 변경 + 자동 영속화 |
| `planner.ts` | LLM으로 목표 → Task 배열 분해 |
| `runner.ts` | Task Graph 순차 실행 루프 |
| `store.ts` | JSON 파일 I/O (`data/tasks/`) |

### `src/agentGraph/` — Agent Workflow 파이프라인

| 파일 | 역할 |
|---|---|
| `types.ts` | WorkflowContext / WorkflowResult 인터페이스 |
| `executor.ts` | 파이프라인 실행기 (planner → developer → reviewer → tester) |
| `nodes/plannerNode.ts` | LLM으로 구현 계획 수립 |
| `nodes/developerNode.ts` | Claude Code로 코드 작성 + Git 워크플로우 |
| `nodes/reviewerNode.ts` | LLM 코드 리뷰 (APPROVED / REVISION_NEEDED) |
| `nodes/testerNode.ts` | Claude Code로 테스트 실행 + CI 확인 |

### `src/admin/` — 관리 웹 서버

| 파일 | 역할 |
|---|---|
| `server.ts` | Express 관리 웹 서버 (기본 127.0.0.1:3000) |
| `hotreload.ts` | 설정 핫리로드 |
| `routes/config.ts` | `/api/config` 에이전트 설정 CRUD |
| `routes/discord.ts` | `/api/discord` 채널/봇 목록 조회 |
| `routes/roleUpdate.ts` | `/api/role-update` 역할 핀 직접 수정 |

### `commands/` — CmdBot 슬래시 커맨드 (AI 파이프라인과 무관)

| 파일 | 커맨드 |
|---|---|
| `channel.js` | `/channel` — 채널 컨텍스트 관리 |
| `github.js` | `/github` — 레포 관리 |
| `project.js` | `/project` — 프로젝트 생성/관리 |
| `role.js` | `/role` — 역할 채널 관리 |
| `status.js` | `/status` — 봇 상태 확인 |
| `task.js` | `/task` — Task Graph 조회/제어 |

## 4. 기동 순서 (`index.ts`)

1. `data/config.json` 로드 및 설정 파싱
2. Discord Client × n(AI봇) + CmdBot Client 생성
3. Agent 인스턴스 × n 생성 (각자 LLMClient + AgentMCPManager 보유)
4. 봇별 MCP 서버 초기화 (병렬)
5. 전체 봇 동시 로그인 + ready 대기
6. 채널별 대화 히스토리 + 채널 컨텍스트(토픽+핀) 로드
7. 협력 채널 핀에서 봇 역할 자동 감지 → `agent.config.role` 주입
8. ROLE 카테고리 채널 핀 캐시 로드
9. 미완료 TaskGraph 재개
10. `messageCreate` 이벤트 → router 연결
11. 관리 웹 서버 시작 (Express)

## 5. 메시지 라우팅 흐름 (`router.ts`)

```
메시지 수신
  ├─ 봇 메시지
  │   ├─ [AGENT_MSG] 봉투 → handleHarnessMessage() (사이클 상태 관리)
  │   └─ 봇 @멘션 → 멘션된 봇 병렬 응답 (자기 멘션 제외, 연속 봇 턴 100회 한도)
  └─ 유저 메시지
      ├─ 협력 채널 → collaboration.handle() (멘션된 봇 순차 응답)
      └─ 그 외 채널
          ├─ !페르소나/!도움말 → 즉시 응답 (LLM 호출 없음)
          ├─ !목표 <goal>     → 히스토리 추가 후 respond() (오케스트레이터 LLM이 팀 위임)
          ├─ !자율 <goal>     → agent.startTaskGraph() (단독 자동 파이프라인)
          └─ @멘션 + 일반 대화 → agent.respond()
```

## 6. [AGENT_MSG] 봉투 프로토콜 (`agentProtocol.ts`)

봇 간 통신은 Discord 메시지에 다음 봉투 형식으로 이루어집니다:

```
[AGENT_MSG]
cycleId: <uuid>
turn: <integer>
from: <botId>
to: <botId | "SYSTEM_USER">
type: TASK_ASSIGN | TASK_RESULT | CONFIRM_REQUEST | CONFIRM_RESPONSE | ESCALATE
goalId: <string>

<body>
```

- `router.ts`가 `[AGENT_MSG]`로 시작하는 봇 메시지를 감지 → `handleHarnessMessage()`로 라우팅
- `CycleState`로 turn 한도 / rate-limit / 루프 감지 제어
- 기본값: `maxTurns=12`, `maxBotMsgs/min=20`, 루프 감지 임계=3회

## 7. 역할 컨텍스트 3단계 로딩 (`roleContext.ts`)

System prompt에 역할 내용 주입 시 다음 순서로 누적합니다:

```
Step 1 │ ROLE 카테고리 채널 (role/developer 등)
       │ 모든 프로젝트에 공통 적용되는 글로벌 역할 정의
       │ → /role init 으로 생성, /role reset 으로 초기화
       │
Step 2 │ 현재 채널의 카테고리 안 "role" 채널 (프로젝트A/role)
       │ 이 프로젝트(카테고리)에만 적용되는 커스텀 지침
       │ → 직접 핀 작성, 또는 회고를 통해 자동 제안
       │
Step 3 │ 현재 채널의 봇 멘션 핀 (<@봇ID> 형식)
       │ 이 채널에만 적용되는 개별 설정
       │ → /channel setup 으로 관리
```

## 8. Task 실행 방식

### !목표 — LLM 위임 방식
오케스트레이터 봇이 Role 핀에 따라 팀에 `[AGENT_MSG]`로 위임합니다:
```
오케스트레이터 → planner(분해) → developer(구현) → reviewer(리뷰) → tester(검증)
```
각 봇이 자신의 역할 핀 지침에 따라 자율 처리합니다.

### !자율 — 단독 자동 파이프라인
단일 에이전트가 전체 파이프라인을 직접 실행합니다:

1. LLM이 목표를 Task 배열로 분해 (`planner.ts`)
2. 각 Task가 Agent Workflow 파이프라인으로 실행:
   ```
   plannerNode → developerNode → reviewerNode → testerNode
   ```
   - **plannerNode**: LLM이 구현 계획 작성
   - **developerNode**: Claude Code로 코드 작성 (sessionKey=`${graphId}:${taskId}`)
     - `githubRepo` 설정 시: 브랜치 생성 → 커밋 → 푸시 → PR 생성
   - **reviewerNode**: LLM이 APPROVED/REVISION_NEEDED 판정 (최대 `maxReviewRetries`회 루프)
   - **testerNode**: Claude Code로 테스트 실행 (같은 세션 resume)
     - `githubRepo` 설정 시: `gh pr checks`로 CI 상태 확인
3. 완료 후 `retrospective.ts`에서 이슈 분석 → 역할 핀 개선 제안 생성
   - `[ROLE_UPDATE_PROPOSAL]` 메시지를 채널에 전송
   - 유저가 ✅ 반응 → 적용, ❌ 반응 → 폐기

## 9. LLM 클라이언트 (`llm.ts`)

| 클라이언트 | 설명 |
|---|---|
| `AnthropicClient` | 네이티브 Anthropic SDK, prompt-caching-2024-07-31 beta 사용. Computer Use 툴 포함 시 beta 자동 추가 |
| `OpenAICompatClient` | OpenAI SDK + baseUrl 스왑으로 Gemini/MiniMax 등 지원. Computer Use Beta 툴 자동 필터링 |
| `UnconfiguredLLMClient` | apiKey/model 미설정 시 호출마다 오류 반환하는 더미 |

시스템 프롬프트 + 툴 목록 마지막 항목에 `cache_control: ephemeral` 자동 마킹 (프롬프트 캐싱).

## 10. 데이터 영속성

| 데이터 | 저장 위치 | 비고 |
|---|---|---|
| 대화 히스토리 | 인메모리 (`history.ts`) | 재시작 시 Discord API에서 재로드 |
| Task Graph | `data/tasks/{id}.json` | 상태 변경마다 동기 저장 |
| 에이전트 설정 | `data/config.json` | `/github set` 등 커맨드로 런타임 수정 가능 |
| 페르소나 | `data/personas/{channelId}.md` | `update_persona` 툴로 수정 |
| 역할 핀 제안 | `data/proposals/{id}.json` | TTL 24h, 리액션 컨펌 방식 |
| Claude Code 세션 | 인메모리 (`claude-code.ts`) | 재시작 시 초기화 |

## 11. MCP 서버 관리 (`mcp.ts`)

- Claude Desktop `claude_desktop_config.json`에서 MCP 서버 목록 읽기
- `AgentConfig.mcpTokens` 값을 서버 프로세스 환경변수에 주입
- 봇마다 서로 다른 계정 토큰으로 Notion/Gmail 등 독립 접근 가능

> 슬래시 커맨드 전체 가이드: [COMMANDS.md](./COMMANDS.md)
