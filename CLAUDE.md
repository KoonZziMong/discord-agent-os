# discord-ai-team 프로젝트

Discord 멀티 에이전트 AI 봇 시스템. 3개의 봇(찌몽/아루/센세)이 각자 독립된 채널에서 운영됩니다.

## 기술 스택
- **언어**: TypeScript (strict)
- **런타임**: Node.js + ts-node
- **주요 라이브러리**: discord.js v14, @anthropic-ai/sdk, @modelcontextprotocol/sdk

## 프로젝트 구조
```
src/
  index.ts        — 진입점, 봇 초기화 및 이벤트 바인딩
  agent.ts        — Agent 클래스 (대화 응답, 툴 실행)
  router.ts       — Discord 메시지 라우팅
  collaboration.ts — 협력 채널 오케스트레이터
  llm.ts          — LLM 클라이언트 추상화 (Anthropic / OpenAI 호환)
  mcp.ts          — MCP 서버 관리
  tools.ts        — 툴 정의 (update_persona, claude_code, Computer Use)
  claude-code.ts  — Claude Code CLI 연동 및 세션 관리
  history.ts      — 채널별 인메모리 대화 히스토리
  config.ts       — 설정 로드 (data/config.json)
  persona.ts      — 페르소나 파일 로드/수정
  computer.ts     — macOS Computer Use 구현
  utils.ts        — 공통 유틸리티
  task/
    types.ts      — Task/TaskGraph 타입 정의
    graph.ts      — TaskGraph 클래스 (상태 관리)
    planner.ts    — LLM으로 목표 → 태스크 분해
    runner.ts     — Task Graph 순차 실행 루프
    store.ts      — JSON 파일 영속화 (data/tasks/)
  agentGraph/
    types.ts      — WorkflowContext/WorkflowResult 인터페이스
    executor.ts   — 파이프라인 실행기 (planner→developer→reviewer→tester)
    nodes/
      plannerNode.ts   — LLM으로 구현 계획 수립
      developerNode.ts — Claude Code로 코드 작성 + Git 워크플로우
      reviewerNode.ts  — LLM 코드 리뷰 (APPROVED/REVISION_NEEDED)
      testerNode.ts    — Claude Code로 테스트 실행 + CI 확인

data/
  config.json     — 봇 설정 (토큰, 채널 ID, 에이전트 설정)
  personas/
    agent-a.md    — 찌몽 페르소나
    agent-b.md    — 아루 페르소나
    agent-c.md    — 센세 페르소나
  tasks/          — Task Graph JSON 파일 (graphId.json)
```

## 코딩 컨벤션
- TypeScript strict 모드
- 함수형 스타일 선호 (클래스는 Agent처럼 상태가 있을 때만)
- 비동기는 async/await
- 에러는 `err instanceof Error ? err.message : String(err)` 패턴
- 한국어 주석 사용
- 불필요한 추상화 금지 — 필요한 만큼만

## Task Graph 실행 흐름
`!목표 <goal>` 입력 시:
1. LLM이 목표를 Task 배열로 분해 (planner.ts)
2. 각 Task가 Agent Workflow 파이프라인으로 실행:
   - **plannerNode**: LLM이 구현 계획 작성
   - **developerNode**: Claude Code로 코드 작성 (sessionKey=`${graphId}:${taskId}`)
     - `githubRepo` 설정 시: 브랜치 생성→커밋→푸시→PR 생성 (`gh pr create`)
   - **reviewerNode**: LLM이 APPROVED/REVISION_NEEDED 판정 (최대 2회 루프)
   - **testerNode**: Claude Code로 테스트 실행 (같은 세션 resume)
     - `githubRepo` 설정 시: `gh pr checks`로 CI 상태 확인

## GitHub 워크플로우 설정
`config.json` 에이전트 설정에 `githubRepo` 추가:
```json
{ "id": "zzimong", "githubRepo": "owner/repo-name", ... }
```
- 브랜치명: `feature/{taskId}-{taskTitle}`
- `gh` CLI가 설치되어 있고 `gh auth login` 완료 상태여야 합니다.

## 주의사항
- `data/config.json`에 Discord 토큰, API 키 등 민감 정보 포함 — 절대 출력하지 말 것
- `dist/` 디렉토리는 빌드 결과물 — 직접 수정 금지
- MCP 서버 설정은 `config.json`의 `mcpTokens` 필드로 관리
- Claude Code 세션은 인메모리 — 봇 재시작 시 세션 초기화됨
