/**
 * gemmaRouter.ts — Gemma4 로컬 모델 기반 메시지 라우터
 *
 * 멘션 없는 유저 메시지를 받아 어떤 봇(들)이 응답해야 하는지 결정합니다.
 *
 * 동작 흐름:
 *   1. isAvailable() — Gemma 서버 alive 체크 (GET /v1/models)
 *   2. classify()    — 각 에이전트의 전체 컨텍스트를 프롬프트에 주입 후 분류
 *
 * classify() 주입 컨텍스트:
 *   - 각 봇의 역할 채널 핀 (getRoleContent)
 *   - 현재 채널 컨텍스트 (토픽 + 핀)
 *   - 대화 히스토리 (최근 historyLimit 개)
 *   - 새 메시지 내용
 *
 * 반환값:
 *   - Agent[]  : 응답해야 할 봇 목록 (1개 이상)
 *   - null     : 응답 불필요 또는 판단 불가 (fallback — 조용히 무시)
 */

import { Message } from 'discord.js';
import type { Agent } from './agent';
import type { AppConfig, GemmaRoutingConfig } from './config';
import { getChannelContext, ensureLoaded } from './channelContext';
import { getRoleContent, getRoleChannelId } from './roleContext';
import * as history from './history';

// ── 기본 라우팅 규칙 (rule 채널에 [GEMMA_ROUTER] 핀이 없을 때 사용) ──
const DEFAULT_ROUTING_RULES = [
  '규칙 (우선순위 순):',
  '1. 봇 이름을 직접 호칭하거나 언급한 경우 (예: "찌몽아", "아루야", "찌몽이", "아루한테") → 해당 봇을 반드시 포함합니다. 업무와 무관한 잡담, 게임, 농담이라도 포함합니다.',
  '2. 여러 봇의 이름이 언급된 경우 → 언급된 봇 모두 포함합니다.',
  '3. 특정 이름 없이 역할 관련 요청인 경우 (예: "코드 리뷰해줘", "개발해줘") → 해당 역할의 봇을 선택합니다.',
  '4. 모든 봇에게 해당하는 인사, 공지, 출석 체크 등 → 전체를 선택합니다.',
  '5. 봇 이름/역할 언급이 전혀 없고 봇과 완전히 무관한 내용 → 빈 배열을 반환합니다.',
].join('\n');

// ── 가용성 체크 ──────────────────────────────────────────────

let _available: boolean | null = null;   // null = 미확인
let _lastCheck = 0;
const RECHECK_INTERVAL_MS = 60_000;      // 1분마다 재확인

/**
 * Gemma 서버가 응답 가능한 상태인지 확인합니다.
 * 결과는 RECHECK_INTERVAL_MS 동안 캐시됩니다.
 */
export async function isAvailable(cfg: GemmaRoutingConfig): Promise<boolean> {
  const now = Date.now();
  if (_available !== null && now - _lastCheck < RECHECK_INTERVAL_MS) {
    return _available;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000); // ping 타임아웃 3초
    const res = await fetch(`${cfg.endpoint}/models`, { signal: controller.signal });
    clearTimeout(timer);
    _available = res.ok;
  } catch {
    _available = false;
  }

  _lastCheck = now;
  if (!_available) {
    console.warn('[GemmaRouter] 서버 응답 없음 — 라우팅 건너뜀');
  }
  return _available;
}

/** 외부에서 가용성 캐시를 강제 무효화합니다. (재시작 감지 등) */
export function invalidateAvailabilityCache(): void {
  _available = null;
  _lastCheck = 0;
}

// ── 프롬프트 빌더 ────────────────────────────────────────────

async function buildClassifyPrompt(
  message: Message,
  agents: Agent[],
  appCfg: AppConfig,
): Promise<string> {
  const cfg = appCfg.gemmaRouting!;
  const channelId = message.channelId;
  const guild = agents[0]?.botClient.guilds.cache.first() ?? null;
  const client = agents[0]?.botClient;

  // ── 각 봇의 전체 역할 컨텍스트 수집 ──
  const agentBlocks: string[] = [];
  for (const agent of agents) {
    const roleContent = guild && client
      ? await getRoleContent(
          agent.botClient,
          agent.id,
          channelId,
          agent.config.role,
          guild,
          false,
        ).catch(() => '')
      : '';

    agentBlocks.push(
      `=== ${agent.name} (역할: ${agent.config.role ?? '없음'}, ID: ${agent.id}) ===\n` +
      (roleContent || '(역할 정보 없음)'),
    );
  }

  // ── 현재 채널 컨텍스트 ──
  const ctx = getChannelContext(channelId);
  const channelCtx = [
    ctx.topic ? `채널 토픽: ${ctx.topic}` : '',
    ctx.pins.length > 0 ? `채널 핀:\n${ctx.pins.join('\n---\n')}` : '',
  ].filter(Boolean).join('\n');

  // ── 대화 히스토리 (최근 N개) ──
  // getHistory는 agentBotUserId 기준으로 role을 구분하므로,
  // 라우팅용으로는 첫 번째 봇 기준으로 가져온 뒤 내용만 사용합니다.
  const rawHistory = history.getHistory(channelId, agents[0]?.id ?? '', true);
  const recentHistory = rawHistory.slice(-cfg.historyLimit);
  const historyBlock = recentHistory.length > 0
    ? recentHistory.map((m) => `[${m.role === 'assistant' ? '봇' : '유저'}] ${m.content}`).join('\n')
    : '(대화 없음)';

  // ── 새 메시지 ──
  const senderName = message.member?.displayName ?? message.author.username;
  const newMessage = `${senderName}: ${message.content}`;

  // ── 봇 목록 (응답 형식 안내용) ──
  const botList = agents.map((a) => `"${a.name}"`).join(', ');

  // ── rule 채널에서 [GEMMA_ROUTER] 핀 조회 ──
  // ROLE 카테고리의 'rule' 채널 핀 중 [GEMMA_ROUTER]로 시작하는 것을 라우팅 규칙으로 사용합니다.
  // 없으면 DEFAULT_ROUTING_RULES를 사용합니다.
  let routingRules = DEFAULT_ROUTING_RULES;
  if (guild && client) {
    const ruleChannelId = getRoleChannelId(guild, 'rule');
    if (ruleChannelId) {
      await ensureLoaded(client, ruleChannelId);
      const ruleCtx = getChannelContext(ruleChannelId);
      const gemmaPin = ruleCtx.pins.find((p) => p.trimStart().startsWith('[GEMMA_ROUTER]'));
      if (gemmaPin) {
        // [GEMMA_ROUTER] 첫 줄 제거 후 본문만 추출
        routingRules = gemmaPin.trimStart().replace(/^\[GEMMA_ROUTER\][^\n]*\n?/, '').trim();
        console.log('[GemmaRouter] rule 채널 커스텀 규칙 적용');
      }
    }
  }

  return [
    '당신은 Discord 멀티봇 시스템의 라우터입니다.',
    '아래 정보를 바탕으로 새 메시지에 응답해야 할 봇을 결정하세요.',
    '',
    '━━ 봇 컨텍스트 ━━',
    agentBlocks.join('\n\n'),
    '',
    '━━ 채널 컨텍스트 ━━',
    channelCtx || '(없음)',
    '',
    '━━ 대화 히스토리 ━━',
    historyBlock,
    '',
    '━━ 새 메시지 ━━',
    newMessage,
    '',
    '━━ 지시사항 ━━',
    `응답 가능한 봇: ${botList}`,
    routingRules,
    '',
    '반드시 아래 JSON 형식만 출력하세요. 설명 없이 JSON만:',
    '{"targets": ["봇이름1", "봇이름2"]}',
    '또는',
    '{"targets": []}',
  ].join('\n');
}

// ── JSON 파싱 ────────────────────────────────────────────────

function parseTargets(text: string, agents: Agent[]): Agent[] {
  // JSON 블록 추출 (reasoning 모델이 생각 토큰을 먼저 출력할 수 있음)
  const jsonMatch = text.match(/\{[\s\S]*?"targets"[\s\S]*?\}/);
  if (!jsonMatch) return [];

  let parsed: { targets?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { targets?: unknown };
  } catch {
    console.warn('[GemmaRouter] JSON 파싱 실패:', jsonMatch[0].slice(0, 100));
    return [];
  }

  if (!Array.isArray(parsed.targets)) return [];

  const targets: Agent[] = [];
  for (const name of parsed.targets) {
    if (typeof name !== 'string') continue;
    const agent = agents.find(
      (a) => a.name === name || a.config.role === name || a.id === name,
    );
    if (agent) targets.push(agent);
  }
  return targets;
}

// ── 메인 분류 함수 ───────────────────────────────────────────

/**
 * 메시지를 분류하여 응답해야 할 에이전트 목록을 반환합니다.
 *
 * @returns Agent[] — 응답할 봇 목록 (빈 배열이면 응답 불필요)
 * @returns null    — Gemma 서버 불가 또는 오류 (조용한 fallback)
 */
export async function classify(
  message: Message,
  agents: Agent[],
  appCfg: AppConfig,
): Promise<Agent[] | null> {
  const cfg = appCfg.gemmaRouting;
  if (!cfg?.enabled) return null;

  // 가용성 체크
  const available = await isAvailable(cfg);
  if (!available) return null;

  // 프롬프트 구성
  let prompt: string;
  try {
    prompt = await buildClassifyPrompt(message, agents, appCfg);
  } catch (err) {
    console.warn('[GemmaRouter] 프롬프트 빌드 실패:', err instanceof Error ? err.message : err);
    return null;
  }

  // Gemma 호출
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
        temperature: 0,
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[GemmaRouter] HTTP ${res.status}`);
      _available = false; // 오류 시 캐시 무효화
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    console.log(`[GemmaRouter] 응답: ${content.slice(0, 120)}`);

    const targets = parseTargets(content, agents);
    console.log(`[GemmaRouter] 선택된 봇: [${targets.map((a) => a.name).join(', ') || '없음'}]`);
    return targets;

  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      console.warn(`[GemmaRouter] 타임아웃 (${cfg.timeoutMs}ms)`);
    } else {
      console.warn('[GemmaRouter] 호출 실패:', msg);
    }
    _available = false;
    return null;
  }
}
