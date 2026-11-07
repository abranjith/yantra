#!/usr/bin/env node
import { runTerminal } from './adapters/terminal/terminal-adapter.js';

void runTerminal(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
