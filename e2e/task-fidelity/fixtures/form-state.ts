/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Independent browser-state witness. Protected text never leaves the page. */
import { createHash } from 'node:crypto';

import { z } from 'zod';

const ControlStateSchema = z
  .object({
    value: z.string().max(8192).optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    checked: z.boolean().optional(),
  })
  .strict()
  .refine((state) => state.digest === undefined || state.value === undefined);

export const FormStateSchema = z
  .object({
    page: z.string().min(1).max(160),
    seq: z.number().int().nonnegative(),
    controls: z.record(ControlStateSchema),
    submits: z.number().int().nonnegative(),
    requestSubmitCalls: z.number().int().nonnegative(),
    formSubmitCalls: z.number().int().nonnegative(),
  })
  .strict();

export type FormState = z.infer<typeof FormStateSchema>;

/** Digest used only by fixture expectations, never by the engine. */
export function protectedDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Last event sequence wins even when asynchronous digest requests arrive out of order. */
export function latestFormStates(log: readonly FormState[]): Readonly<Record<string, FormState>> {
  const result: Record<string, FormState> = {};
  for (const state of log) {
    if (result[state.page] === undefined || result[state.page]!.seq < state.seq)
      result[state.page] = state;
  }
  return result;
}

/** Self-contained page code; serialized as source so no Node closure can leak in. */
function installFormState(): void {
  let seq = 0;
  let scheduled = false;
  let submits = 0;
  let requestSubmitCalls = 0;
  let formSubmitCalls = 0;
  let pending: Promise<void> = Promise.resolve();
  const collect = async (): Promise<void> => {
    const state = {
      page: document.body.dataset.fixturePage ?? location.pathname.slice(1),
      seq: ++seq,
      controls: {} as Record<string, { value?: string; digest?: string; checked?: boolean }>,
      submits,
      requestSubmitCalls,
      formSubmitCalls,
    };
    const protectedValues: { key: string; value: string }[] = [];
    for (const control of document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('[data-fixture-key]')) {
      const key = control.dataset.fixtureKey!;
      if (control instanceof HTMLInputElement && control.type === 'password') {
        protectedValues.push({ key, value: control.value });
      } else if (
        control instanceof HTMLInputElement &&
        ['checkbox', 'radio'].includes(control.type)
      ) {
        state.controls[key] = { checked: control.checked };
      } else state.controls[key] = { value: control.value };
    }
    // Capture counters and values synchronously before the first await.
    for (const { key, value } of protectedValues) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      state.controls[key] = {
        digest: Array.from(new Uint8Array(bytes), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }
    await fetch('/__fixture/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
      keepalive: true,
    });
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      pending = collect();
    });
  };
  const prototype = HTMLFormElement.prototype;
  // Keep the native receiver: these wrappers intentionally call the method on each form.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRequest = prototype.requestSubmit;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSubmit = prototype.submit;
  prototype.requestSubmit = function (submitter?: HTMLElement): void {
    requestSubmitCalls++;
    schedule();
    originalRequest.call(this, submitter);
  };
  prototype.submit = function (): void {
    formSubmitCalls++;
    schedule();
    originalSubmit.call(this);
  };
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  document.addEventListener(
    'submit',
    (event) => {
      submits++;
      event.preventDefault();
      schedule();
    },
    true,
  );
  // Tests can await the actual network witness, rather than sleeping a guessed duration.
  Object.assign(window, {
    flushFixtureState: async () => {
      await pending;
      await collect();
    },
  });
  pending = collect();
}

export const FORM_STATE_SCRIPT = `<script>(${installFormState.toString()})();</script>`;
