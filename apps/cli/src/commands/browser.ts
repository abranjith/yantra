/**
 * `yantra browser` — the local browser selection and diagnostics surface.
 *
 * Four subcommands, and the boundary between them is what each one is allowed to
 * do rather than what it reports:
 *
 * - `install` downloads Chrome for Testing Stable with explicit consent.
 * - `list` is a pure local inventory: no network, no launch, no install.
 * - `use` writes exactly two config keys and launches nothing — setting a
 *   preference must never cost a browser start, and must not fail on a host
 *   where starting one is the broken thing.
 * - `check` runs a fresh isolated compatibility probe and writes only the local
 *   evidence cache.
 *
 * None of them contacts an update server. `browser update` (FEAT-046) is the
 * only update-check surface.
 */
import {
  createLocalBrowserRuntimeServices,
  LocalBrowserInventoryService,
  managedBrowsersRoot,
  requiredCapabilities,
  validateSelectablePath,
  writeBrowserSelection as writeBrowserSelectionToConfig,
  type BrowserInventory,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type BrowserSource,
  type CapabilityEvidence,
  type CompatibilityEvidenceState,
  type CompatibilityResult,
  type ManagedInstallOutcome,
  type ManagedInstallService,
  type ProbeProfile,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';
import prompts from 'prompts';

import {
  addBrowserSelectionOptions,
  resolveBrowserSelectionOverride,
  type BrowserSelectionOptions,
} from '../browser-options.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface InstallOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
}

interface ListOptions {
  readonly json?: boolean;
}

interface UseOptions {
  readonly path?: string;
  readonly json?: boolean;
}

interface CheckOptions extends BrowserSelectionOptions {
  readonly json?: boolean;
}

export interface BrowserCommandRuntime {
  readonly service?: ManagedInstallService;
  /** Selection, compatibility, managed state, and the inventory projection. */
  readonly services?: BrowserRuntimeServices;
  /** Config writer boundary, injected so `use` tests never touch a real home. */
  readonly writeSelection?: typeof writeBrowserSelectionToConfig;
  readonly isTty?: () => boolean;
  readonly prompt?: typeof prompts;
  readonly destinationRoot?: () => string;
  readonly now?: () => Date;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

const APPROXIMATE_BYTES = 200 * 1024 * 1024;

const SOURCES: readonly BrowserSource[] = ['auto', 'managed', 'system'];

/** Creates the `yantra browser` command group. */
export function makeBrowserCommand(runtime: BrowserCommandRuntime = {}): Command {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const isTty = runtime.isTty ?? (() => process.stdin.isTTY === true);
  const prompt = runtime.prompt ?? prompts;
  const destinationRoot = runtime.destinationRoot ?? managedBrowsersRoot;
  const now = runtime.now ?? (() => new Date());
  const writeSelection = runtime.writeSelection ?? writeBrowserSelectionToConfig;

  // Composed lazily: building the command must not construct the acquisition
  // graph, and `--help` must not read the filesystem.
  let composed: BrowserRuntimeServices | undefined = runtime.services;
  const services = (): BrowserRuntimeServices => {
    composed ??= createLocalBrowserRuntimeServices();
    return composed;
  };
  const installService = (): ManagedInstallService => runtime.service ?? services().installService!;

  const browser = new Command('browser').description('Manage Yantra-owned browser installations');

  browser
    .command('install')
    .description('Download current Chrome for Testing Stable into Yantra-managed storage')
    .option('--yes', 'accept the download without prompting', false)
    .option('--json', 'emit exactly one JSON outcome', false)
    .action(async (options: InstallOptions) => {
      const destination = destinationRoot();
      if (options.yes !== true && (!isTty() || options.json === true)) {
        const message =
          '`yantra browser install --yes` is required for JSON or non-interactive use.';
        stderr.write(`${message}\n`);
        if (options.json)
          writeInstallJson(stdout, destination, {
            status: 'failed',
            error: {
              code: 'consent-required',
              phase: 'preflight',
              remediation: 'Pass --yes only after reviewing the download notice.',
              detail: message,
              retainedOrphan: null,
            },
          });
        throw new CommanderError(1, 'yantra.browser.install.consent-required', message);
      }

      stderr.write(
        `Chrome for Testing Stable will be downloaded to ${destination} (about 200 MB). Failed downloads restart from zero; external Chrome installations are untouched.\n`,
      );
      let granted = options.yes === true;
      if (!granted) {
        const answer = (await prompt({
          type: 'confirm',
          name: 'granted',
          message: 'Download managed Chrome?',
          initial: false,
        })) as { granted?: boolean };
        granted = answer.granted === true;
      }
      if (!granted) {
        const outcome = { status: 'cancelled', at: 'preflight', retainedOrphan: null } as const;
        if (options.json) writeInstallJson(stdout, destination, outcome);
        stderr.write('Browser download was declined; no installation state changed.\n');
        throw new CommanderError(
          4,
          'yantra.browser.install.declined',
          'Browser download was declined.',
        );
      }

      const outcome = await installService().install({
        trigger: 'explicit-command',
        consent: {
          granted: true,
          source: options.yes === true ? 'cli-accept-flag' : 'cli-prompt',
          grantedAt: now().toISOString(),
          destinationRoot: destination,
          approximateBytes: APPROXIMATE_BYTES,
        },
        onProgress: (event) =>
          stderr.write(
            `${event.phase}${event.percent === undefined ? '' : ` ${event.percent}%`}${event.interruptible ? '' : ' (finishing; cancellation pending)'}\n`,
          ),
      });

      if (options.json) {
        writeInstallJson(stdout, destination, outcome);
        if (outcome.status === 'failed')
          stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
        if (outcome.status === 'cancelled')
          stderr.write(`Browser installation was cancelled during ${outcome.at}.\n`);
      } else renderInstallTerminal(stdout, stderr, outcome);
      if (outcome.status === 'cancelled')
        throw new CommanderError(
          4,
          'yantra.browser.install.cancelled',
          'Browser installation was cancelled.',
        );
      if (outcome.status === 'failed')
        throw new CommanderError(
          exitCodeFor(outcome.error.code),
          `yantra.browser.install.${outcome.error.code}`,
          `${outcome.error.detail} ${outcome.error.remediation}`,
        );
    });

  browser
    .command('list')
    .description(
      'List the browsers Yantra can use on this machine, with the current selection. Local only: no network, launch, install, or update check',
    )
    .option('--json', 'emit the inventory as JSON', false)
    .action(async (options: ListOptions) => {
      const inventory = await readInventory(services());
      if (options.json === true) {
        stdout.write(`${JSON.stringify(browserListPayload(inventory))}\n`);
        return;
      }
      renderInventoryTerminal(stdout, inventory);
      // A broken selection is rendered as data and still exits 0: `list` is an
      // inventory, and failing is the job of a launching command and of `check`.
      if (inventory.effective.status === 'unavailable') {
        stderr.write(`${inventory.effective.error.remediation}\n`);
      }
    });

  browser
    .command('use')
    .description(
      'Select which browser Yantra launches and persist it. Validates the path; never launches a browser or checks for updates',
    )
    .argument('<source>', 'auto, managed, or system')
    .option('--path <absolute-executable>', 'custom external executable (only with `system`)')
    .option('--json', 'emit the committed selection as JSON', false)
    .action(async (rawSource: string, options: UseOptions) => {
      const source = rawSource.trim().toLowerCase();
      if (!SOURCES.includes(source as BrowserSource)) {
        return failUse(
          stderr,
          'invalid-source',
          `\`yantra browser use\` takes one of ${SOURCES.join(', ')}, not "${rawSource}".`,
        );
      }
      if (options.path !== undefined && source !== 'system') {
        return failUse(
          stderr,
          'path-not-allowed',
          `\`--path\` names one specific executable, which is only meaningful with \`system\`; \`${source}\` describes how to find a browser instead.`,
        );
      }

      let selection: BrowserSelection;
      if (options.path === undefined) {
        selection = { source: source as BrowserSource, executablePath: null };
      } else {
        // Resolvability, not compatibility: exists, regular file, readable, and
        // executable. `browser check` is what answers "does it work?".
        const validated = await validateSelectablePath(options.path);
        if (validated.status === 'invalid') {
          return failUse(
            stderr,
            `path-${validated.reason}`,
            `${validated.detail} ${validated.remediation}`,
          );
        }
        selection = { source: 'system', executablePath: validated.executablePath };
      }

      // Ownership and managed readiness come from the resolver, so `use` never
      // re-derives containment: a custom path inside the managed root is
      // managed-owned and has to be the exact ready executable.
      const resolution = await services().resolver.resolve(selection);
      if (resolution.status === 'unavailable' && source !== 'auto') {
        return failUse(stderr, resolution.error.code, resolution.error.message);
      }

      await writeSelection(selection);

      const installation = resolution.status === 'resolved' ? resolution.installation : null;
      const evidence: CompatibilityEvidenceState =
        installation === null
          ? { state: 'unverified' }
          : await services()
              .compatibility.readCached(installation, 'automation')
              .catch((): CompatibilityEvidenceState => ({ state: 'unverified' }));
      const compatibility = pairingLabel(evidence);
      const nextCommand = compatibility === 'unverified' ? checkCommandFor(selection) : null;

      if (options.json === true) {
        stdout.write(
          `${JSON.stringify({
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            kind: 'browser_use',
            status: 'set',
            source: selection.source,
            executablePath: installation?.canonicalPath ?? selection.executablePath,
            ownership: installation?.ownership ?? null,
            version: installation?.version ?? null,
            compatibility,
            nextCommand,
          })}\n`,
        );
        return;
      }

      if (installation === null) {
        stdout.write(`Browser selection is now ${selection.source}.\n`);
        if (resolution.status === 'unavailable')
          stderr.write(`No browser resolves yet: ${resolution.error.message}\n`);
      } else {
        stdout.write(
          `Browser selection is now ${selection.source}: ${installation.ownership} Chrome ${installation.version} at ${installation.canonicalPath}.\n`,
        );
      }
      stdout.write(`Compatibility: ${compatibility}.\n`);
      if (nextCommand !== null) stdout.write(`Run \`${nextCommand}\` to test it locally.\n`);
    });

  addBrowserSelectionOptions(
    browser
      .command('check')
      .description(
        'Run a fresh local compatibility check against the selected browser, using isolated synthetic pages. No network: this does not look for a newer browser',
      ),
  )
    .option('--json', 'emit the compatibility report as JSON', false)
    .action(async (options: CheckOptions) => {
      const override = resolveBrowserSelectionOverride(options);
      const resolution = await services().resolver.resolve(override);
      if (resolution.status === 'unavailable') {
        stderr.write(`${resolution.error.message}\n`);
        throw new CommanderError(
          3,
          `yantra.browser.check.${resolution.error.code}`,
          resolution.error.message,
        );
      }
      const installation = resolution.installation;

      const profiles: ProbeProfile[] = ['automation', 'recorder'];
      const results: CompatibilityResult[] = [];
      for (const profile of profiles) {
        // `fresh: true` is what makes this a diagnosis rather than a replay of
        // whatever was cached.
        results.push(await services().compatibility.check(installation, { profile, fresh: true }));
      }

      const report = buildCheckReport(installation, results);
      if (options.json === true) {
        stdout.write(
          `${JSON.stringify({
            schemaVersion: CLI_JSON_SCHEMA_VERSION,
            kind: 'browser_check',
            ...report,
          })}\n`,
        );
      } else {
        renderCheckTerminal(stdout, report);
      }

      const failure = results.find((result) => result.verdict.status === 'failed');
      if (failure?.verdict.status === 'failed') {
        stderr.write(`${failure.verdict.remediation}\n`);
        throw new CommanderError(
          3,
          `yantra.browser.check.${failure.verdict.failureClass}`,
          `This browser failed the required ${failure.profile} capabilities.`,
        );
      }
    });

  return browser;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Reads the shared inventory projection.
 *
 * A services bag without one is a hand-built test double; composing a local
 * projection over its own parts keeps `list` and `doctor` reading the same
 * builder rather than inventing a second view.
 */
function readInventory(services: BrowserRuntimeServices): Promise<BrowserInventory> {
  if (services.inventory !== undefined) return services.inventory.read();
  return new LocalBrowserInventoryService({
    resolver: services.resolver,
    managedState: services.managedState,
    compatibility: services.compatibility,
  }).read();
}

function browserListPayload(inventory: BrowserInventory): Record<string, unknown> {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    kind: 'browser_list',
    selection: {
      source: inventory.configured?.source ?? 'auto',
      executablePath: inventory.configured?.executablePath ?? null,
      origin:
        inventory.effective.status === 'resolved'
          ? inventory.effective.installation.selectionOrigin
          : inventory.configured === undefined
            ? 'default'
            : 'config',
    },
    effective:
      inventory.effective.status === 'resolved'
        ? {
            status: 'resolved',
            ownership: inventory.effective.installation.ownership,
            executablePath: inventory.effective.installation.canonicalPath,
            version: inventory.effective.installation.version,
            channel: inventory.effective.installation.channel,
            selectionReason: inventory.effective.installation.selectionReason,
            compatibility: pairingLabel(inventory.effective.compatibility),
            recorderCompatibility: pairingLabel(inventory.effective.recorderCompatibility),
          }
        : {
            status: 'unavailable',
            code: inventory.effective.error.code,
            message: inventory.effective.error.message,
            remediation: inventory.effective.error.remediation,
          },
    managed:
      inventory.managed.status === 'ready'
        ? { status: 'ready', buildId: inventory.managed.record.buildId }
        : inventory.managed.status === 'invalid'
          ? { status: 'invalid', reason: inventory.managed.reason }
          : { status: 'absent' },
    alternatives: inventory.alternatives,
    orphans: inventory.orphans,
    managedRoot: inventory.managedRoot,
    driver: inventory.driver,
  };
}

function renderInventoryTerminal(stream: NodeJS.WritableStream, inventory: BrowserInventory): void {
  const configured = inventory.configured;
  stream.write(
    `Selection: ${configured?.source ?? 'auto'}${
      configured === undefined ? ' (default — nothing configured)' : ' (config.yaml)'
    }${configured?.executablePath === null || configured?.executablePath === undefined ? '' : ` → ${configured.executablePath}`}\n`,
  );

  if (inventory.effective.status === 'resolved') {
    const { installation, compatibility, recorderCompatibility } = inventory.effective;
    stream.write(
      `Effective: ${installation.ownership} Chrome ${installation.version} at ${installation.canonicalPath} (${installation.selectionReason})\n`,
    );
    stream.write(`Compatibility: ${pairingLabel(compatibility)} (automation)`);
    stream.write(
      pairingLabel(recorderCompatibility) === pairingLabel(compatibility)
        ? '\n'
        : `, ${pairingLabel(recorderCompatibility)} (recorder)\n`,
    );
  } else {
    stream.write(`Effective: unavailable — ${inventory.effective.error.message}\n`);
  }

  stream.write(
    `Managed: ${
      inventory.managed.status === 'ready'
        ? `Chrome for Testing ${inventory.managed.record.buildId}`
        : inventory.managed.status === 'invalid'
          ? `unusable (${inventory.managed.reason})`
          : 'not installed'
    } under ${inventory.managedRoot}\n`,
  );

  if (inventory.alternatives.length === 0) {
    stream.write('Browsers found: none\n');
  } else {
    stream.write('Browsers found:\n');
    for (const entry of inventory.alternatives) {
      stream.write(
        `  ${entry.isEffective ? '*' : ' '} ${entry.ownership.padEnd(8)} ${entry.version ?? 'unknown version'}  ${entry.executablePath}\n`,
      );
    }
  }

  stream.write(
    `Reclaimable: ${inventory.orphans.count} superseded installation(s), ${formatBytes(inventory.orphans.reclaimableBytes)}\n`,
  );
  stream.write(
    `Driver: puppeteer-core ${inventory.driver.version} (tested against Chrome ${inventory.driver.testedBuild})\n`,
  );
}

// ---------------------------------------------------------------------------
// Compatibility report
// ---------------------------------------------------------------------------

/** One capability row plus the descriptor's own justification for it. */
export interface BrowserCheckCapabilityRow extends CapabilityEvidence {
  readonly why: string;
}

export interface BrowserCheckReport {
  readonly driverVersion: string;
  readonly testedBuild: string;
  readonly probeRevision: number;
  readonly browser: {
    readonly executablePath: string;
    readonly version: string;
    readonly ownership: 'managed' | 'external';
    readonly selectionOrigin: ResolvedBrowserInstallation['selectionOrigin'];
  };
  readonly profiles: readonly {
    readonly profile: ProbeProfile;
    readonly verdict: CompatibilityResult['verdict'];
    readonly capabilities: readonly BrowserCheckCapabilityRow[];
  }[];
}

function buildCheckReport(
  installation: ResolvedBrowserInstallation,
  results: readonly CompatibilityResult[],
): BrowserCheckReport {
  const first = results[0]!;
  return {
    driverVersion: first.driverVersion,
    testedBuild: first.testedBuild,
    probeRevision: first.probeRevision,
    browser: {
      executablePath: installation.canonicalPath,
      version: installation.version,
      ownership: installation.ownership,
      selectionOrigin: installation.selectionOrigin,
    },
    profiles: results.map((result) => ({
      profile: result.profile,
      verdict: result.verdict,
      // Rendered verbatim from the declared capability table: the CLI must not
      // keep its own copy of why each primitive is required.
      capabilities: result.capabilities.map((evidence) => ({
        ...evidence,
        why:
          requiredCapabilities(result.profile).find((row) => row.id === evidence.capability)?.why ??
          '',
      })),
    })),
  };
}

function renderCheckTerminal(stream: NodeJS.WritableStream, report: BrowserCheckReport): void {
  stream.write(
    `Browser: ${report.browser.ownership} Chrome ${report.browser.version} at ${report.browser.executablePath} (selected by ${report.browser.selectionOrigin})\n`,
  );
  stream.write(
    `Driver:  puppeteer-core ${report.driverVersion}, tested against Chrome ${report.testedBuild}, probe revision ${report.probeRevision}\n\n`,
  );

  for (const profile of report.profiles) {
    stream.write(`${profile.profile}:\n`);
    for (const row of profile.capabilities) {
      const mark = row.status === 'passed' ? 'pass' : row.status === 'failed' ? 'FAIL' : 'skip';
      stream.write(`  [${mark}] ${row.capability} — ${row.why}\n`);
      if (row.reason !== null) stream.write(`         ${row.reason}\n`);
    }
    if (profile.verdict.status === 'passed') {
      // `capability-checked` is the steady state, not a warning: Chrome ships
      // Stable faster than this repository bumps Puppeteer.
      stream.write(
        `  → passed (${profile.verdict.pairing === 'tested' ? 'this is the tested pairing' : 'capability-checked against this exact build'})\n\n`,
      );
    } else {
      stream.write(`  → failed (${profile.verdict.failureClass})\n\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** What `list`, `use`, and `doctor` all call the local evidence. */
function pairingLabel(
  evidence: CompatibilityEvidenceState,
): 'tested' | 'capability-checked' | 'unverified' {
  if (evidence.state !== 'evidence') return 'unverified';
  return evidence.result.verdict.status === 'passed'
    ? evidence.result.verdict.pairing
    : 'unverified';
}

/** The exact command to run, matching the selection that was just committed. */
function checkCommandFor(selection: BrowserSelection): string {
  if (selection.source === 'system' && selection.executablePath !== null) {
    return `yantra browser check --browser-path ${selection.executablePath}`;
  }
  return 'yantra browser check';
}

function failUse(stream: NodeJS.WritableStream, code: string, message: string): never {
  stream.write(`${message}\n`);
  throw new CommanderError(1, `yantra.browser.use.${code}`, message);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function writeInstallJson(
  stream: NodeJS.WritableStream,
  destinationRoot: string,
  outcome: ManagedInstallOutcome,
): void {
  stream.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'browser_install', destinationRoot, outcome })}\n`,
  );
}

function renderInstallTerminal(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  outcome: ManagedInstallOutcome,
): void {
  if (outcome.status === 'installed') {
    stdout.write(
      `Installed managed Chrome ${outcome.record.buildId} at ${outcome.executablePath}.\n`,
    );
    if (!outcome.selection.selectsThisInstallation && outcome.selection.command)
      stderr.write(`This installation is not selected. Run ${outcome.selection.command}.\n`);
  } else if (outcome.status === 'already-installed') {
    stdout.write(
      `Managed Chrome ${outcome.record.buildId} is already installed at ${outcome.executablePath}. To replace it, run ${outcome.updateCommand}.\n`,
    );
  } else if (outcome.status === 'cancelled') {
    stderr.write(
      `Browser installation was cancelled during ${outcome.at}; an interrupted download restarts from zero.\n`,
    );
  } else {
    stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
  }
}

function exitCodeFor(
  code: Extract<ManagedInstallOutcome, { status: 'failed' }>['error']['code'],
): number {
  return code === 'consent-required' ? 1 : 3;
}
