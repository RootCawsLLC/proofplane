import type { Config } from '../config.js';
import { AnthropicModel } from './anthropic.js';
import { MockModel } from './mock.js';
import type { Model } from './types.js';

export { isPinned } from './types.js';
export type { Model, ModelMessage, ModelTurn } from './types.js';

export function createModel(cfg: Config, env: NodeJS.ProcessEnv = process.env): Model {
  if (cfg.modelProvider === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'PROOFPLANE_MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY. ' +
          'Unset the provider to run against the deterministic double instead.',
      );
    }
    return new AnthropicModel(cfg.modelId, key);
  }
  return new MockModel(cfg.modelId);
}
