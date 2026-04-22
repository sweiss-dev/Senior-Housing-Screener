# Handoff: Deal Review Chatbot

## Overview

A floating chatbot that lives on the Bloomfield Agent Hub (senior-housing-screener.vercel.app). It lets a Bloomfield analyst — or a broker/borrower submitting through the hub — walk through a new senior housing financing opportunity and get back an instant, analyst-voiced fit read against Bloomfield's credit box ($4M–$30M senior housing operating assets; no ground-up).

The bot interviews the user through 11 structured questions, then calls Claude with Bloomfield's box and the collected deal, and renders the response in one of three selectable formats (score card / IC memo / chat summary).

## About the Design Files

The file in this bundle (`Deal Intake Chatbot.html`) is a **design reference prototype built in plain HTML/CSS/JS**, not production code to ship directly. The task is to **recreate this design inside the existing Next.js app** at `senior-housing-screener.vercel.app`, using its established patterns (React components, Next.js API routes, the inline CSS variables already defined in the app, the Satoshi font already loaded, etc.).

The prototype uses `window.claude.complete()`, which is only available inside the design sandbox — this needs to be replaced with a server-side API route that calls Anthropic's API with a real key (see "API Integration" below).

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, and shadows were pulled directly from the live Vercel app's inline stylesheet so the chatbot visually matches the existing hub exactly. Recreate pixel-perfectly using the app's existing tokens and components.

---

## Component Tree

One top-level component: `<DealReviewChat />` — mounted once in the hub layout so it floats globally.

Internally it owns:
- `ChatLauncher` — bubble in bottom-right + hover tooltip + unread dot
- `ChatPanel` — slide-in panel containing:
  - `ChatHeader` — avatar, title, status dot, reset/close buttons
  - `ChatProgress` — progress bar + phase label
  - `ChatBody` — scrollable message list
  - `ChatInput` — textarea + send button
  - `ChatFooter` — disclaimer line
- `Feedback` renderers — `ScoreCard`, `Memo`, `Summary` (pick one based on state)

---

## Design Tokens (exact values from the live app)

Declared as CSS vars on `:root` in the existing app — reuse them:

```
--bg:        #f3f6fa
--card:      #ffffff
--card-soft: #f8fafc
--ink:       #111827
--muted:     #627083
--line:      #dbe3ee
--blue:      #086aa6   /* primary */
--blue-dark: #07547f
--blue-soft: #eef4fa
--green:     #087f5b
--amber:     #b45309   /* also #d97706 for solid fills */
--red:       #b42318
--shadow:    0 18px 45px rgba(15, 23, 42, 0.08)
--shadow-lg: 0 30px 80px rgba(15, 23, 42, 0.18)
--radius:    18px
```

**Font:** Satoshi (already loaded from Fontshare in the hub) with `letter-spacing: -0.01em` at body, `-0.04em` on `h1`.

**Spacing:** 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 22 / 24 / 32 px steps.

**Radii:** `12px` (buttons/inputs), `14px` (inner cards), `16px` (message bubbles), `18px` (panels/cards), `999px` (pills), `50%` (bubble/dots).

---

## Screens / Views

### 1. Launcher Bubble

- **Position:** `fixed; bottom: 24px; right: 24px; z-index: 50`
- **Size:** 60×60 circle
- **Fill:** `var(--blue)` → hover `var(--blue-dark)`
- **Icon:** 26×26 white chat bubble (`lucide` `message-circle` equivalent — 2px stroke, round caps/joins)
- **Hover:** `transform: translateY(-2px)` + 180ms ease
- **Unread dot:** 12×12 red (`#ef4444`) circle with 2px white border, top-right (6px / 6px). Hide once chat is opened.
- **Hover tooltip:** dark (`#111827`) chip floats 72px to the left — *"Got a new deal in? Walk me through it."* — with a small triangle pointer on its right edge.

### 2. Chat Panel (open state)

- **Position:** `fixed; bottom: 96px; right: 24px; z-index: 49`
- **Size:** `420px × min(680px, 100vh - 120px)`
- **Border:** `1px solid var(--line)`, `border-radius: 20px`, `box-shadow: var(--shadow-lg)`
- **Open/close animation:** scale from `0.92` + translateY(8px) + opacity 0 → 1, 220ms `cubic-bezier(.2,.9,.25,1.05)`
- **Mobile (<500px):** full-screen (all 0s, `border-radius: 0`, `height: 100vh`)

#### 2a. Header

- Background: `linear-gradient(135deg, #0a7abc 0%, #07547f 100%)`; text white; padding `16px 18px`
- Avatar: 38×38, `border-radius: 12px`, `background: rgba(255,255,255,0.18)`, contents "BC" in bold
- Title: **"Deal Review Desk"** (15px, 700)
- Sub: 12px, 85% opacity, green dot (`#4ade80` w/ soft halo) + *"Senior housing analyst · reviewing now"*
- Right side: two 30×30 icon buttons (reset ↺, close ×), `background: rgba(255,255,255,0.12)` → hover `0.22`, 8px radius

#### 2b. Progress Bar

- Padding `10px 18px`, `background: #f8fafc`, bottom border `var(--line)`, text 11px `var(--muted)`
- Shape: `<strong>N</strong> of 11 details` · 4px-tall bar (flex-grow, `#e4e9f2` track, `var(--blue)` fill, 999px radius, 350ms ease width transition) · phase label on right
- Phase labels: "Deal review" (0), "Property basics" (<4), "Operator & trend" (<7), "Numbers & story" (<10), "Wrapping up" (10+), "Read ready" (done)

#### 2c. Message List

- `padding: 18px`, `background: #fafbfd`, vertical gap 12px, smooth-scroll to bottom on new messages
- Scrollbar: 8px, `#cbd5e1` thumb, 4px radius
- Fade-in animation on each message (opacity 0 + translateY(4px) → 1, 250ms)

**Bot message:**
- 28×28 round avatar on left (`var(--blue)` fill, white "BC", 11px bold)
- Bubble: white, 1px `var(--line)` border, `border-radius: 16px 16px 16px 4px`, 10px/13px padding, 14px text, 1.5 line-height, max-width 85%

**User message:**
- Right-aligned, no avatar
- Bubble: `var(--blue)` fill, white text, `border-radius: 16px 16px 4px 16px`, max-width 78%

**Typing indicator:** three 6px `var(--muted)` dots inside a bot bubble, bouncing sequentially (1.2s infinite, 0 / .15s / .3s delays; scale 0.5↔1, opacity 0.4↔1).

**Quick-reply chips:** appear under a bot message, 6px gap, left-indent 38px
- `padding: 7px 12px`, `border-radius: 999px`, 12px bold text
- Idle: `var(--blue-soft)` fill, `#d6e5f1` border, `var(--blue)` text
- Hover/selected: `var(--blue)` fill, white text
- Clicking a chip submits its label as the user's answer and removes the chip row.

#### 2d. Input Row

- `padding: 12px`, top border `var(--line)`, white bg, `gap: 8px`, items align-end
- Textarea: flex-1, 1px `#c9d4e3` border, 12px radius, 10px/12px padding, `min-height: 40px`, `max-height: 120px`, resize none, 14px text, auto-grows on input
  - Focus: border `var(--blue)`, box-shadow `0 0 0 3px rgba(8, 106, 166, 0.14)`
  - **Enter** submits; **Shift+Enter** newline
  - Placeholder: *"Walk me through the deal…"*
- Send button: 40×40 square, 12px radius, `var(--blue)` fill, white paper-plane icon (18×18, 2px stroke). Disabled at 0.4 opacity.

#### 2e. Footer

- `padding: 6px 12px 10px`, white bg, top border `var(--line)`, 10px `var(--muted)`, centered
- Text: *"Analyst read · preliminary · not a commitment to lend"*

---

## Conversation Flow

### Fields collected (order matters)

1. **property** — *"Start with the property — name and address?"*
2. **source** — *"Where did it come from — broker or direct from the borrower?"* · chips: Broker, Direct from borrower, Existing relationship, Returning sponsor
3. **type** — *"What's the care mix? IL, AL, MC, some combo?"* · chips: IL only, AL only, MC only, IL + AL, AL + MC, IL/AL/MC mix, Skilled nursing
4. **units** — *"How big is it — units and beds?"*
5. **vintage** — *"When was it built? Any recent capex or renovations worth noting?"*
6. **occupancy** — *"What's occupancy running, and is the trend up, flat, or down over the last 6-12 months?"*
7. **operator** — *"Who's the operator? Any prior history with them, and how many other communities do they run?"*
8. **noi** — *"What's the in-place NOI on the T-12? Any one-time items to strip out?"*
9. **ask** — *"What's the sponsor asking for — loan size and purchase price or as-is value?"*
10. **purpose** — *"And the story — acquisition, refi, bridge? What's the business plan?"* · chips: Acquisition, Refinance, Bridge, Cash-out refi, Value-add / turnaround, Construction
11. **timing** — *"When do they need to close, and are they talking to other lenders?"*

### Opening messages (on first open)

Message 1 (400ms delay): *"Hi — I can help you review deal opportunities for Bloomfield Capital. Tell me about the deal request."*

Message 2 (800ms delay): *"Quick reminder on the box: **$4M–$30M**, senior housing, operating assets only — no ground-up. We want a real operator, a coherent plan, and a basis that makes sense."*

Then ask field 1.

### State machine

```
idx: -1 → intro → ask(0) → user answers → ask(1) → ... → ask(10) → finalize()
state.done = true → any further input is a follow-up chat
```

### Finalize

1. Bot: *"Alright, let me put it together. One sec."*
2. Show typing indicator.
3. Call API with the 11 collected fields.
4. Replace typing with a **Feedback** card (format depends on user preference).
5. Follow up: *"Want to push back on the sponsor on anything, or talk through sizing before we circle up?"*

### Follow-up chat

After finalize, any typed message is sent as a free-form follow-up. The API call includes the original deal + prior feedback + the new message, and returns 2–4 plain sentences (not JSON).

---

## Feedback Formats (three variants — user-togglable)

Store selection in local state; default to `scorecard`. In the current hub, the prototype also exposes a Tweaks panel to switch formats at runtime — omit that from production unless useful.

All three render a `verdict` (`green` | `amber` | `red`) and use color tokens:
- green → `var(--green)` (`#087f5b`)
- amber → `#d97706` solid / `#b45309` text
- red → `var(--red)` (`#b42318`)

### Format A — Score Card (default)

```
┌─────────────────────────────────┐
│  ⬤  Verdict label               │  ← 46×46 colored dot (4px halo), 18px bold letter (✓ ! ×)
│     One-sentence headline       │     13px bold label; 11px muted sub
├─────────────────────────────────┤
│  WHAT WORKS                     │  ← 11px 700 uppercase muted header w/ 0.08em letter-spacing
│  • pro 1                        │     13px / 1.5 bullets with colored ● (6px)
│  • pro 2                        │     green bullets
├─────────────────────────────────┤
│  WHAT I'D WANT TO DIG INTO      │
│  • concern 1                    │     amber bullets (#d97706)
├─────────────────────────────────┤
│  HARD FLAGS  (only if any)      │
│  • flag                         │     red bullets
├─────────────────────────────────┤
│  [next step chip] [chip] ...    │  ← `var(--blue-soft)` chips that submit the chip text as follow-up
└─────────────────────────────────┘
```

Container: white, 1px `var(--line)`, 14px radius, sections separated by `border-top: 1px solid var(--line)`.

### Format B — IC Memo

- Tinted bg (`#fcfcf9`) wrapper; two white inner sections (head & foot)
- **Head** (14px pad): verdict stamp (colored tint bg, uppercase 10px tracking-wide, `border-radius: 4px`), property name (15px 700), then subtitle of `type · units · ask` in 12px muted
- **Body**: 13px / 1.65, paragraphs split on double newline, `var(--ink)` text
- **Foot**: 10px 14px pad, 11px muted, flex justify-between: *"Bloomfield · Deal Review"* ⟷ today's date (`MMM d`)
- Next-step chips below

### Format C — Chat Summary (inline)

- No card chrome — just another bot-style bubble (white, bot border-radius)
- Top row: verdict pill (colored tint bg, 13px 700) with a tiny dot + verdict label
- Then the headline sentence (14px / 1.55)
- Below: up to 2 pros (`✓`, green), 2 cons (`!`, amber), 2 flags (`⚠`, red) — single-line, 13px muted
- Next-step chips as a separate `.quick-replies` row below the bubble (static, not clickable in this variant)

---

## API Integration

The prototype calls `window.claude.complete(promptString)` which returns a string. In production, replace with a Next.js API route at e.g. `app/api/deal-review/route.ts`:

```ts
// app/api/deal-review/route.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("");
  return Response.json({ text });
}
```

Env var: add `ANTHROPIC_API_KEY` in Vercel project settings.

Client helper:
```ts
async function askClaude(prompt: string): Promise<string> {
  const r = await fetch("/api/deal-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const { text } = await r.json();
  return text;
}
```

### Scoring prompt (use verbatim)

Build with the 11 field values interpolated; request strict JSON with shape:

```
{
  "verdict": "green" | "amber" | "red",
  "verdict_label": "3-6 words",
  "headline": "one sentence, 18-24 words, no names",
  "pros": [string],
  "cons": [string],
  "flags": [string],
  "memo": "2-3 paragraphs, no names, third-person sponsor/operator references",
  "next_steps": [string]
}
```

See the exact prompt text inside `generateFeedback()` in the HTML file — copy it verbatim including the credit box rules:
- $4M–$30M, all US, senior housing (IL/AL/MC/SNF)
- **No ground-up construction**
- Prioritize: experienced operator, clear plan, reasonable basis
- Score `red` if outside box / ground-up / clearly un-lendable
- Score `amber` for workable-but-needs-more-info
- Score `green` only for clean fit
- **Never use names**, analyst voice, third-person sponsor

### Follow-up prompt

Smaller prompt that includes `JSON.stringify(dealPayload)` + `JSON.stringify(priorFeedback)` + the new user message, asking for 2–4 plain sentences in analyst voice. See `handleFollowUp()` in the HTML.

### Response parsing

The model sometimes wraps JSON in prose — extract with `raw.match(/\{[\s\S]*\}/)` before `JSON.parse`. On any parse or network failure, show the `fallbackFeedback()` content (see HTML) so the UX degrades gracefully.

---

## State Management

Minimal — a single `useReducer` (or Zustand/Context if you prefer) is plenty:

```ts
type State = {
  open: boolean;
  idx: number;              // -1 before start, 0..10 while asking, 11 when done
  payload: Record<string, string>;
  messages: Message[];      // {role: 'bot'|'user', kind: 'text'|'feedback', ...}
  format: "scorecard" | "memo" | "summary";
  pending: boolean;         // model call in flight
  lastFeedback?: Feedback;
};
```

Persist `format` to `localStorage` if you want it sticky across reloads. Do **not** persist the conversation — each open is a fresh review.

---

## Interactions & Behavior

- **Open:** bubble click or hub tile button → panel scales in
- **Close:** `×` button or click bubble while open → panel scales out
- **Reset:** `↺` button → `confirm()` dialog, then wipe state and replay intro
- **Send:** Enter (not Shift+Enter) or send button; textarea auto-grows 40→120px
- **Chips:** click submits chip text as the answer; all chips in that row are removed
- **Scroll:** chat body auto-scrolls to bottom on every new message
- **Progress bar:** animates 350ms width transition on each step
- **Message fade-in:** 250ms opacity+translateY on every appended node
- **Typing indicator:** 1.2s infinite bounce on three dots
- **Mobile:** <500px viewport → panel goes full-screen

---

## Integration with Existing Hub

Add a new agent card to the hub grid so the chatbot has a tile entry point alongside its floating bubble:

```
Icon: 💬   (or a real senior-housing icon if available)
Title: Deal Review Desk
Body:  Walk a new broker / borrower submission through an analyst-style
       review. Flags issues and drafts a fit read.
Button: Open review desk  (opens the chat panel)
Pill:  Analyst review
```

Include a "NEW" badge in the top-right corner of the card (10px 700 uppercase, `var(--blue)` fill, white text, `3px 7px 6px radius`) if you want to draw attention on launch.

---

## Files in This Bundle

- `Deal Intake Chatbot.html` — full working prototype. All CSS, markup, and logic inline. Open directly in a browser to see the final behavior. Reference this as the source of truth for anything ambiguous in this doc — especially prompt text, animation timings, and the exact copy for each question.

---

## Deployment Checklist

1. Port the component into the Next app under `components/DealReviewChat.tsx` (+ optional subcomponents)
2. Add the API route `app/api/deal-review/route.ts`
3. Add `ANTHROPIC_API_KEY` to Vercel env (Production + Preview)
4. Mount `<DealReviewChat />` once in the hub layout (e.g. `app/layout.tsx` or the hub page)
5. Add the new agent card to the hub grid
6. Smoke test: bubble opens, 11-question flow completes, API returns parseable JSON, all three formats render, follow-up chat works, fallback triggers on a forced API error
7. `git push` → Vercel auto-deploys
