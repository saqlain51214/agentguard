# AgentGuard — demo video script

Target: **2:45**. The limit is 3:00 and judges are not required to watch past it,
so leave margin. Narration below is ~380 words, which lands around 2:45 at a
normal speaking pace.

Record at 1920×1080. Browser in full screen, no bookmarks bar, no other tabs.
Zoom the page to ~110% so text is readable on a phone.

**Before recording:** click *Enable on-device screening* and wait for the chip to
read `on-device: ready`. Then click *Clear ledger*. Start recording from a clean
state.

---

## 0:00 – 0:18 · The problem

**Screen:** A code editor showing just this, large:

```json
{ "mcpServers": { "tools": { "command": "npx", "args": ["-y", "@some/mcp", "--tools=all"] } } }
```

**Say:**

> This is all it takes to give an AI agent your tools. One line. From this
> moment it can email your customers, move your money, drop a table, or publish
> to your blog. There is no limit on it, and no record of what it tried.
>
> We have spent two years teaching agents to act. We have not built the thing
> that stops them.

---

## 0:18 – 0:32 · What it is

**Screen:** Cut to the AgentGuard dashboard, clean, nothing held.

**Say:**

> AgentGuard screens every action an agent proposes — on your device, before it
> happens — then enforces your policy and writes it down where it can't be
> quietly edited.
>
> Here is the policy. Plain English, on the right. Let's give it some work.

---

## 0:32 – 1:05 · The quiet cases

**Screen:** Click **Run all scenarios**. Let the first two land. Hover the two
`allow` badges in the console list.

**Say:**

> Four agents, nine actions. A support agent replying to a shipping question. An
> ops agent paying a forty-five dollar invoice.
>
> Both allowed. No prompt, no interruption, nothing for me to click.
>
> That matters more than it sounds. A guard that asks about everything gets
> clicked through by Thursday. Most of what an agent does is fine, and the tool
> has to be quiet on those to be worth running at all.

---

## 1:05 – 1:50 · The cases that need you

**Screen:** Scroll to the held cards. Pause on the bulk email card, then the
prod database card. Point at the risk score and the reasons list.

**Say:**

> Now the ones that stopped.
>
> An email going to three thousand one hundred and eighty-four users. An update
> touching forty-one thousand rows — on production.
>
> Each card tells me what the agent wants, the actual content, and which rule
> caught it. Nothing has happened yet. These are waiting on me.

**Screen:** Click **Approve & run** on the bulk email. Show it leave the queue
and the ledger update.

**Say:**

> I approve that one, and it runs — and the approval goes into the ledger under
> my name.

---

## 1:50 – 2:05 · The ones with no approval button

**Screen:** Scroll to the two refused actions in the console list — the API key
in a webhook, and the $7,400 payment. Show the `deny` badges.

**Say:**

> Two actions have no approve button at all. An agent pasting a live API key
> into a third-party webhook. A payment past the hard ceiling.
>
> There is no path to yes on those. Not for me, not for the agent.

---

## 2:05 – 2:35 · Why this needs hybrid inference

**Screen:** Open a held card and point at the `on device` pill. Then show the
dashed box: *"This, and only this, left your device."*

**Say:**

> Screening means reading the thing being screened — the email body, the SQL,
> the customer record. Sending all of that to a cloud model on every single
> action would be a worse privacy posture than having no guard at all.
>
> So Gemini Nano runs on device and sees the real payload. Nothing leaves the
> machine. The cloud is consulted only when the local model says it isn't sure —
> and then it gets this. Redacted first. You can read exactly what left.
>
> If redaction can't come out clean, the escalation is skipped. Privacy wins the
> tie.

---

## 2:35 – 2:45 · The close

**Screen:** The header chips — `on-device: ready`, `2 actions stopped`,
`ledger intact`.

**Say:**

> One more thing. The model classifies and scores. It never decides. Allow and
> deny live in a pure function with no model in it — so an agent under prompt
> injection ends up arguing with an if statement.
>
> Screen locally. Escalate rarely, and redacted. Let rules decide. Write it all
> down where it can be checked.

**End card (2 seconds):** `AgentGuard` · the repo URL.

---

## Checklist before uploading

- [ ] Under 3:00
- [ ] The `on device` pill is clearly visible at least once
- [ ] The redacted escalation box is on screen for at least 4 seconds — **this
      is the single most important shot in the video**
- [ ] No API keys, `.env` contents, or personal email visible anywhere on screen
- [ ] English subtitles burned in or uploaded as a track
- [ ] Uploaded to YouTube as **Public**, not Unlisted
- [ ] Watched once on a phone — if the text is unreadable there, re-record zoomed in

## If the cloud escalation won't fire naturally

It only triggers below 0.7 confidence. If no scenario reaches that honestly,
add one that is genuinely ambiguous rather than forcing it — a judge who
notices a staged escalation will discount the whole submission. If it still
won't fire, show the redaction module working on its own and say plainly that
escalation is rare by design. An honest demo of a rare path beats a fake one.

## Recording notes

- OBS Studio, or Chrome's own screen record. Record system audio off, mic only.
- Record narration separately from screen capture if you can — it is far easier
  to re-do one line than the whole take.
- Do not read this script word for word in one breath. Record it in the seven
  sections above and cut them together.
- Speak slower than feels natural. Everyone rushes on camera.
