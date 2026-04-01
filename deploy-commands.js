/**
 * deploy-commands.js — Discord 슬래시 커맨드 등록 스크립트
 *
 * 사용법:
 *   node deploy-commands.js                     # 전체 봇, 글로벌 등록
 *   node deploy-commands.js --guild GUILD_ID    # 특정 서버에만 등록 (즉시 반영)
 *   node deploy-commands.js --agent zzimong     # 특정 봇만 등록
 */

const { REST, Routes } = require('discord.js');
const path = require('path');
const fs = require('fs');

// 설정 로드
const configPath = path.join(__dirname, 'data', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('❌ data/config.json 없음');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// commands/ 폴더에서 커맨드 자동 스캔
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) {
  console.error('❌ commands/ 폴더 없음');
  process.exit(1);
}

const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));
const commands = commandFiles.map((file) => {
  const cmd = require(path.join(commandsPath, file));
  return cmd.data.toJSON();
});

console.log(`📦 등록할 커맨드 (${commands.length}개): ${commands.map((c) => `/${c.name}`).join(', ')}`);

// CLI 인자 파싱
const args = process.argv.slice(2);
const guildIdx = args.indexOf('--guild');
const guildId = guildIdx !== -1 ? args[guildIdx + 1] : null;
const agentIdx = args.indexOf('--agent');
const agentFilter = agentIdx !== -1 ? args[agentIdx + 1] : null;

const targetAgents = agentFilter
  ? config.agents.filter((a) => a.id === agentFilter)
  : config.agents;

if (targetAgents.length === 0) {
  console.error(`❌ 에이전트를 찾을 수 없음: ${agentFilter}`);
  process.exit(1);
}

async function deploy() {
  for (const agent of targetAgents) {
    const rest = new REST().setToken(agent.discordToken);

    // 토큰에서 applicationId 자동 획득
    const app = await rest.get(Routes.oauth2CurrentApplication());
    const clientId = app.id;

    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);

    await rest.put(route, { body: commands });

    const scope = guildId ? `서버(${guildId})` : '글로벌';
    console.log(`✅ ${agent.name} (${clientId}): ${commands.length}개 커맨드 ${scope} 등록 완료`);
  }
}

deploy().catch((err) => {
  console.error('❌ 등록 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
