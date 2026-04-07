/**
 * task/planner.ts — 자연어 목표 → Task 목록 변환
 *
 * LLM을 호출하여 사용자의 목표를 실행 가능한 태스크 목록으로 분해합니다.
 * 결과는 JSON으로 파싱되어 TaskInput[] 형태로 반환됩니다.
 */

import type { LLMClient } from '../llm';
import type { TaskInput } from './graph';

const PLANNING_SYSTEM = `당신은 소프트웨어 개발 작업 계획가입니다.
사용자의 목표를 실행 가능한 개발 태스크로 분해하세요.

규칙:
- 각 태스크는 Claude Code 하나로 완수할 수 있는 수준으로 구체적으로 작성
- dependencies는 반드시 먼저 완료되어야 할 태스크 id 배열 (없으면 [])
- role: developer(코드 작성/수정), reviewer(검토), tester(테스트 실행), researcher(조사/문서화)
- 태스크는 최대 6개
- 반드시 JSON 배열만 출력할 것. 앞뒤 설명 텍스트 금지. 마크다운 코드블록(\`\`\`)으로 감싸도 됨.

출력 예시:
[
  {
    "id": "T1",
    "title": "한 줄 제목",
    "description": "구체적인 작업 내용. 수정할 파일, 구현할 기능, 요구사항을 포함.",
    "dependencies": [],
    "role": "developer"
  },
  {
    "id": "T2",
    "title": "한 줄 제목",
    "description": "구체적인 작업 내용.",
    "dependencies": ["T1"],
    "role": "reviewer"
  }
]`;

export async function planTasks(goal: string, llm: LLMClient): Promise<TaskInput[]> {
  const { text } = await llm.chat(
    PLANNING_SYSTEM,
    [{ role: 'user', content: goal }],
    [],
    async (_name: string, _input: unknown, _id: string): Promise<string> => '(not used)',
  );

  // 응답에서 JSON 배열 추출 — [{ 로 시작하는 객체 배열만 매칭
  // (코드블록 wrapping, 목표 텍스트의 [ 오매칭 모두 방지)
  console.log(`[planner] LLM 응답 전체:\n${text}`);
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) {
    throw new Error(`플래너 응답에서 JSON을 찾을 수 없음:\n${text.slice(0, 500)}`);
  }

  const raw = JSON.parse(match[0]) as Array<{
    id: string;
    title: string;
    description: string;
    dependencies?: string[];
    role?: string;
  }>;

  return raw.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dependencies: t.dependencies ?? [],
    role: (['developer', 'reviewer', 'tester', 'researcher'].includes(t.role ?? '')
      ? t.role
      : 'developer') as TaskInput['role'],
  }));
}
