# 기여 가이드

## 1. 기여 전 읽어야 할 문서

| 문서 | 내용 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 전체 시스템 구조 이해 |
| [development.md](./development.md) | 코드 컨벤션 및 개발 환경 |
| [api.md](./api.md) | 내부 인터페이스 명세 |
| [getting-started.md](./getting-started.md) | 로컬 환경 구축 |

## 2. 이슈 작성 방법

GitHub 이슈를 작성할 때 아래 정보를 포함해 주세요:

**버그 리포트:**
- 재현 단계 (최소한의 재현 예시)
- 기대 동작 vs 실제 동작
- 봇 로그 또는 오류 메시지
- Node.js 버전, OS

**기능 제안:**
- 어떤 문제를 해결하는지
- 제안하는 구현 방법 (선택)
- 영향을 받는 모듈/파일

## 3. 새 역할(봇) 추가하기

### 3-1. 역할 채널 생성

```
/role init    # 아직 ROLE 카테고리가 없다면
```

또는 Discord에서 `ROLE` 카테고리 하위에 새 채널 수동 생성 후 역할 내용 핀 등록.

### 3-2. 역할 시스템 프롬프트 작성

역할 채널의 핀 메시지에 역할 지침을 작성합니다. 권장 구조:

```
## 역할: {역할명}

### 핵심 책임
- ...

### 행동 원칙
- ...

### 금지 사항
- ...
```

### 3-3. 봇 설정 추가

`data/config.json`의 `agents` 배열에 새 봇 추가:

```json
{
  "id": "봇 Discord User ID",
  "name": "새봇이름",
  "role": "새역할명",
  "discordToken": "봇 토큰",
  "personaFile": "/절대경로/data/personas/{channelId}.md",
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-opus-4-6",
  "mcpTokens": {}
}
```

### 3-4. 디폴트 봇 지정

```
/role set-default role:새역할명 bots:@새봇이름
```

## 4. PR 가이드

### 브랜치명 규칙

```
feature/T{n}-{설명}     # 태스크 기반 기능
fix/{모듈명}-{설명}      # 버그 수정
docs/{파일명}-update     # 문서 수정
```

예시:
```bash
git checkout -b feature/T5-add-researcher-node
git checkout -b fix/roleContext-step2-missing-channel
```

### 커밋 컨벤션

```
feat: 새 기능
fix: 버그 수정
refactor: 리팩토링 (기능 변경 없음)
docs: 문서 수정
chore: 설정/빌드 변경
```

### PR 체크리스트

```
□ npx tsc --noEmit 통과 (타입 오류 없음)
□ 기존 코드 컨벤션 준수 (한국어 주석, 함수형 스타일)
□ 불필요한 추상화 추가 없음
□ data/config.json 민감 정보 미포함
□ dist/ 디렉토리 변경 없음
□ commands/ 수정 시 CmdBot 독립 테스트 완료
```

## 5. 로컬 테스트 체크리스트

PR 제출 전:

```bash
# 1. 타입 체크
npx tsc --noEmit

# 2. 개발 모드 실행 확인
npm start

# 3. 수정한 기능 Discord에서 직접 확인
#    - 봇 응답 정상 동작
#    - Task Graph 실행 (해당하는 경우)
#    - 슬래시 커맨드 (commands/ 수정 시)

# 4. GitHub 연동 확인 (developerNode/testerNode 수정 시)
gh auth status
gh pr list
```

## 6. 코드 리뷰 기준

리뷰어가 집중하는 항목:

- **정확성**: 의도한 동작을 올바르게 구현했는가
- **TypeScript**: strict 모드 위반 없이 타입이 안전한가
- **단순성**: 불필요한 추상화나 과도한 일반화가 없는가
- **보안**: 민감 정보 노출, 명령어 주입 등 취약점 없는가
- **컨벤션**: 한국어 주석, 함수형 스타일 등 기존 컨벤션 준수

## 7. 질문 및 논의

- GitHub Issues: 버그 및 기능 제안
- Discord 협력 채널: 실시간 논의
