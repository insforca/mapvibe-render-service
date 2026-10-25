/**
 * Public identity for GET /health. The studio webhook reads `capabilities`
 * to decide whether this build accepts `dryRun` and an explicit catalogue SKU.
 *
 * `commit` is a git SHA from the platform env, or null. Values that are not
 * a SHA are dropped so a mis-set variable cannot publish a secret.
 */
export const SERVICE_VERSION = '3.6.0';

export const HEALTH_CAPABILITIES = ['dryRun', 'catalogueSku'] as const;

const COMMIT_ENV_KEYS = ['RAILWAY_GIT_COMMIT_SHA', 'GIT_COMMIT', 'SOURCE_VERSION'] as const;
const SHA = /^[0-9a-f]{7,40}$/i;

export interface HealthIdentity {
  version: string;
  /** Full or abbreviated git SHA, or null when the platform did not provide one. */
  commit: string | null;
  /** `version`, or `version@commit` when a SHA is available. */
  build: string;
  capabilities: readonly ['dryRun', 'catalogueSku'];
}

export function healthIdentity(env: NodeJS.ProcessEnv = process.env): HealthIdentity {
  const commit = readCommit(env);
  return {
    version: SERVICE_VERSION,
    commit,
    build: commit ? `${SERVICE_VERSION}@${commit}` : SERVICE_VERSION,
    capabilities: HEALTH_CAPABILITIES,
  };
}

function readCommit(env: NodeJS.ProcessEnv): string | null {
  for (const key of COMMIT_ENV_KEYS) {
    const value = (env[key] ?? '').trim();
    if (SHA.test(value)) return value;
  }
  return null;
}
