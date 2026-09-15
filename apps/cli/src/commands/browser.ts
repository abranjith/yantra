/**
 * `yantra browser` — the local browser selection and diagnostics surface.
 *
 * Five subcommands, and the boundary between them is what each one is allowed to
 * do rather than what it reports:
 *
 * - `install` downloads Chrome for Testing Stable with explicit consent.
 * - `list` is a pure local inventory: no network, no launch, no install.
 * - `use` writes exactly two config keys and launches nothing — setting a
 *   preference must never cost a browser start, and must not fail on a host
 *   where starting one is the broken thing.
 * - `check` runs a fresh isolated compatibility probe and writes only the local
 *   evidence cache.
 * - `update` is the *only* surface that ever asks whether a newer Chrome
 *   exists. `--dry-run` reports availability and changes nothing; without it,
 *   the command replaces the managed installation with recorded consent.
 *
 * `check` and `update --dry-run` are deliberate opposites — a local probe with
 * no network, and an availability query with no download — and the help text of
 * each has to say which it is, because one word meaning two opposite things
 * inside one noun namespace is exactly what makes a command surface unreadable.
 */
import {
  compareManagedBuild,
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
  type ManagedUpdateAvailability,
  type ManagedUpdateOutcome,
  type ManagedUpdateService,
  type ProbeProfile,
  type ResolvedBrowserInstallation,
  type StableBuild,
  type UpdateComparison,
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

interface UpdateOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

export interface BrowserCommandRuntime {
  readonly service?: ManagedInstallService;
  /** The only update surface, injected so tests never reach a real network. */
  readonly updateService?: ManagedUpdateService;
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
  const updateService = (): ManagedUpdateService =>
    runtime.updateService ?? services().updateService!;

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
          // A first install resolves Stable in-helper and replaces nothing.
          // Only an update can name a build before it is acquired.
          targetBuildId: null,
          replaces: null,
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

  browser
    .command('update')
    .description(
      'Replace the Yantra-managed browser with current Chrome for Testing Stable. This is the only command that checks whether a newer browser exists; use --dry-run to report availability and download nothing',
    )
    .option('--dry-run', 'report what is available without downloading or changing anything', false)
    .option('--yes', 'accept the replacement without prompting', false)
    .option('--json', 'emit exactly one JSON outcome', false)
    .action(async (options: UpdateOptions) => {
      // Two modes, not a mode plus a modifier. `--yes` accepts a replacement,
      // and the availability report has no replacement to accept: an acceptance
      // flag that changes nothing is a dead control, so it is refused rather
      // than silently ignored.
      if (options.dryRun === true && options.yes === true) {
        const message =
          '`--dry-run` reports availability and changes nothing, so there is nothing for `--yes` to accept. Use one or the other.';
        stderr.write(`${message}\n`);
        throw new CommanderError(1, 'yantra.browser.update.conflicting-modes', message);
      }

      if (options.dryRun === true) {
        await runDryRun(options);
        return;
      }
      await runReplacement(options);
    });

  return browser;

  // -------------------------------------------------------------------------
  // `browser update --dry-run`
  // -------------------------------------------------------------------------

  /**
   * Availability only.
   *
   * Nothing in this branch downloads, installs, replaces, launches, collects
   * orphans, writes the ready pointer, writes config, or asks for consent — a
   * `--dry-run` run has to leave the data root, the cache root, and
   * `config.yaml` byte-identical, and that is asserted by comparison rather
   * than taken on this comment's word.
   */
  async function runDryRun(options: UpdateOptions): Promise<void> {
    const availability = await updateService().checkAvailability();

    if (options.json === true) {
      stdout.write(`${JSON.stringify(updatePayload(true, availability, null))}\n`);
    } else {
      renderAvailabilityTerminal(stdout, availability);
    }

    if (availability.comparison.state === 'metadata-unavailable') {
      const { error } = availability.comparison;
      stderr.write(
        `${error.detail} ${error.remediation} The installed managed browser is unaffected and still usable offline.\n`,
      );
      throw new CommanderError(3, `yantra.browser.update.${error.code}`, error.detail);
    }
    // Every comparison state is a legitimate availability answer, including
    // "nothing is installed". Exit 0.
  }

  // -------------------------------------------------------------------------
  // `browser update`
  // -------------------------------------------------------------------------

  async function runReplacement(options: UpdateOptions): Promise<void> {
    const service = updateService();

    // Order matters: local preconditions first, so a refusal never costs a
    // metadata call, and a busy refusal never costs a 200 MB download.
    const preflight = await service.preflightMutation();
    if (preflight.status === 'refused') {
      const { error } = preflight;
      if (options.json === true)
        stdout.write(
          `${JSON.stringify(updatePayload(false, null, { status: 'failed', error, record: { status: 'absent' } }))}\n`,
        );
      stderr.write(`${error.detail} ${error.remediation}\n`);
      throw new CommanderError(3, `yantra.browser.update.${error.code}`, error.detail);
    }
    const installed = preflight.record;

    // Resolved exactly once, before consent, and never re-resolved: the build
    // the user accepts is the build that lands.
    const resolution = await service.resolveTarget();
    if (resolution.status === 'unavailable') {
      const { error } = resolution;
      if (options.json === true)
        stdout.write(
          `${JSON.stringify(
            updatePayload(false, null, {
              status: 'failed',
              error,
              record: { status: 'ready', record: installed },
            }),
          )}\n`,
        );
      stderr.write(
        `${error.detail} ${error.remediation} Managed Chrome ${installed.buildId} is unaffected and still usable offline.\n`,
      );
      throw new CommanderError(3, `yantra.browser.update.${error.code}`, error.detail);
    }
    const target = resolution.build;

    // Core owns the ordering grammar. The CLI must not compare build strings of
    // its own: a string compare puts `…8010.36` before `…8010.9` and would
    // refuse a real update, and a second grammar beside the one that owns it is
    // silent divergence rather than redundancy.
    const comparison = compareManagedBuild({ status: 'ready', record: installed }, target);
    if (comparison.state === 'up-to-date' || comparison.state === 'installed-newer') {
      emitNoOp(options, comparison.state, installed.buildId, target);
      return;
    }

    stderr.write(
      `Managed Chrome ${installed.buildId} would be replaced by Chrome for Testing Stable ${target.buildId} in ${destinationRoot()} (about 200 MB).\n` +
        'An interrupted transfer restarts from zero — there is no resume. External Chrome installations are untouched.\n',
    );

    if (options.yes !== true && (!isTty() || options.json === true)) {
      const message = '`yantra browser update --yes` is required for JSON or non-interactive use.';
      stderr.write(`${message}\n`);
      if (options.json === true)
        stdout.write(
          `${JSON.stringify(
            updatePayload(false, null, {
              status: 'failed',
              error: {
                code: 'consent-required',
                phase: 'preflight',
                remediation: 'Pass --yes only after reviewing the replacement notice.',
                detail: message,
                retainedOrphan: null,
              },
              record: { status: 'ready', record: installed },
            }),
          )}\n`,
        );
      throw new CommanderError(1, 'yantra.browser.update.consent-required', message);
    }

    let granted = options.yes === true;
    if (!granted) {
      const answer = (await prompt({
        type: 'confirm',
        name: 'granted',
        message: `Replace managed Chrome ${installed.buildId} with ${target.buildId}?`,
        initial: false,
      })) as { granted?: boolean };
      granted = answer.granted === true;
    }
    if (!granted) {
      stderr.write('Browser replacement was declined; no installation state changed.\n');
      throw new CommanderError(
        4,
        'yantra.browser.update.declined',
        'Browser replacement was declined.',
      );
    }

    const outcome = await service.update({
      consent: {
        granted: true,
        source: options.yes === true ? 'cli-accept-flag' : 'cli-update-prompt',
        grantedAt: now().toISOString(),
        destinationRoot: destinationRoot(),
        approximateBytes: APPROXIMATE_BYTES,
        targetBuildId: target.buildId,
        replaces: installed.buildId,
      },
      target,
      onProgress: (event) =>
        stderr.write(
          `${event.phase}${event.percent === undefined ? '' : ` ${event.percent}%`}${event.interruptible ? '' : ' (finishing; cancellation pending)'}\n`,
        ),
    });

    if (options.json === true) {
      stdout.write(`${JSON.stringify(updatePayload(false, null, outcome))}\n`);
      if (outcome.status === 'failed')
        stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
      if (outcome.status === 'cancelled')
        stderr.write(
          `Browser replacement was cancelled during ${outcome.at}; managed Chrome ${outcome.record.buildId} is unchanged.\n`,
        );
    } else {
      renderUpdateTerminal(stdout, stderr, outcome);
    }

    if (outcome.status === 'cancelled')
      throw new CommanderError(
        4,
        'yantra.browser.update.cancelled',
        'Browser replacement was cancelled.',
      );
    if (outcome.status === 'failed')
      throw new CommanderError(
        // Both acceptance failures are validation: consent was absent, or it
        // named a build other than the one that was resolved. Everything else
        // is an environment failure.
        outcome.error.code === 'consent-required' || outcome.error.code === 'consent-build-mismatch'
          ? 1
          : 3,
        `yantra.browser.update.${outcome.error.code}`,
        `${outcome.error.detail} ${outcome.error.remediation}`,
      );
  }

  /** Renders a no-op verdict identically in both modes and exits 0. */
  function emitNoOp(
    options: UpdateOptions,
    status: 'up-to-date' | 'installed-newer',
    installedBuildId: string,
    target: StableBuild,
  ): void {
    if (options.json === true) {
      stdout.write(
        `${JSON.stringify({
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          kind: 'browser_update',
          dryRun: false,
          destinationRoot: destinationRoot(),
          outcome: { status, installedBuildId, available: target },
        })}\n`,
      );
      return;
    }
    stdout.write(
      status === 'up-to-date'
        ? `Managed Chrome ${installedBuildId} is current Chrome for Testing Stable. Nothing to do.\n`
        : `Managed Chrome ${installedBuildId} is newer than current Stable ${target.buildId}. Leaving it in place — Yantra never downgrades.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Update rendering
// ---------------------------------------------------------------------------

/** The one `browser_update` envelope, marking its mode exactly as `config data-dir` does. */
function updatePayload(
  dryRun: boolean,
  availability: ManagedUpdateAvailability | null,
  outcome: ManagedUpdateOutcome | null,
): Record<string, unknown> {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    kind: 'browser_update',
    dryRun,
    ...(availability === null
      ? {}
      : {
          managedRoot: availability.managedRoot,
          driver: availability.driver,
          concurrentOperation: availability.concurrentOperation,
          activeManagedRun: availability.activeManagedRun,
          nextCommand: availability.nextCommand,
          comparison: comparisonPayload(availability.comparison),
        }),
    ...(outcome === null ? {} : { outcome }),
  };
}

function comparisonPayload(comparison: UpdateComparison): Record<string, unknown> {
  if (comparison.state === 'metadata-unavailable') {
    return {
      state: comparison.state,
      installed:
        comparison.installed.status === 'ready'
          ? { status: 'ready', buildId: comparison.installed.record.buildId }
          : comparison.installed,
      available: null,
      error: comparison.error,
    };
  }
  return {
    state: comparison.state,
    installed:
      comparison.state === 'no-installation'
        ? null
        : { status: 'ready', buildId: comparison.installed.buildId },
    available: comparison.available,
    ...(comparison.state === 'no-installation'
      ? { installCommand: comparison.installCommand }
      : {}),
  };
}

function renderAvailabilityTerminal(
  stream: NodeJS.WritableStream,
  availability: ManagedUpdateAvailability,
): void {
  const { comparison } = availability;
  const installedLabel =
    comparison.state === 'no-installation'
      ? 'absent'
      : comparison.state === 'metadata-unavailable'
        ? comparison.installed.status === 'ready'
          ? `Chrome for Testing ${comparison.installed.record.buildId}`
          : 'absent'
        : `Chrome for Testing ${comparison.installed.buildId}`;

  stream.write(`Installed: ${installedLabel}\n`);
  stream.write(
    `Available: ${
      comparison.state === 'metadata-unavailable'
        ? 'unknown — Stable metadata could not be resolved'
        : `Chrome for Testing Stable ${comparison.available.buildId}${comparison.available.artifactAvailable ? '' : ' (no downloadable artifact for this platform)'}`
    }\n`,
  );
  stream.write(`Verdict:   ${verdictProse(comparison)}\n`);
  stream.write(`Managed root: ${availability.managedRoot}\n`);
  stream.write(
    `Driver: puppeteer-core ${availability.driver.version} (tested against Chrome ${availability.driver.testedBuild})\n`,
  );
  if (availability.activeManagedRun)
    stream.write(
      'A managed browser is running, so a replacement would be refused until it exits.\n',
    );
  if (availability.concurrentOperation)
    stream.write('Another managed browser operation is in progress.\n');
  if (availability.nextCommand !== null) stream.write(`Next: ${availability.nextCommand}\n`);
  stream.write('Nothing was downloaded, installed, or changed.\n');
}

function verdictProse(comparison: UpdateComparison): string {
  switch (comparison.state) {
    case 'no-installation':
      return 'no managed browser is installed yet';
    case 'up-to-date':
      return 'the managed browser is current';
    case 'update-available':
      return 'a newer Stable build is available';
    case 'installed-newer':
      return 'the installed build is newer than current Stable; Yantra never downgrades';
    default:
      return 'availability could not be determined';
  }
}

function renderUpdateTerminal(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  outcome: ManagedUpdateOutcome,
): void {
  if (outcome.status === 'replaced') {
    stdout.write(
      `Replaced managed Chrome ${outcome.previousBuildId} with ${outcome.record.buildId} at ${outcome.executablePath}.\n`,
    );
    if (outcome.compatibility.verdict.status === 'passed') {
      // Ordinary provenance, never a warning: Chrome ships Stable faster than
      // this repository bumps Puppeteer, so this is the normal state.
      stdout.write(
        `Compatibility: ${outcome.compatibility.verdict.pairing === 'tested' ? 'this is the tested pairing' : 'capability-checked against this exact build'}.\n`,
      );
    }
    stdout.write(
      `Reclaimed ${outcome.orphans.deleted} superseded installation(s), ${formatBytes(outcome.orphans.bytesReclaimed)}.\n`,
    );
    if (!outcome.selection.selectsThisInstallation && outcome.selection.command !== null)
      stderr.write(`This installation is not selected. Run ${outcome.selection.command}.\n`);
    return;
  }
  if (outcome.status === 'up-to-date') {
    stdout.write(
      `Managed Chrome ${outcome.record.buildId} is current Chrome for Testing Stable. Nothing to do.\n`,
    );
    return;
  }
  if (outcome.status === 'installed-newer') {
    stdout.write(
      `Managed Chrome ${outcome.record.buildId} is newer than current Stable ${outcome.available.buildId}. Leaving it in place — Yantra never downgrades.\n`,
    );
    return;
  }
  if (outcome.status === 'cancelled') {
    stderr.write(
      `Browser replacement was cancelled during ${outcome.at}; managed Chrome ${outcome.record.buildId} is unchanged and an interrupted download restarts from zero.\n`,
    );
    return;
  }
  stderr.write(`${outcome.error.detail} ${outcome.error.remediation}\n`);
  if (outcome.record.status === 'ready')
    stderr.write(
      `Managed Chrome ${outcome.record.record.buildId} is unchanged and still usable.\n`,
    );
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
