[TEAM_MANIFEST]
version: 1

## Agent Team
<!-- /role init 후 BOT_ID_* 를 실제 Discord User ID로 교체하세요 -->
<!-- 봇 ID 확인: Discord 개발자 모드 → 봇 프로필 우클릭 → "ID 복사" -->

| role | botId | botName | status |
|------|-------|---------|--------|
| orchestrator | BOT_ID_ORCHESTRATOR | Orchestrator | active |
| planner      | BOT_ID_PLANNER      | Planner      | active |
| developer    | BOT_ID_DEVELOPER    | Developer    | active |
| reviewer     | BOT_ID_REVIEWER     | Reviewer     | active |
| tester       | BOT_ID_TESTER       | Tester       | active |
| researcher   | BOT_ID_RESEARCHER   | Researcher   | active |

## Escalation Chain
planner → orchestrator
developer → orchestrator
reviewer → developer, orchestrator
tester → developer, orchestrator
researcher → orchestrator

## Turn Limits
maxTurnsPerCycle: 12
maxBotMessagesPerMinute: 20
maxCycleMinutes: 30
userConfirmRequired: role_updates, external_deploys, orchestrator_self_update
