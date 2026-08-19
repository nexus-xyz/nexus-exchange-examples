// The MCP session: spawn the server, and constrain what may be called on it.
//
// Why this file exists at all
// ---------------------------
// The Nexus Exchange MCP server exposes 63 tools, and 16 of them move money or
// change account settings — `place_order`, `amend_order`, `deposit_collateral`,
// `claim_credit`, `submit_deposit`, `set_tier`. That is the right surface for a
// general-purpose agent. It is emphatically not the surface a *risk review*
// needs, which is three read calls.
//
// **An agent's blast radius is its tool list.** This is the thing an
// agent-shaped app has to get right that a normal client does not: a normal
// client can only call the functions someone wrote into it, while an agent can
// call anything the server offers, and the server offers everything. So the
// narrowing has to be explicit and enforced somewhere, rather than left as an
// intention.
//
// Here it is enforced in one place: `call()` refuses any tool not in the
// allowlist below, and nothing else in this app can reach the transport — so
// there is no second path to keep in sync. The check is a runtime one on
// purpose: tool names are strings arriving from a subprocess, and a type cannot
// hold that line.
//
// Two smaller things this also gets right:
//
//   * **The child's environment is built explicitly, never inherited whole.**
//     Passing `process.env` to a subprocess hands it every secret in your shell
//     — cloud tokens, other exchanges' keys — for no reason. Only the variables
//     the server documents are forwarded, and admin tools are left switched off
//     by simply never setting `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS`. Unset means
//     those tools are never registered at all, which is a stronger guarantee
//     than choosing not to call them.
//
//   * **The child is always reaped.** A stdio MCP server is a real subprocess.
//     If the parent throws between spawn and close, the server outlives it and
//     you accumulate orphans — so every path closes the session.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Config } from "./config.js";

/**
 * Every tool this app is permitted to call. Read-only, by inspection.
 *
 * Adding one is a deliberate act, which is the point: the cost of widening the
 * blast radius should be an edit to this list and a line in review.
 */
export const ALLOWED_TOOLS = [
  "get_balance",
  "get_positions",
  "get_open_orders",
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/** Tool-name prefixes that only ever read. Used to describe what we skipped. */
const READ_ONLY_PREFIXES = ["get_", "list_", "preview_"];

export interface ToolSurface {
  readonly total: number;
  readonly mutating: number;
}

export class McpError extends Error {}

export class Session {
  private constructor(
    private readonly client: Client,
    readonly surface: ToolSurface,
  ) {}

  /**
   * Spawn the server, handshake, and verify the tool contract before use.
   *
   * The contract check is not ceremony. Tool names and shapes are runtime
   * strings from another process; a server that renamed `get_positions` would
   * otherwise fail deep inside the review, with an error about the wrong thing.
   */
  static async open(config: Config): Promise<Session> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntrypoint()],
      // Built explicitly — see the header. `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS`
      // is conspicuously absent.
      env: {
        PATH: process.env["PATH"] ?? "",
        NEXUS_EXCHANGE_API_KEY: config.apiKey,
        NEXUS_EXCHANGE_API_SECRET: config.apiSecret,
        NEXUS_EXCHANGE_NETWORK: config.network,
        ...(config.baseUrl ? { NEXUS_EXCHANGE_API_URL: config.baseUrl } : {}),
      },
      // The server logs to stderr; let it through so a reader can see why a
      // handshake failed instead of getting silence.
      stderr: "inherit",
    });

    const client = new Client({ name: "risk-review", version: "0.0.0" });

    // From here on a subprocess exists, so every failure path must close it.
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      const names = new Set(tools.map((tool) => tool.name));
      const missing = ALLOWED_TOOLS.filter((tool) => !names.has(tool));
      if (missing.length > 0) {
        throw new McpError(
          `this server does not offer ${missing.join(", ")}. It exposed ` +
            `${tools.length} tools; this app needs exactly ${ALLOWED_TOOLS.length}. ` +
            "Check the pinned @nexus-xyz/exchange-mcp version.",
        );
      }

      const mutating = tools.filter(
        (tool) => !READ_ONLY_PREFIXES.some((prefix) => tool.name.startsWith(prefix)),
      ).length;

      return new Session(client, { total: tools.length, mutating });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Call one allowed tool and return its parsed JSON payload.
   *
   * The allowlist check is first, before anything else can go wrong, so the
   * refusal is unambiguous rather than a side effect of a later failure.
   */
  async call(tool: AllowedTool, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_TOOLS.includes(tool)) {
      throw new McpError(
        `refusing to call "${tool}": not in this app's allowlist ` +
          `(${ALLOWED_TOOLS.join(", ")})`,
      );
    }

    const result = await this.client.callTool({ name: tool, arguments: args });

    // `isError` is the protocol's way of reporting a tool-level failure inside
    // an otherwise successful response. Treating it as success is how a failed
    // read becomes an empty position list — which would read as "no exposure".
    if ((result as { isError?: unknown }).isError === true) {
      throw new McpError(`${tool} failed: ${firstText(result) ?? "no detail given"}`);
    }

    const text = firstText(result);
    if (text === null) {
      throw new McpError(`${tool} returned no text content to parse`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new McpError(`${tool} returned content that is not JSON`);
    }
  }

  async close(): Promise<void> {
    // Never allowed to throw: it runs in a `finally`, where a throw would mask
    // the error that actually mattered.
    await this.client.close().catch(() => {});
  }
}

/**
 * The first text block of a tool result, or `null`.
 *
 * Takes `unknown` rather than a result type on purpose: `callTool` can return
 * either the current `content` shape or the legacy `toolResult` one, and this
 * has to survive a server that sends something else again. Narrowing here beats
 * asserting a type onto bytes from a subprocess.
 */
function firstText(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

/**
 * Absolute path to the installed server's entrypoint.
 *
 * Resolved from this package's own `node_modules` rather than found on `PATH`,
 * so the review always drives the version pinned in `package.json` — not
 * whatever `exchange-mcp` a reader happens to have installed globally.
 */
function serverEntrypoint(): string {
  return new URL(import.meta.resolve("@nexus-xyz/exchange-mcp/dist/index.js")).pathname;
}
