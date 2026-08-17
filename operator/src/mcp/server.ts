#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { underModelAuthority } from '../core/boundary.js';
import { ProposalQueue } from '../core/proposals.js';
import { Repo } from '../core/repo.js';
import { TOOLS, findTool, type Context } from '../tools/index.js';

/**
 * MCP server exposing the assurance programme to an agent.
 *
 * Every tool invocation is wrapped in `underModelAuthority`. Anything reached from inside that
 * wrapper — at any call depth — that tries to perform an operation carrying a compliance
 * consequence will throw. The model gets a clear refusal rather than a silent success, and the
 * refusal names the boundary it hit.
 *
 * Run it:  node dist/mcp/server.js
 * Wire it into Claude Code:  claude mcp add proofplane -- node /abs/path/dist/mcp/server.js
 */

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const repo = Repo.locate(process.env.PROOFPLANE_ROOT ?? process.cwd());
  const context: Context = {
    repo,
    queue: new ProposalQueue(repo.root),
    // Recorded on every proposal so a judgment can be scoped to the model that made it — the
    // same reason PP-C006 insists the serving model is pinned and declared.
    model: process.env.PROOFPLANE_OPERATOR_MODEL ?? 'unknown',
  };

  const server = new Server(
    { name: 'proofplane-operator', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: `[${t.effect}] ${t.description}`,
      inputSchema: t.inputSchema,
    })),
  }));

  let invocation = 0;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `no such tool: ${request.params.name}` }],
      };
    }

    invocation += 1;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await underModelAuthority(tool.name, `inv_${invocation}`, () =>
        tool.handler(args, context),
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    }
  });

  await server.connect(new StdioServerTransport());
  // stderr, not stdout: stdout is the protocol channel.
  process.stderr.write(
    `proofplane-operator ${VERSION} on stdio — ${TOOLS.length} tools ` +
      `(${TOOLS.filter((t) => t.effect === 'read').length} read, ` +
      `${TOOLS.filter((t) => t.effect === 'propose').length} propose, 0 decide)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
