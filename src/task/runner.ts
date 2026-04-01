/**
 * task/runner.ts — Task Graph 실행 루프
 *
 * Phase 5: 병렬 실행 + Discord 실시간 상태 메시지
 *
 * - 의존성이 없는 태스크를 Promise.all()로 동시 실행
 * - 단일 상태 메시지를 edit()으로 실시간 업데이트
 * - 실패 시 /task retry 안내
 */

import type { TextChannel, Message } from 'discord.js';
import type { Task } from './types';
import type { TaskGraph } from './graph';
import { delay } from '../utils';

export type ExecuteTaskFn = (task: Task) => Promise<string>;

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  running: '⚙️',
  completed: '✅',
  failed: '❌',
};

function buildStatusText(graph: TaskGraph): string {
  const lines: string[] = [
    `🗂️ **${graph.data.goal.slice(0, 80)}**`,
    '',
  ];

  for (const task of graph.data.tasks) {
    const icon = STATUS_ICON[task.status] ?? '❓';
    const suffix = task.status === 'running' ? ' _(실행 중...)_' : '';
    lines.push(`${icon} **[${task.id}]** ${task.title}${suffix}`);
  }

  const done = graph.data.tasks.filter((t) => t.status === 'completed').length;
  const total = graph.data.tasks.length;
  const elapsed = Math.floor((Date.now() - graph.data.createdAt) / 1000);

  lines.push('');
  lines.push(`-# 진행 ${done}/${total} | 경과 ${elapsed}초`);

  return lines.join('\n');
}

export async function runTaskGraph(
  graph: TaskGraph,
  channel: TextChannel,
  executeTask: ExecuteTaskFn,
): Promise<void> {
  // 초기 상태 메시지 전송
  let statusMsg: Message | null = null;
  try {
    statusMsg = await channel.send(buildStatusText(graph));
  } catch {
    // 메시지 전송 실패 시 상태 메시지 없이 진행
  }

  const updateStatus = async () => {
    if (!statusMsg) return;
    try {
      await statusMsg.edit(buildStatusText(graph));
    } catch {
      // 편집 실패(삭제됨 등)는 무시
    }
  };

  // 실행 루프 — 병렬 실행
  while (!graph.isComplete() && !graph.hasFailed()) {
    const readyTasks = graph.getReadyTasks();

    if (readyTasks.length === 0) {
      // 실행 중인 태스크 완료 대기
      await delay(500);
      continue;
    }

    // 준비된 모든 태스크 동시 실행
    await Promise.all(
      readyTasks.map(async (task) => {
        graph.markRunning(task.id);
        await updateStatus();

        try {
          const result = await executeTask(task);
          graph.markComplete(task.id, result);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          graph.markFailed(task.id, errMsg);
        }

        await updateStatus();
      }),
    );
  }

  // 최종 상태 반영
  await updateStatus();

  if (graph.isComplete()) {
    const elapsed = ((Date.now() - graph.data.createdAt) / 1000).toFixed(0);
    await channel.send(`🎉 **완료!** (${elapsed}초)\n> ${graph.data.goal}`);
  } else {
    const failed = graph.data.tasks.find((t) => t.status === 'failed');
    await channel.send(
      `⚠️ **실행 중단** — \`${failed?.id}\` ${failed?.title ?? ''} 실패\n-# \`/task retry\`로 재시도할 수 있습니다.`,
    );
  }
}
