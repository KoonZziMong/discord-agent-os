/**
 * Step 2: 연동 스모크 테스트
 * Anthropic API + Discord Bot 연결을 최소 코드로 검증합니다.
 * 실행: npm run test:smoke
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// 루트 .env 로드 (AgentWithDiscord/.env)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'DISCORD_TOKEN_ZZIMONG',
  'CHANNEL_CHAT_ZZIMONG',
];

function checkEnv(): void {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ 누락된 환경변수: ${missing.join(', ')}`);
    console.error('   루트 .env 파일을 확인하세요: AgentWithDiscord/.env');
    process.exit(1);
  }
}

async function testAnthropic(): Promise<boolean> {
  console.log('\n[1/2] Anthropic API 연동 테스트...');
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const response = await client.messages.create({
      model: process.env.DEFAULT_MODEL || 'claude-sonnet-4-6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log(`✅ Anthropic API OK — 응답: "${text.slice(0, 60)}"`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Anthropic API 실패: ${msg}`);
    return false;
  }
}

async function testDiscord(): Promise<boolean> {
  console.log('\n[2/2] Discord Bot 연동 테스트...');
  return new Promise((resolve) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    const timeout = setTimeout(() => {
      console.error('❌ Discord 연결 타임아웃 (10초)');
      client.destroy();
      resolve(false);
    }, 10_000);

    client.once('clientReady', async (c) => {
      try {
        const channelId = process.env.TEST_CHANNEL_ID!;
        const channel = await c.channels.fetch(channelId);

        if (!channel || !channel.isTextBased()) {
          console.error(`❌ 채널을 찾을 수 없거나 텍스트 채널이 아님 (ID: ${channelId})`);
          clearTimeout(timeout);
          client.destroy();
          resolve(false);
          return;
        }

        if (!('send' in channel)) {
          console.error('❌ 채널에 메시지 전송 권한 없음');
          clearTimeout(timeout);
          client.destroy();
          resolve(false);
          return;
        }

        await channel.send('🤖 [스모크 테스트] 봇 연결 성공!');
        console.log(`✅ Discord Bot OK — ${c.user.tag} 로그인, 메시지 전송 완료`);
        clearTimeout(timeout);
        client.destroy();
        resolve(true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Discord 메시지 전송 실패: ${msg}`);
        clearTimeout(timeout);
        client.destroy();
        resolve(false);
      }
    });

    client.on('error', (err) => {
      console.error(`❌ Discord 클라이언트 에러: ${err.message}`);
    });

    client.login(process.env.DISCORD_TOKEN_ZZIMONG!).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Discord 로그인 실패: ${msg}`);
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  console.log('=== discord-ai-team 연동 스모크 테스트 ===');
  checkEnv();

  const anthropicOk = await testAnthropic();
  const discordOk = await testDiscord();

  console.log('\n=== 결과 ===');
  console.log(`Anthropic API : ${anthropicOk ? '✅ OK' : '❌ FAIL'}`);
  console.log(`Discord Bot   : ${discordOk ? '✅ OK' : '❌ FAIL'}`);

  if (anthropicOk && discordOk) {
    console.log('\n🎉 모든 연동 테스트 통과! Step 3으로 진행하세요.');
    process.exit(0);
  } else {
    console.log('\n⚠️  일부 테스트 실패. 위 오류를 확인하세요.');
    process.exit(1);
  }
}

main();
