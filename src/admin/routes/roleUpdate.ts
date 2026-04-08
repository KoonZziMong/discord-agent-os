/**
 * admin/routes/roleUpdate.ts — 역할 핀 업데이트 REST 엔드포인트
 *
 * POST /api/role-update
 *   역할 채널의 핀 메시지를 새 내용으로 교체합니다.
 *   AI 봇은 Manage Messages 권한이 없으므로 CmdBot(clients 중 AI 봇이 아닌 것)이
 *   이 엔드포인트를 통해 실제 Discord 핀 수정을 대행합니다.
 *
 * Body: { roleChannelId, proposalId, newContent }
 *   - roleChannelId : 역할 채널 ID (핀을 수정할 채널)
 *   - proposalId    : [ROLE_UPDATE_PROPOSAL] 메시지에 포함된 제안 ID (로깅용)
 *   - newContent    : 새 핀 메시지 전체 내용
 *
 * 처리 흐름:
 *   1. 역할 채널 기존 핀 전부 해제
 *   2. 새 내용으로 메시지 전송
 *   3. 새 메시지 핀 고정
 *   4. roleContext 캐시 무효화 (다음 응답부터 새 역할 내용 반영)
 */

import { Router } from 'express';
import type { Client, TextChannel } from 'discord.js';
import type { Agent } from '../../agent';
import { refreshPins } from '../../channelContext';

export function createRoleUpdateRouter(agents: Agent[], clients: Client[]): Router {
  const router = Router();

  // CmdBot 클라이언트 = AI 봇이 아닌 클라이언트
  const cmdClient = clients.find((c) => !agents.some((a) => a.botClient === c));

  router.post('/', async (req, res) => {
    const { roleChannelId, proposalId, newContent } = req.body as {
      roleChannelId?: string;
      proposalId?: string;
      newContent?: string;
    };

    if (!roleChannelId || !newContent) {
      res.status(400).json({ error: 'roleChannelId, newContent 필수' });
      return;
    }

    if (!cmdClient) {
      res.status(503).json({ error: 'CmdBot 클라이언트 없음 — 역할 핀 수정 불가' });
      return;
    }

    console.log(`[roleUpdate] proposalId=${proposalId ?? 'N/A'} | 채널: ${roleChannelId}`);

    try {
      const channel = await cmdClient.channels.fetch(roleChannelId) as TextChannel;
      if (!channel || !('messages' in channel)) {
        res.status(404).json({ error: '채널을 찾을 수 없거나 텍스트 채널이 아님' });
        return;
      }

      // 기존 핀 전부 해제
      const existingPins = await channel.messages.fetchPinned();
      for (const msg of existingPins.values()) {
        await msg.unpin().catch(() => {});
      }
      console.log(`[roleUpdate] 기존 핀 ${existingPins.size}개 해제`);

      // 새 내용 전송 + 핀 고정
      const newMsg = await channel.send(newContent);
      await newMsg.pin();
      console.log(`[roleUpdate] 새 핀 등록 완료 (msgId: ${newMsg.id})`);

      // channelContext 핀 캐시 갱신 → 다음 LLM 호출 시 새 내용 반영
      await refreshPins(channel).catch(() => {});

      res.json({
        ok: true,
        channelId: roleChannelId,
        messageId: newMsg.id,
        proposalId: proposalId ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[roleUpdate] 오류:', msg);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
