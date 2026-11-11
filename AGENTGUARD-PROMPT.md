# AgentGuard — project handoff

Paste everything below into Claude Code (or any coding agent) from inside the
`agentguard/` project directory.

---

## What this project is

AgentGuard is a browser app that screens every action an AI agent proposes,
decides what needs a human, and writes everything to a tamper-evident ledger.

It is my submission for the **Firebase #BuildHybridAI 2026** hackathon
(firebasehybridaihackathon.devpost.com). **Submission deadline: 30 November
2026, 2:00 PM PT.** Prizes are $30,000 total plus $3,000 for the best app on
each platform.

The hackathon requires: all AI inference goes through **Firebase AI Logic**
using hybrid on-device + cloud inference; a public repo with an open-source
license visible in the About section; a public YouTube demo video under three
minutes; and a working demo (not a mockup).

## Current state

The project builds and runs. `npm run dev` works, the on-device model loads,
and all nine demo scenarios execute end to end.

```
src/
  core/guard.ts      the single chokepoint — the only path to execution
  core/policy.ts     deterministic rule evaluation. no network, no model
  core/ledger.ts     hash-chained append-only log, Web Crypto, localStorage
  core/types.ts      domain types
  ai/screener.ts     hybrid screening: on-device first, redacted cloud escalation
  ai/redact.ts       runs before anything leaves the device
  agent/scenarios.ts nine demo actions from four agents
  main.ts            wiring and all UI rendering
index.html           dashboard markup and styles (plain CSS, no framework)
```

Stack: Vite + TypeScript + the `firebase` SDK. No UI framework. Verify with
`npm run check` (tsc) and `npm run build`.

## Environment (already set up, do not redo)

- Firebase project `agentguard-79534`, **Spark plan** — free, no billing. Never
  add anything that requires the Blaze plan or Vertex AI / Agent Platform.
- Firebase AI Logic is enabled with the **Gemini Developer API** backend.
- App Check is registered but **not enforced**, so `VITE_RECAPTCHA_SITE_KEY` is
  intentionally empty in `.env.local` and App Check is skipped. If inference
  starts returning 403s, that is the thing to revisit.
- Chrome flag `#prompt-api-for-gemini-nano-multimodal-input` is enabled and the
  on-device model is downloaded. `LanguageModel.availability()` returns
  `available`.
- Chrome's Prompt API requires `outputLanguage` to be specified or it logs a
  warning on every call.

## Design invariants — do not break these

These are the argument of the project, not implementation details. If a change
would violate one, stop and tell me instead of doing it.

1. **AI advises, rules decide.** The model classifies, scores risk and writes
   explanations. It never makes the allow/deny call — that lives in
   `core/policy.ts`, a pure function with no network and no model. An agent
   under prompt injection should end up arguing with an `if` statement.

2. **Nothing leaves the device unredacted.** On-device screening sees the real
   payload. The cloud is consulted only when the local model reports confidence
   below the escalation threshold, and only ever receives output from
   `ai/redact.ts`. If `looksClean()` fails on the redacted text, the escalation
   is skipped and the uncertain local answer stands. Privacy wins ties.

3. **The guard fails closed, never open.** If inference fails or times out,
   screening falls back to heuristics and **every rule still runs**.

4. **One chokepoint.** Every action goes through `Guard.propose()`. There is
   exactly one place an action can execute and one place that writes the
   ledger. Do not add a second path.

5. **The raw payload is never written to the ledger.** Only the redacted
   summary is, precisely because it is what left the device.

6. **The hard ceiling must stay above the approval threshold.** If they were
   equal, nothing would ever be held, and the approval path would be dead code.
   This was a real bug I already fixed once.

## Known issues to work on

**1. Screening sometimes falls back to heuristics even when the on-device model
is ready.** I added a retry, a 20s timeout, a serialising queue, and error
surfacing (`console.warn("[AgentGuard] screening fell back to heuristics: ...")`).
Run all nine scenarios, check the console, and find out whether any still fall
back and why. Fix the root cause rather than widening the fallback.

**2. Risk-score nondeterminism near the decision threshold.** The same action
scored 20, 40 and 25 across runs. The decision stayed the same because it came
from a deterministic rule — which is the design working. But
`riskApprovalThreshold` is 70, so an action oscillating between 68 and 72 would
flip run to run. Propose a fix: either stop using the model's risk score as a
decision input and keep it advisory only, or treat a band around the threshold
as always-hold. Tell me the tradeoff before implementing.

**3. Cloud escalation has probably never actually fired.** The escalation path
triggers only below 0.7 confidence. I have not seen a card showing
`cloud (redacted)`. Verify the path works end to end — temporarily force it if
needed — because it is the core of the hybrid story and must be visible in the
demo video. If it rarely fires naturally, consider adding a scenario genuinely
ambiguous enough to trigger it honestly. Do not fake it.

**4. UI polish.** Judging weights design and presentation. The dashboard is
functional but plain. Improve it without adding a framework or dependencies.

## How to run and verify

```bash
npm install
npm run dev      # then open in Chrome, click "Enable on-device screening"
npm run check    # tsc, must stay clean
npm run build    # must stay green
```

The demo flow: click **Enable on-device screening** (the Prompt API needs a user
gesture), then **Run all scenarios**. That resets state first so it is
repeatable.

There are no automated tests yet. The redaction module is the highest-risk code
in the project — if you add tests anywhere, add them there, covering emails,
card numbers, API keys, JWTs, private key blocks, phone numbers, IPs, URL paths
and amount bucketing.

## How I want you to work

- Make changes directly, run `npm run check` and `npm run build` after each one,
  and tell me what you changed and why.
- When you find a bug, tell me the root cause, not just that you fixed it.
- If something is a design tradeoff rather than a bug, ask me before choosing.
- Do not add dependencies without telling me first.
- Do not weaken any invariant above to make something easier.
- Be direct about what is not working. I would rather hear a problem now than
  find it the night before the deadline.

## Start here

Read the README and the files above, run the app, then work through known issue
1 (heuristics fallback) and issue 3 (cloud escalation never firing). Report what
you find before changing anything substantial.
