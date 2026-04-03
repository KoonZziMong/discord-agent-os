/**
 * admin/server.ts — 관리 웹 서버
 *
 * Discord 봇과 같은 프로세스에서 실행되는 Express 서버입니다.
 * public/admin.html을 제공하고 /api/* 엔드포인트로 설정을 관리합니다.
 *
 * 기본 바인딩: 127.0.0.1 (로컬 전용)
 * config.adminHost로 "0.0.0.0" 등 외부 노출 가능
 */

import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import type { Client } from 'discord.js';
import type { Agent } from '../agent';
import type { AppConfig } from '../config';
import { createDiscordRouter } from './routes/discord';
import { createConfigRouter } from './routes/config';
import { createRoleUpdateRouter } from './routes/roleUpdate';

export function startAdminServer(
  agents: Agent[],
  appCfg: AppConfig,
  clients: Client[],
): void {
  const app = express();
  const port = appCfg.adminPort ?? 3000;
  const host = appCfg.adminHost ?? '127.0.0.1';

  app.use(express.json());

  // 정적 파일 (public/)
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // API 라우트 — appCfg를 참조로 넘기므로 guildId 변경 시 즉시 반영
  app.use('/api/discord', createDiscordRouter(clients, appCfg));
  app.use('/api/config', createConfigRouter(agents, appCfg));
  app.use('/api/role-update', createRoleUpdateRouter(agents, clients));

  // 슬래시 커맨드 목록 (commands/*.js 파싱)
  app.get('/api/commands', (_req, res) => {
    const commandsDir = path.join(__dirname, '..', '..', 'commands');
    if (!fs.existsSync(commandsDir)) {
      res.json({ commands: [] });
      return;
    }
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
    const commands = files.flatMap((file) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cmd = require(path.join(commandsDir, file));
        const data = cmd.data?.toJSON ? cmd.data.toJSON() : cmd.data;
        if (!data) return [];
        return [{
          name: data.name ?? file.replace('.js', ''),
          description: data.description ?? '',
          subcommands: (data.options ?? [])
            .filter((o: { type: number }) => o.type === 1)
            .map((o: { name: string; description: string }) => ({
              name: o.name,
              description: o.description,
            })),
        }];
      } catch {
        return [];
      }
    });
    res.json({ commands });
  });

  // 상태 확인
  app.get('/api/status', (_req, res) => {
    // AI 봇 클라이언트에 속하지 않는 클라이언트(=CmdBot)를 찾아 user ID 포함
    const cmdClient = clients.find((c) => !agents.some((a) => a.botClient === c));
    const configuredBotIds = [
      ...agents.map((a) => a.id),
      ...(cmdClient?.user?.id ? [cmdClient.user.id] : []),
    ];

    res.json({
      uptime: process.uptime(),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        online: !!a.botClient.user,
      })),
      guildId: appCfg.guildId ?? '',
      configuredBotIds,
    });
  });

  // SPA fallback (Express 5: * → /{*path})
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.listen(port, host, () => {
    console.log(`🌐 관리 페이지: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
