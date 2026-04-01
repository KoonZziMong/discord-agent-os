/**
 * agentGraph/nodes/plannerNode.ts — 구현 계획 수립 노드
 *
 * Task 설명을 받아 LLM으로 구현 계획(파일 구조, 함수/클래스, 핵심 로직)을 작성합니다.
 */

import type { WorkflowContext } from '../types';

export async function plannerNode(ctx: WorkflowContext): Promise<string> {
  const { task, llm, agentSystemPrompt } = ctx;

  const { text } = await llm.chat(
    agentSystemPrompt,
    [
      {
        role: 'user',
        content: [
          `다음 태스크를 어떻게 구현할지 구체적인 계획을 작성해주세요.`,
          ``,
          `## 태스크`,
          `**${task.title}**`,
          ``,
          task.description,
          ``,
          `## 요청사항`,
          `- 구현에 필요한 파일 경로`,
          `- 함수/클래스 구조 및 시그니처`,
          `- 핵심 로직 흐름`,
          `- 주의해야 할 엣지 케이스`,
          ``,
          `계획은 개발자가 바로 구현할 수 있도록 구체적으로 작성해주세요.`,
        ].join('\n'),
      },
    ],
    [],
    async () => '',
  );

  return text;
}
