/**
 * taskWaiter.ts — 태스크 위임 응답 대기 레지스트리
 *
 * orchestrator가 팀원 봇에게 [AGENT_MSG] TASK_ASSIGN을 보낸 뒤
 * 응답(TASK_RESULT)을 기다리는 Promise를 관리합니다.
 *
 * key 형식: `{graphId}/{taskId}`
 */

type WaiterEntry = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const waiters = new Map<string, WaiterEntry>();

/**
 * 태스크 응답 대기를 등록하고 Promise를 반환합니다.
 * timeoutMs 이내에 resolve/reject 없으면 자동 reject합니다.
 */
export function register(key: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiters.delete(key)) {
        reject(new Error(`태스크 위임 응답 타임아웃: ${key}`));
      }
    }, timeoutMs);
    waiters.set(key, { resolve, reject, timer });
  });
}

/**
 * 대기 중인 태스크를 성공으로 완료합니다.
 * @returns 대기 중인 항목이 있어 완료했으면 true, 없으면 false
 */
export function resolve(key: string, resultText: string): boolean {
  const entry = waiters.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  waiters.delete(key);
  entry.resolve(resultText);
  return true;
}

/**
 * 대기 중인 태스크를 실패로 완료합니다.
 * @returns 대기 중인 항목이 있어 처리했으면 true, 없으면 false
 */
export function reject(key: string, reason: string): boolean {
  const entry = waiters.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  waiters.delete(key);
  entry.reject(new Error(reason));
  return true;
}

/**
 * 대기 중인 태스크를 조용히 취소합니다 (타이머만 정리, reject 호출 없음).
 * delegateTask가 중간에 실패해 resultPromise가 고아(orphaned)가 될 때 사용합니다.
 * Promise는 참조가 없어지면 GC가 수거하므로 unhandled rejection이 발생하지 않습니다.
 * @returns 정리된 항목이 있으면 true, 없으면 false
 */
export function cancel(key: string): boolean {
  const entry = waiters.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  waiters.delete(key);
  return true;
}
