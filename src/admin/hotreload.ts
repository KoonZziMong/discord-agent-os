/**
 * admin/hotreload.ts — 런타임 설정 즉시 반영
 *
 * 즉시 적용: LLM 설정, githubRepo, computerUse, historyLimit, channelLimits, toolBots
 * 재시작 필요: Discord 토큰, 채널 ID, 에이전트 추가/삭제, mcpTokens
 */

import type { Agent } from '../agent';
import type { AppConfig, AgentConfig } from '../config';

export function hotReloadAgent(agent: Agent, next: AgentConfig): void {
  agent.updateConfig(next);
}

export function hotReloadAppConfig(appCfg: AppConfig, next: Partial<AppConfig>): void {
  if (next.historyLimit !== undefined) appCfg.historyLimit = next.historyLimit;
  if (next.channelLimits !== undefined) appCfg.channelLimits = next.channelLimits;
  if (next.toolBots !== undefined) appCfg.toolBots = next.toolBots;
  if (next.githubRepos !== undefined) appCfg.githubRepos = next.githubRepos;
  if (next.guildId !== undefined) appCfg.guildId = next.guildId;
  if (next.collabChannel !== undefined) appCfg.collabChannel = next.collabChannel;
  console.log('[Admin] 앱 설정 즉시 반영 완료');
}
