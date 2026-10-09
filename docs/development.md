# Running the Prototype

This milestone searches LinkedIn, persists a small queue, analyzes a visible
profile, and prints a generated funding message. It accepts **dry-run mode only**;
there is no sending operation. The default run discovers at most five profiles
and processes one queued profile, which may fail investor verification.

## Requirements and Setup

Use Node.js 24 and npm, with a graphical desktop session for the visible browser.
SQLite uses Node's built-in `node:sqlite` module; Node may display its experimental
API warning. No database server is required.

```bash
npm ci --ignore-scripts
npm run browser:install
cp config.example.yaml config.yaml
cp pitch.example.md pitch.md
```

Edit the private `config.yaml` and `pitch.md` before running. Set the LLM API key,
endpoint, and model in YAML. The pitch is loaded once at startup. Keep your actual
business facts in the pitch; the example is an outline, not a fictional business.

Add optional founder and business facts under `outreach` so messages can use a
real identity and a specific funding request:

```yaml
outreach:
  founder_name: Sam Founder
  founder_role: Founder and CEO
  business_name: Example Business
  industry: Healthcare software
  funding_stage: Pre-seed
  funding_ask: Raising EUR 250,000
  website: https://example.com
```

Replace example values with your own facts, or omit fields you do not wish to
supply. The pitch remains the source for your problem, solution, business story,
and verified traction. Configured outreach fields take precedence if the pitch
contradicts them. Missing details are omitted rather than replaced with template
placeholders; unresolved placeholders cause generation to stop with the row still
`working`.

Message generation looks for a relevant investment, portfolio company, sector,
or thesis in the investor's extracted About and Experience, and connects at most
one supported example to your business. It does not research outside companies
or assume that a fund's investment was made personally by the profile owner.
Without a relevant example, it uses supported role/sector context or a direct
business pitch. Review generated messages for factual accuracy.

```bash
npm run dev
```

To run discovery separately from profile analysis and message generation:

```bash
npm run dev:search
npm run dev:message
```

`dev:search` appends matching profiles to the persisted queue, deduplicating by
slug. It does not analyze profiles, load the pitch, or call the LLM.
`dev:message` processes existing `working` and `new` rows up to
`max_profiles_per_run`, without running a search. It reads investor profiles,
classifies them, and prints generated messages in dry-run mode. Both commands use
the same configuration, queue lock, and browser session. An empty message queue
exits without opening the browser. `npm run dev` still runs both stages together.
After `npm run build`, use `npm run start:search` and `npm run start:message` for
the compiled versions.

The commands take no arguments and read `config.yaml` from the working
directory. Relative file paths resolve against that file. On first use, sign in
manually in the Chromium window. The browser session is reused from
`linkedin.session_dir`; the application does not collect your password. Use an
English LinkedIn interface for this initial extraction implementation.

Generated messages go to standard output; progress and errors go to standard
error. Redirect messages with `npm run dev:message --silent > messages.txt` if desired.
Do not commit that file if it contains personal information or private pitches.

## Configuration

To regenerate messages for previously completed dry runs:

```bash
npm run queue:reset-dryruns
npm run dev:message
```

The reset command reads `queue_path` from `config.yaml` and changes only `dryrun`
rows to `new`, preserving their names, roles, identifiers, and insertion order.
It prints the number reset and refuses to run while another process holds the
queue lock. It does not open LinkedIn, contact an LLM, or require the pitch file.
Failed rows remain failed.

The complete example is [config.example.yaml](../config.example.yaml).

| Setting                                            | Behavior                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                                             | Must be `dryrun`. Live mode is rejected at startup.                                                                                  |
| `search.keywords`                                  | Keywords for ordinary LinkedIn people search, including supported Boolean syntax.                                                    |
| `search.max_results`                               | Maximum unique profiles collected per run; default 5, maximum 50.                                                                    |
| `search.max_pages`                                 | Maximum search pages visited; default 1, maximum 10.                                                                                 |
| `max_profiles_per_run`                             | Maximum queued profiles attempted per run; positive integer, default 1, no prototype cap. Rejected profiles count toward this limit. |
| `pitch_path`, `queue_path`                         | Markdown source and SQLite database paths.                                                                                           |
| `linkedin.session_dir`                             | Dedicated local browser profile directory.                                                                                           |
| `linkedin.timeout_ms`, `linkedin.login_timeout_ms` | Page timeout and manual-login timeout.                                                                                               |
| `llm.api`                                          | `responses` (default) or `chat-completions`.                                                                                         |
| `llm.structured_output`                            | Request schema-constrained assessments; disable only when the provider does not support them. Responses are still validated locally. |
| `llm.max_output_tokens`                            | Output budget per classification/generation request; includes model reasoning where applicable.                                      |
| `llm.max_message_characters`                       | Reject messages exceeding this limit.                                                                                                |

Unknown YAML keys are rejected. Other LinkedIn filters and Sales Navigator are
outside this prototype. Search results are deduplicated by profile slug, including
across restarts; a repeated search never resets a row's status.

## LLM Access

The example uses the previously recommended `gpt-6-luna`; model availability and
output quality must be checked with your account and representative samples.
Requests use the official OpenAI SDK with a configurable endpoint. The Responses
integration uses self-contained requests and `store: false`, following
[OpenAI's structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs).
Dry runs still incur usage charges when using a paid provider.

For local Ollama, install a suitable model separately and change the LLM section:

```yaml
llm:
  provider: openai-compatible
  base_url: http://localhost:11434/v1/
  model: qwen3:8b # Must already be installed locally.
  api_key: ollama
  api: chat-completions
  structured_output: true
```

Compatibility depends on the server version and model. See
[Ollama's compatibility documentation](https://docs.ollama.com/api/openai-compatibility).
For an Ollama server on your LAN, use its reachable address, for example
`base_url: http://192.168.0.2:11434/v1`. HTTP and HTTPS endpoints are supported;
include `/v1` and keep the model name consistent with a model installed on that
server. A trailing slash is optional. URLs cannot include credentials, query
parameters, or fragments.
If the server rejects structured output, set `structured_output: false`; invalid
assessment JSON still stops the run. LLM requests are not automatically retried.

LLM failures report the operation, endpoint, model, HTTP status, provider message,
and request ID when available. Connection errors include nested network causes
(for example, `ECONNREFUSED`, `ENOTFOUND`, address, and port); timeouts report the
configured duration. Diagnostics are bounded and redact the configured API key,
authorization tokens, and supplied source text. Request bodies and headers are
not logged. The queue row stays `working` so rerunning resumes it.

Classification receives labeled Header, About, and Experience text, with separate
character budgets so a long About cannot crowd out Experience. It also receives
the same profile's search-result role as supporting evidence. Logs show section
sizes, truncation, the decision, and the model's reason and evidence.

A self-attributed `Angel Investor` headline is sufficient evidence, even alongside
another occupation. Startup investing and investment roles at VC funds also
qualify; incidental investor mentions, recruiting, and fund support roles alone
do not. A positive assessment must quote an excerpt present in the profile or
search role. The LLM still makes the decision; these validation checks do not
guarantee classification accuracy. Uncertain assessments become `failed` with
`investor status uncertain`.

## Persistence and Recovery

`queue` contains `id`, `name`, `role`, `slug`, `status`, and `failure`. It resumes a
`working` row before selecting the oldest `new` row. Successful terminal output
marks the row `dryrun`. Missing profiles and non-investors use the agreed exact
failure reasons. `failed`, `dryrun`, and `sent` rows are not selected automatically;
the explicit reset command can return `dryrun` rows to `new`. To retest previously
failed profiles after changing classification, use a separate `queue_path` (for
example `data/classification-test.sqlite`); existing failed rows stay failed.

`proper-lockfile` allows one active process per queue, with a heartbeat and stale
lock recovery. SQLite commits each search append and status change independently.
Do not manually delete an active lock. Interrupted pre-output work remains
`working`; restarting may regenerate the message. Output interrupted before its
completion is persisted may be displayed again; this prototype never sends it.

Authentication expiry, checkpoints, recognized account warnings, unsupported
layouts, and LLM failures stop the run while preserving progress. Resolve the
problem manually, then restart. Do not reset failed rows as part of recovery.

Search waits for complete name-and-headline cards, with bounded fallbacks for
layouts that do not use the original result classes. If parsing still times out,
the error names a layout report saved beside the browser session directory
(normally `data/diagnostics/search-layout-*.json`). It contains link counts and
element structure, without visible profile text, profile identifiers, search query
parameters, or browser cookies. Use it to diagnose changed markup. These reports
are ignored by Git.

Profile loading supports visible names in headings, accessible headings, and
header text matching the queued name. It reads bounded header, About, and
Experience content rather than requiring `h1` and `section` elements. Profile
loading failures save `profile-layout-*.json` in the same diagnostics directory,
recording element structure and whether the queued name was found, without
storing the name or visible profile text. The selected row stays `working` for
restart after the problem is resolved.

Browser layouts can change; local fixture checks cannot establish compatibility
with your live account. Dry-run mode prevents sending but still automates search
and profile access. LinkedIn prohibits unauthorized automation and may restrict
accounts ([LinkedIn policy](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions)).

`config.yaml`, `pitch.md`, `data/`, and generated SQLite files are ignored by Git.
Browser session files grant account access and must be kept private. Relevant
visible profile text and your pitch are sent to your configured LLM service.

## Development Commands and Layout

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Run TypeScript locally.                                         |
| `npm run build`        | Compile `src/` into `dist/`.                                    |
| `npm start`            | Run the compiled no-argument CLI after building.                |
| `npm test`             | Run Node's built-in test runner with native TypeScript support. |
| `npm run typecheck`    | Check strict TypeScript types without emitting files.           |
| `npm run format:check` | Check Prettier formatting.                                      |
| `npm run format`       | Format source, tests, and new documentation.                    |
| `npm run check`        | Run type checking, tests, and formatting checks.                |

`src/config.ts` handles startup, `src/queue.ts` handles storage,
`src/linkedin.ts` handles browser access, `src/llm.ts` handles classification and
writing, and `src/workflow.ts` coordinates the steps. `src/cli.ts` owns resources
and handles interruptions. Tests live under `tests/` and use synthetic profiles,
mock LLM responses, and temporary SQLite databases. No coverage percentage is
mandated. Use descriptive `*.test.ts` names, two-space indentation, and Prettier.
TypeScript performs static checking; no separate lint tool is configured.

Browser fixture tests intercept all requests locally and run headlessly. They
are skipped with an explicit notice if Chromium is not installed. Run
`npm run browser:install` and repeat `npm test` to include them. Tests never use
your LinkedIn login or incur LLM charges.

## Manual Feasibility Check

1. Configure your actual pitch, a narrow keyword query, and LLM access.
2. Run the CLI from a graphical desktop and complete manual login.
3. Verify search rows in the SQLite `queue` table and compare them with the browser.
4. Verify the selected profile's investor evidence and generated message in the terminal.
5. Restart and confirm previously completed rows are skipped and the session is reused.

Live sending is a later milestone. Before adding it, validate message eligibility
and choose how to recover from an uncertain send without sending twice.
