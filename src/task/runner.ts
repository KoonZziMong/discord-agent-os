/**
 * task/runner.ts — Task Graph 순차 실행 루프
 *
 * Phase 1: 순차 실행 (의존성 완료 순서로)
 * Phase 5: 병렬 실행으로 업그레이드 예정
 */

import type { TextChannel } from 'discord.js';
import type { Task } from './types';
import type { TaskGraph } from './graph';
import { delay } from '../utils';

export type ExecuteTaskFn = (task: Task) => Promise<string>;

export async function runTaskGraph(
  graph: TaskGraph,
  channel: TextChannel,
  executeTask: ExecuteTaskFn,
): Promise<void> {
  const total = graph.data.tasks.length;

  // 태스크 목록 출력
  const taskList = graph.data.tasks
    .map((t) => `\`${t.id}\` ${t.title}`)
    .join('\n');
  await channel.send(`🗂️ **태스크 실행 시작** (총 ${total}개)\n${taskList}`);

  // 실행 루프
  while (true) {
    if (graph.isComplete()) break;
    if (graph.hasFailed()) break;

    const readyTasks = graph.getReadyTasks();

    if (readyTasks.length === 0) {
      // 준비된 태스크 없음 — 의존성 대기 중이거나 모두 실행 중
      await delay(500);
      continue;
    }

    // Phase 1: 첫 번째 준비 태스크만 실행 (순차)
    const task = readyTasks[0];
    graph.markRunning(task.id);
    await channel.send(`⚙️ **[${task.id}] ${task.title}** 실행 중...`);

    try {
      const result = await executeTask(task);
      graph.markComplete(task.id, result);
      await channel.send(`✅ **[${task.id}] ${task.title}** 완료`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      graph.markFailed(task.id, errMsg);
      await channel.send(
        `❌ **[${task.id}] ${task.title}** 실패\n\`\`\`\n${errMsg.slice(0, 200)}\n\`\`\``,
      );
      break;
    }

    await delay(500);
  }

  // 최종 결과
  if (graph.isComplete()) {
    const elapsed = ((Date.now() - graph.data.createdAt) / 1000).toFixed(0);
    const summary = graph.data.tasks
      .map((t) => `- \`${t.id}\` ${t.title}: ${t.result?.slice(0, 80) ?? '완료'}`)
      .join('\n');
    await channel.send(
      `🎉 **목표 달성 완료!** (${elapsed}초)\n\n**목표:** ${graph.data.goal}\n\n${summary}`,
    );
  } else {
    const failed = graph.data.tasks.find((t) => t.status === 'failed');
    await channel.send(
      `⚠️ **실행 중단** — \`${failed?.id}\` ${failed?.title ?? ''} 실패로 중단되었습니다.`,
    );
  }
}
