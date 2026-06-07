import { relations } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    preferredLangs: jsonb("preferred_langs").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)]
);

export const jobStatus = pgEnum("job_status", [
  "pending",
  "awaiting_confirm",
  "queued",
  "fetching_transcript",
  "transcribing",
  "summarizing",
  "done",
  "failed",
  "cancelled",
]);

export const transcriptSource = pgEnum("transcript_source", [
  "captions",
  "whisper",
]);

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    youtubeId: text("youtube_id").notNull(),
    title: text("title"),
    channel: text("channel"),
    durationSec: integer("duration_sec").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    hasCaptions: boolean("has_captions").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("videos_youtube_id_idx").on(t.youtubeId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("pending"),
    overview: text("overview"),
    keyPoints: jsonb("key_points").$type<string[]>(),
    verificationResults: jsonb("verification_results").$type<{ claim: string; score: number; commentary: string }[]>(),
    trueTakeaways: jsonb("true_takeaways").$type<string[]>(),
    costEstimateUsd: real("cost_estimate_usd"),
    costActualUsd: real("cost_actual_usd"),
    chatCostUsd: real("chat_cost_usd").notNull().default(0),
    verifyCostUsd: real("verify_cost_usd").notNull().default(0),
    translateCostUsd: real("translate_cost_usd").notNull().default(0),
    translations: jsonb("translations").$type<Record<string, {
      overview: string;
      keyPoints: string[];
      trueTakeaways: string[];
      verificationCommentaries: string[];
      summaries: { id: string; minuteIndex: number; startSec: number; endSec: number; topic: string | null; summary: string }[];
    }>>(),
    error: text("error"),
    // Library: curated membership + optional folder + per-job notes.
    inLibrary: boolean("in_library").notNull().default(false),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    notes: text("notes"),
    libraryOrder: integer("library_order"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_user_idx").on(t.userId, t.createdAt),
    index("jobs_status_idx").on(t.status),
    index("jobs_library_idx").on(t.userId, t.folderId),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("folders_user_idx").on(t.userId),
    // Self-reference: deleting a folder deletes its subtree (affected jobs fall back
    // to the library root via jobs.folderId ON DELETE SET NULL).
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: "folders_parent_fk" }).onDelete("cascade"),
  ],
);

export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  videoId: uuid("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  source: transcriptSource("source").notNull(),
  text: text("text").notNull(),
  segments: jsonb("segments").$type<TranscriptSegment[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const summaries = pgTable(
  "summaries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    minuteIndex: integer("minute_index").notNull(),
    startSec: integer("start_sec").notNull(),
    endSec: integer("end_sec").notNull(),
    topic: text("topic"),
    summary: text("summary").notNull(),
  },
  (t) => [index("summaries_job_idx").on(t.jobId, t.minuteIndex)],
);

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    startSec: integer("start_sec").notNull(),
    endSec: integer("end_sec").notNull(),
    orderIndex: integer("order_index").notNull(),
  },
  (t) => [index("topics_video_idx").on(t.videoId, t.orderIndex)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("chat_messages_job_idx").on(t.jobId, t.createdAt)]
);

export const videosRelations = relations(videos, ({ many }) => ({
  jobs: many(jobs),
  transcripts: many(transcripts),
  topics: many(topics),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  video: one(videos, { fields: [jobs.videoId], references: [videos.id] }),
  folder: one(folders, { fields: [jobs.folderId], references: [folders.id] }),
  summaries: many(summaries),
  chatMessages: many(chatMessages),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  parent: one(folders, { fields: [folders.parentId], references: [folders.id], relationName: "folder_parent" }),
  children: many(folders, { relationName: "folder_parent" }),
  jobs: many(jobs),
}));

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type Video = typeof videos.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Summary = typeof summaries.$inferSelect;
export type Topic = typeof topics.$inferSelect;
