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
  const { task, graphId, channelId, githubRepo, runCode } = ctx;
  const sessionKey = `${graphId}:${task.id}`;
  const isFirst = attempt === 0;

  // GitHub 워크플로우 지시사항 (githubRepo 설정 시에만 포함)
  const branchName = `feature/${task.id}-${task.title.replace(/\s+/g, '-').replace(/[^\w-]/g, '').toLowerCase().slice(0, 40)}`;
  const githubInstructions = githubRepo
    ? [
        ``,
        `## GitHub 워크플로우`,
        `레포: ${githubRepo}`,
        isFirst
          ? [
              `코드 작성 완료 후 아래 순서로 Git 작업을 수행하세요:`,
              `1. 브랜치 생성: \`git checkout -b ${branchName}\``,
              `2. 변경사항 스테이징: \`git add -A\``,
              `3. 커밋: \`git commit -m "feat: ${task.title}"\``,
              `4. 푸시: \`git push -u origin ${branchName}\``,
              `5. PR 생성: \`gh pr create --title "${task.title}" --body "## 변경사항\\n${task.description.slice(0, 200)}"\``,
            ].join('\n')
          : [
              `리뷰 피드백을 반영하여 코드를 수정한 후:`,
              `1. 변경사항 스테이징: \`git add -A\``,
              `2. 커밋: \`git commit -m "fix: apply review feedback"\``,
              `3. 푸시: \`git push\``,
            ].join('\n'),
      ].join('\n')
    : '';

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
    githubInstructions,
    ``,
    `## 지시사항`,
    `- 위 계획에 따라 실제 코드를 작성하세요.`,
    `- 기존 코드 컨벤션을 따르세요.`,
    `- 작업 완료 후 변경/생성된 파일 목록을 요약해서 보고하세요.`,
    githubRepo ? `- Git 워크플로우(위 GitHub 워크플로우 섹션)도 완료하세요.` : '',
  ].filter(Boolean).join('\n');

  const result = await runCode({
    task: prompt,
    resume: !isFirst,
    channelId,
    sessionKey,
  });

  return result.text;
}
