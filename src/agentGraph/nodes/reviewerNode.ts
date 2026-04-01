/**
 * agentGraph/nodes/reviewerNode.ts — 코드 리뷰 노드
 *
 * developerNode 결과를 LLM으로 리뷰합니다.
 * - APPROVED: 승인, 다음 단계로 진행
 * - REVISION_NEEDED: 재작업 요청, 피드백 포함
 */

import type { WorkflowContext } from '../types';

export interface ReviewResult {
  approved: boolean;
  feedback: string;
}

export async function reviewerNode(
  ctx: WorkflowContext,
  plan: string,
  devResult: string,
): Promise<ReviewResult> {
  const { task, llm, agentSystemPrompt } = ctx;

  const { text } = await llm.chat(
    agentSystemPrompt,
    [
      {
        role: 'user',
        content: [
          `다음 태스크의 구현 결과를 리뷰해주세요.`,
          ``,
          `## 태스크`,
          `**${task.title}**`,
          ``,
          task.description,
          ``,
          `## 구현 계획`,
          plan,
          ``,
          `## 구현 결과`,
          devResult.slice(0, 2000),
          ``,
          `## 리뷰 기준`,
          `- 구현 계획의 핵심 요구사항이 충족되었는가`,
          `- 명백한 버그나 누락된 로직이 없는가`,
          `- 기존 코드베이스와 일관성이 있는가`,
          ``,
          `## 응답 형식`,
          `첫 줄에 반드시 "APPROVED" 또는 "REVISION_NEEDED" 중 하나만 쓰세요.`,
          `REVISION_NEEDED인 경우 그 다음 줄부터 구체적인 수정 요청을 작성하세요.`,
        ].join('\n'),
      },
    ],
    [],
    async () => '',
  );

  const approved = text.trimStart().startsWith('APPROVED');
  return { approved, feedback: text };
}
