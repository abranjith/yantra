/// <reference lib="dom" />
/**
 * @no-llm FEAT-068 TASK-016: M3 consent evidence.
 *
 * This suite uses a real built app host and Chromium. The run fixtures are
 * parked consent checkpoints, which keeps the suite deterministic and keeps
 * provider construction at zero while exercising the app, host, protocol,
 * claim writer, and `yantra confirm` boundary.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Intervention, type ConfirmationRequest } from '@yantra/protocol';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchGalleryBrowser } from '../drshya/browser.js';
import { runAxe } from '../drshya/capture.js';

const execFileAsync = promisify(execFile);
const BIN = resolve(import.meta.dirname, '..', '..', 'apps', 'cli', 'dist', 'bin.js');
const WAIT = 30_000;

let home: string;
let browser: Browser;
let hostPid = 0;
function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YANTRA_HOME: home,
    LLM_PROVIDER: 'none',
    YANTRA_UI_ASSETS_DIR: '',
  };
}

function openUi(): { url: string; port: number; hostPid: number } {
  return JSON.parse(
    execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
      env: env(),
      encoding: 'utf8',
    }),
  ) as { url: string; port: number; hostPid: number };
}

function request(runId: string, confirmationId: string, host: string): ConfirmationRequest {
  return {
    confirmation_id: confirmationId,
    run_id: runId,
    step_id: 'step-consent',
    action_kind: 'navigate',
    host,
    description: 'Open the approved fixture page',
    expected_cost: null,
    consequence: 'reversible',
    requested_at: '2026-07-28T00:00:00.000Z',
    timeout_ms: null,
    target_host: host,
  };
}

function seedConsent(runId: string, confirmationId: string, host: string): void {
  const runDir = join(home, 'data', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const consent = request(runId, confirmationId, host);
  const intervention = Intervention.parse({
    intervention_id: confirmationId,
    run_id: runId,
    kind: 'consent',
    state: 'pending',
    raised_at: consent.requested_at,
    request: consent,
    attended_deadline_at: null,
    deadline_basis: 'none',
    unattended_ceiling_ms: 900_000,
    unattended_accrued_ms: 0,
    recovery: 'resume',
  });
  writeFileSync(join(runDir, 'confirmations.jsonl'), `${JSON.stringify(consent)}\n`);
  writeFileSync(
    join(runDir, 'interventions.jsonl'),
    `${JSON.stringify({ entry: 'raised', intervention })}\n`,
  );
}

function seedInformational(runId: string): void {
  const runDir = join(home, 'data', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const raisedAt = '2026-07-28T00:00:00.000Z';
  const handoff = Intervention.parse({
    intervention_id: '01J00000000000000000000002',
    run_id: runId,
    kind: 'handoff',
    state: 'recorded',
    raised_at: raisedAt,
    handoff: { blocker: 'The fixture needs a person.', safest_next_action: 'Review and run again.' },
    recovery: 'run_again',
  });
  const input = Intervention.parse({
    intervention_id: '01J00000000000000000000003',
    run_id: runId,
    kind: 'input',
    state: 'recorded',
    raised_at: raisedAt,
    missing: [{ label: 'Destination', reason: 'No destination was supplied.' }],
    recovery: 'run_again',
  });
  writeFileSync(
    join(runDir, 'interventions.jsonl'),
    `${JSON.stringify({ entry: 'raised', intervention: handoff })}\n${JSON.stringify({ entry: 'raised', intervention: input })}\n`,
  );
}

interface ConsentCard {
  readonly page: Page;
  readonly host: string;
}

async function waitForInbox(page: Page): Promise<void> {
  await page.waitForSelector('[role="status"][data-status="connected"]', { timeout: WAIT });
  await page.waitForSelector('a[href="/inbox"]', { timeout: WAIT });
  await page.click('a[href="/inbox"]');
  await expectText(page, 'Inbox');
}

async function openConsent(page: Page, host: string): Promise<ConsentCard> {
  await page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll('article')).some(
        (article) =>
          article.textContent?.includes(needle) &&
          Array.from(article.querySelectorAll('button')).some(
            (button) => button.textContent?.trim() === 'Approve',
          ),
      ),
    { timeout: WAIT },
    host,
  );
  return { page, host };
}

async function answerByKeyboard(card: ConsentCard): Promise<void> {
  await focusCardButton(card, 'Approve');
  await card.page.keyboard.press('Enter');
  await card.page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll('article')).some(
        (article) =>
          article.textContent?.includes(needle) &&
          article.querySelector('[role="group"][aria-label="Review approval"]') !== null,
      ),
    { timeout: WAIT },
    card.host,
  );
  // The review path deliberately focuses Deny first; Tab reaches Approve.
  await card.page.keyboard.press('Tab');
  await card.page.keyboard.press('Enter');
}

async function focusCardButton(card: ConsentCard, label: string): Promise<void> {
  await card.page.evaluate(
    ({ needle, buttonLabel }) => {
      const article = Array.from(document.querySelectorAll('article')).find((candidate) =>
        candidate.textContent?.includes(needle),
      );
      const button = Array.from(article?.querySelectorAll('button') ?? []).find(
        (candidate) => candidate.textContent?.trim() === buttonLabel,
      );
      if (button === undefined) throw new Error(`missing ${buttonLabel} button`);
      button.focus();
    },
    { needle: card.host, buttonLabel: label },
  );
}

async function clickCardButton(card: ConsentCard, label: string): Promise<void> {
  await focusCardButton(card, label);
  await card.page.keyboard.press('Enter');
}

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error('Run `pnpm build` first: the e2e suite uses the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-m3-'));
  seedConsent('01J00000000000000000000000', '01J00000000000000000000001', 'fixture.example.com');
  seedInformational('01J00000000000000000000004');
  const opened = openUi();
  hostPid = opened.hostPid;
  browser = await launchGalleryBrowser();
}, WAIT);

afterAll(async () => {
  await browser?.close();
  if (hostPid !== 0) {
    try {
      process.kill(hostPid);
    } catch {
      // The host may already have exited.
    }
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('@no-llm FEAT-068 M3 consent', () => {
  it('approves a parked consent by keyboard, records user_app, and passes axe', async () => {
    const page = await browser.newPage();
    await page.goto(openUi().url, { waitUntil: 'load' });
    await waitForInbox(page);

    const card = await openConsent(page, 'fixture.example.com');
    expect(await runAxe(page, 'body')).toEqual([]);
    await answerByKeyboard(card);
    await expectText(page, 'Approved');

    const confirmations = readFileSync(
      join(home, 'data', 'runs', '01J00000000000000000000000', 'confirmations.jsonl'),
      'utf8',
    );
    expect(confirmations).toContain('"decision":"granted"');
    expect(confirmations).toContain('"decided_by":"user_app"');
    await page.close();
  }, 90_000);

  it('shows handoff and input items, and concurrent app/CLI answers resolve once', async () => {
    const runId = '01J00000000000000000000005';
    const confirmationId = '01J00000000000000000000006';
    seedConsent(runId, confirmationId, 'race.example.com');

    const page = await browser.newPage();
    await page.goto(openUi().url, { waitUntil: 'load' });
    await waitForInbox(page);
    await expectText(page, 'Run needs your attention');
    await expectText(page, 'Run needs more input');
    const card = await openConsent(page, 'race.example.com');

    const cli = runConfirm(runId);
    await answerByKeyboard(card);
    const cliResult = await cli;
    expect(`${cliResult.stdout}${cliResult.stderr}`).toMatch(/accepted|already_decided/u);

    const lines = readFileSync(join(home, 'data', 'runs', runId, 'confirmations.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines.filter((line) => line.includes('"decision"')).length).toBe(1);
    await page.close();
  }, 90_000);

  it('reconnects and reports an already-decided answer without duplicating the decision', async () => {
    const page = await browser.newPage();
    await page.goto(openUi().url, { waitUntil: 'load' });
    await waitForInbox(page);
    const card = await openConsent(page, 'fixture.example.com');
    await answerByKeyboard(card);
    await page.reload({ waitUntil: 'load' });
    await waitForInbox(page);
    const reloaded = await openConsent(page, 'fixture.example.com');
    await clickCardButton(reloaded, 'Deny');
    await expectText(page, 'Already granted');

    const confirmations = readFileSync(
      join(home, 'data', 'runs', '01J00000000000000000000000', 'confirmations.jsonl'),
      'utf8',
    );
    expect(confirmations.match(/"decision"/gu)?.length).toBe(1);
    await page.close();
  }, 90_000);

  it('keeps run-facing logs free of the fixture goal and secret canaries', () => {
    const forbidden = ['private-goal-canary', 'secret-value-canary'];
    const files = [
      join(home, 'data', 'runs', '01J00000000000000000000000', 'confirmations.jsonl'),
      join(home, 'data', 'runs', '01J00000000000000000000000', 'interventions.jsonl'),
      join(home, 'data', 'runs', '01J00000000000000000000005', 'confirmations.jsonl'),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const canary of forbidden) expect(text).not.toContain(canary);
    }
  });
});

async function expectText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    { timeout: WAIT },
    text,
  );
}

async function runConfirm(runId: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, [BIN, 'confirm', runId, 'grant', '--json'], {
      env: env(),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}
