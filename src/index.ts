/**
 * index.ts — 진입점
 *
 * 기동 순서:
 *  [1] data/config.json 로드 및 설정 파싱
 *  [2] Discord Client × 3 생성
 *  [3] Agent 인스턴스 × 3 생성 (각자 LLMClient + AgentMCPManager 보유)
 *  [4] 봇별 MCP 서버 초기화 (병렬)
 *  [5] 3개 봇 동시 로그인 + 전체 ready 대기
 *  [6] 채널별 대화 히스토리 로드 (Discord API, 설정 채널 제외)
 *  [7] messageCreate 이벤트 → router 연결
 *  [8] Graceful shutdown 핸들러 등록
 */

import { Client, GatewayIntentBits, Events, TextChannel, ChatInputCommandInteraction, Collection } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { Agent } from './agent';
import { createRouter } from './router';
import { loadFromDiscord } from './history';

interface SlashCommand {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// commands/ 폴더에서 슬래시 커맨드 자동 로드
function loadCommands(): Collection<string, SlashCommand> {
  const collection = new Collection<string, SlashCommand>();
  const commandsPath = path.join(__dirname, '..', 'commands');
  if (!fs.existsSync(commandsPath)) return collection;

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cmd = require(path.join(commandsPath, file)) as SlashCommand;
    collection.set(cmd.data.name, cmd);
  }
  return collection;
}

async function main(): Promise<void> {
  // [1] 설정 로드
  const appCfg = loadConfig();

  // 슬래시 커맨드 로드
  const slashCommands = loadCommands();
  console.log(`📋 슬래시 커맨드 로드: ${[...slashCommands.keys()].map((k) => `/${k}`).join(', ') || '없음'}`);

  // [2] Discord Client 3개 생성
  const clients = appCfg.agents.map(() =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    }),
  );

  // [3] Agent 인스턴스 생성
  const agents = appCfg.agents.map((cfg, i) => new Agent(cfg, clients[i]));

  // [4] 봇별 MCP 서버 초기화 (병렬)
  await Promise.all(agents.map((a) => a.mcpManager.init()));

  const primaryClient = clients[0];

  // [5] 로그인 + 전체 ready 대기
  //     ready 이벤트에서 botUserId를 기록하고 resolve합니다.
  const readyPromises = clients.map((client, i) =>
    new Promise<void>((resolve) => {
      client.once(Events.ClientReady, (c) => {
        agents[i].botUserId = c.user.id;
        console.log(`✅ ${agents[i].name} (${c.user.tag}) 온라인`);
        resolve();
      });
    }),
  );

  await Promise.all(appCfg.agents.map((cfg, i) => clients[i].login(cfg.discordToken)));
  await Promise.all(readyPromises);

  // [6] 채널별 히스토리 로드 (대화 채널 + 협력 채널, 설정 채널 제외)
  //     모든 봇이 전 채널 보기 권한을 가지므로 primaryClient로 통일합니다.
  const getLimit = (channelId: string) =>
    appCfg.channelLimits[channelId] ?? appCfg.historyLimit;

  const historyChannels = [
    ...appCfg.agents.map((a) => a.chatChannel),
    appCfg.collabChannel,
  ];

  console.log('📂 히스토리 로드 중...');
  await Promise.allSettled(
    historyChannels.map(async (channelId) => {
      try {
        const channel = await primaryClient.channels.fetch(channelId) as TextChannel;
        await loadFromDiscord(channel, getLimit(channelId));
      } catch (err: unknown) {
        console.warn(
          `⚠️  히스토리 로드 실패 (${channelId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  // [7] 라우터 생성 후 messageCreate 이벤트 바인딩
  const router = createRouter(agents, appCfg, primaryClient);

  for (const client of clients) {
    client.on(Events.MessageCreate, (message) => {
      router(message, client).catch((err: unknown) => {
        console.error('라우터 오류:', err instanceof Error ? err.message : err);
      });
    });
  }

  // [8] interactionCreate — 슬래시 커맨드 라우팅
  for (const client of clients) {
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const cmd = slashCommands.get(interaction.commandName);
      if (!cmd) return;
      try {
        await cmd.execute(interaction);
      } catch (err: unknown) {
        console.error(`슬래시 커맨드 오류 (/${interaction.commandName}):`, err instanceof Error ? err.message : err);
        const msg = { content: '커맨드 실행 중 오류가 발생했습니다.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      }
    });
  }

  const shutdown = async () => {
    console.log('\n종료 중...');
    await Promise.all(agents.map((a) => a.mcpManager.close()));
    for (const client of clients) client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('🚀 discord-ai-team 시작 완료');
}

main().catch((err) => {
  console.error('시작 오류:', err instanceof Error ? err.message : err);
  process.exit(1);
});
