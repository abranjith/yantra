import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { EffectiveOptions, RunRecoveryAssessment } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { composerArgv } from '../../../src/features/composer/composer-model.js';
import {
  settingsDiff,
  priorLabel,
  resumeModel,
} from '../../../src/features/recovery/RecoveryActions.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';

function assessment(overrides: Partial<RunRecoveryAssessment> = {}): RunRecoveryAssessment {
  return {
    run_id: 'run-1',
    resume: { available: false, reason: 'Only saved workflow runs can be resumed. Use Run again.' },
    run_again: {
      prior: 'receipt',
      path: ['do'],
      argv: ['fill the form', '--allow-host', 'shop.test'],
      pinned_argv: ['fill the form', '--allow-host', 'shop.test', '--model', 'claude-old'],
      cwd: HOME,
      effects: 'none',
      effect_reasons: [],
      notices: [],
    },
    ...overrides,
  };
}

function effective(model: string): EffectiveOptions {
  return {
    path: ['do'],
    mode: 'llm',
    options: [
      { option: 'model', flag: '--model', value: model, source: { kind: 'flag' } },
      { option: 'allowHost', flag: '--allow-host', value: ['shop.test'], source: { kind: 'flag' } },
    ],
  };
}

/** A finished run in the cockpit, with its recovery read. */
function host(recovery: RunRecoveryAssessment): FakeRpc {
  const rpc = new FakeRpc()
    .answer('run.subscribe', (params) => {
      for (const { seq, event } of numbered([ev('goal_echo'), ev('run_outcome')])) {
        rpc.notify('run.event', { run_id: params.run_id, seq, event });
      }
      return { channel: 'replay_only' };
    })
    .answer('run.unsubscribe', {})
    .answer('read.run_recovery', recovery)
    .answer('read.mission_context', { home: HOME, platform: process.platform })
    .answer('read.template.list', { schema: null, value: { items: [] }, next_cursor: null })
    .answer('read.effective_options', (params) =>
      effective((params.argv as string[]).includes('claude-old') ? 'claude-old' : 'claude-new'),
    )
    .answer('read.provider_readiness', { ready: true, provider: 'anthropic', model: 'claude-new' })
    .answer('command.invoke', (params) => ({
      invocation_id: (params.invocation as { invocation_id: string }).invocation_id,
      state: 'queued',
      execution_class: 'run',
      path: (params.invocation as { path: string[] }).path,
      run_id: null,
      queued_at: '2026-11-14T10:00:00.000Z',
      review: null,
      result: null,
    }))
    .answer('read.invocation', (params) => ({
      invocation_id: params.invocation_id,
      state: 'queued',
      execution_class: 'run',
      path: ['do'],
      position: 1,
      run_id: null,
      queued_at: '2026-11-14T10:00:00.000Z',
      review: null,
      result: null,
    }));
  return rpc;
}

async function finishedCockpit(rpc: FakeRpc) {
  const rendered = await renderAt('/mission/runs/run-1', rpc);
  await screen.findByRole('button', { name: /^Run again/u });
  return rendered;
}

describe('@no-llm recovery actions', () => {
  it('hides Resume when the run cannot resume, and puts the reason on Run again', async () => {
    await finishedCockpit(host(assessment()));

    expect(screen.queryByRole('button', { name: /^Resume/u })).toBeNull();
    expect(
      screen.getByText('Resume: Only saved workflow runs can be resumed. Use Run again.'),
    ).toBeDefined();
    // Keyboard focus opens a tooltip at once (hover waits for its delay).
    const runAgain = screen.getByRole('button', { name: /^Run again/u });
    let guard = 0;
    while (document.activeElement !== runAgain && guard < 40) {
      await userEvent.tab();
      guard += 1;
    }
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Only saved workflow runs can be resumed. Use Run again.',
    );
  });

  it('resumes after acknowledging the stop, adding --force', async () => {
    const rpc = host(
      assessment({
        resume: { available: true, requires_consent: true, failure_class: 'scope_violation' },
      }),
    );
    await finishedCockpit(rpc);

    await userEvent.click(screen.getByRole('button', { name: 'Resume…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Resume past the stop?' });
    expect(within(dialog).getByText('scope_violation')).toBeDefined();
    const confirm = within(dialog).getByRole('button', { name: 'Resume' });
    expect(
      confirm.hasAttribute('disabled') || confirm.getAttribute('data-disabled') === 'true',
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole('checkbox'));
    expect(dialog.querySelector('[data-part="command"]')?.textContent).toMatch(/--force/u);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(rpc.paramsOf('command.invoke')).toHaveLength(1);
    });
    expect(rpc.paramsOf('command.invoke')[0]!.invocation).toMatchObject({
      path: ['resume'],
      argv: ['run-1', '--force'],
    });
  });

  it('resumes at once when no consent is needed', async () => {
    const rpc = host(assessment({ resume: { available: true, requires_consent: false } }));
    await finishedCockpit(rpc);

    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(rpc.paramsOf('command.invoke')[0]?.invocation).toMatchObject({ argv: ['run-1'] });
    });
  });

  it('lists only the settings that differ, and runs again with the chosen ones', async () => {
    const rpc = host(assessment());
    await finishedCockpit(rpc);

    await userEvent.click(screen.getByRole('button', { name: /^Run again/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Run again?' });
    await waitFor(() => {
      expect(dialog.querySelector('[data-part="settings-diff"]')).not.toBeNull();
    });
    const rows = [...dialog.querySelectorAll('[data-part="settings-diff"] tbody tr')].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual(['--model"claude-old""claude-new"']);

    await userEvent.click(within(dialog).getByRole('button', { name: /Settings/u }));
    await userEvent.click(await screen.findByRole('option', { name: 'Prior settings' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run again' }));

    await waitFor(() => {
      expect(rpc.paramsOf('command.invoke')).toHaveLength(1);
    });
    expect((rpc.paramsOf('command.invoke')[0]!.invocation as { argv: string[] }).argv).toEqual([
      'fill the form',
      '--model',
      'claude-old',
      '--allow-host',
      'shop.test',
    ]);
  });

  it('warns about what the previous run did, with Cancel as the default', async () => {
    const rpc = host(
      assessment({
        run_again: {
          ...assessment().run_again,
          effects: 'verified',
          effect_reasons: [
            'The previous run filled 3 fields on example.org.',
            'It was allowed to submit a form.',
          ],
        },
      }),
    );
    await finishedCockpit(rpc);

    await userEvent.click(screen.getByRole('button', { name: /^Run again/u }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Run again?' });

    const warning = dialog.querySelector('[data-part="effects-warning"]')!;
    expect(warning.textContent).toContain('The previous run filled 3 fields on example.org.');
    expect(warning.textContent).toContain('It was allowed to submit a form.');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await userEvent.keyboard('{Enter}');
    expect(rpc.paramsOf('command.invoke')).toEqual([]);
  });

  it('shows no warning when the previous run changed nothing', async () => {
    await finishedCockpit(host(assessment()));

    await userEvent.click(screen.getByRole('button', { name: /^Run again/u }));

    const dialog = await screen.findByRole('dialog', { name: 'Run again?' });
    expect(dialog.querySelector('[data-part="effects-warning"]')).toBeNull();
  });

  it('labels a goal-only command and offers no prior settings', async () => {
    await finishedCockpit(
      host(
        assessment({
          run_again: {
            ...assessment().run_again,
            prior: 'goal_only',
            argv: ['fill the form'],
            pinned_argv: ['fill the form'],
            cwd: null,
          },
        }),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: /^Run again/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Run again?' });

    expect(within(dialog).getByText('Goal only')).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /Settings/u })).toBeNull();
  });

  it('prefills the composer from ?from=', async () => {
    const rpc = host(assessment());

    await renderAt('/mission?from=run-1&settings=prior', rpc);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Do', selected: true })).toBeDefined();
    });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Goal/u }).value).toBe(
      'fill the form',
    );
    await userEvent.click(screen.getByRole('button', { name: /^Options/u }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^Model/u }).value).toBe(
      'claude-old',
    );
  });

  it('has no axe violations in the cockpit’s finished state', async () => {
    const { container } = await finishedCockpit(host(assessment()));

    await expectNoAxeViolations(container);
  });
});

describe('@no-llm recovery helpers', () => {
  it('diffs only differing settings', () => {
    expect(settingsDiff(effective('a'), effective('b'))).toEqual([
      { flag: '--model', prior: '"a"', current: '"b"' },
    ]);
    expect(settingsDiff(effective('a'), effective('a'))).toEqual([]);
    expect(settingsDiff(undefined, effective('a'))).toEqual([]);
  });

  it('labels rebuilt commands', () => {
    expect(priorLabel('reconstructed')).toBe('Reconstructed');
    expect(priorLabel('goal_only')).toBe('Goal only');
    expect(priorLabel('receipt')).toBeNull();
  });

  it('builds a resume with --force only when consented', () => {
    expect(composerArgv(resumeModel('run-1', false))).toEqual(['run-1']);
    expect(composerArgv(resumeModel('run-1', true))).toEqual(['run-1', '--force']);
  });
});
