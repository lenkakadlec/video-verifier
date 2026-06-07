# Video Verifier

Paste a YouTube URL, get per-minute summaries, key points, and a chat panel you can ask questions in. Built end to end by one developer: data model, background workers, the Claude integration, cost accounting, auth, and UI. · [live demo](#)

---

![Video Verifier library and chat panel](assets/library-chat.png)

---

## What it does

You paste a video URL. Then:

1. **Resolve** the video. Grab metadata and thumbnail.
2. **Transcribe.** Use YouTube captions if they exist, otherwise download the audio and run it through Groq Whisper-large-v3-turbo.
3. **Chunk** the transcript into windows. Window size scales with how long the video is.
4. **Summarize** each chunk with Claude Haiku 4.5, in parallel where possible. Output is per-minute summaries plus an overview and a key-points list.
5. **Store and show** the results in a library: folders, drag-and-drop reordering, notes, and a chat panel.

The chat panel streams responses and can optionally hit web search. Each video's summaries get cached on the API side with prompt caching, so follow-up turns cost about 90% less than the first.

---

## Cost per video

Cost is tracked per job in the database and shown in the UI before you process a long video.

**Processing** (transcription + summarization):

| Length | With captions | Without captions |
| ------ | ------------- | ---------------- |
| 10 min | ~$0.006       | ~$0.013          |
| 60 min | ~$0.032       | ~$0.072          |
| 3 hr   | n/a           | ~$0.215          |

Processing is cheap. The expensive part is claim verification. A 16-minute captioned video costs about $0.13 end to end: roughly $0.01 to process and $0.12 to verify claims against web sources. That number climbs with video length and how many claims are packed in.

Worth saying plainly: at these margins a generic "verify any video" product is hard to make work. The economics only really hold up in a niche where people pay more, like medical content, financial advice, or news, where you can tune the verification to that domain. Figuring that out was half the point of building it.

---

## What this shows

- **Production Claude integration.** Streaming, tool use (web search), prompt caching on long stable contexts, model fallback, and token accounting that feeds per-job cost tracking.
- **Durable background jobs.** Inngest step functions with retries, partial-progress checkpoints, and DB-driven status. A long transcription job survives a cold start or a redeploy mid-run.
- **Multi-runtime setup.** A Next.js app on serverless, a Python audio worker on a long-running VM, and a managed job queue tying them together. Each piece runs where it actually fits.
- **Real data modeling.** Drizzle schema with FK cascades, soft delete via `inLibrary`, a self-referential folder tree, a separate `chat_messages` table, and drag-reorder via sparse integer keys.
- **Cost tracking.** Estimated and actual cost per job, stored and shown to the user before they kick off a long video.
- **One person, the whole thing.** Schema, API routes, workers, auth, UI, deploy config.

---

## Stack

| Layer            | Technology                                           |
| ---------------- | ---------------------------------------------------- |
| Framework        | Next.js 16 (App Router), React 19                    |
| Styling          | Tailwind CSS v4                                       |
| Hosting          | Vercel                                                |
| Database         | Neon Postgres + Drizzle ORM                           |
| Auth             | NextAuth v5 (credentials)                             |
| Background jobs  | Inngest (durable workflows, retries, step functions) |
| LLM              | Anthropic Claude Haiku 4.5 + Sonnet 4.5              |
| Transcription    | Groq Whisper-large-v3-turbo                           |
| Audio download   | Python worker on Fly.io (yt-dlp)                     |
| Rate limiting    | Upstash Redis                                         |
| Object storage   | Cloudflare R2 (cached audio)                          |

---

## Architecture

[`ARCHITECTURE.md`](ARCHITECTURE.md) has the data flow, the component breakdown, and why each technical choice was made.

---

## Code examples

A few representative excerpts:

| File | What it shows |
| ---- | ------------- |
| [`examples/process-video.ts`](examples/process-video.ts) | The Inngest workflow: transcript fetch, chunking, summarization, and persistence as four resumable steps |
| [`examples/chat-route.ts`](examples/chat-route.ts)       | A Next.js route streaming Claude over SSE, with opt-in web search and prompt caching for cheaper multi-turn chat |
| [`examples/schema.ts`](examples/schema.ts)               | The Drizzle schema: users, videos, jobs, transcripts, summaries, chat messages, and the folder system |

---

## Project status

Active development.

---

_Built by [Lenka Kadlec](https://github.com/lenkakadlec), Applied AI Product Engineer, ex-Microsoft. I build AI features that actually do things in production: tool calling, agents, voice. Available for contract work or full-time roles._