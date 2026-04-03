/**
 * agentProtocol.ts — 에이전트 간 통신 프로토콜
 *
 * 모든 봇간 메시지는 [AGENT_MSG] 봉투 형식을 따릅니다.
 * 이 모듈은 봉투 파싱/직렬화와 팀 매니페스트 파싱을 담당합니다.
 *
 * ## 메시지 봉투 형식
 * ```
 * [AGENT_MSG]
 * cycleId: <uuid>
 * turn: <integer>
 * from: <botId>
 * to: <botId | "SYSTEM_USER">
 * type: TASK_ASSIGN | TASK_RESULT | CONFIRM_REQUEST | CONFIRM_RESPONSE | ESCALATE
 * goalId: <string>
 *
 * <body — 빈 줄 이후의 모든 내용>
 * ```
 *
 * ## 팀 매니페스트 형식 (협력 채널 공통 핀)
 * ```
 * [TEAM_MANIFEST]
 * | role | botId | botName | status |
 * ```
 */

// ── 타입 정의 ─────────────────────────────────────────────────

export type AgentMessageType =
  | 'TASK_ASSIGN'       // 오케스트레이터 → 역할 봇: 태스크 위임
  | 'TASK_RESULT'       // 역할 봇 → 오케스트레이터: 결과 보고
  | 'CONFIRM_REQUEST'   // 오케스트레이터 → 유저: 승인 요청 (역할 핀 업데이트 등)
  | 'CONFIRM_RESPONSE'  // 유저 → 오케스트레이터: 승인/거부 응답
  | 'ESCALATE';         // 어느 봇 → 오케스트레이터/유저: 긴급 에스컬레이션

export type TaskStatus =
  | 'APPROVED'          // 작업 완료, 승인
  | 'REVISION_NEEDED'   // 수정 필요
  | 'FAILED'            // 재시도 후에도 실패
  | 'BLOCKED';          // 정보 부족 / 외부 의존성으로 진행 불가

export interface AgentMessageHeader {
  cycleId: string;
  turn: number;
  from: string;           // botId
  to: string;             // botId 또는 "SYSTEM_USER"
  type: AgentMessageType;
  goalId: string;
  status?: TaskStatus;    // TASK_RESULT 메시지에서 사용
}

export interface AgentMessage {
  header: AgentMessageHeader;
  body: string;           // 봉투 이후의 자유 형식 내용
  raw: string;            // 원본 전체 메시지
}

// ── 팀 매니페스트 ──────────────────────────────────────────────

export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'developer'
  | 'reviewer'
  | 'tester'
  | 'researcher';

export interface TeamMember {
  role: AgentRole;
  botId: string;
  botName: string;
  status: 'active' | 'inactive';
}

export interface TeamManifest {
  version: number;
  members: TeamMember[];
  escalationChain: Record<AgentRole, AgentRole[]>;  // role → 에스컬레이션 대상
  maxTurnsPerCycle: number;
  maxBotMessagesPerMinute: number;
  userConfirmRequired: string[];  // 항상 유저 컨펌이 필요한 작업 목록
}

// ── 상수 ──────────────────────────────────────────────────────

export const AGENT_MSG_SENTINEL = '[AGENT_MSG]';
export const TEAM_MANIFEST_SENTINEL = '[TEAM_MANIFEST]';
export const ROLE_UPDATE_PROPOSAL_SENTINEL = '[ROLE_UPDATE_PROPOSAL]';

export const DEFAULT_MAX_TURNS = 12;
export const TURN_WARNING_THRESHOLD = 10;
export const DEFAULT_MAX_BOT_MESSAGES_PER_MINUTE = 20;
export const DEFAULT_MAX_CYCLE_MINUTES = 30;

// ── 파싱 ──────────────────────────────────────────────────────

/**
 * 메시지 내용이 AGENT_MSG 봉투로 시작하는지 확인합니다.
 */
export function isAgentMessage(content: string): boolean {
  return content.trimStart().startsWith(AGENT_MSG_SENTINEL);
}

/**
 * AGENT_MSG 봉투를 파싱합니다.
 * 형식이 맞지 않으면 null을 반환합니다.
 */
export function parseAgentMessage(content: string): AgentMessage | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(AGENT_MSG_SENTINEL)) return null;

  // 첫 줄(봉투 선언) 이후 헤더 파싱
  const lines = trimmed.split('\n');
  const headerFields: Record<string, string> = {};
  let bodyStartIndex = 1; // [AGENT_MSG] 다음 줄부터

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // 빈 줄이 나오면 이후는 body
    if (line.trim() === '') {
      bodyStartIndex = i + 1;
      break;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      bodyStartIndex = i;
      break;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headerFields[key] = value;
    bodyStartIndex = i + 1;
  }

  // 필수 필드 검증
  const { cycleid, turn, from, to, type, goalid } = headerFields;
  if (!cycleid || !turn || !from || !to || !type || !goalid) return null;

  const turnNum = parseInt(turn, 10);
  if (isNaN(turnNum)) return null;

  const validTypes: AgentMessageType[] = [
    'TASK_ASSIGN', 'TASK_RESULT', 'CONFIRM_REQUEST', 'CONFIRM_RESPONSE', 'ESCALATE',
  ];
  if (!validTypes.includes(type as AgentMessageType)) return null;

  const header: AgentMessageHeader = {
    cycleId: cycleid,
    turn: turnNum,
    from,
    to,
    type: type as AgentMessageType,
    goalId: goalid,
    status: headerFields.status as TaskStatus | undefined,
  };

  const body = lines.slice(bodyStartIndex).join('\n').trimStart();

  return { header, body, raw: content };
}

/**
 * AGENT_MSG 봉투를 직렬화합니다.
 */
export function serializeAgentMessage(
  header: AgentMessageHeader,
  body: string,
): string {
  const lines = [
    AGENT_MSG_SENTINEL,
    `cycleId: ${header.cycleId}`,
    `turn: ${header.turn}`,
    `from: ${header.from}`,
    `to: ${header.to}`,
    `type: ${header.type}`,
    `goalId: ${header.goalId}`,
  ];

  if (header.status) {
    lines.push(`status: ${header.status}`);
  }

  lines.push(''); // 헤더와 body 사이 빈 줄
  lines.push(body);

  return lines.join('\n');
}

// ── 팀 매니페스트 파싱 ─────────────────────────────────────────

/**
 * 핀 목록에서 [TEAM_MANIFEST] 핀을 찾아 파싱합니다.
 * 없으면 null을 반환합니다.
 */
export function parseTeamManifest(pins: string[]): TeamManifest | null {
  const manifestPin = pins.find((p) => p.trimStart().startsWith(TEAM_MANIFEST_SENTINEL));
  if (!manifestPin) return null;

  const members: TeamMember[] = [];

  // 마크다운 테이블 행 파싱 (| role | botId | botName | status |)
  const tableRowRegex = /^\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(active|inactive)\s*\|/;
  for (const line of manifestPin.split('\n')) {
    const m = line.match(tableRowRegex);
    if (!m) continue;
    const [, role, botId, botName, status] = m;
    const validRoles: AgentRole[] = ['orchestrator', 'planner', 'developer', 'reviewer', 'tester', 'researcher'];
    if (!validRoles.includes(role as AgentRole)) continue;
    members.push({
      role: role as AgentRole,
      botId,
      botName: botName.trim(),
      status: status as 'active' | 'inactive',
    });
  }

  if (members.length === 0) return null;

  // 에스컬레이션 체인 파싱
  const escalationChain: Partial<Record<AgentRole, AgentRole[]>> = {};
  const escalationSection = manifestPin.match(/## Escalation Chain\n([\s\S]*?)(?=\n##|$)/);
  if (escalationSection) {
    for (const line of escalationSection[1].split('\n')) {
      const chainMatch = line.match(/(\w+)\s*→\s*(.+)/);
      if (!chainMatch) continue;
      const [, from, toStr] = chainMatch;
      const targets = toStr.split(',').map((t) => t.trim()).filter(Boolean) as AgentRole[];
      escalationChain[from as AgentRole] = targets;
    }
  }

  // 숫자 설정 파싱
  const extract = (key: string, def: number): number => {
    const m = manifestPin.match(new RegExp(`${key}:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : def;
  };

  const userConfirmLine = manifestPin.match(/userConfirmRequired:\s*(.+)/);
  const userConfirmRequired = userConfirmLine
    ? userConfirmLine[1].split(',').map((s) => s.trim()).filter(Boolean)
    : ['role_updates', 'external_deploys'];

  return {
    version: extract('version', 1),
    members,
    escalationChain: escalationChain as Record<AgentRole, AgentRole[]>,
    maxTurnsPerCycle: extract('maxTurnsPerCycle', DEFAULT_MAX_TURNS),
    maxBotMessagesPerMinute: extract('maxBotMessagesPerMinute', DEFAULT_MAX_BOT_MESSAGES_PER_MINUTE),
    userConfirmRequired,
  };
}

/**
 * 팀 매니페스트에서 특정 역할의 봇 ID를 조회합니다.
 */
export function getBotIdByRole(manifest: TeamManifest, role: AgentRole): string | null {
  const member = manifest.members.find((m) => m.role === role && m.status === 'active');
  return member?.botId ?? null;
}

/**
 * 팀 매니페스트에서 특정 봇 ID의 역할을 조회합니다.
 */
export function getRoleByBotId(manifest: TeamManifest, botId: string): AgentRole | null {
  const member = manifest.members.find((m) => m.botId === botId);
  return member?.role ?? null;
}

// ── 사이클 상태 ───────────────────────────────────────────────

export interface CycleState {
  cycleId: string;
  goalId: string;
  channelId: string;
  turn: number;
  startedAt: number;       // Date.now()
  visitedPairs: string[];  // `${fromId}:${toId}` 형태의 누적 라우팅 기록
  botMessageCount: number; // 분당 봇 메시지 수 추적용
  windowStart: number;     // 현재 rate-limit 윈도우 시작 시각
}

/**
 * 새 사이클 상태를 생성합니다.
 */
export function createCycleState(
  cycleId: string,
  goalId: string,
  channelId: string,
): CycleState {
  return {
    cycleId,
    goalId,
    channelId,
    turn: 0,
    startedAt: Date.now(),
    visitedPairs: [],
    botMessageCount: 0,
    windowStart: Date.now(),
  };
}

/**
 * 봇 메시지 수를 카운트하고 rate limit 초과 여부를 반환합니다.
 */
export function checkRateLimit(
  state: CycleState,
  maxPerMinute: number,
): { exceeded: boolean; updatedState: CycleState } {
  const now = Date.now();
  const windowElapsed = now - state.windowStart;

  // 60초 윈도우 리셋
  if (windowElapsed >= 60_000) {
    return {
      exceeded: false,
      updatedState: { ...state, botMessageCount: 1, windowStart: now },
    };
  }

  const newCount = state.botMessageCount + 1;
  return {
    exceeded: newCount > maxPerMinute,
    updatedState: { ...state, botMessageCount: newCount },
  };
}

/**
 * 중복 페어 루프를 감지합니다.
 * 동일한 (from → to) 조합이 임계값 이상 반복되면 true를 반환합니다.
 */
export function detectLoop(state: CycleState, from: string, to: string, threshold = 3): boolean {
  const pair = `${from}:${to}`;
  const count = state.visitedPairs.filter((p) => p === pair).length;
  return count >= threshold;
}
