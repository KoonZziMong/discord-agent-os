# 아키텍처

## 전체 구조

```
Discord 사용자
    │
    ├─ 메시지 (@멘션, !목표)
    │       └─→ AI 봇 (찌몽 / 아루 / 센세)
    │                   │
    │                   ├─ 일반 대화 → LLM 응답
    │                   └─ !목표 → Task Graph 실행
    │
    └─ 슬래시 커맨드 (/task, /github, /status)
            └─→ CmdBot (전담 처리)
```

## 봇 구성

프로세스 하나에서 4개의 Discord 클라이언트가 동시에 실행됩니다.

| 봇 | 역할 | Discord 인텐트 |
|---|---|---|
| 찌몽 / 아루 / 센세 | AI 대화 + Task Graph 실행 | Guilds, GuildMessages, MessageContent |
| CmdBot | 슬래시 커맨드 전담 | Guilds |

AI 봇과 CmdBot을 분리한 이유: Discord는 봇 계정당 슬래시 커맨드를 등록하므로, 3개의 AI 봇에 커맨드를 등록하면 서버에 동일 커맨드가 3벌 노출됩니다. CmdBot에 집중시켜 이를 방지합니다.

## 디렉토리 구조

```
discord-agent-os/
├── src/
│   ├── index.ts             # 진입점 — 봇 초기화, 이벤트 바인딩, 재시작 복구
│   ├── agent.ts             # Agent 클래스 — 대화 응답, Task Graph 실행
│   ├── router.ts            # Discord 메시지 → 적절한 에이전트로 라우팅
│   ├── collaboration.ts     # 협력 채널 오케스트레이터
│   ├── llm.ts               # LLM 클라이언트 추상화 (Anthropic / OpenAI 호환)
│   ├── mcp.ts               # MCP 서버 연결 관리
│   ├── tools.ts             # 툴 정의 (update_persona, claude_code, Computer Use)
│   ├── claude-code.ts       # Claude Code CLI 연동 및 세션 관리
│   ├── history.ts           # 채널별 인메모리 대화 히스토리
│   ├── config.ts            # data/config.json 로드 및 타입 정의
│   ├── persona.ts           # 페르소나 파일 로드 / 수정
│   ├── computer.ts          # macOS Computer Use 구현
│   ├── utils.ts             # 공통 유틸리티
│   ├── task/
│   │   ├── types.ts         # Task / TaskGraphData 타입
│   │   ├── graph.ts         # TaskGraph 클래스 — 상태 변경 + 영속화
│   │   ├── planner.ts       # LLM으로 목표 → Task 배열 분해
│   │   ├── runner.ts        # Task Graph 실행 루프 (병렬 + 실시간 상태)
│   │   └── store.ts         # JSON 파일 I/O (data/tasks/)
│   └── agentGraph/
│       ├── types.ts         # WorkflowContext / WorkflowResult 인터페이스
│       ├── executor.ts      # 파이프라인 실행기
│       └── nodes/
│           ├── plannerNode.ts    # LLM으로 구현 계획 수립
│           ├── developerNode.ts  # Claude Code로 코드 작성 + Git 워크플로우
│           ├── reviewerNode.ts   # LLM 코드 리뷰 (APPROVED / REVISION_NEEDED)
│           └── testerNode.ts     # Claude Code로 테스트 실행 + CI 확인
├── commands/
│   ├── task.js              # /task 슬래시 커맨드
│   ├── github.js            # /github 슬래시 커맨드
│   └── status.js            # /status 슬래시 커맨드
├── data/
│   ├── config.json          # 봇 설정 (토큰, 채널 ID 등) — git 제외
│   ├── personas/            # 에이전트별 페르소나 마크다운
│   └── tasks/               # Task Graph JSON 파일 — git 제외
└── deploy-commands.js       # 슬래시 커맨드 Discord 등록 스크립트
```

## Task Graph 실행 흐름

### 1. 목표 입력

사용자가 `!목표 <goal>`을 입력하면 `router.ts`가 감지하고 `agent.startTaskGraph()`를 호출합니다.

### 2. Task 분해 (planner.ts)

LLM이 목표를 분석해 의존 관계가 있는 Task 배열로 분해합니다.

```
목표: "사용자 인증 API 구현"
  ├── [T1] DB 스키마 설계
  ├── [T2] JWT 유틸 구현  (depends: T1)
  ├── [T3] 로그인 엔드포인트  (depends: T2)
  └── [T4] 테스트 작성  (depends: T3)
```

### 3. 병렬 실행 (runner.ts)

의존성이 해소된 태스크는 `Promise.all()`로 동시에 실행됩니다. Discord에 단일 상태 메시지가 전송되고, 각 태스크 상태가 바뀔 때마다 실시간으로 수정됩니다.

```
🗂️ 사용자 인증 API 구현

⚙️ [T1] DB 스키마 설계 (실행 중...)
⏳ [T2] JWT 유틸 구현
⏳ [T3] 로그인 엔드포인트
⏳ [T4] 테스트 작성

-# 진행 0/4 | 경과 12초
```

### 4. Agent Workflow 파이프라인 (agentGraph/)

각 태스크는 4단계 파이프라인으로 처리됩니다.

```
plannerNode
    │  LLM이 태스크의 구체적 구현 계획을 작성
    ↓
developerNode
    │  Claude Code CLI로 실제 코드를 작성
    │  githubRepo 설정 시: 브랜치 생성 → 커밋 → 푸시 → PR 생성
    ↓
reviewerNode
    │  LLM이 코드를 리뷰하여 APPROVED / REVISION_NEEDED 판정
    │  REVISION_NEEDED면 developerNode 재실행 (최대 2회)
    ↓
testerNode
       Claude Code CLI로 테스트 실행 (developer와 동일 세션 유지)
       githubRepo 설정 시: gh pr checks로 CI 상태 확인
```

#### Claude Code 세션 관리

태스크마다 `sessionKey = "${graphId}:${taskId}"`로 세션을 격리합니다. developer와 tester는 같은 키로 세션을 공유하므로, tester가 developer가 작성한 코드 맥락을 그대로 이어받습니다.

## 메시지 라우팅

```
messageCreate 이벤트
    │
    ├─ 발신자가 봇이면 → 무시 (단, 협력 채널은 봇 메시지도 히스토리에 포함)
    ├─ 채널이 설정 채널이면 → agent.respond(mode: 'config')
    ├─ !목표 prefix → agent.startTaskGraph()
    ├─ 협력 채널이면 → collaboration.ts 오케스트레이터
    └─ 그 외 → agent.respond(mode: 'chat')
```

멘션에 `@툴봇`이 포함되어 있으면 해당 MCP 서버 툴을 활성화합니다. 아무 멘션도 없으면 `claude_code` 툴만 사용하는 순수 대화 모드로 동작합니다.

## 재시작 복구

봇이 재시작되면 `data/tasks/`의 JSON 파일을 읽어 `status: 'running'`인 그래프를 자동으로 재개합니다.

- `resetForResume()`: running 상태였던 태스크를 pending으로 초기화 (중간에 끊긴 Claude Code 세션은 복구 불가이므로 처음부터 재실행)
- `/task retry`: 사용자가 수동으로 실패한 그래프를 다시 running 상태로 만들고, 봇 재시작 시 자동 재개

## GitHub 연동

`config.json` 에이전트 설정에 `githubRepo: "owner/repo"`를 지정하면 활성화됩니다.

```
developerNode 실행 시:
  1. git checkout -b feature/{taskId}-{taskTitle}
  2. 코드 작성 및 커밋
  3. git push origin <branch>
  4. gh pr create --title "..." --body "..."

testerNode 실행 시:
  5. 테스트 스크립트 실행
  6. gh pr checks (CI 상태 폴링)
```

요구사항: `gh` CLI 설치 및 `gh auth login` 완료, 봇 git 계정 설정 (`git config user.name`, `user.email`).

## 데이터 영속성

인메모리 상태와 파일 기반 영속성을 혼합합니다.

| 데이터 | 저장 위치 | 비고 |
|---|---|---|
| 대화 히스토리 | 인메모리 (`history.ts`) | 재시작 시 Discord API에서 재로드 |
| Task Graph | `data/tasks/{id}.json` | 상태 변경마다 동기 저장 |
| 에이전트 설정 | `data/config.json` | `/github set` 등 커맨드로 런타임 수정 가능 |
| 페르소나 | `data/personas/*.md` | `update_persona` 툴로 수정 |
| Claude Code 세션 | 인메모리 (`claude-code.ts`) | 재시작 시 초기화 |
