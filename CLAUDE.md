# discord-ai-team 프로젝트

Discord 멀티 에이전트 AI 봇 시스템. 3개의 AI 봇(찌몽/아루/센세)이 각자 독립된 채널에서 운영되며, 협력 채널에서 함께 작업합니다.

## 기술 스택
- **언어**: TypeScript (strict)
- **런타임**: Node.js + ts-node
- **주요 라이브러리**: discord.js v14, @anthropic-ai/sdk, @modelcontextprotocol/sdk, openai, express
- **빌드**: `npm run build` (tsc) / 개발: `npm start` (ts-node)
- **프로세스 관리**: pm2 (`npm run prod`)
- **설정 소스**: `data/config.json` 단일 파일 (.env 미사용)

## 프로젝트 구조
```
src/
  index.ts          — 진입점: 봇 초기화, 이벤트 바인딩, graceful shutdown
  agent.ts          — Agent 클래스 (대화 응답, 툴 실행, TaskGraph 관리)
  router.ts         — Discord 메시지 라우팅 (유저/봇 메시지 분기, 하네스 라우팅)
  collaboration.ts  — 협력 채널 오케스트레이터 (멘션 기반 순차 응답)
  agentProtocol.ts  — 봇 간 통신 프로토콜 ([AGENT_MSG] 봉투, 팀 매니페스트, 사이클 상태)
  llm.ts            — LLM 클라이언트 추상화 (Anthropic / OpenAI 호환, 프롬프트 캐싱)
  mcp.ts            — 봇별 MCP 서버 관리 (Claude Desktop config 읽기, subprocess 실행)
  tools.ts          — 툴 정의 (update_persona, claude_code, Computer Use)
  claude-code.ts    — Claude Code CLI 연동 및 세션 관리
  history.ts        — 채널별 인메모리 대화 히스토리
  channelContext.ts — 채널 토픽 + 핀 메시지 캐시 (system prompt에 주입)
  roleContext.ts    — 역할 채널 컨텍스트 3단계 로딩 (글로벌/프로젝트/채널)
  roleProposals.ts  — 역할 핀 업데이트 제안 관리 (파일 영속화, TTL 24h)
  retrospective.ts  — 사이클 완료 후 회고 및 역할 핀 개선 제안 생성
  config.ts         — 설정 로드/저장 (data/config.json)
  persona.ts        — 페르소나 파일 로드/수정
  computer.ts       — macOS Computer Use 구현
  utils.ts          — 공통 유틸리티 (sendSplit, keepTyping, delay, getErrorMessage)
  task/
    types.ts        — Task/TaskGraph 타입 정의
    graph.ts        — TaskGraph 클래스 (상태 관리, 자동 영속화)
    planner.ts      — LLM으로 목표 → Task 배열 분해
    runner.ts       — Task Graph 순차 실행 루프
    store.ts        — JSON 파일 영속화 (data/tasks/)
  agentGraph/
    types.ts        — WorkflowContext/WorkflowResult 인터페이스
    executor.ts     — 파이프라인 실행기 (planner→developer→reviewer→tester)
    nodes/
      plannerNode.ts   — LLM으로 구현 계획 수립
      developerNode.ts — Claude Code로 코드 작성 + Git 워크플로우
      reviewerNode.ts  — LLM 코드 리뷰 (APPROVED/REVISION_NEEDED)
      testerNode.ts    — Claude Code로 테스트 실행 + CI 확인
  admin/
    server.ts       — 관리 웹 서버 (Express, 기본 127.0.0.1:3000)
    hotreload.ts    — 설정 핫리로드
    routes/
      config.ts     — /api/config 에이전트 설정 CRUD
      discord.ts    — /api/discord 채널/봇 목록 조회
      roleUpdate.ts — /api/role-update 역할 핀 직접 수정

commands/           — CmdBot 슬래시 커맨드 (JS, AI 파이프라인과 별개)
  channel.js        — /channel (채널 설정)
  github.js         — /github (레포 관리)
  project.js        — /project (프로젝트 생성/관리)
  role.js           — /role (역할 채널 관리)
  status.js         — /status (봇 상태 확인)
  task.js           — /task (태스크 조회)

data/
  config.json       — 봇 설정 (토큰, 채널 ID, 에이전트 설정)
  personas/         — 봇별 페르소나 마크다운 파일 (channelId.md 형태)
  tasks/            — Task Graph JSON 파일 (graphId.json)
  proposals/        — 역할 핀 업데이트 제안 JSON (proposalId.json)

public/
  admin.html        — 관리 웹 UI

docs/
  ARCHITECTURE.md   — 아키텍처 문서
  COMMANDS.md       — 슬래시 커맨드 가이드
  CLAUDE.md         — AI 에이전트용 간결 가이드
  api.md            — AgentConfig/AppConfig 타입, API 명세
  development.md    — 코드 컨벤션, 브랜치 전략
  contributing.md   — 새 역할 추가법, PR 가이드
  getting-started.md — 설치, 환경 설정, 실행 방법
```

## 핵심 타입 및 인터페이스

### AgentConfig (config.ts)
```typescript
interface AgentConfig {
  id: string;          // Discord User ID
  name: string;        // 표시 이름
  role?: string;       // 하네스 역할명 (orchestrator/planner/developer/reviewer/tester/researcher)
  discordToken: string;
  personaFile: string; // 절대 경로
  provider: string;    // "anthropic" | "openai" | "gemini" | "minimax"
  apiKey: string;
  model: string;
  baseUrl?: string;    // OpenAI-compat endpoint
  mcpTokens: Record<string, string>;
  computerUse?: boolean;
  githubRepo?: string; // "owner/repo" 형식
}
```

### AppConfig (config.ts)
주요 필드: `agents[]`, `cmdBot`, `collabChannel`, `guildId`, `adminPort`, `toolBots`, `historyLimit`, `channelLimits`, `githubRepos`, `commands`, `maxReviewRetries`, `maxTurnsPerCycle`, `maxCycleMinutes`, `autonomousRoleUpdates`

### CommandsConfig (config.ts)
```typescript
interface CommandsConfig {
  persona: string[];    // 기본: ["!페르소나", "!persona"]
  help: string[];       // 기본: ["!도움말", "!help"]
  task: string[];       // 기본: ["!목표", "!task"] — LLM 위임 방식
  autonomous: string[]; // 기본: ["!자율", "!pipeline"] — 단독 자동 파이프라인
}
```

### [AGENT_MSG] 봉투 프로토콜 (agentProtocol.ts)
봇 간 통신은 Discord 메시지에 봉투 형식으로 이루어집니다:
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
- 기본값: maxTurns=12, maxBotMsgs/min=20, 루프 감지 임계=3회

## 기동 순서 (index.ts)
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

## 메시지 라우팅 흐름 (router.ts)
```
메시지 수신
  ├─ 봇 메시지
  │   ├─ [AGENT_MSG] 봉투 → handleHarnessMessage() (사이클 상태 관리)
  │   └─ 봇 @멘션 → 멘션된 봇 병렬 응답 (자기 멘션 제외, 연속 봇 턴 100회 한도)
  └─ 유저 메시지
      ├─ 협력 채널 → collaboration.handle() (멘션된 봇 순차 응답)
      └─ 그 외 채널
          ├─ !페르소나/!도움말 → 즉시 응답 (LLM 호출 없음)
          ├─ !목표 <goal>     → 히스토리 추가 후 respond() (오케스트레이터가 팀 위임)
          ├─ !자율 <goal>     → agent.startTaskGraph() (단독 자동 파이프라인)
          └─ @멘션 + 일반 대화 → agent.respond()
```

## 역할 컨텍스트 3단계 로딩 (roleContext.ts)
System prompt에 역할 내용 주입 시 다음 순서로 누적합니다:
1. **Step 1** — `ROLE` 카테고리 채널 (`role/developer` 등): 모든 프로젝트 공통 글로벌 역할 정의
2. **Step 2** — 현재 채널 카테고리 안 `role` 채널 (`프로젝트A/role`): 프로젝트 커스텀 지침
3. **Step 3** — 현재 채널의 봇 멘션 핀 (`<@botId>`): 채널 개별 설정

## Task 실행 방식
### !목표 (LLM 위임 방식)
오케스트레이터 봇이 Role 핀에 따라 팀에 [AGENT_MSG]로 위임합니다:
- 오케스트레이터 → planner(분해) → developer(구현) → reviewer(리뷰) → tester(검증)
- 각 봇이 자신의 역할 핀 지침에 따라 자율 처리

### !자율 (단독 자동 파이프라인)
단일 에이전트가 전체 파이프라인을 직접 실행합니다:
1. LLM이 목표를 Task 배열로 분해 (`planner.ts`)
2. 각 Task가 Agent Workflow 파이프라인으로 실행:
   - **plannerNode**: LLM이 구현 계획 작성
   - **developerNode**: Claude Code로 코드 작성 (sessionKey=`${graphId}:${taskId}`)
   - **reviewerNode**: LLM이 APPROVED/REVISION_NEEDED 판정 (최대 `maxReviewRetries`회 루프)
   - **testerNode**: Claude Code로 테스트 실행 (같은 세션 resume)
3. 완료 후 `retrospective.ts`에서 역할 핀 개선 제안 생성

## GitHub 워크플로우 설정
`config.json` 에이전트 설정에 `githubRepo` 추가:
```json
{ "id": "zzimong", "githubRepo": "owner/repo-name", ... }
```
- Developer 봇 브랜치명: `developer/{taskId}-{desc}`
- `gh` CLI가 설치되어 있고 `gh auth login` 완료 상태여야 합니다.

## LLM 클라이언트 (llm.ts)
- **AnthropicClient**: 네이티브 Anthropic SDK, prompt-caching-2024-07-31 beta 사용
- **OpenAICompatClient**: OpenAI SDK + baseUrl 스왑으로 Gemini/MiniMax 등 지원
- **UnconfiguredLLMClient**: apiKey/model 미설정 시 호출마다 오류 반환하는 더미

## 코딩 컨벤션
- TypeScript strict 모드
- 함수형 스타일 선호 (클래스는 Agent처럼 상태가 있을 때만)
- 비동기는 async/await
- 에러는 `err instanceof Error ? err.message : String(err)` 패턴
- 한국어 주석 사용
- 불필요한 추상화 금지 — 필요한 만큼만
- `commands/` 폴더: CmdBot JS 슬래시 커맨드 (AI 파이프라인과 무관, 수정 주의)

## 주의사항
- `data/config.json`에 Discord 토큰, API 키 등 민감 정보 포함 — 절대 출력하지 말 것
- `.env` 파일이 없고 `data/config.json`이 단일 설정 소스입니다
- `dist/` 디렉토리는 빌드 결과물 — 직접 수정 금지
- MCP 서버 설정은 `config.json`의 `mcpTokens` 필드로 관리
- Claude Code 세션은 인메모리 — 봇 재시작 시 세션 초기화됨
- `data/personas/` 파일명은 채널 ID (숫자).md 형태입니다 (agent-a/b/c.md가 아님)
- `autonomousRoleUpdates: false`(기본값)이면 역할 핀 변경은 유저 컨펌 필요
