import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { and, asc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { calcTokenCost } from "@/lib/cost";
import { db } from "@/lib/db/client";
import { chatMessages, jobs, summaries, videos } from "@/lib/db/schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] as const;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await db
    .select({ id: chatMessages.id, role: chatMessages.role, content: chatMessages.content, createdAt: chatMessages.createdAt })
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

  const body = await req.json().catch(() => null);
  const parsed = z.object({
    message: z.string().min(1).max(2000),
    model: z.enum(CHAT_MODELS).optional(),
    webSearch: z.boolean().optional(),
  }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const [job] = await db
    .select({ id: jobs.id, videoId: jobs.videoId, status: jobs.status, overview: jobs.overview, keyPoints: jobs.keyPoints })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Build video context
  const [video] = await db
    .select({ title: videos.title, channel: videos.channel })
    .from(videos)
    .where(eq(videos.id, job.videoId))
    .limit(1);

  const summaryRows = await db
    .select({ minuteIndex: summaries.minuteIndex, startSec: summaries.startSec, topic: summaries.topic, summary: summaries.summary })
    .from(summaries)
    .where(eq(summaries.jobId, id))
    .orderBy(asc(summaries.minuteIndex));

  const videoContext = [
    `Title: ${video?.title ?? "Unknown"}`,
    video?.channel ? `Channel: ${video.channel}` : "",
    job.overview ? `Overview: ${job.overview}` : "",
    job.keyPoints?.length
      ? `Key points:\n${job.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : "",
    summaryRows.length
      ? `Per-minute summaries:\n${summaryRows.map((s) => `[${Math.floor(s.startSec / 60)}m]${s.topic ? ` ${s.topic}:` : ""} ${s.summary}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");

  const systemPrompt = `You are a helpful assistant discussing a YouTube video with the user. Answer questions based on the video content below. Be concise and direct.

${videoContext}`;

  // Fetch existing history
  const history = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.jobId, id))
    .orderBy(asc(chatMessages.createdAt));

  // Save user message
  await db.insert(chatMessages).values({ jobId: id, role: "user", content: parsed.data.message });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: parsed.data.message },
  ];

  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const model = parsed.data.model ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
        const useWebSearch = !!parsed.data.webSearch;

        if (useWebSearch) {
          const betaMessages: BetaMessageParam[] = [
            ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            { role: "user", content: parsed.data.message },
          ];
          let totalCost = 0;

          for (let i = 0; i < 6; i++) {
            const response: Anthropic.Beta.Messages.BetaMessage = await client.beta.messages.create({
              model,
              max_tokens: 1024,
              system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
              tools: [{ type: "web_search_20250305", name: "web_search" }],
              messages: betaMessages,
            });

            if (response.usage) {
              totalCost += calcTokenCost(response.usage.input_tokens, response.usage.output_tokens, model);
            }

            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text) fullText += text;

            const toolUses = response.content.filter((b) => b.type === "tool_use");
            if (toolUses.length === 0 || response.stop_reason === "end_turn") {
              break;
            }

            betaMessages.push({ role: "assistant", content: response.content });
            betaMessages.push({
              role: "user",
              content: toolUses.map((b) => ({
                type: "tool_result" as const,
                tool_use_id: (b as Anthropic.ToolUseBlock).id,
                content: "",
              })),
            });
          }

          if (!fullText.trim()) {
            fullText = "I couldn't find enough information to answer that.";
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: fullText })}\n\n`));

          await Promise.all([
            db.insert(chatMessages).values({ jobId: id, role: "assistant", content: fullText }),
            db.update(jobs).set({ chatCostUsd: sql`coalesce(chat_cost_usd, 0) + ${totalCost}` }).where(eq(jobs.id, id)),
          ]);
        } else {
          const anthropicStream = client.messages.stream({
            model,
            max_tokens: 1024,
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            messages,
          });

          for await (const event of anthropicStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              fullText += event.delta.text;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`));
            }
          }

          const finalMsg = await anthropicStream.finalMessage();
          const cost = calcTokenCost(finalMsg.usage.input_tokens, finalMsg.usage.output_tokens, model);

          await Promise.all([
            db.insert(chatMessages).values({ jobId: id, role: "assistant", content: fullText }),
            db.update(jobs).set({ chatCostUsd: sql`coalesce(chat_cost_usd, 0) + ${cost}` }).where(eq(jobs.id, id)),
          ]);
        }
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
