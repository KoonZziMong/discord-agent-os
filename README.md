# discord-agent-os

Discord를 운영 인터페이스로 삼는 자율 AI 개발팀 플랫폼입니다.

자연어로 목표를 입력하면 AI 에이전트가 계획을 수립하고, 코드를 작성하고, 리뷰하고, 테스트한 뒤 GitHub PR까지 올립니다. Discord 채널이 곧 작업 공간이자 실시간 대시보드입니다.

---

## 핵심 개념

### Discord-first 운영

모든 상호작용은 Discord에서 이루어집니다. 별도의 웹 UI나 CLI 없이 채팅만으로 AI 팀을 지휘합니다.

- **개별 채널**: 각 AI 에이전트(찌몽·아루·센세)는 전용 채널을 가집니다
- **협력 채널**: 에이전트들이 함께 논의하는 공용 채널
- **슬래시 커맨드**: CmdBot이 작업 관리·GitHub 연동·상태 조회 등 운영 커맨드를 전담

### 목표 기반 실행 (`!목표`)

```
!목표 사용자 인증 API를 JWT 방식으로 구현해줘
```

에이전트가 목표를 받아 Task Graph로 분해하고, 각 태스크를 **Planner → Developer → Reviewer → Tester** 파이프라인으로 자동 실행합니다. 병렬로 실행 가능한 태스크는 동시에 처리되며, Discord에 실시간 진행 상황이 표시됩니다.

### GitHub 워크플로우

에이전트에 `githubRepo`를 연결하면 코드 작성 후 자동으로 브랜치를 만들고 PR을 올립니다. CI 결과도 확인합니다.

---

## 슬래시 커맨드

모든 커맨드는 관리자 전용이며 본인에게만 표시됩니다(ephemeral).

### `/task`

Task Graph 실행 현황을 조회하고 제어합니다.

| 서브커맨드 | 설명 |
|---|---|
| `list` | 최근 태스크 그래프 목록 (최대 10개) |
| `detail` | 드롭다운으로 그래프를 선택해 태스크별 상세 결과 확인 |
| `cancel <id>` | 실행 중인 그래프 강제 종료 |
| `retry <id>` | 실패한 그래프 재시도 (봇 재시작 후 자동 재개) |

### `/github`

에이전트별 연결 GitHub 레포를 관리합니다.

| 서브커맨드 | 설명 |
|---|---|
| `add <owner/repo>` | 글로벌 레포 목록에 추가 |
| `set` | 드롭다운으로 현재 채널 에이전트의 레포 선택 |
| `list` | 등록된 레포 목록 및 에이전트별 현재 설정 조회 |
| `remove` | 드롭다운으로 레포 삭제 |

### `/status`

봇 프로세스 상태를 확인합니다 (업타임, 핑, 메모리, Node.js 버전).

---

## 시작하기

### 요구사항

- Node.js 20+
- Discord 봇 계정 × 4 (AI 봇 3 + CmdBot 1)
- Anthropic API 키
- `gh` CLI (GitHub 워크플로우 사용 시)

### 설치

```bash
git clone https://github.com/KoonZziMong/discord-agent-os.git
cd discord-agent-os
npm install
```

### 설정

`data/config.json`을 작성합니다.

```jsonc
{
  "historyLimit": 50,
  "collabChannel": "COLLAB_CHANNEL_ID",
  "cmdBot": {
    "discordToken": "CMDBOT_TOKEN"
  },
  "agents": [
    {
      "id": "zzimong",
      "name": "찌몽",
      "discordToken": "BOT_TOKEN",
      "chatChannel": "CHAT_CHANNEL_ID",
      "configChannel": "CONFIG_CHANNEL_ID",
      "personaFile": "data/personas/agent-a.md",
      "anthropicApiKey": "sk-ant-...",
      "githubRepo": "owner/repo"
    }
  ]
}
```

### 슬래시 커맨드 등록

```bash
node deploy-commands.js --guild YOUR_SERVER_ID
```

### 실행

```bash
npm start
```

---

## 문서

- [아키텍처](docs/ARCHITECTURE.md) — 시스템 구조, 데이터 흐름, 주요 모듈 설명

---

## 라이선스

MIT
