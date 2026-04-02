/**
 * /channel 슬래시 커맨드
 *
 * 채널 토픽과 핀 메시지를 관리합니다.
 *
 * 서브커맨드:
 *   /channel context  — 현재 채널의 토픽 + 핀 메시지를 출력 (LLM 불필요)
 *   /channel setup <지시사항>  — LLM이 토픽 + 핀 내용을 생성하여 채널에 적용
 *
 * 필요 권한 (CmdBot 역할):
 *   - 채널 관리 (Manage Channels)  — 토픽 수정
 *   - 메시지 관리 (Manage Messages) — 핀 고정/해제
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

// config.json에서 CmdBot LLM 설정 로드
function loadCmdBotConfig() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.cmdBot ?? {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('채널 컨텍스트(토픽/핀) 관리')
    .addSubcommand((sub) =>
      sub
        .setName('context')
        .setDescription('현재 채널의 토픽과 핀 메시지를 출력합니다'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('LLM이 지시사항을 바탕으로 채널 토픽과 핀 메시지를 생성합니다')
        .addStringOption((opt) =>
          opt
            .setName('instruction')
            .setDescription('채널 컨텍스트 생성 지시사항 (예: 30년차 개발자 출신 CEO 페르소나)')
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    // 관리자 권한 체크
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'context') {
      await handleContext(interaction);
    } else if (sub === 'setup') {
      await handleSetup(interaction);
    }
  },
};

// ── /channel context ──────────────────────────────────────────

async function handleContext(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;

  try {
    const topic = channel.topic ?? '';
    const pinned = await channel.messages.fetchPinned();
    const pins = [...pinned.values()]
      .reverse()
      .filter((m) => m.content.trim().length > 0);

    const lines = [`**#${channel.name} 채널 컨텍스트**\n`];

    if (topic) {
      lines.push(`**📌 토픽**\n> ${topic.replace(/\n/g, '\n> ')}`);
    } else {
      lines.push('**📌 토픽**\n> (없음)');
    }

    if (pins.length > 0) {
      lines.push(`\n**📎 고정 메시지 (${pins.length}개)**`);
      pins.forEach((msg, i) => {
        const preview = msg.content.length > 500
          ? msg.content.slice(0, 500) + '...'
          : msg.content;
        lines.push(`\n**[${i + 1}]** ${preview}`);
      });
    } else {
      lines.push('\n**📎 고정 메시지**\n> (없음)');
    }

    const output = lines.join('\n');
    // Discord 메시지 제한(2000자) 초과 시 분할
    if (output.length <= 2000) {
      await interaction.editReply({ content: output });
    } else {
      await interaction.editReply({ content: output.slice(0, 1990) + '\n...' });
    }
  } catch (err) {
    await interaction.editReply({ content: `오류: ${err.message}` });
  }
}

// ── /channel setup ────────────────────────────────────────────

async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  const instruction = interaction.options.getString('instruction');

  // LLM 설정 확인
  const cmdCfg = loadCmdBotConfig();
  if (!cmdCfg.apiKey || !cmdCfg.model) {
    return interaction.editReply({ content: '❌ CmdBot LLM 설정이 없습니다. config.json에 apiKey와 model을 추가하세요.' });
  }

  await interaction.editReply({ content: '⏳ LLM이 채널 컨텍스트를 생성 중...' });

  try {
    const client = new Anthropic.default({ apiKey: cmdCfg.apiKey });

    const systemPrompt = `당신은 Discord 채널 컨텍스트를 설계하는 전문가입니다.
사용자의 지시사항을 바탕으로 채널 토픽과 핀 메시지 내용을 작성합니다.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요:
{
  "topic": "채널 토픽 (한 줄 요약, 최대 100자)",
  "pins": [
    "첫 번째 핀 메시지 내용",
    "두 번째 핀 메시지 내용"
  ]
}

핀 메시지는 LLM의 system prompt로 주입됩니다. 마크다운 형식으로 작성하고, 역할/행동방식/규칙 등을 명확하게 서술하세요.
핀은 2~4개가 적당합니다.`;

    const response = await client.messages.create({
      model: cmdCfg.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: instruction }],
    });

    const raw = response.content[0]?.text ?? '';
    let parsed;
    try {
      // JSON 블록 추출 (```json ... ``` 감싸진 경우 대응)
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      return interaction.editReply({ content: `❌ LLM 응답 파싱 실패:\n\`\`\`\n${raw.slice(0, 500)}\n\`\`\`` });
    }

    const { topic, pins } = parsed;
    if (typeof topic !== 'string' || !Array.isArray(pins)) {
      return interaction.editReply({ content: '❌ LLM이 올바른 형식으로 응답하지 않았습니다.' });
    }

    // 기존 핀 전부 해제
    const existing = await channel.messages.fetchPinned();
    for (const msg of existing.values()) {
      await msg.unpin().catch(() => {});
    }

    // 토픽 설정
    await channel.setTopic(topic).catch((err) => {
      throw new Error(`토픽 설정 실패 (채널 관리 권한 필요): ${err.message}`);
    });

    // 새 핀 메시지 작성 + 고정
    for (const pinContent of pins) {
      const msg = await channel.send(pinContent);
      await msg.pin().catch((err) => {
        throw new Error(`핀 고정 실패 (메시지 관리 권한 필요): ${err.message}`);
      });
    }

    await interaction.editReply({
      content: `✅ 채널 컨텍스트 설정 완료\n- 토픽: ${topic}\n- 핀 메시지: ${pins.length}개`,
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
