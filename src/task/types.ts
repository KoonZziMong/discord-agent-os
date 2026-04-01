/**
 * task/types.ts — Task Graph 타입 정의
 */

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TaskRole = 'developer' | 'reviewer' | 'tester' | 'researcher';

export interface Task {
  id: string;
  graphId: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];   // 완료되어야 하는 선행 태스크 ID 목록
  role: TaskRole;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskGraphData {
  id: string;
  goal: string;
  channelId: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  tasks: Task[];
  createdAt: number;
  completedAt?: number;
}
