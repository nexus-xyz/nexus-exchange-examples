// Wiring and lifecycle.
//
// This app is **read-only**. It sends `GET` and nothing else: there is no
// order path, no cancel path, and no code here that could place, amend or
// remove anything. That is a property of the example, not a mode of it — there
// is no `--submit` to forget.

import { RateBudget } from "./budget.js";
import { loadConfig } from "./config.js";
import { reconcile } from "./reconcile.js";
import { render } from "./render.js";
import {
  ApiError,
  MissingCredentialsError,
  RestClient,
  TransportError,
} from "./rest.js";
import { buildStatement } from "./statement.js";

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

  log(`Nexus Exchange account statement — ${config.baseUrl} (${config.funds} funds)`);

  if (!client.hasCredentials) {
    process.stderr.write(
      "\nThis statement is about one account's own history, and every " +
        "endpoint it\nreads is authenticated. Set NEXUS_EXCHANGE_API_KEY and " +
        "NEXUS_EXCHANGE_API_SECRET\n(see .env.example) and run it again.\n\n" +
        "There is no useful public fallback: the unauthenticated demo mirror " +
        "on testnet\nserves empty history buffers, so a statement built from " +
        "it would be a page of\nzeroes that looked like an answer.\n",
    );
    return 2;
  }

  // Discover the budget before spending any of it. `GET /account/rate-limit`
  // is the one call that costs nothing, which is the whole reason this app
  // reads its ceiling instead of hardcoding one from the tier table.
  try {
    const status = await client.get<unknown>({
      path: "/api/v1/account/rate-limit",
      signed: true,
      weight: 0,
    });
    budget.applyStatus(status.body);
  } catch (error) {
    budget.degrade(
      `GET /account/rate-limit failed (${(error as Error).message})`,
    );
  }
  log(budget.describe());

  const statement = await buildStatement(client, config, (message) =>
    log(`reading ${message}`),
  );
  render(statement, reconcile(statement), config, out);

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof MissingCredentialsError) {
      process.stderr.write(`\nerror: ${error.message}\n`);
    } else if (error instanceof ApiError || error instanceof TransportError) {
      process.stderr.write(`\nerror: ${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`\nerror: ${error.message}\n`);
    } else {
      process.stderr.write(`\nerror: ${String(error)}\n`);
    }
    process.exitCode = 1;
  });
