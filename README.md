# ⚠️ WARNING: Risk of LinkedIn Account Suspension

**This tool is a proof of concept (PoC). Using it may lead to your LinkedIn account being restricted or suspended.** Automated browsing and outreach may violate LinkedIn's terms. Dry-run mode still automates access to LinkedIn and carries this risk. Use at your own risk.

This is a fun experiment and proof of concept that leverages LLMs to post-filter search results by validating that the profile is of an investor and then generating a message asking for funding.

For now, only dry-run is implemented. Messages can be printed in the terminal (`dryrun-terminal`) or filled into LinkedIn message drafts for review (`dryrun-browser`). Neither mode sends messages.

# LinkedIn Search-Write-Send

LinkedIn Search-Write-Send automates personalized outreach for founders seeking angel investment. It brings investor discovery, pitch writing, and message delivery into a single workflow on LinkedIn.

Example [here](example/).

## Product Vision

Give founders a simple way to turn their investor criteria and business story into personalized funding conversations. The founder defines who to approach and supplies the pitch context; the product searches for angel investors, generates a message for each person, and sends those messages as direct messages on LinkedIn.

## How It Works

1. **Search:** Find angel investors on LinkedIn using criteria supplied in a YAML file.
2. **Write:** Generate a personalized message for each investor using the founder's business description and funding pitch, supplied in a Markdown file.
3. **Send:** Deliver each personalized pitch as a direct message to its intended recipient on LinkedIn, or prepare it for review during a dry run. Sending is a future milestone.

## Founder Inputs

- **Investor criteria:** A YAML file defining the criteria used to select investors.
- **Pitch context:** A Markdown file containing a free-form description of the business and its investment opportunity.

These files let founders express whom they want to reach and what they want to communicate.

## Execution Modes

- **`dryrun-terminal`:** Display generated messages in the terminal.
- **`dryrun-browser`:** Open a separate tab per recipient and fill the message body, plus a subject for InMail. Review drafts, then close the browser to finish. The tool never presses Send.
- **Send mode (planned):** Deliver personalized messages on LinkedIn. Live mode is currently rejected.

Select the mode in `config.yaml`; no CLI arguments are required. Both dry-run modes record queue status `dryrun`, and `npm run queue:reset-dryruns` returns those rows to `new` for testing. Browser mode preserves existing nonempty drafts and stops for review. Draft text is not stored locally, and LinkedIn may not retain drafts after the browser closes.

See [setup and commands](docs/development.md) for `npm run dev:search` and `npm run dev:message`.

## LLM Compatibility

- Compatible with the OpenAI API through a configurable endpoint and model.
- Tested with Ollama running `gemma4:e4b`, using the OpenAI-compatible Chat Completions API.

## Scope

The product focuses on founders seeking angel investment, with LinkedIn as its only platform. Other outreach use cases may be considered in the future and are outside the current scope.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Francisco de Gouveia.
