/**
 * agentGraph/executor.ts — Agent Workflow 파이프라인 실행기
 *
 * 단일 Task를 planner → developer → reviewer → tester 파이프라인으로 실행합니다.
 *
 * 흐름:
 *   plannerNode  → 구현 계획 생성
 *       ↓
 *   developerNode → claude_code로 실제 구현 (세션 유지)
 *       ↓
 *   reviewerNode  → LLM 코드 리뷰
 *       ↓ REVISION_NEEDED (최대 MAX_REVIEW_RETRIES회)
 *   developerNode (재시도, 동일 세션 resume)
 *       ↓ APPROVED
 *   testerNode    → 테스트 실행 (동일 세션 resume)
 *       ↓
 *   WorkflowResult 반환
 */

import type { Task } from '../task/types';
import type { LLMClient } from '../llm';
import type { ClaudeCodeInput, ClaudeCodeResult } from '../claude-code';
import type { WorkflowContext, WorkflowResult } from './types';
import { plannerNode } from './nodes/plannerNode';
import { developerNode } from './nodes/developerNode';
import { reviewerNode } from './nodes/reviewerNode';
import { testerNode } from './nodes/testerNode';

const MAX_REVIEW_RETRIES = 2;

export async function executeWorkflow(
  task: Task,
  graphId: string,
  channelId: string,
  llm: LLMClient,
  agentName: string,
  agentSystemPrompt: string,
  runCode: (input: ClaudeCodeInput) => Promise<ClaudeCodeResult>,
  githubRepo?: string,
): Promise<WorkflowResult> {
  const ctx: WorkflowContext = {
    task,
    graphId,
    channelId,
    llm,
    agentName,
    agentSystemPrompt,
    githubRepo,
    runCode,
  };

  // 1. Planner: 구현 계획 수립
  console.log(`[${agentName}] 📋 [${task.id}] Planner 실행 중...`);
  const plan = await plannerNode(ctx);

  // 2. Developer → Reviewer 루프 (최대 MAX_REVIEW_RETRIES+1회)
  let devResult = '';
  let reviewFeedback = '';
  let approved = false;

  for (let attempt = 0; attempt <= MAX_REVIEW_RETRIES; attempt++) {
    console.log(`[${agentName}] 💻 [${task.id}] Developer 실행 중... (시도 ${attempt + 1}/${MAX_REVIEW_RETRIES + 1})`);
    devResult = await developerNode(
      ctx,
      plan,
      attempt > 0 ? reviewFeedback : undefined,
      attempt,
    );

    console.log(`[${agentName}] 🔍 [${task.id}] Reviewer 실행 중...`);
    const review = await reviewerNode(ctx, plan, devResult);
    reviewFeedback = review.feedback;
    approved = review.approved;

    if (approved) {
      console.log(`[${agentName}] ✅ [${task.id}] 리뷰 승인`);
      break;
    }

    if (attempt < MAX_REVIEW_RETRIES) {
      console.log(`[${agentName}] 🔄 [${task.id}] 리뷰 재작업 요청 (${attempt + 1}/${MAX_REVIEW_RETRIES})`);
    } else {
      console.log(`[${agentName}] ⚠️  [${task.id}] 최대 재시도 초과 — 현재 결과로 진행`);
    }
  }

  // 3. Tester: 테스트 실행
  console.log(`[${agentName}] 🧪 [${task.id}] Tester 실행 중...`);
  const testResult = await testerNode(ctx, devResult);

  return {
    plan,
    devResult,
    reviewFeedback,
    testResult,
    approved,
  };
}
