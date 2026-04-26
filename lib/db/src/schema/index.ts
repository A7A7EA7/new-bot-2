import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const linksTable = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  clicks: integer("clicks").notNull().default(0),
  abTest: text("ab_test"),
  imageFileId: text("image_file_id"),
});

export const statsTable = sqliteTable("stats", {
  id: integer("id").primaryKey().default(1),
  totalStarts: integer("total_starts").notNull().default(0),
  totalLinkOpens: integer("total_link_opens").notNull().default(0),
  totalWarnings: integer("total_warnings").notNull().default(0),
  totalBans: integer("total_bans").notNull().default(0),
  totalKicks: integer("total_kicks").notNull().default(0),
  totalMutes: integer("total_mutes").notNull().default(0),
});

export const knownUsersTable = sqliteTable("known_users", {
  telegramId: integer("telegram_id", { mode: "number" }).primaryKey(),
});

export const warningsTable = sqliteTable(
  "warnings",
  {
    chatId: integer("chat_id", { mode: "number" }).notNull(),
    userId: integer("user_id", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] })],
);

export const scheduledBroadcastsTable = sqliteTable("scheduled_broadcasts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  postId: integer("post_id"),
  scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  status: text("status").notNull().default("pending"),
  delivered: integer("delivered").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
});

export const settingsTable = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const postsTable = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  text: text("text"),
  photoFileId: text("photo_file_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
  sendCount: integer("send_count").notNull().default(0),
});

export const recurringBroadcastsTable = sqliteTable("recurring_broadcasts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  postId: integer("post_id"),
  kind: text("kind").notNull(),
  hour: integer("hour").notNull(),
  minute: integer("minute").notNull(),
  dayOfWeek: integer("day_of_week"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  nextFireAt: integer("next_fire_at", { mode: "timestamp_ms" }).notNull(),
  lastFiredAt: integer("last_fired_at", { mode: "timestamp_ms" }),
  totalSent: integer("total_sent").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type LinkRow = typeof linksTable.$inferSelect;
export type StatsRow = typeof statsTable.$inferSelect;
export type ScheduledBroadcastRow = typeof scheduledBroadcastsTable.$inferSelect;
export type SettingRow = typeof settingsTable.$inferSelect;
