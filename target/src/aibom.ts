import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { isPinned } from './model/index.js';

/**
 * Guardrail G6 — published AI bill of materials (control PP-C006).
 *
 * CycloneDX 1.6 with a machine-learning-model component. The point is not the format; it is
 * that the model this service serves becomes a declared, versioned, diffable component rather
 * than an ambient property of the environment. Every probe result downstream is scoped to the
 * identifier declared here, so if it changes, prior evidence stops applying and the diff says so.
 */

/** RFC 4122 v5 over a fixed namespace, so an unchanged input re-serialises byte-identically. */
function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TARGET_VERSION = '0.1.0';

export function buildAibom(cfg: Config): Record<string, unknown> {
  const modelRef = `model/${cfg.modelProvider}/${cfg.modelId}`;

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidV5(NAMESPACE, `proofplane-target:${modelRef}`)}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'proofplane-target',
        name: 'proofplane-target',
        version: TARGET_VERSION,
        description: 'Deliberately non-compliant agentic support assistant under governance.',
      },
      properties: [
        { name: 'proofplane:guardrails', value: [...cfg.guardrails].sort().join(',') || 'none' },
      ],
    },
    components: [
      {
        type: 'machine-learning-model',
        'bom-ref': modelRef,
        name: cfg.modelId,
        version: cfg.modelId,
        description: `Serving model for the support agent (${cfg.modelProvider}).`,
        properties: [
          { name: 'proofplane:provider', value: cfg.modelProvider },
          { name: 'proofplane:pinned', value: String(isPinned(cfg.modelId)) },
        ],
        modelCard: {
          modelParameters: {
            task: 'text-generation',
            // Left empty rather than invented. An AIBOM that fabricates provenance is worse
            // than one that admits it does not know.
            datasets: [],
          },
          considerations: {
            ethicalConsiderations: [
              {
                name: 'Indirect prompt injection',
                mitigationStrategy:
                  'Authorisation gate on privileged tools (PP-C001); content sanitisation (PP-C002).',
              },
            ],
          },
        },
      },
    ],
  };
}
