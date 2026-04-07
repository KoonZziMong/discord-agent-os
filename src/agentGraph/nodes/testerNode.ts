/**
 * agentGraph/nodes/testerNode.ts — 테스트 실행 노드
 *
 * developerNode와 동일 세션을 이어받아 테스트를 실행합니다.
 * 기존 테스트가 있으면 실행하고, 없으면 기본 동작 검증을 수행합니다.
 */

import type { WorkflowContext } from '../types';

export async function testerNode(ctx: WorkflowContext, devResult: string): Promise<string> {
  const { task, graphId, channelId, runCode } = ctx;
  const sessionKey = `${graphId}:${task.id}`;

  const prompt = [
    `# 테스트: ${task.title}`,
    ``,
    `## 구현 결과 요약`,
    devResult.slice(0, 500),
    ``,
    `## 지시사항`,
    `구현된 코드가 올바르게 동작하는지 확인하세요.`,
    `1. 관련 테스트 파일이 있으면 실행하세요 (예: npm test, npx tsc --noEmit 등).`,
    `2. 테스트가 없으면 TypeScript 타입 체크만 수행하세요.`,
    `3. 결과를 간결하게 요약해서 보고하세요 (PASS/FAIL 포함).`,
  ].join('\n');

  const result = await runCode({
    task: prompt,
    resume: true,  // developer 세션 이어서
    channelId,
    sessionKey,
  });

  return result.text;
}
