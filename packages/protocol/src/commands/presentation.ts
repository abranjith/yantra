/**
 * Options the app's generated forms never show, with the reviewed reason for
 * each (FEAT-067; FEAT-070's parity manifest inherits this list).
 *
 * An exemption is a decision, not an omission: each one names why the option
 * has no meaning in the app. Every other applicable, live option of a command
 * appears in its generated form.
 */

/** One option the app does not offer. */
export interface AppOptionExemption {
  readonly long: string;
  readonly reason: string;
}

/** The reviewed app exemptions, by long flag (they apply to every command). */
export const APP_OPTION_EXEMPTIONS: readonly AppOptionExemption[] = [
  {
    long: '--json',
    reason: 'The app reads structured results directly; JSON output is for scripts.',
  },
  {
    long: '--open',
    reason: 'The cockpit opens the run result itself when the run finishes.',
  },
  {
    long: '--no-color',
    reason: 'The app renders its own styling; terminal colors do not apply.',
  },
];

/** Whether the app leaves `long` out of every generated form. */
export function isAppExemptOption(long: string): boolean {
  return APP_OPTION_EXEMPTIONS.some((exemption) => exemption.long === long);
}
