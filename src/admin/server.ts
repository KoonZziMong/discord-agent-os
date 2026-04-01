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
import type { Client } from 'discord.js';
import type { Agent } from '../agent';
import type { AppConfig } from '../config';
import { createDiscordRouter } from './routes/discord';
import { createConfigRouter } from './routes/config';

export function startAdminServer(
  agents: Agent[],
  appCfg: AppConfig,
  clients: Client[],
): void {
  const app = express();
  const port = appCfg.adminPort ?? 3000;
  const host = (appCfg as AppConfig & { adminHost?: string }).adminHost ?? '127.0.0.1';
  const guildId = (appCfg as AppConfig & { guildId?: string }).guildId ?? '';

  app.use(express.json());

  // 정적 파일 (public/)
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // API 라우트
  app.use('/api/discord', createDiscordRouter(clients, guildId));
  app.use('/api/config', createConfigRouter(agents, appCfg));

  // 상태 확인
  app.get('/api/status', (_req, res) => {
    res.json({
      uptime: process.uptime(),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        online: !!a.botUserId,
      })),
      guildId,
    });
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.listen(port, host, () => {
    console.log(`🌐 관리 페이지: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
