// Wiring and lifecycle.
//
// This app is **read-only and credential-free**. It sends `GET` and nothing
// else, to four public endpoints, with no key, no signature and no `.env`
// required. There is no order path, no cancel path, and no `--submit` to
// forget — those are properties of the example, not modes of it.

import { RateBudget } from "./budget.js";
import { MARKETS_ENDPOINT_NOTE, collect } from "./collect.js";
import { loadConfig } from "./config.js";
import { render } from "./render.js";
import { ApiError, RestClient, TransportError } from "./rest.js";

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(message: string): void {
  process.stdout.write(`${stamp()}  ${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${stamp()}  warning: ${message}\n`);
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2));

  // Ctrl-C unwinds every in-flight request. Nothing here holds state the venue
  // can see, so there is nothing to clean up — a read-only app's shutdown is
  // just "stop asking".
  const shutdown = new AbortController();
  const stop = (): void => {
    if (!shutdown.signal.aborted) {
      shutdown.abort(new Error("interrupted"));
      warn("interrupted; no further requests will be made");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const budget = new RateBudget(config.utilisation, (note) => log(note));
  const client = new RestClient(config, budget, shutdown.signal, warn);

  log(`Nexus Exchange funding carry — ${config.baseUrl} (${config.funds} funds)`);
  log("no credentials required; every surface read here is public");
  log(budget.describe());

  const report = await collect(client, config, (message) => log(`reading ${message}`));
  render(report, config, out);

  out(`Note: ${MARKETS_ENDPOINT_NOTE}`);
  out("");

  // A run that ranked nothing is not a success. Exit non-zero so a scheduled
  // invocation notices, rather than logging a confident-looking empty table
  // and returning 0.
  return report.markets.some((row) => row.excluded === null) ? 0 : 3;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ApiError || error instanceof TransportError) {
      process.stderr.write(`\nerror: ${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`\nerror: ${error.message}\n`);
    } else {
      process.stderr.write(`\nerror: ${String(error)}\n`);
    }
    process.exitCode = 1;
  });
