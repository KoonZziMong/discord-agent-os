/**
 * admin/routes/discord.ts — Discord 서버 정보 조회 API
 *
 * 이미 로그인된 Discord 클라이언트를 통해 길드 정보를 가져옵니다.
 * 외부 API 호출 없이 인메모리 클라이언트를 직접 사용합니다.
 *
 * GET /api/discord/guild          — 길드 기본 정보
 * GET /api/discord/channels       — 카테고리별 채널 목록
 * GET /api/discord/bots           — 서버 내 봇 멤버 목록
 */

import { Router } from 'express';
import type { Client, Guild, GuildChannel } from 'discord.js';
import { ChannelType } from 'discord.js';

export function createDiscordRouter(clients: Client[], guildId: string) {
  const router = Router();

  /** 첫 번째로 길드를 찾을 수 있는 클라이언트 반환 */
  async function getGuild(): Promise<Guild | null> {
    for (const client of clients) {
      try {
        const guild = await client.guilds.fetch(guildId);
        if (guild) return guild;
      } catch {
        // 다음 클라이언트 시도
      }
    }
    return null;
  }

  // 길드 기본 정보
  router.get('/guild', async (_req, res) => {
    try {
      const guild = await getGuild();
      if (!guild) {
        res.status(404).json({ error: '길드를 찾을 수 없습니다. 봇이 서버에 초대되어 있는지 확인하세요.' });
        return;
      }
      res.json({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        memberCount: guild.memberCount,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 카테고리별 채널 목록
  router.get('/channels', async (_req, res) => {
    try {
      const guild = await getGuild();
      if (!guild) {
        res.status(404).json({ error: '길드를 찾을 수 없습니다.' });
        return;
      }

      const channels = await guild.channels.fetch();

      // 카테고리 수집
      const categories: Record<string, { id: string; name: string; position: number; channels: object[] }> = {};
      const uncategorized: object[] = [];

      // 카테고리 먼저 등록
      channels.forEach((ch) => {
        if (!ch) return;
        if (ch.type === ChannelType.GuildCategory) {
          categories[ch.id] = {
            id: ch.id,
            name: ch.name,
            position: ch.position,
            channels: [],
          };
        }
      });

      // 텍스트 채널을 카테고리에 분류
      channels.forEach((ch) => {
        if (!ch) return;
        if (ch.type !== ChannelType.GuildText) return;
        const textCh = ch as GuildChannel;
        const entry = {
          id: textCh.id,
          name: textCh.name,
          position: textCh.position,
        };
        const parentId = 'parentId' in textCh ? (textCh.parentId as string | null) : null;
        if (parentId && categories[parentId]) {
          categories[parentId].channels.push(entry);
        } else {
          uncategorized.push(entry);
        }
      });

      // 카테고리 내 채널 position 정렬
      const sorted = Object.values(categories)
        .sort((a, b) => a.position - b.position)
        .map((cat) => ({
          ...cat,
          channels: (cat.channels as { position: number }[]).sort((a, b) => a.position - b.position),
        }));

      res.json({
        categories: sorted,
        uncategorized: (uncategorized as { position: number }[]).sort((a, b) => a.position - b.position),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 서버 내 봇 멤버 목록
  router.get('/bots', async (_req, res) => {
    try {
      const guild = await getGuild();
      if (!guild) {
        res.status(404).json({ error: '길드를 찾을 수 없습니다.' });
        return;
      }

      const members = await guild.members.fetch();
      const bots = members
        .filter((m) => m.user.bot)
        .map((m) => ({
          id: m.user.id,
          username: m.user.username,
          displayName: m.displayName,
          avatar: m.user.displayAvatarURL(),
          online: m.presence?.status !== 'offline',
        }));

      res.json({ bots });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
