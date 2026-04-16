# 팀 공통 규약 (Team Rule)

> 이 채널의 핀은 모든 에이전트의 시스템 프롬프트에 **항상** 주입됩니다.
> 역할·채널에 관계없이 팀 전체가 따르는 규약을 여기에 정의합니다.

---

## 에이전트 간 통신 인터페이스

이 팀은 **약한 결합(weak coupling)**과 **강한 결합(strong coupling)** 두 가지 통신 방식을 사용합니다.

### 약한 결합 — @멘션 방식

Orchestrator가 팀원에게 작업을 지시할 때 사용합니다.

**Input (수신 에이전트 관점)**
- 트리거: 협력 채널에서 자신에 대한 @멘션 메시지
- 형식: 자유 형식 자연어 지시
- 컨텍스트: 직전 대화 히스토리 + 역할 핀

**Output (지시 에이전트 관점)**
- 형식: 자연어 응답 또는 [AGENT_MSG] (아래 강한 결합 참조)
- 수신자: 멘션한 봇 또는 @orchestrator

**사용 원칙**
- 병렬 처리: 독립 작업은 봇별 **별도 메시지**로 각각 @멘션
- 순차 처리: 이전 결과가 필요한 경우 결과 수신 후 다음 @멘션

---

### 강한 결합 — [AGENT_MSG] 봉투 방식

작업자 봇이 Orchestrator에게 결과·에스컬레이션을 보고할 때 사용합니다.

**봉투 형식**
```
[AGENT_MSG]
cycleId: <uuid>
turn: <integer>
from: <botId>
to: <botId | "SYSTEM_USER">
type: <MessageType>
goalId: <string>
goalThreadId: <discord thread id | 없으면 생략>

<body>
```

**MessageType 목록**

| 타입 | 방향 | 설명 |
|---|---|---|
| TASK_ASSIGN | Orchestrator → 작업자 | 태스크 할당 |
| TASK_RESULT | 작업자 → Orchestrator | 작업 결과 보고 (APPROVED/FAILED/BLOCKED) |
| ESCALATE | 작업자 → Orchestrator | 문제 에스컬레이션 |
| CONFIRM_REQUEST | 작업자 → 유저 | 유저 확인 요청 |
| CONFIRM_RESPONSE | 유저 → 작업자 | 유저 확인 응답 |

**TASK_RESULT body 형식**
```
status: APPROVED | FAILED | BLOCKED
summary: <한 줄 요약>
detail: <선택 — 상세 결과, 에러 메시지, 블로킹 이유>
```

---

---

## Goals 포럼 기록 규약

모든 에이전트는 작업 진행 상황을 goals 포럼 thread에 기록합니다.

### 툴 목록

| 툴 | 호출자 | 시점 |
|---|---|---|
| `create_goal_thread` | orchestrator | 목표 수신 즉시 |
| `post_to_goal_thread` | 모든 에이전트 | 태스크 시작·완료·실패·에스컬레이션 시 |

### 흐름

1. **orchestrator** → 목표 수신 시 `create_goal_thread` 호출 → `threadId` 획득
2. **orchestrator** → TASK_ASSIGN 봉투에 `goalThreadId: <threadId>` 포함하여 팀원에게 전달
3. **각 에이전트** → TASK_ASSIGN 수신 시 `goalThreadId` 추출 → 작업 시작 전 `post_to_goal_thread` 호출
4. **각 에이전트** → 작업 완료·실패 시 `post_to_goal_thread` 호출 (완료/실패 status 포함)
5. **orchestrator** → 사이클 종료 시 `post_to_goal_thread`로 최종 요약 기록 (status: 완료 또는 실패)

### 기록 형식 권장

```
### ⚙️ 태스크 시작 — [T1] 태스크명
담당: developer | 04.16. 14:30

### ✅ 태스크 완료 — [T1] 태스크명
결과 요약 (핵심만, 300자 이내)

### ❌ 태스크 실패 — [T1] 태스크명
실패 원인
```

### 주의사항
- `goalThreadId`가 없으면 기록 생략 (thread 생성 실패 시 작업은 계속 진행)
- thread에는 **추가(append)만** 합니다. 기존 메시지 수정 금지
- 동시에 여러 에이전트가 기록해도 안전 (append-only 구조)

---

## 에스컬레이션 규칙

1. 작업 2회 시도 후 실패 → `type: TASK_RESULT, status: FAILED` 로 @orchestrator 보고
2. 필요 정보 부족 → `type: ESCALATE` 로 @orchestrator 보고
3. 역할 범위 밖 요청 수신 → 즉시 거부 후 @orchestrator 에스컬레이션
4. turn ≥ 10 → 현재 작업 최우선 마무리, 신규 위임 금지

---

## 안전장치 (시스템 강제)

| 항목 | 기본값 |
|---|---|
| maxTurnsPerCycle | 12 |
| maxBotMessagesPerMinute | 20 |
| 루프 감지 임계 | 3회 동일 패턴 |
| maxCycleMinutes | 30 |
