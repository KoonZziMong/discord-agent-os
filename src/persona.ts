/**
 * persona.ts — 페르소나 파일(.md) 로드 및 수정
 *
 * 각 에이전트의 성격·역할·기억·규칙은 data/personas/agent-*.md 파일로 관리됩니다.
 * 이 파일이 Anthropic API 호출의 system prompt 기반이 됩니다.
 *
 * 파일 구조 (마크다운 섹션):
 *   ## 페르소나   — 이름, 역할, 성격, 전문분야
 *   ## 장기 기억  — 날짜별 중요 사실 (update_memory로 추가)
 *   ## 행동 규칙  — 응답 스타일 규칙 (append_rule로 추가)
 *
 * Claude가 설정 채널에서 update_persona tool_use를 반환하면
 * agent.ts → executeTool() → persona.update() 순으로 호출됩니다.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './config';

/** .md 파일 전체 내용을 문자열로 반환 */
export function load(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    const defaultContent = `## 페르소나\n- 이름: 에이전트\n- 역할: AI 어시스턴트\n\n## 장기 기억\n(초기 상태)\n\n## 행동 규칙\n- 한국어로 응답\n`;
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 페르소나 파일의 특정 섹션을 수정.
 * action:
 *   - "append_rule"    : ## 행동 규칙 섹션에 항목 추가
 *   - "update_memory"  : ## 장기 기억 섹션에 항목 추가
 *   - "replace_section": section 이름의 섹션 전체를 content로 교체
 */
export function update(
  filePath: string,
  action: 'append_rule' | 'update_memory' | 'replace_section',
  content: string,
  section?: string,
): void {
  const current = load(filePath);

  let updated: string;

  if (action === 'append_rule') {
    updated = appendToSection(current, '## 행동 규칙', `- ${content}`);
  } else if (action === 'update_memory') {
    const timestamp = new Date().toISOString().slice(0, 10);
    updated = appendToSection(current, '## 장기 기억', `- ${timestamp}: ${content}`);
  } else if (action === 'replace_section' && section) {
    updated = replaceSection(current, `## ${section}`, content);
  } else {
    throw new Error(`알 수 없는 action: ${action}`);
  }

  fs.writeFileSync(filePath, updated, 'utf-8');
}

/** 모든 에이전트 페르소나를 Map<agentId, content>로 반환 */
export function loadAll(configs: AgentConfig[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cfg of configs) {
    map.set(cfg.id, load(cfg.personaFile));
  }
  return map;
}

// ── 내부 헬퍼 ──────────────────────────────────────────────

function appendToSection(text: string, sectionHeader: string, line: string): string {
  const idx = text.indexOf(sectionHeader);
  if (idx === -1) {
    return `${text}\n${sectionHeader}\n${line}\n`;
  }

  // 다음 ## 섹션 시작점 또는 파일 끝
  const nextSection = text.indexOf('\n## ', idx + sectionHeader.length);
  const insertAt = nextSection === -1 ? text.length : nextSection;

  // 섹션 끝에 빈 줄이 있으면 그 앞에 삽입
  const before = text.slice(0, insertAt).trimEnd();
  const after = text.slice(insertAt);
  return `${before}\n${line}\n${after}`;
}

function replaceSection(text: string, sectionHeader: string, newContent: string): string {
  const idx = text.indexOf(sectionHeader);
  if (idx === -1) {
    return `${text}\n${sectionHeader}\n${newContent}\n`;
  }
  const nextSection = text.indexOf('\n## ', idx + sectionHeader.length);
  const before = text.slice(0, idx);
  const after = nextSection === -1 ? '' : text.slice(nextSection);
  return `${before}${sectionHeader}\n${newContent}\n${after}`;
}
