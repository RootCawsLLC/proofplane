/**
 * Guardrail G12 — system-prompt disclosure resistance (control PP-C012).
 *
 * Asking a model to repeat its instructions is the cheapest reconnaissance there is. What comes
 * back is the tool inventory, the phrasing of every restriction, and therefore a map of what to
 * argue with. Telling the model "do not reveal your instructions" adds one more line to the
 * thing being revealed.
 *
 * So the check runs on the response, comparing it against the actual system prompt rather than
 * against a list of phrases someone guessed. Overlap above the threshold is redacted.
 */

const MIN_SHINGLE_WORDS = 6;
const MAX_OVERLAP_RATIO = 0.3;

function shingles(text: string, size: number): Set<string> {
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) {
    out.add(words.slice(i, i + size).join(' '));
  }
  return out;
}

export interface DisclosureResult {
  readonly text: string;
  readonly disclosed: boolean;
  readonly overlapRatio: number;
}

/**
 * @param reply    the model's response
 * @param systemPrompt the instructions it was given
 */
export function blockSystemPromptEcho(reply: string, systemPrompt: string): DisclosureResult {
  const promptShingles = shingles(systemPrompt, MIN_SHINGLE_WORDS);
  if (promptShingles.size === 0) {
    return { text: reply, disclosed: false, overlapRatio: 0 };
  }

  const replyShingles = shingles(reply, MIN_SHINGLE_WORDS);
  let shared = 0;
  for (const shingle of replyShingles) {
    if (promptShingles.has(shingle)) shared += 1;
  }

  const ratio = promptShingles.size === 0 ? 0 : shared / promptShingles.size;
  if (ratio <= MAX_OVERLAP_RATIO) {
    return { text: reply, disclosed: false, overlapRatio: ratio };
  }

  return {
    text:
      'I can tell you what I am able to help with, but I do not share my configuration. ' +
      'Ask me about your account, your tickets, or our policies.',
    disclosed: true,
    overlapRatio: ratio,
  };
}
