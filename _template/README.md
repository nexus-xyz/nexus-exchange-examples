# `_template/` — copy-to-start scaffold

This directory is **not an example**. It's the starting point you copy when you
add one. (The leading underscore keeps it sorted above the track directories and
marks it as not-an-example.)

## What's here

| File | What it's for |
| --- | --- |
| [`EXAMPLE_README.md`](./EXAMPLE_README.md) | The README template. Copy it as your example's `README.md` and fill in every section. |
| [`.env.example`](./.env.example) | The credentials template, for examples that need an API key. |
| [`stub-ts/`](./stub-ts) | A working TypeScript app — fetches live testnet markets. Copy it to start a TS example, or read it as a reference for any language. |

## Starting a TypeScript example

```bash
cp -r _template/stub-ts sdk-ts/my-example
cd sdk-ts/my-example
npm install
npm start          # prints live testnet markets
```

Then, in the copy:

1. **`package.json`** — set `name` to your example's directory name. Keep the
   `@nexus-xyz/exchange-ts` version **exactly pinned** (no `^`).
2. **`src/index.ts`** — replace the body with your app. Keep the pattern of
   reading credentials from the environment and treating them as optional if your
   example can do anything useful without them.
3. **`README.md`** — it's a filled-in copy of `EXAMPLE_README.md`. Rewrite it for
   your app; don't leave the stub's text in place.
4. **`.env.example`** — keep it if you need credentials, and document every
   variable you read. Delete it if you don't.

## Starting an example in another language

There's no stub for Rust, Python, or the CLI yet — the track-2 seed examples will
serve as those references once they land. Until then, copy the README template
and follow the same standards:

```bash
mkdir -p analytics/my-example
cp _template/EXAMPLE_README.md analytics/my-example/README.md
cp _template/.env.example      analytics/my-example/.env.example
```

Your example must still be self-contained, pin its SDK/CLI version exactly, run
against testnet, and build in CI. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## A note on maintenance

`stub-ts` is built and typechecked by CI exactly like a real example, so it can't
rot. If you change the standards in `CONTRIBUTING.md`, change the stub to match —
it's the copy people actually start from, so it's the one that teaches.
