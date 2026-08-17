/*
 * Syntax highlighting, hand-rolled.
 *
 * WHY NOT A LIBRARY. Shiki and Prism are both excellent and both wrong here: this
 * app has three runtime dependencies on purpose, and a highlighter that ships a
 * grammar engine and a theme file to colour four languages in a dozen code blocks
 * is the largest dependency on the page by an order of magnitude. The languages
 * are known and closed, so a tokenizer for exactly those is ~120 lines.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a parser. It cannot tell you that a token is a
 * type rather than a value, and it will mis-colour something eventually — which is
 * survivable, because the failure mode of a highlighter is a word in the wrong
 * shade, not a wrong claim. Everything here is per-line and regex-driven, so it
 * also cannot be confused by an unterminated construct on the line above.
 *
 * THE PALETTE: TWO ACCENTS AND AN INK LADDER.
 *
 * This briefly had a hue per token role — violet keywords, gold types, blue calls,
 * green strings, coral constants — the scheme every editor ships. It was legible and
 * it was wrong for this page: seven hues is a theme borrowed from somewhere else, and
 * a code block that looks like a screenshot of an editor stops looking like part of
 * the site it is sitting in. This page is built on ink hierarchy plus a small number
 * of accents, and its code blocks should be too.
 *
 * So colour is reserved for VALUES — a string, a number, a literal, a shell variable
 * — in the two accents the site already uses, cyan and gold. Everything structural is
 * ink: the brightest weight for language keywords, plain bright for the names that
 * matter (types and the things being called), body ink for identifiers and keys, and
 * dim for punctuation and operators. Four levels of achromatic hierarchy do the work
 * five extra hues were doing, and they do it in the site's own voice.
 *
 * WHAT IS BETTER THAN THE FIRST TWO-HUE VERSION. That one had no way to say "this is
 * a type" or "this is a call" — every identifier arrived as the same flat white,
 * because the tokenizer could not tell them apart. It can now, and the extra kinds
 * are spent on ink rather than on colour.
 *
 * The accents are the originals lifted for legibility: cyan #00a1ca measured 6.51:1
 * on the darker of this app's two code surfaces and is now 8.44, gold #b88a10 was
 * 6.26 and is now 8.83. Same hues, more readable, still two.
 */

import { DIM, FAINT, HI, TXT } from "./theme";

export type Lang = "ts" | "json" | "bash" | "http" | "plain";

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "key"
  | "punct"
  /** A called identifier — `placeOrder(`. */
  | "func"
  /** PascalCase, which in these samples is always a type or a constructor. */
  | "type"
  /** ALL_CAPS identifiers and the language's literals: true, false, null. */
  | "constant"
  | "operator"
  /** `$FOO` in a shell line. */
  | "variable";

export interface Token {
  text: string;
  kind: TokenKind;
}

/**
 * Token colours. Cyan carries values, gold carries numbers, and everything else
 * is ink weight — so a block reads as structure first and colour second.
 */
export const TOKEN_COLOR: Record<TokenKind, string> = {
  /* Ink — structure, in four levels of brightness and nothing else. */
  plain: TXT,
  key: TXT,
  func: HI,
  type: HI,
  keyword: HI,
  operator: DIM,
  punct: DIM,
  comment: FAINT,
  /* Accent — values, and only values. */
  string: "#2fb8dc",
  variable: "#2fb8dc",
  number: "#d6a730",
  constant: "#d6a730",
};

/** Only `keyword` earns weight; bolding more than one role flattens the scheme. */
/**
 * Weight is the top of the ink ladder, and only a language keyword earns it.
 *
 * `type` and `func` are already lifted to HI, which separates them from body ink
 * without a second bold on the line. Bolding three roles would flatten the scale it
 * exists to create — the reason the first version of this file only bolded one.
 */
export const TOKEN_WEIGHT: Partial<Record<TokenKind, number>> = { keyword: 600 };

/**
 * Map a block's human label to a grammar. Unknown labels highlight nothing.
 *
 * WHOLE TOKENS, NOT SUBSTRINGS. This matched `includes("ts")` and `includes("sh")`,
 * which is a rule that fires on "receipts", "charts", "results", "shortcuts" and
 * "dashboard" — any label with those two letters anywhere in it got a TypeScript or
 * shell grammar and mis-coloured silently, because the failure mode of a highlighter
 * is a word in the wrong shade rather than an error. The label is split on
 * everything that is not alphanumeric — dots included, so `nexus.json` yields
 * `json` — and a grammar is chosen only on an exact token.
 *
 * A label that names no grammar highlights nothing, which is the right default: a
 * file tree and a directory listing are not code and should not be coloured like it.
 */
export function detectLang(label?: string): Lang {
  const tokens = new Set(
    (label ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const has = (...names: string[]) => names.some((n) => tokens.has(n));

  if (has("ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs")) return "ts";
  if (has("json", "jsonc")) return "json";
  if (has("bash", "sh", "zsh", "shell", "terminal", "console", "cli")) return "bash";
  if (has("http", "https", "header", "headers", "canonical", "curl")) return "http";
  return "plain";
}

const TS_KEYWORDS = new Set([
  "import", "from", "export", "const", "let", "var", "await", "async", "function",
  "return", "new", "if", "else", "for", "of", "in", "try", "catch", "throw",
  "type", "interface", "as", "class", "extends", "true", "false", "null", "undefined",
]);

const BASH_BUILTINS = new Set([
  "npm", "npx", "node", "curl", "printf", "echo", "export", "cd", "git", "openssl",
  "shasum", "cut", "date", "nexus", "pnpm", "yarn",
]);

/*
 * One ordered pattern list per pass. Order is the whole design: comments before
 * strings (a `//` inside a string would otherwise eat the rest of the line), and
 * strings before everything, because a keyword inside a string is not a keyword.
 */
const PATTERNS: Record<Exclude<Lang, "plain">, [TokenKind, RegExp][]> = {
  ts: [
    ["comment", /\/\/[^\n]*/],
    ["string", /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/],
    ["number", /\b\d[\d_]*(?:\.\d+)?\b/],
    /* ALL_CAPS before PascalCase, or NEXUS_API_URL would be read as a type. */
    ["constant", /\b[A-Z][A-Z0-9_]{2,}\b/],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/],
    /* An identifier followed by a colon is an object key. Lookahead only — this
       scanner has no lookbehind and does not need one. */
    ["key", /\b[A-Za-z_$][\w$]*(?=\s*:)/],
    /* An identifier followed by an open paren is being called. */
    ["func", /\b[a-z_$][\w$]*(?=\s*\()/],
    ["keyword", /\b[A-Za-z_$][\w$]*\b/],
    ["operator", /=>|[=+\-*/!?&|<>]/],
    ["punct", /[{}[\]();:,.]/],
  ],
  json: [
    ["comment", /\/\/[^\n]*/],
    /* A quoted name followed by a colon is a key, not a value — matched first so
       the generic string rule cannot claim it. */
    ["key", /"(?:[^"\\]|\\.)*"(?=\s*:)/],
    ["string", /"(?:[^"\\]|\\.)*"/],
    ["number", /-?\b\d[\d_]*(?:\.\d+)?\b/],
    ["constant", /\b(?:true|false|null)\b/],
    ["punct", /[{}[\]:,]/],
  ],
  bash: [
    ["comment", /#[^\n]*/],
    ["string", /"(?:[^"\\]|\\.)*"|'[^']*'/],
    /* A leading `$` prompt is punctuation, not a variable — it is the thing you
       are told not to type. Matched before the variable rule, which would
       otherwise need to exclude it. */
    ["punct", /^\s*\$(?![A-Za-z_{])/],
    ["variable", /\$\{?[A-Za-z_][\w]*\}?/],
    ["number", /\b\d[\d_]*\b/],
    ["keyword", /\b[A-Za-z_][\w-]*\b/],
    ["operator", /[|&><=]/],
    ["punct", /[;(){}[\]\\]/],
  ],
  http: [
    ["comment", /\/\/[^\n]*/],
    /* A header name is everything up to its colon at the start of a line. */
    ["key", /^[A-Za-z][A-Za-z0-9-]*(?=:)/],
    ["string", /"(?:[^"\\]|\\.)*"/],
    ["number", /\b\d[\d_]*\b/],
    ["keyword", /\b(?:GET|POST|PUT|PATCH|DELETE|HTTP)\b/],
    ["punct", /[:<>\\/]/],
  ],
};

/* Everything after this marker on a line reads as a comment. Not exported: the
   only thing that should know the spelling is `tokenizeWithDim` below. */
const DIM_MARK = "[dim]";

/**
 * Tokenize one line.
 *
 * A keyword pattern that matched a bare word is downgraded to plain unless the
 * word is in the language's own set — cheaper and more predictable than a
 * negative lookahead per keyword, and it is what stops every identifier in a
 * TypeScript sample from arriving bright.
 *
 * BASH BUILTINS ALSO HAVE TO BE AT COMMAND POSITION. Membership alone bolded
 * `nexus` inside `https://api.nexus.xyz/v1/markets`, because the word is genuinely
 * our CLI's name and the scanner had no idea it was reading a hostname. A shell word
 * is a command only at the start of a line or after a `|`, `;` or `&` — so that is
 * the test, which is both the real rule and the one that fixes the URL.
 */
export function tokenizeLine(line: string, lang: Lang): Token[] {
  if (lang === "plain" || line === "") return [{ text: line, kind: "plain" }];

  const patterns = PATTERNS[lang];
  const out: Token[] = [];
  let rest = line;
  let guard = 0;
  /* True while the next word would be a command. Starts true; survives whitespace
     and a `$` prompt; ends at the first thing that is an argument. */
  let atCommand = true;

  while (rest !== "" && guard++ < 2_000) {
    let best: { kind: TokenKind; index: number; text: string } | null = null;

    for (const [kind, re] of patterns) {
      const m = re.exec(rest);
      if (!m || m[0] === "") continue;
      if (best === null || m.index < best.index) best = { kind, index: m.index, text: m[0] };
      if (best.index === 0) break;
    }

    if (best === null) {
      out.push({ text: rest, kind: "plain" });
      break;
    }
    if (best.index > 0) {
      const gap = rest.slice(0, best.index);
      out.push({ text: gap, kind: "plain" });
      /* Whitespace between a prompt and a command must not end command position;
         anything else is already an argument. */
      if (gap.trim() !== "") atCommand = false;
    }

    let kind = best.kind;
    if (kind === "keyword") {
      const set = lang === "bash" ? BASH_BUILTINS : lang === "ts" ? TS_KEYWORDS : null;
      if (set && !set.has(best.text)) kind = "plain";
      if (lang === "bash" && !atCommand) kind = "plain";
    }
    out.push({ text: best.text, kind });

    if (lang === "bash" && kind !== "comment") {
      /* A prompt opens a command; a pipe, a separator or an opening paren opens the
         next one — `$(date …)` is a command substitution and `date` is the command
         in it — and every other token means we are past the command word. */
      atCommand = /^\s*\$$/.test(best.text) || /^[|;&(]$/.test(best.text);
    }

    rest = rest.slice(best.index + best.text.length);
  }

  return out;
}

/** Split on the dim marker, tokenizing only the live half. */
export function tokenizeWithDim(line: string, lang: Lang): Token[] {
  const at = line.indexOf(DIM_MARK);
  if (at === -1) return tokenizeLine(line, lang);
  const head = line.slice(0, at);
  const tail = line.slice(at + DIM_MARK.length);
  return [...tokenizeLine(head, lang), { text: tail, kind: "comment" as const }];
}
