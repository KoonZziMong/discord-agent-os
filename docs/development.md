# 개발 가이드

## 1. 개발 환경 세팅

```bash
git clone https://github.com/KoonZziMong/discord-agent-os.git
cd discord-agent-os
npm install
cp data/config.example.json data/config.json  # 설정 파일 준비
npm start                                      # ts-node로 바로 실행
```

TypeScript strict 모드가 활성화되어 있습니다. `tsconfig.json`에서 `"strict": true` 설정을 확인하세요.

## 2. 코드 컨벤션

### 언어 및 스타일
- **TypeScript strict 모드** — 암시적 any, 널 체크 누락 등 불허
- **함수형 스타일 선호** — 클래스는 `Agent`처럼 상태가 있을 때만 사용
- **비동기**: 항상 `async/await` (Promise 체인 지양)
- **에러 처리 패턴**: `err instanceof Error ? err.message : String(err)`
- **주석**: 한국어 사용

### 추상화 원칙
- 불필요한 추상화 금지 — 필요한 만큼만
- 한 번만 쓰는 헬퍼/유틸리티 함수 생성 금지
- 세 줄의 유사한 코드가 섣부른 추상화보다 낫습니다

### 디렉토리 역할 분리

| 디렉토리 | 역할 | 수정 주의 |
|---|---|---|
| `src/` | AI 봇 런타임 코드 (TypeScript) | 자유롭게 수정 가능 |
| `commands/` | CmdBot 슬래시 커맨드 (JavaScript) | AI 파이프라인과 무관 — 별도 주의 |
| `dist/` | 빌드 결과물 | **직접 수정 금지** |
| `data/` | 런타임 데이터 | config.json, personas/, tasks/ |

### `commands/` 폴더 주의사항

`commands/*.js` 파일은 CmdBot이 단독으로 실행하는 Discord 슬래시 커맨드입니다.
AI 봇 파이프라인(`src/`)과 완전히 분리된 코드이므로 수정 시 독립적으로 테스트해야 합니다.

## 3. 주요 개발 명령어

```bash
npm start          # 개발 실행 (ts-node src/index.ts)
npm run build      # TypeScript 컴파일 (dist/ 생성)
npm run prod       # pm2로 프로덕션 실행

npx tsc --noEmit   # 타입 체크만 (파일 생성 없음)

node deploy-commands.js   # 슬래시 커맨드 Discord 등록
```

## 4. 브랜치 전략

```
main            — 프로덕션 브랜치
feature/T{n}-{desc}   — 태스크 기반 기능 브랜치
```

예시:
```bash
git checkout -b feature/T3-add-researcher-role
```

## 5. 커밋 메시지 규칙

```
feat: 새 기능 추가
fix: 버그 수정
refactor: 리팩토링 (기능 변경 없음)
docs: 문서 수정
chore: 빌드 스크립트, 설정 변경
```

예시:
```
feat: retrospective에서 project 레벨 제안 지원 추가
fix: roleContext Step 2 채널이 없을 때 오류 수정
```

## 6. 설정 변경 시 주의사항

`data/config.json`은 런타임 중에도 관리 웹 서버 API(`/api/config`)로 수정 가능합니다.
코드에서 config를 읽을 때는 `config.ts`의 `getConfig()` 함수를 통해 접근하세요.

- `data/config.json`에 Discord 토큰, API 키 등 민감 정보 포함 — **절대 출력하거나 커밋하지 말 것**
- `.env` 파일이 없고 `data/config.json`이 단일 설정 소스입니다
- `autonomousRoleUpdates: false`(기본값)이면 역할 핀 변경은 유저 컨펌 필요

## 7. 페르소나 파일

`data/personas/{channelId}.md` 형태로 저장됩니다.
파일명은 채널 ID(숫자)입니다 (`agent-a.md`, `bot.md` 같은 이름이 아닙니다).

봇이 `update_persona` 툴을 통해 직접 자신의 페르소나를 수정할 수 있습니다.

## 8. Claude Code 세션 관리

Claude Code 세션은 인메모리에서 관리됩니다.
- 봇 재시작 시 세션이 초기화됩니다
- sessionKey 형식: `${graphId}:${taskId}` (developerNode와 testerNode가 같은 세션 공유)
- 세션 관련 코드: `src/claude-code.ts`

## 9. MCP 서버 연동 개발

봇별 MCP 서버는 Claude Desktop `claude_desktop_config.json`을 읽어 초기화됩니다.
봇 계정마다 다른 토큰이 필요한 경우 `config.json`의 `mcpTokens` 필드에 토큰을 추가합니다:

```json
{
  "mcpTokens": {
    "NOTION_TOKEN": "notion_secret_...",
    "GMAIL_TOKEN": "gmail_token_..."
  }
}
```

이 값들은 MCP 서버 subprocess의 환경변수로 주입됩니다.
