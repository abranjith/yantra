// Reachable from the violating `--json` entry. Importing chalk here is exactly
// the leak the `--json` dependency-freedom guard must catch.
import chalk from 'chalk';

export function styleHeading(value: string): string {
  return chalk.bold(value);
}
