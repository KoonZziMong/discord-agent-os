/**
 * /project 슬래시 커맨드
 *
 * 서브커맨드:
 *   /project create — 새 프로젝트 카테고리 + 채널 일괄 생성
 *
 * 생성 구조:
 *   P|{name}/ (카테고리)
 *     role      — Step 2 프로젝트 커스텀 지침 채널 (default_role 또는 description 시 생성)
 *     workspace — 실제 작업 채널 (항상 생성)
 *
 * 옵션:
 *   default_role  — role 채널 생성 + ROLE 카테고리 디폴트 봇을 workspace 채널에 매핑
 *   description   — LLM이 프로젝트 설명을 분석하여 role 채널에 특화 지침 자동 작성
 *
 * 필요 권한 (CmdBot 역할):
 *   - 채널 관리 (Manage Channels)
 *   - 메시지 관리 (Manage Messages) — 핀 고정
 */

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

function loadCmdBotConfig() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.cmdBot ?? {};
}

function loadAgentList() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return (config.agents ?? []).map((a) => ({ id: a.id, name: a.name }));
}

/** y/yes/true/1/on — 어떤 형태든 truthy 값이면 true */
function isTruthy(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'y' || v === '1' || v === 'on';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('project')
    .setDescription('프로젝트 관리')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('새 프로젝트 카테고리와 채널을 생성합니다')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('프로젝트명 (예: 테스트 → P|테스트 카테고리 생성)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('default_role')
            .setDescription('role 채널 생성 + 디폴트 봇 workspace 매핑 (y/yes/true/1)')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('description')
            .setDescription('프로젝트 설명 — LLM이 role 채널에 특화 지침 자동 작성')
            .setRequired(false),
        ),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', flags: 64 });
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') await handleCreate(interaction);
  },
};

// ── /project create ───────────────────────────────────────────

async function handleCreate(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const projectName = interaction.options.getString('name');
  const defaultRoleRaw = interaction.options.getString('default_role');
  const description = interaction.options.getString('description');

  const useDefaultRole = isTruthy(defaultRoleRaw);
  const needsRoleChannel = useDefaultRole || !!description;
  const categoryName = `P|${projectName}`;
  const log = [];

  try {
    await interaction.editReply({ content: `⏳ **${categoryName}** 프로젝트 생성 중...` });

    // 1. 카테고리 생성
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === categoryName,
    );
    if (category) {
      log.push(`📁 ${categoryName} 카테고리 — 이미 존재, 스킵`);
    } else {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
      log.push(`📁 ${categoryName} 카테고리 — 생성 완료`);
    }

    // 2. role 채널 생성 (default_role 또는 description 시)
    let roleChannel = null;
    if (needsRoleChannel) {
      const existingRoleCh = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name.toLowerCase() === 'role',
      );
      if (existingRoleCh) {
        roleChannel = existingRoleCh;
        log.push('  📋 #role — 이미 존재, 스킵');
      } else {
        roleChannel = await guild.channels.create({
          name: 'role',
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `[${projectName}] 프로젝트 커스텀 역할 지침 (Step 2 컨텍스트)`,
        });
        log.push('  📋 #role — 생성 완료');
      }
    }

    // 3. workspace 채널 생성
    let workspaceChannel = guild.channels.cache.find(
      (c) => c.parentId === category.id && c.name === 'workspace',
    );
    if (workspaceChannel) {
      log.push('  💬 #workspace — 이미 존재, 스킵');
    } else {
      workspaceChannel = await guild.channels.create({
        name: 'workspace',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `[${projectName}] 작업 채널`,
      });
      log.push('  💬 #workspace — 생성 완료');
    }

    // 4. 디폴트 봇 매핑 (default_role = true)
    //    ROLE 카테고리에서 디폴트 봇을 읽어 workspace 채널에 Step 3 핀 등록
    const defaultBotMap = {}; // roleName → botId[]

    if (useDefaultRole) {
      const cmdBotId = interaction.client.user.id;
      const globalRoleCategory = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
      );

      if (!globalRoleCategory) {
        log.push('  ⚠️  ROLE 카테고리 없음 — /role init을 먼저 실행하세요');
      } else {
        // 각 역할 채널에서 CmdBot 핀의 default 봇 목록 수집
        const globalRoleChannels = guild.channels.cache.filter(
          (c) => c.parentId === globalRoleCategory.id && c.type === ChannelType.GuildText,
        );
        await Promise.all([...globalRoleChannels.values()].map(async (ch) => {
          try {
            const textCh = await guild.channels.fetch(ch.id);
            const pins = await textCh.messages.fetchPinned();
            for (const msg of pins.values()) {
              if (msg.content.trimStart().startsWith(`<@${cmdBotId}>`) && msg.content.includes('default:')) {
                const mentionMatches = [...msg.content.matchAll(/<@!?(\d+)>/g)].slice(1); // CmdBot ID 제외
                const botIds = mentionMatches.map((m) => m[1]);
                if (botIds.length > 0) defaultBotMap[ch.name] = botIds;
                break;
              }
            }
          } catch { /* 개별 채널 실패 무시 */ }
        }));

        if (Object.keys(defaultBotMap).length === 0) {
          log.push('  ⚠️  디폴트 봇 미설정 — /role set-default 로 먼저 지정하세요');
        } else {
          // workspace 채널에 역할별 봇 멘션 핀 등록 (Step 3)
          const agentList = loadAgentList();
          const workspaceTextCh = await guild.channels.fetch(workspaceChannel.id);

          for (const [roleName, botIds] of Object.entries(defaultBotMap)) {
            for (const botId of botIds) {
              const botName = agentList.find((a) => a.id === botId)?.name ?? botId;
              const pinContent = `<@${botId}>\n역할: ${roleName}`;
              const msg = await workspaceTextCh.send(pinContent);
              await msg.pin();
              log.push(`  📌 #workspace 핀 — ${botName} → 역할: ${roleName}`);
            }
          }
        }
      }
    }

    // 5. description → LLM이 role 채널 Step 2 지침 생성
    //    Step 1 글로벌 역할 채널 내용을 먼저 읽어서 중복 없이 프로젝트 특화 내용만 추가
    if (description && roleChannel) {
      await interaction.editReply({
        content: `⏳ **${categoryName}** 생성 중...\n\`\`\`\n${log.join('\n')}\n\`\`\`\n🤖 LLM이 프로젝트 특화 지침 생성 중...`,
      });

      const cmdCfg = loadCmdBotConfig();
      if (!cmdCfg.apiKey || !cmdCfg.model) {
        log.push('  ⚠️  CmdBot LLM 미설정 — config.json에 apiKey/model을 추가하세요');
      } else {
        const agentList = loadAgentList();

        // Step 1 글로벌 역할 채널에서 각 역할의 핀 내용 로드 (중복 방지용)
        const globalRoleCategory = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'role',
        );
        const globalRoleContents = {}; // roleName → string
        if (globalRoleCategory) {
          await Promise.all(
            Object.keys(defaultBotMap).map(async (roleName) => {
              try {
                const ch = guild.channels.cache.find(
                  (c) => c.parentId === globalRoleCategory.id && c.name === roleName,
                );
                if (!ch) return;
                const textCh = await guild.channels.fetch(ch.id);
                const pins = await textCh.messages.fetchPinned();
                const content = [...pins.values()]
                  .reverse()
                  .filter((m) => m.content.trim().length > 0)
                  .filter((m) => !m.content.trimStart().match(/^<@!?\d+>\s*\ndefault:/))
                  .filter((m) => !m.content.trimStart().match(/^<@!?\d+>/))
                  .map((m) => m.content)
                  .join('\n\n---\n\n');
                if (content) globalRoleContents[roleName] = content;
              } catch { /* 개별 채널 실패 무시 */ }
            }),
          );
        }

        // 역할별 항목 구성 (봇ID, 역할명, 글로벌 내용)
        const roleEntries = Object.entries(defaultBotMap).flatMap(([roleName, botIds]) =>
          botIds.map((botId) => ({
            roleName,
            botId,
            botName: agentList.find((a) => a.id === botId)?.name ?? botId,
            globalContent: globalRoleContents[roleName] ?? '(내용 없음)',
          })),
        );

        // 역할별 섹션 — LLM이 기존 내용을 보고 중복 없이 추가할 내용 결정
        const roleSection = roleEntries.map(({ roleName, botId, botName, globalContent }) => {
          const preview = globalContent.slice(0, 600) + (globalContent.length > 600 ? '\n...(이하 생략)' : '');
          return `### ${roleName} — ${botName} (ID: ${botId})
이미 주입되는 글로벌 역할 내용 (중복 작성 금지):
\`\`\`
${preview}
\`\`\``;
        }).join('\n\n');

        const systemPrompt = `당신은 Discord AI 에이전트 팀의 프로젝트 설정 도우미입니다.
프로젝트의 "role" 채널에 넣을 핀 내용을 생성합니다.
이 핀들은 프로젝트 내 모든 채널에서 AI 봇의 system prompt에 글로벌 역할 정의 다음에 추가로 주입됩니다.

## 핀 1개 = 봇 1명
각 봇마다 핀 1개를 생성합니다. 형식은 반드시:
첫 줄: <@봇ID>
둘째 줄: 역할: {역할명}
이후: 이 프로젝트에서 해당 역할에 필요한 특화 내용

## 절대 금지
- 글로벌 역할 내용과 동일하거나 유사한 내용 작성 (이미 주입됨)
- "역할: roleName" 외의 역할 배정 문법 사용
- description과 무관한 일반적인 내용 작성

## 작성 기준
description을 분석하여 각 역할이 이 프로젝트에서 특히 알아야 할 내용만 작성:
- 기술 스택, 도메인, 컨벤션 중 해당 역할에 관련된 것
- 글로벌 정의에 없는 이 프로젝트만의 규칙이나 제약
- 각 봇 역할 특성에 맞게 다른 내용으로 작성 (복붙 금지)
- 핀당 최대 800자, 전체 합산 1500자 이내

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "pins": [
    "<@봇ID>\\n역할: roleName\\n프로젝트 특화 내용...",
    "<@봇ID>\\n역할: roleName\\n프로젝트 특화 내용..."
  ]
}`;

        const userMessage = `## 프로젝트명
${projectName}

## 프로젝트 설명
${description}

## 봇별 글로벌 역할 내용 (이미 주입됨 — 중복 금지)
${roleSection || '(글로벌 역할 내용 없음 — description 기반으로 자유롭게 작성)'}`;

        try {
          console.log(`[/project create] LLM 호출 시작 (${cmdCfg.model})`);
          const AnthropicClient = Anthropic.default ?? Anthropic;
          const anthropicClient = new AnthropicClient({ apiKey: cmdCfg.apiKey });

          const response = await anthropicClient.messages.create({
            model: cmdCfg.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          });

          const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
          const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
          const parsed = JSON.parse(jsonMatch[1].trim());

          if (!Array.isArray(parsed.pins)) throw new Error('pins 배열 없음');

          const roleChannelTextCh = await guild.channels.fetch(roleChannel.id);
          let pinCount = 0;
          for (const pinContent of parsed.pins) {
            if (typeof pinContent === 'string' && pinContent.trim()) {
              const msg = await roleChannelTextCh.send(pinContent.trim());
              await msg.pin();
              pinCount++;
            }
          }
          log.push(`  ✅ #role — LLM 지침 ${pinCount}개 핀 등록 완료`);
        } catch (llmErr) {
          console.error('[/project create] LLM 오류:', llmErr);
          log.push(`  ⚠️  #role LLM 오류: ${(llmErr.message ?? String(llmErr)).slice(0, 100)}`);
        }
      }
    }

    // 완료 메시지
    const channelList = needsRoleChannel ? '#role, #workspace' : '#workspace';
    const summaryLine = [
      `📁 카테고리: \`${categoryName}\``,
      `💬 채널: ${channelList}`,
      useDefaultRole && Object.keys(defaultBotMap).length > 0 ? `📌 디폴트 봇 매핑 완료` : '',
      description ? `🤖 LLM 지침 적용` : '',
    ].filter(Boolean).join(' | ');

    await interaction.editReply({
      content: `✅ **${categoryName}** 프로젝트 생성 완료\n${summaryLine}\n\`\`\`\n${log.join('\n')}\n\`\`\``,
    });

    console.log(`[/project create] 완료: ${categoryName}`);
  } catch (err) {
    console.error('[/project create] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
