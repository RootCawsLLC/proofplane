import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { runAgent } from './agent.js';
import { buildAibom } from './aibom.js';
import { AuditLog } from './audit.js';
import {
  ALL_GUARDRAILS,
  enabled,
  GUARDRAILS,
  loadConfig,
  withGuardrails,
  type Config,
} from './config.js';
import { freshStore, makeTicket, type Store } from './data.js';
import { Ledger } from './guardrails/authz.js';
import { createModel, isPinned, type Model } from './model/index.js';

/**
 * The system under governance.
 *
 * Everything the probe suite needs to observe is exposed over HTTP: the guardrail set in
 * force, the side-effect ledger, the interaction log, and the AIBOM. That instrumentation is
 * not a shortcut around the assessment — it is the assessment surface. A system that cannot be
 * interrogated cannot be continuously assured, which is itself a finding worth making.
 */

interface AppState {
  cfg: Config;
  store: Store;
  ledger: Ledger;
  audit: AuditLog;
  model: Model;
}

function newState(cfg: Config): AppState {
  return {
    cfg,
    store: freshStore(),
    ledger: new Ledger(enabled(cfg, 'G9')),
    audit: new AuditLog(enabled(cfg, 'G5')),
    model: createModel(cfg),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 256 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function createApp(cfg: Config = loadConfig()) {
  let state = newState(cfg);

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // ---- observability of the governance posture itself ----------------------------------
    if (method === 'GET' && (path === '/healthz' || path === '/')) {
      return send(res, 200, {
        ok: true,
        service: 'proofplane-target',
        guardrails: {
          enabled: [...state.cfg.guardrails].sort(),
          available: ALL_GUARDRAILS.map((id) => ({ id, description: GUARDRAILS[id] })),
        },
        model: {
          provider: state.model.provider,
          id: state.model.id,
          pinned: isPinned(state.model.id),
        },
      });
    }

    if (method === 'POST' && path === '/reset') {
      // An optional guardrail override is sticky: it becomes the running configuration until
      // changed again. Probes call /reset with no body between trials, so a sticky override
      // survives them, which is what lets the independence matrix run in one process.
      const body = await readJson(req);
      const override = Array.isArray(body.guardrails) ? body.guardrails.map(String) : null;
      state = newState(override ? withGuardrails(state.cfg, override) : state.cfg);
      return send(res, 200, { ok: true, guardrails: [...state.cfg.guardrails].sort() });
    }

    // ---- the attacker's channel: anyone can write a ticket body --------------------------
    if (method === 'POST' && path === '/tickets') {
      const body = await readJson(req);
      const ticket = makeTicket(
        str(body.tenant_id, 'acme'),
        str(body.account_id, 'acct_acme_001'),
        str(body.subject, '(no subject)'),
        str(body.body),
      );
      state.store.tickets.push(ticket);
      state.audit.append('ticket.created', { id: ticket.id, tenant: ticket.tenantId });
      return send(res, 201, { ticket_id: ticket.id });
    }

    if (method === 'POST' && path === '/chat') {
      const body = await readJson(req);
      const result = await runAgent(
        {
          tenantId: str(body.tenant_id, 'acme'),
          userEmail: str(body.user_email, 'dana.whitfield@acme.test'),
          message: str(body.message),
        },
        state,
      );
      return send(res, 200, result);
    }

    // ---- PP-C001 assessment surface ------------------------------------------------------
    if (method === 'GET' && path === '/ledger') {
      return send(res, 200, {
        effects: state.ledger.allEffects(),
        approvals: state.ledger.allApprovals(),
        unapproved_effects: state.ledger.unapprovedEffects(),
        replayed_approvals: state.ledger.replayedApprovals(),
      });
    }

    // Operator-initiated approval request. Exists so PP-P009 can test redemption semantics
    // without depending on G1 to have routed something here — otherwise disabling the approval
    // gate would also break the replay probe, and the independence matrix would be a lie.
    if (method === 'POST' && path === '/approvals') {
      const body = await readJson(req);
      const request = state.ledger.requestApproval(
        str(body.tool, 'issue_refund') as never,
        str(body.tenant_id, 'acme'),
        (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>,
      );
      return send(res, 201, request);
    }

    const approveMatch = /^\/approvals\/([\w-]+)\/approve$/.exec(path);
    if (method === 'POST' && approveMatch) {
      if (req.headers['x-operator-token'] !== state.cfg.operatorToken) {
        return send(res, 403, { error: 'operator token required' });
      }
      // The optional `args` override is the replay/substitution surface PP-P009 attacks: with
      // G9 off, a caller can redeem the same approval repeatedly and swap in arguments no
      // human ever saw, while the approval record still reads as a clean human decision.
      const approveBody = await readJson(req);
      const overrideArgs =
        approveBody.args && typeof approveBody.args === 'object'
          ? (approveBody.args as Record<string, unknown>)
          : undefined;
      const outcome = state.ledger.approve(approveMatch[1]!, overrideArgs);
      state.audit.append('approval.decided', { id: approveMatch[1], ok: outcome.ok });
      return send(res, outcome.ok ? 200 : 400, outcome);
    }

    // ---- PP-C005 assessment surface ------------------------------------------------------
    if (method === 'GET' && path === '/audit') {
      return send(res, 200, {
        recording: state.audit.isRecording,
        verification: state.audit.verify(),
        entries: state.audit.all(),
      });
    }

    if (method === 'POST' && path === '/audit/tamper') {
      // A test affordance, exposed unconditionally and on purpose. PP-P005 needs to demonstrate
      // that the chain DETECTS modification; a probe that never tampers cannot claim that.
      const body = await readJson(req);
      const seq = Number(body.seq ?? 1);
      const ok = state.audit.tamper(seq, str(body.event, 'tampered.event'));
      return send(res, ok ? 200 : 404, { ok, verification: state.audit.verify() });
    }

    // ---- PP-C006 assessment surface ------------------------------------------------------
    if (method === 'GET' && path === '/aibom') {
      if (!enabled(state.cfg, 'G6')) {
        return send(res, 404, { error: 'no AI bill of materials is published by this service' });
      }
      return send(res, 200, buildAibom(state.cfg));
    }

    return send(res, 404, { error: `no route for ${method} ${path}` });
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, '127.0.0.1', () => {
    const set = [...cfg.guardrails].sort().join(',') || 'none';
    process.stdout.write(
      `proofplane-target listening on http://127.0.0.1:${cfg.port} ` +
        `[guardrails=${set}] [model=${cfg.modelProvider}:${cfg.modelId}]\n`,
    );
  });
}
