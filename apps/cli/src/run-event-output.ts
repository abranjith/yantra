/**
 * The CLI's side of a run's event stream (FEAT-063).
 *
 * A command creates its run's {@link RunEventStream} at start, subscribes its
 * terminal or `--json` renderer to it (with `includeUncommitted`, so the goal
 * echo and pre-run warnings print before the run directory exists), emits its
 * own live lines through it, and hands it to the pipeline, orchestrator or
 * agent runtime, which opens it. Exactly one renderer is subscribed per
 * stream, so nothing prints twice.
 */

import {
  ResourceBusyError,
  RunEventLogError,
  RunEventStream,
  capText,
  runOutcomeEvent,
  stripControl,
} from '@yantra/core';
import {
  RUN_WARNING_TEXT_MAX,
  type RunEventDelivery,
  type RunEventOf,
  type TaskOutcome,
} from '@yantra/protocol';
import { CommanderError } from 'commander';

import { CommandFailure } from './context/command-context.js';
import { renderRunEventJson } from './render/run-event-json.js';
import { renderRunEventTerminal } from './render/run-event-terminal.js';
import type { ConnectorRenderOpts } from './render/types.js';

/** Writes one NDJSON line (the command output seam, when one exists). */
export interface JsonLineWriter {
  jsonLine(value: unknown): void;
}

/**
 * Subscribes the renderer `renderOpts` selects to `stream`.
 *
 * @returns The idempotent disposer.
 */
export function subscribeRunEventRenderer(
  stream: RunEventStream,
  renderOpts: ConnectorRenderOpts,
  output?: JsonLineWriter,
): () => void {
  const render = (delivery: RunEventDelivery): void => {
    if (renderOpts.json) {
      renderRunEventJson(delivery.event, {
        jsonLine: (value) => {
          if (output) output.jsonLine(value);
          else renderOpts.stream.write(`${JSON.stringify(value)}\n`);
        },
        errStream: renderOpts.errStream,
      });
    } else {
      renderRunEventTerminal(delivery.event, {
        stream: renderOpts.stream,
        errStream: renderOpts.errStream,
      });
    }
  };
  return stream.subscribe(render, { includeUncommitted: true });
}

/**
 * Render options for a command whose only live lines are its own advisories
 * (`run`, `resume`): stdout/stderr of the command's output, JSON per its flag.
 */
export function liveRenderOpts(
  context: {
    readonly output: {
      readonly stdout: NodeJS.WritableStream;
      readonly stderr: NodeJS.WritableStream;
    };
  },
  json: boolean,
): ConnectorRenderOpts {
  return {
    json,
    debug: false,
    noColor: true,
    stream: context.output.stdout,
    errStream: context.output.stderr,
  };
}

/** A new run stream with the command's renderer already subscribed. */
export function createLiveRunEvents(
  renderOpts: ConnectorRenderOpts,
  output?: JsonLineWriter,
): RunEventStream {
  const stream = new RunEventStream();
  subscribeRunEventRenderer(stream, renderOpts, output);
  return stream;
}

/** A `run_warning` event: the advisory text without its `warning: ` prefix. */
export function warningEvent(
  source: 'command' | 'agent',
  text: string,
  at: string = new Date().toISOString(),
): RunEventOf<'run_warning'> {
  return {
    kind: 'run_warning',
    source,
    text: capText(stripControl(text), RUN_WARNING_TEXT_MAX),
    at,
  };
}

/**
 * The exit code a command reports for an error it rethrows: the code a
 * `CommanderError` or `CommandFailure` carries, 3 for a busy resource or an
 * unopenable run-event log (environment), else 2 (execution).
 */
export function exitCodeOfThrown(error: unknown): number {
  if (error instanceof CommanderError || error instanceof CommandFailure) return error.exitCode;
  if (error instanceof ResourceBusyError || error instanceof RunEventLogError) return 3;
  return 2;
}

function outcomeForExit(exitCode: number): TaskOutcome {
  if (exitCode === 0) return 'fulfilled';
  if (exitCode === 4) return 'handoff';
  if (exitCode === 130) return 'aborted';
  return 'failed';
}

/**
 * Ends the run's stream from the command's side. When the run threw after its
 * log opened, the run left the outcome to the command (the stream's owner):
 * this records it with the exit code the command actually returns, then
 * closes the stream. A stream that never opened (the command failed before
 * any run existed) is simply closed, writing nothing.
 */
export function finishRunEvents(stream: RunEventStream, exitCode: number): void {
  const runId = stream.runId;
  if (stream.opened && !stream.outcomeRecorded && runId !== null) {
    try {
      stream.emit(
        runOutcomeEvent({
          runId,
          taskOutcome: outcomeForExit(exitCode),
          terminationReason: null,
          stopDetail: null,
          exitCode,
          failureClass: exitCode === 0 || exitCode === 4 ? null : 'unexpected',
        }),
      );
    } catch {
      // The run's log already ends with its outcome: nothing to add.
    }
  }
  stream.close();
}
