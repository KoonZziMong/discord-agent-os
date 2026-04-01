/**
 * /task 슬래시 커맨드 — Task Graph 관리
 *
 * 서브커맨드:
 *   /task list              — 최근 태스크 그래프 목록
 *   /task detail            — 드롭다운으로 그래프 선택 후 상세 보기
 *   /task cancel id:graphId — 실행 중인 그래프 취소
 *   /task retry  id:graphId — 실패한 그래프 재시도 (봇 재시작 후 자동 재개)
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '..', 'data', 'tasks');
const DETAIL_SELECT_PREFIX = 'task_detail_';

function loadAllGraphs() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function loadGraph(id) {
  const graphs = loadAllGraphs();
  return graphs.find((g) => g.id === id || g.id.startsWith(id)) ?? null;
}

function statusEmoji(status) {
  return { running: '⚙️', completed: '✅', failed: '❌' }[status] ?? '❓';
}

function formatElapsed(createdAt, completedAt) {
  const ms = (completedAt ?? Date.now()) - createdAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

function buildDetailEmbed(graph) {
  const done = graph.tasks.filter((t) => t.status === 'completed').length;
  const total = graph.tasks.length;
  const elapsed = formatElapsed(graph.createdAt, graph.completedAt);

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(graph.status)} ${graph.goal.slice(0, 80)}`)
    .setColor(graph.status === 'completed' ? 0x57f287 : graph.status === 'running' ? 0x5865f2 : 0xed4245)
    .setDescription([
      `**ID** \`${graph.id.slice(0, 8)}...\``,
      `**에이전트** ${graph.agentId}`,
      `**진행** ${done}/${total} · **경과** ${elapsed}`,
    ].join('  |  '))
    .setTimestamp(graph.createdAt);

  for (const task of graph.tasks) {
    const result = task.result ? task.result.slice(0, 100) + (task.result.length > 100 ? '…' : '') : null;
    const error = task.error ? `오류: ${task.error.slice(0, 80)}` : null;
    embed.addFields({
      name: `${statusEmoji(task.status)} [${task.id}] ${task.title}`,
      value: result ?? error ?? '(결과 없음)',
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('task')
    .setDescription('Task Graph 관리')
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('최근 태스크 그래프 목록을 표시합니다'),
    )
    .addSubcommand((sub) =>
      sub.setName('detail').setDescription('태스크 그래프를 선택하여 상세 내용을 확인합니다'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('실행 중인 태스크 그래프를 취소합니다')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('그래프 ID (/task list에서 확인)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('retry')
        .setDescription('실패한 태스크 그래프를 재시도합니다 (봇 재시작 후 자동 재개)')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('그래프 ID (/task list에서 확인)').setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    // ── list ─────────────────────────────────────────────────
    if (sub === 'list') {
      const graphs = loadAllGraphs().slice(0, 10);

      if (graphs.length === 0) {
        return interaction.reply({ content: '저장된 태스크 그래프가 없습니다.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 태스크 그래프 목록')
        .setColor(0x5865f2)
        .setFooter({ text: '상세 보기: /task detail' })
        .setTimestamp();

      for (const g of graphs) {
        const done = g.tasks.filter((t) => t.status === 'completed').length;
        const total = g.tasks.length;
        embed.addFields({
          name: `${statusEmoji(g.status)} ${g.goal.slice(0, 50)}`,
          value: `\`${g.id.slice(0, 8)}...\` · ${g.agentId} · ${done}/${total}개 · ${formatElapsed(g.createdAt, g.completedAt)}`,
        });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── detail ───────────────────────────────────────────────
    if (sub === 'detail') {
      const graphs = loadAllGraphs().slice(0, 25); // Select Menu 최대 25개

      if (graphs.length === 0) {
        return interaction.reply({ content: '저장된 태스크 그래프가 없습니다.', ephemeral: true });
      }

      const options = graphs.map((g) => {
        const done = g.tasks.filter((t) => t.status === 'completed').length;
        return new StringSelectMenuOptionBuilder()
          .setLabel(g.goal.slice(0, 100))
          .setDescription(`${statusEmoji(g.status)} ${g.id.slice(0, 8)}... · ${done}/${g.tasks.length}개 · ${formatElapsed(g.createdAt, g.completedAt)}`)
          .setValue(g.id);
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId(DETAIL_SELECT_PREFIX + 'select')
        .setPlaceholder('그래프를 선택하세요')
        .addOptions(options);

      return interaction.reply({
        content: '상세 내용을 확인할 태스크 그래프를 선택하세요:',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── cancel ───────────────────────────────────────────────
    if (sub === 'cancel') {
      const id = interaction.options.getString('id').trim();
      const graph = loadGraph(id);

      if (!graph) {
        return interaction.reply({ content: `❌ 그래프를 찾을 수 없습니다: \`${id}\``, ephemeral: true });
      }
      if (graph.status !== 'running') {
        return interaction.reply({
          content: `⚠️ 이미 ${graph.status === 'completed' ? '완료된' : '실패/취소된'} 그래프입니다.`,
          ephemeral: true,
        });
      }

      for (const task of graph.tasks) {
        if (task.status === 'pending' || task.status === 'running') {
          task.status = 'failed';
          task.error = '취소됨';
          task.updatedAt = Date.now();
        }
      }
      graph.status = 'failed';
      fs.writeFileSync(path.join(TASKS_DIR, `${graph.id}.json`), JSON.stringify(graph, null, 2));

      return interaction.reply({
        content: `🛑 \`${graph.id.slice(0, 8)}...\` 취소 완료\n> ${graph.goal.slice(0, 80)}`,
        ephemeral: true,
      });
    }

    // ── retry ───────────────────────────────────────────────
    if (sub === 'retry') {
      const id = interaction.options.getString('id').trim();
      const graph = loadGraph(id);

      if (!graph) {
        return interaction.reply({ content: `❌ 그래프를 찾을 수 없습니다: \`${id}\``, ephemeral: true });
      }
      if (graph.status !== 'failed') {
        return interaction.reply({
          content: `⚠️ 실패 상태가 아닌 그래프입니다. (현재: ${graph.status})`,
          ephemeral: true,
        });
      }

      // 실패한 태스크를 pending으로 초기화
      for (const task of graph.tasks) {
        if (task.status === 'failed') {
          task.status = 'pending';
          delete task.error;
          task.updatedAt = Date.now();
        }
      }
      graph.status = 'running';
      fs.writeFileSync(path.join(TASKS_DIR, `${graph.id}.json`), JSON.stringify(graph, null, 2));

      return interaction.reply({
        content: [
          `🔄 \`${graph.id.slice(0, 8)}...\` 재시도 준비 완료`,
          `> ${graph.goal.slice(0, 80)}`,
          `-# 봇을 재시작하면 자동으로 이어서 실행됩니다.`,
        ].join('\n'),
        ephemeral: true,
      });
    }
  },

  // Select Menu 응답 처리
  async handleSelectMenu(interaction) {
    if (!interaction.customId.startsWith(DETAIL_SELECT_PREFIX)) return false;

    const graphId = interaction.values[0];
    const graph = loadGraph(graphId);

    if (!graph) {
      await interaction.update({ content: '❌ 그래프를 찾을 수 없습니다.', components: [] });
      return true;
    }

    await interaction.update({
      content: '',
      embeds: [buildDetailEmbed(graph)],
      components: [],
    });
    return true;
  },
};
