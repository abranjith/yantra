#!/usr/bin/env node
import { run } from './index.js';

void run()
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
