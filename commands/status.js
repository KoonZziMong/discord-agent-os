/**
 * /status 슬래시 커맨드
 *
 * 봇의 현재 운영 상태를 임베드 메시지로 표시합니다.
 * 관리자(Administrator) 권한을 가진 사용자만 실행할 수 있으며,
 * 응답은 ephemeral(본인에게만 보임)로 전송됩니다.
 *
 * @module commands/status
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 *   Discord 슬래시 커맨드 인터랙션 객체
 *
 * @returns {Promise<void>}
 *   반환값 없음. 결과는 다음 중 하나로 응답됩니다:
 *   - 권한 없음: ephemeral 오류 메시지
 *   - 성공: 아래 필드를 포함하는 ephemeral 임베드
 *       • 업타임       — 봇 프로세스 가동 시간 (일/시간/분/초)
 *       • 핑           — WebSocket 레이턴시 (ms)
 *       • 서버 수      — 봇이 참여 중인 길드 수
 *       • 메모리 사용량 — 힙 메모리 사용량 (MB)
 *       • Node.js 버전 — 현재 Node.js 런타임 버전
 *   - 오류: ephemeral 오류 안내 메시지
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// 업타임을 사람이 읽기 좋은 형식으로 변환
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}일`);
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  parts.push(`${s}초`);
  return parts.join(' ');
}

// 메모리를 MB 단위로 변환
function formatMemory(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('봇의 현재 상태 정보를 표시합니다'),

  async execute(interaction) {
    // 관리자 권한 체크
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', ephemeral: true });
    }

    // 응답 지연 방지 (3초 타임아웃)
    await interaction.deferReply({ ephemeral: true });

    try {
      const client = interaction.client;

      const embed = new EmbedBuilder()
        .setTitle('봇 상태')
        .setColor(0x5865f2)
        .addFields(
          {
            name: '업타임',
            value: formatUptime(Math.floor(process.uptime())),
            inline: true,
          },
          {
            name: '핑',
            value: `${client.ws.ping}ms`,
            inline: true,
          },
          {
            name: '서버 수',
            value: `${client.guilds.cache.size}개`,
            inline: true,
          },
          {
            name: '메모리 사용량',
            value: formatMemory(process.memoryUsage().heapUsed),
            inline: true,
          },
          {
            name: 'Node.js 버전',
            value: process.version,
            inline: true,
          },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const msg = '상태 조회 중 오류가 발생했습니다.';
      if (interaction.deferred) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    }
  },
};
