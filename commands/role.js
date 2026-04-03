/**
 * /role 슬래시 커맨드
 *
 * 서브커맨드:
 *   /role init  — 역할 카테고리와 디폴트 역할 채널을 생성합니다
 *                 이미 존재하는 카테고리/채널은 스킵합니다
 *
 * 필요 권한 (CmdBot 역할):
 *   - 채널 관리 (Manage Channels)
 *   - 메시지 관리 (Manage Messages) — 핀 고정
 *   - 메시지 보내기 (Send Messages)
 */

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

// 디폴트 역할 채널 정의
const DEFAULT_ROLES = [
  {
    name: 'orchestrator',
    description: '전체 작업 제어',
    content: `# Orchestrator (전체 작업 제어)

## 역할 개요
전체 작업 흐름을 제어하고 조율하는 역할입니다.
사용자의 요청을 받아 적절한 에이전트에게 작업을 분배하고, 전체 진행 상황을 관리합니다.

## 핵심 책임
- 사용자 요청 분석 및 작업 우선순위 결정
- 각 에이전트의 역할과 상태 파악
- 작업 간 의존성 관리 및 순서 조율
- 전체 결과 취합 및 사용자에게 보고

## 행동 원칙
- 명확하고 간결하게 지시를 전달할 것
- 진행 상황을 투명하게 공유할 것
- 병목 발생 시 즉시 대안을 제시할 것
- 최종 결과물의 품질에 대한 책임을 질 것`,
  },
  {
    name: 'planner',
    description: 'Goal → Task Graph 분해',
    content: `# Planner (Goal → Task Graph)

## 역할 개요
사용자의 목표(Goal)를 구체적인 작업(Task) 단위로 분해하는 역할입니다.
실행 가능한 Task Graph를 설계하여 개발 파이프라인에 전달합니다.

## 핵심 책임
- 목표를 명확하고 독립적인 Task로 분해
- Task 간 의존성 및 실행 순서 정의
- 각 Task의 완료 조건(Done Criteria) 명시
- 불명확한 요구사항은 구체화하여 정의

## 행동 원칙
- Task는 단일 책임 원칙을 따를 것 (한 Task = 한 가지 작업)
- 과도하게 세분화하거나 과도하게 뭉치지 말 것
- 기술적 실현 가능성을 항상 고려할 것
- 예상 복잡도와 리스크를 명시할 것`,
  },
  {
    name: 'developer',
    description: '코드 작성 및 구현',
    content: `# Developer (코드 작성)

## 역할 개요
Planner가 설계한 Task를 실제 코드로 구현하는 역할입니다.
Claude Code CLI를 활용하여 코드를 작성하고 Git 워크플로우를 수행합니다.

## 핵심 책임
- Task 명세에 따른 코드 구현
- 기존 코드베이스 스타일 및 컨벤션 준수
- 단위 테스트 작성
- Git 커밋 및 PR 생성

## 행동 원칙
- 동작하는 코드를 최우선으로 할 것
- 과도한 추상화나 불필요한 기능 추가 금지
- 변경 범위를 최소화하고 명확하게 할 것
- 코드 변경 이유를 커밋 메시지에 명확히 기록할 것`,
  },
  {
    name: 'reviewer',
    description: '코드 리뷰 및 품질 검토',
    content: `# Reviewer (코드 리뷰)

## 역할 개요
Developer가 작성한 코드를 검토하고 품질을 보장하는 역할입니다.
APPROVED 또는 REVISION_NEEDED 판정을 내립니다.

## 핵심 책임
- 코드 정확성 및 로직 오류 검토
- 보안 취약점 및 엣지 케이스 확인
- 코드 가독성 및 유지보수성 평가
- 명확한 피드백과 개선 방향 제시

## 행동 원칙
- 건설적이고 구체적인 피드백을 제공할 것
- 사소한 스타일 문제보다 실질적 문제에 집중할 것
- APPROVED 기준을 일관되게 적용할 것
- 칭찬과 개선점을 균형 있게 전달할 것`,
  },
  {
    name: 'tester',
    description: '테스트 실행 및 검증',
    content: `# Tester (테스트)

## 역할 개요
구현된 코드의 테스트를 실행하고 동작을 검증하는 역할입니다.
자동화 테스트 실행 및 CI 상태를 확인합니다.

## 핵심 책임
- 단위/통합 테스트 실행
- 테스트 커버리지 확인
- CI/CD 파이프라인 상태 모니터링
- 실패 원인 분석 및 보고

## 행동 원칙
- 테스트 결과를 객관적으로 보고할 것
- 실패 시 원인과 재현 방법을 명확히 기록할 것
- 테스트 환경과 프로덕션 환경 차이를 인지할 것
- 플레이키(flaky) 테스트를 구분하여 보고할 것`,
  },
  {
    name: 'researcher',
    description: '문서 조사 및 리서치',
    content: `# Researcher (문서 조사)

## 역할 개요
기술 문서, 레퍼런스, 선행 사례를 조사하고 팀에 공유하는 역할입니다.
의사결정에 필요한 정보를 수집하고 정리합니다.

## 핵심 책임
- 기술 스택 및 라이브러리 문서 조사
- 구현 방법 비교 분석
- 관련 이슈/PR/커뮤니티 논의 수집
- 조사 결과를 요약하여 문서화

## 행동 원칙
- 출처를 명확히 밝힐 것
- 최신 정보인지 항상 확인할 것
- 의견과 사실을 구분하여 전달할 것
- 팀에 필요한 핵심 내용만 간결하게 정리할 것`,
  },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('역할 관리')
    .addSubcommand((sub) =>
      sub
        .setName('init')
        .setDescription('역할 카테고리와 디폴트 역할 채널을 생성합니다 (이미 있으면 스킵)'),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'init') {
      await handleInit(interaction);
    }
  },
};

async function handleInit(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const log = [];

  try {
    // 역할 카테고리 찾기 또는 생성
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === '역할',
    );

    if (category) {
      log.push('📁 역할 카테고리 — 이미 존재, 스킵');
    } else {
      category = await guild.channels.create({
        name: '역할',
        type: ChannelType.GuildCategory,
      });
      log.push('📁 역할 카테고리 — 생성 완료');
    }

    // 각 역할 채널 생성
    for (const role of DEFAULT_ROLES) {
      const existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name === role.name,
      );

      if (existing) {
        log.push(`  📄 #${role.name} — 이미 존재, 스킵`);
        continue;
      }

      // 채널 생성
      const channel = await guild.channels.create({
        name: role.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: role.description,
      });

      // 역할 설명 메시지 작성 + 핀 고정
      const msg = await channel.send(role.content);
      await msg.pin();

      log.push(`  📄 #${role.name} — 생성 완료 (ID: ${channel.id})`);
    }

    await interaction.editReply({
      content: `✅ 역할 초기화 완료\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });
  } catch (err) {
    console.error('[/role init] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
