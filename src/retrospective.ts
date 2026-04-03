/**
 * retrospective.ts — 사이클 완료 후 회고 및 역할 핀 개선 제안
 *
 * 사이클(TaskGraph)이 완료되면 오케스트레이터가 이 모듈을 호출합니다.
 *
 * 흐름:
 *   1. 완료된 TaskGraph에서 문제가 발생한 Task 추출
 *   2. LLM이 문제 패턴 분석 → 역할별 개선 제안 생성
 *   3. [ROLE_UPDATE_PROPOSAL] 메시지를 채널에 전송 + 제안 파일 저장
 *   4. 유저가 ✅/❌ 반응 → index.ts의 핸들러가 처리
 *
 * 역할 채널 탐색:
 *   Discord 길드에서 "역할" 카테고리 하위의 채널 이름으로 찾습니다.
 *   (예: 역할/developer, 역할/reviewer)
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
 * 길드에서 "역할" 카테고리 하위의 역할 채널 목록을 조회합니다.
 * { roleName → channelId } 형태로 반환합니다.
 */
async function findRoleChannels(guild: Guild): Promise<Record<string, string>> {
  const roleChannels: Record<string, string> = {};

  const category = guild.channels.cache.find(
    (c): c is CategoryChannel => c.type === 4 /* GuildCategory */ && c.name === '역할',
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
 * LLM을 사용해 이슈를 분석하고 역할 핀 개선 제안을 생성합니다.
 * 역할 채널 내용은 핀 메시지를 Discord API에서 직접 가져옵니다.
 *
 * @returns 제안 목록 (역할별) — 개선이 필요 없으면 빈 배열
 */
async function generateProposals(
  llm: LLMClient,
  client: Client,
  graph: TaskGraphData,
  issuesSummary: string,
  roleChannels: Record<string, string>,
  agentSystemPrompt: string,
): Promise<Array<{ targetRole: string; roleChannelId: string; newContent: string; reasoning: string }>> {
  if (issuesSummary === '(이슈 없음 — 정상 완료)') return [];

  // 역할 채널 핀을 Discord API에서 직접 조회 (캐시 의존 없음)
  const roleChannelSummary = (
    await Promise.all(
      Object.entries(roleChannels).map(async ([role, id]) => {
        const content = await fetchRoleContent(client, id);
        return `### ${role} 채널 (ID: ${id})\n${content.slice(0, 800) || '(내용 없음)'}`;
      }),
    )
  ).join('\n\n');

  const prompt = `당신은 AI 에이전트 팀의 오케스트레이터입니다.
방금 완료된 작업 사이클을 회고하고 역할 정의를 개선하는 역할을 합니다.

## 완료된 목표
${graph.goal}

## 발생한 이슈
${issuesSummary}

## 현재 역할 채널 내용
${roleChannelSummary}

## 지시
위 이슈를 분석하여, 다음에 같은 실수가 반복되지 않도록 역할 핀 내용을 개선하세요.
개선이 필요한 역할에 대해서만 제안하고, 불필요한 변경은 하지 마세요.

반드시 다음 JSON 형식으로만 응답하세요:
[
  {
    "targetRole": "역할명 (developer/reviewer/tester/planner/researcher 중 하나)",
    "reasoning": "왜 이 역할의 핀을 수정해야 하는지 (1-2문장)",
    "newContent": "새 핀 전체 내용 (기존 핀을 개선한 완전한 버전, 마크다운)"
  }
]

개선이 필요 없으면 빈 배열 [] 을 반환하세요.`;

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
      reasoning: string;
      newContent: string;
    }>;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((p) => p.targetRole && p.newContent && roleChannels[p.targetRole])
      .map((p) => ({
        targetRole: p.targetRole,
        roleChannelId: roleChannels[p.targetRole],
        newContent: p.newContent,
        reasoning: p.reasoning ?? '',
      }));
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

  // 2. 역할 채널 목록 조회
  const guild = channel.guild;
  const roleChannels = await findRoleChannels(guild);
  if (Object.keys(roleChannels).length === 0) {
    console.warn('[retrospective] 역할 채널 없음 — /role init을 실행하세요');
    return;
  }

  // 3. LLM 분석 — 역할 채널 핀을 Discord API에서 직접 읽어 분석
  const proposals = await generateProposals(llm, client, graph, issuesSummary, roleChannels, agentSystemPrompt);
  if (proposals.length === 0) {
    console.log('[retrospective] 제안할 개선 사항 없음');
    return;
  }

  // 4. 각 제안을 Discord 메시지로 전송 + 파일 저장
  for (const proposal of proposals) {
    const proposalId = randomUUID();
    const now = Date.now();

    const messageContent = [
      ROLE_UPDATE_PROPOSAL_SENTINEL,
      `cycleId: ${cycleId ?? graph.id}`,
      `targetRole: ${proposal.targetRole}`,
      `proposalId: ${proposalId}`,
      '',
      `<@${userId}> 역할 핀 업데이트를 제안합니다.`,
      '',
      `**대상 역할:** \`${proposal.targetRole}\``,
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
      });

      // 반응 추가 (편의용)
      await msg.react('✅').catch(() => {});
      await msg.react('❌').catch(() => {});

      console.log(`[retrospective] 제안 전송: ${proposalId} (role: ${proposal.targetRole})`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[retrospective] 제안 전송 실패 (${proposal.targetRole}): ${errMsg}`);
    }
  }
}
