# ⚠️ WARNING: Risk of LinkedIn Account Suspension

**This tool is a proof of concept (PoC). Using it may lead to your LinkedIn account being restricted or suspended.** Automated browsing and outreach may violate LinkedIn's terms. Dry-run mode still automates access to LinkedIn and carries this risk. Use at your own risk.

This is a fun experiment and proof of concept that leverages LLMs to post-filter search results by validating that the profile is of an investor and then generating a message asking for funding.

Messages can be printed in the terminal (`dryrun-terminal`), filled into LinkedIn drafts for review (`dryrun-browser`), or sent automatically (`live`). Only live mode presses Send.

# LinkedIn Search-Write-Send

LinkedIn Search-Write-Send automates personalized outreach for founders seeking angel investment. It brings investor discovery, pitch writing, and message delivery into a single workflow on LinkedIn.

Example [here](example/).

## Product Vision

Give founders a simple way to turn their investor criteria and business story into personalized funding conversations. The founder defines who to approach and supplies the pitch context; the product searches for angel investors, generates a message for each person, and sends those messages as direct messages on LinkedIn.

## How It Works

1. **Search:** Find profiles using YAML criteria, validate investor status with the LLM, and save accepted profiles and validation failures.
2. **Write:** Reopen each accepted profile, generate a personalized subject and message using the Markdown pitch and founder context, and save them in SQLite.
3. **Send:** Deliver the saved messages to LinkedIn, prepare browser drafts, or display them in the terminal. This stage does not call the LLM.

## Founder Inputs

- **Investor criteria:** A YAML file defining the criteria used to select investors.
- **Pitch context:** A Markdown file containing a free-form description of the business and its investment opportunity.

These files let founders express whom they want to reach and what they want to communicate.

## Execution Modes

- **`dryrun-terminal`:** Display generated messages in the terminal.
- **`dryrun-browser`:** Open a separate tab per recipient and fill the message body, plus a subject for InMail. Review drafts, then close the browser to finish. The tool never presses Send.
- **`live`:** Verify the selected recipient and fill the saved message as in browser dry-run mode, then click Send and record confirmed messages as `sent`.

Select the mode in `config.yaml`; no CLI arguments are required. Both dry-run modes record message status `dryrun`. `npm run queue:reset-dryruns` requeues those saved messages without regenerating them. Browser modes validate the selected recipient, then fill the saved text, replacing existing draft contents. Preparation failures remain `new` for retry; submission failures remain `failed` for manual review. The browser stays open for inspection until you close it.

## Run the Stages

```bash
npm run dev:search
npm run dev:write
npm run dev:send
```

Run stages independently or use `npm run dev` for all three. Profiles and generated messages are persisted in separate SQLite tables, so delivery can run later without rewriting messages. See [setup, recovery, and commands](docs/development.md).

## LLM Compatibility

- Compatible with the OpenAI API through a configurable endpoint and model.
- Tested with Ollama running `gemma4:e4b`, using the OpenAI-compatible Chat Completions API.

## Scope

The product focuses on founders seeking angel investment, with LinkedIn as its only platform. Other outreach use cases may be considered in the future and are outside the current scope.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Francisco de Gouveia.
