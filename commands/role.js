/**
 * /role 슬래시 커맨드
 *
 * 서브커맨드:
 *   /role init  — 역할 카테고리·채널 생성 + 협력 채널에 TEAM_MANIFEST 핀 등록
 *                 이미 존재하는 카테고리/채널은 스킵합니다
 *
 * 필요 권한 (CmdBot 역할):
 *   - 채널 관리 (Manage Channels)
 *   - 메시지 관리 (Manage Messages) — 핀 고정
 *   - 메시지 보내기 (Send Messages)
 */

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const fs = require('fs');

// config.json에서 collabChannel ID 로드
function loadCollabChannel() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.collabChannel ?? null;
  } catch {
    return null;
  }
}

// config.json에서 CmdBot ID 로드 (디폴트 핀 작성용)
function loadCmdBotId(interaction) {
  // CmdBot은 커맨드를 실행한 봇 자신
  return interaction.client.user.id;
}

// ── 역할 파일 로더 ─────────────────────────────────────────────

const ROLES_DIR = path.join(__dirname, '..', 'data', 'roles');

function loadRoleContent(name) {
  const filePath = path.join(ROLES_DIR, `${name}.md`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`역할 파일을 찾을 수 없습니다: ${filePath}`);
  }
}

// ── 역할 채널 정의 ─────────────────────────────────────────────

const DEFAULT_ROLES = [
  { name: 'rule',         description: '팀 전체 공통 규약 (모든 에이전트 필수 컨텍스트)' },
  { name: 'orchestrator', description: '전체 작업 제어 및 팀 조율' },
  { name: 'planner',      description: 'Goal → Task 분해 및 실행 계획 수립' },
  { name: 'developer',    description: '코드 구현 및 Git 브랜치 워크플로우' },
  { name: 'reviewer',     description: '코드 리뷰 및 브랜치 머지' },
  { name: 'tester',       description: '테스트 실행 및 검증' },
  { name: 'researcher',   description: '기술 조사 및 의사결정 지원' },
];


// ── TEAM_MANIFEST 공통 핀 템플릿 ──────────────────────────────

function buildTeamManifestPin() {
  return loadRoleContent('team-manifest');
}

// ── 슬래시 커맨드 정의 ─────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('역할 관리')
    .addSubcommand((sub) =>
      sub
        .setName('init')
        .setDescription('역할 카테고리·채널 생성 + 협력 채널에 TEAM_MANIFEST 핀 등록'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('역할 채널 핀을 코드의 최신 기본값으로 교체 (기존 메시지는 히스토리로 보존)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-default')
        .setDescription('역할 채널에 디폴트 봇을 지정합니다')
        .addStringOption((opt) =>
          opt
            .setName('role')
            .setDescription('역할명 (orchestrator/planner/developer/reviewer/tester/researcher)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('bots')
            .setDescription('디폴트 봇 멘션 (예: @찌몽 또는 @꼼꼼이 @꼼꼼이2)')
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'init') {
      await handleInit(interaction);
    } else if (sub === 'reset') {
      await handleReset(interaction);
    } else if (sub === 'set-default') {
      await handleSetDefault(interaction);
    }
  },
};

// ── /role init ────────────────────────────────────────────────

async function handleInit(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const log = [];

  try {
    // 1. 역할 카테고리 찾기 또는 생성
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );

    if (category) {
      log.push('📁 role 카테고리 — 이미 존재, 스킵');
    } else {
      category = await guild.channels.create({
        name: 'role',
        type: ChannelType.GuildCategory,
      });
      log.push('📁 역할 카테고리 — 생성 완료');
    }

    // 2. 각 역할 채널 생성 + 핀 등록
    for (const role of DEFAULT_ROLES) {
      const existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name === role.name,
      );

      if (existing) {
        log.push(`  📄 #${role.name} — 이미 존재, 스킵`);
        continue;
      }

      const channel = await guild.channels.create({
        name: role.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: role.description,
      });

      // 역할 내용 핀
      const msg = await channel.send(loadRoleContent(role.name));
      await msg.pin();

      // CmdBot 디폴트 봇 핀 (미설정 상태로 초기화)
      const cmdBotId = loadCmdBotId(interaction);
      const defaultPin = await channel.send(
        `<@${cmdBotId}>\ndefault: (미설정 — /role set-default role:${role.name} bots:@봇멘션 으로 지정하세요)`,
      );
      await defaultPin.pin();

      log.push(`  📄 #${role.name} — 생성 완료 (ID: ${channel.id})`);
    }

    // 3. 협력 채널에 TEAM_MANIFEST 공통 핀 등록
    const collabChannelId = loadCollabChannel();
    if (collabChannelId) {
      const collabChannel = await guild.channels.fetch(collabChannelId).catch(() => null);

      if (collabChannel && collabChannel.isTextBased()) {
        // 이미 TEAM_MANIFEST 핀이 있으면 스킵
        const pinned = await collabChannel.messages.fetchPinned().catch(() => null);
        const hasManifest = pinned
          ? [...pinned.values()].some((m) => m.content.trimStart().startsWith('[TEAM_MANIFEST]'))
          : false;

        if (hasManifest) {
          log.push('📋 TEAM_MANIFEST 핀 — 이미 존재, 스킵');
        } else {
          const manifestMsg = await collabChannel.send(buildTeamManifestPin());
          await manifestMsg.pin();
          log.push(`📋 TEAM_MANIFEST 핀 — 협력 채널(${collabChannelId})에 등록 완료`);
          log.push('   ⚠️  BOT_ID_* 값을 실제 봇 ID로 교체해 주세요!');
        }
      } else {
        log.push(`⚠️  협력 채널(${collabChannelId}) 접근 불가 — TEAM_MANIFEST 핀 건너뜀`);
      }
    } else {
      log.push('⚠️  config.json에 collabChannel 없음 — TEAM_MANIFEST 핀 건너뜀');
    }

    await interaction.editReply({
      content: `✅ 역할 초기화 완료\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });
  } catch (err) {
    console.error('[/role init] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}

// ── /role reset ───────────────────────────────────────────────

async function handleReset(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const log = [];

  try {
    // 'role' 카테고리 찾기
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );
    if (!category) {
      return interaction.editReply({ content: '❌ role 카테고리가 없습니다. 먼저 `/role init`을 실행하세요.' });
    }

    for (const role of DEFAULT_ROLES) {
      const existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name === role.name,
      );

      // 채널 없으면 생성 (init 이후 코드에 추가된 역할 채널 처리)
      if (!existing) {
        const channel = await guild.channels.create({
          name: role.name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: role.description,
        });
        const msg = await channel.send(loadRoleContent(role.name));
        await msg.pin();
        log.push(`  ✅ #${role.name} — 채널 생성 + 핀 등록 완료`);
        continue;
      }

      const textChannel = await guild.channels.fetch(existing.id);

      // 기존 역할 내용 핀만 언핀 (CmdBot 디폴트 핀은 유지)
      const pinned = await textChannel.messages.fetchPinned();
      const rolePins = [...pinned.values()].filter(
        (m) => !m.content.trimStart().match(/^<@!?\d+>/),
      );
      for (const msg of rolePins) {
        await msg.unpin().catch(() => {});
      }

      // 최신 기본값으로 새 메시지 작성 + 핀 고정
      const newMsg = await textChannel.send(loadRoleContent(role.name));
      await newMsg.pin();

      log.push(`  ✅ #${role.name} — 핀 교체 완료 (기존 ${rolePins.length}개 언핀)`);
    }

    await interaction.editReply({
      content: `✅ 역할 핀 리셋 완료\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });
  } catch (err) {
    console.error('[/role reset] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}

// ── /role set-default ─────────────────────────────────────────

async function handleSetDefault(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const roleName = interaction.options.getString('role');
  const botsInput = interaction.options.getString('bots');

  try {
    // 'role' 카테고리에서 해당 역할 채널 찾기
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
    );
    if (!category) {
      return interaction.editReply({ content: '❌ role 카테고리가 없습니다. 먼저 `/role init`을 실행하세요.' });
    }

    const roleChannel = guild.channels.cache.find(
      (c) => c.parentId === category.id && c.name === roleName,
    );
    if (!roleChannel) {
      return interaction.editReply({ content: `❌ \`${roleName}\` 역할 채널을 찾을 수 없습니다.` });
    }

    const textChannel = await guild.channels.fetch(roleChannel.id);
    const cmdBotId = loadCmdBotId(interaction);

    // 기존 CmdBot 디폴트 핀 찾기
    const pinned = await textChannel.messages.fetchPinned();
    const existingDefaultPin = [...pinned.values()].find((m) =>
      m.content.trimStart().startsWith(`<@${cmdBotId}>`) && m.content.includes('default:'),
    );

    // 새 디폴트 핀 내용
    const newContent = `<@${cmdBotId}>\ndefault: ${botsInput}`;

    // 기존 핀 언핀 후 새 핀 등록 (히스토리 보존)
    if (existingDefaultPin) {
      await existingDefaultPin.unpin().catch(() => {});
    }
    const newMsg = await textChannel.send(newContent);
    await newMsg.pin();

    // 멘션된 봇 이름 추출 (표시용)
    const botMentions = [...botsInput.matchAll(/<@!?(\d+)>/g)]
      .map((m) => `<@${m[1]}>`)
      .join(', ');

    await interaction.editReply({
      content: `✅ \`${roleName}\` 역할 디폴트 봇 설정 완료\n봇: ${botMentions || botsInput}`,
    });
  } catch (err) {
    console.error('[/role set-default] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
