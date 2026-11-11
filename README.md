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

**On-device (Gemini Nano, via Firebase AI Logic `PREFER_ON_DEVICE`)** sees the real
payload and screens every action. No network, no cost, no data leaving the machine.
This handles the overwhelming majority of actions.

**Cloud (Gemini, `ONLY_IN_CLOUD`)** is consulted only when the on-device model reports
low confidence in its own judgement — the genuinely ambiguous cases. And it never sees
the payload: the action is redacted first, and the UI shows you the exact text that
left your device, so the claim can be inspected rather than believed.

If redaction cannot produce a clean summary, the escalation is **skipped** and the
uncertain local answer stands. Privacy wins the tie.

This is the whole argument for hybrid, and it is not a box being ticked. A cloud-only
version of AgentGuard would be unusable for the data it exists to protect. An
on-device-only version would be wrong too often on the hard cases.

---

## The second design decision: AI advises, rules decide

The model classifies, scores risk, and writes the explanation you read on the approval
card. It **never** makes the allow/deny call. That lives in a pure function with no
network and no model.

This matters because an agent under prompt injection will try to argue its way past
the guard — and with AgentGuard it is arguing with an `if` statement. A model that can
be talked into permitting an action is not a control, it is another attack surface.

It also means the guard keeps working when the model does not. If inference fails or
the device model is unavailable, screening falls back to heuristics and **every rule
still runs**. A guard that fails open is not a guard.

---

## Run it

Needs Node 18+ and Chrome Desktop 139+.

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

Every entry stores the SHA-256 hash of the entry before it. Editing or deleting any
past record breaks every hash after it, and the header badge reports where the chain
broke.

The audit trail is the product. You do not have to trust the agent, and you do not have
to trust that nobody edited the log afterwards — you can check. Note that the raw
payload is never written to the ledger; the redacted summary is, precisely because it
is the thing that left the device.

Hashing uses Web Crypto, so appends are async and serialised through a tail promise —
two concurrent appends cannot read the same previous entry and fork the chain.

---

## Layout

```
src/
  core/guard.ts      the one chokepoint — the only path to execution
  core/policy.ts     deterministic evaluation. no network, no model
  core/ledger.ts     hash-chained append-only log + verification
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
ledger in an append-only store rather than `localStorage`, a real approval channel
rather than a page someone has to be watching, and a hardened adapter layer for actual
agent tool calls rather than the demo executor.

The architecture is the contribution: screen locally, escalate rarely and redacted,
let rules decide, and write everything down where it can be verified.

## License

MIT
