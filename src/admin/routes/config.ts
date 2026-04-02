/**
 * admin/routes/config.ts — 설정 조회 및 저장 API
 *
 * GET  /api/config          전체 설정 반환 (토큰은 마스킹)
 * PUT  /api/config          전체 설정 저장 + 가능한 항목 즉시 반영
 * GET  /api/config/raw      토큰 포함 원본 반환 (패널에서 편집 시 사용)
 * PUT  /api/config/system   시스템 설정만 갱신 (collabChannel, historyLimit 등)
 * PUT  /api/agents/:id      단일 에이전트 설정 갱신 + 즉시 반영
 */

import { Router } from 'express';
import type { Agent } from '../../agent';
import type { AppConfig, AgentConfig } from '../../config';
import { saveConfig } from '../../config';
import { hotReloadAgent, hotReloadAppConfig } from '../hotreload';
import * as fs from 'fs';
import * as path from 'path';

function maskToken(val: string): string {
  if (!val || val.length < 8) return '••••••••';
  return val.slice(0, 4) + '•'.repeat(Math.min(val.length - 8, 20)) + val.slice(-4);
}

function maskAgentConfig(a: AgentConfig): object {
  return {
    ...a,
    discordToken: maskToken(a.discordToken),
    apiKey: maskToken(a.apiKey),
    mcpTokens: Object.fromEntries(
      Object.entries(a.mcpTokens ?? {}).map(([k, v]) => [k, maskToken(v)]),
    ),
  };
}

export function createConfigRouter(agents: Agent[], appCfg: AppConfig) {
  const router = Router();

  // 전체 설정 (마스킹)
  router.get('/', (_req, res) => {
    res.json({
      ...appCfg,
      cmdBot: appCfg.cmdBot
        ? {
            ...appCfg.cmdBot,
            discordToken: maskToken(appCfg.cmdBot.discordToken),
            apiKey: appCfg.cmdBot.apiKey ? maskToken(appCfg.cmdBot.apiKey) : '',
          }
        : undefined,
      agents: appCfg.agents.map(maskAgentConfig),
    });
  });

  // 토큰 포함 원본 (편집 패널용)
  router.get('/raw', (_req, res) => {
    res.json(appCfg);
  });

  // 전체 설정 저장
  router.put('/', (req, res) => {
    try {
      const next = req.body as AppConfig;

      // 기존 마스킹된 값은 원본으로 복원 (••• 패턴이면 기존 값 유지)
      const restore = (next: string, orig: string) =>
        next.includes('•') ? orig : next;

      next.agents = next.agents.map((a) => {
        const orig = appCfg.agents.find((o) => o.id === a.id);
        if (!orig) return a;
        return {
          ...a,
          discordToken: restore(a.discordToken, orig.discordToken),
          apiKey: restore(a.apiKey, orig.apiKey),
          mcpTokens: Object.fromEntries(
            Object.entries(a.mcpTokens ?? {}).map(([k, v]) => [
              k,
              restore(v, orig.mcpTokens?.[k] ?? v),
            ]),
          ),
        };
      });

      if (next.cmdBot && appCfg.cmdBot) {
        next.cmdBot.discordToken = restore(
          next.cmdBot.discordToken ?? '',
          appCfg.cmdBot.discordToken,
        );
        if (next.cmdBot.apiKey !== undefined) {
          next.cmdBot.apiKey = restore(next.cmdBot.apiKey, appCfg.cmdBot.apiKey ?? '');
        }
      }

      // 신규 에이전트 페르소나 파일 자동 생성 (없는 경우에만)
      for (const agentNext of next.agents) {
        const isNew = !appCfg.agents.find((a) => a.id === agentNext.id);
        if (isNew && agentNext.personaFile) {
          const dir = path.dirname(agentNext.personaFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (!fs.existsSync(agentNext.personaFile)) {
            fs.writeFileSync(
              agentNext.personaFile,
              `# ${agentNext.name} 페르소나\n\n당신은 ${agentNext.name}입니다.\n`,
              'utf-8',
            );
            console.log(`[Admin] 페르소나 파일 생성: ${agentNext.personaFile}`);
          }
        }
      }

      // 즉시 반영 가능한 항목 적용
      hotReloadAppConfig(appCfg, next);
      for (const agentNext of next.agents) {
        const agent = agents.find((a) => a.id === agentNext.id);
        if (agent) hotReloadAgent(agent, agentNext);
      }

      // appCfg 전체 갱신
      Object.assign(appCfg, next);

      // 파일 저장
      saveConfig(appCfg);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 시스템 설정만 갱신
  router.put('/system', (req, res) => {
    try {
      const patch = req.body as Partial<AppConfig>;
      hotReloadAppConfig(appCfg, patch);
      Object.assign(appCfg, patch);
      saveConfig(appCfg);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 단일 에이전트 설정 갱신
  router.put('/agents/:id', (req, res) => {
    try {
      const agentId = req.params.id;
      const patch = req.body as Partial<AgentConfig>;
      const agent = agents.find((a) => a.id === agentId);
      const origIdx = appCfg.agents.findIndex((a) => a.id === agentId);

      if (!agent || origIdx === -1) {
        res.status(404).json({ error: `에이전트 '${agentId}'를 찾을 수 없습니다.` });
        return;
      }

      // 마스킹 복원
      const orig = appCfg.agents[origIdx];
      if (patch.discordToken?.includes('•')) patch.discordToken = orig.discordToken;
      if (patch.apiKey?.includes('•')) patch.apiKey = orig.apiKey;
      if (patch.mcpTokens) {
        patch.mcpTokens = Object.fromEntries(
          Object.entries(patch.mcpTokens).map(([k, v]) => [
            k,
            v.includes('•') ? (orig.mcpTokens?.[k] ?? v) : v,
          ]),
        );
      }

      const next: AgentConfig = { ...orig, ...patch };
      hotReloadAgent(agent, next);
      appCfg.agents[origIdx] = agent.config;
      saveConfig(appCfg);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 페르소나 조회
  router.get('/agents/:id/persona', (req, res) => {
    const agent = agents.find((a) => a.id === req.params.id);
    if (!agent) { res.status(404).json({ error: '에이전트 없음' }); return; }
    try {
      const content = fs.readFileSync(agent.config.personaFile, 'utf-8');
      res.json({ content });
    } catch {
      res.json({ content: '' });
    }
  });

  // 페르소나 저장 (즉시 반영 — persona.load()가 매번 파일을 읽음)
  router.put('/agents/:id/persona', (req, res) => {
    const agent = agents.find((a) => a.id === req.params.id);
    if (!agent) { res.status(404).json({ error: '에이전트 없음' }); return; }
    try {
      const { content } = req.body as { content: string };
      fs.writeFileSync(agent.config.personaFile, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
