#!/usr/bin/env node
const qa = require('../src/core/idleUiQa');

qa.runOnce()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  })
  .catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
