# CLAUDE.md

Claude AI가 이 프로젝트를 이해하기 위한 핵심 안내서.

## 프로젝트 개요

**discord-ai-team** — Discord 봇 위에서 동작하는 멀티 에이전트 오케스트레이션 시스템.
복수의 AI 봇(찌몽/아루/센세 등)이 각자 독립 채널에서 운영되며, 협력 채널에서 함께 작업합니다.

- **진입점:** `src/index.ts`
- **핵심 클래스:** `Agent` (`src/agent.ts`), `TaskGraph` (`src/task/graph.ts`)
- **고정 파이프라인:** `planner → developer → reviewer → tester`
- **언어/런타임:** TypeScript (strict mode), Node.js + ts-node
- **패키지 매니저:** npm
- **설정 소스:** `data/config.json` 단일 파일 (.env 미사용)
- **주요 라이브러리:** discord.js v14, @anthropic-ai/sdk, @modelcontextprotocol/sdk, openai, express

## 주요 명령어

| 명령어 | 설명 |
|---|---|
| `npm start` | 개발 서버 실행 (ts-node) |
| `npm run build` | TypeScript 컴파일 |
| `npm run prod` | 프로덕션 실행 (pm2) |
| `npx tsc --noEmit` | 타입 체크만 수행 |

## 아키텍처 요약

```
src/
├── index.ts          # 진입점 — 봇 초기화
├── agent.ts          # Agent 클래스 — 역할별 LLM 호출
├── router.ts         # 메시지 라우팅 및 봇 간 통신
├── history.ts        # 대화 히스토리 관리
├── task/
│   └── graph.ts      # TaskGraph — 파이프라인 실행 제어
├── config.ts         # AgentConfig / AppConfig 타입
└── commands/         # CmdBot JS 슬래시 커맨드 (AI 봇과 무관)
```

단일 Node.js 프로세스에서 복수의 Discord 클라이언트가 동시 실행됩니다.

- `!목표 <goal>` — 오케스트레이터 LLM이 Role 핀에 따라 `[AGENT_MSG]`로 팀에 위임합니다.
- `!자율 <goal>` — 단일 에이전트가 planner→developer→reviewer→tester 파이프라인을 직접 실행합니다.

봇 간 통신은 `[AGENT_MSG]` 봉투 프로토콜로 이루어지며, turn 한도/rate-limit/루프 감지로 보호됩니다.

**중요:** `commands/` 폴더는 CmdBot 전용 슬래시 커맨드이며, AI 에이전트 파이프라인과 무관하다.

자세한 내용 → [ARCHITECTURE.md](./ARCHITECTURE.md)

## 개발 규칙

- **TypeScript strict mode** — `any` 사용 금지, 모든 타입 명시
- **한국어 주석** — 코드 주석은 한국어로 작성
- **함수형 스타일** — 불필요한 클래스/추상화 지양 (클래스는 상태가 있을 때만)
- **불필요한 추상화 금지** — 실제 필요가 생기기 전까지 인터페이스 분리 금지
- **브랜치 전략:** `feature/{taskId}-{desc}` → 리뷰 후 main 머지

자세한 내용 → [development.md](./development.md)

## 주의사항

- `data/config.json`에 Discord 토큰, API 키 포함 — **절대 출력하거나 커밋하지 말 것**
- `dist/` 디렉토리는 빌드 결과물 — 직접 수정 금지
- `data/personas/` 파일명은 채널 ID (숫자).md 형태 (agent-a.md 같은 이름이 아님)
- `autonomousRoleUpdates: false`(기본값)이면 역할 핀 변경은 유저 컨펌 필요

## 문서 링크

| 문서 | 설명 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 모듈 맵, 프로토콜, 파이프라인 흐름 |
| [getting-started.md](./getting-started.md) | 설치, 환경 설정, 실행 방법 |
| [development.md](./development.md) | 코드 컨벤션, 브랜치 전략, 개발 명령어 |
| [api.md](./api.md) | AgentConfig/AppConfig 타입, API 명세 |
| [contributing.md](./contributing.md) | 새 역할 추가법, PR 가이드, 테스트 체크리스트 |
| [COMMANDS.md](./COMMANDS.md) | 슬래시 커맨드 전체 가이드 |
