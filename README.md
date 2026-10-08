# LinkedIn Search-Write-Send

LinkedIn Search-Write-Send automates personalized outreach for founders seeking angel investment. It brings investor discovery, pitch writing, and message delivery into a single workflow on LinkedIn.

## Product Vision

Give founders a simple way to turn their investor criteria and business story into personalized funding conversations. The founder defines who to approach and supplies the pitch context; the product searches for angel investors, generates a message for each person, and sends those messages as direct messages on LinkedIn.

## How It Works

1. **Search:** Find angel investors on LinkedIn using criteria supplied in a YAML file.
2. **Write:** Generate a personalized message for each investor using the founder's business description and funding pitch, supplied in a Markdown file.
3. **Send:** Deliver each personalized pitch as a direct message to its intended recipient on LinkedIn, or display it in the terminal during a dry run.

## Founder Inputs

- **Investor criteria:** A YAML file defining the criteria used to select investors.
- **Pitch context:** A Markdown file containing a free-form description of the business and its investment opportunity.

These files let founders express whom they want to reach and what they want to communicate.

## Execution Modes

- **Send mode:** Run the search and writing workflow, then send the generated pitches as direct messages on LinkedIn.
- **Dry-run mode:** Run the search and writing workflow, then display the generated messages in the terminal without sending them to anyone.

## Scope

The product focuses on founders seeking angel investment, with LinkedIn as its only platform. Other outreach use cases may be considered in the future and are outside the current scope.
