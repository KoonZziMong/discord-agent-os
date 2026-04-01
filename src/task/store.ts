/**
 * task/store.ts — Task Graph JSON 파일 영속성
 *
 * data/tasks/{graphId}.json 형태로 저장합니다.
 * 봇 재시작 후에도 태스크 상태를 유지할 수 있습니다.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TaskGraphData } from './types';

const STORE_DIR = path.resolve(__dirname, '../../data/tasks');

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

export function saveGraph(graph: TaskGraphData): void {
  ensureDir();
  fs.writeFileSync(
    path.join(STORE_DIR, `${graph.id}.json`),
    JSON.stringify(graph, null, 2),
    'utf-8',
  );
}

export function loadGraph(graphId: string): TaskGraphData | null {
  const file = path.join(STORE_DIR, `${graphId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as TaskGraphData;
}

/** 미완료 그래프 전체 로드 (재시작 후 상태 복원용) */
export function loadIncompleteGraphs(): TaskGraphData[] {
  ensureDir();
  return fs.readdirSync(STORE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf-8')) as TaskGraphData)
    .filter((g) => g.status === 'running');
}
