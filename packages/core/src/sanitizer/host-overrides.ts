import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SanitizationProfileError } from './errors.js';
import type { SanitizationProfile } from './profiles.js';

/**
 * Per-host extra redactor tags. Each tag maps to a context-anchored redactor in
 * `strippers.ts` (dispatched via `EXTRA_REDACTORS` in `index.ts`). Tags are
 * deliberately conservative — they anchor on labelling keywords or unambiguous
 * formats (IBAN, EIN) so ordinary numbers in page prose stay visible to the
 * model; over-redaction breaks task functionality.
 */
export type ExtraRedactorTag =
  | 'currency_usd'
  | 'date_of_birth'
  | 'case_number'
  | 'account_number'
  | 'iban'
  | 'member_id'
  | 'medical_record_number'
  | 'tax_id'
  | 'passport_number'
  | 'drivers_license';

export interface HostOverride {
  readonly hostPattern: string;
  readonly inherits: SanitizationProfile;
  readonly extraRedactors: readonly ExtraRedactorTag[];
}

export interface HostOverrideStore {
  load(path?: string): Promise<readonly HostOverride[]>;
  reload(): Promise<void>;
  match(host: string): HostOverride | null;
}

interface CompiledHostOverride {
  readonly override: HostOverride;
  readonly matcher: RegExp;
}

const extraRedactorSchema = z.enum([
  'currency_usd',
  'date_of_birth',
  'case_number',
  'account_number',
  'iban',
  'member_id',
  'medical_record_number',
  'tax_id',
  'passport_number',
  'drivers_license',
]);
const hostOverrideConfigSchema = z.object({
  version: z.literal(1),
  hosts: z.record(
    z.string(),
    z.object({
      inherits: z.enum(['public', 'read-only-data', 'authenticated']),
      extra_redactors: z.array(extraRedactorSchema).default([]),
    }),
  ),
});

const USER_OVERRIDE_PATH = join(homedir(), '.config', 'yantra', 'sanitizer-hosts.yaml');
const DEFAULT_OVERRIDE_FILE_URL = new URL('./default-host-overrides.yaml', import.meta.url);

function frozenOverride(
  hostPattern: string,
  inherits: SanitizationProfile,
  extraRedactors: readonly ExtraRedactorTag[],
): HostOverride {
  return Object.freeze({
    hostPattern,
    inherits,
    extraRedactors: Object.freeze([...extraRedactors]),
  });
}

/** Redactor bundles shared by every host of one category. */
const BANK_REDACTORS: readonly ExtraRedactorTag[] = ['currency_usd', 'account_number', 'iban'];
const BROKERAGE_REDACTORS: readonly ExtraRedactorTag[] = ['currency_usd', 'account_number'];
const CREDIT_BUREAU_REDACTORS: readonly ExtraRedactorTag[] = ['date_of_birth', 'account_number'];
const HEALTH_REDACTORS: readonly ExtraRedactorTag[] = [
  'date_of_birth',
  'member_id',
  'medical_record_number',
];
const PAYROLL_REDACTORS: readonly ExtraRedactorTag[] = [
  'currency_usd',
  'account_number',
  'date_of_birth',
];
const TAX_PREP_REDACTORS: readonly ExtraRedactorTag[] = ['tax_id', 'currency_usd'];
const AUTO_INSURANCE_REDACTORS: readonly ExtraRedactorTag[] = ['member_id', 'drivers_license'];

/**
 * Packaged production defaults, mirrored byte-for-byte (as data) by
 * `default-host-overrides.yaml` — keep BOTH in sync; the file store falls back
 * to the YAML while in-process sanitization uses this constant. Categories:
 * banking/payments, brokerage, credit bureaus, health portals/insurers,
 * government, payroll/tax, and auto insurance.
 */
export const DEFAULT_HOST_OVERRIDES: readonly HostOverride[] = Object.freeze([
  // Banking & payments.
  frozenOverride('*.chase.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.bankofamerica.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.wellsfargo.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.citi.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.capitalone.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.usbank.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.pnc.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.truist.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.ally.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.americanexpress.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.discover.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.paypal.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.venmo.com', 'authenticated', BANK_REDACTORS),
  frozenOverride('*.wise.com', 'authenticated', BANK_REDACTORS),
  // Brokerage & retirement.
  frozenOverride('*.fidelity.com', 'authenticated', BROKERAGE_REDACTORS),
  frozenOverride('*.schwab.com', 'authenticated', BROKERAGE_REDACTORS),
  frozenOverride('*.vanguard.com', 'authenticated', BROKERAGE_REDACTORS),
  frozenOverride('*.robinhood.com', 'authenticated', BROKERAGE_REDACTORS),
  // Credit bureaus.
  frozenOverride('*.experian.com', 'authenticated', CREDIT_BUREAU_REDACTORS),
  frozenOverride('*.equifax.com', 'authenticated', CREDIT_BUREAU_REDACTORS),
  frozenOverride('*.transunion.com', 'authenticated', CREDIT_BUREAU_REDACTORS),
  frozenOverride('*.creditkarma.com', 'authenticated', CREDIT_BUREAU_REDACTORS),
  frozenOverride('*.annualcreditreport.com', 'authenticated', CREDIT_BUREAU_REDACTORS),
  // Health portals, pharmacies, and insurers.
  frozenOverride('*.mychart.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.kaiserpermanente.org', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.uhc.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.aetna.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.cigna.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.anthem.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.humana.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.express-scripts.com', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.healthcare.gov', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.medicare.gov', 'authenticated', HEALTH_REDACTORS),
  frozenOverride('*.va.gov', 'authenticated', HEALTH_REDACTORS),
  // Government.
  frozenOverride('*.uscis.gov', 'authenticated', ['case_number', 'date_of_birth']),
  frozenOverride('*.irs.gov', 'authenticated', ['tax_id', 'currency_usd']),
  frozenOverride('*.ssa.gov', 'authenticated', ['date_of_birth']),
  frozenOverride('*.state.gov', 'authenticated', ['passport_number']),
  frozenOverride('*.studentaid.gov', 'authenticated', ['account_number', 'currency_usd']),
  // Payroll, HR, and tax preparation.
  frozenOverride('*.adp.com', 'authenticated', PAYROLL_REDACTORS),
  frozenOverride('*.gusto.com', 'authenticated', PAYROLL_REDACTORS),
  frozenOverride('*.paychex.com', 'authenticated', PAYROLL_REDACTORS),
  frozenOverride('*.myworkday.com', 'authenticated', PAYROLL_REDACTORS),
  frozenOverride('*.intuit.com', 'authenticated', TAX_PREP_REDACTORS),
  frozenOverride('*.hrblock.com', 'authenticated', TAX_PREP_REDACTORS),
  // Auto insurance.
  frozenOverride('*.geico.com', 'authenticated', AUTO_INSURANCE_REDACTORS),
  frozenOverride('*.progressive.com', 'authenticated', AUTO_INSURANCE_REDACTORS),
  frozenOverride('*.statefarm.com', 'authenticated', AUTO_INSURANCE_REDACTORS),
  frozenOverride('*.allstate.com', 'authenticated', AUTO_INSURANCE_REDACTORS),
]);

/**
 * Read sanitizer host overrides from user config with default fallback.
 */
export class FileHostOverrideStore implements HostOverrideStore {
  private activePath: string;
  private cached: readonly HostOverride[] = DEFAULT_HOST_OVERRIDES;
  private compiled: readonly CompiledHostOverride[] = compileOverrides(DEFAULT_HOST_OVERRIDES);

  public constructor(path = USER_OVERRIDE_PATH) {
    this.activePath = path;
  }

  public async load(path = this.activePath): Promise<readonly HostOverride[]> {
    this.activePath = path;

    const fromDisk = await this.readOverrides(path);
    this.cached = fromDisk;
    this.compiled = compileOverrides(fromDisk);

    return this.cached;
  }

  public async reload(): Promise<void> {
    await this.load(this.activePath);
  }

  public match(host: string): HostOverride | null {
    const normalizedHost = normalizeHost(host);
    for (const entry of this.compiled) {
      if (entry.matcher.test(normalizedHost)) {
        return entry.override;
      }
    }
    return null;
  }

  private async readOverrides(path: string): Promise<readonly HostOverride[]> {
    const sourceText = await readYamlWithDefault(path);

    let parsed: unknown;
    try {
      parsed = parseYaml(sourceText);
    } catch (error) {
      throw new SanitizationProfileError('Failed to parse sanitizer host override YAML.', {
        filePath: path,
        cause: error,
      });
    }

    const validated = hostOverrideConfigSchema.safeParse(parsed);
    if (!validated.success) {
      throw new SanitizationProfileError('Sanitizer host override file is malformed.', {
        filePath: path,
        cause: validated.error,
      });
    }

    return Object.entries(validated.data.hosts).map(([pattern, config]) =>
      Object.freeze({
        hostPattern: pattern,
        inherits: config.inherits,
        extraRedactors: Object.freeze([...config.extra_redactors]),
      }),
    );
  }
}

export function matchHostOverride(
  host: string,
  overrides: readonly HostOverride[],
): HostOverride | null {
  const normalizedHost = normalizeHost(host);
  for (const override of overrides) {
    if (globToRegExp(override.hostPattern).test(normalizedHost)) {
      return override;
    }
  }
  return null;
}

export function normalizeHost(hostHint: string): string {
  try {
    const fromUrl = new URL(hostHint);
    return fromUrl.hostname.toLowerCase();
  } catch {
    return hostHint.toLowerCase();
  }
}

async function readYamlWithDefault(path: string): Promise<string> {
  try {
    await access(path);
    return await readFile(path, 'utf8');
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code !== 'ENOENT') {
      throw new SanitizationProfileError('Unable to read sanitizer host override file.', {
        filePath: path,
        cause: error,
      });
    }
    return readFile(DEFAULT_OVERRIDE_FILE_URL, 'utf8');
  }
}

function compileOverrides(overrides: readonly HostOverride[]): readonly CompiledHostOverride[] {
  return overrides.map((override) => ({
    override,
    matcher: globToRegExp(override.hostPattern),
  }));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/-/g, '\\-');

  return new RegExp(`^${escaped}$`, 'i');
}
