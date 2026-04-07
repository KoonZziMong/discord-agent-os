/**
 * agentGraph/nodes/developerNode.ts — 코드 구현 노드
 *
 * plannerNode가 작성한 계획을 Claude Code에 전달하여 실제 코드를 작성합니다.
 * 같은 Task 내 재시도(리뷰 루프)는 동일 세션을 이어 사용합니다.
 * sessionKey = `${graphId}:${task.id}`
 */

import type { WorkflowContext } from '../types';

export async function developerNode(
  ctx: WorkflowContext,
  plan: string,
  reviewFeedback?: string,
  attempt = 0,
): Promise<string> {
  const { task, graphId, channelId, runCode } = ctx;
  const sessionKey = `${graphId}:${task.id}`;

  const prompt = [
    `# 구현 태스크: ${task.title}`,
    ``,
    `## 작업 내용`,
    task.description,
    ``,
    `## 구현 계획`,
    plan,
    reviewFeedback
      ? [``, `## 리뷰 피드백 (반드시 반영)`, reviewFeedback].join('\n')
      : '',
    ``,
    `## 지시사항`,
    `- 위 계획에 따라 실제 코드를 작성하세요.`,
    `- 기존 코드 컨벤션을 따르세요.`,
    `- 작업 완료 후 변경/생성된 파일 목록을 요약해서 보고하세요.`,
  ].filter(Boolean).join('\n');

  const result = await runCode({
    task: prompt,
    resume: attempt > 0,
    channelId,
    sessionKey,
  });

  return result.text;
}
