/**
 * retrospective.ts — 사이클 완료 후 회고 및 역할 핀 개선 제안
 *
 * 사이클(TaskGraph)이 완료되면 오케스트레이터가 이 모듈을 호출합니다.
 *
 * 흐름:
 *   1. 완료된 TaskGraph에서 문제가 발생한 Task 추출
 *   2. LLM이 문제 패턴 분석 → 역할별 개선 제안 생성 (step 1 / step 2 구분)
 *   3. [ROLE_UPDATE_PROPOSAL] 메시지를 채널에 전송 + 제안 파일 저장
 *   4. 유저가 ✅/❌ 반응 → index.ts의 핸들러가 처리
 *
 * ## 제안 범위 (scope)
 *   - global: ROLE 카테고리 채널 수정 (모든 프로젝트에 공통 적용)
 *   - project: 현재 채널의 카테고리/role 채널 수정 (이 프로젝트에만 적용)
 *
 * 역할 채널 탐색:
 *   Discord 길드에서 "role" 카테고리 하위의 채널 이름으로 찾습니다.
 *   (예: role/developer, role/reviewer)
 */

import { randomUUID } from 'crypto';
import type { Client, TextChannel, Guild, CategoryChannel } from 'discord.js';
import type { LLMClient } from './llm';
import type { TaskGraphData } from './task/types';
import { ROLE_UPDATE_PROPOSAL_SENTINEL } from './agentProtocol';
import { saveProposal } from './roleProposals';
import { fetchRoleContent } from './roleContext';

// 24시간 (ms)
const PROPOSAL_TTL = 24 * 60 * 60 * 1000;

/**
 * 역할 핀 내용의 권장 최대 크기 (chars).
 * 이 값을 넘으면 LLM에게 내용 정리(pruning)를 명시적으로 요청합니다.
 * 역할 내용은 매 LLM 호출 시 system prompt에 주입되므로 토큰 비용에 직결됩니다.
 */
const ROLE_CONTENT_SOFT_BUDGET = 1500;

/**
 * 완료된 사이클의 태스크 결과에서 이슈 요약을 추출합니다.
 */
function extractIssues(graph: TaskGraphData): string {
  const issues: string[] = [];

  for (const task of graph.tasks) {
    if (task.status === 'failed') {
      issues.push(`- [${task.id}] ${task.title}: FAILED\n  오류: ${(task.error ?? '').slice(0, 200)}`);
    } else if (task.status === 'completed' && task.result) {
      // 결과에 REVISION_NEEDED 패턴이 있으면 이슈로 추출
      if (task.result.includes('REVISION_NEEDED')) {
        issues.push(`- [${task.id}] ${task.title}: REVISION_NEEDED 발생\n  결과: ${task.result.slice(0, 200)}`);
      }
      if (task.result.includes('BLOCKED')) {
        issues.push(`- [${task.id}] ${task.title}: BLOCKED 발생\n  결과: ${task.result.slice(0, 200)}`);
      }
    }
  }

  return issues.length > 0 ? issues.join('\n') : '(이슈 없음 — 정상 완료)';
}

/**
 * 길드에서 "role" 카테고리 하위의 역할 채널 목록을 조회합니다.
 * { roleName → channelId } 형태로 반환합니다.
 */
async function findRoleChannels(guild: Guild): Promise<Record<string, string>> {
  const roleChannels: Record<string, string> = {};

  const category = guild.channels.cache.find(
    (c): c is CategoryChannel => c.type === 4 /* GuildCategory */ && c.name.toLowerCase() === 'role',
  );
  if (!category) return roleChannels;

  for (const [, channel] of guild.channels.cache) {
    if (channel.parentId === category.id && channel.type === 0 /* GuildText */) {
      roleChannels[channel.name] = channel.id;
    }
  }
  return roleChannels;
}

/**
 * 현재 채널의 카테고리 안 "role" 채널을 찾아 반환합니다. (Step 2 대상)
 *
 * - ROLE 카테고리에 속한 채널이면 null (step 1과 중복 방지)
 * - 카테고리가 없거나 "role" 채널이 없으면 null
 */
function findCategoryRoleChannel(
  guild: Guild,
  channelId: string,
): { channelId: string; categoryName: string } | null {
  const currentChannel = guild.channels.cache.get(channelId);
  if (!currentChannel || !currentChannel.parentId) return null;

  const categoryId = currentChannel.parentId;

  // ROLE 카테고리 소속이면 제외 (순환 방지)
  const roleCategory = guild.channels.cache.find(
    (c) => c.type === 4 /* GuildCategory */ && c.name.toLowerCase() === 'role',
  );
  if (roleCategory && categoryId === roleCategory.id) return null;

  const category = guild.channels.cache.get(categoryId);
  const categoryName = category?.name ?? '(알 수 없음)';

  const roleChannel = guild.channels.cache.find(
    (c) => c.parentId === categoryId && c.type === 0 /* GuildText */ && c.name.toLowerCase() === 'role',
  );
  if (!roleChannel) return null;

  return { channelId: roleChannel.id, categoryName };
}

/**
 * 채널의 핀 내용 + 크기를 로드합니다.
 */
async function loadChannelContent(
  client: Client,
  channelId: string,
): Promise<{ content: string; size: number; overBudget: boolean }> {
  const content = await fetchRoleContent(client, channelId);
  const size = content.length;
  return { content, size, overBudget: size > ROLE_CONTENT_SOFT_BUDGET };
}

/**
 * LLM을 사용해 이슈를 분석하고 역할 핀 개선 제안을 생성합니다.
 * 역할 채널 내용은 핀 메시지를 Discord API에서 직접 가져옵니다.
 *
 * scope:
 *   - global: ROLE 카테고리 채널 수정 (모든 프로젝트에 공통)
 *   - project: 현재 채널 카테고리의 role 채널 수정 (이 프로젝트에만 적용)
 *
 * @returns 제안 목록 — 개선이 필요 없으면 빈 배열
 */
async function generateProposals(
  llm: LLMClient,
  client: Client,
  graph: TaskGraphData,
  issuesSummary: string,
  roleChannels: Record<string, string>,
  agentSystemPrompt: string,
  categoryRoleChannel: { channelId: string; categoryName: string } | null,
): Promise<Array<{
  targetRole: string;
  roleChannelId: string;
  newContent: string;
  reasoning: string;
  proposalScope: 'global' | 'project';
}>> {
  if (issuesSummary === '(이슈 없음 — 정상 완료)') return [];

  // Step 1: ROLE 카테고리 채널 핀 로드 + 크기 측정
  const roleContentMap: Record<string, { content: string; size: number; overBudget: boolean }> = {};
  await Promise.all(
    Object.entries(roleChannels).map(async ([role, id]) => {
      roleContentMap[role] = await loadChannelContent(client, id);
    }),
  );

  const step1Summary = Object.entries(roleChannels)
    .map(([role, id]) => {
      const { content, size, overBudget } = roleContentMap[role];
      const sizeTag = overBudget
        ? ` ⚠️ ${size}자 (권장 ${ROLE_CONTENT_SOFT_BUDGET}자 초과 — 정리 필요)`
        : ` (${size}자)`;
      return `### ${role}${sizeTag}\nID: ${id}\n${content || '(내용 없음)'}`;
    })
    .join('\n\n');

  // Step 2: 카테고리 role 채널 핀 로드
  let step2Summary = '(없음 — 이 프로젝트 카테고리에 role 채널이 없습니다)';
  let step2ChannelId: string | null = null;
  if (categoryRoleChannel) {
    step2ChannelId = categoryRoleChannel.channelId;
    const { content, size, overBudget } = await loadChannelContent(client, step2ChannelId);
    const sizeTag = overBudget
      ? ` ⚠️ ${size}자 (권장 ${ROLE_CONTENT_SOFT_BUDGET}자 초과 — 정리 필요)`
      : ` (${size}자)`;
    step2Summary = `채널 ID: ${step2ChannelId}${sizeTag}\n${content || '(내용 없음)'}`;
  }

  // 토큰 예산 초과 역할 목록 (step 1)
  const overBudgetRoles = Object.entries(roleContentMap)
    .filter(([, v]) => v.overBudget)
    .map(([role]) => role);

  const pruningInstruction = overBudgetRoles.length > 0
    ? `\n\n## ⚠️ 토큰 예산 초과 역할 (Step 1): ${overBudgetRoles.join(', ')}
역할 내용은 매 LLM 호출마다 system prompt에 주입되므로 크기가 토큰 비용에 직결됩니다.
위 역할은 내용 정리가 필요합니다. newContent 작성 시 다음을 반드시 적용하세요:
- 한 번도 위반되지 않은 규칙 → 삭제
- 중복·유사한 내용 → 하나로 통합
- 예시 코드 블록 → 제거 또는 1줄 요약으로 대체
- 목표: 핵심 지침만 남겨 ${ROLE_CONTENT_SOFT_BUDGET}자 이내로 압축`
    : '';

  const step2Instruction = categoryRoleChannel
    ? `\n\n## Step 2 — 프로젝트 커스텀 채널 ("${categoryRoleChannel.categoryName}/role")
이 채널은 현재 프로젝트(카테고리)에만 적용되는 커스텀 지침을 담습니다.
scope: "project" 제안은 이 채널을 수정합니다. 채널이 비어있으면 새 내용이 핀으로 추가됩니다.`
    : `\n\n## Step 2 — 프로젝트 커스텀 채널
현재 없음. scope: "project" 제안을 생성하면 적용 시 채널이 자동 생성되지 않으므로,
이번 사이클에서는 step 1(global) 제안만 생성하세요.`;

  const prompt = `당신은 AI 에이전트 팀의 오케스트레이터입니다.
방금 완료된 작업 사이클을 회고하고 역할 정의를 개선하는 역할을 합니다.

## 완료된 목표
${graph.goal}

## 발생한 이슈
${issuesSummary}

---

## [Step 1] 글로벌 역할 채널 — 모든 프로젝트에 공통 적용
${step1Summary}${pruningInstruction}

## [Step 2] 프로젝트 커스텀 채널 — 이 프로젝트에만 적용
${step2Summary}${step2Instruction}

---

## 지시
위 이슈를 분석하여 역할 핀을 개선하세요. 제안마다 **scope**를 반드시 결정하세요:

- scope **"global"**: 이번 이슈가 모든 프로젝트에 해당하는 역할 정의 문제 → Step 1 채널 수정
- scope **"project"**: 이번 프로젝트에만 해당하는 특수 지침이 필요 → Step 2 채널 수정

각 제안에서 다음 두 가지를 고려하세요:
1. **추가**: 이번 이슈를 막을 수 있었던 구체적 지침을 추가
2. **정리**: 불필요해진 내용, 중복, 한 번도 위반되지 않은 규칙은 제거

개선이 필요한 경우에만 제안하세요.
newContent는 추가와 정리가 모두 반영된 최종 전체 내용이어야 합니다.

반드시 다음 JSON 형식으로만 응답하세요:
[
  {
    "targetRole": "역할명 (orchestrator/planner/developer/reviewer/tester/researcher 중 하나)",
    "scope": "global 또는 project",
    "reasoning": "scope 선택 이유 + 추가/정리 내용을 각각 1문장으로 설명",
    "newContent": "최종 핀 전체 내용 (마크다운, ${ROLE_CONTENT_SOFT_BUDGET}자 이내 권장)"
  }
]

변경이 전혀 필요 없으면 빈 배열 [] 을 반환하세요.`;

  try {
    const { text } = await llm.chat(
      agentSystemPrompt,
      [{ role: 'user', content: prompt }],
      [],
      async () => '',
    );

    // JSON 파싱
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const parsed = JSON.parse(jsonMatch[1].trim()) as Array<{
      targetRole: string;
      scope?: string;
      reasoning: string;
      newContent: string;
    }>;

    if (!Array.isArray(parsed)) return [];

    const results: Array<{
      targetRole: string;
      roleChannelId: string;
      newContent: string;
      reasoning: string;
      proposalScope: 'global' | 'project';
    }> = [];

    for (const p of parsed) {
      if (!p.targetRole || !p.newContent) continue;

      const scope = p.scope === 'project' ? 'project' : 'global';

      if (scope === 'global') {
        // step 1: ROLE 카테고리 채널 수정
        if (!roleChannels[p.targetRole]) continue;
        results.push({
          targetRole: p.targetRole,
          roleChannelId: roleChannels[p.targetRole],
          newContent: p.newContent,
          reasoning: p.reasoning ?? '',
          proposalScope: 'global',
        });
      } else {
        // step 2: 카테고리/role 채널 수정 (채널이 없으면 스킵)
        if (!step2ChannelId) {
          console.warn(`[retrospective] scope=project 제안이 있지만 카테고리 role 채널 없음 — 스킵 (role: ${p.targetRole})`);
          continue;
        }
        results.push({
          targetRole: p.targetRole,
          roleChannelId: step2ChannelId,
          newContent: p.newContent,
          reasoning: p.reasoning ?? '',
          proposalScope: 'project',
        });
      }
    }

    return results;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[retrospective] LLM 분석 실패: ${msg.slice(0, 100)}`);
    return [];
  }
}

/**
 * 사이클 완료 후 회고를 실행합니다.
 * Agent.startTaskGraph() 완료 시점에 호출됩니다.
 */
export async function runRetrospective(opts: {
  graph: TaskGraphData;
  llm: LLMClient;
  client: Client;          // 역할 채널 핀 조회용 Discord 클라이언트
  agentSystemPrompt: string;
  channel: TextChannel;
  userId: string;          // 제안 메시지에서 멘션할 유저 ID
  cycleId?: string;        // 하네스 cycleId (없으면 graphId 사용)
}): Promise<void> {
  const { graph, llm, client, agentSystemPrompt, channel, userId, cycleId } = opts;

  console.log(`[retrospective] 사이클 ${graph.id} 회고 시작...`);

  // 1. 이슈 추출
  const issuesSummary = extractIssues(graph);
  if (issuesSummary === '(이슈 없음 — 정상 완료)') {
    console.log('[retrospective] 이슈 없음 — 회고 생략');
    return;
  }

  // 2. 역할 채널 목록 조회 (Step 1)
  const guild = channel.guild;
  const roleChannels = await findRoleChannels(guild);
  if (Object.keys(roleChannels).length === 0) {
    console.warn('[retrospective] 역할 채널 없음 — /role init을 실행하세요');
    return;
  }

  // 3. 현재 채널의 카테고리 role 채널 탐색 (Step 2)
  const categoryRoleChannel = findCategoryRoleChannel(guild, channel.id);
  if (categoryRoleChannel) {
    console.log(`[retrospective] Step 2 채널 발견: ${categoryRoleChannel.categoryName}/role (${categoryRoleChannel.channelId})`);
  } else {
    console.log('[retrospective] Step 2 채널 없음 — global 제안만 생성');
  }

  // 4. LLM 분석 — step 1 / step 2 구분 제안 생성
  const proposals = await generateProposals(
    llm, client, graph, issuesSummary, roleChannels, agentSystemPrompt, categoryRoleChannel,
  );
  if (proposals.length === 0) {
    console.log('[retrospective] 제안할 개선 사항 없음');
    return;
  }

  // 5. 각 제안을 Discord 메시지로 전송 + 파일 저장
  for (const proposal of proposals) {
    const proposalId = randomUUID();
    const now = Date.now();

    const scopeLabel = proposal.proposalScope === 'project'
      ? `프로젝트 커스텀 (\`${categoryRoleChannel?.categoryName}/role\`) — \`${proposal.targetRole}\` 관련`
      : `글로벌 역할 \`${proposal.targetRole}\``;

    const messageContent = [
      ROLE_UPDATE_PROPOSAL_SENTINEL,
      `cycleId: ${cycleId ?? graph.id}`,
      `targetRole: ${proposal.targetRole}`,
      `proposalId: ${proposalId}`,
      `scope: ${proposal.proposalScope}`,
      '',
      `<@${userId}> 역할 핀 업데이트를 제안합니다.`,
      '',
      `**대상:** ${scopeLabel}`,
      `**제안 이유:** ${proposal.reasoning}`,
      '',
      '**새 핀 내용 미리보기:**',
      '```',
      proposal.newContent.slice(0, 800) + (proposal.newContent.length > 800 ? '\n...(이하 생략)' : ''),
      '```',
      '',
      '승인: ✅ 이모지 반응 | 거부: ❌ 이모지 반응',
      `-# 제안은 24시간 후 만료됩니다. proposalId: ${proposalId}`,
    ].join('\n');

    try {
      const msg = await channel.send(messageContent);

      // 제안 파일 저장
      saveProposal({
        proposalId,
        cycleId: cycleId ?? graph.id,
        targetRole: proposal.targetRole,
        roleChannelId: proposal.roleChannelId,
        newContent: proposal.newContent,
        discordMessageId: msg.id,
        channelId: channel.id,
        createdAt: now,
        expiresAt: now + PROPOSAL_TTL,
        proposalScope: proposal.proposalScope,
      });

      // 반응 추가 (편의용)
      await msg.react('✅').catch(() => {});
      await msg.react('❌').catch(() => {});

      console.log(`[retrospective] 제안 전송: ${proposalId} (role: ${proposal.targetRole}, scope: ${proposal.proposalScope})`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[retrospective] 제안 전송 실패 (${proposal.targetRole}): ${errMsg}`);
    }
  }
}
