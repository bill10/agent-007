# Billion on the phone: research and plan

Status: research and plan only (2026-10-22). Nothing has been bought, no
account has been opened and no call has been placed. The owner approves the
spending in [Costs](#costs) before anything in [The proof of
concept](#the-proof-of-concept) runs.

The ask, 2026-10-22: "I've been really impressed by mega's voice. I talk to it
to onboard and then it captures all the information … I can also ask it to
call me and it gives my phone number a call and u just talk to the agent. I
want you billion to have that capability. And with a good voice."

## Recommendation in one paragraph

Use **ElevenLabs Agents with a Twilio number**, outbound to one number only
(`OWNER_PHONE`). We already pay for ElevenLabs Pro, its voices are the best
of the options, it has a native Twilio integration with an outbound-call API,
and it takes per-call context (the briefing, open questions) as variables, so
the first version is mostly configuration plus one small server module. All
in it is about **$0.10 a call minute plus $1.15 a month** for the number; a
3-minute test call costs about 30 cents. The call agent is a fast voice model
briefed with Billion's context, not Billion itself: Billion's turns take
seconds to minutes in a terminal, too slow for conversation. What the owner
says comes back to Billion as owner messages, and question answers resolve
the Qnn they answer. Recommended voice: **Eric** (samples below).

## How voice works today

The Billion tab's *Talk to Billion* (`server/talk.js`, `public/modules/talk.js`,
[BILLION.md](BILLION.md#talk-to-billion)) is a turn-by-turn loop through
Billion itself:

1. The page detects an utterance (Silero VAD), posts the WAV to
   `/api/talk/utterance`.
2. whisper.cpp transcribes it on this machine; `ownerSays(text, { voice: true,
   utterance })` types it into Billion's terminal as `[Owner via app, voice]
   ...`, keyed by the utterance id so a retry never sends twice.
3. Billion answers with `tell_owner` bound to that message (`replyTo`); the
   page fetches `/api/talk/audio/:id/:index` and the reply is spoken by macOS
   `say`, sentence by sentence; echo of its own voice is dropped
   (`looksLikeEcho`).

It is private (no audio leaves the machine) and Billion is the brain, but each
turn waits for a whole Billion turn, and it needs the tab open. Telegram does
the same with voice notes (`server/voice.js`). A phone call needs sub-second
turns, so it cannot route every turn through Billion's terminal; that is the
main design decision below.

## What MEGA uses

MEGA (gomega.ai) does not say publicly. Its customer app's public JavaScript
(`app.gomega.ai`, the bundles the login page loads, fetched 2026-10-22) holds
its database field names, among them `vapiAssistantId`, `vapiCallId`,
`vapiPhoneNumberId`, `vapiByoSipCredentialId`, `vapiCostBreakdown`,
`vapiTurnLatencyAverageMs`, `telnyxSipConnectionId` and
`telnyxOutboundVoiceProfileId`. So MEGA's calls very likely run on **Vapi**
(the orchestration layer), with **Telnyx** phone numbers brought in over SIP.
Vapi lets each assistant pick its voice provider (ElevenLabs, Cartesia, its
own, ...); the bundles do not say which one MEGA picked. MEGA was not
contacted.

So the experience the owner liked is a pipeline (speech-to-text → LLM →
text-to-speech) on a managed layer, the same shape as ElevenLabs Agents.

## Options

Prices are list prices from the vendors' pages and the pricing write-ups
cited in [Sources](#sources), October 2026; per-minute figures for the
token-billed models (OpenAI, Gemini) are estimates. Latency figures are the
vendors' claims; the proof of concept measures the real one.

| | ElevenLabs Agents + Twilio | OpenAI Realtime + Twilio SIP | Gemini Live + Twilio | Vapi (MEGA's) | Retell |
|---|---|---|---|---|---|
| How it works | Pipeline: their STT, any LLM, their TTS; turn-taking model | One speech-to-speech model | One speech-to-speech model, full duplex | Pipeline: pick each provider | Pipeline, managed |
| Voice quality | Best: thousands of voices, ours included; expressive | Very natural prosody; ~10 built-in voices | Good; ~30 built-in voices | As good as the TTS picked (ElevenLabs voices possible) | Good; ElevenLabs/own voices |
| Latency | ~1 s turn (Flash TTS ~75 ms) | ~0.5–1 s; hears audio directly | ~0.5–1 s | ~1 s; tunable | ~1 s |
| Interruptions | Good (barge-in, turn model) | Very good | Very good (full duplex) | Good, configurable | Good |
| Model cost / min | $0.08 platform + LLM ~$0.001–0.02 | ~$0.06–0.11 (gpt-realtime); ~$0.02–0.05 mini | ~$0.02–0.03 | $0.05 platform + STT + LLM + TTS ≈ $0.10–0.15 | ~$0.07–0.12 all in |
| Phone, per min (US outbound) | Twilio $0.014 | Twilio $0.014 + SIP ~$0.004 | Twilio $0.014 | Vapi/Twilio/Telnyx ~$0.01–0.02 | $0.015 |
| Number / month | Twilio $1.15 | Twilio $1.15 | Twilio $1.15 | ~$1–2 | $2 |
| Setup for us | **Low**: native Twilio import, outbound-call API, variables, tools, post-call webhook | Medium: SIP trunk to OpenAI, a webhook to accept each call, tool calls handled on our server | **High**: no telephony; we host the Twilio media-stream ↔ Gemini bridge (μ-law 8 kHz ↔ PCM), always on | Low; one more vendor account | Low; one more vendor account |
| New accounts | Twilio only (ElevenLabs already paid) | Twilio + OpenAI API | Twilio (Gemini credits exist) | Vapi + Twilio/Telnyx | Retell |

Why ElevenLabs over the others:

- **Voice is what the owner asked for**, and it is ElevenLabs' strength; the
  speech-to-speech models sound natural but offer a handful of fixed voices.
- **Least to build and run.** Twilio import and outbound calls are built in.
  Gemini Live would be the cheapest per minute, but it means owning a
  real-time audio bridge with a public WebSocket on the Mac mini; at our
  volume (minutes a day) the savings are a few dollars a month.
- **No new AI vendor.** Vapi would reproduce MEGA closely, but it is a fourth
  bill (Vapi, plus a voice and an LLM provider, plus phone) for about the same
  result as ElevenLabs alone.
- **Escape hatch.** If ElevenLabs' turn-taking disappoints in the proof of
  concept, OpenAI Realtime over SIP is the runner-up: best interruption
  handling, same Twilio number.

The LLM inside the call: ElevenLabs offers several (Gemini Flash, GPT-4.1/5
mini, Claude Haiku/Sonnet). Start with a fast one (Gemini 2.5 Flash or Claude
Haiku); the call is short, so the LLM is a cent or two a call either way.

## How it plugs into Billion

```
 owner: "call me" (tab / Telegram)      Billion: call_owner(reason)
            │                                     │
            └──────────►  server/phone.js  ◄──────┘
                            │ checks: number = OWNER_PHONE, rate limit, quiet hours
                            │ builds context: brief, open Qnn, STATE "Plan", status
                            ▼
             ElevenLabs outbound-call API ──► Twilio ──► owner's phone
                            │
         during the call: tools  tell_billion(text)  answer_question(n, answer)
         after the call:  transcript (webhook, or polled)
                            ▼
      ownerSays("[Owner via phone, call #id] ...")   answerWaiting(Qnn, ..., 'phone')
```

### Starting a call

- **The owner asks.** "call me" (also "call me now", "phone me") typed in the
  tab or sent on Telegram is handled by the server, the way "start the
  briefing now" is, and the call goes out within seconds without waiting for
  a Billion turn. Billion hears one line: `[Owner via app] asked for a call;
  call #c12 placed`.
- **Billion asks.** A new board tool `call_owner({ reason })` for a briefing or
  a blocker. Its result is "Call #c12 placed" or why not (outside the hours
  the owner set, a call in the last N minutes, a call already live). The
  charter says when it may call: the owner asked for briefings by phone, or a
  blocking question that has waited past a set time; never for normal or low
  ones. Off until the owner turns it on (`PHONE_CALLS=1`).
- **A missed call** falls back to the briefing's Telegram message; Billion does
  not redial in a loop (one retry at most, after 10 minutes).

### What the call agent knows

Passed per call as ElevenLabs dynamic variables
(`conversation_initiation_client_data`), built fresh by the server:

- `reason`: why this call (the owner asked; afternoon briefing; Q12 blocking).
- `brief`: the briefing's brief (`set_round_brief`) and its numbered items.
- `open_questions`: each open question as `Q12: text [choices; recommended]`.
- `plan`: the *Plan* and *Waiting on you* sections of `STATE.md`, trimmed to a
  few thousand characters.
- `status`: Billion's status line (`statusPayload`).

The agent's prompt: you are Billion's voice on a call with the owner; go
through the reason first, ask the open questions one at a time, offer the
recommended choice, keep it short, confirm each answer back ("So Q12 is yes,
spend the forty dollars. Got it."), and anything you cannot answer from the
context, say Billion will follow up in the chat. It must not invent status.

### What comes back to Billion

- **Live, per instruction.** A server tool `tell_billion(text)` the agent
  calls when the owner gives an instruction or new information ("tell the
  landing-page worker to use the blue hero"). The server turns it into
  `ownerSays('[Owner via phone, call #c12] ...')`, keyed by the tool call's id
  so a retry never sends twice, the same rule as Talk's utterance ids.
- **Live, per answer.** A server tool `answer_question(number, answer)` after
  the agent has read the answer back. The server resolves it through the same
  path as a tap in the tab (`answerWaiting`, via `phone`): the question shows
  "you answered: ... (call)" in the tab and on Telegram, and Billion reads
  `[Owner via phone] Q12: yes`.
- **After the call.** The full transcript (ElevenLabs post-call webhook, or the
  server fetching `GET /v1/convai/conversations/{id}` when the call ends)
  goes into the chat thread as one owner message with the transcript attached
  as a file, so Billion can catch anything the tools missed, and the call
  appears in the thread as "Call, 3 min" with the transcript.

Tools need ElevenLabs to reach the server over HTTPS: `PUBLIC_URL`, or a
Tailscale Funnel on just `/api/phone/*`, with a per-call secret in the tool
URL. Until that is set up, the after-call transcript alone works with no
inbound access at all (the server polls), and Billion resolves the answers
itself from it. The proof of concept uses only that.

### Inbound: the owner calls Billion

The same Twilio number, imported into ElevenLabs, answers with the same
agent. An inbound call gets its context through ElevenLabs' conversation
initiation webhook (our server returns the same variables), so it needs the
public endpoint. Caller ID is easy to spoof, so:

- a call from any number other than `OWNER_PHONE` hears one sentence ("This
  line is private.") and is hung up; no context is loaded;
- even from the owner's number, the agent asks for a spoken passphrase before
  it reads the briefing or takes an answer (set by the owner, stored in
  `~/.agent-007/.env`, never in the prompt the agent can repeat).

Ship outbound first; inbound is phase 3.

### Safety

- **One number.** `OWNER_PHONE` (the owner's verified number, E.164) in `~/.agent-007/.env`. The
  server compares the E.164 form before every call and the API takes no
  number from Billion or from the call: `call_owner` has no number argument.
  The agent gets no transfer, dial or SMS tool, and Twilio's geo permissions
  allow the US only. Twilio's own "verified caller IDs" keep a trial account
  to that one number as well.
- **No secrets read aloud.** Context is built from the brief, questions,
  status and two `STATE.md` sections, never env files, terminal output or
  tool output. A scrubber drops anything that looks like a key or token
  (`sk-`, `ghp_`, `xoxb-`, long base64/hex runs, `KEY=` lines) before it
  leaves the machine; `redact()` in `server/owner.js` covers only the
  Telegram token today, so this is new. The prompt forbids reading out keys,
  passwords or card numbers even if asked.
- **Bounded.** Max call length 10 minutes (agent setting), at most one live
  call, a few calls a day by Billion, quiet hours (Billion never calls 21:00 to
  08:00 owner time unless the owner asked).
- **What leaves the machine.** Unlike Talk to Billion, call audio and the
  transcript go to ElevenLabs and Twilio. ElevenLabs' retention can be set to
  zero days for audio; the transcript we keep is the copy in the chat.
- **Prompt injection.** The context includes text written by workers
  (question text, status). The call agent's only effects are messages and
  answers to the owner's own questions, the same as the owner typing, so a
  planted instruction can at worst put words in the transcript Billion
  already treats as from the owner. The tools accept only open question
  numbers and refuse everything else.

## The proof of concept

Goal: one outbound call to the owner's phone, 2–3 minutes, Eric's voice, the
current brief and open questions as context, and the transcript saved to the
chat. No server changes beyond a script.

What the owner does (about 15 minutes, and the spending decision):

1. Open a Twilio account, add $20 of credit (prepaid; it pays for the
   minutes) and buy one local number, $1.15/month.
2. Turn on usage-based billing for agent minutes in ElevenLabs, or confirm
   Pro's remaining credits cover the test (see [Costs](#costs)).
3. Put the Twilio Account SID and Auth Token in `~/.agent-007/.env`.

What a worker does:

1. Create the agent with the ElevenLabs API: voice Eric
   (`cjVigY5qzO86Huf0OWal`, `eleven_flash_v2_5`), the prompt above, max
   duration 5 minutes, overrides allowed for `first_message`, audio retention
   off.
2. Import the Twilio number into ElevenLabs (`POST /v1/convai/phone-numbers`).
3. `scripts/phone-poc.mjs`: build the variables from the live server
   (`/api/...` for the brief and questions, `STATE.md`), refuse any number but
   `OWNER_PHONE`, then
   `POST /v1/convai/twilio/outbound-call { agent_id, agent_phone_number_id,
   to_number, conversation_initiation_client_data: { dynamic_variables } }`.
4. Poll `GET /v1/convai/conversations/{conversation_id}` until it is done;
   save the transcript to `~/.agent-007/calls/<id>.json` and print it, with
   the measured turn latency and the call's cost from the response.
5. The owner listens for: does it sound like the samples, is it ever awkward
   to interrupt, how long are the pauses. Go or no-go on ElevenLabs vs. OpenAI
   Realtime (then a one-day spike on that).

Cost of the proof of concept: about $0.30 in minutes, the $1.15 number, and
the $20 Twilio credit that stays in the account.

## Building it after the proof of concept

1. `server/phone.js`: place a call (the checks above), build and scrub the
   context, fetch the transcript when it ends, put it in the chat.
   "call me" in the tab and on Telegram. Tests with a stubbed ElevenLabs.
2. The `call_owner` board tool and the charter's rule for when to call; the
   call in the briefing ("call me for briefings" setting: the briefing's
   Telegram message becomes a call, text as fallback).
3. Live tools (`tell_billion`, `answer_question`) behind `PUBLIC_URL` or a
   Funnel; then inbound with the passphrase.
4. Docs in BILLION.md and FEATURES.md; `agent007 doctor` checks the phone
   settings.

## Costs

| | Item | Cost |
|---|---|---|
| One-time | Twilio account | $0 |
| | Twilio prepaid credit (minimum top-up; spent on minutes) | $20 |
| | ElevenLabs agent setup | $0 |
| Monthly | Twilio local number | $1.15 |
| | ElevenLabs Pro | $99, **already paid** |
| Per minute | ElevenLabs Agents | $0.08 |
| | LLM inside the call | ~$0.001–0.02 |
| | Twilio, outbound to a US mobile | $0.014 |
| | (inbound to the local number, later) | $0.0085 |
| | **Total** | **≈ $0.10** |

Usage at, say, two 5-minute briefing calls a day: 300 minutes, about $30 a
month plus $1.15. One 3-minute call: about $0.30.

One catch: agent minutes come out of the same ElevenLabs credit pool as
text-to-speech, and our account was over 90% through this billing cycle's
credits when checked (2026-10-22). So either turn on usage-based
billing (overage is $0.08/minute, the same rate) or calls compete with the
other projects using this key. Pro allows 20 concurrent calls, far more than
we need.

Alternatives' totals for comparison, per minute: OpenAI Realtime ≈
$0.08–0.13, Gemini Live ≈ $0.04–0.05 (plus the bridge to build and run),
Vapi ≈ $0.11–0.17, Retell ≈ $0.09–0.14.

## Voice

Three candidates from ElevenLabs' built-in voices (stable, always available
to agents), each reading the same briefing opener with `eleven_flash_v2_5`,
the low-latency model a call uses. Each also comes as `-phone.wav`, the same
take squeezed to a phone line (8 kHz μ-law, 300–3400 Hz), closer to what the
owner hears on a call. The files are in the owner's Drive, folder
`billion-voice/` (links in the job card's summary, not here: this repo is
public).

| Voice | Description | Full quality | Phone line |
|---|---|---|---|
| **Eric** (recommended) | Smooth, trustworthy; American, middle-aged male | `billion-eric.mp3` | `billion-eric-phone.wav` |
| Chris | Charming, down-to-earth, casual; American male | `billion-chris.mp3` | `billion-chris-phone.wav` |
| Sarah | Mature, reassuring, confident; American female | `billion-sarah.mp3` | `billion-sarah-phone.wav` |

The line read: "Hey, it's Billion. Quick afternoon briefing, about two
minutes. The dark mode PR merged this morning and it's live. Two things need
you. First, question twelve: do you want me to spend about forty dollars a
month on a phone number and call minutes? Second, the landing page copy is
ready for your eyes. Which one do you want to start with?" (339 characters,
three takes ≈ 1,000 credits.)

Eric because he sounds calm and businesslike at phone bandwidth and is a
different voice from the owner's side in the demo video (Talk's demo uses a
woman's voice for the owner). Any of the account's other voices, or a
designed or cloned one, can be swapped in later by changing one id.

## Sources

- MEGA: public bundles of `https://app.gomega.ai/` (field names above), fetched 2026-10-22; [gomega.ai](https://www.gomega.ai/); [Trustpilot reviews of the onboarding call](https://www.trustpilot.com/review/gomega.ai).
- ElevenLabs: [Twilio outbound call API](https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call.md), [register Twilio calls](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call), [personalization / dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization); pricing write-ups: [Macha](https://www.getmacha.com/blog/elevenlabs-agents-pricing-explained), [Thunderphone](https://thunderphone.com/guides/elevenlabs-agents-pricing), [CloudZero](https://www.cloudzero.com/blog/elevenlabs-pricing/), [Quiq](https://quiq.com/blog/elevenlabs-pricing/).
- OpenAI Realtime: [Fora Soft pricing](https://www.forasoft.com/blog/article/openai-realtime-api-pricing), [Fora Soft SIP](https://www.forasoft.com/blog/article/openai-realtime-api-webrtc-sip-websockets-integration), [Layer3 Labs](https://www.layer3labs.io/guides/openai-realtime-api-pricing).
- Gemini Live: [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/), [TokenKarma](https://tokenkarma.app/blog/gemini-live-api-pricing-voice-agents-2026/), [Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api).
- Vapi and Retell: [Retell vs Vapi](https://www.retellai.com/comparisons/retell-vs-vapi), [Lindy on Vapi](https://www.lindy.ai/blog/vapi-ai), [Superdupr](https://superdupr.com/blog/vapi-vs-bland-vs-retell), [StackBinary](https://stackbinary.io/insights/voice-ai-pricing-per-minute-2026).
- Comparisons: [andrew.ooo](https://andrew.ooo/answers/gpt-realtime-2-vs-elevenlabs-vs-gemini-live-may-2026/), [apiscout](https://apiscout.dev/guides/realtime-voice-ai-apis-comparison-2026).
- Twilio: [voice and number pricing](https://www.twilio.com/en-us/phone-numbers/pricing).
