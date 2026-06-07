import { eq } from "drizzle-orm";

import { estimateCost } from "@/lib/cost";
import { db } from "@/lib/db/client";
import { jobs, summaries, transcripts, videos } from "@/lib/db/schema";
import { inngest } from "@/lib/inngest";
import { chunkTranscript, summarizeTranscript, windowSecForDuration } from "@/lib/llm";
import { transcribeVideo } from "@/lib/worker";
import { fetchCaptions, segmentsToText } from "@/lib/youtube";


export const processVideo = inngest.createFunction(
  {
    id: "process-video",
    retries: 2,
    triggers: [{ event: "video/process" }],
    onFailure: async ({ event }) => {
      const jobId = (event.data as { jobId?: string })?.jobId;
      if (jobId) {
        await db
          .update(jobs)
          .set({ status: "failed", error: "Processing failed after all retries" })
          .where(eq(jobs.id, jobId));
      }
    },
  },
  async ({ event, step }) => {
    const { jobId, videoId, youtubeId, hasCaptions } = event.data;

    // Step 1: Fetch transcript (captions or Whisper)
    const transcript = await step.run("fetch-transcript", async () => {
      await db
        .update(jobs)
        .set({ status: hasCaptions ? "fetching_transcript" : "transcribing" })
        .where(eq(jobs.id, jobId));

      if (hasCaptions) {
        try {
          const segments = await fetchCaptions(youtubeId);
          const text = segmentsToText(segments);
          return { segments, text, source: "captions" as const };
        } catch {
          // Fall through to Whisper on caption error
        }
      }

      await db.update(jobs).set({ status: "transcribing" }).where(eq(jobs.id, jobId));
      const result = await transcribeVideo(youtubeId);
      return { segments: result.segments, text: result.text, source: "whisper" as const };
    });

    // Step 2: Persist transcript + chunk it
    const chunks = await step.run("chunk-transcript", async () => {
      await db.insert(transcripts).values({
        videoId,
        source: transcript.source,
        text: transcript.text,
        segments: transcript.segments,
      });

      const totalSec = transcript.segments.length ? transcript.segments[transcript.segments.length - 1].end : 0;
      return chunkTranscript(transcript.segments, windowSecForDuration(totalSec));
    });

    // Step 3: Summarize with Claude
    const summaryResult = await step.run("summarize", async () => {
      await db.update(jobs).set({ status: "summarizing" }).where(eq(jobs.id, jobId));

      const [video] = await db.select({ title: videos.title }).from(videos).where(eq(videos.id, videoId));
      const result = await summarizeTranscript(chunks, video?.title ?? "");

      return result;
    });

    // Step 4: Persist results + mark done (summaries and overview belong to this job)
    await step.run("persist-results", async () => {
      const durationSec = chunks.length > 0 ? chunks[chunks.length - 1].endSec : 0;
      const hasCaptionsActual = transcript.source === "captions";
      const cost = estimateCost(durationSec, hasCaptionsActual);

      if (summaryResult.perMinute.length > 0) {
        await db.insert(summaries).values(
          summaryResult.perMinute.map((s) => ({
            jobId,
            minuteIndex: s.minuteIndex,
            startSec: Math.round(s.startSec),
            endSec: Math.round(s.endSec),
            topic: s.topic,
            summary: s.summary,
          }))
        );
      }

      await db
        .update(jobs)
        .set({
          status: "done",
          overview: summaryResult.overview,
          keyPoints: summaryResult.keyPoints,
          costActualUsd: cost.totalCost,
          completedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    });

    return { jobId, status: "done" };
  }
);
