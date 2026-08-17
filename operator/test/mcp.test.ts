import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Drives the actual MCP server over stdio.
 *
 * The unit tests check the tool handlers directly, which proves the logic and proves nothing
 * about the protocol. This spawns the built server and speaks JSON-RPC at it, because "I built
 * an MCP server" is a claim about the wire, not about a function signature.
 *
 * Requires `npm run build` — package.json wires that in as a pretest step.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'mcp', 'server.js');

let proc: ChildProcessWithoutNullStreams;
let nextId = 0;
const pending = new Map<number, (msg: Record<string, unknown>) => void>();

function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method: string): void {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function callResult(response: Record<string, unknown>): {
  isError?: boolean;
  content: { type: string; text: string }[];
} {
  return response.result as { isError?: boolean; content: { type: string; text: string }[] };
}

beforeAll(async () => {
  if (!existsSync(serverPath)) {
    throw new Error(`built server not found at ${serverPath} — run npm run build`);
  }

  proc = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: join(here, '..'),
  }) as ChildProcessWithoutNullStreams;

  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const id = msg.id as number | undefined;
      if (id !== undefined && pending.has(id)) {
        pending.get(id)!(msg);
        pending.delete(id);
      }
    }
  });

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'proofplane-test', version: '0' },
  });
  const result = init.result as { serverInfo: { name: string } };
  expect(result.serverInfo.name).toBe('proofplane-operator');
  notify('notifications/initialized');
}, 30_000);

afterAll(() => {
  proc?.kill();
});

describe('MCP protocol', () => {
  it('lists tools with their effect in the description', async () => {
    const response = await rpc('tools/list', {});
    const { tools } = response.result as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    expect(tools.length).toBeGreaterThanOrEqual(10);
    for (const tool of tools) {
      expect(tool.description).toMatch(/^\[(read|propose)\]/);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('advertises no tool that decides anything', async () => {
    const response = await rpc('tools/list', {});
    const { tools } = response.result as { tools: { name: string; description: string }[] };
    expect(tools.filter((t) => /^\[propose\]/.test(t.description)).length).toBeGreaterThan(0);
    expect(tools.filter((t) => /approve|reject|apply|decide/i.test(t.name))).toEqual([]);
  });

  it('serves assurance status over the wire', async () => {
    const response = await rpc('tools/call', { name: 'assurance_status', arguments: {} });
    const parsed = JSON.parse(callResult(response).content[0]!.text) as {
      summary: Record<string, number>;
      head_hash: string;
      controls: unknown[];
    };
    expect(parsed.summary.HELD).toBeGreaterThanOrEqual(12);
    expect(parsed.head_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the evidence chain over the wire', async () => {
    const response = await rpc('tools/call', { name: 'verify_evidence_chain', arguments: {} });
    const parsed = JSON.parse(callResult(response).content[0]!.text) as { intact: boolean };
    expect(parsed.intact).toBe(true);
  });

  it('returns an error result rather than crashing on a bad argument', async () => {
    const response = await rpc('tools/call', {
      name: 'get_control',
      arguments: { control_id: 'PP-C999' },
    });
    const result = callResult(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no control/);
  });

  it('reports an unknown tool without dying', async () => {
    const response = await rpc('tools/call', { name: 'delete_everything', arguments: {} });
    const result = callResult(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no such tool/);
  });
});
