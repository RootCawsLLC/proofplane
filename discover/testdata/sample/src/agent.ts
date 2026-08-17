import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";
const FALLBACK = "gpt-4o-mini";

export async function ask(prompt: string) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client.messages.create({ model: MODEL, max_tokens: 512, messages: [] });
}
