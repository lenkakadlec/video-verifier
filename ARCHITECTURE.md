# Architecture

This document describes how the system is put together, the responsibilities of each component, and the decisions behind the technical choices.

## High-level flow

```
       User
        │  paste YouTube URL
        ▼
┌──────────────────────┐
│  Next.js app         │ ──── createJob ────▶  Neon Postgres (jobs row, status=pending)
│  (Vercel)            │
└─────────┬────────────┘
          │ trigger event "video/process"
          ▼
┌──────────────────────┐
│  Inngest             │  durable workflow, retries, step checkpoints
│  step.run("...")     │
└─────────┬────────────┘
          │
   ┌──────┴──────┐
   ▼             ▼
captions      no captions
fetched        │
in-process     ▼
               ┌──────────────────────┐
               │  Fly.io Python       │  yt-dlp -> audio file
               │  worker              │  POST to Groq Whisper
               └──────────┬───────────┘
                          │ transcript JSON
   ┌──────────────────────┘
   ▼
┌──────────────────────┐
│  Claude Haiku 4.5    │  chunk -> summarize in parallel
│  (Anthropic API)     │  per-minute summaries + overview + key points
└─────────┬────────────┘
          ▼
   Neon Postgres
   (transcripts, summaries, jobs.status=done)
          ▼
┌──────────────────────┐
│  Next.js app         │  Library UI, chat panel
│  (Vercel)            │  streams Claude responses over SSE
└──────────────────────┘
```

## Components

### Next.js app on Vercel

Runs the marketing pages, the authenticated UI, all the REST routes, and the Inngest webhook. App Router, server components where they make sense; only the interactive bits (library drag-and-drop, chat panel, job submission) ship as client components.

Anything that takes more than a couple of seconds, like a caption-less transcript fetch or summarization, doesn't run in the route handler. The route fires an Inngest event and returns the job ID right away, and the UI polls a status endpoint until the job is `done` or `failed`.

### Inngest workflows

The whole pipeline is one Inngest function with four `step.run()` calls:

1. `fetch-transcript`. Try YouTube captions first; if there aren't any, call the Python worker to download audio and run Whisper.
2. `chunk-transcript`. Split the segments into windows. Shorter videos get shorter windows so the summaries stay fine-grained.
3. `summarize`. One Claude call per chunk, run concurrently, for the per-minute summaries; one more call for the overview and key points.
4. `persist-results`. Write the summaries, update the job's cost columns, set status to `done`.

Each `step.run()` is a checkpoint. If the function crashes or gets redeployed halfway through, Inngest picks up from the last finished step instead of starting over. The function sets `retries: 2` and has an `onFailure` handler that marks the job `failed` with an error the UI can show.

See [`examples/process-video.ts`](examples/process-video.ts).

### Python worker on Fly.io

A small Flask app with one endpoint, `POST /transcribe`. Give it a YouTube ID, it runs `yt-dlp` to pull the audio at a low bitrate, sends that to Groq Whisper, and hands back the transcript JSON. It can cache the audio in Cloudflare R2 so a retry doesn't re-download.

It's on Fly because it needs a long-running process (audio downloads can run 30 to 90s on hour-long videos) and `yt-dlp` as a binary on disk. A shared secret in the `Authorization` header gates it.

### Database

Neon Postgres through Drizzle ORM. The main tables:

- `users`. Credentials auth (email + bcrypt) and preferred languages for translation.
- `videos`. One row per unique URL, shared across users. Holds duration, whether captions exist, and the thumbnail.
- `jobs`. One row per processing run a user kicks off. FK to `videos`, so two people can share the metadata but keep their own summaries. Holds status, overview, key points, cost columns, library membership, folder placement.
- `transcripts`, `summaries`, `topics`, `chat_messages`. Split out into their own tables because each has many rows per parent and gets queried on its own.
- `folders`. A per-user folder tree with a self-referential `parent_id`. The self-FK cascade-deletes; jobs in a deleted folder drop back to the library root via `ON DELETE SET NULL`.

There are two more per-video features sharing the same job row: claim verification (pull out factual claims, check each against web sources) and translation (render summaries in the user's language). Each has its own cost column (`chat_cost_usd`, `verify_cost_usd`, `translate_cost_usd`), and translations live in a `translations` JSONB keyed by language code. All of it shows up in the UI as running spend per video.

See [`examples/schema.ts`](examples/schema.ts) for the full schema.

### LLM integration

Every Claude call goes through `src/lib/llm.ts`. Two shapes:

- **Batch summarization** (background). Non-streaming, parallel `client.messages.create` calls, one per chunk, then a final call that merges them into the overview and key points. The token counts from each response convert to dollars through a small per-model price table and add up in `jobs.cost_actual_usd`.
- **Streaming chat** (foreground). `client.messages.stream`, piped through a `ReadableStream` and out over SSE. The system prompt carries the full video context (overview, key points, per-minute summaries) and goes out with `cache_control: { type: "ephemeral" }`. So the second turn onward reads that context from cache instead of paying for it again, which is where the ~90% saving comes from.

The chat route also takes an optional web-search tool (`web_search_20250305`, still beta). It runs a tool-use loop up to 6 times and returns the assembled text plus the total cost. The verification feature leans on the same web search.

See [`examples/chat-route.ts`](examples/chat-route.ts).

## Why it's built this way

**Inngest instead of a custom queue.** The pipeline already splits into clear stages (fetch, chunk, summarize, persist), and each fails differently. Inngest's step functions hand you resumability without having to run your own queue, worker, and state store.

**The Anthropic SDK directly, not the Vercel AI SDK.** The two places that needed Claude, background summarization and the chat panel, don't share a chat-UI shape, so the AI SDK's `useChat` and streaming helpers didn't buy much. Going direct also got me prompt caching, the web-search beta, and the beta message types, all of which the chat route uses.

**A separate Python worker for audio.** It'd be tempting to cram `yt-dlp` and Whisper into an Inngest step on Vercel, but `yt-dlp` is a binary that's awkward to ship serverless, the downloads can blow past serverless time and memory limits on long videos, and Whisper wants a file upload rather than a stream, so it needs disk. A little Fly app handles all of that and deploys on its own.

**Drizzle instead of Prisma.** The schema has self-referential FKs (the folder tree), composite indexes, and `pgEnum` types. Drizzle's SQL-shaped API expressed those cleanly, and the generated types are good enough that I never had to fight a separate ORM layer.

**Sparse integers for ordering.** Library items reorder by drag. `library_order` is just an integer, and on reorder the API recomputes the order across the affected scope. Simpler than fractional indexing, and the set being reordered is small (one user's library).

## Repository layout

```
src/
├── app/
│   ├── api/           # Route handlers (jobs, library, chat, inngest webhook)
│   ├── jobs/[id]/     # Per-job results page
│   ├── library/       # Library UI with folders + drag-drop
│   └── ...            # Auth pages, history, marketing
├── components/        # Client components (library-view, video-chat, etc.)
├── inngest/
│   └── functions/     # Durable workflows (process-video, dev-runner)
└── lib/
    ├── db/            # Drizzle schema + client
    ├── llm.ts         # Claude calls (summarize, verify, translate)
    ├── worker.ts      # Fly worker client
    ├── youtube.ts     # YouTube metadata + caption fetch
    └── ...
worker/                # Python Flask app (Dockerfile, server.py, fly.toml)
drizzle/               # Generated migrations
```