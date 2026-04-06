# 내부 API 명세

> 이 문서는 코드 기준으로 작성됩니다. 코드가 변경되면 문서도 함께 업데이트하세요.

## 1. 핵심 타입 정의 (`config.ts`)

### AgentConfig

에이전트(AI 봇) 하나의 설정을 표현합니다.

```typescript
interface AgentConfig {
  id: string;          // Discord User ID
  name: string;        // 표시 이름
  role?: string;       // 하네스 역할명 (orchestrator/planner/developer/reviewer/tester/researcher)
  discordToken: string;
  personaFile: string; // 절대 경로 (data/personas/{channelId}.md)
  provider: string;    // "anthropic" | "openai" | "gemini" | "minimax"
  apiKey: string;
  model: string;
  baseUrl?: string;    // OpenAI-compat endpoint (Gemini/MiniMax 등)
  mcpTokens: Record<string, string>;
  computerUse?: boolean;
  githubRepo?: string; // "owner/repo" 형식
}
```

### AppConfig

전체 시스템 설정입니다.

```typescript
interface CmdBotConfig {
  discordToken: string;
  provider?: string;
  apiKey?: string;
  model?: string;
}

interface CommandsConfig {
  persona: string[];    // 기본: ["!페르소나", "!persona"]
  help: string[];       // 기본: ["!도움말", "!help"]
  task: string[];       // 기본: ["!목표", "!task"] — LLM 위임 방식
  autonomous: string[]; // 기본: ["!자율", "!pipeline"] — 단독 자동 파이프라인
}

interface AppConfig {
  agents: AgentConfig[];
  cmdBot?: CmdBotConfig;
  collabChannel: string;          // 협력 채널 ID
  guildId?: string;               // Discord 서버 ID
  adminPort: number;              // 관리 웹 서버 포트 (기본 3000)
  adminHost?: string;             // 바인딩 호스트 (기본 127.0.0.1)
  toolBots: Record<string, string>; // 툴봇 username → MCP 서버명 매핑
  historyLimit: number;           // 채널당 히스토리 보관 건수 (기본 20)
  channelLimits: Record<string, number>;
  githubRepos: string[];          // 글로벌 레포 목록
  commands: CommandsConfig;
  maxReviewRetries: number;       // reviewerNode 최대 재시도 횟수 (기본 2)
  maxTurnsPerCycle: number;       // 사이클당 최대 봇 턴 (기본 12)
  maxCycleMinutes: number;        // 사이클 최대 시간(분, 기본 30)
  autonomousRoleUpdates: boolean; // false이면 역할 핀 변경에 유저 컨펌 필요
}
```

## 2. Agent 클래스 (`agent.ts`)

```typescript
class Agent {
  config: AgentConfig;
  client: Client;       // Discord.js 클라이언트

  // 채널에서 일반 대화 응답 (LLM 호출)
  respond(message: Message, options?: RespondOptions): Promise<void>;

  // !목표 커맨드로 TaskGraph 시작
  startTaskGraph(message: Message, goal: string): Promise<void>;
}
```

## 3. TaskGraph 클래스 (`task/graph.ts`)

```typescript
class TaskGraph {
  id: string;
  goal: string;
  tasks: Task[];
  status: 'pending' | 'running' | 'completed' | 'failed';

  // 상태 변경 + 자동 파일 영속화
  updateTask(taskId: string, updates: Partial<Task>): void;

  // 재시작 복구: running 태스크를 pending으로 초기화
  resetForResume(): void;
}
```

### Task 타입

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  dependsOn: string[];  // 선행 태스크 ID 배열
  result?: string;
  error?: string;
}
```

## 4. [AGENT_MSG] 봉투 프로토콜 (`agentProtocol.ts`)

### 봉투 형식

```
[AGENT_MSG]
cycleId: <uuid>
turn: <integer>
from: <botId>
to: <botId | "SYSTEM_USER">
type: <MessageType>
goalId: <string>

<body>
```

### MessageType 열거형

| 타입 | 설명 |
|---|---|
| `TASK_ASSIGN` | 오케스트레이터 → 작업자: 태스크 할당 |
| `TASK_RESULT` | 작업자 → 오케스트레이터: 작업 결과 보고 |
| `CONFIRM_REQUEST` | 작업자 → 유저: 확인 요청 |
| `CONFIRM_RESPONSE` | 유저 → 작업자: 확인 응답 |
| `ESCALATE` | 작업자 → 오케스트레이터: 문제 에스컬레이션 |

### CycleState 안전장치

| 설정 | 기본값 | 설명 |
|---|---|---|
| `maxTurns` | 12 | 사이클당 최대 봇 메시지 턴 수 |
| `maxBotMsgs/min` | 20 | 분당 최대 봇 메시지 수 (rate-limit) |
| 루프 감지 임계 | 3 | 동일 패턴 반복 감지 횟수 |

## 5. 역할 컨텍스트 API (`roleContext.ts`)

```typescript
// 채널 ID와 봇 ID를 받아 3단계 역할 컨텍스트 문자열 반환
async function loadRoleContext(
  channelId: string,
  botId: string,
  client: Client
): Promise<string>;
```

반환 형식: 각 Step의 핀 내용을 줄바꿈으로 연결한 문자열.
비어있는 Step은 건너뜁니다.

## 6. 채널 컨텍스트 API (`channelContext.ts`)

```typescript
// 채널 토픽 + 핀 메시지를 캐시에서 읽어 system prompt용 문자열 반환
async function getChannelContext(
  channelId: string,
  botId: string
): Promise<string>;

// 채널 컨텍스트 캐시 강제 갱신
async function refreshChannelContext(channelId: string): Promise<void>;
```

## 7. 관리 웹 API (`admin/`)

기본 주소: `http://127.0.0.1:{adminPort}` (외부 노출 없음)

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/config` | GET | 전체 AppConfig 반환 (민감 정보 마스킹) |
| `/api/config/agent/:id` | PATCH | 특정 에이전트 설정 수정 |
| `/api/discord/channels` | GET | 서버 채널 목록 |
| `/api/discord/bots` | GET | 봇 목록 및 온라인 상태 |
| `/api/role-update` | POST | 역할 핀 직접 수정 |

## 8. 채팅 명령어 (슬래시 커맨드 아님)

채팅에서 직접 입력하는 텍스트 명령어입니다.

| 명령어 | 설명 |
|---|---|
| `!목표 @봇 <목표>` | 봇에게 Task Graph 실행 요청 |
| `!task @봇 <목표>` | 위와 동일 |
| `!페르소나` | 봇의 현재 페르소나 확인 |
| `!도움말` | 봇 사용 가이드 출력 |

슬래시 커맨드 전체 규격: [COMMANDS.md](./COMMANDS.md)

## 9. Agent Workflow 파이프라인 인터페이스 (`agentGraph/types.ts`)

```typescript
interface WorkflowContext {
  graphId: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  plan?: string;         // plannerNode 결과
  prUrl?: string;        // developerNode 결과
  reviewComment?: string;
  testResult?: string;
}

interface WorkflowResult {
  success: boolean;
  summary: string;
  prUrl?: string;
}
```
