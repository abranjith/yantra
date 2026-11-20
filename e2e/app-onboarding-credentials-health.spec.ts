/// <reference lib="dom" />
/**
 * @no-llm Onboarding, Health & Credentials end-to-end (FEAT-071 TASK-010).
 *
 * Exercises the built app and host with real Chrome (`puppeteer-core`), a
 * sandboxed `YANTRA_HOME`, an in-memory fake keychain injected at the host
 * boundary, and a local fake OpenAI-completions provider for `doctor --agent-smoke`:
 *
 * 1. Fresh home opens `/onboarding`; completing it produces `config.yaml` and
 *    `profile.yaml` byte-identical to terminal `init` for the same answers.
 * 2. `/settings/credentials` lists names only, sets a new canary, and removes
 *    both unreferenced and referenced credentials with confirmation.
 * 3. `/health` renders every `yantra doctor --json` check, navigates via the
 *    search-key remediation, and runs the provider smoke test through a real
 *    detached worker against the local fake provider.
 * 4. Outbound canary scan across host-to-app WebSocket frames, HTTP responses,
 *    `host.log`, `run-events.jsonl`, `execution-receipt.json`, and the smoke
 *    run directory finds zero canary occurrences.
 * 5. Argv scan across `supervisor.spawn` invocations and OS process command
 *    lines finds zero canary occurrences.
 * 6. `/onboarding`, `/settings/credentials`, and `/health` are axe-clean.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openHostLog, spawnDetachedWorker, startHostRuntime, type RunningHost } from '@yantra/cli';
import {
  collectInitContextGrants,
  collectInitProviderAnswers,
  currentProcessIdentity,
  dataDir,
  hostLogPath,
  resetPathCache,
  runInit,
  workerLaunchRoot,
  yantraVersion,
  type KeychainProvider,
} from '@yantra/core';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchGalleryBrowser } from './drshya/browser.js';
import { runAxe } from './drshya/capture.js';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');
const ASSETS_ROOT = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'web');
const CHROME_TIMEOUT = 90_000;

const CANARY_ANTHROPIC = 'CANARY-ONBOARDING-ANTHROPIC-001';
const CANARY_TAVILY = 'CANARY-ONBOARDING-TAVILY-002';
const CANARY_CREDENTIAL = 'CANARY-CREDENTIALS-SET-003';
const ALL_CANARIES = [CANARY_ANTHROPIC, CANARY_TAVILY, CANARY_CREDENTIAL] as const;

function makeFakeKeychain(): KeychainProvider & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: () => Promise.resolve(true),
    get: (_service, account) => Promise.resolve(store.get(account) ?? null),
    set: (_service, account, value) => {
      store.set(account, value);
      return Promise.resolve();
    },
    delete: (_service, account) => Promise.resolve(store.delete(account)),
    list: () => Promise.resolve([...store.keys()].map((account) => ({ account }))),
  };
}

interface FakeProviderServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Local fake OpenAI-completions server for `doctor --agent-smoke`:
 * - Turn 1: calls the `status` tool.
 * - Turn 2 (after tool result): returns a short completion.
 */
async function startFakeProviderServer(): Promise<FakeProviderServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let hasToolResult: boolean;
      try {
        const parsed = JSON.parse(bodyText) as { messages?: { role?: string }[] };
        hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
      } catch {
        res.writeHead(400).end();
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });

      const sendChunk = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      if (!hasToolResult) {
        sendChunk({
          id: 'chatcmpl-smoke-1',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'llama3.1:8b',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_smoke_status',
                    type: 'function',
                    function: { name: 'status', arguments: '{}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sendChunk({
          id: 'chatcmpl-smoke-1',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'llama3.1:8b',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        sendChunk({
          id: 'chatcmpl-smoke-2',
          object: 'chat.completion.chunk',
          created: 1700000001,
          model: 'llama3.1:8b',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Smoke check ok.' },
              finish_reason: null,
            },
          ],
        });
        sendChunk({
          id: 'chatcmpl-smoke-2',
          object: 'chat.completion.chunk',
          created: 1700000001,
          model: 'llama3.1:8b',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

function collectFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) results.push(...collectFilesRecursive(full));
    else results.push(full);
  }
  return results;
}

function listOsProcessCommandLines(): string {
  if (process.platform === 'win32') {
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return '';
  }
}

async function clickButtonByText(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate((targetLabel) => {
    const buttons = [...document.querySelectorAll('button')];
    const match = buttons.find((btn) => (btn.textContent ?? '').trim() === targetLabel);
    if (!match || match.disabled) return false;
    match.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Button "${label}" not found or disabled`);
}

async function selectRadioByLabel(page: Page, labelText: string): Promise<void> {
  const selected = await page.evaluate((target) => {
    const labels = [...document.querySelectorAll('label')];
    for (const label of labels) {
      if ((label.textContent ?? '').trim().startsWith(target)) {
        const input = label.querySelector<HTMLInputElement>('input[type="radio"]');
        if (input && !input.disabled) {
          input.click();
          return true;
        }
      }
    }
    return false;
  }, labelText);
  if (!selected) throw new Error(`Radio option "${labelText}" not found or disabled`);
}

async function typeIntoPasswordField(page: Page, value: string): Promise<void> {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].some(
        (el) => el.offsetParent !== null && !el.disabled,
      ),
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].find(
      (el) => el.offsetParent !== null && !el.disabled,
    );
    if (!visible) throw new Error('Visible password field not found');
    visible.focus();
    visible.value = '';
  });
  await page.keyboard.type(value);
}

describe('@no-llm App Onboarding, Health & Credentials end-to-end (FEAT-071 TASK-010)', () => {
  let home = '';
  let terminalHome = '';
  let host: RunningHost | undefined;
  let hostLog: ReturnType<typeof openHostLog> | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;
  let fakeProvider: FakeProviderServer | undefined;

  const keychain = makeFakeKeychain();
  const outboundWsFrames: string[] = [];
  const outboundHttpTexts: string[] = [];
  const recordedWorkerArgvs: (readonly string[])[] = [];
  const observedOsCmdLines: string[] = [];
  const originalYantraHome = process.env.YANTRA_HOME;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'yantra-e2e-071-app-'));
    terminalHome = mkdtempSync(join(tmpdir(), 'yantra-e2e-071-term-'));
    fakeProvider = await startFakeProviderServer();

    process.env.YANTRA_HOME = home;
    resetPathCache();

    hostLog = openHostLog(hostLogPath());
    const identity = await currentProcessIdentity();
    const envForHost: NodeJS.ProcessEnv = {
      ...process.env,
      YANTRA_HOME: home,
      OLLAMA_API_KEY: 'local-fake-ollama',
    };
    delete envForHost.LLM_PROVIDER;

    host = await startHostRuntime({
      assetsRoot: ASSETS_ROOT,
      identity,
      yantraVersion: yantraVersion(),
      logger: hostLog.logger,
      env: envForHost,
      cwd: dataDir(),
      keychain,
      supervisor: {
        spawn: (launch) => {
          recordedWorkerArgvs.push(launch.invocation.argv);
          const child = spawnDetachedWorker({
            launch,
            launchDir: workerLaunchRoot(),
            env: envForHost,
          });
          observedOsCmdLines.push(listOsProcessCommandLines());
          return child;
        },
      },
    });

    browser = await launchGalleryBrowser();
    page = await browser.newPage();
    cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', (event) => {
      outboundWsFrames.push(event.response.payloadData);
    });
    page.on('response', (response) => {
      outboundHttpTexts.push(JSON.stringify(response.headers()));
      const ct = response.headers()['content-type'] ?? '';
      if (ct.includes('json') || ct.includes('text')) {
        void response
          .text()
          .then((text) => {
            outboundHttpTexts.push(text);
          })
          .catch(() => undefined);
      }
    });
  }, CHROME_TIMEOUT);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {
      // Best-effort cleanup.
    }
    try {
      await host?.stop();
    } catch {
      // Best-effort cleanup.
    }
    hostLog?.flush();
    try {
      await fakeProvider?.close();
    } catch {
      // Best-effort cleanup.
    }
    if (originalYantraHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = originalYantraHome;
    resetPathCache();
    if (home !== '') rmSync(home, { recursive: true, force: true });
    if (terminalHome !== '') rmSync(terminalHome, { recursive: true, force: true });
  }, 30_000);

  it(
    'completes onboarding byte-identical to terminal init, manages write-only credentials, runs Health checks & smoke, and passes canary/argv scans',
    async () => {
      if (!host || !page || !fakeProvider) throw new Error('Test fixture not initialized');

      const { code } = host.sessions.issueLaunchCode();
      await page.goto(`http://127.0.0.1:${String(host.port)}/#code=${encodeURIComponent(code)}`, {
        waitUntil: 'networkidle2',
      });

      // Fresh home routes to /onboarding automatically.
      await page.waitForFunction(() => window.location.pathname === '/onboarding', {
        timeout: 20_000,
      });
      await page.waitForSelector('h1', { timeout: 15_000 });
      expect(await runAxe(page, 'main')).toEqual([]);

      // Step 1: Model (anthropic, keychain, canary secret, default model claude-opus-4-7).
      await selectRadioByLabel(page, 'anthropic');
      await selectRadioByLabel(page, 'keychain');
      await typeIntoPasswordField(page, CANARY_ANTHROPIC);
      await clickButtonByText(page, 'Next');

      // Step 2: Search (tavily, canary secret).
      await selectRadioByLabel(page, 'tavily');
      await typeIntoPasswordField(page, CANARY_TAVILY);
      await clickButtonByText(page, 'Next');

      // Step 3: Storage (read-only).
      await clickButtonByText(page, 'Next');

      // Step 4: Context (decline location).
      await selectRadioByLabel(page, 'No');
      await clickButtonByText(page, 'Next');

      // Step 5: Review & Submit.
      await clickButtonByText(page, 'Finish setup');
      await page.waitForFunction(
        () => document.body.textContent?.includes('Setup complete') ?? false,
        { timeout: 15_000 },
      );

      // Run terminal init in a second sandboxed home with identical answers and byte-compare.
      const termKeychain = makeFakeKeychain();
      process.env.YANTRA_HOME = terminalHome;
      resetPathCache();
      const termSelects = ['anthropic', 'keychain', 'tavily'];
      const termTexts = ['claude-opus-4-7', ''];
      const termPasswords = [CANARY_ANTHROPIC, CANARY_TAVILY];
      await runInit(
        { reset: false, yes: false, interactive: true },
        {
          providerAnswers: () =>
            collectInitProviderAnswers({
              select: () => Promise.resolve(termSelects.shift() ?? null),
              text: () => Promise.resolve(termTexts.shift() ?? null),
              password: () => Promise.resolve(termPasswords.shift() ?? null),
              keychain: () => Promise.resolve(termKeychain),
            }),
          contextGrants: () =>
            collectInitContextGrants({
              confirm: () => Promise.resolve(false),
              text: () => Promise.resolve(''),
            }),
        },
      );
      process.env.YANTRA_HOME = home;
      resetPathCache();

      const appConfigText = readFileSync(join(home, 'config.yaml'), 'utf8');
      const termConfigText = readFileSync(join(terminalHome, 'config.yaml'), 'utf8');
      expect(appConfigText).toBe(termConfigText);

      const appProfileText = readFileSync(join(home, 'profile.yaml'), 'utf8');
      const termProfileText = readFileSync(join(terminalHome, 'profile.yaml'), 'utf8');
      expect(appProfileText).toBe(termProfileText);

      // Navigate to Credentials (/settings/credentials).
      await page.goto(`http://127.0.0.1:${String(host.port)}/settings/credentials`, {
        waitUntil: 'networkidle2',
      });
      await page.waitForFunction(
        () => document.body.textContent?.includes('anthropic.api_key') ?? false,
        { timeout: 15_000 },
      );
      expect(await runAxe(page, 'main')).toEqual([]);
      const credPageText = await page.evaluate(() => document.body.textContent ?? '');
      for (const canary of ALL_CANARIES) {
        expect(credPageText).not.toContain(canary);
      }

      // Set a new canary credential via Set credential dialog.
      await clickButtonByText(page, 'Set credential');
      await page.waitForSelector('input[type="password"]', { timeout: 10_000 });
      await page.evaluate(() => {
        const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')];
        const keyInput = inputs.at(-1);
        if (!keyInput) throw new Error('Key input not found');
        keyInput.focus();
      });
      await page.keyboard.type('custom.test_key');
      await typeIntoPasswordField(page, CANARY_CREDENTIAL);
      await clickButtonByText(page, 'Store credential');
      await page.waitForFunction(
        () => document.body.textContent?.includes('custom.test_key') ?? false,
        { timeout: 15_000 },
      );

      // Remove custom.test_key (unreferenced -> single confirm).
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr')];
        const row = rows.find((r) => (r.textContent ?? '').includes('custom.test_key'));
        const btn = [...(row?.querySelectorAll('button') ?? [])].find(
          (b) => (b.textContent ?? '').trim() === 'Remove',
        );
        if (!btn) throw new Error('Remove button for custom.test_key not found');
        btn.click();
      });
      await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
      await clickButtonByText(page, 'Remove credential');
      await page.waitForFunction(
        () => !(document.body.textContent ?? '').includes('custom.test_key'),
        { timeout: 15_000 },
      );

      // Remove anthropic.api_key (referenced -> requires explicit confirmation checkbox).
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr')];
        const row = rows.find((r) => (r.textContent ?? '').includes('anthropic.api_key'));
        const btn = [...(row?.querySelectorAll('button') ?? [])].find(
          (b) => (b.textContent ?? '').trim() === 'Remove',
        );
        if (!btn) throw new Error('Remove button for anthropic.api_key not found');
        btn.click();
      });
      await page.waitForSelector('input[type="checkbox"]', { timeout: 10_000 });
      await page.click('input[type="checkbox"]');
      await clickButtonByText(page, 'Remove credential');
      await page.waitForFunction(() => !document.querySelector('[role="alertdialog"]'), {
        timeout: 15_000,
      });

      // Navigate to Health (/health) and compare row count to `yantra doctor --json`.
      await page.goto(`http://127.0.0.1:${String(host.port)}/health`, {
        waitUntil: 'networkidle2',
      });
      await page.waitForSelector('[data-testid="health-checks"] > *', { timeout: 15_000 });
      expect(await runAxe(page, 'main')).toEqual([]);

      const doctorCli = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
        env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none' },
        encoding: 'utf8',
      });
      expect(doctorCli.status).toBe(0);
      const doctorJson = JSON.parse(doctorCli.stdout) as { checks: unknown[] };
      const renderedCheckCount = await page.evaluate(
        () => document.querySelectorAll('[data-testid="health-checks"] > *').length,
      );
      expect(renderedCheckCount).toBe(doctorJson.checks.length);

      // Remove tavily.api_key so Health offers the search-key remediation, then click it.
      await keychain.delete('yantra', 'tavily.api_key');
      await clickButtonByText(page, 'Re-run checks');
      await page.waitForFunction(
        () => document.body.textContent?.includes('Add Tavily key') ?? false,
        { timeout: 15_000 },
      );
      await clickButtonByText(page, 'Add Tavily key');
      await page.waitForFunction(() => window.location.pathname === '/settings/credentials', {
        timeout: 10_000,
      });

      // Configure ollama pointing to our local fake provider, reload /health, and run smoke test.
      writeFileSync(
        join(home, 'config.yaml'),
        `models:\n  - id: llama3.1:8b\n    provider: ollama\n    base_url: ${fakeProvider.baseUrl}\n    api_key: '\${env:OLLAMA_API_KEY}'\n    input: [text]\n`,
        'utf8',
      );

      const existingProfile = readFileSync(join(home, 'profile.yaml'), 'utf8');
      const updatedProfile = existingProfile
        .replace('provider: anthropic', 'provider: ollama')
        .replace('model: claude-opus-4-7', 'model: llama3.1:8b');
      writeFileSync(join(home, 'profile.yaml'), updatedProfile, 'utf8');

      await page.goto(`http://127.0.0.1:${String(host.port)}/health`, {
        waitUntil: 'networkidle2',
      });
      await page.waitForSelector('[data-testid="health-checks"] > *', { timeout: 15_000 });

      await clickButtonByText(page, 'Run smoke test');
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('[data-testid="agent-smoke-panel"]');
          const text = panel?.textContent ?? '';
          return text.includes('passed') || text.includes('failed') || text.includes('aborted');
        },
        { timeout: 45_000 },
      );
      const smokePanelText = await page.$eval(
        '[data-testid="agent-smoke-panel"]',
        (el) => el.textContent ?? '',
      );
      expect(smokePanelText).toContain('passed');
      const runPath = await page.$eval('[data-testid="smoke-result"] a', (link) =>
        link.getAttribute('href'),
      );
      expect(runPath).toMatch(/^\/runs\/[^/]+$/u);

      // Outbound canary scan across WS frames, HTTP responses, host.log, and all run artifacts.
      hostLog?.flush();
      const hostLogContent = existsSync(hostLogPath()) ? readFileSync(hostLogPath(), 'utf8') : '';
      const runFiles = collectFilesRecursive(join(home, 'data', 'runs'));
      const runFileContents = runFiles.map((file) => readFileSync(file, 'utf8'));

      const outboundCorpus = [
        ...outboundWsFrames,
        ...outboundHttpTexts,
        hostLogContent,
        ...runFileContents,
      ];
      for (const canary of ALL_CANARIES) {
        for (const chunk of outboundCorpus) {
          expect(chunk).not.toContain(canary);
        }
      }

      // Argv scan across supervisor.spawn invocations and OS process command lines.
      observedOsCmdLines.push(listOsProcessCommandLines());
      for (const canary of ALL_CANARIES) {
        for (const argv of recordedWorkerArgvs) {
          expect(argv.join(' ')).not.toContain(canary);
        }
        for (const cmdLines of observedOsCmdLines) {
          expect(cmdLines).not.toContain(canary);
        }
      }
    },
    CHROME_TIMEOUT,
  );
});
