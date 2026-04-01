/**
 * /github 슬래시 커맨드 — GitHub 레포 관리
 *
 * 서브커맨드:
 *   /github add repo:owner/repo   — 글로벌 레포 목록에 추가
 *   /github set                   — 현재 채널 기본 레포를 드롭다운으로 선택
 *   /github list                  — 등록된 전체 레포 목록 확인
 *   /github remove repo:owner/repo — 글로벌 목록에서 삭제
 *
 * Select Menu 응답은 handleSelectMenu()로 처리 (index.ts의 interactionCreate에서 호출).
 */

const {
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** Select Menu customId 접두사 */
const SELECT_ID_PREFIX = 'github_set_';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('github')
    .setDescription('GitHub 레포 관리')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('레포를 글로벌 목록에 등록합니다')
        .addStringOption((opt) =>
          opt.setName('repo').setDescription('owner/repo 형식 (예: KoonZziMong/my-project)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('set').setDescription('현재 채널의 기본 레포를 목록에서 선택합니다'),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('등록된 전체 레포 목록을 확인합니다'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('글로벌 목록에서 레포를 삭제합니다')
        .addStringOption((opt) =>
          opt.setName('repo').setDescription('삭제할 owner/repo').setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '이 커맨드는 관리자만 사용할 수 있습니다.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const cfg = readConfig();
    if (!Array.isArray(cfg.githubRepos)) cfg.githubRepos = [];

    // ── add ─────────────────────────────────────────────────
    if (sub === 'add') {
      const repo = interaction.options.getString('repo').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return interaction.reply({
          content: '❌ 형식이 올바르지 않습니다. `owner/repo` 형식으로 입력해주세요.',
          ephemeral: true,
        });
      }
      if (cfg.githubRepos.includes(repo)) {
        return interaction.reply({ content: `⚠️ \`${repo}\`는 이미 등록되어 있습니다.`, ephemeral: true });
      }
      cfg.githubRepos.push(repo);
      writeConfig(cfg);
      return interaction.reply({ content: `✅ \`${repo}\` 등록 완료`, ephemeral: true });
    }

    // ── list ─────────────────────────────────────────────────
    if (sub === 'list') {
      if (cfg.githubRepos.length === 0) {
        return interaction.reply({
          content: '등록된 레포가 없습니다. `/github add`로 추가하세요.',
          ephemeral: true,
        });
      }
      // 각 에이전트의 기본 레포 표시
      const agentMap = {};
      for (const a of cfg.agents) {
        if (a.githubRepo) agentMap[a.githubRepo] = (agentMap[a.githubRepo] ?? []).concat(a.name);
      }
      const lines = cfg.githubRepos.map((r) => {
        const agents = agentMap[r] ? ` ← ${agentMap[r].join(', ')}` : '';
        return `\`${r}\`${agents}`;
      });
      return interaction.reply({
        content: `**등록된 GitHub 레포 (${cfg.githubRepos.length}개)**\n${lines.join('\n')}`,
        ephemeral: true,
      });
    }

    // ── remove ───────────────────────────────────────────────
    if (sub === 'remove') {
      const repo = interaction.options.getString('repo').trim();
      const idx = cfg.githubRepos.indexOf(repo);
      if (idx === -1) {
        return interaction.reply({ content: `❌ \`${repo}\`는 등록되지 않은 레포입니다.`, ephemeral: true });
      }
      cfg.githubRepos.splice(idx, 1);
      writeConfig(cfg);
      return interaction.reply({ content: `🗑️ \`${repo}\` 삭제 완료`, ephemeral: true });
    }

    // ── set ──────────────────────────────────────────────────
    if (sub === 'set') {
      if (cfg.githubRepos.length === 0) {
        return interaction.reply({
          content: '등록된 레포가 없습니다. 먼저 `/github add`로 추가하세요.',
          ephemeral: true,
        });
      }

      const agent = cfg.agents.find((a) => a.chatChannel === interaction.channelId);
      if (!agent) {
        return interaction.reply({
          content: '❌ 현재 채널은 에이전트 대화 채널이 아닙니다.',
          ephemeral: true,
        });
      }

      const options = cfg.githubRepos.map((r) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(r)
          .setValue(r)
          .setDefault(r === agent.githubRepo),
      );

      const select = new StringSelectMenuBuilder()
        .setCustomId(`${SELECT_ID_PREFIX}${agent.id}`)
        .setPlaceholder(agent.githubRepo ? `현재: ${agent.githubRepo}` : '레포를 선택하세요')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);

      return interaction.reply({
        content: `**${agent.name}** 채널의 기본 레포를 선택하세요:`,
        components: [row],
        ephemeral: true,
      });
    }
  },

  /**
   * Select Menu 응답 처리
   * index.ts의 interactionCreate 핸들러에서 호출됩니다.
   * @returns {boolean} 이 커맨드가 처리했으면 true
   */
  async handleSelectMenu(interaction) {
    if (!interaction.customId.startsWith(SELECT_ID_PREFIX)) return false;

    const agentId = interaction.customId.slice(SELECT_ID_PREFIX.length);
    const repo = interaction.values[0];
    const cfg = readConfig();
    const agent = cfg.agents.find((a) => a.id === agentId);

    if (!agent) {
      await interaction.update({ content: '❌ 에이전트를 찾을 수 없습니다.', components: [] });
      return true;
    }

    agent.githubRepo = repo;
    writeConfig(cfg);
    await interaction.update({
      content: `✅ **${agent.name}** 기본 레포 → \`${repo}\`\n봇 재시작 없이 다음 \`!목표\`부터 적용됩니다.`,
      components: [],
    });
    return true;
  },
};
