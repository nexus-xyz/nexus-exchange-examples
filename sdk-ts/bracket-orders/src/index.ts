// A bracket order manager: an entry, plus a take-profit and a stop-loss that
// cancel each other.
//
// Run it with:  npm start                                         (dry run)
//               npm start -- --live --limit P --tp P --sl P       (testnet)
//
// The shape, in order of what matters:
//
//   1. The exits are the venue's own conditional orders (`TakeProfitMarket`,
//      `StopMarket`), reduce-only, sized to what the entry actually filled.
//      The venue fires them. This process is not the stop.
//   2. The venue doesn't link them, so one-cancels-other is done here: the
//      WebSocket says "look now", REST says what is true, and only a REST read
//      ever cancels anything.
//   3. Ctrl-C leaves the position protected. Both exits stay resting, and the
//      app says so, because the alternative (cancelling them on the way out)
//      turns "I stopped the program" into "I removed my stop".

import { HelpRequested, USAGE, ConfigError, loadConfig } from "./config.js";
import { EXIT_ERROR, runBracket } from "./app.js";
import type { Phase } from "./app.js";
import { describe } from "./venue.js";

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(USAGE);
      return 0;
    }
    if (error instanceof ConfigError) {
      console.error(error.message);
      return EXIT_ERROR;
    }
    throw error;
  }

  const interrupted = new AbortController();
  // A holder, not a `let`: it is written from a callback, and TypeScript would
  // otherwise narrow it to its initial value at every read below.
  const state: { phase: Phase } = { phase: "reading" };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted.signal.aborted || state.phase === "reading") {
      // Nothing placed yet, or asked twice. Say what that can cost.
      process.stderr.write(
        state.phase === "placing"
          ? `\n${signal} again: exiting now. An entry may be filled without both exits placed; check the account.\n`
          : `\n${signal}: exiting.\n`,
      );
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    }
    interrupted.abort();
    process.stderr.write(
      state.phase === "placing"
        ? `\n${signal}: finishing placing the exits first, so the position isn't left without a stop. Again to force.\n`
        : `\n${signal}: stopping. The exits stay resting.\n`,
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    return await runBracket(config, {
      log,
      signal: interrupted.signal,
      onPhase: (p) => {
        state.phase = p;
      },
    });
  } catch (error) {
    log(`error: ${describe(error)}`);
    if (state.phase === "placing" || state.phase === "managing") log("anything already placed was left as it is; check the account.");
    return EXIT_ERROR;
  }
}

process.exitCode = await main();
// The SDK's socket client may hold the event loop open; the outcome is decided.
process.exit();
