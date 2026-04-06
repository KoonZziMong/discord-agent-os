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

// config.json에서 에이전트 목록(이름 → ID) 로드
function loadAgentList() {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return (config.agents ?? []).map((a) => ({ id: a.id, name: a.name }));
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
    // 에이전트 목록 로드 (봇 멘션 생성 시 정확한 ID 제공용)
    const agentList = loadAgentList();

    // '역할' 카테고리 채널 목록 + 디폴트 봇 정보 조회
    const guild = interaction.guild;
    const cmdBotId = interaction.client.user.id;
    const roleCategory = guild?.channels.cache.find(
      (c) => c.type === 4 /* GuildCategory */ && c.name === '역할',
    );
    const availableRoles = roleCategory
      ? guild.channels.cache
          .filter((c) => c.parentId === roleCategory.id && c.type === 0)
          .map((c) => c.name)
      : [];

    // 역할별 디폴트 봇 목록 조회 (역할 채널의 CmdBot 핀에서 파싱)
    const defaultBotMap = {};
    if (roleCategory) {
      const roleChannels = guild.channels.cache.filter(
        (c) => c.parentId === roleCategory.id && c.type === 0,
      );
      await Promise.all([...roleChannels.values()].map(async (ch) => {
        try {
          const textCh = await guild.channels.fetch(ch.id);
          const pins = await textCh.messages.fetchPinned();
          for (const msg of pins.values()) {
            if (msg.content.trimStart().startsWith(`<@${cmdBotId}>`) && msg.content.includes('default:')) {
              const mentionMatches = [...msg.content.matchAll(/<@!?(\d+)>/g)].slice(1); // CmdBot 제외
              const botIds = mentionMatches.map((m) => m[1]);
              const botNames = botIds.map((id) => {
                const agent = agentList.find((a) => a.id === id);
                return agent ? `${agent.name}(<@${id}>)` : `<@${id}>`;
              });
              if (botNames.length > 0) defaultBotMap[ch.name] = botNames.join(', ');
              break;
            }
          }
        } catch { /* 개별 채널 실패는 무시 */ }
      }));
    }

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
채널 토픽과 핀 메시지는 이 채널에서 활동하는 AI 봇의 system prompt로 직접 주입됩니다.
봇이 대화할 때 가장 먼저 읽는 컨텍스트이므로, 내용을 풍부하고 명확하게 작성해야 합니다.

## 토픽 작성 원칙
- 최대 1024자까지 사용 가능 — 채널의 중요 정보를 충분히 담으세요
- 채널의 목적, 핵심 규칙, 주요 참여자, 프로젝트 배경 등 봇이 항상 알아야 할 정보
- 짧게 쓰지 말 것 — 공간이 허락하는 한 디테일하게 작성하세요

## 핀 메시지 작성 원칙
- 핀 하나당 최대 2000자 — 공간을 최대한 활용하세요
- 필요하다면 여러 개의 핀을 사용해 내용을 분리하세요 (역할/규칙/컨텍스트 등 주제별 분리 권장)
- 마크다운 형식으로 구조화하여 봇이 읽기 쉽게 작성
- 페르소나, 행동 규칙, 금지 사항, 참고 정보 등을 상세하게 서술
- 핀 개수 제한 없음 — 내용이 많으면 핀을 늘리세요

## 봇 전용 핀 작성 규칙
- 특정 봇에게만 전달할 내용은 핀 맨 첫 줄을 해당 봇의 멘션(<@봇ID>)으로 시작하세요
- 멘션 없이 시작하는 핀은 채널의 모든 봇에게 공통으로 전달됩니다
- 반드시 아래 실제 봇 ID를 사용하세요 (임의로 ID를 만들지 마세요):
${agentList.length > 0
  ? agentList.map((a) => `  - ${a.name}: <@${a.id}>`).join('\n')
  : '  (등록된 봇 없음)'
}
- 예시:
  - \`<@실제봇ID>\n봇 전용 역할 설명...\` → 해당 봇에게만 전달
  - \`## 공통 프로젝트 규칙\n...\` → 모든 봇에게 전달

## 하네스 역할 지정 규칙
봇 전용 핀에 하네스 역할을 지정할 때는 반드시 아래 형식을 사용하세요:
\`역할: {역할명}\`

${availableRoles.length > 0
  ? `현재 등록된 역할 (정확히 이 이름 중 하나만 사용):
${availableRoles.map((r) => {
    const def = defaultBotMap[r];
    return `- ${r}${def ? ` (디폴트 봇: ${def})` : ''}`;
  }).join('\n')}

사용자가 역할 이름에 오타를 내거나 다른 표현을 써도 위 목록에서 가장 가까운 역할명으로 교정하여 사용하세요.

"디폴트 봇으로 설정해줘" 또는 "기본 봇으로 매핑해줘" 지시 시:
위 디폴트 봇 정보를 참고하여 각 봇의 전용 핀에 '역할: {역할명}'을 자동으로 작성하세요.`
  : '(역할 채널 없음 — /role init을 먼저 실행하세요)'
}

예시:
\`<@1488036292280320140>
역할: orchestrator
역할채널: 1234567890
찌몽 전용 지시사항...\`

## 작업 방식
1. 사용자의 지시와 채널 현재 상태를 파악합니다
2. 지시에서 특정 메시지를 참조하면 get_messages 또는 get_message 툴로 내용을 확인합니다
3. 모든 정보가 파악되면 반드시 아래 JSON 형식으로만 최종 응답합니다 (다른 텍스트 없이):

{
  "topic": "변경할 토픽 내용. 토픽을 변경하지 않으려면 현재 토픽을 그대로 반환하세요.",
  "pinChanges": {
    "keep":   ["변경 불필요한 핀의 ID (현재 고정 메시지에서 ID 참조)"],
    "update": [{"id": "수정할 핀 ID", "content": "새 내용 (최대 2000자)"}],
    "add":    ["새로 추가할 핀 내용 (최대 2000자)"],
    "remove": ["삭제할 핀 ID"]
  }
}

핵심 원칙:
- 지시사항과 관련 없는 기존 핀은 반드시 keep에 넣어 그대로 유지하세요
- 수정이 필요한 핀만 update, 새 핀은 add, 불필요한 핀은 remove
- 기존 핀이 없으면 keep/update/remove는 빈 배열, add에만 내용 작성`;

    const userMessage = `## 채널 현재 상태\n${channelInfo}\n\n## 지시사항\n${instruction}`;

    // 툴 호출 루프
    const messages = [{ role: 'user', content: userMessage }];
    let raw = '';

    for (let i = 0; i < 5; i++) {
      const response = await client.messages.create({
        model: cmdCfg.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });

      console.log(`[/channel setup] LLM 응답 (${response.stop_reason})`);

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
        raw = response.content.find((b) => b.type === 'text')?.text ?? '';
        if (response.stop_reason === 'max_tokens') {
          console.warn('[/channel setup] max_tokens 도달 — 응답이 잘렸을 수 있음');
        }
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
      return interaction.editReply({ content: `**지시사항:** ${instruction}\n\n❌ LLM 응답 파싱 실패:\n\`\`\`\n${raw.slice(0, 500)}\n\`\`\`` });
    }

    const { topic, pinChanges } = parsed;
    if (typeof topic !== 'string' || !pinChanges || typeof pinChanges !== 'object') {
      return interaction.editReply({ content: '❌ LLM이 올바른 형식으로 응답하지 않았습니다.' });
    }

    const keep   = Array.isArray(pinChanges.keep)   ? pinChanges.keep   : [];
    const update = Array.isArray(pinChanges.update)  ? pinChanges.update  : [];
    const add    = Array.isArray(pinChanges.add)     ? pinChanges.add    : [];
    const remove = Array.isArray(pinChanges.remove)  ? pinChanges.remove  : [];

    console.log(`[/channel setup] 토픽: "${topic}", keep:${keep.length} update:${update.length} add:${add.length} remove:${remove.length}`);

    // 현재 핀 목록 (처리 기준)
    const existing = await channel.messages.fetchPinned();

    // 토픽 설정
    console.log('[/channel setup] 토픽 설정 중...');
    await channel.setTopic(topic).catch((err) => {
      throw new Error(`토픽 설정 실패 (채널 관리 권한 필요): ${err.message}`);
    });

    // remove: 핀 해제 (메시지는 채널에 남음)
    for (const id of remove) {
      const msg = existing.get(id);
      if (msg) {
        await msg.unpin().catch(() => {});
        console.log(`[/channel setup] 핀 해제: ${id}`);
      }
    }

    // update: 기존 핀 해제 → 새 내용으로 메시지 작성 → 핀 고정
    for (const { id, content } of update) {
      const old = existing.get(id);
      if (old) await old.unpin().catch(() => {});
      const msg = await channel.send(content);
      await msg.pin().catch((err) => {
        throw new Error(`핀 고정 실패 (메시지 관리 권한 필요): ${err.message}`);
      });
      console.log(`[/channel setup] 핀 수정: ${id} → ${msg.id}`);
    }

    // add: 새 메시지 작성 + 핀 고정
    for (let i = 0; i < add.length; i++) {
      const msg = await channel.send(add[i]);
      await msg.pin().catch((err) => {
        throw new Error(`핀 고정 실패 (메시지 관리 권한 필요): ${err.message}`);
      });
      console.log(`[/channel setup] 핀 추가: ${msg.id}`);
    }

    // keep: 아무것도 하지 않음 (기존 핀 그대로 유지)
    console.log(`[/channel setup] 유지된 핀: ${keep.length}개`);

    const summary = [
      keep.length   > 0 ? `유지 ${keep.length}개`   : '',
      update.length > 0 ? `수정 ${update.length}개` : '',
      add.length    > 0 ? `추가 ${add.length}개`    : '',
      remove.length > 0 ? `제거 ${remove.length}개` : '',
    ].filter(Boolean).join(', ');

    await interaction.editReply({
      content: `**지시사항:** ${instruction}\n\n✅ 완료 — ${summary || '변경 없음'}`,
    });
  } catch (err) {
    console.error('[/channel setup] 오류:', err);
    await interaction.editReply({ content: `**지시사항:** ${instruction}\n\n❌ 오류: ${err.message}` });
  }
}
