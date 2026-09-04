import { NextResponse } from 'next/server';
import { runProofplane, type RunRequest } from '@/lib/proofplane-runner';

// The run boots real target servers and spawns the real Python probe suite against them, so
// this needs the Node runtime and a generous budget.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await runProofplane(body);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[run] failed:', err);
    const message = err instanceof Error ? err.message : 'Assurance run failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
