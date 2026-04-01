/**
 * task/graph.ts — TaskGraph 클래스
 *
 * TaskGraphData를 감싸서 상태 변경 메서드와 영속성을 제공합니다.
 * 모든 상태 변경은 자동으로 store에 저장됩니다.
 */

import { randomUUID } from 'crypto';
import type { Task, TaskGraphData, TaskRole } from './types';
import { saveGraph } from './store';

export type TaskInput = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  role: TaskRole;
};

export class TaskGraph {
  readonly data: TaskGraphData;

  constructor(data: TaskGraphData) {
    this.data = data;
  }

  /** 새 TaskGraph를 생성하고 저장합니다. */
  static create(
    goal: string,
    channelId: string,
    agentId: string,
    taskInputs: TaskInput[],
  ): TaskGraph {
    const graphId = randomUUID();
    const now = Date.now();
    const data: TaskGraphData = {
      id: graphId,
      goal,
      channelId,
      agentId,
      status: 'running',
      tasks: taskInputs.map((t) => ({
        ...t,
        graphId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })),
      createdAt: now,
    };
    const graph = new TaskGraph(data);
    graph.persist();
    return graph;
  }

  /** 의존성이 모두 완료된 실행 가능한 태스크를 반환합니다. */
  getReadyTasks(): Task[] {
    return this.data.tasks.filter((task) => {
      if (task.status !== 'pending') return false;
      return task.dependencies.every((depId) => {
        const dep = this.data.tasks.find((t) => t.id === depId);
        return dep?.status === 'completed';
      });
    });
  }

  markRunning(taskId: string): void {
    const task = this.find(taskId);
    if (task) {
      task.status = 'running';
      task.updatedAt = Date.now();
      this.persist();
    }
  }

  markComplete(taskId: string, result: string): void {
    const task = this.find(taskId);
    if (task) {
      task.status = 'completed';
      task.result = result;
      task.updatedAt = Date.now();
    }
    if (this.data.tasks.every((t) => t.status === 'completed')) {
      this.data.status = 'completed';
      this.data.completedAt = Date.now();
    }
    this.persist();
  }

  markFailed(taskId: string, error: string): void {
    const task = this.find(taskId);
    if (task) {
      task.status = 'failed';
      task.error = error;
      task.updatedAt = Date.now();
    }
    this.data.status = 'failed';
    this.persist();
  }

  isComplete(): boolean {
    return this.data.status === 'completed';
  }

  hasFailed(): boolean {
    return this.data.status === 'failed';
  }

  private find(taskId: string): Task | undefined {
    return this.data.tasks.find((t) => t.id === taskId);
  }

  private persist(): void {
    saveGraph(this.data);
  }
}
