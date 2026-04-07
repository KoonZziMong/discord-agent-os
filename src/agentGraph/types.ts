/**
 * agentGraph/types.ts — Agent Workflow 파이프라인 타입 정의
 *
 * Phase 2: 각 Task를 planner → developer → reviewer → tester 파이프라인으로 실행
 */

import type { Task } from '../task/types';
import type { LLMClient } from '../llm';
import type { ClaudeCodeInput, ClaudeCodeResult } from '../claude-code';

/** 파이프라인 각 노드에 전달되는 공통 컨텍스트 */
export interface WorkflowContext {
  task: Task;
  graphId: string;
  channelId: string;
  llm: LLMClient;
  agentName: string;
  agentSystemPrompt: string;
  runCode: (input: ClaudeCodeInput) => Promise<ClaudeCodeResult>;
}

/** 파이프라인 전체 실행 결과 */
export interface WorkflowResult {
  plan: string;
  devResult: string;
  reviewFeedback: string;
  testResult: string;
  approved: boolean;
}
