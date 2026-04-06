# 슬래시 커맨드 가이드

Discord AI 팀 봇 시스템의 전체 슬래시 커맨드 규격과 사용 가이드입니다.
모든 커맨드는 **CmdBot**이 처리하며, 관리자(Administrator) 권한이 필요합니다.

---

## `/channel` — 채널 컨텍스트 관리

채널의 토픽과 핀 메시지를 관리합니다.
채널 토픽과 핀은 AI 봇의 시스템 프롬프트에 직접 주입되어 봇의 행동을 제어합니다.

---

### `/channel context`

현재 채널의 토픽과 핀 메시지를 출력합니다. LLM 호출 없이 즉시 응답합니다.

**사용 상황:**
- 현재 채널에 어떤 설정이 되어 있는지 확인할 때
- 봇이 어떤 컨텍스트로 동작하는지 확인할 때
- `/channel setup` 실행 전후 비교할 때

**예시:**
```
/channel context
```

**출력:** 채널 토픽 + 핀 메시지 목록 (핀 ID 포함)

---

### `/channel setup`

LLM이 지시사항을 바탕으로 채널 토픽과 핀 메시지를 생성하여 적용합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `instruction` | ✅ | 채널 설정 지시사항 (자연어) |

**사용 상황:**
- 새 프로젝트 채널에 봇 역할을 처음 설정할 때
- 특정 봇에게 역할을 부여하거나 변경할 때
- 채널 목적이나 규칙을 봇에게 전달할 때
- 디폴트 봇을 현재 채널에 일괄 매핑할 때

**주요 동작:**
- 변경이 필요한 핀만 수정 (keep/update/add/remove diff 방식)
- 수정하지 않아도 되는 핀은 그대로 유지
- 봇 전용 핀: `<@봇ID>`로 시작 → 해당 봇에게만 주입
- 공통 핀: 멘션 없이 시작 → 모든 봇에게 주입

**봇 역할 설정 시 핀 형식:**
```
<@봇ID>
역할: orchestrator
역할채널: {역할채널ID}
추가 지시사항...
```

**예시:**
```
/channel setup "찌몽이에게 오케스트레이터 역할을 부여해줘"
/channel setup "아루에게 디벨로퍼 역할, 센세에게 리뷰어 역할을 설정해줘"
/channel setup "디폴트 봇으로 설정해줘"
/channel setup "이 채널은 React Native 프로젝트용이야. 모든 봇이 알 수 있게 해줘"
/channel setup "찌몽 전용 핀의 역할 설명을 최신 버전으로 업데이트해줘"
```

**완료 메시지 예시:**
```
✅ 완료 — 유지 2개, 수정 1개, 추가 1개
```

---

## `/role` — 역할 시스템 관리

AI 봇 팀의 역할 채널을 생성하고 관리합니다.
역할 채널의 핀 메시지는 각 봇의 행동 원칙과 책임 범위를 정의합니다.

### 역할 컨텍스트 3단계 로딩 구조

봇은 응답 시 아래 순서로 역할 컨텍스트를 누적 로드합니다.

```
Step 1 │ ROLE 카테고리 채널 (role/developer 등)
       │ 모든 프로젝트에 공통 적용되는 글로벌 역할 정의
       │ → /role init 으로 생성, /role reset 으로 초기화
       │
Step 2 │ 현재 채널의 카테고리 안 "role" 채널 (프로젝트A/role)
       │ 이 프로젝트(카테고리)에만 적용되는 커스텀 지침
       │ → 직접 생성 후 핀 작성, 또는 회고를 통해 자동 제안
       │
Step 3 │ 현재 채널의 봇 멘션 핀 (<@봇ID> 형식)
       │ 이 채널에만 적용되는 개별 설정
       │ → /channel setup 으로 관리
```

**회고(retrospective) 제안 범위:**
- `global` — Step 1 수정: 이번 이슈가 모든 프로젝트에 해당하는 역할 정의 문제
- `project` — Step 2 수정: 이번 프로젝트에만 해당하는 특수 지침이 필요

---

---

### `/role init`

역할 카테고리와 채널을 생성하고, 협력 채널에 TEAM_MANIFEST 핀을 등록합니다.

**사용 상황:**
- 봇 시스템을 처음 세팅할 때 (최초 1회)
- 역할 채널이 삭제되어 재생성이 필요할 때

**주요 동작:**
1. `role` 카테고리 생성 (이미 있으면 스킵, 대소문자 무관)
2. 역할별 채널 생성: `orchestrator`, `planner`, `developer`, `reviewer`, `tester`, `researcher`
3. 각 채널에 기본 역할 내용 핀 등록
4. 각 채널에 CmdBot 디폴트 봇 핀 등록 (초기값: 미설정)
5. 협력 채널에 TEAM_MANIFEST 핀 등록

**예시:**
```
/role init
```

**실행 후 해야 할 일:**
```
/role set-default role:orchestrator bots:@찌몽
/role set-default role:developer bots:@아루
/role set-default role:reviewer bots:@센세
```

---

### `/role reset`

역할 채널의 핀을 코드의 최신 기본값으로 교체합니다.

**사용 상황:**
- 역할 정의가 코드에서 업데이트된 후 실제 채널에 반영할 때
- 역할 핀이 지저분해져서 초기화하고 싶을 때

**주요 동작:**
- 기존 핀을 모두 언핀 (메시지는 채널에 남아 히스토리 보존)
- 코드의 `DEFAULT_ROLES` 최신 내용으로 새 메시지 작성 후 핀 고정

**예시:**
```
/role reset
```

> ⚠️ 회고를 통해 수정된 역할 핀도 초기화됩니다. 신중하게 사용하세요.

---

### `/role set-default`

역할 채널에 디폴트 봇을 지정합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `role` | ✅ | 역할명 (`orchestrator`/`planner`/`developer`/`reviewer`/`tester`/`researcher`) |
| `bots` | ✅ | 디폴트 봇 멘션 (여러 개 가능) |

**사용 상황:**
- `/role init` 후 각 역할에 담당 봇을 지정할 때
- 역할 담당 봇을 교체할 때
- tester처럼 여러 봇이 같은 역할을 할 때

**주요 동작:**
- 역할 채널의 CmdBot 핀에 `default: <@봇ID>` 기록
- 기존 디폴트 핀 언핀 후 새 핀 등록 (히스토리 보존)
- 설정 후 해당 역할 채널이 없는 채널에서 자동 폴백으로 동작

**예시:**
```
/role set-default role:orchestrator bots:@찌몽
/role set-default role:tester bots:@꼼꼼이 @꼼꼼이2
/role set-default role:developer bots:@아루
```

---

## `/project` — 프로젝트 관리

프로젝트 카테고리와 채널을 일괄 생성합니다.
각 프로젝트는 `{이름}` 카테고리 아래에 role 채널(Step 2)과 workspace 채널을 가집니다.

---

### `/project create`

새 프로젝트 카테고리와 채널을 한 번에 생성합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `name` | ✅ | 프로젝트명 (예: `테스트` → `테스트` 카테고리 생성) |
| `default_role` | ❌ | `y/yes/true/1` — role 채널 생성 + ROLE 카테고리의 디폴트 봇을 workspace에 자동 매핑 |
| `description` | ❌ | 프로젝트 설명 — CmdBot LLM이 role 채널에 프로젝트 특화 지침 자동 작성 |

**생성 구조:**
```
테스트/ (카테고리)
  role       — Step 2 프로젝트 커스텀 지침 채널 (default_role 또는 description 시 생성)
  workspace  — 실제 작업 채널 (항상 생성)
```

**사용 상황:**
- 새 프로젝트를 시작할 때 채널 구조를 한 번에 세팅
- 프로젝트별 역할 커스터마이징을 자동화할 때

**주요 동작:**
1. `{name}` 카테고리 생성 (이미 있으면 스킵)
2. `role` 채널 생성 (`default_role` 또는 `description` 시 — Step 2)
3. `workspace` 채널 생성
4. `default_role` 활성화 시:
   - ROLE 카테고리의 디폴트 봇 설정을 읽어 workspace 채널에 봇 멘션 핀 자동 등록
   - 예: `<@아루>\n역할: developer`
5. `description` 있을 시:
   - LLM이 프로젝트 설명 분석 → role 채널에 프로젝트 특화 지침 핀 자동 작성
   - 공통 핀(모든 봇) + 봇 전용 핀 혼합 구성

**예시:**
```
/project create name:내앱
/project create name:내앱 default_role:y
/project create name:내앱 default_role:y description:"React Native 기반 위치 기반 맛집 추천 앱"
/project create name:내앱 description:"FastAPI 백엔드, Python, PostgreSQL 사용"
```

**완료 메시지 예시:**
```
✅ 내앱 프로젝트 생성 완료
📁 카테고리: 내앱 | 💬 채널: #role, #workspace | 📌 디폴트 봇 매핑 완료 | 🤖 LLM 지침 적용
```

---

## `/github` — GitHub 레포 관리

채널과 GitHub 레포를 연결합니다.
연결된 레포는 Developer 봇이 브랜치 생성 및 PR 작업 시 기준으로 사용합니다.

---

### `/github add`

글로벌 레포 목록에 레포를 추가합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `repo` | ✅ | `owner/repo-name` 형식 |

```
/github add repo:KoonZziMong/my-app
```

---

### `/github set`

현재 채널의 기본 레포를 드롭다운으로 선택합니다.

**사용 상황:**
- 채널(프로젝트)마다 작업할 레포를 지정할 때
- Developer 봇이 어느 레포에 커밋할지 설정할 때

```
/github set
```

---

### `/github list`

등록된 전체 레포 목록을 확인합니다.

```
/github list
```

---

### `/github remove`

글로벌 목록에서 레포를 삭제합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `repo` | ✅ | `owner/repo-name` 형식 |

```
/github remove repo:KoonZziMong/my-app
```

---

## `/status` — 봇 상태 확인

봇의 현재 운영 상태를 임베드 메시지로 표시합니다.

**출력 항목:**
- 업타임 (봇 프로세스 가동 시간)
- 핑 (WebSocket 레이턴시)
- 서버 수
- 메모리 사용량

**사용 상황:**
- 봇이 정상 동작 중인지 확인할 때
- 성능 이슈 발생 시 상태 점검

```
/status
```

---

## `/task` — Task Graph 관리

AI 봇이 실행 중이거나 완료한 Task Graph를 관리합니다.
`!목표` 명령으로 시작된 작업의 상태를 추적하고 제어합니다.

---

### `/task list`

최근 Task Graph 목록을 표시합니다.

```
/task list
```

---

### `/task detail`

드롭다운으로 Task Graph를 선택하여 상세 정보를 봅니다.

**출력 항목:**
- 목표 (goal)
- 각 Task의 상태 (pending/running/completed/failed)
- 실행 시간

```
/task detail
```

---

### `/task cancel`

실행 중인 Task Graph를 취소합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `id` | ✅ | Task Graph ID |

```
/task cancel id:abc123
```

---

### `/task retry`

실패한 Task Graph를 재시도합니다.

**파라미터:**
| 파라미터 | 필수 | 설명 |
|---|---|---|
| `id` | ✅ | Task Graph ID |

```
/task retry id:abc123
```

---

## 채팅 명령어 (슬래시 커맨드 아님)

슬래시 커맨드 외에 채팅에서 직접 입력하는 명령어입니다.

| 명령어 | 설명 |
|---|---|
| `!목표 @봇 <목표>` | 봇에게 Task Graph 실행 요청 |
| `!task @봇 <목표>` | 위와 동일 |
| `!페르소나` | 봇의 현재 페르소나 확인 |
| `!도움말` | 봇 사용 가이드 출력 |

---

## 추천 초기 셋업 순서

```
1. /role init
   → role 카테고리/채널 생성

2. /role set-default role:orchestrator bots:@찌몽
   /role set-default role:planner bots:@쿤찌
   /role set-default role:developer bots:@아루
   /role set-default role:reviewer bots:@센세
   /role set-default role:tester bots:@꼼꼼이
   /role set-default role:researcher bots:@센세
   → 각 역할에 디폴트 봇 지정

3. 봇 재시작
   → 역할 채널 핀 캐시 로드

4. /project create name:내앱 default_role:y description:"프로젝트 설명"
   → 내앱 카테고리 + role + workspace 채널 일괄 생성
   → 디폴트 봇 workspace 자동 매핑 + LLM 프로젝트 지침 작성

   (개별 채널 커스터마이징이 필요하면 workspace에서)
   /channel setup "추가 지시사항"
   → Step 3 채널 개별 설정

5. /github add repo:owner/repo
   /github set
   → 프로젝트 레포 연결

6. !목표 @찌몽 <목표 입력>
   → 하네스 동작 시작
```
