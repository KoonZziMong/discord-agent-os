<div align="center">

# 🤖 DiscordAgentOS

**Discord 위에서 동작하는 AI 에이전트 오케스트레이션 시스템**

*Planner → Developer → Reviewer → Tester 파이프라인을 Discord 채널에서 실행*

<br/>

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)
![Build](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

</div>

---

## ✨ Features

- 🧠 **역할 기반 AI 에이전트** — Planner / Developer / Reviewer / Tester / Researcher
- 🔗 **TaskGraph 기반 자동 파이프라인** — 목표 하나로 전체 개발 사이클 자동 실행
- 💬 **Discord-first 운영** — 채널이 곧 작업 공간이자 실시간 대시보드
- 🌐 **관리 웹 UI** — Express 기반 상태 모니터링
- 📌 **역할 핀 메시지** — 컨텍스트 동적 주입으로 일관된 페르소나 유지
- 🔀 **병렬 태스크 실행** — 의존성 없는 태스크는 동시 처리

---

## 📸 Demo

> 🚧 스크린샷 준비 중입니다. 실제 사용 화면은 추후 업데이트됩니다.

<!-- TODO: 데모 GIF 추가 후 아래 주석을 해제하세요 -->
<!-- ![Demo](docs/assets/demo.gif) -->

---

## 🛠 Tech Stack

![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/-Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/-Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![Anthropic](https://img.shields.io/badge/-Anthropic%20Claude-D97757?style=for-the-badge)
![Express](https://img.shields.io/badge/-Express-000000?style=for-the-badge&logo=express&logoColor=white)

---

## 🚀 Quick Start

### 1. 설치

```bash
git clone https://github.com/KoonZziMong/discord-agent-os.git
cd discord-agent-os
npm install
```

### 2. 환경 설정

```bash
cp .env.example .env
# .env 파일에서 DISCORD_TOKEN, ANTHROPIC_API_KEY 등 설정
```

`data/config.json`을 작성합니다:

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

### 3. 슬래시 커맨드 등록

```bash
node deploy-commands.js --guild YOUR_SERVER_ID
```

### 4. 실행

```bash
npm run dev      # 개발 모드
npm run build    # 빌드
npm start        # 프로덕션
```

> 상세 설정 및 Discord 봇 생성 방법은 [📖 Getting Started](docs/getting-started.md) 참조

---

## 📚 Documentation

| 문서 | 설명 |
|---|---|
| [🏗 Architecture](docs/ARCHITECTURE.md) | 시스템 구조, 모듈 맵, 파이프라인 흐름 |
| [🚀 Getting Started](docs/getting-started.md) | 설치, 환경 설정, Discord 봇 생성, 첫 실행 |
| [🔌 API Reference](docs/api.md) | AgentConfig, TaskGraph, 관리 웹 API 명세 |
| [🛠 Development Guide](docs/development.md) | 코드 컨벤션, 브랜치 전략, 개발 명령어 |
| [🤝 Contributing](docs/contributing.md) | 새 역할 추가법, PR 가이드, 로컬 테스트 체크리스트 |
| [📋 Commands](docs/COMMANDS.md) | 슬래시 커맨드 전체 레퍼런스 |
| [🤖 Claude AI Guide](docs/CLAUDE.md) | AI 에이전트 운용 가이드 |

---

## 🤝 Contributing

기여는 언제나 환영입니다! 자세한 내용은 [CONTRIBUTING 가이드](docs/contributing.md)를 확인해주세요.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

MIT License — [LICENSE](LICENSE) 파일 참조
