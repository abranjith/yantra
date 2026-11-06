// Stand-in for the yantra CLI in the copied-command shell suite
// (e2e/command-format-shells.spec.ts). It records the argv it receives as JSON
// in the file named by ARGV_ECHO_OUT. A file, not stdout, so no console code
// page can alter the bytes.
import { writeFileSync } from 'node:fs';

const out = process.env.ARGV_ECHO_OUT;
if (!out) {
  process.stderr.write('ARGV_ECHO_OUT is not set\n');
  process.exit(2);
}
writeFileSync(out, JSON.stringify(process.argv.slice(2)), 'utf8');
