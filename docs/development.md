# Running the Prototype

The CLI separates discovery and investor validation, message generation, and delivery.
All settings come from `config.yaml`; commands take no arguments. The example
uses `dryrun-terminal`, discovers up to five profiles, and attempts one profile
per write run and one message per send run.

## Setup

Use Node.js 24 and npm. LinkedIn operations require a graphical desktop session.
SQLite uses Node's built-in `node:sqlite`; no database server is required.

```bash
npm ci --ignore-scripts
npm run browser:install
cp config.example.yaml config.yaml
cp pitch.example.md pitch.md
```

Edit the private configuration and pitch before running. Paths resolve relative
to `config.yaml`. Sign in manually in the Chromium window on first use; the
browser session is reused from `linkedin.session_dir`. Use an English LinkedIn
interface. Keep credentials, browser sessions, pitches, and generated messages private.

**This version requires a fresh database.** Legacy databases containing the old
`queue` table are rejected without migration. Remove your old database yourself
while no CLI is running, or configure a new `queue_path`. The tool does not delete it.

## Three Independent Stages

```bash
npm run dev:search
npm run dev:write
npm run dev:send
```

- **Search:** Discover unique candidates, then open each unseen profile and classify
  investor status with the LLM. Save accepted profiles as `new` and validation
  failures as `failed`, with an explanation. Existing slugs retain their status.
  This stage does not read the pitch or generate messages.
- **Write:** Resume `working` profiles before claiming the oldest `new` profile.
  Reopen LinkedIn for fresh information, generate both subject and body, and save
  one message per profile. Saving the message and changing the profile to `written`
  happen in one transaction. Investor classification is not repeated. The pitch
  is loaded once at startup. Generation errors return the profile to `new`, log
  the reason, and continue; each profile is attempted only once per invocation.
- **Send:** Select saved messages with status `new` in insertion order. Use their
  stored subject and body without loading the pitch or calling the LLM. A terminal
  send run does not open LinkedIn. Preparation failures log and skip the message,
  leaving it `new` for a subsequent invocation.

`max_profiles_per_run` limits attempts independently in write and send, including
failed or skipped attempts. Search uses `search.max_results` and `search.max_pages`.
Empty write/send queues exit without opening a browser. `npm run dev` runs all
three stages. After building, use `start:search`, `start:write`, and `start:send`.
The former `dev:message` and `start:message` commands have been replaced.

Progress and errors go to standard error. Terminal delivery prints recipient,
profile URL, subject, and body to standard output:

```bash
npm run dev:send --silent > messages.txt
```

## Founder Context and Message Quality

Supply the business story and verified traction in `pitch.md`. Add optional facts
under `outreach` for a complete identity, request, and signature:

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

Configured facts take precedence over conflicting pitch text. Missing facts are
omitted; unresolved placeholders prevent saving a message. Website links are plain
URLs; supported Markdown/link wrappers are normalized before validation.
Generation can connect one relevant investment, portfolio company, sector, or
thesis from the profile to your business. It does not research outside companies
or assume a fund's investment was personally made by the profile owner. Review
saved messages for factual accuracy before live delivery.

## Delivery Modes and Browser Review

Select `mode` in YAML; it affects delivery only:

- **`dryrun-terminal`:** Print the saved subject and body, then mark the message
  `dryrun` after successful output.
- **`dryrun-browser`:** Open a separate recipient tab, wait for the profile to load,
  open its Message action, verify the recipient, and prepare the saved body.
  InMail also receives the saved subject; ordinary chats ignore it. Record `dryrun`
  after the recipient is verified and filling completes. No Send click or Enter submission occurs.
- **`live`:** Verify the recipient and fill as above, then click Send
  inside the verified composer. Record `sent` only after browser UI confirmation.
  Selecting live mode authorizes sending up to the configured attempt limit.

The only browser validation before filling or sending is whether the selected
recipient matches the profile slug, or name when no header slug is available.
The saved body and optional InMail subject are filled directly, replacing existing
draft contents. The tool does not validate draft text, compare readback, or check
chat-history contents. Message and subject quality checks belong to `dev:write`.
Failures to locate or fill the selected recipient's editor leave messages `new`
and continue to later recipients.

Immediately before clicking Send, SQLite commits a reserved failed marker. A new
sent notice, or an increased displayed-message count plus an empty editor, confirms
submission. An empty editor alone does not. Successful confirmation promotes the
marker to `sent`. A click error, confirmation timeout, interruption, or crash leaves
`failed`, preventing automatic duplicate sends. Inspect the LinkedIn conversation
manually before taking further action. UI confirmation does not establish that the
recipient read the message.

After browser delivery, including errors, the terminal prints:

```text
Waiting for browser to be closed by the user
```

Review all tabs and close the browser to finish and release the database lock.
Closing it during processing interrupts outstanding work. Ctrl+C also interrupts.
Generated text remains in SQLite even if LinkedIn does not retain browser drafts.

## Persistence, Recovery, and Maintenance

Both tables live at `queue_path`:

| Table       | Fields and statuses                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `profiles`  | `id`, `name`, `role`, unique `slug`, `status` (`new`, `working`, `written`, `failed`), `failure`.                     |
| `messaging` | `id`, unique `profile_id` foreign key, `subject`, `message`, `status` (`new`, `sent`, `failed`, `dryrun`), `failure`. |

Failed investor validation remains failed, including missing profiles, non-investors,
uncertain assessments, and profile/classification errors. Interrupted writing leaves
`working` for resumption. Generation and preparation errors are retried on a later
invocation; failed submission rows are excluded. Authentication expiry, account
checkpoints, interruptions, and database errors stop the run while preserving progress.

```bash
npm run queue:reset-dryruns
npm run queue:clear-messages
npm run queue:clear-profiles
```

These commands use the same exclusive lock and need no browser, pitch file, or LLM:

- **Reset dry runs:** Change only messaging `dryrun` to `new`; preserve subjects,
  bodies, profiles, and all other statuses. Rerun `dev:send` to reuse the text.
- **Clear messages:** Delete every saved message, including sent/failed rows, and
  reset `written` profiles to `new`. Failed profiles stay failed. Rerun `dev:write`
  to regenerate. Clearing sent records removes duplicate-send protection; review
  existing conversations before using this command for live outreach.
- **Clear profiles:** Delete all profiles and all associated messages for a fresh
  search. This also removes delivery history.

SQLite transactions protect local changes. `proper-lockfile` permits one active
CLI per database with heartbeat and stale-lock recovery. Do not delete active locks.
Terminal output interrupted before its status is saved may be printed again.
Search discovery completes before profile navigation; validated rows are committed
individually. Unvalidated candidates are rediscovered on a subsequent search run.

## Configuration

See [config.example.yaml](../config.example.yaml) for all fields. Unknown keys are rejected.

| Setting                                            | Behavior                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `mode`                                             | `dryrun-terminal`, `dryrun-browser`, or `live`; rename the former `dryrun`.   |
| `search.keywords`                                  | Ordinary LinkedIn people search keywords, including Boolean syntax.           |
| `search.max_results`, `search.max_pages`           | Defaults 5 and 1; maximums 50 and 10.                                         |
| `max_profiles_per_run`                             | Positive safe integer; default 1; independent write/send attempt limit.       |
| `pitch_path`, `queue_path`                         | Markdown pitch and SQLite database paths.                                     |
| `linkedin.session_dir`                             | Dedicated persistent browser profile directory.                               |
| `linkedin.timeout_ms`, `linkedin.login_timeout_ms` | Page/action timeout and manual-login timeout.                                 |
| `llm.api`                                          | `responses` (default) or `chat-completions`.                                  |
| `llm.structured_output`                            | Request schema-constrained classification; returned JSON is always validated. |
| `llm.timeout_ms`                                   | Per-request timeout; default 60000 ms, maximum 300000 ms.                     |
| `llm.max_output_tokens`                            | Output budget per request, including model reasoning where applicable.        |
| `llm.max_message_characters`                       | Generated messages must fit this limit.                                       |

Other search filters and Sales Navigator are outside this prototype. Send and
maintenance still validate the complete YAML, but do not contact the configured LLM.

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
  model: gemma4:e4b # Tested model; must already be installed on the server.
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
assessment JSON still records a failed validation. LLM requests are not automatically retried.

LLM failures report the operation, endpoint, model, HTTP status, provider message,
and request ID when available. Connection errors include nested network causes
(for example, `ECONNREFUSED`, `ENOTFOUND`, address, and port); timeouts report the
configured duration. Diagnostics are bounded and redact the configured API key,
authorization tokens, and supplied source text. Request bodies and headers are
not logged. Search saves classification failures as failed profiles; writing skips
generation failures and returns profiles to `new` for the next run.

Classification receives labeled Header, About, and Experience text, with separate
character budgets so a long About cannot crowd out Experience. It also receives
the same profile's search-result role as supporting evidence. Search logs show extracted text size, truncation, the decision, and the model's reason and evidence.

A self-attributed `Angel Investor` headline is sufficient evidence, even alongside
another occupation. Startup investing and investment roles at VC funds also
qualify; incidental investor mentions, recruiting, and fund support roles alone
do not. A positive assessment must quote an excerpt present in the profile or
search role. The LLM still makes the decision; these validation checks do not
guarantee classification accuracy. Uncertain assessments become `failed` with
`investor status uncertain`.

## Diagnostics and Privacy

Search/profile layout reports under `data/diagnostics/` contain structure and
counts without profile text, identifiers, query parameters, or cookies. Composer
reports include the processing stage, Message action, visible dialogs, editors,
frames, and popup counts without draft text. `composerCandidates` also reports
recipient-name matches, profile-link matches, editor counts, and InMail editor
labels for each visible message container, including the full message center.
Composer detection requires a matching recipient header slug (or exact active
recipient name when no header slug is available) and one message editor.
Name matching ignores hidden accessibility text, zero-width formatting, and known
connection-degree or presence labels, while still rejecting different full names. The active conversation pane also supports ordinary recipient text without
heading tags or specific classes. This fallback excludes the conversation list,
editor, and history as identity sources; it does not inspect chat content or
require a particular position relative to history. Arbitrary names elsewhere in the message center do not
verify a recipient. `paneNameMatches` reports this fallback in diagnostics. Other
profile links and UI labels do not reject the composer. An available subject
field identifies InMail; other forms are prepared as chats. Recipient identity is checked before filling and before live sending. Browser failures preserve the first
line of the underlying error; the workflow reports the resulting row status.

LinkedIn layouts change; fixture checks cannot prove compatibility with a live
account. Both dry-run modes still automate LinkedIn access. The account suspension
warning in the [README](../README.md) applies to all LinkedIn operations.
Browser sessions grant account access. SQLite now contains recipients and generated
funding messages. Keep the database, WAL files, sessions, private config, and pitch
out of version control. Profile text and pitch context go to your configured LLM.

## Development Commands and Layout

| Command                | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `npm run build`        | Compile `src/` into `dist/`.                            |
| `npm start`            | Run all compiled stages.                                |
| `npm test`             | Run Node's built-in test runner with native TypeScript. |
| `npm run typecheck`    | Check strict TypeScript without emitting files.         |
| `npm run format:check` | Check Prettier formatting.                              |
| `npm run check`        | Run type checking, tests, and formatting.               |

Domain workflows live in `src/search/`, `src/writing/`, and `src/communication/`.
`src/infrastructure/` holds LinkedIn, SQLite, and LLM adapters. `src/shared/` holds
interfaces and errors; `src/app/` handles configuration and composition, with
entry points under `src/app/cli/`. Use two-space indentation and Prettier.

Tests under `tests/` use synthetic profiles, injected services, and temporary
SQLite databases. There is no coverage percentage requirement or separate lint tool.
Browser fixture tests intercept requests locally and are skipped when Chromium is
unavailable. Tests never use your LinkedIn login or incur LLM charges.

For manual verification, run search and inspect profiles and their validation
reasons; run write and inspect saved subjects/bodies; then run terminal send.
Reset dry runs and test browser delivery, including replacing existing drafts. Verify that all eligible recipients get tabs before browser review.
For live testing, choose eligible recipients and a small limit, then inspect the
conversation and saved status before any reset or clear operation.
