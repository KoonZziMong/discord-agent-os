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
  await interaction.deferReply({ flags: 64 });

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
  await interaction.deferReply({ flags: 64 });

  const channel = interaction.channel;
  const instruction = interaction.options.getString('instruction');

  console.log(`[/channel setup] 실행 — 채널: #${channel.name}, 지시: ${instruction}`);

  // LLM 설정 확인
  const cmdCfg = loadCmdBotConfig();
  if (!cmdCfg.apiKey || !cmdCfg.model) {
    return interaction.editReply({ content: '❌ CmdBot LLM 설정이 없습니다. config.json에 apiKey와 model을 추가하세요.' });
  }

  await interaction.editReply({ content: `**지시사항:** ${instruction}\n\n⏳ 채널 정보 수집 중...` });

  try {
    // 현재 핀 메시지만 미리 로드 (토픽은 channel.topic으로 바로 접근)
    const pinnedMsgs = await channel.messages.fetchPinned();
    const pinnedList = [...pinnedMsgs.values()].reverse()
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ id: m.id, content: m.content }));

    const channelInfo = [
      `채널 ID: ${channel.id}`,
      `채널명: #${channel.name}`,
      channel.topic ? `현재 토픽: ${channel.topic}` : '현재 토픽: (없음)',
      pinnedList.length > 0
        ? `\n현재 고정 메시지 (${pinnedList.length}개):\n` +
          pinnedList.map((m, i) => `[핀${i + 1} | ID:${m.id}]\n${m.content}`).join('\n\n')
        : '현재 고정 메시지: (없음)',
    ].join('\n');

    await interaction.editReply({ content: `**지시사항:** ${instruction}\n\n⏳ LLM이 채널 컨텍스트를 생성 중...` });

    console.log(`[/channel setup] LLM 호출 시작 (${cmdCfg.model})`);
    const AnthropicClient = Anthropic.default ?? Anthropic;
    const client = new AnthropicClient({ apiKey: cmdCfg.apiKey });

    // 툴 정의 — 필요할 때만 메시지 조회
    const tools = [
      {
        name: 'get_messages',
        description: '채널의 최근 메시지를 조회합니다. 지시사항에서 특정 메시지를 참조할 때 사용하세요.',
        input_schema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '조회할 메시지 수 (최대 50, 기본 20)' },
          },
          required: [],
        },
      },
      {
        name: 'get_message',
        description: '특정 메시지 ID로 메시지를 조회합니다.',
        input_schema: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: '조회할 메시지 ID' },
          },
          required: ['message_id'],
        },
      },
    ];

    const systemPrompt = `당신은 Discord 채널의 토픽과 핀 메시지를 관리하는 에이전트입니다.

## 역할
채널 토픽과 핀 메시지는 이 채널에서 활동하는 AI 봇의 system prompt로 사용됩니다.
- 토픽: 채널의 목적이나 핵심 정보를 한 줄로 요약 (최대 100자)
- 핀 메시지: AI 봇의 페르소나, 행동 규칙, 컨텍스트 등을 마크다운으로 상세 서술 (2~4개 권장)

## 작업 방식
1. 사용자의 지시와 채널 현재 상태를 파악합니다
2. 지시에서 특정 메시지를 참조하면 get_messages 또는 get_message 툴로 내용을 확인합니다
3. 모든 정보가 파악되면 반드시 아래 JSON 형식으로만 최종 응답합니다 (다른 텍스트 없이):

{
  "topic": "채널 토픽",
  "pins": ["첫 번째 핀 내용", "두 번째 핀 내용"]
}`;

    const userMessage = `## 채널 현재 상태\n${channelInfo}\n\n## 지시사항\n${instruction}`;

    // 툴 호출 루프
    const messages = [{ role: 'user', content: userMessage }];
    let raw = '';

    for (let i = 0; i < 5; i++) {
      const response = await client.messages.create({
        model: cmdCfg.model,
        max_tokens: 2048,
        system: systemPrompt,
        tools,
        messages,
      });

      console.log(`[/channel setup] LLM 응답 (${response.stop_reason})`);

      if (response.stop_reason === 'end_turn') {
        raw = response.content.find((b) => b.type === 'text')?.text ?? '';
        break;
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          let result = '';

          if (block.name === 'get_messages') {
            const limit = Math.min(block.input.limit ?? 20, 50);
            const msgs = await channel.messages.fetch({ limit });
            result = [...msgs.values()].reverse()
              .map((m) => `[${m.author.username} | ID:${m.id}]: ${m.content}`)
              .join('\n');
            console.log(`[/channel setup] 툴: get_messages(${limit})`);
          } else if (block.name === 'get_message') {
            const msg = await channel.messages.fetch(block.input.message_id).catch(() => null);
            result = msg ? `[${msg.author.username}]: ${msg.content}` : '메시지를 찾을 수 없습니다.';
            console.log(`[/channel setup] 툴: get_message(${block.input.message_id})`);
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      break;
    }

    console.log(`[/channel setup] 최종 응답 수신 (${raw.length}자)`);

    let parsed;
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      console.error('[/channel setup] JSON 파싱 실패:', raw.slice(0, 200));
      return interaction.editReply({ content: `❌ LLM 응답 파싱 실패:\n\`\`\`\n${raw.slice(0, 500)}\n\`\`\`` });
    }

    const { topic, pins } = parsed;
    if (typeof topic !== 'string' || !Array.isArray(pins)) {
      return interaction.editReply({ content: '❌ LLM이 올바른 형식으로 응답하지 않았습니다.' });
    }

    console.log(`[/channel setup] 토픽: "${topic}", 핀 ${pins.length}개`);

    // 기존 핀 전부 해제
    const existing = await channel.messages.fetchPinned();
    for (const msg of existing.values()) {
      await msg.unpin().catch(() => {});
    }

    // 토픽 설정
    console.log('[/channel setup] 토픽 설정 중...');
    await channel.setTopic(topic).catch((err) => {
      throw new Error(`토픽 설정 실패 (채널 관리 권한 필요): ${err.message}`);
    });

    // 새 핀 메시지 작성 + 고정
    for (let i = 0; i < pins.length; i++) {
      console.log(`[/channel setup] 핀 메시지 ${i + 1}/${pins.length} 작성 중...`);
      const msg = await channel.send(pins[i]);
      await msg.pin().catch((err) => {
        throw new Error(`핀 고정 실패 (Discord 서버 설정 → CmdBot 역할 → "메시지 관리" 권한 필요): ${err.message}`);
      });
    }

    await interaction.editReply({
      content: `**지시사항:** ${instruction}\n\n✅ 완료 — 토픽 1개, 핀 메시지 ${pins.length}개 설정됨`,
    });
  } catch (err) {
    console.error('[/channel setup] 오류:', err);
    await interaction.editReply({ content: `❌ 오류: ${err.message}` });
  }
}
