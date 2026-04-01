/**
 * deploy-commands.js — Discord 슬래시 커맨드 등록 스크립트
 *
 * 커맨드는 CmdBot 단독으로 등록합니다.
 * config.json의 cmdBot.discordToken을 사용합니다.
 *
 * 사용법:
 *   node deploy-commands.js                  # 글로벌 등록 (최대 1시간 반영)
 *   node deploy-commands.js --guild GUILD_ID # 특정 서버 즉시 반영
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

if (!config.cmdBot?.discordToken) {
  console.error('❌ config.json에 cmdBot.discordToken이 없습니다.');
  console.error('   data/config.json에 아래 항목을 추가하세요:');
  console.error('   "cmdBot": { "discordToken": "봇토큰" }');
  process.exit(1);
}

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

async function deploy() {
  const rest = new REST().setToken(config.cmdBot.discordToken);

  // 토큰에서 applicationId 자동 획득
  const app = await rest.get(Routes.oauth2CurrentApplication());
  const clientId = app.id;

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });

  const scope = guildId ? `서버(${guildId})` : '글로벌';
  console.log(`✅ CmdBot (${clientId}): ${commands.length}개 커맨드 ${scope} 등록 완료`);
}

deploy().catch((err) => {
  console.error('❌ 등록 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
