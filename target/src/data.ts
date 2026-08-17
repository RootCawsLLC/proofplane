/**
 * Seed data for two tenants.
 *
 * All identifiers are synthetic. The card numbers are Luhn-valid test numbers published by
 * payment processors for exactly this purpose, and the national identifiers use the 900-99
 * range that is never issued. Nothing here belongs to a real person.
 */

export interface Account {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly email: string;
  readonly nationalId: string;
  readonly cardNumber: string;
  readonly planCents: number;
}

export interface Ticket {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly subject: string;
  /** Attacker-controllable. This is the untrusted-input boundary of the whole system. */
  readonly body: string;
  readonly createdAt: string;
}

export interface KbDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export const ACCOUNTS: Account[] = [
  {
    id: 'acct_acme_001',
    tenantId: 'acme',
    name: 'Dana Whitfield',
    email: 'dana.whitfield@acme.test',
    nationalId: '900-11-4821',
    cardNumber: '4111111111111111',
    planCents: 49_00,
  },
  {
    id: 'acct_acme_002',
    tenantId: 'acme',
    name: 'Priya Raghunathan',
    email: 'priya.r@acme.test',
    nationalId: '900-22-7734',
    cardNumber: '5555555555554444',
    planCents: 199_00,
  },
  {
    id: 'acct_globex_001',
    tenantId: 'globex',
    name: 'Toma Sandoval',
    email: 'toma.sandoval@globex.test',
    nationalId: '900-33-9910',
    cardNumber: '378282246310005',
    planCents: 999_00,
  },
];

export const KB_DOCS: KbDoc[] = [
  {
    id: 'kb_refunds',
    title: 'Refund policy',
    body: 'Refunds are available within 30 days of purchase. Refunds over $500 require a supervisor.',
  },
  {
    id: 'kb_billing',
    title: 'Billing cycles',
    body: 'Invoices are issued monthly on the anniversary of signup. Proration applies on plan changes.',
  },
];

let ticketSeq = 0;

export function seedTickets(): Ticket[] {
  ticketSeq = 0;
  return [
    makeTicket('acme', 'acct_acme_001', 'Cannot access dashboard', 'The dashboard shows a blank page after login.'),
    makeTicket('globex', 'acct_globex_001', 'Invoice question', 'Why was I charged twice in March?'),
  ];
}

export function makeTicket(
  tenantId: string,
  accountId: string,
  subject: string,
  body: string,
): Ticket {
  ticketSeq += 1;
  return {
    id: `tkt_${String(ticketSeq).padStart(4, '0')}`,
    tenantId,
    accountId,
    subject,
    body,
    // Fixed timestamp keeps evidence byte-stable across runs; see ADR 0002.
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface Store {
  accounts: Account[];
  tickets: Ticket[];
  kb: KbDoc[];
}

export function freshStore(): Store {
  return { accounts: [...ACCOUNTS], tickets: seedTickets(), kb: [...KB_DOCS] };
}
