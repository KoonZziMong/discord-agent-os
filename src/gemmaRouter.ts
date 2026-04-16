/**
 * gemmaRouter.ts — Gemma4 로컬 모델 기반 메시지 라우터
 *
 * 멘션 없는 유저 메시지를 받아 어떤 봇(들)이 응답해야 하는지 결정합니다.
 *
 * 동작 흐름:
 *   1. isAvailable() — Gemma 서버 alive 체크 (GET /v1/models)
 *   2. classify()    — 각 에이전트의 전체 컨텍스트를 프롬프트에 주입 후 분류
 *
 * classify() 반환값:
 *   - GemmaResult  : targets(봇 목록) + reason(판단 이유) + gemmaName(표시 이름)
 *     - targets 비어있음 → 응답 봇 없음, reason으로 CmdBot이 설명
 *   - null         — Gemma 서버 불가 또는 오류 (조용한 fallback)
 */

import { Message } from 'discord.js';
import type { Agent } from './agent';
import type { AppConfig, GemmaRoutingConfig } from './config';
import { getChannelContext, ensureLoaded } from './channelContext';
import { getRoleContent, getRoleChannelId } from './roleContext';
import * as history from './history';

// ── 타입 ─────────────────────────────────────────────────────

export interface GemmaResult {
  targets: Agent[];
  reason: string;
  gemmaName: string;  // [GEMMA_ROUTER] 핀의 name: 값 (기본값: "Gemma")
}

// ── 기본 라우팅 규칙 (rule 채널에 [GEMMA_ROUTER] 핀이 없을 때 사용) ──
const DEFAULT_ROUTING_RULES = [
  '규칙 (우선순위 순):',
  '1. 봇 이름을 직접 호칭하거나 언급한 경우 (예: "찌몽아", "아루야", "찌몽이", "아루한테") → 해당 봇을 반드시 포함합니다. 업무와 무관한 잡담, 게임, 농담이라도 포함합니다.',
  '2. 여러 봇의 이름이 언급된 경우 → 언급된 봇 모두 포함합니다.',
  '3. 특정 이름 없이 역할 관련 요청인 경우 (예: "코드 리뷰해줘", "개발해줘") → 해당 역할의 봇을 선택합니다.',
  '4. 모든 봇에게 해당하는 인사, 공지, 출석 체크 등 → 전체를 선택합니다.',
  '5. 봇 이름/역할 언급이 전혀 없고 봇과 완전히 무관한 내용 → 빈 배열을 반환합니다.',
].join('\n');

const DEFAULT_GEMMA_NAME = 'Gemma';

// ── 가용성 체크 ──────────────────────────────────────────────

let _available: boolean | null = null;
let _lastCheck = 0;
const RECHECK_INTERVAL_MS = 60_000;

/** 마지막으로 파싱된 gemmaName 캐시 (오류 시 표시용) */
let _cachedGemmaName = DEFAULT_GEMMA_NAME;

export async function isAvailable(cfg: GemmaRoutingConfig): Promise<boolean> {
  const now = Date.now();
  if (_available !== null && now - _lastCheck < RECHECK_INTERVAL_MS) {
    return _available;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${cfg.endpoint}/models`, { signal: controller.signal });
    clearTimeout(timer);
    _available = res.ok;
  } catch {
    _available = false;
  }

  _lastCheck = now;
  if (!_available) {
    console.warn('[GemmaRouter] 서버 응답 없음');
  }
  return _available;
}

export function invalidateAvailabilityCache(): void {
  _available = null;
  _lastCheck = 0;
}

// ── [GEMMA_ROUTER] 핀 파싱 ───────────────────────────────────

interface GemmaPinData {
  name: string;
  rules: string;
}

function parseGemmaPin(pinContent: string): GemmaPinData {
  // [GEMMA_ROUTER] 헤더 줄 제거
  const body = pinContent.trimStart().replace(/^\[GEMMA_ROUTER\][^\n]*\n?/, '');

  // name: 값 추출 (있으면 사용, 없으면 기본값)
  const nameMatch = body.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : DEFAULT_GEMMA_NAME;

  // name: 줄 제거한 나머지가 규칙 본문
  const rules = body.replace(/^name:[^\n]*\n?/m, '').trim();

  return { name, rules };
}

// ── 프롬프트 빌더 ────────────────────────────────────────────

async function buildClassifyPrompt(
  message: Message,
  agents: Agent[],
  appCfg: AppConfig,
): Promise<{ prompt: string; gemmaName: string }> {
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
  const rawHistory = history.getHistory(channelId, agents[0]?.id ?? '', true);
  const recentHistory = rawHistory.slice(-cfg.historyLimit);
  const historyBlock = recentHistory.length > 0
    ? recentHistory.map((m) => `[${m.role === 'assistant' ? '봇' : '유저'}] ${m.content}`).join('\n')
    : '(대화 없음)';

  // ── 새 메시지 ──
  const senderName = message.member?.displayName ?? message.author.username;
  const newMessage = `${senderName}: ${message.content}`;

  // ── 봇 목록 ──
  const botList = agents.map((a) => `"${a.name}"`).join(', ');

  // ── rule 채널에서 [GEMMA_ROUTER] 핀 조회 ──
  let routingRules = DEFAULT_ROUTING_RULES;
  let gemmaName = DEFAULT_GEMMA_NAME;

  if (guild && client) {
    const ruleChannelId = getRoleChannelId(guild, 'rule');
    if (ruleChannelId) {
      await ensureLoaded(client, ruleChannelId);
      const ruleCtx = getChannelContext(ruleChannelId);
      const gemmaPin = ruleCtx.pins.find((p) => p.trimStart().startsWith('[GEMMA_ROUTER]'));
      if (gemmaPin) {
        const parsed = parseGemmaPin(gemmaPin);
        gemmaName = parsed.name;
        _cachedGemmaName = gemmaName; // 오류 시 표시용 캐시 갱신
        if (parsed.rules) routingRules = parsed.rules;
        console.log(`[GemmaRouter] rule 채널 커스텀 규칙 적용 (name: ${gemmaName})`);
      }
    }
  }

  const prompt = [
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
    '반드시 아래 JSON 형식만 출력하세요. 설명 없이 JSON만.',
    'reason에는 선택 이유를 한 줄로 간결하게 작성하세요 (타겟이 없을 때도 이유를 작성하세요):',
    '{"targets": ["봇이름1", "봇이름2"], "reason": "선택 이유"}',
    '또는',
    '{"targets": [], "reason": "타겟 미선택 이유"}',
  ].join('\n');

  return { prompt, gemmaName };
}

// ── JSON 파싱 ────────────────────────────────────────────────

function parseResult(
  text: string,
  agents: Agent[],
  gemmaName: string,
): GemmaResult {
  const jsonMatch = text.match(/\{[\s\S]*?"targets"[\s\S]*?\}/);
  if (!jsonMatch) return { targets: [], reason: '응답 파싱 실패', gemmaName };

  let parsed: { targets?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { targets?: unknown; reason?: unknown };
  } catch {
    console.warn('[GemmaRouter] JSON 파싱 실패:', jsonMatch[0].slice(0, 100));
    return { targets: [], reason: 'JSON 파싱 실패', gemmaName };
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason : '이유 없음';

  if (!Array.isArray(parsed.targets)) {
    return { targets: [], reason, gemmaName };
  }

  const targets: Agent[] = [];
  for (const name of parsed.targets) {
    if (typeof name !== 'string') continue;
    const agent = agents.find(
      (a) => a.name === name || a.config.role === name || a.id === name,
    );
    if (agent) targets.push(agent);
  }

  return { targets, reason, gemmaName };
}

// ── 메인 분류 함수 ───────────────────────────────────────────

/**
 * 메시지를 분류하여 GemmaResult를 반환합니다.
 *
 * @returns GemmaResult  — targets(응답 봇), reason(이유), gemmaName(표시명)
 *   - targets.length === 0 → 응답 봇 없음, reason으로 CmdBot이 설명
 * @returns null          — Gemma 서버 불가 또는 오류 (조용한 fallback)
 */
/**
 * 메시지를 분류하여 GemmaResult를 반환합니다.
 *
 * @returns GemmaResult  — targets(응답 봇), reason(이유), gemmaName(표시명)
 *   - targets.length > 0  → 해당 봇들이 응답
 *   - targets.length === 0 → CmdBot이 reason으로 설명 (Gemma 판단 or 오류)
 * @returns null           — gemmaRouting.enabled = false (완전 무응답)
 */
export async function classify(
  message: Message,
  agents: Agent[],
  appCfg: AppConfig,
): Promise<GemmaResult | null> {
  const cfg = appCfg.gemmaRouting;
  if (!cfg?.enabled) return null;

  // 서버 불가 → CmdBot에 알림
  const available = await isAvailable(cfg);
  if (!available) {
    return { targets: [], reason: `서버(${cfg.endpoint})에 연결할 수 없습니다`, gemmaName: _cachedGemmaName };
  }

  let prompt: string;
  let gemmaName: string;
  try {
    ({ prompt, gemmaName } = await buildClassifyPrompt(message, agents, appCfg));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn('[GemmaRouter] 프롬프트 빌드 실패:', errMsg);
    return { targets: [], reason: `컨텍스트 빌드 오류: ${errMsg.slice(0, 60)}`, gemmaName: _cachedGemmaName };
  }

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
      _available = false;
      return { targets: [], reason: `서버 오류 (HTTP ${res.status})`, gemmaName };
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    console.log(`[GemmaRouter] 응답: ${content.slice(0, 200)}`);

    const result = parseResult(content, agents, gemmaName);
    console.log(`[GemmaRouter] 선택된 봇: [${result.targets.map((a) => a.name).join(', ') || '없음'}] | 이유: ${result.reason}`);
    return result;

  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const reason = msg.includes('abort')
      ? `응답 시간 초과 (${cfg.timeoutMs / 1000}초)`
      : `호출 실패: ${msg.slice(0, 60)}`;
    console.warn(`[GemmaRouter] ${reason}`);
    _available = false;
    return { targets: [], reason, gemmaName };
  }
}
