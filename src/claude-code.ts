/**
 * claude-code.ts — Claude Code CLI 연동
 *
 * `claude -p` 명령을 subprocess로 실행하여 개발 작업을 위임합니다.
 * 과금은 claude.ai 구독 기준으로 처리됩니다 (API 크레딧 불필요).
 *
 * 세션 관리:
 *   - 채널 ID 기준으로 session_id를 인메모리에 보관합니다.
 *   - resume: true 이면 기존 세션을 이어갑니다.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

/** 키(채널 ID 또는 그래프 ID)별 활성 세션 ID */
const sessionStore = new Map<string, string>();

export interface ClaudeCodeInput {
  task: string;
  workdir?: string;
  resume?: boolean;
  channelId: string;
  /** 태스크 그래프 실행 시 graphId를 전달하면 그래프 내 태스크들이 세션을 공유합니다. */
  sessionKey?: string;
}

export interface ClaudeCodeResult {
  text: string;
  sessionId: string | null;
}

interface ClaudeJsonResult {
  type: string;
  subtype?: string;
  is_error: boolean;
  result?: string;
  session_id?: string;
}

/**
 * Claude Code CLI에 작업을 위임하고 결과를 반환합니다.
 */
export async function runClaudeCode(input: ClaudeCodeInput): Promise<ClaudeCodeResult> {
  const { task, workdir, resume = false, channelId, sessionKey } = input;

  const cwd = workdir ?? process.cwd();
  const storeKey = sessionKey ?? channelId;
  const existingSessionId = resume ? sessionStore.get(storeKey) : undefined;

  // 작업 내용을 임시 파일로 저장하고 shell 리다이렉션으로 stdin 전달
  // (execAsync의 input 옵션은 claude CLI와 호환이 불안정)
  const tmpFile = path.join(os.tmpdir(), `cc_task_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, task, 'utf-8');

  const resumeFlag = existingSessionId ? `--resume "${existingSessionId}"` : '';
  const cmd = [
    'claude --print',
    '--output-format json',
    '--permission-mode bypassPermissions',
    resumeFlag,
    `< "${tmpFile}"`,
  ].filter(Boolean).join(' ');

  let stdout: string;
  let stderr: string;

  try {
    const result = await execAsync(cmd, {
      cwd,
      timeout: 300_000, // 5분
      encoding: 'utf-8',
      shell: '/bin/bash',
    });
    stdout = result.stdout as string;
    stderr = result.stderr as string;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? e.message ?? '';
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  if (stderr && !stdout) {
    return { text: `Claude Code 오류: ${stderr.slice(0, 500)}`, sessionId: null };
  }

  try {
    const parsed: ClaudeJsonResult = JSON.parse(stdout.trim());

    if (parsed.is_error) {
      return { text: `Claude Code 오류: ${parsed.result ?? '알 수 없는 오류'}`, sessionId: null };
    }

    const sessionId = parsed.session_id ?? null;
    if (sessionId) {
      sessionStore.set(storeKey, sessionId);
    }

    return {
      text: parsed.result ?? '(응답 없음)',
      sessionId,
    };
  } catch {
    return { text: stdout.trim() || '(응답 없음)', sessionId: null };
  }
}

/** 채널의 Claude Code 세션을 초기화합니다. */
export function clearClaudeCodeSession(channelId: string): void {
  sessionStore.delete(channelId);
}

/** 채널에 활성 세션이 있는지 확인합니다. */
export function hasClaudeCodeSession(channelId: string): boolean {
  return sessionStore.has(channelId);
}
