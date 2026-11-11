# AgentGuard

**We are handing AI agents the ability to send, spend, publish and delete. We have not built the thing that stops them.**

Connecting an agent to a set of tools takes one line of config, and from that moment
it can email your customers, move money, drop a table or post to your blog. The usual
answer is "put a human in the loop" — but a human cannot read every action, and an
approval prompt that fires on everything gets clicked through within a day.

AgentGuard screens every action an agent proposes, **on your device**, decides what
actually needs you, and writes all of it to a ledger that cannot be quietly edited.

---

## Why this needs hybrid inference

Screening has to be free, instant and private, or nobody runs it on every action. But
screening means reading the thing being screened — the email body, the SQL, the shell
command, the customer record. Sending all of that to a cloud model to ask "is this
risky?" would mean routing your most sensitive data through a third party on every
single agent action. That is a worse privacy posture than having no guard at all.

So the work is split:

**On-device (Gemini Nano, via Firebase AI Logic `ONLY_ON_DEVICE`)** sees the real
payload and screens every action. No network, no cost, no data leaving the machine.

The mode is `ONLY_ON_DEVICE` on purpose, not `PREFER_ON_DEVICE`. The "prefer" mode
falls back to the cloud silently when no local model exists, and that first pass
carries the real, unredacted payload. Here, with no device model, screening drops
to heuristics and every rule still runs. The cloud is reachable only through the
redacted escalation path below.

**Cloud (Gemini, `ONLY_IN_CLOUD`)** is a second opinion, asked for in three cases:

1. the on-device model reports low confidence in its own judgement (below 0.7);
2. its label contradicts what the action type already tells us. `rm -rf` is a
   `delete_file`; if the local model calls that "public facing", it got something wrong
   that we can see, so we ask again;
3. a developer forces it with `?forceEscalate=1`, which the UI labels while it is on.

Escalation is deliberately rare. In one run of the nine demo scenarios on Gemini Nano,
the model's confidence was never below 0.7, so case 1 did not fire at all, and its
labels were wrong on the two destructive actions, which is what case 2 catches. Labels
and scores vary from run to run. I report that rather than tune a threshold until the
demo escalates more.

What the cloud receives is a **redacted** version of the action, not nothing. Redaction
is pattern-based (`src/ai/redact.ts`). It removes emails, phone numbers, card numbers,
IBANs, IPs, API keys and tokens, credentials written as `password: ...`, URL paths,
labelled names and addresses, internal hostnames and long opaque strings, and it turns
exact amounts into buckets. It does **not** understand free text: an unlabelled name or
a sentence describing a secret would get through. The UI shows you the exact text that
left your device, so the claim can be inspected rather than believed.

Two cases never reach the cloud. If the action contains credential material, it stays
on the device (the policy engine refuses it on its own anyway). And if the redacted
text fails an independent re-check, the escalation is **skipped** and the local answer
stands. Privacy wins the tie.

This is the whole argument for hybrid, and it is not a box being ticked. A cloud-only
version of AgentGuard would be unusable for the data it exists to protect. An
on-device-only version would be wrong too often on the hard cases.

---

## The second design decision: AI advises, rules decide

The model classifies, scores risk, and writes the explanation you read on the approval
card. It **never** makes the allow/deny call. That lives in a pure function with no
network and no model, and the risk score is not one of its inputs: the same action was
scored 20, 40 and 25 on different runs, so a threshold on it would flip verdicts at
random. The score is shown to the human as advice.

This matters because an agent under prompt injection will try to argue its way past
the guard. Where a rule covers the action, it is arguing with an `if` statement. A model
that can be talked into permitting an action is not a control, it is another attack
surface. Where no rule applies the default is to allow, which is why shell commands and
outbound requests have a rule of their own that always sends them to a human. The rule
set is small and a real deployment would need a much more complete one.

It also means the guard keeps working when the model does not. If inference fails or
the device model is unavailable, screening falls back to heuristics and **every rule
still runs**. Malformed numbers (a missing amount, a NaN record count) are refused
outright rather than waved through.

---

## Run it

Needs Node 18+ and Chrome Desktop 139+.

On-device speed depends on your hardware. On a machine Chrome classes as "Very Low"
performance, one screening call takes about 30 seconds, so running all nine scenarios
takes several minutes. I have not yet measured a machine with a capable GPU.

**1. Enable the on-device model in Chrome**

Go to `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, set it to
**Enabled**, and relaunch. The model downloads on first use (a few GB).

**2. Set up Firebase** (free, no billing required)

In the [Firebase console](https://console.firebase.google.com): create a project, add a
Web app, then open **AI Logic → Get started → Gemini Developer API**. Copy the web app
config.

```bash
cp .env.example .env.local   # paste your Firebase keys in
npm install
npm run dev
```

**3. Open the app**, click **Enable on-device screening** (the Prompt API requires a
user gesture), then **Run all scenarios**.

Without Firebase config the app still runs — on heuristics, with every rule enforcing —
so you can see the policy and ledger behaviour before setting anything up.

### What you'll see

Nine actions from four different agents. Most are things an agent genuinely should be
allowed to do, and the guard stays quiet on those — that is the point.

| Action | Outcome |
|---|---|
| Reply to a customer's shipping question | **Allowed.** Routine. No interruption. |
| Pay a $45 design tool invoice | **Allowed.** Under the approval line. |
| Refund a disputed $480 annual plan | **Held.** Over the payment approval threshold. |
| Email 3,184 users about an outage | **Held.** Far over the bulk threshold. |
| `rm -rf` old log files | **Held.** Destructive actions always need a human. |
| `UPDATE` 41,002 rows on prod | **Held.** Production target *and* bulk scope. |
| Publish a pricing announcement | **Held.** Nothing goes public unread. |
| POST a live API key to a partner webhook | **Refused.** Credential material — no approval path exists. |
| Pay $7,400 to an unfamiliar vendor | **Refused.** Over the hard ceiling. Cannot be overridden. |

On any held action, the card shows which screening path was used — **on device** or
**cloud (redacted)** — and if it escalated, exactly what text was sent.

---

## The ledger

Every entry stores the SHA-256 hash of the entry before it. Editing or deleting a
record in the middle breaks every hash after it, and the header badge reports where the
chain broke. The latest entry's hash is also stored separately, so cutting entries off
the end is caught too.

The audit trail is the product, and it is worth saying exactly how far it goes. This
detects casual and partial tampering. It does **not** stop someone with access to the
browser's storage from rewriting the whole chain and recomputing every hash, because the
hashes are unkeyed and everything lives in one place. Anchoring the latest hash somewhere
the operator cannot write (a server, a signed timestamp) is the real fix, and is not
built.

The raw payload is never written to the ledger. Targets and summaries are redacted
before they are recorded, because an address or a path is often an identifier itself.
The "Clear ledger" button resets the demo and wipes the log; it is not part of how a
real ledger would behave. Pending approvals live in memory only, so reloading the page
leaves an `approval_requested` entry with no resolution.

Hashing uses Web Crypto, so appends are async and serialised through a tail promise —
two concurrent appends cannot read the same previous entry and fork the chain.

---

## Layout

```
src/
  core/guard.ts      the one chokepoint — the only path to execution
  core/policy.ts     deterministic evaluation. no network, no model
  core/ledger.ts     hash-chained log + verification (see the caveats above)
  core/types.ts      domain types
  ai/screener.ts     hybrid screening: on-device first, redacted cloud escalation
  ai/redact.ts       what runs before anything leaves the device
  agent/scenarios.ts the demo agents
  main.ts            wiring and UI
index.html           dashboard markup and styles
```

Everything flows through `Guard.propose()`. There is exactly one place an action can be
executed and exactly one place that writes the ledger, which is what makes the audit
trail complete by construction rather than by discipline.

## What this is not

A prototype built for the Firebase #BuildHybridAI hackathon. Before this guarded
anything real it would need: policy storage and per-agent scoping, authentication, the
ledger in an append-only store anchored outside the browser rather than `localStorage`,
a real approval channel rather than a page someone has to be watching, a much more
complete rule set, and a hardened adapter layer for actual agent tool calls rather than
the demo executor.

The architecture is the contribution: screen locally, escalate rarely and redacted,
let rules decide, and write everything down where it can be checked. The pieces that
are solid are the single chokepoint and the deterministic policy. The pieces that are
honest approximations are the redaction (patterns, not understanding) and the ledger
(tamper-evident, not tamper-proof).

## Checks

```bash
npm run check         # tsc
npm run build
npm run test:redact   # redaction tests, no extra dependencies
```


## License

MIT
