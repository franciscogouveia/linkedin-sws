# Working example

Using the example [pitch.md](pitch.md) and the [config.yaml](config.yaml), I get the following output (redacted sample):

```
$ npm run dev

> linkedin-search-write-send@0.1.0 dev
> node src/app/cli/all.ts

(node:130051) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Starting dry-run prototype. Generated messages will be printed to the terminal.
Search collected 30 profile(s); appended 0 new queue row(s).
Queue: 24 new, 1 working, 3 dryrun, 0 sent, 2 failed. Processing limit: 10. Completed and failed rows are skipped.
Analyzing Aaaaa Bbbbbbbb (xxxxxxxxxx).
Profile data: header 109, About 0, Experience 0 characters; search role: Tech PR | Angel Investor; truncated: false.
Investor assessment: investor. Reason: The profile clearly identifies the individual as an 'Angel Investor'. Evidence: Tech PR | Angel Investor

To: Aaaaa Bbbbbbbb
Profile: https://www.linkedin.com/in/xxxxxxxxxx/

Dear Aaaaa Bbbbbbbb,

My name is Francisco de Gouveia, Co-Founder and CTO of Useless Waste. Given your experience as a Tech PR and Angel Investor, I wanted to introduce our unique concept.

Useless Waste is a C2B Software venture that tackles a problem we’ve identified: what if failure itself could be sold? Our business sells certainty, generating value from the guarantee of a zero return. It’s a paradoxical "promising future unicorn" that needs significant capital to burn.

We are currently raising billions of euros in a pre-seed round. I believe our approach to monetizing certainty aligns with forward-thinking investment strategies.

I would appreciate the opportunity to schedule a brief conversation to discuss our vision further.

Best regards,

Francisco de Gouveia
https://de-gouveia.eu

Analyzing Cccccccc Ddddd (yyyyyyyyyyyyy).
Profile data: header 179, About 0, Experience 0 characters; search role: Founder, Builder, Angel Investor @MoselVentures; truncated: false.
Investor assessment: investor. Reason: The profile explicitly and repeatedly labels the individual as an 'Angel Investor'. Evidence: Founder, Builder, Angel Investor

To: Cccccccc Ddddd
Profile: https://www.linkedin.com/in/yyyyyyyyyyyyy/

Dear Cccccccc,

My name is Francisco de Gouveia, and I am the Co-Founder and CTO of Useless Waste, a C2B Software company. We take a unique approach to the market by selling guaranteed certainty. Ultimately, we understand that certainty is the key commodity, and that’s what defines our business model.

We are currently in a pre-seed round raising billions of euros to build this certainty. Given your deep experience as an Angel Investor and Builder, I thought our unconventional opportunity might resonate with your investment theses.

I would welcome the chance to discuss how Useless Waste aims to capture this market. Are you available for a brief conversation anytime next week?

Best regards,

Francisco de Gouveia
Co-Founder and CTO, Useless Waste
https://de-gouveia.eu

...
```


In the output, there are 3 main parts.

## Search

```
Search collected 30 profile(s); appended 0 new queue row(s).
Queue: 24 new, 1 working, 3 dryrun, 0 sent, 2 failed. Processing limit: 10. Completed and failed rows are skipped.
```

Here, LinkedIn page is open, the search triggered with the configured parameters from [config.yaml](./config.yaml) and the results parsed into a queue.

## Writing

```
Analyzing Aaaaa Bbbbbbbb (xxxxxxxxxx).
Profile data: header 109, About 0, Experience 0 characters; search role: Tech PR | Angel Investor; truncated: false.
Investor assessment: investor. Reason: The profile clearly identifies the individual as an 'Angel Investor'. Evidence: Tech PR | Angel Investor

To: Aaaaa Bbbbbbbb
Profile: https://www.linkedin.com/in/xxxxxxxxxx/

[Generated Message]
```

Here, the profile page is retrieved, given to the LLM to validate: is it really an investor profile? Well, the prompt is larger than that, but you get the drill.

If the page is validated, the LLM is given the pitch from [pitch.md](./pitch.md), founder and business details from [config.yaml](./config.yaml) and the profile data from the LinkedIn page. A pitch message is then generated based on all the information.

## Communication

Well, you saw the output, because only dry-run is implemented. Otherwise, a message would be placed and sent to the profile. *To be implemented.*

## Note

Useless Waste is a fictitious business for this example. The business doesn't actually exist, just in case you were considering any investment.