/**
 * config.ts — data/config.json 로드 및 설정 구조화
 *
 * .env 대신 data/config.json 을 단일 설정 소스로 사용합니다.
 * Step 14 웹 UI도 이 파일을 읽고 saveConfig()로 변경사항을 저장합니다.
 *
 * AgentConfig : 에이전트 1개의 설정
 *               (Discord 토큰, 채널, 페르소나, LLM provider/apiKey/model, MCP 토큰)
 * AppConfig   : 전체 앱 설정 (에이전트 배열 + 공통 설정)
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AgentConfig {
  id: string;            // Discord User ID
  name: string;          // 표시 이름
  role?: string;         // 하네스 역할명 (orchestrator/planner/developer/reviewer/tester/researcher)
  discordToken: string;  // Discord Bot Token
  personaFile: string;   // 절대 경로 (loadConfig에서 해석) — 채널 핀 없을 때 폴백
  configChannel?: string; // (레거시) 설정 전용 채널 — 사용 안 해도 됨
  chatChannel?: string;   // (레거시) 전용 채팅 채널 — 사용 안 해도 됨

  // LLM 설정
  provider: string;      // "anthropic" | "openai" | "gemini" | "minimax"
  apiKey: string;
  model: string;
  baseUrl?: string;      // OpenAI-compat endpoint (provider가 anthropic이 아닐 때)

  // 봇별 MCP 서비스 토큰 (환경변수명 → 값)
  mcpTokens: Record<string, string>;

  // Computer Use 활성화 여부 (macOS + 손쉬운 사용 권한 필요, 기본값 false)
  computerUse?: boolean;

  // 이 채널(프로젝트)에 연결된 GitHub 레포 (owner/repo 형식, 미설정 시 GitHub 워크플로우 비활성화)
  githubRepo?: string;
}

export interface CmdBotConfig {
  discordToken: string;
  provider?: string;
  apiKey?: string;
  model?: string;
}

/** 채팅 명령어 prefix 설정 */
export interface CommandsConfig {
  /** 페르소나 조회 명령어 목록 (기본: ["!페르소나", "!persona"]) */
  persona: string[];
  /** 도움말 명령어 목록 (기본: ["!도움말", "!help"]) */
  help: string[];
  /**
   * 멀티-에이전트 목표 위임 prefix 목록 (기본: ["!목표", "!task"])
   * 오케스트레이터 LLM이 Role 핀에 따라 팀에 [AGENT_MSG]로 위임합니다.
   */
  task: string[];
  /**
   * 단독 에이전트 자동 파이프라인 prefix 목록 (기본: ["!자율", "!pipeline"])
   * LLM 위임 없이 planner→developer→reviewer→tester 파이프라인을 직접 실행합니다.
   */
  autonomous: string[];
}

export interface AppConfig {
  agents: AgentConfig[];
  /** 슬래시 커맨드 전담 봇 설정 (없으면 커맨드 비활성화) */
  cmdBot?: CmdBotConfig;
  collabChannel: string;
  /** Discord 서버(길드) ID — 관리 웹 UI에서 채널/봇 목록 조회에 사용 */
  guildId?: string;
  adminPort: number;
  /** 관리 서버 바인딩 호스트 (기본값: 127.0.0.1 / 외부 노출 시 0.0.0.0) */
  adminHost?: string;
  // 툴 봇 이름 → MCP 서버명 (또는 "computer")
  // @멘션으로 해당 MCP 툴을 활성화합니다.
  toolBots: Record<string, string>;
  // 대화 히스토리 기본 유지 개수 (기본값 20)
  historyLimit: number;
  // 채널별 히스토리 개수 오버라이드 { channelId: limit }
  channelLimits: Record<string, number>;
  // 글로벌 GitHub 레포 목록 ["owner/repo", ...]
  // /github add 커맨드로 관리, /github set으로 채널별 기본 레포 지정
  githubRepos: string[];
  /** 채팅 명령어 prefix 설정 */
  commands: CommandsConfig;
  /** Agent Workflow 리뷰 최대 재시도 횟수 (기본값: 2) */
  maxReviewRetries: number;

  // ── 하네스 설정 ────────────────────────────────────────────
  /** 사이클당 최대 turn 수 (기본값: 12) */
  maxTurnsPerCycle: number;
  /** 사이클 최대 실행 시간 분 단위 (기본값: 30) */
  maxCycleMinutes: number;
  /**
   * 역할 핀 자율 업데이트 활성화 여부 (기본값: false)
   * false: 오케스트레이터가 제안 → 유저 컨펌 후 적용 (Phase 1)
   * true:  오케스트레이터가 직접 적용 + 채널에 공지 (Phase 2)
   * 오케스트레이터 자신의 핀은 이 값과 무관하게 항상 유저 컨펌 필요
   */
  autonomousRoleUpdates: boolean;
}

// 프로젝트 루트 (src/../)
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'config.json');

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `설정 파일 없음: ${CONFIG_PATH}\n` +
      `data/config.json 을 생성하세요. (data/config.json.example 참고)`,
    );
  }

  let raw: AppConfig;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as AppConfig;
  } catch (err) {
    throw new Error(`config.json 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }

  // 필수 필드 검증
  if (!raw.collabChannel) throw new Error('config.json: collabChannel 누락');
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error('config.json: agents 배열 누락');
  }

  for (const a of raw.agents) {
    // id, name은 식별자이므로 필수
    for (const key of ['id', 'name'] as const) {
      if (!a[key]) throw new Error(`config.json: agents[${a.id ?? '?'}].${key} 누락`);
    }
    // 나머지 필드는 선택적 — 없으면 해당 기능만 비활성화
    if (!a.discordToken) console.warn(`⚠️  agents[${a.id}]: discordToken 없음 — 로그인 건너뜀`);
    if (!a.apiKey)       console.warn(`⚠️  agents[${a.id}]: apiKey 없음 — LLM 연동 불가`);
    if (!a.model)        console.warn(`⚠️  agents[${a.id}]: model 없음 — LLM 연동 불가`);
    if (!a.provider)     a.provider = 'anthropic'; // 기본값
    // personaFile: 상대 경로이면 프로젝트 루트 기준으로 절대 경로 변환
    a.personaFile = path.isAbsolute(a.personaFile)
      ? a.personaFile
      : path.resolve(PROJECT_ROOT, a.personaFile);

    // mcpTokens 기본값
    a.mcpTokens = a.mcpTokens ?? {};
  }

  return {
    collabChannel: raw.collabChannel,
    guildId: raw.guildId,
    adminPort: raw.adminPort ?? 3000,
    adminHost: raw.adminHost,
    agents: raw.agents,
    cmdBot: raw.cmdBot,
    toolBots: raw.toolBots ?? {},
    historyLimit: raw.historyLimit ?? 20,
    channelLimits: raw.channelLimits ?? {},
    githubRepos: raw.githubRepos ?? [],
    commands: {
      persona:    raw.commands?.persona    ?? ['!페르소나', '!persona'],
      help:       raw.commands?.help       ?? ['!도움말', '!help'],
      task:       raw.commands?.task       ?? ['!목표', '!task'],
      autonomous: raw.commands?.autonomous ?? ['!자율', '!pipeline'],
    },
    maxReviewRetries: raw.maxReviewRetries ?? 2,
    maxTurnsPerCycle: raw.maxTurnsPerCycle ?? 12,
    maxCycleMinutes: raw.maxCycleMinutes ?? 30,
    autonomousRoleUpdates: raw.autonomousRoleUpdates ?? false,
  };
}

/** config.json에 변경사항을 저장합니다 (Step 14 웹 UI용). */
export function saveConfig(cfg: AppConfig): void {
  // 저장 시 personaFile은 프로젝트 루트 기준 상대 경로로 변환
  const toSave: AppConfig = {
    ...cfg,
    agents: cfg.agents.map((a) => ({
      ...a,
      personaFile: path.relative(PROJECT_ROOT, a.personaFile),
    })),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
}
