# discord-ai-team 프로젝트

Discord 멀티 에이전트 AI 봇 시스템. 복수의 AI 봇(찌몽/아루/센세 등)이 각자 독립 채널에서 운영되며, 협력 채널에서 함께 작업합니다.

## 기술 스택

- **언어**: TypeScript (strict) / **런타임**: Node.js + ts-node
- **주요 라이브러리**: discord.js v14, @anthropic-ai/sdk, @modelcontextprotocol/sdk, openai, express
- **빌드**: `npm run build` (tsc) / 개발: `npm start` (ts-node) / 프로덕션: `npm run prod` (pm2)
- **설정 소스**: `data/config.json` 단일 파일 (.env 미사용)

## 빠른 시작

```bash
npm install
cp data/config.example.json data/config.json  # 설정 파일 준비
npm start
```

자세한 내용: [docs/getting-started.md](./docs/getting-started.md)

## 핵심 아키텍처

단일 Node.js 프로세스에서 복수의 Discord 클라이언트가 동시 실행됩니다.
`!목표 <goal>` → planner → developer → reviewer → tester 파이프라인으로 Task Graph를 실행합니다.
봇 간 통신은 `[AGENT_MSG]` 봉투 프로토콜로 이루어지며, turn 한도/rate-limit/루프 감지로 보호됩니다.

자세한 내용: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## 개발 규칙 요약

- 한국어 주석 사용
- 함수형 스타일 선호 (클래스는 상태가 있을 때만)
- 불필요한 추상화 금지 — 필요한 만큼만

자세한 내용: [docs/development.md](./docs/development.md)

## 주의사항

- `data/config.json`에 Discord 토큰, API 키 포함 — **절대 출력하거나 커밋하지 말 것**
- `dist/` 디렉토리는 빌드 결과물 — 직접 수정 금지
- `data/personas/` 파일명은 채널 ID (숫자).md 형태 (agent-a.md 같은 이름이 아님)
- `commands/` 폴더: CmdBot JS 슬래시 커맨드 (AI 파이프라인과 무관, 수정 주의)
- `autonomousRoleUpdates: false`(기본값)이면 역할 핀 변경은 유저 컨펌 필요

## 문서 인덱스

| 문서 | 내용 |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 시스템 구조, 모듈 맵, 프로토콜 명세 |
| [docs/getting-started.md](./docs/getting-started.md) | 설치, 환경 설정, 최초 실행 |
| [docs/development.md](./docs/development.md) | 코드 컨벤션, 브랜치 전략, 개발 명령어 |
| [docs/api.md](./docs/api.md) | 내부 인터페이스 및 API 명세 |
| [docs/contributing.md](./docs/contributing.md) | 기여 방법, PR 가이드, 역할 추가법 |
| [docs/COMMANDS.md](./docs/COMMANDS.md) | 슬래시 커맨드 전체 가이드 |
