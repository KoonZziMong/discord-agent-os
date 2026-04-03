/**
 * roleProposals.ts — 역할 핀 업데이트 제안 영속화
 *
 * 오케스트레이터가 [ROLE_UPDATE_PROPOSAL] 메시지를 생성할 때
 * 제안 데이터를 data/proposals/{proposalId}.json 에 저장합니다.
 *
 * 반응(✅/❌) 핸들러는 proposalId로 이 파일을 읽어 적용/폐기합니다.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROPOSALS_DIR = path.join(PROJECT_ROOT, 'data', 'proposals');

export interface RoleProposal {
  proposalId: string;
  cycleId: string;
  targetRole: string;       // 'orchestrator' | 'planner' | ...
  roleChannelId: string;    // 역할 채널 ID (핀을 수정할 채널)
  newContent: string;       // 새 핀 전체 내용 (전체 교체)
  discordMessageId: string; // 제안 Discord 메시지 ID (반응 추적용)
  channelId: string;        // 제안 메시지가 있는 채널 ID
  createdAt: number;        // Date.now()
  expiresAt: number;        // Date.now() + 24h (기본)
}

function ensureDir(): void {
  if (!fs.existsSync(PROPOSALS_DIR)) {
    fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  }
}

function proposalPath(proposalId: string): string {
  return path.join(PROPOSALS_DIR, `${proposalId}.json`);
}

/** 제안을 디스크에 저장합니다. */
export function saveProposal(proposal: RoleProposal): void {
  ensureDir();
  fs.writeFileSync(proposalPath(proposal.proposalId), JSON.stringify(proposal, null, 2), 'utf-8');
  console.log(`[roleProposals] 제안 저장: ${proposal.proposalId} (role: ${proposal.targetRole})`);
}

/** proposalId로 제안을 로드합니다. 없으면 null. */
export function loadProposal(proposalId: string): RoleProposal | null {
  const p = proposalPath(proposalId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RoleProposal;
  } catch {
    return null;
  }
}

/** Discord 메시지 ID로 제안을 찾습니다. */
export function findProposalByMessageId(discordMessageId: string): RoleProposal | null {
  ensureDir();
  try {
    const files = fs.readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const p = JSON.parse(
          fs.readFileSync(path.join(PROPOSALS_DIR, file), 'utf-8'),
        ) as RoleProposal;
        if (p.discordMessageId === discordMessageId) return p;
      } catch {
        // 손상된 파일 스킵
      }
    }
  } catch {
    // PROPOSALS_DIR 없으면 null
  }
  return null;
}

/** 제안을 삭제합니다. */
export function deleteProposal(proposalId: string): void {
  const p = proposalPath(proposalId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`[roleProposals] 제안 삭제: ${proposalId}`);
  }
}

/** 만료된 제안을 정리합니다. (기동 시 호출 권장) */
export function cleanExpiredProposals(): void {
  ensureDir();
  const now = Date.now();
  try {
    const files = fs.readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const p = JSON.parse(
          fs.readFileSync(path.join(PROPOSALS_DIR, file), 'utf-8'),
        ) as RoleProposal;
        if (p.expiresAt < now) {
          fs.unlinkSync(path.join(PROPOSALS_DIR, file));
          console.log(`[roleProposals] 만료 제안 삭제: ${p.proposalId}`);
        }
      } catch {
        // 손상된 파일 삭제
        fs.unlinkSync(path.join(PROPOSALS_DIR, file));
      }
    }
  } catch {
    // 디렉토리 없으면 스킵
  }
}
