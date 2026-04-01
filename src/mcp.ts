/**
 * mcp.ts — 봇별 MCP(Model Context Protocol) 클라이언트 매니저
 *
 * 각 Agent가 AgentMCPManager 인스턴스를 하나씩 소유합니다.
 * Claude Desktop 설정 파일을 읽어 MCP 서버들을 subprocess로 실행/연결하며,
 * AgentConfig.mcpTokens의 값을 해당 서버 프로세스 환경변수에 주입합니다.
 *
 * 이를 통해 봇마다 서로 다른 계정의 MCP 서비스(Notion, Gmail 등)에
 * 각자의 토큰으로 독립적으로 접근할 수 있습니다.
 *
 * 흐름:
 *   agent.initMCP() 호출
 *     → Claude Desktop config 읽기
 *     → 각 mcpServers 항목을 subprocess로 실행 (mcpTokens 환경변수 주입)
 *     → 툴 목록 수집 → Anthropic.Tool[] 포맷으로 변환
 *
 *   Agent.callAPI() 호출 시
 *     → mcpManager.getAllMcpTools() 로 MCP 툴 목록 주입
 *     → Claude가 tool_use 응답 시 mcpManager.callMcpTool() 로 실행
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── 타입 정의 ──────────────────────────────────────────────

/** Claude Desktop claude_desktop_config.json 의 mcpServers 각 항목 */
interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 연결된 MCP 서버 1개의 상태 */
interface McpConnection {
  client: Client;
  tools: Anthropic.Tool[];
}

// ── AgentMCPManager ────────────────────────────────────────

/**
 * 에이전트 1개가 사용할 MCP 연결 집합을 관리합니다.
 *
 * @param agentId   - 로그 식별용 에이전트 ID
 * @param mcpTokens - 봇별 MCP 서비스 토큰 (환경변수명 → 값)
 *                    예: { "NOTION_TOKEN": "secret_abc...", "GMAIL_TOKEN": "..." }
 *                    Claude Desktop config의 env 위에 덮어씌워집니다.
 */
export class AgentMCPManager {
  private connections = new Map<string, McpConnection>();
  private agentId: string;
  private mcpTokens: Record<string, string>;

  constructor(agentId: string, mcpTokens: Record<string, string>) {
    this.agentId = agentId;
    this.mcpTokens = mcpTokens;
  }

  /**
   * Claude Desktop 설정을 읽어 MCP 서버들을 초기화합니다.
   * 서버 연결 실패 시 경고만 출력하고 계속 진행합니다.
   */
  async init(): Promise<void> {
    const configPath = path.join(
      os.homedir(),
      'Library/Application Support/Claude/claude_desktop_config.json',
    );

    if (!fs.existsSync(configPath)) {
      console.log(`ℹ️  [${this.agentId}] Claude Desktop config 없음 — MCP 없이 실행합니다.`);
      return;
    }

    let parsed: { mcpServers?: Record<string, McpServerConfig> };
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.warn(`⚠️  [${this.agentId}] Claude Desktop config 파싱 실패 — MCP 없이 실행합니다.`);
      return;
    }

    const servers = parsed.mcpServers ?? {};
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      console.log(`ℹ️  [${this.agentId}] MCP 서버 설정 없음.`);
      return;
    }

    await Promise.allSettled(
      entries.map(([name, cfg]) => this.connectServer(name, cfg)),
    );

    const total = [...this.connections.values()].reduce((s, c) => s + c.tools.length, 0);
    console.log(`🔧 [${this.agentId}] MCP 초기화 완료 — ${this.connections.size}개 서버, 총 ${total}개 툴`);
  }

  /** 현재 연결된 모든 MCP 서버의 툴을 Anthropic.Tool[] 형태로 반환합니다. */
  getAllMcpTools(): Anthropic.Tool[] {
    const all: Anthropic.Tool[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.tools);
    }
    return all;
  }

  /** 현재 연결된 MCP 서버 이름 목록을 반환합니다. (슬래시 커맨드 자동완성용) */
  getServerNames(): string[] {
    return [...this.connections.keys()];
  }

  /** 지정한 서버 이름들의 툴만 반환합니다. (슬래시 커맨드 필터링용) */
  getMcpToolsByServices(services: string[]): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [];
    for (const name of services) {
      const conn = this.connections.get(name);
      if (conn) tools.push(...conn.tools);
    }
    return tools;
  }

  /**
   * 특정 MCP 툴을 실행하고 결과를 문자열로 반환합니다.
   */
  async callMcpTool(toolName: string, toolInput: unknown): Promise<string> {
    for (const conn of this.connections.values()) {
      const hasTool = conn.tools.some((t) => t.name === toolName);
      if (!hasTool) continue;

      const result = await conn.client.callTool({
        name: toolName,
        arguments: toolInput as Record<string, unknown>,
      });

      if (Array.isArray(result.content)) {
        return result.content
          .map((c: { type: string; text?: string }) =>
            c.type === 'text' ? (c.text ?? '') : JSON.stringify(c),
          )
          .join('\n');
      }
      return JSON.stringify(result.content);
    }

    throw new Error(`MCP 툴 '${toolName}'을 제공하는 서버를 찾을 수 없습니다.`);
  }

  /** 모든 MCP 서버 연결을 닫습니다. */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      try {
        await conn.client.close();
      } catch {
        // 종료 중 에러는 무시
      }
    }
    this.connections.clear();
  }

  // ── 내부 ─────────────────────────────────────────────────

  private async connectServer(name: string, cfg: McpServerConfig): Promise<void> {
    try {
      // mcpTokens를 서버 환경변수에 주입 (봇별 서비스 토큰 분리)
      const env: Record<string, string> = {
        ...process.env,
        ...(cfg.env ?? {}),
        ...this.mcpTokens,  // 봇별 토큰이 최우선
      } as Record<string, string>;

      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
      });

      const client = new Client({ name: `discord-ai-team-${this.agentId}`, version: '1.0.0' });
      await client.connect(transport);

      const { tools: rawTools } = await client.listTools();
      const tools: Anthropic.Tool[] = rawTools.map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));

      this.connections.set(name, { client, tools });
      console.log(`  ✅ [${this.agentId}] MCP [${name}]: ${tools.map((t) => t.name).join(', ')}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️  [${this.agentId}] MCP [${name}] 연결 실패: ${msg}`);
    }
  }
}
