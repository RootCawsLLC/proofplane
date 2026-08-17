import { type Config, enabled } from './config.js';
import type { Store } from './data.js';
import { Ledger, isPrivileged, type ToolName } from './guardrails/authz.js';
import { evaluatePolicy, parseAmountCents } from './guardrails/policy.js';
import { sanitizeUntrusted } from './guardrails/sanitize.js';

export type { ToolName } from './guardrails/authz.js';

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: readonly string[];
}

/**
 * Tools the runtime can dispatch. Note that this is a SUPERSET of `APPROVED_TOOLS` in config —
 * `export_accounts` is here because something added it (a plugin, an MCP server, a well-meaning
 * engineer) and the runtime will happily call it. Whether it is *allowed* to is G8's business.
 *
 * That gap between "dispatchable" and "approved" is where most real agent tool sprawl lives.
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'lookup_account',
    description: 'Look up a customer account by email address.',
    parameters: ['email'],
  },
  { name: 'list_tickets', description: 'List support tickets.', parameters: [] },
  { name: 'search_kb', description: 'Search the support knowledge base.', parameters: ['query'] },
  {
    name: 'issue_refund',
    description: 'Issue a refund to an account.',
    parameters: ['email', 'amount'],
  },
  { name: 'send_email', description: 'Send an email.', parameters: ['to', 'body'] },
  {
    name: 'export_accounts',
    description: 'Export the full account list as a report. Added by a reporting plugin.',
    parameters: [],
  },
];

export interface ToolCall {
  readonly tool: ToolName;
  readonly args: Record<string, string>;
  /** Where the instruction that produced this call came from. Diagnostic, not enforcement. */
  readonly provenance: 'user' | 'untrusted_content';
}

export interface ToolResult {
  readonly tool: ToolName;
  readonly status: 'ok' | 'denied' | 'pending_approval' | 'error';
  readonly content: string;
  /** True when the content embeds text an outside party authored. */
  readonly containsUntrusted: boolean;
  readonly detail?: Record<string, unknown>;
}

export interface CallerContext {
  readonly tenantId: string;
  readonly userEmail: string;
}

export interface ToolDeps {
  readonly cfg: Config;
  readonly store: Store;
  readonly ledger: Ledger;
}

export function executeTool(
  call: ToolCall,
  caller: CallerContext,
  deps: ToolDeps,
): ToolResult {
  const { cfg, store, ledger } = deps;

  // ---- G8, G11, G10, G7: policy runs BEFORE the approval gate ----------------------------
  // A request that violates policy is refused, not queued. Asking a human to sign off on
  // something the system already knows is invalid is how approval fatigue is manufactured.
  const verdict = evaluatePolicy(call, caller.tenantId, cfg);
  if (!verdict.allowed) {
    return {
      tool: call.tool,
      status: 'denied',
      content: `Denied by ${verdict.control}: ${verdict.reason}`,
      containsUntrusted: false,
      detail: { control: verdict.control },
    };
  }

  // ---- G1: privileged calls never take effect on the model's say-so -----------------------
  if (isPrivileged(call.tool) && enabled(cfg, 'G1')) {
    const req = ledger.requestApproval(call.tool, caller.tenantId, { ...call.args });
    return {
      tool: call.tool,
      status: 'pending_approval',
      content: `Action queued for human approval as ${req.id}. It has NOT been performed.`,
      containsUntrusted: false,
      detail: { approvalId: req.id },
    };
  }

  switch (call.tool) {
    case 'lookup_account': {
      const email = (call.args.email ?? '').toLowerCase();
      // ---- G3: tenant scoping resolved from the session, never from model arguments -------
      const pool = enabled(cfg, 'G3')
        ? store.accounts.filter((a) => a.tenantId === caller.tenantId)
        : store.accounts;
      const account = pool.find((a) => a.email.toLowerCase() === email);

      if (!account) {
        const existsElsewhere = store.accounts.some((a) => a.email.toLowerCase() === email);
        return {
          tool: call.tool,
          status: 'denied',
          content:
            existsElsewhere && enabled(cfg, 'G3')
              ? 'Denied: that account belongs to a different tenant.'
              : 'No account found for that email address.',
          containsUntrusted: false,
        };
      }

      return {
        tool: call.tool,
        status: 'ok',
        content: [
          `account_id: ${account.id}`,
          `tenant: ${account.tenantId}`,
          `name: ${account.name}`,
          `email: ${account.email}`,
          `national_id: ${account.nationalId}`,
          `card_number: ${account.cardNumber}`,
          `plan_cents: ${account.planCents}`,
        ].join('\n'),
        containsUntrusted: false,
      };
    }

    case 'list_tickets': {
      const pool = enabled(cfg, 'G3')
        ? store.tickets.filter((t) => t.tenantId === caller.tenantId)
        : store.tickets;

      const rendered = pool
        .map((t) => {
          const body = enabled(cfg, 'G2')
            ? sanitizeUntrusted(`ticket:${t.id}`, t.body).text
            : t.body;
          return `[${t.id}] ${t.subject}\n${body}`;
        })
        .join('\n\n');

      return {
        tool: call.tool,
        status: 'ok',
        content: rendered || 'No tickets.',
        containsUntrusted: true,
      };
    }

    case 'search_kb': {
      const q = (call.args.query ?? '').toLowerCase();
      const hits = store.kb.filter(
        (d) => d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q),
      );
      const pool = hits.length > 0 ? hits : store.kb;
      return {
        tool: call.tool,
        status: 'ok',
        content: pool.map((d) => `[${d.id}] ${d.title}\n${d.body}`).join('\n\n'),
        containsUntrusted: false,
      };
    }

    case 'export_accounts': {
      // Reached only when G8 is off. Dumps every tenant — a reporting plugin nobody scoped.
      return {
        tool: call.tool,
        status: 'ok',
        content: store.accounts
          .map((a) => `${a.id}\t${a.tenantId}\t${a.name}`)
          .join('\n'),
        containsUntrusted: false,
        detail: { exported: store.accounts.length },
      };
    }

    case 'issue_refund': {
      // Reached only when G1 is off.
      const cents = parseAmountCents(call.args.amount) ?? 0;
      const effect = ledger.recordEffect(
        'issue_refund',
        caller.tenantId,
        { email: call.args.email ?? '', amount_cents: cents },
        'model',
        null,
      );
      return {
        tool: call.tool,
        status: 'ok',
        content: `Refund ${effect.id} of ${cents} cents issued to ${call.args.email ?? 'unknown'}.`,
        containsUntrusted: false,
        detail: { effectId: effect.id, amountCents: cents },
      };
    }

    case 'send_email': {
      const effect = ledger.recordEffect(
        'send_email',
        caller.tenantId,
        { to: call.args.to ?? '', body: call.args.body ?? '' },
        'model',
        null,
      );
      return {
        tool: call.tool,
        status: 'ok',
        content: `Email ${effect.id} sent to ${call.args.to ?? 'unknown'}.`,
        containsUntrusted: false,
        detail: { effectId: effect.id },
      };
    }

    default: {
      return {
        tool: call.tool,
        status: 'error',
        content: `Unknown tool: ${String(call.tool)}`,
        containsUntrusted: false,
      };
    }
  }
}
