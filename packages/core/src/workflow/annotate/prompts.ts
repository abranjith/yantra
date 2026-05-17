/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `prompts()` is typed as Promise<any>; we narrow at destructuring sites */
import type { WorkflowFile } from '@yantra/protocol';
import prompts from 'prompts';

import type { WorkflowStore } from '../store.types.js';

import type { AnnotateSession, AnnotateView } from './session.js';

export interface AnnotatePromptsOptions {
  onSaved?: (workflow: WorkflowFile) => void;
  onCancelled?: () => void;
}

function renderContextCard(view: AnnotateView): void {
  const action = view.capturedAction;
  process.stdout.write('\n');
  process.stdout.write(`--- Action ${view.index + 1} / ${view.total} ---\n`);
  process.stdout.write(`Kind: ${action.kind}\n`);

  if (action.kind === 'navigate') {
    process.stdout.write(`URL: ${action.url_after ?? action.url_before}\n`);
  }

  if (action.kind === 'click' || action.kind === 'fill') {
    const desc = action.element_descriptor;
    process.stdout.write(`Tag: ${desc.tag}\n`);
    if (desc.role) process.stdout.write(`Role: ${desc.role}\n`);
    if (desc.accessible_name) process.stdout.write(`Name: ${desc.accessible_name}\n`);
  }

  if (action.kind === 'fill') {
    process.stdout.write(`Input type: ${action.input_type}\n`);
    process.stdout.write(`Value length: ${action.value_length} chars\n`);
  }

  if (view.candidateSummary.length > 0) {
    process.stdout.write(`Top candidates:\n`);
    for (const c of view.candidateSummary) {
      process.stdout.write(`  - ${c}\n`);
    }
  }

  if (view.suggestedLocatorName) {
    process.stdout.write(`Suggested name: ${view.suggestedLocatorName}\n`);
  }

  process.stdout.write(`\nPower keys: [a]ccept all  [s]kip all  [b]ack  [q]uit\n`);
}

/** Run the interactive annotate flow for a session. */
export async function runAnnotatePrompts(
  session: AnnotateSession,
  store: WorkflowStore,
  opts?: AnnotatePromptsOptions,
): Promise<void> {
  let cancelled = false;

  prompts.override({});

  const onCancel = () => {
    cancelled = true;
    return false;
  };

  while (session.getState().kind === 'reviewing') {
    const view = session.current();
    if (!view) break;

    renderContextCard(view);

    const { keep } = await prompts(
      {
        type: 'select',
        name: 'keep',
        message: 'Action:',
        choices: [
          { title: 'Keep', value: 'keep' },
          { title: 'Skip', value: 'skip' },
          { title: 'Accept all remaining', value: 'accept_all' },
          { title: 'Skip all remaining', value: 'skip_all' },
          { title: 'Back', value: 'back' },
          { title: 'Quit / Cancel', value: 'quit' },
        ],
      },
      { onCancel },
    );

    if (cancelled || keep === 'quit') {
      session.cancel();
      opts?.onCancelled?.();
      return;
    }

    if (keep === 'accept_all') {
      session.acceptAll();
      break;
    }

    if (keep === 'skip_all') {
      session.skipAll();
      break;
    }

    if (keep === 'back') {
      session.back();
      continue;
    }

    if (keep === 'skip') {
      session.applyDecision({
        draftActionId: String(view.index),
        action: 'skip',
        locatorName: null,
        valuePromotion: null,
        paramOrSecretKey: null,
        scopeOverride: null,
      });
      session.next();
      continue;
    }

    // Keep path
    let locatorName: string | null = view.suggestedLocatorName;
    const action = view.capturedAction;

    if (action.kind === 'click' || action.kind === 'fill') {
      const { name } = await prompts(
        {
          type: 'text',
          name: 'name',
          message: 'Locator name:',
          initial: view.suggestedLocatorName ?? '',
        },
        { onCancel },
      );
      if (cancelled) {
        session.cancel();
        opts?.onCancelled?.();
        return;
      }
      locatorName = (name as string | undefined) ?? view.suggestedLocatorName;
    }

    let valuePromotion = view.suggestedValuePromotion;
    let paramOrSecretKey: string | null = null;

    if (action.kind === 'fill') {
      const { promotion } = await prompts(
        {
          type: 'select',
          name: 'promotion',
          message: 'Value type:',
          choices: [
            { title: 'Literal (use placeholder)', value: 'literal' },
            { title: 'Param reference', value: 'param' },
            { title: 'Secret reference', value: 'secret' },
          ],
          initial: valuePromotion === 'secret' ? 2 : valuePromotion === 'param' ? 1 : 0,
        },
        { onCancel },
      );

      if (cancelled) {
        session.cancel();
        opts?.onCancelled?.();
        return;
      }

      valuePromotion = (promotion as 'literal' | 'param' | 'secret') ?? 'literal';

      if (valuePromotion === 'param' || valuePromotion === 'secret') {
        const defaultKey =
          valuePromotion === 'secret' ? `secret.field${view.index + 1}` : `field${view.index + 1}`;

        const { keyName } = await prompts(
          {
            type: 'text',
            name: 'keyName',
            message: valuePromotion === 'secret' ? 'Secret key (namespace.name):' : 'Param key:',
            initial: defaultKey,
          },
          { onCancel },
        );

        if (cancelled) {
          session.cancel();
          opts?.onCancelled?.();
          return;
        }

        paramOrSecretKey = (keyName as string | undefined) ?? defaultKey;
      }
    }

    session.applyDecision({
      draftActionId: String(view.index),
      action: 'keep',
      locatorName,
      valuePromotion,
      paramOrSecretKey,
      scopeOverride: null,
    });

    session.next();
  }

  // Preview stage
  if (session.getState().kind === 'preview') {
    const workflow = session.assemble();
    process.stdout.write('\n=== Workflow Preview ===\n');
    process.stdout.write(`Name: ${workflow.name}\n`);
    process.stdout.write(`Steps: ${workflow.steps.length}\n`);
    process.stdout.write(`Params: ${Object.keys(workflow.params).join(', ') || '(none)'}\n`);
    process.stdout.write(`Secrets: ${workflow.secrets.join(', ') || '(none)'}\n`);
    process.stdout.write('\n');

    const { confirmSave } = await prompts(
      {
        type: 'confirm',
        name: 'confirmSave',
        message: 'Save this workflow?',
        initial: true,
      },
      { onCancel },
    );

    if (cancelled || !confirmSave) {
      session.cancel();
      opts?.onCancelled?.();
      return;
    }

    session.confirm();
    const finalWorkflow = session.assemble();
    await store.save(finalWorkflow);
    opts?.onSaved?.(finalWorkflow);
  }
}
