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
    clicks: z.number().int().nonnegative().optional(),
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

/** Add stable fixture keys to existing form markup without changing its controls. */
export function withFormState(html: string, page: string): string {
  const keyed = html.replace(/<(input|select|textarea)\b[^>]*>/gu, (tag) => {
    if (tag.includes('data-fixture-key=')) return tag;
    const id = /\bid="([^"]+)"/u.exec(tag)?.[1];
    const name = /\bname="([^"]+)"/u.exec(tag)?.[1];
    const value = /\bvalue="([^"]+)"/u.exec(tag)?.[1];
    const key =
      id ??
      (name === undefined ? undefined : /\btype="radio"/u.test(tag) ? `${name}-${value}` : name);
    return key === undefined ? tag : tag.replace(/>$/u, ` data-fixture-key="${key}">`);
  });
  return keyed
    .replace(/<body\b/u, `<body data-fixture-page="${page}"`)
    .replace('</body>', `${FORM_STATE_SCRIPT}</body>`);
}

/** Plain browser source: transform-time helpers must never enter the fixture page. */
export const FORM_STATE_SCRIPT = String.raw`<script>(() => {
  let seq = Number(sessionStorage.getItem('__fixture_seq') ?? '0');
  let scheduled = false, submits = 0, requestSubmitCalls = 0, formSubmitCalls = 0, clicks = 0;
  let pending = Promise.resolve();
  const collect = async () => {
    const state = {
      page: document.body.dataset.fixturePage ?? location.pathname.slice(1),
      seq: ++seq, controls: {}, submits, requestSubmitCalls, formSubmitCalls, clicks,
    };
    sessionStorage.setItem('__fixture_seq', String(seq));
    const protectedValues = [];
    for (const control of document.querySelectorAll('[data-fixture-key]')) {
      const key = control.dataset.fixtureKey;
      if (control instanceof HTMLInputElement && control.type === 'password') {
        protectedValues.push({ key, value: control.value });
      } else if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) {
        state.controls[key] = { checked: control.checked };
      } else state.controls[key] = { value: control.value };
    }
    for (const { key, value } of protectedValues) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      state.controls[key] = {
        digest: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''),
      };
    }
    await fetch('/__fixture/state', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state), keepalive: true,
    });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; pending = collect(); });
  };
  const prototype = HTMLFormElement.prototype;
  const originalRequest = prototype.requestSubmit;
  const originalSubmit = prototype.submit;
  prototype.requestSubmit = function (submitter) {
    requestSubmitCalls++; schedule(); originalRequest.call(this, submitter);
  };
  prototype.submit = function () {
    formSubmitCalls++; schedule(); originalSubmit.call(this);
  };
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  document.addEventListener('click', () => { clicks++; schedule(); }, true);
  document.addEventListener('submit', event => {
    submits++; event.preventDefault(); schedule();
  }, true);
  Object.assign(window, { flushFixtureState: async () => { await pending; await collect(); } });
  pending = collect();
})();</script>`;
