import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { calcTokenCost } from "@/lib/cost";
import { db } from "@/lib/db/client";
import { chatMessages, jobs, summaries, videos } from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] as const;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  model: z.enum(CHAT_MODELS).optional(),
  webSearch: z.boolean().optional(),
});

// --- handlers ----------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const job = await getOwnedJob(id, userId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.jobId, id))
    .orderBy(asc(chatMessages.createdAt));

  return NextResponse.json({ messages });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const job = await getOwnedJob(id, userId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const systemPrompt = await buildSystemPrompt(job);
  const history = await loadHistory(id);

  await db.insert(chatMessages).values({ jobId: id, role: "user", content: parsed.data.message });

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: parsed.data.message },
  ];

  const model = parsed.data.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const tools: Anthropic.ToolUnion[] | undefined = parsed.data.webSearch
    ? [{ type: "web_search_20250305", name: "web_search" }]
    : undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let fullText = "";
      try {
        const anthropicStream = client.messages.stream({
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages,
          ...(tools ? { tools } : {}),
        });

        for await (const event of anthropicStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            fullText += event.delta.text;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            );
          }
        }

        const finalMsg = await anthropicStream.finalMessage();
        if (!fullText.trim()) {
          fullText = "I couldn't find enough information to answer that.";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: fullText })}\n\n`));
        }

        const cost = calcTokenCost(
          finalMsg.usage.input_tokens,
          finalMsg.usage.output_tokens,
          model
        );
        await persistTurn(id, fullText, cost);

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (_err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- helpers -----------------------------------------------------------------

type ChatRole = "user" | "assistant";

async function getOwnedJob(id: string, userId: string) {
  const [job] = await db
    .select({
      id: jobs.id,
      videoId: jobs.videoId,
      status: jobs.status,
      overview: jobs.overview,
      keyPoints: jobs.keyPoints,
    })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);
  return job ?? null;
}

async function buildSystemPrompt(job: NonNullable<Awaited<ReturnType<typeof getOwnedJob>>>) {
  const [video] = await db
    .select({ title: videos.title, channel: videos.channel })
    .from(videos)
    .where(eq(videos.id, job.videoId))
    .limit(1);

  const summaryRows = await db
    .select({
      startSec: summaries.startSec,
      topic: summaries.topic,
      summary: summaries.summary,
    })
    .from(summaries)
    .where(eq(summaries.jobId, job.id))
    .orderBy(asc(summaries.minuteIndex));

  const videoContext = [
    `Title: ${video?.title ?? "Unknown"}`,
    video?.channel ? `Channel: ${video.channel}` : "",
    job.overview ? `Overview: ${job.overview}` : "",
    job.keyPoints?.length
      ? `Key points:\n${job.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : "",
    summaryRows.length
      ? `Per-minute summaries:\n${summaryRows
          .map((s) => `[${Math.floor(s.startSec / 60)}m]${s.topic ? ` ${s.topic}:` : ""} ${s.summary}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `You are a helpful assistant discussing a YouTube video with the user. Answer questions based on the video content below. Be concise and direct.\n\n${videoContext}`;
}

async function loadHistory(jobId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.jobId, jobId))
    .orderBy(asc(chatMessages.createdAt));
  return rows.map((m) => ({ role: m.role as ChatRole, content: m.content }));
}

async function persistTurn(jobId: string, assistantText: string, cost: number) {
  await Promise.all([
    db.insert(chatMessages).values({ jobId, role: "assistant", content: assistantText }),
    db
      .update(jobs)
      .set({ chatCostUsd: sql`coalesce(chat_cost_usd, 0) + ${cost}` })
      .where(eq(jobs.id, jobId)),
  ]);
}
