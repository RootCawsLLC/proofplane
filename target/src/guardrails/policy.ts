import {
  APPROVED_TOOLS,
  REFUND_CEILING_CENTS,
  TENANT_EMAIL_DOMAINS,
  enabled,
  type Config,
} from '../config.js';
import type { ToolCall } from '../tools.js';

/**
 * Pre-dispatch policy checks: G8, G11, G10, G7.
 *
 * These run BEFORE the approval gate (G1), and the ordering is load-bearing rather than
 * incidental. A request that violates policy must be refused outright, not queued for a human
 * to rubber-stamp. Putting a human in front of a request the system already knows is invalid
 * converts a deterministic refusal into a judgment call, and judgment under volume is how
 * approval fatigue starts.
 *
 * It is also what makes the probes independent: with the approval gate on and one of these off,
 * the violating request is still observable as having been accepted.
 */

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  readonly control: string;
}

const ALLOW: PolicyVerdict = { allowed: true, reason: '', control: '' };

function deny(control: string, reason: string): PolicyVerdict {
  return { allowed: false, reason, control };
}

export function parseAmountCents(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** G8 — the model may name any tool it likes; only approved names dispatch. */
export function checkToolAllowed(call: ToolCall, cfg: Config): PolicyVerdict {
  if (!enabled(cfg, 'G8')) return ALLOW;
  if (APPROVED_TOOLS.includes(call.tool)) return ALLOW;
  return deny(
    'PP-C008',
    `Tool ${call.tool} is not on the approved tool manifest for this deployment.`,
  );
}

/** G11 — arguments are validated for shape and range before anything acts on them. */
export function checkArguments(call: ToolCall, cfg: Config): PolicyVerdict {
  if (!enabled(cfg, 'G11')) return ALLOW;

  if (call.tool === 'issue_refund') {
    const cents = parseAmountCents(call.args.amount);
    if (cents === null) {
      return deny('PP-C011', `Refund amount ${JSON.stringify(call.args.amount)} is not a number.`);
    }
    if (cents <= 0) {
      return deny('PP-C011', `Refund amount must be positive; got ${cents} cents.`);
    }
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(call.args.email ?? '')) {
      return deny('PP-C011', 'Refund recipient is not a well-formed email address.');
    }
  }

  if (call.tool === 'send_email' && !/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(call.args.to ?? '')) {
    return deny('PP-C011', 'Email recipient is not a well-formed address.');
  }

  return ALLOW;
}

/** G10 — an agent may only send outward to destinations inside the caller's own tenant. */
export function checkDestination(
  call: ToolCall,
  tenantId: string,
  cfg: Config,
): PolicyVerdict {
  if (!enabled(cfg, 'G10')) return ALLOW;
  if (call.tool !== 'send_email') return ALLOW;

  const allowed = TENANT_EMAIL_DOMAINS[tenantId];
  const to = (call.args.to ?? '').toLowerCase();
  const domain = to.split('@')[1] ?? '';

  if (!allowed) return deny('PP-C010', `No egress domain is configured for tenant ${tenantId}.`);
  if (domain !== allowed) {
    return deny(
      'PP-C010',
      `Destination ${to || '(none)'} is outside tenant ${tenantId} (allowed: @${allowed}).`,
    );
  }
  return ALLOW;
}

/** G7 — an absolute ceiling the agent path cannot cross, with or without an approval. */
export function checkCeiling(call: ToolCall, cfg: Config): PolicyVerdict {
  if (!enabled(cfg, 'G7')) return ALLOW;
  if (call.tool !== 'issue_refund') return ALLOW;

  const cents = parseAmountCents(call.args.amount) ?? 0;
  if (cents > REFUND_CEILING_CENTS) {
    return deny(
      'PP-C007',
      `Refund of ${cents} cents exceeds the agent ceiling of ${REFUND_CEILING_CENTS} cents. ` +
        `This action does not belong on the agent path.`,
    );
  }
  return ALLOW;
}

export function evaluatePolicy(
  call: ToolCall,
  tenantId: string,
  cfg: Config,
): PolicyVerdict {
  for (const verdict of [
    checkToolAllowed(call, cfg),
    checkArguments(call, cfg),
    checkDestination(call, tenantId, cfg),
    checkCeiling(call, cfg),
  ]) {
    if (!verdict.allowed) return verdict;
  }
  return ALLOW;
}
