export interface ExchangeCredentials {
  readonly exchangeId: string;
  readonly apiKey: string;
  readonly secret: string;
  readonly sandbox: boolean;
  readonly category: 'spot' | 'linear';
}

export interface LoadCredentialsOptions {
  /** Explicit opt-in required to leave the testnet. */
  readonly allowLive?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const KEY_VAR = 'BYBIT_API_KEY';
const SECRET_VAR = 'BYBIT_API_SECRET';
const LIVE_VAR = 'BYBIT_LIVE';
const CATEGORY_VAR = 'BYBIT_CATEGORY';

/**
 * Read exchange credentials from the environment, refusing anything ambiguous.
 *
 * Two deliberate choices:
 *
 *  - Sandbox is the default and leaving it takes TWO signals: `BYBIT_LIVE=true`
 *    in the environment AND `allowLive` from the caller (a `--live` flag).
 *    One forgotten variable can then never move real money.
 *  - Nothing here logs, returns or stringifies the secret. Callers get a
 *    `describe()` line that names the key by prefix only.
 */
export function loadExchangeCredentials(options: LoadCredentialsOptions = {}): ExchangeCredentials {
  const env = options.env ?? process.env;

  const apiKey = (env[KEY_VAR] ?? '').trim();
  const secret = (env[SECRET_VAR] ?? '').trim();

  const missing = [
    apiKey === '' ? KEY_VAR : null,
    secret === '' ? SECRET_VAR : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(
      `Missing exchange credentials: ${missing.join(', ')}. ` +
        'Export them for this shell only, and use a key with trading enabled and WITHDRAWAL DISABLED.',
    );
  }

  const wantsLive = (env[LIVE_VAR] ?? '').trim().toLowerCase() === 'true';
  if (wantsLive && options.allowLive !== true) {
    throw new Error(
      `${LIVE_VAR}=true is set but this command was not started with --live. ` +
        'Refusing to trade real funds without both.',
    );
  }
  if (options.allowLive === true && !wantsLive) {
    throw new Error(
      `--live was passed but ${LIVE_VAR} is not "true". ` +
        'Refusing to trade real funds without both.',
    );
  }

  const rawCategory = (env[CATEGORY_VAR] ?? 'spot').trim().toLowerCase();
  if (rawCategory !== 'spot' && rawCategory !== 'linear') {
    throw new Error(`${CATEGORY_VAR} must be "spot" or "linear", got ${JSON.stringify(rawCategory)}`);
  }

  return {
    exchangeId: 'bybit',
    apiKey,
    secret,
    sandbox: !wantsLive,
    category: rawCategory,
  };
}

/** A one-line summary safe to print: the secret never appears. */
export function describeCredentials(credentials: ExchangeCredentials): string {
  const fingerprint =
    credentials.apiKey.length <= 4
      ? '****'
      : `${credentials.apiKey.slice(0, 4)}…${'*'.repeat(4)}`;
  return (
    `${credentials.exchangeId} ${credentials.category} ` +
    `${credentials.sandbox ? 'TESTNET' : 'LIVE — REAL FUNDS'} (key ${fingerprint})`
  );
}
