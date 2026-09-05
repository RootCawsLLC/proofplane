/**
 * Guardrail G1 — approval gate on privileged tool calls (control PP-C001).
 * Guardrail G3 — tenant scoping on data tools (control PP-C003).
 *
 * The design point worth arguing in a review: the authorization decision has no access to the
 * model's reasoning, its confidence, or the text of the request. It sees a tool name, a tenant,
 * and arguments. There is nothing here for a prompt to talk to. That is what makes it a control
 * rather than a mitigation.
 */

export type ToolName =
  | 'lookup_account'
  | 'list_tickets'
  | 'search_kb'
  | 'issue_refund'
  | 'send_email'
  | 'export_accounts';

/** Tools whose effects are externally visible and not cheaply reversible. */
export const PRIVILEGED_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'issue_refund',
  'send_email',
]);

export function isPrivileged(tool: string): boolean {
  return PRIVILEGED_TOOLS.has(tool as ToolName);
}

export interface SideEffect {
  readonly id: string;
  readonly tool: ToolName;
  readonly tenantId: string;
  readonly args: Record<string, unknown>;
  /**
   * 'model' means the effect happened because the model asked for it and nothing stopped it.
   * Any entry with this value is a PP-C001 breach by definition.
   */
  readonly authorisedBy: 'model' | 'operator';
  readonly approvalId: string | null;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly tool: ToolName;
  readonly tenantId: string;
  readonly args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
}

export class Ledger {
  private effects: SideEffect[] = [];
  private approvals: ApprovalRequest[] = [];
  private seq = 0;

  /**
   * G9. When false, an approval can be redeemed more than once and the arguments executed are
   * whatever the caller supplies at redemption time rather than what a human actually saw.
   *
   * Approval replay is the quiet failure of every human-in-the-loop design: the reviewer did
   * consent, once, to something — so the log looks clean, the control looks present, and the
   * effect happened twice.
   */
  constructor(private readonly strictApprovals = true) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, '0')}`;
  }

  recordEffect(
    tool: ToolName,
    tenantId: string,
    args: Record<string, unknown>,
    authorisedBy: 'model' | 'operator',
    approvalId: string | null,
  ): SideEffect {
    const effect: SideEffect = {
      id: this.nextId('eff'),
      tool,
      tenantId,
      args,
      authorisedBy,
      approvalId,
    };
    this.effects.push(effect);
    return effect;
  }

  requestApproval(
    tool: ToolName,
    tenantId: string,
    args: Record<string, unknown>,
  ): ApprovalRequest {
    const req: ApprovalRequest = {
      id: this.nextId('apr'),
      tool,
      tenantId,
      args,
      status: 'pending',
    };
    this.approvals.push(req);
    return req;
  }

  approve(
    id: string,
    overrideArgs?: Record<string, unknown>,
  ): { ok: boolean; effect?: SideEffect; reason?: string } {
    const req = this.approvals.find((a) => a.id === id);
    if (!req) return { ok: false, reason: 'no such approval' };

    if (this.strictApprovals && req.status !== 'pending') {
      return { ok: false, reason: `already ${req.status}; approvals are single-use` };
    }

    // With G9 on, the arguments a human saw are the arguments that execute. With it off, a
    // caller can substitute their own at redemption time and the approval still "counts".
    const args = this.strictApprovals ? req.args : { ...req.args, ...(overrideArgs ?? {}) };

    req.status = 'approved';
    const effect = this.recordEffect(req.tool, req.tenantId, args, 'operator', req.id);
    return { ok: true, effect };
  }

  /** Approvals redeemed more than once, or redeemed with arguments a human never saw. */
  replayedApprovals(): { approvalId: string; effects: number }[] {
    const counts = new Map<string, number>();
    for (const effect of this.effects) {
      if (effect.approvalId) {
        counts.set(effect.approvalId, (counts.get(effect.approvalId) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([approvalId, effects]) => ({ approvalId, effects }));
  }

  deny(id: string): boolean {
    const req = this.approvals.find((a) => a.id === id);
    if (!req || req.status !== 'pending') return false;
    req.status = 'denied';
    return true;
  }

  allEffects(): readonly SideEffect[] {
    return this.effects;
  }

  allApprovals(): readonly ApprovalRequest[] {
    return this.approvals;
  }

  /** Effects that occurred with no operator approval — the PP-C001 breach set. */
  unapprovedEffects(): readonly SideEffect[] {
    return this.effects.filter((e) => e.authorisedBy !== 'operator' || e.approvalId === null);
  }

  reset(): void {
    this.effects = [];
    this.approvals = [];
    this.seq = 0;
  }
}
