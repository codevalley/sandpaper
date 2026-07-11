# Sandpaper

A **living project brain** for Claude Code and Codex projects. Sandpaper scaffolds a
small static site in `brain/`—a cover, three lenses, and three books—and installs
provider-neutral workflows that teach either agent to keep it current. After substantive
work, the agent stamps the brain: it records the work, refreshes the digest a new session
reads, updates the plan, and captures decisions and gotchas.

The repository and rendered files remain authoritative for behavior. The shared brain is
the canonical durable record of intent, decisions, plans, progress, and learnings. Claude
and Codex sessions are resumable compute context, not competing project histories.

No framework, build step, database, or runtime dependency. It is plain HTML on disk,
maintained by the agent and readable by you.

## Quick start

Install both Claude Code and Codex integrations into the current repository:

```bash
npx @nynb/sandpaper install-skill
```

Then initialize the same brain from either agent:

```text
/sandpaper:init       # Claude Code
$sandpaper init       # Codex
```

Open it in a browser:

```bash
npx @nynb/sandpaper open
```

Dual installation is the default. Constrained environments can install one integration,
and hook configuration can be disabled explicitly:

```bash
npx @nynb/sandpaper install-skill --integration claude --provider claude
npx @nynb/sandpaper install-skill --integration codex --provider codex
npx @nynb/sandpaper install-skill --no-hooks
```

`--integration` selects which agent entrypoints are installed. `--provider` is separate:
on `install-skill` or `init` it selects the local manifest default, while on `open` or a
serve command it overrides only that launch. Both forms accept only `claude` or `codex`.

## What you get

- **`brain/`** — a multi-page static site: a cover with a machine-readable
  `#brain-state` digest, one-line NOW, plan lenses, worklog, decisions, and learnings.
- **One canonical workflow set** — Claude uses `/sandpaper:<action>` wrappers and Codex
  uses the `$sandpaper <action>` dispatcher, but both execute the same provider-neutral
  workflow documents and update the same brain.
- **The canvas** — a whiteboard on the cover for explanations worth keeping. It retains
  the current board and a bounded stack of earlier boards.
- **The refine toolbar** — a local overlay for scoped AI edits, direct edit/move/delete,
  Undo, and terminal-ready Sling instructions. The document bytes on disk remain the
  source of truth and the browser reloads from them.

Sandpaper now installs and diagnoses Claude Code and Codex as first-class agent
integrations. The current toolbar still dispatches turns through Claude; the provider
selector, controlled embedded Codex execution, provider-scoped toolbar histories/reset,
and provider-specific usage presentation are the remaining **v0.3.0 Toolbar Wave**. The
CLI accepts provider choices now without implying that current toolbar turns consume that
routing.

## CLI plumbing

| Command | What it does |
|---|---|
| `sandpaper install-skill [--integration claude\|codex] [--provider claude\|codex] [--no-hooks]` | Install both integration trees by default, or an explicit solo tree; scaffold the brain and shared hook scripts. |
| `sandpaper init [--provider claude\|codex]` | Scaffold missing brain files; an explicit provider changes only the local runtime default and preserves integration/hook intent. |
| `sandpaper upgrade` | Refresh generated integrations, managed blocks, scripts, assets, and canvas while preserving provider choices, hooks intent, identity, counters, theme, and sessions. |
| `sandpaper rebuild` | Back up the old brain and lay down a fresh shell while preserving the same local intent and durable identity fields. |
| `sandpaper doctor` | Check brain truth, manifest/session schemas, installed integration bytes, hooks, provider capability, and authentication readiness. |
| `sandpaper open [--provider claude\|codex]` | Serve this repository's brain and open it; the provider option is a launch-only override. |
| `sandpaper [--provider claude\|codex] <doc.html \| dir>` | Serve a document or directory with the on-page toolbar; the provider option is a launch-only override. |
| `sandpaper help` | Show current syntax and truthful provider status. |

The server binds only to `127.0.0.1`. It uses port `4848` by default; the local manifest
or `SANDPAPER_PORT` can override it, and Sandpaper tries the next local port when needed.

## Agent workflows

Use `/sandpaper:<action>` in Claude Code or `$sandpaper <action>` in Codex. The supported
actions are identical:

| Action | Purpose |
|---|---|
| `init` | Discover the repository and fill the shared brain. |
| `stamp` | Update worklog, NOW, digest, decisions, learnings, plan, and map after substantive work. |
| `log` | Add one worklog entry. |
| `plan` | Add or update a task or initiative. |
| `decide` | Record a decision or open/resolve a question. |
| `learn` | Record a gotcha or verdict. |
| `canvas` | Elevate an explanation into the cover's current board. |
| `sync` | Reconcile brain state against repository truth. |
| `open` | Open the brain. |
| `serve` | Serve the brain or another document. |
| `theme` | Re-skin the brain from a brand color or preset. |
| `release` | Draft, confirm, gate, version, tag, and push a release through the shared workflow. |
| `help` | Show workflow help. |

Interactive `$sandpaper` commands run inside the user's normal Codex environment. That
is distinct from the controlled embedded Codex toolbar runtime planned for the Toolbar
Wave.

## Authentication, hooks, and trust

Codex uses the authentication already established by `codex login`, whether that is a
ChatGPT login or an intentionally configured API key. Sandpaper does not read credential
files or print identities, tokens, raw authentication output, or secret material.
`doctor` runs capability commands and reports only readiness, compatible version, and a
coarse authentication method such as `chatgpt`, `api-key`, or `subscription`.

By default, `install-skill` writes provider-specific hook configuration and two shared
scripts. Existing settings and unrelated hooks are preserved. Codex project hooks run
only after the project is trusted, and each command hook must be reviewed during startup
or through `/hooks`; written configuration is not a claim that SessionStart is active.
Use `--no-hooks` to install both integrations and scripts without writing either provider
hook configuration. `upgrade` and `rebuild` preserve that disabled intent.

## Runtime safety boundary

Sandpaper's toolbar process runs from the real document directory. This is
project-directory access, not hard single-file or OS-level isolation: an agent process can
write other project paths. Sandpaper tells the agent to target the selected document and
derives Saved/Replied and Undo truth only from that document's actual bytes. It cannot
verify or undo unrelated path changes and does not automatically revert them.

Toolbar Codex controls such as explicit no-fallback selection, network/integration
disablement, separate browser histories, and provider-scoped reset are not documented as
current behavior because they belong to the remaining Toolbar Wave.

## Publishing and release

The canonical `release` workflow reads the brain, asks a human to confirm the bump and
notes, stamps the release record, stages only known paths, and runs all release gates
before a separate final confirmation authorizes version/tag/push. The pushed tag triggers
`.github/workflows/release.yml`, which re-verifies the exact package, publishes with npm
provenance, and creates the GitHub Release.

The package ships an explicit per-file allowlist, zero runtime dependencies, exact packed
install evidence, secret/path scanning, relative-import closure, and size envelopes.
Historical changelog entries remain historical evidence and are not rewritten when the
current provider model changes.

`brain/` itself is plain static content and can be hosted directly on GitHub Pages,
Vercel, Netlify, or Cloudflare. See the scaffolded [`brain/README.md`](brain/README.md).

## Requirements and conventions

- Node.js 18 or newer, ESM, and zero runtime dependencies.
- The document on disk is the source of truth; the browser never gets ahead of it.
- The brain links to canonical repository facts instead of copying them.
- The local server binds to `127.0.0.1` only.

## License

MIT
