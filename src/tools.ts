/**
 * tools.ts — Anthropic tool use 정의 (자체 툴)
 *
 * MCP 툴은 mcp.ts에서 동적으로 로드됩니다.
 * 여기서는 MCP와 무관하게 봇 자체가 처리하는 툴만 정의합니다.
 *
 * COMPUTER_USE_TOOLS: Anthropic Computer Use Beta 툴 (computer/bash/str_replace_editor)
 *
 * AnyTool           : 일반 Anthropic.Tool | Beta 컴퓨터유즈 툴 유니온 타입
 *
 * CHAT_TOOLS        : 대화 채널용 (MCP 툴은 mcp.ts에서 동적 추가)
 */
import type Anthropic from '@anthropic-ai/sdk';
import { DISPLAY_SIZE } from './computer';

// ── 유니온 타입 ────────────────────────────────────────────

/** 일반 Tool과 Beta 컴퓨터유즈 툴을 모두 포함하는 타입 */
export type AnyTool = Anthropic.Tool | Anthropic.Beta.BetaToolUnion;

// ── Computer Use Beta 상수 ─────────────────────────────────

/** beta.messages.create() 에 전달할 betas 값 */
export const COMPUTER_USE_BETAS: Anthropic.AnthropicBeta[] = ['computer-use-2025-01-24'];

/** beta tool type 목록 — AnthropicClient에서 beta 경로 여부 판단에 사용 */
export const BETA_TOOL_TYPES = new Set([
  'computer_20241022', 'computer_20250124',
  'bash_20241022',     'bash_20250124',
  'text_editor_20241022', 'text_editor_20250124',
]);

// ── 툴 정의 ───────────────────────────────────────────────

/**
 * Anthropic Computer Use Beta 툴 (2025-01-24 버전)
 *
 * - computer        : 스크린샷, 마우스, 키보드 제어
 * - bash            : 터미널 명령 실행
 * - str_replace_editor : 파일 보기 / 생성 / 수정
 */
export const COMPUTER_USE_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    type: 'computer_20250124',
    name: 'computer',
    display_width_px: DISPLAY_SIZE.width,
    display_height_px: DISPLAY_SIZE.height,
  } as Anthropic.Beta.BetaToolComputerUse20250124,
  {
    type: 'bash_20250124',
    name: 'bash',
  } as Anthropic.Beta.BetaToolBash20250124,
  {
    type: 'text_editor_20250124',
    name: 'str_replace_editor',
  } as Anthropic.Beta.BetaToolTextEditor20250124,
];

/** Claude Code에 개발 작업을 위임하는 툴 */
export const CLAUDE_CODE_TOOL: Anthropic.Tool = {
  name: 'claude_code',
  description:
    '개발 작업(코드 작성, 수정, 리팩토링, 디버깅, 테스트 등)을 Claude Code에 위임합니다. ' +
    '실제 파일을 읽고 쓸 수 있으며, 작업이 완료되면 결과를 반환합니다. ' +
    '결과에 [claude_code_session: <id>]가 포함되면 세션이 열려 있으므로, ' +
    '연속 작업 시 resume: true와 동일한 sessionKey를 설정하면 이전 컨텍스트를 재사용합니다. ' +
    '세션이 이미 열려 있으면 resume을 생략해도 자동으로 이어서 실행됩니다. ' +
    '관련 작업은 가능하면 하나의 task 설명에 묶어서 전달하세요.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: '수행할 개발 작업을 구체적으로 설명합니다. 파일 경로, 요구사항, 제약조건을 포함하세요. 연관된 여러 작업은 하나의 task에 묶어서 전달하면 컨텍스트를 절약할 수 있습니다.',
      },
      workdir: {
        type: 'string',
        description: '작업할 디렉토리 절대 경로. 미지정 시 봇 프로젝트 루트를 사용합니다.',
      },
      resume: {
        type: 'boolean',
        description: '이전 세션을 명시적으로 이어서 진행할지 여부. 생략 시 sessionKey에 해당하는 세션이 존재하면 자동으로 재사용됩니다.',
      },
      sessionKey: {
        type: 'string',
        description: '세션을 식별하는 키. 같은 태스크 내 연속 호출에서 동일한 키를 사용하면 세션이 공유됩니다. 미지정 시 채널 ID를 사용합니다.',
      },
    },
    required: ['task'],
  },
};

// ── 채널별 툴 세트 ─────────────────────────────────────────

/** 대화 채널: 자체 툴 없음 (MCP + Computer Use 툴은 agent.ts에서 동적 추가) */
export const CHAT_TOOLS: Anthropic.Tool[] = [];
