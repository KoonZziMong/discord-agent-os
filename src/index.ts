/**
 * index.ts — 진입점
 *
 * 기동 순서:
 *  [1] data/config.json 로드 및 설정 파싱
 *  [2] Discord Client × 3 생성 (AI 봇) + CmdBot 클라이언트 생성
 *  [3] Agent 인스턴스 × 3 생성 (각자 LLMClient + AgentMCPManager 보유)
 *  [4] 봇별 MCP 서버 초기화 (병렬)
 *  [5] 전체 봇 동시 로그인 + ready 대기
 *  [6] 채널별 대화 히스토리 로드 (Discord API, 설정 채널 제외)
 *  [7] messageCreate 이벤트 → router 연결 (AI 봇만)
 *  [8] interactionCreate → CmdBot 전담 처리
 *  [9] Graceful shutdown 핸들러 등록
 */

import { Client, GatewayIntentBits, Events, TextChannel, BaseGuildTextChannel, ChatInputCommandInteraction, StringSelectMenuInteraction, Collection, MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, type AppConfig } from './config';
import { Agent } from './agent';
import { createRouter } from './router';
import { loadFromDiscord } from './history';
import { loadChannelContext, updateTopic, refreshPins } from './channelContext';
import { invalidateRoleCache } from './roleContext';
import { TaskGraph } from './task/graph';
import { loadIncompleteGraphs } from './task/store';
import { startAdminServer } from './admin/server';
import { cleanExpiredProposals, findProposalByMessageId, deleteProposal } from './roleProposals';
import { ROLE_UPDATE_PROPOSAL_SENTINEL } from './agentProtocol';

interface SlashCommand {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleSelectMenu?: (interaction: StringSelectMenuInteraction) => Promise<boolean>;
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

/**
 * [ROLE_UPDATE_PROPOSAL] 메시지에 반응(✅/❌)이 달렸을 때 제안을 적용하거나 폐기합니다.
 */
async function applyOrRejectProposal(
  emoji: string | null,
  proposal: import('./roleProposals').RoleProposal,
  notifyChannel: TextChannel,
  appCfg: AppConfig,
  clients: Client[],
  agents: Agent[],
): Promise<void> {
  if (emoji === '✅') {
    console.log(`[proposal] 승인: ${proposal.proposalId} (role: ${proposal.targetRole})`);
    try {
      // CmdBot으로 역할 채널 핀 수정
      const cmdClient = clients.find((c) => !agents.some((a) => a.botClient === c));
      if (!cmdClient) throw new Error('CmdBot 없음');

      const roleChannel = await cmdClient.channels.fetch(proposal.roleChannelId) as TextChannel;

      // 기존 핀 해제
      const existingPins = await roleChannel.messages.fetchPinned();
      for (const m of existingPins.values()) await m.unpin().catch(() => {});

      // 새 핀 등록
      const newMsg = await roleChannel.send(proposal.newContent);
      await newMsg.pin();

      // 캐시 무효화
      invalidateRoleCache(proposal.roleChannelId);
      await refreshPins(roleChannel).catch(() => {});

      deleteProposal(proposal.proposalId);

      await notifyChannel.send(
        `✅ **역할 핀 업데이트 완료** — \`${proposal.targetRole}\` 역할이 수정되었습니다.\n` +
        `-# proposalId: ${proposal.proposalId}`,
      );
      console.log(`[proposal] 적용 완료: ${proposal.proposalId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proposal] 적용 실패: ${msg}`);
      await notifyChannel.send(`❌ 역할 핀 업데이트 실패: ${msg.slice(0, 200)}`).catch(() => {});
    }
  } else if (emoji === '❌') {
    console.log(`[proposal] 거부: ${proposal.proposalId}`);
    deleteProposal(proposal.proposalId);
    await notifyChannel.send(
      `❌ **역할 핀 업데이트 거부됨** — \`${proposal.targetRole}\` 제안이 폐기되었습니다.\n` +
      `-# proposalId: ${proposal.proposalId}`,
    ).catch(() => {});
  }
}

async function main(): Promise<void> {
  // [1] 설정 로드
  const appCfg = loadConfig();

  // 만료된 역할 핀 업데이트 제안 정리
  cleanExpiredProposals();

  // 슬래시 커맨드 로드
  const slashCommands = loadCommands();
  console.log(`📋 슬래시 커맨드 로드: ${[...slashCommands.keys()].map((k) => `/${k}`).join(', ') || '없음'}`);

  // [2] AI 봇 Client 3개 + CmdBot Client 생성
  const clients = appCfg.agents.map(() =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,  // [ROLE_UPDATE_PROPOSAL] 반응 감지
      ],
    }),
  );

  const cmdClient = appCfg.cmdBot
    ? new Client({ intents: [GatewayIntentBits.Guilds] })
    : null;

  // [3] Agent 인스턴스 생성
  const agents = appCfg.agents.map((cfg, i) => new Agent(cfg, clients[i], appCfg));

  // [4] 봇별 MCP 서버 초기화 (병렬)
  await Promise.all(agents.map((a) => a.mcpManager.init()));

  const primaryClient = clients[0];

  // [5] 로그인 + 전체 ready 대기 (discordToken 없는 봇은 건너뜀)
  const readyPromises = clients.map((client, i) => {
    if (!appCfg.agents[i].discordToken) return Promise.resolve();
    return new Promise<void>((resolve) => {
      client.once(Events.ClientReady, (c) => {
        console.log(`✅ ${agents[i].name} (${c.user.tag}) 온라인`);
        resolve();
      });
    });
  });

  // CmdBot ready 대기
  const cmdReadyPromise = cmdClient
    ? new Promise<void>((resolve) => {
        cmdClient.once(Events.ClientReady, (c) => {
          console.log(`✅ CmdBot (${c.user.tag}) 온라인`);
          resolve();
        });
      })
    : Promise.resolve();

  await Promise.all([
    ...appCfg.agents.map((cfg, i) => cfg.discordToken ? clients[i].login(cfg.discordToken) : Promise.resolve()),
    ...(appCfg.cmdBot ? [cmdClient!.login(appCfg.cmdBot.discordToken)] : []),
  ]);
  await Promise.all([...readyPromises, cmdReadyPromise]);

  // [6] 채널별 히스토리 로드 (대화 채널 + 협력 채널, 설정 채널 제외)
  //     모든 봇이 전 채널 보기 권한을 가지므로 primaryClient로 통일합니다.
  const getLimit = (channelId: string) =>
    appCfg.channelLimits[channelId] ?? appCfg.historyLimit;

  const historyChannels: string[] = [
    ...appCfg.agents.map((a) => a.chatChannel).filter((c): c is string => !!c),
    appCfg.collabChannel,
  ];

  console.log('📂 히스토리 + 채널 컨텍스트 로드 중...');
  await Promise.allSettled(
    historyChannels.map(async (channelId) => {
      try {
        const channel = await primaryClient.channels.fetch(channelId) as TextChannel;
        await loadFromDiscord(channel, getLimit(channelId));
        await loadChannelContext(channel);
      } catch (err: unknown) {
        console.warn(
          `⚠️  채널 로드 실패 (${channelId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  // [7] 미완료 태스크 그래프 재개 (봇 재시작 복구)
  const incompleteGraphs = loadIncompleteGraphs();
  if (incompleteGraphs.length > 0) {
    console.log(`🔄 미완료 태스크 그래프 ${incompleteGraphs.length}개 재개 중...`);
    for (const graphData of incompleteGraphs) {
      const agent = agents.find((a) => a.id === graphData.agentId);
      if (!agent) {
        console.warn(`⚠️  그래프 재개 실패 (${graphData.id}): 에이전트 '${graphData.agentId}' 없음`);
        continue;
      }
      try {
        const channel = await primaryClient.channels.fetch(graphData.channelId) as TextChannel;
        const graph = new TaskGraph(graphData);
        agent.resumeTaskGraph(graph, channel).catch((err: unknown) => {
          console.error(`그래프 재개 오류 (${graphData.id}):`, err instanceof Error ? err.message : err);
        });
      } catch (err: unknown) {
        console.warn(`⚠️  그래프 재개 실패 (${graphData.id}):`, err instanceof Error ? err.message : err);
      }
    }
  }

  // [8] 라우터 생성 후 messageCreate 이벤트 바인딩
  const router = createRouter(agents, appCfg, primaryClient);

  for (const client of clients) {
    client.on(Events.MessageCreate, (message) => {
      router(message, client).catch((err: unknown) => {
        console.error('라우터 오류:', err instanceof Error ? err.message : err);
      });
    });
  }

  // 채널 컨텍스트 갱신 이벤트 (primaryClient 하나만 리스닝)
  primaryClient.on(Events.ChannelUpdate, (_old, newChannel) => {
    if (newChannel instanceof BaseGuildTextChannel) {
      updateTopic(newChannel.id, newChannel.topic ?? '');
    }
  });

  primaryClient.on(Events.ChannelPinsUpdate, (channel) => {
    if (channel instanceof BaseGuildTextChannel) {
      // 채널 핀 갱신 + 이 채널이 역할 채널로 캐시된 경우 무효화
      invalidateRoleCache(channel.id);
      refreshPins(channel as TextChannel).catch(() => {});
    }
  });

  primaryClient.on(Events.MessageUpdate, (_old, newMsg) => {
    if (newMsg.pinned && newMsg.channel instanceof BaseGuildTextChannel) {
      refreshPins(newMsg.channel as TextChannel).catch(() => {});
    }
  });

  // [ROLE_UPDATE_PROPOSAL] 반응 핸들러 (✅ = 승인, ❌ = 거부)
  const handleProposalReaction = async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> => {
    if (user.bot) return;

    // partial 해소
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    const msg = reaction.message;
    const emoji = reaction.emoji.name;

    // 제안 메시지 여부 확인
    if (!msg.content?.trimStart().startsWith(ROLE_UPDATE_PROPOSAL_SENTINEL)) return;

    // proposalId 파싱 (메시지에서 "proposalId: <id>" 추출)
    const proposalIdMatch = msg.content.match(/proposalId:\s*(\S+)/);
    if (!proposalIdMatch) {
      // proposalId 없으면 메시지 ID로 검색
      const proposal = findProposalByMessageId(msg.id);
      if (!proposal) return;
      await applyOrRejectProposal(emoji, proposal, msg.channel as TextChannel, appCfg, clients, agents);
      return;
    }

    const proposal = findProposalByMessageId(msg.id) ??
      // proposalId로 직접 로드 (메시지 ID 매칭 실패 시 폴백)
      (await import('./roleProposals')).loadProposal(proposalIdMatch[1]);

    if (!proposal) {
      console.warn(`[proposal] 메시지(${msg.id})에 해당하는 제안 없음`);
      return;
    }

    await applyOrRejectProposal(emoji, proposal, msg.channel as TextChannel, appCfg, clients, agents);
  };

  primaryClient.on(Events.MessageReactionAdd, (reaction, user) => {
    handleProposalReaction(reaction, user).catch((err: unknown) => {
      console.error('반응 핸들러 오류:', err instanceof Error ? err.message : err);
    });
  });

  // [8] interactionCreate — CmdBot 전담 처리 (AI 봇은 커맨드 처리 안 함)
  if (cmdClient) {
    cmdClient.on(Events.InteractionCreate, async (interaction) => {
      // Select Menu 처리
      if (interaction.isStringSelectMenu()) {
        for (const cmd of slashCommands.values()) {
          if (!cmd.handleSelectMenu) continue;
          try {
            const handled = await cmd.handleSelectMenu(interaction as StringSelectMenuInteraction);
            if (handled) return;
          } catch (err: unknown) {
            console.error('Select Menu 오류:', err instanceof Error ? err.message : err);
          }
        }
        return;
      }

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
  } else {
    console.log('ℹ️  cmdBot 미설정 — 슬래시 커맨드 비활성화');
  }

  const shutdown = async () => {
    console.log('\n종료 중...');
    await Promise.all(agents.map((a) => a.mcpManager.close()));
    for (const client of clients) client.destroy();
    cmdClient?.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 관리 웹 서버 시작
  startAdminServer(agents, appCfg, [...clients, ...(cmdClient ? [cmdClient] : [])]);

  console.log('🚀 discord-ai-team 시작 완료');
}

main().catch((err) => {
  console.error('시작 오류:', err instanceof Error ? err.message : err);
  process.exit(1);
});
