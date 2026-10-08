# Implementation Plan

## Application Contract

Build a local CLI in TypeScript with no arguments. One YAML file configures the application, including investor search criteria and live or dry-run mode. A separate Markdown file supplies the free-form business and funding pitch.

**Selected first milestone:** a Playwright feasibility prototype using a visible local browser and manual login. Discover at most five profiles and process one queued profile by default, printing its message in dry-run mode. Live sending remains a later milestone. See [the development guide](development.md) for implemented settings, commands, and validation limits. The workflow below describes the full product; its live-delivery acceptance criteria are not claimed by the prototype.

At startup, load and validate the YAML, load the entire Markdown pitch into memory, and open the persisted queue. Run search once, then process queued investors one at a time until no eligible rows remain.

Keep search, analysis and generation, and delivery as separate modules behind one CLI. This allows search to run independently in the future without adding that option now.

## Language and Storage

**Confirmed language:** TypeScript.

**Confirmed storage:** SQLite, with one local database file such as `data/queue.sqlite` and one queue table. It requires no database server and suits local application storage ([SQLite guidance](https://www.sqlite.org/whentouse.html)). Transactional updates protect persisted queue changes from partial writes during an interruption ([transaction guarantees](https://www.sqlite.org/transactional.html)). They do not make LinkedIn delivery and the subsequent local status update a single transaction; the delivery recovery decision below still applies.

Proposed implementation: use direct SQL for the queue table, without an ORM. Finalize the TypeScript runtime and SQLite integration during project setup.

## Configuration

The YAML should cover:

- Investor search criteria.
- Execution mode: live or dry run.
- Path to the Markdown pitch file.
- Path to the persisted queue.
- LinkedIn access and session settings.
- LLM provider, model, and access settings.

Proposed default: read `config.yaml` from the working directory and resolve configured relative paths against its directory. Final field names and technology choices remain to be agreed.

## LLM Recommendation and Configuration Example

**Recommended starting model:** OpenAI's `gpt-6-luna`. The [official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) positions it for focused, cost-sensitive workloads. It is a starting recommendation for profile analysis and short personalized funding messages; its suitability for this project must be validated with representative profiles and generated messages.

Example LLM section for the YAML configuration, using proposed field names:

```yaml
llm:
  provider: openai-compatible
  base_url: https://api.openai.com/v1
  model: gpt-6-luna
  api_key: YOUR_OPENAI_API_KEY
```

This is a partial configuration example, not a complete application configuration. The API key is a placeholder; keep real credentials out of version control. Keep the endpoint and model configurable rather than hardcoding the recommendation.

For local Ollama, the same proposed configuration can use `http://localhost:11434/v1/`, an installed Ollama model, and the placeholder key `ollama`. Ollama ignores that local key and supports a subset of the OpenAI API, including stateless Responses requests ([compatibility documentation](https://docs.ollama.com/api/openai-compatibility)). Use self-contained requests containing the pitch and relevant profile information so generation does not depend on provider-managed conversation state.

Before choosing the final model, review a small dry-run sample for accurate investor classification, factual personalization, and message quality. Dry-run mode still calls the configured LLM; when using OpenAI, those requests incur API usage charges. Investor verification uses the LLM as described below.

## LinkedIn Access Options

**Selected integration:** local browser automation with Playwright, reusing a dedicated local browser session. The prototype supports keyword criteria on ordinary people search, with configurable result and page limits. Other filters can be added after verifying the browser workflow against the user's account. The options considered are retained below for reference.

| Option | Approach | Considerations |
| --- | --- | --- |
| Official LinkedIn APIs | Use OAuth and the capabilities explicitly granted to the application. | Open developer permissions cover identity and social posting, not the general people-search and private-message workflow. Other permissions usually require approval; verify granted capabilities before choosing this route ([access documentation](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)). |
| Local browser automation | Use a TypeScript browser library such as Playwright to operate the user's LinkedIn interface and reuse an authenticated session. | Fits the local CLI architecture, but requires maintenance when the interface changes. Search and messaging depend on account capabilities. Playwright supports saved authentication state ([authentication documentation](https://playwright.dev/docs/auth)). LinkedIn prohibits third-party scraping and website automation ([LinkedIn policy](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions)). |
| Hosted integration service | Connect the LinkedIn account to a service such as Unipile and call its search, profile, and messaging endpoints. | Adds a service dependency and subscription cost. Available operations depend on the connected account. Vendor-provided access does not by itself establish LinkedIn authorization ([vendor capabilities](https://www.unipile.com/communication-api/messaging-api/linkedin-api/), [search documentation](https://developer.unipile.com/docs/linkedin-search)). |

Standard LinkedIn people search offers keywords and filters such as location, company, industry, and connection degree ([search documentation](https://www.linkedin.com/help/linkedin/answer/a525054)). Sales Navigator adds dedicated lead filters such as current job title and seniority; it is a subscription/search interface choice, not automatic approval for API access ([filter documentation](https://www.linkedin.com/help/sales-navigator/answer/a1468001)).

Messaging must reflect the user's actual access: first-degree connections can receive free messages, while non-connections may require Open Profile access, an available message-request route, or InMail ([messaging documentation](https://www.linkedin.com/help/linkedin/answer/a554575)). Whether to support InMail and how to classify recipients who cannot be messaged remain to be decided.

## Persisted Queue

| Field | Meaning |
| --- | --- |
| `name` | Investor's name from the search result. |
| `role` | Role or headline from the search result. |
| `slug` | LinkedIn profile identifier used to open the profile. |
| `status` | `new`, `working`, `sent`, `failed`, or `dryrun`. |
| `failure` | Reason for failure; empty for other statuses. |

Proposed queue rules:

- Use the slug to identify and deduplicate investors.
- Append previously unseen results with status `new`.
- Preserve existing statuses and failure reasons when a search finds the same slug again.
- Persist each transition before proceeding to the next operation.
- Process rows in insertion order, prioritizing `working` over `new`.
- Permit one running CLI instance per queue to avoid concurrent processing.

**Confirmed failure policy:** Failed rows stay `failed`; subsequent runs must not retry or automatically reset them.

`sent`, `failed`, and `dryrun` rows are excluded from automatic selection. The proposed handling for `dryrun` rows is to leave them completed when switching to live mode; that behavior still needs confirmation. Reset or replay tooling is outside the initial workflow.

## Step 1: Search

Search LinkedIn using the YAML criteria. Collect each result's name, role, and slug, then append it to the queue according to the deduplication rules. Persist collected results as the search progresses so an interruption does not discard completed discovery.

## Step 2: Analyze and Generate

1. Select the first `working` row. If none exists, select the first `new` row and persist its transition to `working`. Stop when neither exists.
2. Open the LinkedIn profile using its slug.
3. If the profile does not exist, persist `failed` with the exact failure text `invalid slug, profile not found`.
4. If the profile exists, use the LLM to determine whether the person is an investor. Supply the available profile text and treat keywords such as `VC`, `Angel`, and `Investor` as evidence. If not an investor, persist `failed` with the exact failure text `not an investor`.
5. Extract relevant profile information and combine it with the pitch already loaded in memory.
6. Ask the LLM to generate a personalized direct message requesting funding. Ground the message in the supplied pitch and observed profile information.
7. Pass the message and selected queue row to Step 3. The row remains `working` until delivery finishes.

Only a confirmed missing profile should receive the profile-not-found reason. Authentication problems and temporary LinkedIn failures need distinct handling.

Proposed classification guidance: interpret keywords in context rather than treating a match as proof. A founder seeking investors or a recruiter mentioning VC clients should not qualify solely because those words appear. Require the classifier to return its decision with supporting profile evidence. The treatment of insufficient or ambiguous evidence remains to be agreed.

## Step 3: Deliver

- **Live mode:** Send the generated direct message on LinkedIn. Persist `sent` only after confirming delivery.
- **Dry-run mode:** Print the recipient and generated message to the terminal. Persist `dryrun` after successful output.
- **Recipient-specific errors:** Persist `failed` with an explanatory reason, then continue with the next row.
- **Application-wide errors:** Stop with a clear terminal error when configuration, authentication, or a required service prevents further work; preserve the queue for recovery.

The normal transitions are `new → working → sent`, `new → working → dryrun`, and `working → failed`.

## Delivery Recovery Decision

An interruption after sending but before recording `sent` leaves a `working` row whose delivery is uncertain. Blindly repeating Step 2 and Step 3 could send twice. Before implementing live delivery, choose whether to check LinkedIn for prior delivery or mark uncertain deliveries `failed` for manual review. Any additional persisted recovery information must be designed explicitly. The prototype has no sending operation, so this decision does not block its dry-run implementation.

## Work Breakdown

1. **CLI and configuration:** Establish the project, no-argument entry point, YAML validation, and startup pitch loading.
2. **Queue storage:** Implement persistence, slug deduplication, insertion ordering, status transitions, and exclusive access.
3. **LinkedIn search:** Implement access, configured search, result extraction, and incremental queue updates.
4. **Profile analysis and writing:** Implement profile lookup, investor verification, relevant information extraction, and LLM generation.
5. **Delivery:** Implement direct messaging, terminal output, failure reporting, and the agreed recovery policy.
6. **Integration:** Connect the three steps and verify restart behavior end to end.

## Acceptance Criteria

### Confirmed Workflow

| Scenario | Expected result |
| --- | --- |
| Start the CLI with no arguments | Configuration comes from YAML; the Markdown pitch is read once at startup and reused for every row. |
| Search finds a previously unseen profile | A persisted row contains its name, role, slug, status `new`, and an empty failure value. |
| Both `working` and `new` rows exist | Resume a `working` row before selecting a `new` row. |
| Only `new` rows are eligible | Select the first row, persist `working`, and then open its profile. |
| The selected profile does not exist | Persist `failed` and exactly `invalid slug, profile not found`; do not generate or send a message for it. |
| The selected profile exists | Ask the LLM to assess investor status using profile information and signals such as `VC`, `Angel`, and `Investor`. |
| The LLM determines the selected person is not an investor | Persist `failed` and exactly `not an investor`; do not generate or send a message for them. |
| The profile is an investor | Supply both the loaded pitch and relevant profile information to the LLM; pass the generated funding message to Step 3. |
| Delivery succeeds in live mode | Send the generated direct message to the selected slug's recipient, then persist `sent` with no failure reason. |
| Delivery runs in dry-run mode | Print the generated message, persist `dryrun` with no failure reason, and make zero calls to the sending operation. |
| No `working` or `new` rows remain | Finish processing without reopening completed rows. |
| Restart before delivery has begun | Previously committed queue data survives; resume a `working` row before a `new` row. |
| A subsequent run encounters a `failed` row | Leave its status and failure reason unchanged; do not retry profile analysis, generation, or sending for it. |

### Proposed Operational Checks

These extend the confirmed workflow and should be agreed before treating them as final acceptance criteria.

| Scenario | Expected result |
| --- | --- |
| Repeat a search containing an existing slug | Do not duplicate the row or reset its status or failure reason. |
| Several eligible rows have the same status | Select them in insertion order. |
| YAML is invalid or the pitch cannot be read | Exit with a clear error before starting search or changing queue rows. |
| A recipient-specific operation fails | Record `failed` with an explanatory reason and continue with the next eligible row. |
| Authentication or a required service is unavailable | Stop with a clear error and preserve queue progress. Do not label a login failure as a missing profile. |
| Start a second CLI against the same active queue | Refuse concurrent processing without modifying its rows. |
| Switch from dry run to live with existing `dryrun` rows | Leave those rows unchanged and skip them; resetting or replaying them is outside the initial workflow. |

Use controlled LinkedIn and LLM substitutes for repeatable workflow checks, and a real temporary SQLite database for persistence and restart checks. Verify that the LLM receives the correct context separately from evaluating the wording of real generated messages.

Delivery interrupted after a send attempt requires its own acceptance scenarios once the recovery policy and persisted recovery information are selected. Investor classification also needs agreed positive, negative, and ambiguous profile examples.

## Decisions Needed Before Full Implementation

| Decision | What must be specified |
| --- | --- |
| LinkedIn live delivery | Browser access and manual login are selected; verify message eligibility and define the sending operation after the prototype. |
| LLM integration | Final provider and model selection using the recommendation above as a starting point, plus configured access. |
| Additional search configuration | Keyword search and bounded discovery are implemented for the prototype. Determine additional supported filters after real-account validation. |
| Investor verification | Prototype default: require a quoted supporting excerpt for positive classifications and fail ambiguous rows with `investor status uncertain`. Evaluate this policy and message quality with real samples. |
| Delivery recovery | Handling of an uncertain send and any extra persisted message or attempt metadata needed. Failed rows are never automatically retried. |
| Dry-run completion | Confirm whether `dryrun` rows remain completed when switching to live mode. |

Runtime, tooling, exact configuration keys, and module layout can be chosen during setup. The CLI and queue can be implemented independently while the external integration and classification decisions are resolved.
