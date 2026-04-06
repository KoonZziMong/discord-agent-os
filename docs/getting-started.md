# 시작 가이드

## 1. 사전 요구사항

| 항목 | 버전 / 조건 |
|---|---|
| Node.js | 18 이상 |
| npm | 8 이상 |
| Discord 봇 계정 | AI 봇 수 + CmdBot 1개 (총 n+1개) |
| Anthropic / OpenAI API 키 | 각 봇에 맞게 준비 |
| `gh` CLI | GitHub 연동 기능 사용 시 필수 |
| pm2 | 프로덕션 운영 시 (`npm install -g pm2`) |

## 2. 저장소 클론 및 의존성 설치

```bash
git clone https://github.com/KoonZziMong/discord-agent-os.git
cd discord-agent-os
npm install
```

## 3. 설정 파일 준비

`.env` 파일은 **사용하지 않습니다**. 모든 설정은 `data/config.json` 단일 파일에 집중합니다.

```bash
cp data/config.example.json data/config.json
```

`data/config.json` 주요 필드:

```jsonc
{
  "guildId": "Discord 서버 ID",
  "collabChannel": "협력 채널 ID",
  "adminPort": 3000,
  "historyLimit": 50,
  "maxTurnsPerCycle": 12,
  "maxCycleMinutes": 30,
  "maxReviewRetries": 2,
  "autonomousRoleUpdates": false,
  "agents": [
    {
      "id": "봇 Discord User ID",
      "name": "찌몽",
      "discordToken": "봇 토큰",
      "personaFile": "/절대/경로/data/personas/channelId.md",
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "model": "claude-opus-4-6",
      "mcpTokens": {}
    }
  ],
  "cmdBot": {
    "token": "CmdBot 토큰",
    "clientId": "CmdBot 클라이언트 ID"
  }
}
```

> ⚠️ `data/config.json`에는 Discord 토큰과 API 키가 포함됩니다. Git에 커밋하지 마세요 (`.gitignore` 에 포함되어 있어야 합니다).

## 4. Discord 봇 설정

### 봇 계정 생성
1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. 각 봇마다 Application 생성 → Bot 탭에서 토큰 발급
3. Bot 탭에서 **MESSAGE CONTENT INTENT** 활성화 (AI 봇 전용)

### 서버 초대
필요 권한: `Administrator` 또는 아래 권한 조합:
- Manage Channels, Manage Messages, Send Messages, Read Message History, Add Reactions, Pin Messages

초대 URL 예시:
```
https://discord.com/oauth2/authorize?client_id={CLIENT_ID}&permissions=8&scope=bot+applications.commands
```

### 슬래시 커맨드 등록

```bash
node deploy-commands.js
```

이 스크립트가 `data/config.json`의 `cmdBot` 정보를 읽어 Discord에 커맨드를 등록합니다.

## 5. 채널 및 카테고리 구조 설정

Discord 서버에서 아래 순서로 초기 구조를 만듭니다:

```
1. /role init
   → ROLE 카테고리 + 역할 채널 6개 생성 (orchestrator/planner/developer/reviewer/tester/researcher)

2. /role set-default role:orchestrator bots:@찌몽
   /role set-default role:developer bots:@아루
   /role set-default role:reviewer bots:@센세
   → 각 역할에 디폴트 봇 지정

3. 봇 재시작 (역할 채널 핀 캐시 로드)

4. /project create name:내앱 default_role:y description:"프로젝트 설명"
   → 프로젝트 카테고리 + role + workspace 채널 일괄 생성

5. /github add repo:owner/repo-name
   /github set
   → 프로젝트 레포 연결 (GitHub 연동 사용 시)
```

자세한 커맨드 가이드: [COMMANDS.md](./COMMANDS.md)

## 6. 실행

### 개발 모드

```bash
npm start
# 내부적으로 ts-node src/index.ts 실행
```

### 프로덕션 모드

```bash
npm run build       # TypeScript 컴파일 → dist/
npm run prod        # pm2로 dist/index.js 실행
```

### 타입 체크만

```bash
npx tsc --noEmit
```

## 7. 동작 확인

봇이 정상 기동되면:
1. Discord 서버에서 봇들이 온라인 상태로 표시됩니다.
2. 채널에서 `@봇이름 안녕`으로 대화를 시작할 수 있습니다.
3. `/status` 슬래시 커맨드로 봇 상태를 확인할 수 있습니다.
4. `!목표 @봇이름 간단한 작업 설명`으로 Task Graph를 실행할 수 있습니다.

## 8. GitHub 연동 설정 (선택)

Developer 봇이 브랜치 생성 및 PR을 자동으로 올리려면:

```bash
# gh CLI 설치 후 인증
gh auth login

# git 계정 설정
git config --global user.name "Bot Name"
git config --global user.email "bot@example.com"
```

`data/config.json`의 해당 에이전트에 `githubRepo` 추가:
```json
{ "id": "...", "githubRepo": "owner/repo-name", ... }
```

브랜치명 패턴: `feature/{taskId}-{taskTitle}`
