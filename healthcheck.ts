/**
 * healthcheck.ts — 봇 운영 상태 점검 스크립트
 *
 * 실행: ts-node healthcheck.ts
 *
 * 점검 항목:
 *  1. 봇 프로세스 실행 여부 (pm2 / node 프로세스)
 *  2. 설정 파일(data/config.json) 및 주요 필드 검증
 *  3. .env 파일 존재 여부 (선택적)
 *  4. 의존성 패키지(node_modules) 설치 여부
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname);
const OK = '✅';
const FAIL = '❌';
const WARN = '⚠️ ';

let hasFailure = false;

function pass(label: string, detail?: string) {
  console.log(`  ${OK} ${label}${detail ? `  (${detail})` : ''}`);
}

function fail(label: string, detail?: string) {
  hasFailure = true;
  console.log(`  ${FAIL} ${label}${detail ? `  → ${detail}` : ''}`);
}

function warn(label: string, detail?: string) {
  console.log(`  ${WARN}${label}${detail ? `  → ${detail}` : ''}`);
}

function section(title: string) {
  console.log(`\n[${title}]`);
}

// ─────────────────────────────────────────────
// 1. 봇 프로세스 실행 여부
// ─────────────────────────────────────────────
section('1. 봇 프로세스 실행 여부');

function checkPm2(): boolean {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const list: Array<{ name: string; pm2_env?: { status: string } }> = JSON.parse(output);
    const app = list.find((p) => p.name === 'discord-ai-team');
    if (!app) return false;
    const status = app.pm2_env?.status ?? 'unknown';
    if (status === 'online') {
      pass('pm2 프로세스 실행 중', `status=${status}`);
    } else {
      fail('pm2 프로세스 중지 상태', `status=${status}`);
    }
    return true;
  } catch {
    return false; // pm2 없음 또는 실행 실패
  }
}

function checkNodeProcess(): boolean {
  try {
    // ts-node src/index.ts 또는 node dist/index.js 프로세스 탐색
    const output = execSync(
      'pgrep -a node 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 5000 },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    const botProcess = lines.find(
      (l) => l.includes('index.js') || l.includes('index.ts') || l.includes('discord-ai-team'),
    );
    if (botProcess) {
      pass('Node.js 봇 프로세스 실행 중');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const pm2Found = checkPm2();
if (!pm2Found) {
  // pm2가 없으면 일반 node 프로세스로 확인
  const nodeFound = checkNodeProcess();
  if (!nodeFound) {
    fail('봇 프로세스 없음', 'pm2 또는 node 프로세스가 감지되지 않았습니다');
  }
}

// ─────────────────────────────────────────────
// 2. 설정 파일(data/config.json) 검증
// ─────────────────────────────────────────────
section('2. 설정 파일 (data/config.json)');

const CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  fail('data/config.json 없음', '파일을 생성하세요');
} else {
  pass('data/config.json 존재');

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // 공통 필드
    if (raw.collabChannel) {
      pass('collabChannel 설정됨', raw.collabChannel);
    } else {
      fail('collabChannel 누락');
    }

    // agents 배열
    const agents: Array<Record<string, unknown>> = raw.agents ?? [];
    if (!Array.isArray(agents) || agents.length === 0) {
      fail('agents 배열 누락 또는 비어 있음');
    } else {
      pass(`에이전트 ${agents.length}개 등록됨`);

      const requiredFields = ['id', 'name', 'discordToken', 'provider', 'apiKey', 'model'] as const;
      for (const agent of agents) {
        const agentId = String(agent.id ?? '?');
        const missing = requiredFields.filter((f) => !agent[f]);
        if (missing.length === 0) {
          pass(`[${agentId}] 필수 필드 모두 존재`);
        } else {
          fail(`[${agentId}] 필수 필드 누락`, missing.join(', '));
        }

      }
    }
  } catch (err) {
    fail('config.json 파싱 실패', err instanceof Error ? err.message : String(err));
  }
}

// ─────────────────────────────────────────────
// 3. .env 파일 존재 여부 (선택적)
// ─────────────────────────────────────────────
section('3. .env 파일');

const ENV_PATH = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  const lines = fs.readFileSync(ENV_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  pass(`.env 파일 존재`, `${lines.length}개 항목`);
} else {
  warn('.env 파일 없음', '이 프로젝트는 data/config.json을 주 설정 소스로 사용합니다 (선택 사항)');
}

// ─────────────────────────────────────────────
// 4. 의존성 패키지 설치 여부
// ─────────────────────────────────────────────
section('4. 의존성 패키지 (node_modules)');

const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');
if (!fs.existsSync(NODE_MODULES)) {
  fail('node_modules 없음', 'npm install 을 실행하세요');
} else {
  pass('node_modules 존재');

  // package.json의 dependencies 중 실제로 설치된 패키지 확인
  const PKG_PATH = path.join(PROJECT_ROOT, 'package.json');
  if (fs.existsSync(PKG_PATH)) {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
    const deps: string[] = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const missing = deps.filter((dep) => !fs.existsSync(path.join(NODE_MODULES, dep)));
    if (missing.length === 0) {
      pass(`패키지 ${deps.length}개 모두 설치됨`);
    } else {
      fail(`미설치 패키지 ${missing.length}개`, missing.join(', '));
    }
  }
}

// ─────────────────────────────────────────────
// 최종 결과
// ─────────────────────────────────────────────
console.log('\n' + '─'.repeat(40));
if (hasFailure) {
  console.log(`${FAIL} 헬스체크 실패 — 위 항목을 확인하세요.`);
  process.exit(1);
} else {
  console.log(`${OK} 헬스체크 통과`);
  process.exit(0);
}
