import { Telegraf, Context, Markup, Input } from "telegraf";
import { message } from "telegraf/filters";
import path from "path";
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { logger } from "./lib/logger";
import { db, linksTable, statsTable, knownUsersTable, warningsTable, scheduledBroadcastsTable, settingsTable, recurringBroadcastsTable, postsTable, sqliteConnection, resolveDbPath } from "@workspace/db";
import { eq, sql, and, lte, asc } from "drizzle-orm";

const WELCOME_IMAGE = path.join(process.cwd(), "assets", "welcome.png");
const CUSTOM_WELCOME_IMAGE = path.join(path.dirname(resolveDbPath()), "welcome-custom.jpg");

function getWelcomeImagePath(): string {
  return existsSync(CUSTOM_WELCOME_IMAGE) ? CUSTOM_WELCOME_IMAGE : WELCOME_IMAGE;
}

function clearCustomWelcomeImage(): boolean {
  if (!existsSync(CUSTOM_WELCOME_IMAGE)) return false;
  try {
    unlinkSync(CUSTOM_WELCOME_IMAGE);
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to delete custom welcome image");
    return false;
  }
}

const token = process.env["TELEGRAM_BOT_TOKEN"];

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required.");
}

const DEFAULT_OWNER_ID = 7900265965;
const ownerIdEnv = process.env["BOT_OWNER_ID"]?.trim();
const parsedOwnerId = ownerIdEnv ? Number(ownerIdEnv) : NaN;
const OWNER_ID =
  ownerIdEnv && Number.isInteger(parsedOwnerId) && parsedOwnerId > 0
    ? parsedOwnerId
    : DEFAULT_OWNER_ID;
if (ownerIdEnv && OWNER_ID === DEFAULT_OWNER_ID) {
  logger.warn(
    { value: ownerIdEnv },
    "BOT_OWNER_ID is set but is not a valid positive integer; falling back to default owner",
  );
}

const OWNER_EMAIL = process.env["OWNER_EMAIL"]?.trim() || "s7s704s7@outlook.com";

const bot = new Telegraf(token);

// Commands and inline-button callbacks that ANY Telegram user can trigger.
// Everything else (admin menu, moderation, link editing, broadcasts, …) is
// silently ignored for non-owners by the middleware below.
const PUBLIC_COMMANDS = new Set(["start", "help", "myid", "links"]);
const PUBLIC_ACTIONS = new Set(["restart", "contact"]);

function isPublicUpdate(ctx: Context): boolean {
  const msg = ctx.message as { text?: string } | undefined;
  if (msg?.text && msg.text.startsWith("/")) {
    const cmd = msg.text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase();
    if (cmd && PUBLIC_COMMANDS.has(cmd)) return true;
  }
  const cb = ctx.callbackQuery as { data?: string } | undefined;
  if (cb?.data && PUBLIC_ACTIONS.has(cb.data)) return true;
  return false;
}

interface LinkVariant {
  url: string;
  clicks: number;
}

interface AbTestState {
  rotation: number;
  variants: LinkVariant[];
}

interface LinkEntry {
  title: string;
  url: string;
  clicks?: number;
  abTest?: AbTestState | null;
  imageFileId?: string | null;
}

function parseAbTest(raw: string | null | undefined): AbTestState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray(parsed.variants) &&
      typeof parsed.rotation === "number"
    ) {
      const variants: LinkVariant[] = [];
      for (const v of parsed.variants) {
        if (typeof v?.url === "string") {
          variants.push({ url: v.url, clicks: Number(v.clicks) || 0 });
        }
      }
      return { rotation: parsed.rotation, variants };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function serializeAbTest(state: AbTestState | null | undefined): string | null {
  if (!state || state.variants.length === 0) return null;
  return JSON.stringify({
    rotation: state.rotation,
    variants: state.variants.map((v) => ({ url: v.url, clicks: v.clicks })),
  });
}

const DEFAULT_LINKS: LinkEntry[] = [
  { title: "Joymoney", url: "https://trk.ppdu.ru/click/4M4QBoTB?erid=Kra23k98b" },
  { title: "Webbankir", url: "https://trk.ppdu.ru/click/pyZwQoUH?erid=2SDnjeoAsez" },
  { title: "Быстроденьги", url: "https://trk.ppdu.ru/click/NnmtldWL?erid=2SDnjcrSm9t" },
  { title: "ЛайкЗайм", url: "https://trk.ppdu.ru/click/FsCpBfV5?erid=2SDnjc4SoGv" },
  { title: "Credit7", url: "https://trk.ppdu.ru/click/YW95Dyv0?erid=Kra23w9ze" },
  { title: "Moneyman", url: "https://trk.ppdu.ru/click/EikMKM1w?erid=2SDnjdTrs6M" },
  { title: "МигКредит", url: "https://trk.ppdu.ru/click/ricTCWV1?erid=2SDnjdHgEMQ" },
  { title: "Привет, сосед!", url: "https://trk.ppdu.ru/click/qz6imsqJ?erid=2SDnjeb3GV2" },
  { title: "ДеньгиСразу", url: "https://trk.ppdu.ru/click/r5J4eyjJ?erid=2SDnjeeMK5A" },
  { title: "Турбозайм", url: "https://trk.ppdu.ru/click/CsFAWwg9?erid=2SDnjcvWbxM" },
  { title: "Срочноденьги", url: "https://trk.ppdu.ru/click/qrGZHU0x?erid=2SDnjeVT5Gb" },
  { title: "Belkacredit", url: "https://trk.ppdu.ru/click/rpqpL2EZ?erid=2SDnjeD276A" },
  { title: "До Зарплаты", url: "https://trk.ppdu.ru/click/2Yyc5ZuK?erid=2SDnjevZFtJ" },
  { title: "Мега Деньги", url: "https://trk.ppdu.ru/click/b1cWPsBE?erid=2SDnjbxrnwX" },
  { title: "One Click Money", url: "https://trk.ppdu.ru/click/XcaeZEyu?erid=2SDnjbstvYw" },
];

const linkList: LinkEntry[] = [];

const warnings = new Map<number, Map<number, number>>();

interface BotStats {
  totalStarts: number;
  totalLinkOpens: number;
  totalWarnings: number;
  totalBans: number;
  totalKicks: number;
  totalMutes: number;
}

const stats: BotStats = {
  totalStarts: 0,
  totalLinkOpens: 0,
  totalWarnings: 0,
  totalBans: 0,
  totalKicks: 0,
  totalMutes: 0,
};

const knownUsers = new Set<number>();

function isOwner(ctx: Context): boolean {
  return ctx.from?.id === OWNER_ID;
}

// Lockdown: the owner can do everything. Non-owners can only trigger the
// public commands and inline buttons (Start screen, Help, MyID, Links list,
// the Restart and Contact buttons). Admin menu, moderation, link editing,
// and broadcasts are silently ignored for non-owners.
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (ctx.from.id === OWNER_ID) return next();
  if (isPublicUpdate(ctx)) return next();
  logger.debug(
    { fromId: ctx.from.id, updateType: ctx.updateType },
    "Ignored non-public update from non-owner",
  );
});

// Maintenance mode: when enabled, non-owners get a polite "we'll be back" reply
// and no further handlers run for their update.
bot.use(async (ctx, next) => {
  if (ctx.from?.id === OWNER_ID) return next();
  if (!settings.maintenanceMode) return next();
  if (ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery("🛠 Бот на обслуживании. Попробуйте позже.", { show_alert: true });
    } catch { /* ignore */ }
    return;
  }
  if (ctx.message) {
    try {
      await ctx.reply(
        "🛠 *Бот временно на обслуживании*\n\n" +
          "Мы обновляем предложения, чтобы стало ещё лучше.\n" +
          "Пожалуйста, загляните чуть позже.",
        { parse_mode: "Markdown" },
      );
    } catch { /* ignore */ }
  }
});

const DEFAULT_WELCOME_CAPTION =
  "✨ *Добро пожаловать!*\n" +
  "━━━━━━━━━━━━━━━━━━\n\n" +
  "💰 Лучшие предложения по займам — в одном месте.\n" +
  "🛡 Только проверенные сервисы, без скрытых условий.\n" +
  "⚡️ Одобрение за несколько минут, деньги — на карту.\n\n" +
  "👇 *Выберите предложение из списка ниже:*";

const DEFAULT_BOT_DESCRIPTION =
  "💰 Лучшие предложения по займам.\n" +
  "⚡️ Одобрение за несколько минут.\n" +
  "🏠 Онлайн, без посещения банка.\n" +
  "💳 Деньги — сразу на карту.\n\n" +
  "👉 Нажмите Start, чтобы увидеть актуальный список.";

const DEFAULT_AUTO_PROMOTE_THRESHOLD = 30;

const settings: {
  welcomeCaption: string;
  botDescription: string;
  autoBackupHour: number | null;
  lastAutoBackupDate: string | null;
  autoPromoteEnabled: boolean;
  autoPromoteThreshold: number;
  liveCounterEnabled: boolean;
  faqEnabled: boolean;
  faqText: string;
  maintenanceMode: boolean;
  preStartImageFileId: string | null;
} = {
  welcomeCaption: DEFAULT_WELCOME_CAPTION,
  botDescription: DEFAULT_BOT_DESCRIPTION,
  autoBackupHour: null,
  lastAutoBackupDate: null,
  autoPromoteEnabled: false,
  autoPromoteThreshold: DEFAULT_AUTO_PROMOTE_THRESHOLD,
  liveCounterEnabled: false,
  faqEnabled: false,
  faqText: "",
  maintenanceMode: false,
  preStartImageFileId: null,
};

const DEFAULT_FAQ_TEXT =
  "❓ *Частые вопросы*\n" +
  "━━━━━━━━━━━━━━━━━━\n\n" +
  "💰 *Какую сумму можно взять?*\n" +
  "От 1 000 до 100 000 ₽ — зависит от сервиса.\n\n" +
  "⏱ *Сколько ждать одобрения?*\n" +
  "В среднем — несколько минут. Деньги поступают на карту сразу после одобрения.\n\n" +
  "📄 *Какие нужны документы?*\n" +
  "Только паспорт РФ. Заявка оформляется онлайн.\n\n" +
  "🏦 *Нужно ли посещать банк?*\n" +
  "Нет. Всё происходит онлайн — из дома или с телефона.\n\n" +
  "👤 *Кому одобряют?*\n" +
  "Гражданам РФ от 18 лет с действующим паспортом.\n\n" +
  "🔐 *Безопасно ли это?*\n" +
  "Да. Все сервисы работают по лицензии и защищают ваши данные.";

settings.faqText = DEFAULT_FAQ_TEXT;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dailyBaseline(date: string): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  return 80 + (h % 101);
}

const dailyStarts: { date: string; count: number } = { date: todayKey(), count: 0 };

async function persistDailyStarts(): Promise<void> {
  await persistSetting("dailyStarts", JSON.stringify(dailyStarts));
}

function rolloverDailyIfNeeded(): void {
  const today = todayKey();
  if (dailyStarts.date !== today) {
    dailyStarts.date = today;
    dailyStarts.count = 0;
  }
}

function bumpDailyStarts(): void {
  rolloverDailyIfNeeded();
  dailyStarts.count += 1;
  void persistDailyStarts();
}

function getLiveCounterLine(): string {
  rolloverDailyIfNeeded();
  const total = dailyBaseline(dailyStarts.date) + dailyStarts.count;
  return `🔥 *Сегодня уже ${total} человек оформили заявку*`;
}

async function loadSetting(key: string): Promise<string | null> {
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
    return rows[0]?.value ?? null;
  } catch (err) {
    logger.error({ err, key }, "Failed to load setting");
    return null;
  }
}

async function persistSetting(key: string, value: string): Promise<void> {
  try {
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  } catch (err) {
    logger.error({ err, key }, "Failed to persist setting");
  }
}

function getWarnings(chatId: number, userId: number): number {
  if (!warnings.has(chatId)) warnings.set(chatId, new Map());
  return warnings.get(chatId)!.get(userId) ?? 0;
}

function addWarning(chatId: number, userId: number): number {
  if (!warnings.has(chatId)) warnings.set(chatId, new Map());
  const count = (warnings.get(chatId)!.get(userId) ?? 0) + 1;
  warnings.get(chatId)!.set(userId, count);
  void persistWarning(chatId, userId, count);
  return count;
}

function resetWarnings(chatId: number, userId: number): void {
  warnings.get(chatId)?.delete(userId);
  void deleteWarningRow(chatId, userId);
}

async function maybeAutoPromote(index: number): Promise<void> {
  const entry = linkList[index];
  if (!entry?.abTest || entry.abTest.variants.length === 0) return;
  const totalVariantClicks = entry.abTest.variants.reduce((s, v) => s + v.clicks, 0);
  const primaryClicks = Math.max(0, (entry.clicks ?? 0) - totalVariantClicks);
  const pool = [
    { url: entry.url, clicks: primaryClicks, label: "A (primary)" },
    ...entry.abTest.variants.map((v, i) => ({
      url: v.url,
      clicks: v.clicks,
      label: String.fromCharCode(66 + i),
    })),
  ];
  const sorted = [...pool].sort((a, b) => b.clicks - a.clicks);
  const leader = sorted[0];
  const runnerUp = sorted[1];
  const lead = leader.clicks - runnerUp.clicks;
  if (leader.clicks < settings.autoPromoteThreshold) return;
  if (lead < settings.autoPromoteThreshold) return;
  if (leader.url === entry.url) {
    entry.abTest = null;
  } else {
    entry.url = leader.url;
    entry.abTest = null;
  }
  await rewriteAllLinks();
  try {
    await bot.telegram.sendMessage(
      OWNER_ID,
      `🏆 *Авто-продвижение*\n\n` +
        `Ссылка #${index + 1} *${entry.title}*\n` +
        `Победитель: *${leader.label}* (${leader.clicks} кликов, лидерство +${lead})\n` +
        `Новый primary URL:\n${entry.url}\n\nA/B тест отключён.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.warn({ err, index }, "Failed to notify owner about auto-promote");
  }
}

async function persistLinkAbTest(position: number, state: AbTestState | null): Promise<void> {
  try {
    await db
      .update(linksTable)
      .set({ abTest: serializeAbTest(state) })
      .where(eq(linksTable.position, position));
  } catch (err) {
    logger.error({ err, position }, "Failed to persist ab test state");
  }
}

// ===== DB persistence =====

function ensureSchemaUpgrades(): void {
  // Idempotent runtime migrations for SQLite — safe to call on every startup.
  try {
    sqliteConnection.exec(`ALTER TABLE links ADD COLUMN image_file_id TEXT`);
    logger.info("Schema upgrade: added links.image_file_id column");
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (!/duplicate column name/i.test(msg)) {
      logger.error({ err }, "Schema upgrade for links.image_file_id failed");
    }
  }
}

async function loadStateFromDb(): Promise<void> {
  ensureSchemaUpgrades();
  try {
    const linkRows = await db.select().from(linksTable).orderBy(linksTable.position);
    if (linkRows.length === 0) {
      // Seed with defaults on first run
      await db.insert(linksTable).values(
        DEFAULT_LINKS.map((l, i) => ({
          position: i,
          title: l.title,
          url: l.url,
          clicks: 0,
        })),
      );
      linkList.push(...DEFAULT_LINKS.map((l) => ({ ...l, clicks: 0 })));
    } else {
      linkList.length = 0;
      for (const row of linkRows) {
        linkList.push({
          title: row.title,
          url: row.url,
          clicks: row.clicks,
          abTest: parseAbTest(row.abTest),
          imageFileId: row.imageFileId ?? null,
        });
      }
    }

    const statsRows = await db.select().from(statsTable).where(eq(statsTable.id, 1));
    if (statsRows.length === 0) {
      await db.insert(statsTable).values({ id: 1 });
    } else {
      const row = statsRows[0];
      stats.totalStarts = row.totalStarts;
      stats.totalLinkOpens = row.totalLinkOpens;
      stats.totalWarnings = row.totalWarnings;
      stats.totalBans = row.totalBans;
      stats.totalKicks = row.totalKicks;
      stats.totalMutes = row.totalMutes;
    }

    const userRows = await db.select().from(knownUsersTable);
    for (const row of userRows) {
      knownUsers.add(row.telegramId);
    }

    const warningRows = await db.select().from(warningsTable);
    for (const row of warningRows) {
      if (!warnings.has(row.chatId)) warnings.set(row.chatId, new Map());
      warnings.get(row.chatId)!.set(row.userId, row.count);
    }

    const welcome = await loadSetting("welcomeCaption");
    if (welcome) settings.welcomeCaption = welcome;
    const desc = await loadSetting("botDescription");
    if (desc) settings.botDescription = desc;
    const autoHour = await loadSetting("autoBackupHour");
    if (autoHour !== null) {
      const n = Number(autoHour);
      settings.autoBackupHour = Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
    }
    settings.lastAutoBackupDate = await loadSetting("lastAutoBackupDate");
    const autoPromoteEnabled = await loadSetting("autoPromoteEnabled");
    if (autoPromoteEnabled !== null) settings.autoPromoteEnabled = autoPromoteEnabled === "true";
    const autoPromoteThreshold = await loadSetting("autoPromoteThreshold");
    if (autoPromoteThreshold !== null) {
      const n = Number(autoPromoteThreshold);
      if (Number.isInteger(n) && n >= 5 && n <= 1000) settings.autoPromoteThreshold = n;
    }
    const liveCounter = await loadSetting("liveCounterEnabled");
    if (liveCounter !== null) settings.liveCounterEnabled = liveCounter === "true";
    const faqOn = await loadSetting("faqEnabled");
    if (faqOn !== null) settings.faqEnabled = faqOn === "true";
    const faqText = await loadSetting("faqText");
    if (faqText) settings.faqText = faqText;
    const maintenance = await loadSetting("maintenanceMode");
    if (maintenance !== null) settings.maintenanceMode = maintenance === "true";
    const preStart = await loadSetting("preStartImageFileId");
    settings.preStartImageFileId = preStart && preStart.length > 0 ? preStart : null;
    const dailyRaw = await loadSetting("dailyStarts");
    if (dailyRaw) {
      try {
        const parsed = JSON.parse(dailyRaw) as { date?: string; count?: number };
        if (parsed.date && typeof parsed.count === "number") {
          dailyStarts.date = parsed.date;
          dailyStarts.count = parsed.count;
        }
      } catch {
        // ignore corrupt value
      }
    }
    rolloverDailyIfNeeded();

    logger.info(
      { links: linkList.length, users: knownUsers.size },
      "Loaded persisted bot state from database",
    );
  } catch (err) {
    logger.error({ err }, "Failed to load bot state from database");
  }
}

async function persistStats(): Promise<void> {
  try {
    await db
      .insert(statsTable)
      .values({ id: 1, ...stats })
      .onConflictDoUpdate({ target: statsTable.id, set: stats });
  } catch (err) {
    logger.error({ err }, "Failed to persist stats");
  }
}

async function persistKnownUser(userId: number): Promise<void> {
  try {
    await db
      .insert(knownUsersTable)
      .values({ telegramId: userId })
      .onConflictDoNothing();
  } catch (err) {
    logger.error({ err, userId }, "Failed to persist known user");
  }
}

async function persistWarning(chatId: number, userId: number, count: number): Promise<void> {
  try {
    await db
      .insert(warningsTable)
      .values({ chatId, userId, count })
      .onConflictDoUpdate({
        target: [warningsTable.chatId, warningsTable.userId],
        set: { count },
      });
  } catch (err) {
    logger.error({ err, chatId, userId }, "Failed to persist warning");
  }
}

async function deleteWarningRow(chatId: number, userId: number): Promise<void> {
  try {
    await db
      .delete(warningsTable)
      .where(sql`${warningsTable.chatId} = ${chatId} AND ${warningsTable.userId} = ${userId}`);
  } catch (err) {
    logger.error({ err, chatId, userId }, "Failed to delete warning");
  }
}

async function rewriteAllLinks(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.delete(linksTable);
      if (linkList.length > 0) {
        await tx.insert(linksTable).values(
          linkList.map((l, i) => ({
            position: i,
            title: l.title,
            url: l.url,
            clicks: l.clicks ?? 0,
            abTest: serializeAbTest(l.abTest ?? null),
            imageFileId: l.imageFileId ?? null,
          })),
        );
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to rewrite links");
  }
}

// ===== Bot logic =====

async function isAdmin(ctx: Context, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

type AnyButton = ReturnType<typeof Markup.button.url> | ReturnType<typeof Markup.button.callback>;

function buildLinkButtons(): AnyButton[][] {
  return linkList.map((entry, i) => [
    Markup.button.url(`${i + 1}. ${entry.title}`, entry.url),
  ]);
}

let botUsername = "";

const SHARE_TEXT =
  "💰 Лучшие предложения по займам в одном месте. Подписывайся!";

function buildShareButton(): AnyButton | null {
  if (!botUsername) return null;
  const shareUrl =
    `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}`)}` +
    `&text=${encodeURIComponent(SHARE_TEXT)}`;
  return Markup.button.url("📤 Поделиться ботом", shareUrl);
}

function buildStartKeyboard() {
  const buttons: AnyButton[][] = buildLinkButtons();
  if (settings.faqEnabled) {
    buttons.push([Markup.button.callback("❓ Частые вопросы", "faq")]);
  }
  buttons.push([
    Markup.button.callback("🔄 Обновить", "restart"),
    Markup.button.callback("✉️ Контакты", "contact"),
  ]);
  const shareBtn = buildShareButton();
  if (shareBtn) buttons.push([shareBtn]);
  return Markup.inlineKeyboard(buttons);
}

async function getTargetUser(ctx: Context): Promise<{ id: number; name: string } | null> {
  const msg = ctx.message;
  if (!msg || !("reply_to_message" in msg) || !msg.reply_to_message) return null;
  const target = msg.reply_to_message.from;
  if (!target) return null;
  return {
    id: target.id,
    name: target.first_name + (target.last_name ? ` ${target.last_name}` : ""),
  };
}

async function sendStartScreen(ctx: Context): Promise<void> {
  const keyboard = buildStartKeyboard();
  let caption = settings.welcomeCaption;
  if (settings.liveCounterEnabled) {
    caption = `${caption}\n\n${getLiveCounterLine()}`;
  }
  const photo = settings.preStartImageFileId
    ? settings.preStartImageFileId
    : Input.fromLocalFile(getWelcomeImagePath());
  try {
    await ctx.replyWithPhoto(photo, {
      caption,
      parse_mode: "Markdown",
      ...keyboard,
    });
  } catch (err) {
    if (settings.preStartImageFileId) {
      logger.warn({ err }, "Pre-start image failed, falling back to local welcome image");
      settings.preStartImageFileId = null;
      await persistSetting("preStartImageFileId", "");
      await ctx.replyWithPhoto(Input.fromLocalFile(getWelcomeImagePath()), {
        caption,
        parse_mode: "Markdown",
        ...keyboard,
      });
    } else {
      throw err;
    }
  }
}

bot.command("start", async (ctx) => {
  stats.totalStarts += 1;
  void persistStats();
  bumpDailyStarts();
  if (ctx.from?.id) {
    knownUsers.add(ctx.from.id);
    void persistKnownUser(ctx.from.id);
  }
  await sendStartScreen(ctx);
});

bot.action("restart", async (ctx) => {
  try {
    await ctx.answerCbQuery("Обновление…");
  } catch {
    // ignore
  }
  stats.totalStarts += 1;
  void persistStats();
  bumpDailyStarts();
  if (ctx.from?.id) {
    knownUsers.add(ctx.from.id);
    void persistKnownUser(ctx.from.id);
  }
  await sendStartScreen(ctx);
});

bot.action("contact", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {
    // ignore
  }
  await ctx.reply(
    "✉️ *Связаться с нами*\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📧 Email: \`${OWNER_EMAIL}\`\n\n` +
      "_Нажмите на адрес, чтобы скопировать его._\n" +
      "Мы отвечаем в течение 24 часов.",
    { parse_mode: "Markdown" },
  );
});

bot.action("faq", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {
    // ignore
  }
  await ctx.reply(settings.faqText, { parse_mode: "Markdown" });
});

bot.command("myid", (ctx) => {
  const id = ctx.from?.id;
  if (!id) return;
  ctx.reply(`🆔 Your Telegram user ID is: \`${id}\``, { parse_mode: "Markdown" });
});

bot.command("help", (ctx) => {
  if (isOwner(ctx)) {
    ctx.reply(
      "*📋 Owner Commands*\n\n" +
        "🔗 *General*:\n" +
        "/start — Show the welcome screen and offers\n" +
        "/links — Show the link list\n" +
        "/help — Show this help message\n" +
        "/myid — Show your Telegram user ID\n\n" +
        "👮 *Moderation* (reply to a user's message):\n" +
        "/ban — Permanently ban a user\n" +
        "/kick — Remove a user (they can rejoin)\n" +
        "/mute — Restrict a user from sending messages\n" +
        "/unmute — Restore a user's messaging rights\n" +
        "/warn — Issue a warning (auto-ban at 3 warnings)\n" +
        "/warns — Check a user's warning count\n\n" +
        "🔒 *Owner only*:\n" +
        "/addlink `<title> | <url>` — Add a link to the list\n" +
        "/editlink `<number> | <new_url>` — Change a link's URL\n" +
        "/removelink `<number>` — Remove a link by number\n" +
        "/variants `<number>` — Show A/B test stats for a link\n" +
        "/addvariant `<number> | <url>` — Add a rotating URL variant\n" +
        "/removevariant `<number> | <variant#>` — Remove a variant\n" +
        "/abreset `<number>` — Disable A/B testing for a link\n" +
        "/posts — Manage saved posts (open posts menu)\n" +
        "/stats — Show bot statistics\n\n" +
        `✉️ *Contact*: ${OWNER_EMAIL}`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  ctx.reply(
    "*📋 Available Commands*\n\n" +
      "/start — Показать приветствие и список предложений\n" +
      "/links — Показать список ссылок\n" +
      "/help — Показать это сообщение\n" +
      "/myid — Показать ваш Telegram ID\n\n" +
      `✉️ *Контакты*: ${OWNER_EMAIL}`,
    { parse_mode: "Markdown" },
  );
});

bot.command("links", async (ctx) => {
  stats.totalLinkOpens += 1;
  void persistStats();
  if (ctx.from?.id) {
    knownUsers.add(ctx.from.id);
    void persistKnownUser(ctx.from.id);
  }

  if (linkList.length === 0) {
    return ctx.reply("📭 Список пока пуст. Загляните чуть позже — скоро появятся новые предложения.");
  }

  await ctx.reply(
    "🔗 *Актуальные предложения*\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Выбирайте подходящий вариант — карточки с картинками внизу, остальные — кнопками.",
    { parse_mode: "Markdown" },
  );

  for (let i = 0; i < linkList.length; i++) {
    const link = linkList[i];
    if (!link.imageFileId) continue;
    try {
      await ctx.replyWithPhoto(link.imageFileId, {
        caption: `*${i + 1}. ${link.title}*`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.url("🚀 Перейти", link.url)]]),
      });
    } catch (err) {
      logger.warn({ err, index: i }, "Failed to send link photo, sending text fallback");
    }
  }

  await ctx.reply("📋 *Все предложения:*", {
    parse_mode: "Markdown",
    ...buildStartKeyboard(),
  });
});

bot.command("addlink", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Only the bot owner can add links. Use the admin dashboard.");
  }

  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const parts = text.replace(/^\/addlink\s*/, "").split("|");

  if (parts.length < 2) {
    return ctx.reply(
      "⚠️ Usage: `/addlink Title | https://yourlink.com`",
      { parse_mode: "Markdown" },
    );
  }

  const title = parts[0].trim();
  const url = parts[1].trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return ctx.reply("⚠️ Please provide a valid URL starting with http:// or https://");
  }

  linkList.push({ title, url, clicks: 0 });
  await rewriteAllLinks();
  logger.info({ adminId: ctx.from?.id, title, url }, "Link added");

  ctx.reply(
    `✅ Link added as #${linkList.length}:\n*${title}*`,
    { parse_mode: "Markdown" },
  );
});

bot.command("editlink", async (ctx) => {
  if (!isOwner(ctx)) {
    return;
  }
  const text = ctx.message.text;
  const body = text.replace(/^\/editlink\s*/, "").trim();
  const parts = body.split("|");
  if (parts.length < 2) {
    await ctx.reply(
      "⚠️ Usage: `/editlink <number> | <new_url>`\n\nExample: `/editlink 3 | https://new.example.com`",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const num = parseInt(parts[0].trim(), 10);
  const newUrl = parts.slice(1).join("|").trim();
  if (Number.isNaN(num) || num < 1 || num > linkList.length) {
    await ctx.reply(
      `⚠️ Please specify a valid link number between 1 and ${linkList.length}.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  if (!newUrl.startsWith("http://") && !newUrl.startsWith("https://")) {
    await ctx.reply("⚠️ URL must start with http:// or https://");
    return;
  }
  const updated = await adminUpdateLink(num - 1, { url: newUrl });
  if (!updated) {
    await ctx.reply("❌ Link not found.");
    return;
  }
  await ctx.reply(
    `✅ Updated link #${num} (*${updated.title}*):\n${updated.url}`,
    { parse_mode: "Markdown" },
  );
});

function describeAbTest(entry: LinkEntry, num: number): string {
  const ab = entry.abTest;
  if (!ab || ab.variants.length === 0) {
    return `🧪 *A/B test for #${num} ${entry.title}*\n\n_No variants. Add one with:_\n\`/addvariant ${num} | <url>\``;
  }
  const pool = [
    { label: "A (primary)", url: entry.url, clicks: 0 },
    ...ab.variants.map((v, i) => ({
      label: `${String.fromCharCode(66 + i)}`,
      url: v.url,
      clicks: v.clicks,
    })),
  ];
  const totalVariantClicks = ab.variants.reduce((s, v) => s + v.clicks, 0);
  const primaryClicks = Math.max(0, (entry.clicks ?? 0) - totalVariantClicks);
  pool[0].clicks = primaryClicks;
  const totalAll = pool.reduce((s, p) => s + p.clicks, 0);
  const lines = pool.map((p, i) => {
    const pct = totalAll > 0 ? ((p.clicks / totalAll) * 100).toFixed(1) : "0.0";
    return `*${p.label}* (${i === 0 ? "vN/A" : `v${i}`}) — *${p.clicks}* clicks (${pct}%)\n  ${p.url}`;
  });
  return (
    `🧪 *A/B test for #${num} ${entry.title}*\n\n` +
    `Rotation pool: *${pool.length}* URLs\n` +
    `Total clicks: *${totalAll}*\n\n` +
    lines.join("\n\n") +
    `\n\n_Add another:_ \`/addvariant ${num} | <url>\`\n` +
    `_Remove variant:_ \`/removevariant ${num} | <variant#>\`\n` +
    `_Disable A/B:_ \`/abreset ${num}\``
  );
}

bot.command("variants", async (ctx) => {
  if (!isOwner(ctx)) return;
  const body = ctx.message.text.replace(/^\/variants\s*/, "").trim();
  const num = parseInt(body, 10);
  if (Number.isNaN(num) || num < 1 || num > linkList.length) {
    await ctx.reply(
      `⚠️ Usage: \`/variants <number>\`\nLink number 1–${linkList.length}.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  await ctx.reply(describeAbTest(linkList[num - 1], num), { parse_mode: "Markdown" });
});

bot.command("addvariant", async (ctx) => {
  if (!isOwner(ctx)) return;
  const body = ctx.message.text.replace(/^\/addvariant\s*/, "").trim();
  const parts = body.split("|");
  if (parts.length < 2) {
    await ctx.reply(
      "⚠️ Usage: `/addvariant <number> | <url>`\n\nExample: `/addvariant 3 | https://alt.example.com`",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const num = parseInt(parts[0].trim(), 10);
  const newUrl = parts.slice(1).join("|").trim();
  if (Number.isNaN(num) || num < 1 || num > linkList.length) {
    await ctx.reply(`⚠️ Link number must be between 1 and ${linkList.length}.`);
    return;
  }
  if (!newUrl.startsWith("http://") && !newUrl.startsWith("https://")) {
    await ctx.reply("⚠️ URL must start with http:// or https://");
    return;
  }
  const entry = linkList[num - 1];
  if (!entry.abTest) entry.abTest = { rotation: 0, variants: [] };
  if (entry.abTest.variants.length >= 9) {
    await ctx.reply("⚠️ Maximum 9 variants per link.");
    return;
  }
  entry.abTest.variants.push({ url: newUrl, clicks: 0 });
  await persistLinkAbTest(num - 1, entry.abTest);
  const variantLetter = String.fromCharCode(66 + entry.abTest.variants.length - 1);
  await ctx.reply(
    `✅ Variant *${variantLetter}* added to *${entry.title}*.\nRotation pool now has *${entry.abTest.variants.length + 1}* URLs.\n\nUse \`/variants ${num}\` to view stats.`,
    { parse_mode: "Markdown" },
  );
});

bot.command("removevariant", async (ctx) => {
  if (!isOwner(ctx)) return;
  const body = ctx.message.text.replace(/^\/removevariant\s*/, "").trim();
  const parts = body.split("|");
  if (parts.length < 2) {
    await ctx.reply(
      "⚠️ Usage: `/removevariant <linkNumber> | <variantNumber>`\n\nVariant 1 = B, 2 = C, etc. (A is the primary URL — use `/editlink` to change it.)",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const num = parseInt(parts[0].trim(), 10);
  const variantNum = parseInt(parts[1].trim(), 10);
  if (Number.isNaN(num) || num < 1 || num > linkList.length) {
    await ctx.reply(`⚠️ Link number must be between 1 and ${linkList.length}.`);
    return;
  }
  const entry = linkList[num - 1];
  if (!entry.abTest || entry.abTest.variants.length === 0) {
    await ctx.reply(`⚠️ Link #${num} has no variants.`);
    return;
  }
  if (Number.isNaN(variantNum) || variantNum < 1 || variantNum > entry.abTest.variants.length) {
    await ctx.reply(
      `⚠️ Variant number must be between 1 and ${entry.abTest.variants.length}.`,
    );
    return;
  }
  const removed = entry.abTest.variants.splice(variantNum - 1, 1)[0];
  if (entry.abTest.variants.length === 0) entry.abTest = null;
  await persistLinkAbTest(num - 1, entry.abTest);
  await ctx.reply(
    `✅ Removed variant from *${entry.title}*:\n${removed.url}`,
    { parse_mode: "Markdown" },
  );
});

bot.command("abreset", async (ctx) => {
  if (!isOwner(ctx)) return;
  const body = ctx.message.text.replace(/^\/abreset\s*/, "").trim();
  const num = parseInt(body, 10);
  if (Number.isNaN(num) || num < 1 || num > linkList.length) {
    await ctx.reply(
      `⚠️ Usage: \`/abreset <number>\`\nLink number 1–${linkList.length}.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  const entry = linkList[num - 1];
  entry.abTest = null;
  await persistLinkAbTest(num - 1, null);
  await ctx.reply(
    `✅ A/B testing disabled for *${entry.title}*. Only the primary URL will be served.`,
    { parse_mode: "Markdown" },
  );
});

bot.command("removelink", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Only the bot owner can remove links. Use the admin dashboard.");
  }

  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const numStr = text.replace(/^\/removelink\s*/, "").trim();
  const num = parseInt(numStr, 10);

  if (isNaN(num) || num < 1 || num > linkList.length) {
    return ctx.reply(
      `⚠️ Please specify a valid link number between 1 and ${linkList.length}.\nUsage: \`/removelink 1\``,
      { parse_mode: "Markdown" },
    );
  }

  const removed = linkList.splice(num - 1, 1)[0];
  await rewriteAllLinks();
  logger.info({ adminId: ctx.from?.id, removed }, "Link removed");

  ctx.reply(`🗑 Removed link #${num}: *${removed.title}*`, { parse_mode: "Markdown" });
});

bot.on(message("new_chat_members"), async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    const name = member.first_name + (member.last_name ? ` ${member.last_name}` : "");
    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "this group";
    await ctx.replyWithPhoto(Input.fromLocalFile(getWelcomeImagePath()), {
      caption:
        `👋 Welcome to *${chatTitle}*, *${name}*!\n\n` +
        "Please read the group rules and be respectful to everyone. We're glad you're here! 🎉",
      parse_mode: "Markdown",
    });
    logger.info({ userId: member.id, chat: ctx.chat.id }, "New member welcomed");
  }
});

bot.on(message("left_chat_member"), async (ctx) => {
  const member = ctx.message.left_chat_member;
  const name = member.first_name + (member.last_name ? ` ${member.last_name}` : "");
  await ctx.reply(`👋 *${name}* has left the group. Goodbye!`, { parse_mode: "Markdown" });
});

bot.command("ban", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to ban them.");
  }

  if (await isAdmin(ctx, target.id)) {
    return ctx.reply("⚠️ You cannot ban another admin.");
  }

  try {
    await ctx.telegram.banChatMember(ctx.chat!.id, target.id);
    resetWarnings(ctx.chat!.id, target.id);
    stats.totalBans += 1;
    void persistStats();
    await ctx.reply(`🔨 *${target.name}* has been banned.`, { parse_mode: "Markdown" });
    logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: ctx.chat!.id }, "User banned");
  } catch (err) {
    logger.error({ err }, "Failed to ban user");
    ctx.reply("❌ Failed to ban the user. Make sure I have admin rights.");
  }
});

bot.command("kick", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to kick them.");
  }

  if (await isAdmin(ctx, target.id)) {
    return ctx.reply("⚠️ You cannot kick another admin.");
  }

  try {
    await ctx.telegram.banChatMember(ctx.chat!.id, target.id);
    await ctx.telegram.unbanChatMember(ctx.chat!.id, target.id);
    stats.totalKicks += 1;
    void persistStats();
    await ctx.reply(`👢 *${target.name}* has been kicked. They can rejoin with an invite link.`, { parse_mode: "Markdown" });
    logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: ctx.chat!.id }, "User kicked");
  } catch (err) {
    logger.error({ err }, "Failed to kick user");
    ctx.reply("❌ Failed to kick the user. Make sure I have admin rights.");
  }
});

bot.command("mute", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to mute them.");
  }

  if (await isAdmin(ctx, target.id)) {
    return ctx.reply("⚠️ You cannot mute another admin.");
  }

  try {
    await ctx.telegram.restrictChatMember(ctx.chat!.id, target.id, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      },
    });
    stats.totalMutes += 1;
    void persistStats();
    await ctx.reply(`🔇 *${target.name}* has been muted.`, { parse_mode: "Markdown" });
    logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: ctx.chat!.id }, "User muted");
  } catch (err) {
    logger.error({ err }, "Failed to mute user");
    ctx.reply("❌ Failed to mute the user. Make sure I have admin rights.");
  }
});

bot.command("unmute", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to unmute them.");
  }

  try {
    await ctx.telegram.restrictChatMember(ctx.chat!.id, target.id, {
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: true,
        can_pin_messages: false,
      },
    });
    await ctx.reply(`🔊 *${target.name}* has been unmuted.`, { parse_mode: "Markdown" });
    logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: ctx.chat!.id }, "User unmuted");
  } catch (err) {
    logger.error({ err }, "Failed to unmute user");
    ctx.reply("❌ Failed to unmute the user. Make sure I have admin rights.");
  }
});

bot.command("warn", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to warn them.");
  }

  if (await isAdmin(ctx, target.id)) {
    return ctx.reply("⚠️ You cannot warn another admin.");
  }

  const chatId = ctx.chat!.id;
  const count = addWarning(chatId, target.id);
  stats.totalWarnings += 1;
  void persistStats();
  const maxWarnings = 3;

  if (count >= maxWarnings) {
    try {
      await ctx.telegram.banChatMember(chatId, target.id);
      resetWarnings(chatId, target.id);
      stats.totalBans += 1;
      void persistStats();
      await ctx.reply(
        `🚫 *${target.name}* has reached ${maxWarnings} warnings and has been *automatically banned*.`,
        { parse_mode: "Markdown" },
      );
      logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: chatId }, "User auto-banned after max warnings");
    } catch (err) {
      logger.error({ err }, "Failed to auto-ban user");
      ctx.reply("❌ Failed to ban the user after max warnings. Make sure I have admin rights.");
    }
  } else {
    await ctx.reply(
      `⚠️ *${target.name}* has been warned. (${count}/${maxWarnings} warnings)\n\n` +
        `At ${maxWarnings} warnings they will be automatically banned.`,
      { parse_mode: "Markdown" },
    );
    logger.info({ targetId: target.id, ownerId: ctx.from?.id, chat: chatId, count }, "User warned");
  }
});

bot.command("stats", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Only the bot owner can view stats. Use the admin dashboard.");
  }

  let activeWarnings = 0;
  let usersWithWarnings = 0;
  for (const perChat of warnings.values()) {
    for (const count of perChat.values()) {
      activeWarnings += count;
      if (count > 0) usersWithWarnings += 1;
    }
  }

  const totalClicks = linkList.reduce((sum, e) => sum + (e.clicks ?? 0), 0);
  const ranked = linkList
    .map((e, i) => ({ i, title: e.title, clicks: e.clicks ?? 0 }))
    .sort((a, b) => b.clicks - a.clicks);

  const top =
    ranked
      .slice(0, 10)
      .map((e) => `  ${e.i + 1}. ${e.title} — *${e.clicks}*`)
      .join("\n") || "  _no clicks yet_";

  ctx.reply(
    "📊 *Bot Statistics*\n\n" +
      `👥 Unique users: *${knownUsers.size}*\n` +
      `▶️ Total /start invocations: *${stats.totalStarts}*\n` +
      `🔗 Total /links opens: *${stats.totalLinkOpens}*\n` +
      `🧾 Loan offers in list: *${linkList.length}*\n` +
      `🖱 Total offer clicks: *${totalClicks}*\n\n` +
      "*Top offers (clicks):*\n" +
      top +
      "\n\n" +
      "*Moderation (cumulative):*\n" +
      `⚠️ Warnings issued: *${stats.totalWarnings}*\n` +
      `🔨 Bans: *${stats.totalBans}*\n` +
      `👢 Kicks: *${stats.totalKicks}*\n` +
      `🔇 Mutes: *${stats.totalMutes}*\n\n` +
      "*Currently active warnings:*\n" +
      `📋 Total points: *${activeWarnings}*\n` +
      `👤 Users with warnings: *${usersWithWarnings}*`,
    { parse_mode: "Markdown" },
  );
});

bot.command("warns", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ This command is restricted to the bot owner.");
  }

  const target = await getTargetUser(ctx);
  if (!target) {
    return ctx.reply("↩️ Reply to a user's message to check their warnings.");
  }

  const count = getWarnings(ctx.chat!.id, target.id);
  ctx.reply(`📋 *${target.name}* has *${count}/3* warnings.`, { parse_mode: "Markdown" });
});

// ===== In-bot Admin Menu =====

type OwnerInteraction =
  | { mode: "idle" }
  | { mode: "addlink" }
  | { mode: "broadcast" }
  | { mode: "schedule_time" }
  | { mode: "schedule_message"; scheduledAt: Date }
  | { mode: "schedule_post_time"; postId: number }
  | {
      mode: "recurring_post_time";
      postId: number;
      kind: "daily" | "weekly";
      dayOfWeek?: number;
    }
  | { mode: "rename_link"; index: number }
  | { mode: "edit_link_url"; index: number }
  | { mode: "edit_welcome" }
  | { mode: "edit_description" }
  | { mode: "edit_faq" }
  | { mode: "upload_welcome_image" }
  | { mode: "upload_prestart_image" }
  | { mode: "set_link_image"; index: number }
  | { mode: "edit_promote_threshold" }
  | { mode: "post_title" }
  | { mode: "post_content"; title: string }
  | { mode: "recurring_time"; kind: "daily" | "weekly"; dayOfWeek?: number }
  | {
      mode: "recurring_message";
      kind: "daily" | "weekly";
      hour: number;
      minute: number;
      dayOfWeek?: number;
    };

const ownerInteractions = new Map<number, OwnerInteraction>();

function getOwnerMode(userId: number): OwnerInteraction {
  return ownerInteractions.get(userId) ?? { mode: "idle" };
}

function setOwnerMode(userId: number, state: OwnerInteraction): void {
  ownerInteractions.set(userId, state);
}

function buildAdminMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("─── 📈 Аналитика ───", "admin:noop")],
    [
      Markup.button.callback("📊 Статистика", "admin:stats"),
      Markup.button.callback("👥 Пользователи", "admin:users"),
    ],
    [Markup.button.callback("─── 📢 Контент ───", "admin:noop")],
    [
      Markup.button.callback("🔗 Ссылки", "admin:links"),
      Markup.button.callback("📝 Посты", "admin:posts"),
    ],
    [Markup.button.callback("📢 Рассылка", "admin:broadcast")],
    [Markup.button.callback("─── 🛡 Модерация ───", "admin:noop")],
    [Markup.button.callback("⚠️ Предупреждения", "admin:warnings")],
    [Markup.button.callback("─── ⚙️ Система ───", "admin:noop")],
    [
      Markup.button.callback("⚙️ Настройки", "admin:settings"),
      Markup.button.callback("ℹ️ Команды", "admin:help"),
    ],
    [
      Markup.button.callback("🔌 Транспорт", "admin:transport"),
      Markup.button.callback("💾 Бэкап БД", "admin:backup"),
    ],
    [Markup.button.callback("❌ Закрыть", "admin:close")],
  ]);
}

const ADMIN_MAIN_TEXT =
  "🎛 *Админ-панель*\n" +
  "━━━━━━━━━━━━━━━━━━\n\n" +
  "Управляйте ботом по разделам ниже.\n" +
  "Все изменения сохраняются автоматически.";

async function showAdminMain(ctx: Context, edit: boolean): Promise<void> {
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  const opts = { parse_mode: "Markdown" as const, ...buildAdminMainMenu() };
  if (edit) {
    try {
      await ctx.editMessageText(ADMIN_MAIN_TEXT, opts);
      return;
    } catch {
      // fall through to reply if editing failed
    }
  }
  await ctx.reply(ADMIN_MAIN_TEXT, opts);
}

bot.command("admin", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Меню доступно только владельцу.");
  }
  await showAdminMain(ctx, false);
});

bot.command("menu", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Меню доступно только владельцу.");
  }
  await showAdminMain(ctx, false);
});

bot.command("cancel", async (ctx) => {
  if (!isOwner(ctx)) return;
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  await ctx.reply("✅ Действие отменено.");
});

async function sendBackupToOwner(caption: string): Promise<void> {
  // Flush WAL into the main database file so the backup is consistent.
  sqliteConnection.pragma("wal_checkpoint(TRUNCATE)");
  const dbPath = resolveDbPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await bot.telegram.sendDocument(
    OWNER_ID,
    Input.fromLocalFile(dbPath, `bot-backup-${stamp}.db`),
    { caption },
  );
  logger.info({ dbPath }, "Sent database backup to owner");
}

bot.command("backup", async (ctx) => {
  if (!isOwner(ctx)) return;
  try {
    await sendBackupToOwner("💾 Резервная копия базы данных");
  } catch (err) {
    logger.error({ err }, "Failed to send database backup");
    await ctx.reply("❌ Не удалось создать резервную копию базы данных.");
  }
});

bot.command("autobackup", async (ctx) => {
  if (!isOwner(ctx)) return;
  const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();

  if (!arg) {
    const status =
      settings.autoBackupHour === null
        ? "🔕 Авто-резервирование выключено."
        : `🟢 Авто-резервирование включено: каждый день в ${String(settings.autoBackupHour).padStart(2, "0")}:00 UTC.`;
    await ctx.reply(
      `${status}\n\n` +
        `Использование:\n` +
        `• /autobackup <0-23> — установить час (UTC)\n` +
        `• /autobackup off — отключить`,
    );
    return;
  }

  if (arg === "off" || arg === "disable" || arg === "выкл") {
    settings.autoBackupHour = null;
    await persistSetting("autoBackupHour", "");
    await ctx.reply("🔕 Авто-резервирование отключено.");
    return;
  }

  const hour = Number(arg);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    await ctx.reply("⚠️ Укажите час от 0 до 23, либо `off`.");
    return;
  }
  settings.autoBackupHour = hour;
  // Reset the "already sent today" marker so today's run can fire if its hour hasn't passed yet.
  settings.lastAutoBackupDate = null;
  await persistSetting("autoBackupHour", String(hour));
  await persistSetting("lastAutoBackupDate", "");
  await ctx.reply(
    `🟢 Авто-резервирование включено: каждый день в ${String(hour).padStart(2, "0")}:00 UTC.`,
  );
});

let autoBackupRunning = false;

async function runDueAutoBackup(): Promise<void> {
  if (autoBackupRunning) return;
  if (settings.autoBackupHour === null) return;
  const now = new Date();
  if (now.getUTCHours() !== settings.autoBackupHour) return;
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  if (settings.lastAutoBackupDate === today) return;

  autoBackupRunning = true;
  try {
    await sendBackupToOwner(`💾 Авто-резервная копия (${today} UTC)`);
    settings.lastAutoBackupDate = today;
    await persistSetting("lastAutoBackupDate", today);
  } catch (err) {
    logger.error({ err }, "Auto-backup failed");
  } finally {
    autoBackupRunning = false;
  }
}

const RESTORE_TABLES = [
  "links",
  "stats",
  "known_users",
  "warnings",
  "scheduled_broadcasts",
  "settings",
  "recurring_broadcasts",
] as const;

const MAX_RESTORE_BYTES = 50 * 1024 * 1024; // 50 MB

function clearInMemoryState(): void {
  linkList.length = 0;
  knownUsers.clear();
  warnings.clear();
  stats.totalStarts = 0;
  stats.totalLinkOpens = 0;
  stats.totalWarnings = 0;
  stats.totalBans = 0;
  stats.totalKicks = 0;
  stats.totalMutes = 0;
  settings.welcomeCaption = DEFAULT_WELCOME_CAPTION;
  settings.botDescription = DEFAULT_BOT_DESCRIPTION;
  settings.autoBackupHour = null;
  settings.lastAutoBackupDate = null;
}

bot.command("restore", async (ctx) => {
  if (!isOwner(ctx)) return;

  const replied = ctx.message?.reply_to_message;
  const doc =
    replied && "document" in replied ? replied.document : undefined;
  if (!doc) {
    await ctx.reply(
      "⚠️ Чтобы восстановить базу, ответьте командой /restore на сообщение с файлом резервной копии (.db).",
    );
    return;
  }
  if (!doc.file_name?.toLowerCase().endsWith(".db")) {
    await ctx.reply("⚠️ Файл должен иметь расширение .db");
    return;
  }
  if (doc.file_size && doc.file_size > MAX_RESTORE_BYTES) {
    await ctx.reply(
      `⚠️ Файл слишком большой (>${Math.round(MAX_RESTORE_BYTES / 1024 / 1024)} МБ).`,
    );
    return;
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "bot-restore-"));
  const tmpPath = path.join(tmpDir, "restore.db");

  try {
    await ctx.reply("⏳ Скачиваю резервную копию…");

    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.toString());
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);

    // Validate the file is a real SQLite DB with the expected tables.
    const probe = new Database(tmpPath, { readonly: true });
    try {
      const rows = probe
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RESTORE_TABLES.map(() => "?").join(",")})`,
        )
        .all(...RESTORE_TABLES) as Array<{ name: string }>;
      const tables = rows.map((r) => r.name);
      const missing = RESTORE_TABLES.filter((t) => !tables.includes(t));
      if (missing.length) {
        throw new Error(`missing tables: ${missing.join(", ")}`);
      }
    } finally {
      probe.close();
    }

    await ctx.reply("⏳ Применяю резервную копию…");

    // Atomically swap data: ATTACH the uploaded file, replace every table's
    // contents inside one transaction, DETACH. The live connection stays open.
    sqliteConnection.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS src`);
    try {
      const swap = sqliteConnection.transaction(() => {
        for (const t of RESTORE_TABLES) {
          sqliteConnection.exec(`DELETE FROM "${t}"`);
          sqliteConnection.exec(`INSERT INTO "${t}" SELECT * FROM src."${t}"`);
        }
      });
      swap();
    } finally {
      sqliteConnection.exec("DETACH DATABASE src");
    }

    // Refresh in-memory caches from the newly restored data.
    clearInMemoryState();
    await loadStateFromDb();

    await ctx.reply(
      `✅ База восстановлена.\n\n` +
        `🔗 Ссылок: ${linkList.length}\n` +
        `👥 Известных пользователей: ${knownUsers.size}\n` +
        `📊 Запусков: ${stats.totalStarts}`,
    );
    logger.info(
      {
        links: linkList.length,
        users: knownUsers.size,
        sourceFile: doc.file_name,
      },
      "Database restored from backup",
    );
  } catch (err) {
    logger.error({ err }, "Failed to restore database");
    await ctx.reply(
      `❌ Не удалось восстановить базу: ${err instanceof Error ? err.message : "неизвестная ошибка"}`,
    );
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

async function ownerGate(ctx: Context): Promise<boolean> {
  if (!isOwner(ctx)) {
    try {
      await ctx.answerCbQuery("⛔ Только для владельца");
    } catch {
      // ignore
    }
    return false;
  }
  return true;
}

bot.action("admin:main", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await showAdminMain(ctx, true);
});

bot.action("admin:close", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Закрыто"); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  try { await ctx.deleteMessage(); } catch { /* ignore */ }
});

bot.action("admin:noop", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
});

bot.action("admin:stats", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const s = adminGetStats();
  const top = s.topOffers.length
    ? s.topOffers.map((o) => `  ${o.index + 1}. ${o.title} — *${o.clicks}*`).join("\n")
    : "  _нет кликов_";
  const text =
    "📊 *Статистика*\n\n" +
    `👥 Уникальных пользователей: *${s.uniqueUsers}*\n` +
    `▶️ Всего /start: *${s.totalStarts}*\n` +
    `🔗 Всего /links: *${s.totalLinkOpens}*\n` +
    `🧾 Предложений в списке: *${s.totalLinks}*\n` +
    `🖱 Всего кликов: *${s.totalClicks}*\n\n` +
    "*Топ предложений:*\n" + top + "\n\n" +
    "*Модерация (всего):*\n" +
    `⚠️ Предупреждений: *${s.totalWarnings}*\n` +
    `🔨 Банов: *${s.totalBans}*\n` +
    `👢 Киков: *${s.totalKicks}*\n` +
    `🔇 Мутов: *${s.totalMutes}*\n\n` +
    "*Активные предупреждения:*\n" +
    `📋 Сумма очков: *${s.activeWarningPoints}*\n` +
    `👤 Пользователей: *${s.usersWithWarnings}*`;
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:main")]]),
  });
});

function buildClicksBar(value: number, max: number, width = 10): string {
  if (max <= 0) return "·".repeat(width);
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

bot.action("admin:links:top", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const links = listLinks();
  if (links.length === 0) {
    await ctx.editMessageText("📭 Список ссылок пуст.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  const ranked = [...links].sort((a, b) => b.clicks - a.clicks);
  const total = ranked.reduce((sum, l) => sum + l.clicks, 0);
  const max = ranked[0].clicks;
  const lines = ranked.slice(0, 15).map((l, i) => {
    const pct = total > 0 ? ((l.clicks / total) * 100).toFixed(1) : "0.0";
    const bar = buildClicksBar(l.clicks, max);
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    const ab = l.variantCount > 0 ? ` 🧪${l.variantCount + 1}` : "";
    return `${medal} *${l.title}*${ab}\n  \`${bar}\` *${l.clicks}* (${pct}%)`;
  });
  const text =
    "📈 *Топ кликов*\n\n" +
    `Всего кликов: *${total}*\n` +
    `Предложений: *${ranked.length}*\n\n` +
    lines.join("\n\n") +
    "\n\n_Нажмите на ссылку, чтобы изменить её URL._";
  const editButtons = ranked.slice(0, 10).map((l) => [
    Markup.button.callback(
      `🌐 #${l.index + 1} ${l.title} (${l.clicks})`,
      `admin:links:edit_url:${l.index}`,
    ),
  ]);
  editButtons.push([
    Markup.button.callback("🔄 Сбросить клики", "admin:links:reset"),
    Markup.button.callback("🔙 Назад", "admin:links"),
  ]);
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(editButtons),
  });
});

async function showLinksMenu(ctx: Context): Promise<void> {
  const links = listLinks();
  const list = links.length
    ? links
        .map((l) => {
          const pic = linkList[l.index]?.imageFileId ? " 🖼" : "";
          return `${l.index + 1}. *${l.title}*${pic} — ${l.clicks} кликов`;
        })
        .join("\n")
    : "_Список пуст_";
  const text =
    "🔗 *Управление ссылками*\n" +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    `${list}\n\n` +
    "_🖼 = у ссылки есть картинка._\n\n" +
    "Выберите действие:";
  const buttons = [
    [Markup.button.callback("📈 Топ кликов", "admin:links:top")],
    [
      Markup.button.callback("➕ Добавить", "admin:links:add"),
      Markup.button.callback("➖ Удалить", "admin:links:remove"),
    ],
    [
      Markup.button.callback("✏️ Переименовать", "admin:links:rename"),
      Markup.button.callback("🌐 Изменить URL", "admin:links:edit_url"),
    ],
    [
      Markup.button.callback("🖼 Картинки ссылок", "admin:links:image"),
      Markup.button.callback("🔄 Сбросить клики", "admin:links:reset"),
    ],
    [Markup.button.callback("🔙 Назад", "admin:main")],
  ];
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

bot.action("admin:links", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  await showLinksMenu(ctx);
});

bot.action("admin:links:add", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "addlink" });
  await ctx.editMessageText(
    "➕ *Добавить ссылку*\n\nОтправьте новую ссылку в формате:\n`Название | https://example.com`\n\nИли нажмите Отмена / отправьте /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:links")]]),
    },
  );
});

bot.action("admin:links:remove", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const links = listLinks();
  if (links.length === 0) {
    await ctx.editMessageText("📭 Удалять нечего.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  const buttons = links.map((l) => [
    Markup.button.callback(`${l.index + 1}. ${l.title}`, `admin:links:remove:${l.index}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:links")]);
  await ctx.editMessageText("➖ *Нажмите на ссылку, чтобы удалить её*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^admin:links:remove:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  try { await ctx.answerCbQuery("Удаляю..."); } catch { /* ignore */ }
  const removed = await adminRemoveLink(index);
  if (!removed) {
    await ctx.editMessageText("❌ Ссылка не найдена.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  await showLinksMenu(ctx);
  await ctx.reply(`🗑 Удалена: *${removed.title}*`, { parse_mode: "Markdown" });
});

bot.action("admin:links:reset", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText("⚠️ Сбросить *все* счётчики кликов до нуля?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Да, сбросить", "admin:links:reset:yes"),
        Markup.button.callback("❌ Отмена", "admin:links"),
      ],
    ]),
  });
});

bot.action("admin:links:reset:yes", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Сбрасываю..."); } catch { /* ignore */ }
  await adminResetClicks();
  await showLinksMenu(ctx);
  await ctx.reply("✅ Все счётчики кликов сброшены.");
});

bot.action("admin:links:rename", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const links = listLinks();
  if (links.length === 0) {
    await ctx.editMessageText("📭 Переименовывать нечего.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  const buttons = links.map((l) => [
    Markup.button.callback(`${l.index + 1}. ${l.title}`, `admin:links:rename:${l.index}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:links")]);
  await ctx.editMessageText("✏️ *Выберите ссылку для переименования*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^admin:links:rename:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const link = listLinks()[index];
  if (!link) {
    await ctx.editMessageText("❌ Ссылка не найдена.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  setOwnerMode(ctx.from!.id, { mode: "rename_link", index });
  await ctx.editMessageText(
    `✏️ *Переименовать ссылку #${index + 1}*\n\nТекущее название: *${link.title}*\n\nОтправьте новое название или /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:links")]]),
    },
  );
});

bot.action("admin:links:edit_url", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const links = listLinks();
  if (links.length === 0) {
    await ctx.editMessageText("📭 Нет ссылок для редактирования.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  const buttons = links.map((l) => [
    Markup.button.callback(`${l.index + 1}. ${l.title}`, `admin:links:edit_url:${l.index}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:links")]);
  await ctx.editMessageText("🌐 *Выберите ссылку, чтобы изменить URL*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^admin:links:edit_url:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const link = listLinks()[index];
  if (!link) {
    await ctx.editMessageText("❌ Ссылка не найдена.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  setOwnerMode(ctx.from!.id, { mode: "edit_link_url", index });
  await ctx.editMessageText(
    `🌐 *Изменить URL ссылки #${index + 1}*\n\nНазвание: *${link.title}*\nТекущий URL: ${link.url}\n\nОтправьте новый URL (должен начинаться с http:// или https://) или /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:links")]]),
    },
  );
});

bot.action("admin:links:image", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const links = listLinks();
  if (links.length === 0) {
    await ctx.editMessageText("📭 Нет ссылок.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links")]]),
    });
    return;
  }
  const buttons = links.map((l) => {
    const pic = linkList[l.index]?.imageFileId ? "🖼" : "—";
    return [
      Markup.button.callback(
        `${pic} ${l.index + 1}. ${l.title}`,
        `admin:links:image:${l.index}`,
      ),
    ];
  });
  buttons.push([Markup.button.callback("🔙 Назад", "admin:links")]);
  await ctx.editMessageText(
    "🖼 *Картинки ссылок*\n\nВыберите ссылку, чтобы загрузить или убрать её картинку:",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    },
  );
});

bot.action(/^admin:links:image:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const link = linkList[index];
  if (!link) {
    await ctx.editMessageText("❌ Ссылка не найдена.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links:image")]]),
    });
    return;
  }
  const has = Boolean(link.imageFileId);
  const buttons: AnyButton[][] = [
    [Markup.button.callback("📷 Загрузить новую", `admin:links:image:set:${index}`)],
  ];
  if (has) {
    buttons.push([Markup.button.callback("🗑 Убрать картинку", `admin:links:image:clear:${index}`)]);
  }
  buttons.push([Markup.button.callback("🔙 К списку", "admin:links:image")]);
  await ctx.editMessageText(
    `🖼 *Картинка для #${index + 1}: ${link.title}*\n\n` +
      `Текущий статус: ${has ? "✅ установлена" : "—"}\n\n` +
      `URL: ${link.url}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    },
  );
});

bot.action(/^admin:links:image:set:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  if (!linkList[index]) {
    await ctx.editMessageText("❌ Ссылка не найдена.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:links:image")]]),
    });
    return;
  }
  setOwnerMode(ctx.from!.id, { mode: "set_link_image", index });
  await ctx.editMessageText(
    `📷 *Картинка для ссылки #${index + 1}*\n\n` +
      `Отправьте фото *как фото* (не как файл).\n\n` +
      `Для отмены — /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", `admin:links:image:${index}`)]]),
    },
  );
});

bot.action(/^admin:links:image:clear:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const index = parseInt(m[1], 10);
  if (linkList[index]) {
    linkList[index] = { ...linkList[index], imageFileId: null };
    await rewriteAllLinks();
  }
  try { await ctx.answerCbQuery("Картинка убрана"); } catch { /* ignore */ }
  await ctx.editMessageText(
    `🗑 Картинка ссылки #${index + 1} удалена.`,
    {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К списку", "admin:links:image")]]),
    },
  );
});

async function showSettingsMenu(ctx: Context, edit: boolean): Promise<void> {
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  const onOff = (v: boolean) => (v ? "✅" : "❌");
  const text =
    "⚙️ *Настройки бота*\n" +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    "📋 *Текущее состояние:*\n" +
    `• 🛠 Обслуживание: ${onOff(settings.maintenanceMode)}\n` +
    `• 🔥 Счётчик «сегодня»: ${onOff(settings.liveCounterEnabled)}\n` +
    `• ❓ Кнопка FAQ: ${onOff(settings.faqEnabled)}\n` +
    `• 🧪 Авто-продвижение: ${onOff(settings.autoPromoteEnabled)}` +
    (settings.autoPromoteEnabled ? ` (порог ${settings.autoPromoteThreshold})` : "") +
    "\n" +
    `• 🌅 Картинка стартового меню: ${settings.preStartImageFileId ? "✅ загружена" : "по умолчанию"}\n\n` +
    "📝 *Тексты (превью):*\n" +
    `_Приветствие:_ ${truncate(settings.welcomeCaption, 120)}\n\n` +
    `_Описание:_ ${truncate(settings.botDescription, 120)}\n\n` +
    "Выберите раздел для изменения 👇";
  const opts = {
    parse_mode: "Markdown" as const,
    ...Markup.inlineKeyboard([
      // — Тексты
      [Markup.button.callback("─── 📝 Тексты ───", "admin:settings:noop")],
      [
        Markup.button.callback("👋 Приветствие", "admin:settings:welcome"),
        Markup.button.callback("📝 Описание", "admin:settings:description"),
      ],
      [Markup.button.callback("❓ Текст FAQ", "admin:settings:faq:edit")],

      // — Картинки
      [Markup.button.callback("─── 🖼 Картинки ───", "admin:settings:noop")],
      [
        Markup.button.callback("🌅 Стартовое меню (загрузить)", "admin:settings:prestart:upload"),
      ],
      [
        Markup.button.callback("♻️ Стартовое меню (сброс)", "admin:settings:prestart:reset"),
      ],
      [
        Markup.button.callback("🖼 Локальная картинка", "admin:settings:image:upload"),
        Markup.button.callback("♻️ По умолчанию", "admin:settings:image:reset"),
      ],

      // — Переключатели
      [Markup.button.callback("─── 🔘 Переключатели ───", "admin:settings:noop")],
      [
        Markup.button.callback(
          `🛠 Обслуживание: ${settings.maintenanceMode ? "ВКЛ" : "выкл"}`,
          "admin:settings:maintenance:toggle",
        ),
      ],
      [
        Markup.button.callback(
          `🔥 Счётчик: ${settings.liveCounterEnabled ? "ВКЛ" : "выкл"}`,
          "admin:settings:livecounter:toggle",
        ),
        Markup.button.callback(
          `❓ FAQ: ${settings.faqEnabled ? "ВКЛ" : "выкл"}`,
          "admin:settings:faq:toggle",
        ),
      ],
      [
        Markup.button.callback(
          `🧪 Авто-продвиж: ${settings.autoPromoteEnabled ? "ВКЛ" : "выкл"}`,
          "admin:settings:promote:toggle",
        ),
        Markup.button.callback("🎯 Порог", "admin:settings:promote:threshold"),
      ],

      // — Сервис
      [Markup.button.callback("─── 🧹 Сервис ───", "admin:settings:noop")],
      [
        Markup.button.callback("♻️ Сбросить тексты", "admin:settings:reset"),
        Markup.button.callback("🔙 В меню", "admin:main"),
      ],
    ]),
  };
  if (edit) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      // fall through
    }
  }
  await ctx.reply(text, opts);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

bot.action("admin:settings", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:welcome", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "edit_welcome" });
  await ctx.editMessageText(
    "👋 *Изменить приветствие*\n\n" +
      "Это сообщение показывается под картинкой после нажатия Start.\n\n" +
      "*Текущее:*\n" +
      `${settings.welcomeCaption}\n\n` +
      "Отправьте новый текст (Markdown поддерживается) или /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

bot.action("admin:settings:description", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "edit_description" });
  await ctx.editMessageText(
    "📝 *Изменить описание бота*\n\n" +
      "Это текст, который Telegram показывает в пустом чате с ботом — *до* того, как пользователь нажал Start.\n\n" +
      "*Текущее:*\n" +
      `${settings.botDescription}\n\n` +
      "Отправьте новый текст (до 512 символов, без Markdown) или /cancel.\n\n" +
      "_Изменение применится в Telegram через несколько минут._",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

bot.action("admin:settings:reset", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText("♻️ Сбросить *оба* текста к значениям по умолчанию?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Да", "admin:settings:reset:yes"),
        Markup.button.callback("❌ Отмена", "admin:settings"),
      ],
    ]),
  });
});

bot.action("admin:settings:reset:yes", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Сбрасываю..."); } catch { /* ignore */ }
  settings.welcomeCaption = DEFAULT_WELCOME_CAPTION;
  settings.botDescription = DEFAULT_BOT_DESCRIPTION;
  await persistSetting("welcomeCaption", DEFAULT_WELCOME_CAPTION);
  await persistSetting("botDescription", DEFAULT_BOT_DESCRIPTION);
  try { await bot.telegram.setMyDescription(DEFAULT_BOT_DESCRIPTION); } catch (err) {
    logger.warn({ err }, "Failed to apply default description in Telegram");
  }
  await showSettingsMenu(ctx, true);
  await ctx.reply("✅ Тексты сброшены к значениям по умолчанию.");
});

bot.action("admin:settings:promote:toggle", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  settings.autoPromoteEnabled = !settings.autoPromoteEnabled;
  await persistSetting("autoPromoteEnabled", settings.autoPromoteEnabled ? "true" : "false");
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:maintenance:toggle", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  settings.maintenanceMode = !settings.maintenanceMode;
  await persistSetting("maintenanceMode", settings.maintenanceMode ? "true" : "false");
  try {
    await ctx.answerCbQuery(
      settings.maintenanceMode
        ? "🛠 Обслуживание включено"
        : "✅ Бот снова доступен всем",
      { show_alert: true },
    );
  } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:livecounter:toggle", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  settings.liveCounterEnabled = !settings.liveCounterEnabled;
  await persistSetting("liveCounterEnabled", settings.liveCounterEnabled ? "true" : "false");
  try {
    await ctx.answerCbQuery(settings.liveCounterEnabled ? "Счётчик включён" : "Счётчик выключен");
  } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:faq:toggle", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  settings.faqEnabled = !settings.faqEnabled;
  await persistSetting("faqEnabled", settings.faqEnabled ? "true" : "false");
  try {
    await ctx.answerCbQuery(settings.faqEnabled ? "FAQ включён" : "FAQ выключен");
  } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:image:upload", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "upload_welcome_image" });
  await ctx.editMessageText(
    "🖼 *Заменить картинку приветствия*\n\n" +
      "Отправьте новое изображение *как фото* (не как файл).\n\n" +
      "Оно будет показываться над приветственным текстом после нажатия Start.\n\n" +
      "Чтобы вернуть стандартную картинку — нажмите «♻️ Картинка по умолч.» в настройках.\n\n" +
      "Для отмены отправьте /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

bot.action("admin:settings:image:reset", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const removed = clearCustomWelcomeImage();
  try {
    await ctx.answerCbQuery(removed ? "Картинка сброшена" : "Используется стандартная");
  } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:noop", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
});

bot.action("admin:settings:prestart:upload", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "upload_prestart_image" });
  await ctx.editMessageText(
    "🌅 *Картинка стартового меню*\n\n" +
      "Отправьте изображение *как фото* (не как файл).\n\n" +
      "Эта картинка будет показываться над приветственным текстом сразу после нажатия Start.\n" +
      "В отличие от «Локальной картинки», она хранится в Telegram (быстрее, ничего не лежит на диске).\n\n" +
      "Чтобы вернуть стандартное изображение — нажмите «♻️ Стартовое меню (сброс)» в настройках.\n\n" +
      "Для отмены — /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

bot.action("admin:settings:prestart:reset", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const had = Boolean(settings.preStartImageFileId);
  settings.preStartImageFileId = null;
  await persistSetting("preStartImageFileId", "");
  try {
    await ctx.answerCbQuery(had ? "Сброшено" : "Уже стандартная");
  } catch { /* ignore */ }
  await showSettingsMenu(ctx, true);
});

bot.action("admin:settings:faq:edit", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "edit_faq" });
  await ctx.editMessageText(
    "📝 *Изменить FAQ*\n\n" +
      "Это сообщение показывается, когда пользователь нажимает кнопку «❓ Частые вопросы».\n\n" +
      "*Текущее:*\n" +
      `${settings.faqText}\n\n` +
      "Отправьте новый текст (Markdown поддерживается, до 3500 символов) или /cancel.\n" +
      "Чтобы вернуть текст по умолчанию, отправьте слово `default`.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

bot.action("admin:settings:promote:threshold", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "edit_promote_threshold" });
  await ctx.editMessageText(
    "🎯 *Порог авто-продвижения*\n\n" +
      `Сейчас: *${settings.autoPromoteThreshold}* кликов лидерства.\n\n` +
      "Когда вариант опережает все остальные на это число кликов И сам имеет хотя бы столько кликов, " +
      "он автоматически становится primary URL и A/B-тест отключается.\n\n" +
      "Отправьте новое число (от 5 до 1000) или /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:settings")]]),
    },
  );
});

// ===== Posts =====

interface PostRecord {
  id: number;
  title: string;
  text: string | null;
  photoFileId: string | null;
  createdAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
}

async function listPosts(): Promise<PostRecord[]> {
  try {
    const rows = await db.select().from(postsTable).orderBy(postsTable.id);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      photoFileId: r.photoFileId,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      sendCount: r.sendCount,
    }));
  } catch (err) {
    logger.error({ err }, "Failed to list posts");
    return [];
  }
}

async function getPost(id: number): Promise<PostRecord | null> {
  try {
    const rows = await db.select().from(postsTable).where(eq(postsTable.id, id));
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      title: r.title,
      text: r.text,
      photoFileId: r.photoFileId,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      sendCount: r.sendCount,
    };
  } catch (err) {
    logger.error({ err, id }, "Failed to get post");
    return null;
  }
}

async function createPost(
  title: string,
  text: string | null,
  photoFileId: string | null,
): Promise<PostRecord | null> {
  try {
    const result = await db
      .insert(postsTable)
      .values({ title, text, photoFileId })
      .returning();
    const r = result[0];
    return {
      id: r.id,
      title: r.title,
      text: r.text,
      photoFileId: r.photoFileId,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      sendCount: r.sendCount,
    };
  } catch (err) {
    logger.error({ err, title }, "Failed to create post");
    return null;
  }
}

async function deletePost(id: number): Promise<boolean> {
  try {
    await db.delete(postsTable).where(eq(postsTable.id, id));
    return true;
  } catch (err) {
    logger.error({ err, id }, "Failed to delete post");
    return false;
  }
}

async function recordPostSent(id: number): Promise<void> {
  try {
    const existing = await db.select().from(postsTable).where(eq(postsTable.id, id));
    if (existing.length === 0) return;
    await db
      .update(postsTable)
      .set({ lastSentAt: new Date(), sendCount: existing[0].sendCount + 1 })
      .where(eq(postsTable.id, id));
  } catch (err) {
    logger.error({ err, id }, "Failed to record post sent");
  }
}

async function broadcastPost(post: PostRecord): Promise<BroadcastResult> {
  const recipients = Array.from(knownUsers);
  let delivered = 0;
  let failed = 0;
  for (const userId of recipients) {
    try {
      if (post.photoFileId) {
        await bot.telegram.sendPhoto(userId, post.photoFileId, {
          caption: post.text ?? undefined,
          parse_mode: "Markdown",
        });
      } else if (post.text) {
        await bot.telegram.sendMessage(userId, post.text, { parse_mode: "Markdown" });
      } else {
        await bot.telegram.sendMessage(userId, `*${post.title}*`, { parse_mode: "Markdown" });
      }
      delivered += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, userId, postId: post.id }, "Post broadcast delivery failed");
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  await recordPostSent(post.id);
  return { attempted: recipients.length, delivered, failed };
}

async function showPostsMenu(ctx: Context, edit: boolean): Promise<void> {
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  const posts = await listPosts();
  const text =
    "📝 *Посты*\n\n" +
    (posts.length === 0
      ? "_Список пуст. Создайте первый пост._"
      : posts
          .map(
            (p) =>
              `#${p.id} *${p.title}*\n` +
              `  ${p.photoFileId ? "🖼" : "💬"} ${truncate(p.text ?? "_(только заголовок)_", 60)}\n` +
              `  📤 ${p.sendCount} отправок`,
          )
          .join("\n\n"));
  const buttons = posts.slice(0, 10).map((p) => [
    Markup.button.callback(`▶️ ${p.title}`, `admin:posts:open:${p.id}`),
  ]);
  buttons.push([Markup.button.callback("➕ Новый пост", "admin:posts:add")]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:main")]);
  const opts = {
    parse_mode: "Markdown" as const,
    ...Markup.inlineKeyboard(buttons),
  };
  if (edit) {
    try { await ctx.editMessageText(text, opts); return; } catch { /* fall through */ }
  }
  await ctx.reply(text, opts);
}

bot.action("admin:posts", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await showPostsMenu(ctx, true);
});

bot.command("posts", async (ctx) => {
  if (!isOwner(ctx)) return;
  await showPostsMenu(ctx, false);
});

bot.action("admin:posts:add", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "post_title" });
  await ctx.editMessageText(
    "➕ *Новый пост*\n\nШаг 1/2: отправьте *заголовок* (короткое имя для списка). Или /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:posts")]]),
    },
  );
});

bot.action(/^admin:posts:open:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) {
    await ctx.editMessageText("❌ Пост не найден.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:posts")]]),
    });
    return;
  }
  const text =
    `📝 *${post.title}* (#${post.id})\n\n` +
    `${post.photoFileId ? "🖼 *Тип:* фото с подписью\n" : "💬 *Тип:* только текст\n"}` +
    `📤 *Отправок:* ${post.sendCount}\n` +
    `🕒 *Создан:* ${post.createdAt.toISOString().replace("T", " ").slice(0, 16)}\n\n` +
    `*Содержимое:*\n${post.text ? truncate(post.text, 500) : "_(пусто)_"}`;
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("👁 Предпросмотр", `admin:posts:preview:${post.id}`)],
      [Markup.button.callback("📢 Отправить всем", `admin:posts:send:${post.id}`)],
      [
        Markup.button.callback("📅 Запланировать", `admin:posts:schedule:${post.id}`),
        Markup.button.callback("🔁 Повторять", `admin:posts:recurring:${post.id}`),
      ],
      [Markup.button.callback("🗑 Удалить", `admin:posts:delete:${post.id}`)],
      [Markup.button.callback("🔙 Назад", "admin:posts")],
    ]),
  });
});

bot.action(/^admin:posts:schedule:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  setOwnerMode(ctx.from!.id, { mode: "schedule_post_time", postId: id });
  await ctx.editMessageText(
    `📅 *Запланировать отправку поста* «${post.title}»\n\n` +
      "Отправьте время одним сообщением.\n\n" +
      "*Примеры:*\n" +
      "• `30` — через 30 минут\n" +
      "• `2ч` — через 2 часа\n" +
      "• `1д` — через 1 день\n" +
      "• `15:30` — сегодня в 15:30 МСК\n" +
      "• `25.04.2026 15:30` — на конкретную дату\n\n" +
      "Или /cancel для отмены.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", `admin:posts:open:${id}`)]]),
    },
  );
});

bot.action(/^admin:posts:recurring:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  await ctx.editMessageText(
    `🔁 *Повторяющаяся отправка поста* «${post.title}»\n\nВыберите частоту:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📅 Ежедневно", `admin:posts:recurring:${id}:daily`)],
        [Markup.button.callback("📆 Еженедельно", `admin:posts:recurring:${id}:weekly`)],
        [Markup.button.callback("🔙 Назад", `admin:posts:open:${id}`)],
      ]),
    },
  );
});

bot.action(/^admin:posts:recurring:(\d+):daily$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  setOwnerMode(ctx.from!.id, { mode: "recurring_post_time", postId: id, kind: "daily" });
  await ctx.editMessageText(
    "🕒 Отправьте время в формате `HH:MM` по МСК (например `10:00`). Или /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", `admin:posts:open:${id}`)]]),
    },
  );
});

bot.action(/^admin:posts:recurring:(\d+):weekly$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let dow = 0; dow < 7; dow++) {
    buttons.push([
      Markup.button.callback(
        `📆 ${DAY_LABELS_FULL[dow]}`,
        `admin:posts:recurring:${id}:weekly:${dow}`,
      ),
    ]);
  }
  buttons.push([Markup.button.callback("🔙 Назад", `admin:posts:recurring:${id}`)]);
  await ctx.editMessageText("📆 Выберите день недели:", {
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^admin:posts:recurring:(\d+):weekly:(\d)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const dow = parseInt(ctx.match[2], 10);
  setOwnerMode(ctx.from!.id, {
    mode: "recurring_post_time",
    postId: id,
    kind: "weekly",
    dayOfWeek: dow,
  });
  await ctx.editMessageText(
    `🕒 Каждый ${DAY_LABELS_FULL[dow]} в...?\n\nОтправьте время в формате \`HH:MM\` (МСК). Или /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", `admin:posts:open:${id}`)]]),
    },
  );
});

bot.action(/^admin:posts:preview:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Отправляю предпросмотр..."); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  try {
    if (post.photoFileId) {
      await ctx.replyWithPhoto(post.photoFileId, {
        caption: post.text ?? undefined,
        parse_mode: "Markdown",
      });
    } else if (post.text) {
      await ctx.reply(post.text, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`*${post.title}*`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    logger.warn({ err, id }, "Preview send failed");
    await ctx.reply("⚠️ Не удалось отправить предпросмотр (проверьте Markdown).");
  }
});

bot.action(/^admin:posts:send:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  await ctx.editMessageText(
    `📢 Отправить пост *${post.title}* всем ${knownUsers.size} пользователям?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да, отправить", `admin:posts:send:yes:${post.id}`),
          Markup.button.callback("❌ Отмена", `admin:posts:open:${post.id}`),
        ],
      ]),
    },
  );
});

bot.action(/^admin:posts:send:yes:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Запускаю..."); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  await ctx.editMessageText(`📢 Рассылка поста *${post.title}* запущена...`, {
    parse_mode: "Markdown",
  });
  const result = await broadcastPost(post);
  await ctx.reply(
    `✅ Готово.\n📤 Попыток: *${result.attempted}*\n✅ Доставлено: *${result.delivered}*\n❌ Не доставлено: *${result.failed}*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К постам", "admin:posts")]]),
    },
  );
});

bot.action(/^admin:posts:delete:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  const post = await getPost(id);
  if (!post) return;
  await ctx.editMessageText(`🗑 Удалить пост *${post.title}*?`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Да", `admin:posts:delete:yes:${post.id}`),
        Markup.button.callback("❌ Отмена", `admin:posts:open:${post.id}`),
      ],
    ]),
  });
});

bot.action(/^admin:posts:delete:yes:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Удаляю..."); } catch { /* ignore */ }
  const id = parseInt(ctx.match[1], 10);
  await deletePost(id);
  await showPostsMenu(ctx, true);
});

bot.action("admin:broadcast", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  const pending = await listPendingBroadcasts();
  const recurring = await listRecurringBroadcasts();
  const activeRec = recurring.filter((r) => r.active).length;
  await ctx.editMessageText(
    "📢 *Рассылка*\n\n" +
      `👥 Получателей: *${knownUsers.size}*\n` +
      `📅 Запланировано: *${pending.length}*\n` +
      `🔁 Повторяющихся (активных): *${activeRec}*\n\nВыберите действие:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚡ Отправить сейчас", "admin:broadcast:now")],
        [
          Markup.button.callback("📅 Запланировать", "admin:broadcast:schedule"),
          Markup.button.callback("🔁 Повторяющиеся", "admin:broadcast:recurring"),
        ],
        [
          Markup.button.callback("📋 Список", "admin:broadcast:list"),
          Markup.button.callback("🔙 Назад", "admin:main"),
        ],
      ]),
    },
  );
});

bot.action("admin:broadcast:now", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "broadcast" });
  await ctx.editMessageText(
    `⚡ *Отправить сейчас*\n\nОтправьте текст сообщения для немедленной рассылки (поддерживается Markdown).\n\nПолучателей: *${knownUsers.size}*\n\nИли нажмите Отмена / отправьте /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast")]]),
    },
  );
});

bot.action("admin:broadcast:schedule", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "schedule_time" });
  await ctx.editMessageText(
    "📅 *Запланировать рассылку*\n\n" +
      "Когда отправить? Поддерживаемые форматы (московское время):\n" +
      "• `30` — через 30 минут\n" +
      "• `2ч` или `2h` — через 2 часа\n" +
      "• `1д` или `1d` — через 1 день\n" +
      "• `15:30` — сегодня в 15:30 (или завтра, если время уже прошло)\n" +
      "• `25.04.2026 15:30` — конкретная дата и время\n\n" +
      "Отправьте время или /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast")]]),
    },
  );
});

bot.action("admin:broadcast:list", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await renderScheduledList(ctx);
});

bot.action(/^admin:broadcast:cancel:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const id = parseInt(m[1], 10);
  try { await ctx.answerCbQuery("Отменяю..."); } catch { /* ignore */ }
  await cancelScheduledBroadcast(id);
  await renderScheduledList(ctx);
});

// ===== Recurring broadcasts =====

async function renderRecurringList(ctx: Context): Promise<void> {
  const items = await listRecurringBroadcasts();
  if (items.length === 0) {
    await ctx.editMessageText(
      "🔁 *Повторяющиеся рассылки*\n\n_Список пуст_\n\nДобавьте первую — например, ежедневное напоминание в 10:00 МСК.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("➕ Добавить", "admin:broadcast:recurring:add")],
          [Markup.button.callback("🔙 Назад", "admin:broadcast")],
        ]),
      },
    );
    return;
  }
  const lines = items.map((r) => {
    const typeIcon = r.postId ? "🖼" : "💬";
    const preview = r.message.length > 40 ? r.message.slice(0, 40) + "…" : r.message;
    const cleanPreview = preview.replace(/[*_`\[\]]/g, " ");
    const status = r.active ? "✅" : "⏸";
    const next = r.active ? `\n  ⏭ Следующая: ${formatMoscow(r.nextFireAt)} МСК` : "";
    return `${status} ${typeIcon} *#${r.id}* — ${describeRecurring(r)}${next}\n  📨 Отправлено: ${r.totalSent}\n  _${cleanPreview}_`;
  });
  const buttons = items.slice(0, 8).map((r) => [
    Markup.button.callback(
      r.active ? `⏸ #${r.id}` : `▶️ #${r.id}`,
      `admin:broadcast:recurring:toggle:${r.id}`,
    ),
    Markup.button.callback(`🗑 #${r.id}`, `admin:broadcast:recurring:delete:${r.id}`),
  ]);
  buttons.push([Markup.button.callback("➕ Добавить", "admin:broadcast:recurring:add")]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:broadcast")]);
  await ctx.editMessageText(
    "🔁 *Повторяющиеся рассылки*\n\n" + lines.join("\n\n"),
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
}

bot.action("admin:broadcast:recurring", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  await renderRecurringList(ctx);
});

bot.action("admin:broadcast:recurring:add", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText(
    "🔁 *Новая повторяющаяся рассылка*\n\nКак часто отправлять?",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📅 Ежедневно", "admin:broadcast:recurring:add:daily")],
        [Markup.button.callback("📆 Еженедельно", "admin:broadcast:recurring:add:weekly")],
        [Markup.button.callback("🔙 Назад", "admin:broadcast:recurring")],
      ]),
    },
  );
});

bot.action("admin:broadcast:recurring:add:daily", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "recurring_time", kind: "daily" });
  await ctx.editMessageText(
    "📅 *Ежедневная рассылка*\n\nВ какое время по МСК отправлять?\nФормат: `HH:MM` (например, `10:00` или `21:30`).\n\nИли /cancel.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast:recurring")]]),
    },
  );
});

bot.action("admin:broadcast:recurring:add:weekly", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < DAY_PICKER_ORDER.length; i += 2) {
    const row = [DAY_PICKER_ORDER[i]];
    if (i + 1 < DAY_PICKER_ORDER.length) row.push(DAY_PICKER_ORDER[i + 1]);
    buttons.push(
      row.map((dow) =>
        Markup.button.callback(
          DAY_LABELS_FULL[dow],
          `admin:broadcast:recurring:add:weekly:${dow}`,
        ),
      ),
    );
  }
  buttons.push([Markup.button.callback("🔙 Назад", "admin:broadcast:recurring:add")]);
  await ctx.editMessageText(
    "📆 *Еженедельная рассылка*\n\nВ какой день недели отправлять?",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
});

bot.action(/^admin:broadcast:recurring:add:weekly:(\d)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const dow = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  setOwnerMode(ctx.from!.id, { mode: "recurring_time", kind: "weekly", dayOfWeek: dow });
  await ctx.editMessageText(
    `📆 *${DAY_LABELS_FULL[dow]}*\n\nВ какое время по МСК отправлять?\nФормат: \`HH:MM\` (например, \`10:00\` или \`21:30\`).\n\nИли /cancel.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast:recurring")]]),
    },
  );
});

bot.action(/^admin:broadcast:recurring:toggle:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const id = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  const items = await listRecurringBroadcasts();
  const row = items.find((r) => r.id === id);
  if (!row) {
    await renderRecurringList(ctx);
    return;
  }
  const nowActive = !row.active;
  await setRecurringActive(id, nowActive);
  if (nowActive) {
    const nextFireAt = computeNextRecurringFire(
      row.kind as "daily" | "weekly",
      row.hour,
      row.minute,
      row.dayOfWeek,
    );
    await db
      .update(recurringBroadcastsTable)
      .set({ nextFireAt })
      .where(eq(recurringBroadcastsTable.id, id));
  }
  await renderRecurringList(ctx);
});

bot.action(/^admin:broadcast:recurring:delete:(\d+)$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const id = parseInt(m[1], 10);
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText(`🗑 Удалить повторяющуюся рассылку *#${id}*?`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Да", `admin:broadcast:recurring:delete:${id}:yes`),
        Markup.button.callback("❌ Нет", "admin:broadcast:recurring"),
      ],
    ]),
  });
});

bot.action(/^admin:broadcast:recurring:delete:(\d+):yes$/, async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  const m = (ctx as Context & { match: RegExpExecArray }).match;
  const id = parseInt(m[1], 10);
  try { await ctx.answerCbQuery("Удалено"); } catch { /* ignore */ }
  await deleteRecurringBroadcast(id);
  await renderRecurringList(ctx);
});

bot.action("admin:users", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText(
    "👥 *Пользователи*\n\n" +
      `Всего известных пользователей: *${knownUsers.size}*\n\n` +
      "Это все, кто хотя бы раз нажимал /start или /links — они получат рассылку.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📢 Сделать рассылку", "admin:broadcast")],
        [Markup.button.callback("🔙 Назад", "admin:main")],
      ]),
    },
  );
});

bot.action("admin:warnings", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  let total = 0;
  let userCount = 0;
  const lines: string[] = [];
  for (const [chatId, perChat] of warnings.entries()) {
    for (const [userId, count] of perChat.entries()) {
      total += count;
      if (count > 0) {
        userCount += 1;
        lines.push(`  • чат \`${chatId}\`, юзер \`${userId}\` — *${count}/3*`);
      }
    }
  }
  const list = lines.length ? lines.slice(0, 20).join("\n") : "  _нет активных_";
  await ctx.editMessageText(
    "⚠️ *Активные предупреждения*\n\n" +
      `📋 Сумма очков: *${total}*\n` +
      `👤 Пользователей: *${userCount}*\n\n` +
      "*Список:*\n" + list +
      "\n\n_Чтобы выдать предупреждение — ответьте на сообщение пользователя в группе командой /warn._",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:main")]]),
    },
  );
});

bot.action("admin:help", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await ctx.editMessageText(
    "ℹ️ *Команды владельца*\n\n" +
      "🔗 *Общие:*\n" +
      "/start — Приветствие и список\n" +
      "/links — Список предложений\n" +
      "/help — Помощь\n" +
      "/myid — Ваш Telegram ID\n" +
      "/admin или /menu — Это меню\n" +
      "/cancel — Отменить ввод\n\n" +
      "👮 *Модерация (ответом на сообщение):*\n" +
      "/ban — Забанить\n" +
      "/kick — Кикнуть\n" +
      "/mute — Замутить\n" +
      "/unmute — Размутить\n" +
      "/warn — Предупредить (3 → авто-бан)\n" +
      "/warns — Узнать количество предупреждений\n\n" +
      "🔒 *Управление ссылками:*\n" +
      "/addlink `Название | https://...`\n" +
      "/removelink `<номер>`\n" +
      "/stats — Статистика\n\n" +
      "⚙️ *Система:*\n" +
      "/transport — Текущий режим (polling/webhook) и здоровье вебхука",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Назад", "admin:main")]]),
    },
  );
});

// ===== Transport diagnostics =====
//
// Shows whether the bot is currently using long-polling or a Telegram webhook,
// along with webhook health pulled from Telegram (pending updates, last error,
// IP, max connections). Owner-only.

function escapeMd(s: string): string {
  return s.replace(/[_*`\[\]]/g, (c) => `\\${c}`);
}

function formatUtcOrDash(secondsSinceEpoch: number | undefined): string {
  if (!secondsSinceEpoch) return "—";
  return new Date(secondsSinceEpoch * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function buildTransportReport(): Promise<string> {
  const mode = resolveBotMode();
  const lines: string[] = [];
  lines.push("🔌 *Транспорт*");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("");
  lines.push(`Активный режим: *${mode === "webhook" ? "Webhook" : "Long polling"}*`);
  lines.push("");

  let info: Awaited<ReturnType<typeof bot.telegram.getWebhookInfo>> | null = null;
  try {
    info = await bot.telegram.getWebhookInfo();
  } catch (err) {
    lines.push("⚠️ Не удалось получить webhook info от Telegram.");
    lines.push("`" + escapeMd(String((err as Error)?.message ?? err)) + "`");
    return lines.join("\n");
  }

  const registeredUrl = info.url && info.url.length > 0 ? info.url : null;

  if (mode === "webhook") {
    if (!registeredUrl) {
      lines.push("⚠️ Режим webhook включён, но Telegram сообщает, что URL не зарегистрирован.");
    } else {
      lines.push("URL: `" + escapeMd(registeredUrl) + "`");
    }
  } else {
    lines.push(
      registeredUrl
        ? "ℹ️ Telegram всё ещё помнит вебхук: `" + escapeMd(registeredUrl) + "`. " +
            "Он будет очищен при следующем запуске."
        : "Webhook на стороне Telegram не зарегистрирован — это норма для polling.",
    );
  }

  lines.push("");
  lines.push("📨 Ожидает обработки: *" + (info.pending_update_count ?? 0) + "*");
  if (typeof info.max_connections === "number") {
    lines.push("🔗 Max connections: " + info.max_connections);
  }
  if (info.ip_address) {
    lines.push("🌐 IP: `" + escapeMd(info.ip_address) + "`");
  }
  if (info.has_custom_certificate) {
    lines.push("🔐 Self-signed cert: да");
  }

  if (info.last_error_date) {
    lines.push("");
    lines.push("❌ *Последняя ошибка:*");
    lines.push("При: " + formatUtcOrDash(info.last_error_date));
    if (info.last_error_message) {
      lines.push("`" + escapeMd(info.last_error_message) + "`");
    }
  } else {
    lines.push("");
    lines.push("✅ Ошибок Telegram не зафиксировано.");
  }

  if (info.last_synchronization_error_date) {
    lines.push("");
    lines.push(
      "⚠️ Последняя синхронизация: " + formatUtcOrDash(info.last_synchronization_error_date),
    );
  }

  return lines.join("\n");
}

bot.command("transport", async (ctx) => {
  if (!isOwner(ctx)) return;
  const text = await buildTransportReport();
  await ctx.reply(text, { parse_mode: "Markdown" });
});

bot.action("admin:backup", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Готовлю бэкап…"); } catch { /* ignore */ }
  try {
    await sendBackupToOwner("💾 Резервная копия базы данных");
    try {
      await ctx.editMessageText(
        "✅ *Бэкап отправлен*\n\n" +
          "Файл `bot-backup-*.db` пришёл вам в личные сообщения.\n" +
          "Сохраните его перед переездом между хостами — потом восстановите " +
          "командой /restore (ответом на это же сообщение).",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("💾 Ещё раз", "admin:backup")],
            [Markup.button.callback("🔙 Назад", "admin:main")],
          ]),
        },
      );
    } catch {
      /* ignore — main message already edited or replaced */
    }
  } catch (err) {
    logger.error({ err }, "Failed to send backup from admin menu");
    const msg = String((err as Error)?.message ?? err);
    try {
      await ctx.editMessageText(
        "❌ *Не удалось создать бэкап.*\n`" + escapeMd(msg) + "`",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔁 Повторить", "admin:backup")],
            [Markup.button.callback("🔙 Назад", "admin:main")],
          ]),
        },
      );
    } catch {
      /* ignore */
    }
  }
});

function buildTransportKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Обновить", "admin:transport")],
    [Markup.button.callback("🧹 Сбросить webhook", "admin:transport:clear")],
    [Markup.button.callback("🔙 Назад", "admin:main")],
  ]);
}

async function renderTransportScreen(ctx: Context, banner?: string): Promise<void> {
  const report = await buildTransportReport();
  const text = banner ? `${banner}\n\n${report}` : report;
  const opts = { parse_mode: "Markdown" as const, ...buildTransportKeyboard() };
  try {
    await ctx.editMessageText(text, opts);
  } catch {
    await ctx.reply(text, opts);
  }
}

bot.action("admin:transport", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
  await renderTransportScreen(ctx);
});

bot.action("admin:transport:clear", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try {
    await ctx.answerCbQuery("Подтвердите сброс…");
  } catch {
    /* ignore */
  }
  try {
    await ctx.editMessageText(
      "🧹 *Сбросить webhook?*\n\n" +
        "Telegram забудет зарегистрированный URL и очередь ожидающих апдейтов.\n" +
        "Используйте при переезде между хостами или если бот завис на чужом URL.\n\n" +
        "Сам бот при этом не остановится. Если активен режим polling — он продолжит работу.\n" +
        "Если активен режим webhook — бот перестанет получать сообщения, пока не " +
        "перезапустится и не зарегистрирует URL заново.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Сбросить", "admin:transport:clear:yes"),
            Markup.button.callback("✖️ Отмена", "admin:transport"),
          ],
        ]),
      },
    );
  } catch {
    /* ignore */
  }
});

bot.action("admin:transport:clear:yes", async (ctx) => {
  if (!(await ownerGate(ctx))) return;
  try { await ctx.answerCbQuery("Сбрасываю…"); } catch { /* ignore */ }
  let banner: string;
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    logger.info("Webhook cleared via admin transport screen");
    banner = "✅ *Webhook очищен.* Очередь ожидающих апдейтов сброшена.";
  } catch (err) {
    logger.error({ err }, "Failed to clear webhook via admin");
    const msg = String((err as Error)?.message ?? err);
    banner = "❌ *Не удалось сбросить webhook.*\n`" + escapeMd(msg) + "`";
  }
  await renderTransportScreen(ctx, banner);
});

// Owner text input handler — must be the LAST text handler so commands win first
bot.on(message("text"), async (ctx, next) => {
  if (!isOwner(ctx)) return next();
  const state = getOwnerMode(ctx.from!.id);
  if (state.mode === "idle") return next();
  const text = ctx.message.text;
  if (text.startsWith("/")) return next();

  if (state.mode === "addlink") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const parts = text.split("|");
    if (parts.length < 2) {
      await ctx.reply(
        "⚠️ Неверный формат. Используйте: `Название | https://example.com`",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("🔙 В меню", "admin:main")]]),
        },
      );
      return;
    }
    const title = parts[0].trim();
    const url = parts.slice(1).join("|").trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      await ctx.reply("⚠️ URL должен начинаться с http:// или https://");
      return;
    }
    const added = await adminAddLink(title, url);
    await ctx.reply(
      `✅ Добавлено: *${added.title}* (#${added.index + 1})`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 В меню", "admin:main")]]),
      },
    );
    return;
  }

  if (state.mode === "broadcast") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    await ctx.reply(`📢 Начинаю рассылку для ${knownUsers.size} пользователей...`);
    const result = await adminBroadcast(text);
    await ctx.reply(
      "✅ Рассылка завершена.\n\n" +
        `📤 Отправлено попыток: *${result.attempted}*\n` +
        `✅ Доставлено: *${result.delivered}*\n` +
        `❌ Не доставлено: *${result.failed}*`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 В меню", "admin:main")]]),
      },
    );
    return;
  }

  if (state.mode === "schedule_time") {
    const parsed = parseScheduleTime(text);
    if (!parsed) {
      await ctx.reply(
        "⚠️ Не удалось распознать время. Примеры: `30`, `2ч`, `1д`, `15:30`, `25.04.2026 15:30`",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast")]]),
        },
      );
      return;
    }
    setOwnerMode(ctx.from!.id, { mode: "schedule_message", scheduledAt: parsed });
    await ctx.reply(
      `🕒 Время: *${formatMoscow(parsed)}* (МСК)\n\nТеперь отправьте текст сообщения для рассылки (Markdown поддерживается). Или /cancel.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast")]]),
      },
    );
    return;
  }

  if (state.mode === "schedule_message") {
    const when = state.scheduledAt;
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const id = await scheduleBroadcast(text, when);
    await ctx.reply(
      `✅ Рассылка #${id} запланирована на *${formatMoscow(when)}* (МСК).\n\nПолучателей на момент отправки: будет рассчитано в момент запуска.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📋 Список", "admin:broadcast:list")],
          [Markup.button.callback("🔙 В меню", "admin:main")],
        ]),
      },
    );
    return;
  }

  if (state.mode === "schedule_post_time") {
    const parsed = parseScheduleTime(text);
    if (!parsed) {
      await ctx.reply(
        "⚠️ Не удалось распознать время. Примеры: `30`, `2ч`, `1д`, `15:30`, `25.04.2026 15:30`",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("❌ Отмена", `admin:posts:open:${state.postId}`)],
          ]),
        },
      );
      return;
    }
    const post = await getPost(state.postId);
    if (!post) {
      setOwnerMode(ctx.from!.id, { mode: "idle" });
      await ctx.reply("❌ Пост не найден.");
      return;
    }
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const id = await scheduleBroadcast(`[пост #${post.id}] ${post.title}`, parsed, post.id);
    await ctx.reply(
      `✅ Пост *${post.title}* запланирован к отправке #${id} на *${formatMoscow(parsed)}* (МСК).`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📋 Список рассылок", "admin:broadcast:list")],
          [Markup.button.callback("🔙 К посту", `admin:posts:open:${post.id}`)],
        ]),
      },
    );
    return;
  }

  if (state.mode === "recurring_post_time") {
    const parsed = parseHHMM(text);
    if (!parsed) {
      await ctx.reply(
        "⚠️ Не понял формат. Отправьте время как `HH:MM`, например `10:00` или `21:30`. Или /cancel.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const post = await getPost(state.postId);
    if (!post) {
      setOwnerMode(ctx.from!.id, { mode: "idle" });
      await ctx.reply("❌ Пост не найден.");
      return;
    }
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const id = await createRecurringBroadcast({
      message: `[пост #${post.id}] ${post.title}`,
      kind: state.kind,
      hour: parsed.hour,
      minute: parsed.minute,
      dayOfWeek: state.dayOfWeek,
      postId: post.id,
    });
    const desc = describeRecurring({
      kind: state.kind,
      hour: parsed.hour,
      minute: parsed.minute,
      dayOfWeek: state.dayOfWeek ?? null,
    });
    const nextFireAt = computeNextRecurringFire(
      state.kind,
      parsed.hour,
      parsed.minute,
      state.dayOfWeek ?? null,
    );
    await ctx.reply(
      `✅ Повторяющаяся рассылка поста *${post.title}* #${id} создана.\n\n${desc}\n⏭ Первая отправка: *${formatMoscow(nextFireAt)}* МСК`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📋 Повторяющиеся", "admin:broadcast:recurring")],
          [Markup.button.callback("🔙 К посту", `admin:posts:open:${post.id}`)],
        ]),
      },
    );
    return;
  }

  if (state.mode === "recurring_time") {
    const parsed = parseHHMM(text);
    if (!parsed) {
      await ctx.reply(
        "⚠️ Не понял формат. Отправьте время как `HH:MM`, например `10:00` или `21:30`. Или /cancel.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const dayLabel =
      state.kind === "weekly"
        ? `${DAY_LABELS_FULL[state.dayOfWeek ?? 0]}, `
        : "Ежедневно, ";
    const pad = (n: number) => String(n).padStart(2, "0");
    setOwnerMode(ctx.from!.id, {
      mode: "recurring_message",
      kind: state.kind,
      hour: parsed.hour,
      minute: parsed.minute,
      dayOfWeek: state.dayOfWeek,
    });
    await ctx.reply(
      `🕒 ${dayLabel}${pad(parsed.hour)}:${pad(parsed.minute)} МСК.\n\nТеперь отправьте текст сообщения для рассылки (Markdown поддерживается). Или /cancel.`,
      {
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:broadcast:recurring")]]),
      },
    );
    return;
  }

  if (state.mode === "recurring_message") {
    const trimmed = text.trim();
    if (!trimmed) {
      await ctx.reply("⚠️ Сообщение не может быть пустым.");
      return;
    }
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const id = await createRecurringBroadcast({
      message: trimmed,
      kind: state.kind,
      hour: state.hour,
      minute: state.minute,
      dayOfWeek: state.dayOfWeek,
    });
    const desc = describeRecurring({
      kind: state.kind,
      hour: state.hour,
      minute: state.minute,
      dayOfWeek: state.dayOfWeek ?? null,
    });
    const nextFireAt = computeNextRecurringFire(
      state.kind,
      state.hour,
      state.minute,
      state.dayOfWeek ?? null,
    );
    await ctx.reply(
      `✅ Повторяющаяся рассылка #${id} создана.\n\n${desc}\n⏭ Первая отправка: *${formatMoscow(nextFireAt)}* МСК`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📋 Список", "admin:broadcast:recurring")],
          [Markup.button.callback("🔙 В меню", "admin:main")],
        ]),
      },
    );
    return;
  }

  if (state.mode === "rename_link") {
    const idx = state.index;
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const newTitle = text.trim();
    if (!newTitle || newTitle.length > 64) {
      await ctx.reply("⚠️ Название должно быть от 1 до 64 символов.", {
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К ссылкам", "admin:links")]]),
      });
      return;
    }
    const updated = await adminUpdateLink(idx, { title: newTitle });
    if (!updated) {
      await ctx.reply("❌ Ссылка не найдена.");
      return;
    }
    await ctx.reply(`✅ Ссылка #${idx + 1} переименована в *${updated.title}*.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К ссылкам", "admin:links")]]),
    });
    return;
  }

  if (state.mode === "edit_link_url") {
    const idx = state.index;
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const newUrl = text.trim();
    if (!newUrl.startsWith("http://") && !newUrl.startsWith("https://")) {
      await ctx.reply("⚠️ URL должен начинаться с http:// или https://", {
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К ссылкам", "admin:links")]]),
      });
      return;
    }
    const updated = await adminUpdateLink(idx, { url: newUrl });
    if (!updated) {
      await ctx.reply("❌ Ссылка не найдена.");
      return;
    }
    await ctx.reply(
      `✅ URL ссылки #${idx + 1} (*${updated.title}*) обновлён:\n${updated.url}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К ссылкам", "admin:links")]]),
      },
    );
    return;
  }

  if (state.mode === "edit_welcome") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const newText = text.trim();
    if (!newText || newText.length > 1024) {
      await ctx.reply("⚠️ Приветствие должно быть от 1 до 1024 символов.");
      return;
    }
    settings.welcomeCaption = newText;
    await persistSetting("welcomeCaption", newText);
    await ctx.reply("✅ Приветствие обновлено. Вот как оно теперь выглядит:", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К настройкам", "admin:settings")]]),
    });
    try {
      await ctx.replyWithPhoto(Input.fromLocalFile(getWelcomeImagePath()), {
        caption: settings.welcomeCaption,
        parse_mode: "Markdown",
        ...buildStartKeyboard(),
      });
    } catch (err) {
      logger.warn({ err }, "Failed to send welcome preview");
    }
    return;
  }

  if (state.mode === "edit_faq") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    let newText = text.trim();
    if (newText.toLowerCase() === "default") {
      newText = DEFAULT_FAQ_TEXT;
    }
    if (!newText || newText.length > 3500) {
      await ctx.reply("⚠️ FAQ должен быть от 1 до 3500 символов.");
      return;
    }
    settings.faqText = newText;
    await persistSetting("faqText", newText);
    await ctx.reply("✅ FAQ обновлён. Вот как он теперь выглядит:", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К настройкам", "admin:settings")]]),
    });
    try {
      await ctx.reply(settings.faqText, { parse_mode: "Markdown" });
    } catch (err) {
      logger.warn({ err }, "Failed to send FAQ preview");
      await ctx.reply(
        "⚠️ Текст сохранён, но не получилось показать предпросмотр — проверьте Markdown-разметку.",
      );
    }
    return;
  }

  if (state.mode === "edit_description") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const newText = text.trim();
    if (!newText || newText.length > 512) {
      await ctx.reply("⚠️ Описание должно быть от 1 до 512 символов.");
      return;
    }
    settings.botDescription = newText;
    await persistSetting("botDescription", newText);
    try {
      await bot.telegram.setMyDescription(newText);
      await ctx.reply(
        "✅ Описание бота обновлено.\n\n_Telegram может кешировать это значение несколько минут — изменение в чате с ботом появится не сразу._",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К настройкам", "admin:settings")]]),
        },
      );
    } catch (err) {
      logger.error({ err }, "Failed to apply bot description");
      await ctx.reply("⚠️ Не удалось применить описание в Telegram. Сохранил локально, попробую позже.");
    }
    return;
  }

  if (state.mode === "edit_promote_threshold") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const n = parseInt(text.trim(), 10);
    if (Number.isNaN(n) || n < 5 || n > 1000) {
      await ctx.reply("⚠️ Число должно быть от 5 до 1000.", {
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К настройкам", "admin:settings")]]),
      });
      return;
    }
    settings.autoPromoteThreshold = n;
    await persistSetting("autoPromoteThreshold", String(n));
    await ctx.reply(`✅ Порог авто-продвижения: *${n}* кликов лидерства.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 К настройкам", "admin:settings")]]),
    });
    return;
  }

  if (state.mode === "post_title") {
    const title = text.trim();
    if (!title || title.length > 64) {
      await ctx.reply("⚠️ Заголовок должен быть от 1 до 64 символов.");
      return;
    }
    setOwnerMode(ctx.from!.id, { mode: "post_content", title });
    await ctx.reply(
      `✅ Заголовок: *${title}*\n\nШаг 2/2: отправьте *содержимое поста* — текст, фото или фото с подписью. Или /cancel.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "admin:posts")]]),
      },
    );
    return;
  }

  if (state.mode === "post_content") {
    const title = state.title;
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const post = await createPost(title, text, null);
    if (!post) {
      await ctx.reply("❌ Не удалось сохранить пост.");
      return;
    }
    await ctx.reply(
      `✅ Пост *${post.title}* (#${post.id}) создан как текстовый.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📝 К постам", "admin:posts")],
          [Markup.button.callback("📢 Отправить всем", `admin:posts:send:${post.id}`)],
        ]),
      },
    );
    return;
  }

  return next();
});

bot.on(message("photo"), async (ctx, next) => {
  if (!isOwner(ctx)) return next();
  const state = getOwnerMode(ctx.from!.id);

  if (state.mode === "upload_welcome_image") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    try {
      const link = await ctx.telegram.getFileLink(largest.file_id);
      const res = await fetch(link.toString());
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(path.dirname(CUSTOM_WELCOME_IMAGE), { recursive: true });
      writeFileSync(CUSTOM_WELCOME_IMAGE, buf);
      logger.info({ bytes: buf.length }, "Custom welcome image saved");
      await ctx.reply("✅ Картинка обновлена. Вот превью стартового экрана:");
      await sendStartScreen(ctx);
    } catch (err) {
      logger.error({ err }, "Failed to save custom welcome image");
      await ctx.reply(
        "⚠️ Не удалось сохранить картинку. Попробуйте ещё раз или вернитесь в настройки.",
      );
    }
    return;
  }

  if (state.mode === "upload_prestart_image") {
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    settings.preStartImageFileId = largest.file_id;
    await persistSetting("preStartImageFileId", largest.file_id);
    logger.info({ fileId: largest.file_id }, "Pre-start image saved");
    await ctx.reply("✅ Картинка стартового меню обновлена. Превью:");
    await sendStartScreen(ctx);
    return;
  }

  if (state.mode === "set_link_image") {
    const idx = state.index;
    setOwnerMode(ctx.from!.id, { mode: "idle" });
    if (idx < 0 || idx >= linkList.length) {
      await ctx.reply("⚠️ Ссылка не найдена.");
      return;
    }
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    linkList[idx] = { ...linkList[idx], imageFileId: largest.file_id };
    await rewriteAllLinks();
    logger.info({ idx, fileId: largest.file_id }, "Link image saved");
    await ctx.reply(
      `✅ Картинка для ссылки *${linkList[idx].title}* сохранена. Превью:`,
      { parse_mode: "Markdown" },
    );
    try {
      await ctx.replyWithPhoto(largest.file_id, {
        caption: `*${idx + 1}. ${linkList[idx].title}*`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.url("🚀 Перейти", linkList[idx].url)],
          [Markup.button.callback("🔙 К ссылкам", "admin:links")],
        ]),
      });
    } catch { /* ignore */ }
    return;
  }

  if (state.mode !== "post_content") return next();
  const title = state.title;
  setOwnerMode(ctx.from!.id, { mode: "idle" });
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const caption = ctx.message.caption ?? null;
  const post = await createPost(title, caption, largest.file_id);
  if (!post) {
    await ctx.reply("❌ Не удалось сохранить пост.");
    return;
  }
  await ctx.reply(
    `✅ Пост *${post.title}* (#${post.id}) создан с фото${caption ? " и подписью" : ""}.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📝 К постам", "admin:posts")],
        [Markup.button.callback("📢 Отправить всем", `admin:posts:send:${post.id}`)],
      ]),
    },
  );
});

bot.catch((err, ctx) => {
  logger.error({ err, updateType: ctx.updateType }, "Bot error");
});

async function configureBotProfile(): Promise<void> {
  try {
    await bot.telegram.setMyDescription(settings.botDescription);
    await bot.telegram.setMyShortDescription(
      "Онлайн займы, Деньги Срочно, Микрозаймы, Займы онлайн, Деньги быстро, Деньги на карту, Взаймы онлайн",
    );
    logger.info("Bot description updated");
  } catch (err) {
    logger.error({ err }, "Failed to update bot description");
  }
}

// ===== Scheduled broadcasts =====

const MOSCOW_OFFSET_MIN = 3 * 60;

function nowInMoscow(): Date {
  const utcMs = Date.now();
  return new Date(utcMs + MOSCOW_OFFSET_MIN * 60_000);
}

function moscowDateToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Construct the Moscow wall-clock as if it were UTC, then shift back by the offset
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(asUtc - MOSCOW_OFFSET_MIN * 60_000);
}

export function formatMoscow(date: Date): string {
  const m = new Date(date.getTime() + MOSCOW_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(m.getUTCDate())}.${pad(m.getUTCMonth() + 1)}.${m.getUTCFullYear()} ${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}`;
}

export function parseScheduleTime(input: string): Date | null {
  const trimmed = input.trim();

  // Plain number → minutes from now
  if (/^\d+$/.test(trimmed)) {
    const minutes = parseInt(trimmed, 10);
    if (minutes > 0 && minutes < 60 * 24 * 365) {
      return new Date(Date.now() + minutes * 60_000);
    }
  }

  // Nh / Nч → hours from now
  let m = trimmed.match(/^(\d+)\s*(?:ч|h)$/i);
  if (m) {
    const hours = parseInt(m[1], 10);
    if (hours > 0 && hours < 24 * 365) return new Date(Date.now() + hours * 3_600_000);
  }

  // Nd / Nд → days from now
  m = trimmed.match(/^(\d+)\s*(?:д|d)$/i);
  if (m) {
    const days = parseInt(m[1], 10);
    if (days > 0 && days < 365) return new Date(Date.now() + days * 86_400_000);
  }

  // HH:MM → today (or tomorrow if already passed) in Moscow time
  m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 24 && minute < 60) {
      const now = nowInMoscow();
      let target = moscowDateToUtc(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        now.getUTCDate(),
        hour,
        minute,
      );
      if (target.getTime() <= Date.now() + 30_000) {
        target = new Date(target.getTime() + 86_400_000);
      }
      return target;
    }
  }

  // DD.MM.YYYY HH:MM → absolute Moscow time
  m = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const minute = parseInt(m[5], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60) {
      const target = moscowDateToUtc(year, month, day, hour, minute);
      if (target.getTime() > Date.now()) return target;
    }
  }

  return null;
}

const DAY_LABELS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];
const DAY_PICKER_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function parseHHMM(input: string): { hour: number; minute: number } | null {
  const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function computeNextRecurringFire(
  kind: "daily" | "weekly",
  hour: number,
  minute: number,
  dayOfWeek: number | null,
  from: Date = new Date(),
): Date {
  const nowMsk = new Date(from.getTime() + MOSCOW_OFFSET_MIN * 60_000);
  let target = moscowDateToUtc(
    nowMsk.getUTCFullYear(),
    nowMsk.getUTCMonth() + 1,
    nowMsk.getUTCDate(),
    hour,
    minute,
  );
  if (kind === "daily") {
    if (target.getTime() <= from.getTime() + 30_000) {
      target = new Date(target.getTime() + 86_400_000);
    }
    return target;
  }
  // weekly
  const targetDow = dayOfWeek ?? 0;
  const targetMsk = new Date(target.getTime() + MOSCOW_OFFSET_MIN * 60_000);
  const todayDow = targetMsk.getUTCDay();
  let diffDays = (targetDow - todayDow + 7) % 7;
  if (diffDays === 0 && target.getTime() <= from.getTime() + 30_000) {
    diffDays = 7;
  }
  return new Date(target.getTime() + diffDays * 86_400_000);
}

export function describeRecurring(row: {
  kind: string;
  hour: number;
  minute: number;
  dayOfWeek: number | null;
}): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(row.hour)}:${pad(row.minute)}`;
  if (row.kind === "weekly") {
    const dow = row.dayOfWeek ?? 0;
    return `Каждый ${DAY_LABELS_FULL[dow]} в ${time} МСК`;
  }
  return `Ежедневно в ${time} МСК`;
}

export async function listRecurringBroadcasts() {
  return db
    .select()
    .from(recurringBroadcastsTable)
    .orderBy(asc(recurringBroadcastsTable.id));
}

export async function createRecurringBroadcast(params: {
  message: string;
  kind: "daily" | "weekly";
  hour: number;
  minute: number;
  dayOfWeek?: number;
  postId?: number | null;
}): Promise<number> {
  const nextFireAt = computeNextRecurringFire(
    params.kind,
    params.hour,
    params.minute,
    params.dayOfWeek ?? null,
  );
  const [row] = await db
    .insert(recurringBroadcastsTable)
    .values({
      message: params.message,
      postId: params.postId ?? null,
      kind: params.kind,
      hour: params.hour,
      minute: params.minute,
      dayOfWeek: params.dayOfWeek ?? null,
      active: true,
      nextFireAt,
    })
    .returning({ id: recurringBroadcastsTable.id });
  logger.info({ id: row.id, kind: params.kind, nextFireAt, postId: params.postId ?? null }, "Recurring broadcast created");
  return row.id;
}

export async function setRecurringActive(id: number, active: boolean): Promise<boolean> {
  const result = await db
    .update(recurringBroadcastsTable)
    .set({ active })
    .where(eq(recurringBroadcastsTable.id, id))
    .returning({ id: recurringBroadcastsTable.id });
  return result.length > 0;
}

export async function deleteRecurringBroadcast(id: number): Promise<boolean> {
  const result = await db
    .delete(recurringBroadcastsTable)
    .where(eq(recurringBroadcastsTable.id, id))
    .returning({ id: recurringBroadcastsTable.id });
  return result.length > 0;
}

export async function scheduleBroadcast(
  message: string,
  scheduledAt: Date,
  postId?: number | null,
): Promise<number> {
  const [row] = await db
    .insert(scheduledBroadcastsTable)
    .values({ message, scheduledAt, status: "pending", postId: postId ?? null })
    .returning({ id: scheduledBroadcastsTable.id });
  logger.info({ id: row.id, scheduledAt, postId: postId ?? null }, "Scheduled broadcast created");
  return row.id;
}

export async function listPendingBroadcasts() {
  return db
    .select()
    .from(scheduledBroadcastsTable)
    .where(eq(scheduledBroadcastsTable.status, "pending"))
    .orderBy(asc(scheduledBroadcastsTable.scheduledAt));
}

export async function listRecentBroadcasts(limit = 10) {
  return db
    .select()
    .from(scheduledBroadcastsTable)
    .orderBy(asc(scheduledBroadcastsTable.scheduledAt))
    .limit(limit);
}

export async function cancelScheduledBroadcast(id: number): Promise<boolean> {
  const result = await db
    .update(scheduledBroadcastsTable)
    .set({ status: "cancelled" })
    .where(and(eq(scheduledBroadcastsTable.id, id), eq(scheduledBroadcastsTable.status, "pending")))
    .returning({ id: scheduledBroadcastsTable.id });
  return result.length > 0;
}

async function renderScheduledList(ctx: Context): Promise<void> {
  const pending = await listPendingBroadcasts();
  if (pending.length === 0) {
    await ctx.editMessageText("📭 Нет запланированных рассылок.", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📅 Запланировать", "admin:broadcast:schedule")],
        [Markup.button.callback("🔙 Назад", "admin:broadcast")],
      ]),
    });
    return;
  }
  const lines = pending.map((b) => {
    const typeIcon = b.postId ? "🖼" : "💬";
    const preview = b.message.length > 40 ? b.message.slice(0, 40) + "…" : b.message;
    return `• ${typeIcon} #${b.id} — *${formatMoscow(b.scheduledAt)}* МСК\n  _${preview.replace(/[*_`\[\]]/g, " ")}_`;
  });
  const buttons = pending.slice(0, 10).map((b) => [
    Markup.button.callback(`❌ Отменить #${b.id}`, `admin:broadcast:cancel:${b.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin:broadcast")]);
  await ctx.editMessageText(
    "📋 *Запланированные рассылки*\n\n" + lines.join("\n\n"),
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
}

let schedulerRunning = false;

async function runDueBroadcasts(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const due = await db
      .select()
      .from(scheduledBroadcastsTable)
      .where(
        and(
          eq(scheduledBroadcastsTable.status, "pending"),
          lte(scheduledBroadcastsTable.scheduledAt, new Date()),
        ),
      );
    for (const job of due) {
      // Claim the job atomically so concurrent runs don't double-send
      const claimed = await db
        .update(scheduledBroadcastsTable)
        .set({ status: "sending" })
        .where(
          and(
            eq(scheduledBroadcastsTable.id, job.id),
            eq(scheduledBroadcastsTable.status, "pending"),
          ),
        )
        .returning({ id: scheduledBroadcastsTable.id });
      if (claimed.length === 0) continue;
      logger.info({ id: job.id, postId: job.postId }, "Running scheduled broadcast");
      try {
        let result: BroadcastResult;
        let label = "сообщения";
        if (job.postId) {
          const post = await getPost(job.postId);
          if (!post) {
            throw new Error(`Post #${job.postId} not found`);
          }
          result = await broadcastPost(post);
          label = `поста *${post.title}*`;
        } else {
          result = await adminBroadcast(job.message);
        }
        await db
          .update(scheduledBroadcastsTable)
          .set({
            status: "sent",
            delivered: result.delivered,
            failed: result.failed,
            sentAt: new Date(),
          })
          .where(eq(scheduledBroadcastsTable.id, job.id));
        try {
          await bot.telegram.sendMessage(
            OWNER_ID,
            `📬 Запланированная рассылка ${label} #${job.id} выполнена.\n\n✅ Доставлено: *${result.delivered}*\n❌ Не доставлено: *${result.failed}*`,
            { parse_mode: "Markdown" },
          );
        } catch (notifyErr) {
          logger.warn({ err: notifyErr }, "Failed to notify owner about scheduled broadcast");
        }
      } catch (err) {
        logger.error({ err, id: job.id }, "Scheduled broadcast failed");
        await db
          .update(scheduledBroadcastsTable)
          .set({ status: "failed", sentAt: new Date() })
          .where(eq(scheduledBroadcastsTable.id, job.id));
      }
    }

    // Recurring broadcasts
    const dueRecurring = await db
      .select()
      .from(recurringBroadcastsTable)
      .where(
        and(
          eq(recurringBroadcastsTable.active, true),
          lte(recurringBroadcastsTable.nextFireAt, new Date()),
        ),
      );
    for (const job of dueRecurring) {
      // Atomically advance nextFireAt to claim — if another worker beat us, the WHERE won't match
      const newNext = computeNextRecurringFire(
        job.kind as "daily" | "weekly",
        job.hour,
        job.minute,
        job.dayOfWeek,
        new Date(job.nextFireAt.getTime() + 60_000),
      );
      const claimed = await db
        .update(recurringBroadcastsTable)
        .set({ nextFireAt: newNext })
        .where(
          and(
            eq(recurringBroadcastsTable.id, job.id),
            eq(recurringBroadcastsTable.nextFireAt, job.nextFireAt),
          ),
        )
        .returning({ id: recurringBroadcastsTable.id });
      if (claimed.length === 0) continue;
      logger.info({ id: job.id, kind: job.kind, postId: job.postId }, "Running recurring broadcast");
      try {
        let result: BroadcastResult;
        let label = "";
        if (job.postId) {
          const post = await getPost(job.postId);
          if (!post) {
            throw new Error(`Post #${job.postId} not found`);
          }
          result = await broadcastPost(post);
          label = ` (пост *${post.title}*)`;
        } else {
          result = await adminBroadcast(job.message);
        }
        await db
          .update(recurringBroadcastsTable)
          .set({
            lastFiredAt: new Date(),
            totalSent: sql`${recurringBroadcastsTable.totalSent} + ${result.delivered}`,
          })
          .where(eq(recurringBroadcastsTable.id, job.id));
        try {
          await bot.telegram.sendMessage(
            OWNER_ID,
            `🔁 Повторяющаяся рассылка${label} #${job.id} выполнена.\n\n${describeRecurring(job)}\n✅ Доставлено: *${result.delivered}*\n❌ Не доставлено: *${result.failed}*\n⏭ Следующая: *${formatMoscow(newNext)}* МСК`,
            { parse_mode: "Markdown" },
          );
        } catch (notifyErr) {
          logger.warn({ err: notifyErr }, "Failed to notify owner about recurring broadcast");
        }
      } catch (err) {
        logger.error({ err, id: job.id }, "Recurring broadcast failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "Scheduler tick failed");
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler(): void {
  setInterval(() => {
    void runDueBroadcasts();
    void runDueAutoBackup();
  }, 30_000);
  // Also run once shortly after startup to flush anything overdue
  setTimeout(() => {
    void runDueBroadcasts();
    void runDueAutoBackup();
  }, 5_000);
  logger.info("Broadcast scheduler started (poll: 30s)");
}

function resolveBotMode(): "webhook" | "polling" {
  const explicit = process.env["BOT_MODE"]?.trim().toLowerCase();
  if (explicit === "webhook" || explicit === "polling") return explicit;
  return process.env["WEBHOOK_URL"]?.trim() ? "webhook" : "polling";
}

function resolveWebhookPath(): string {
  const raw = process.env["WEBHOOK_PATH"]?.trim() || "/api/telegram/webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export interface WebhookHandle {
  path: string;
  middleware: ReturnType<Telegraf["webhookCallback"]>;
}

let webhookHandle: WebhookHandle | null = null;

export function getWebhookHandle(): WebhookHandle | null {
  return webhookHandle;
}

export async function startBot(): Promise<void> {
  await loadStateFromDb();

  const mode = resolveBotMode();

  if (mode === "webhook") {
    const baseUrl = process.env["WEBHOOK_URL"]?.trim();
    if (!baseUrl) {
      throw new Error(
        "BOT_MODE=webhook requires WEBHOOK_URL (e.g. https://my-bot.example.com).",
      );
    }
    const path = resolveWebhookPath();
    const secret = process.env["WEBHOOK_SECRET"]?.trim() || undefined;
    const fullUrl = baseUrl.replace(/\/+$/, "") + path;

    webhookHandle = {
      path,
      middleware: bot.webhookCallback(path, { secretToken: secret }),
    };

    try {
      await bot.telegram.setWebhook(fullUrl, {
        secret_token: secret,
        drop_pending_updates: true,
      });
      logger.info({ url: fullUrl, path }, "Telegram bot started (webhook)");
    } catch (err) {
      logger.error({ err, url: fullUrl }, "Failed to register Telegram webhook");
      throw err;
    }
  } else {
    try {
      // Make sure no stale webhook is registered before we start polling.
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      logger.warn({ err }, "Could not clear existing webhook before polling");
    }
    bot.launch({ dropPendingUpdates: true });
    logger.info("Telegram bot started (long polling)");
  }

  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username ?? "";
    if (botUsername) {
      logger.info({ username: botUsername }, "Bot identity loaded");
    }
  } catch (err) {
    logger.warn({ err }, "Could not fetch bot identity for share button");
  }

  configureBotProfile();
  startScheduler();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

// ===== Admin API helpers =====

export interface AdminLink {
  index: number;
  title: string;
  url: string;
  clicks: number;
  variantCount: number;
}

export function listLinks(): AdminLink[] {
  return linkList.map((e, i) => ({
    index: i,
    title: e.title,
    url: e.url,
    clicks: e.clicks ?? 0,
    variantCount: e.abTest?.variants.length ?? 0,
  }));
}

export async function adminAddLink(title: string, url: string): Promise<AdminLink> {
  const entry: LinkEntry = { title, url, clicks: 0 };
  linkList.push(entry);
  await rewriteAllLinks();
  return {
    index: linkList.length - 1,
    title: entry.title,
    url: entry.url,
    clicks: 0,
    variantCount: 0,
  };
}

export async function adminUpdateLink(
  index: number,
  patch: { title?: string; url?: string },
): Promise<AdminLink | null> {
  const entry = linkList[index];
  if (!entry) return null;
  if (patch.title !== undefined) entry.title = patch.title;
  if (patch.url !== undefined) entry.url = patch.url;
  await rewriteAllLinks();
  return {
    index,
    title: entry.title,
    url: entry.url,
    clicks: entry.clicks ?? 0,
    variantCount: entry.abTest?.variants.length ?? 0,
  };
}

export async function adminRemoveLink(index: number): Promise<AdminLink | null> {
  const entry = linkList[index];
  if (!entry) return null;
  linkList.splice(index, 1);
  await rewriteAllLinks();
  return {
    index,
    title: entry.title,
    url: entry.url,
    clicks: entry.clicks ?? 0,
    variantCount: entry.abTest?.variants.length ?? 0,
  };
}

export async function adminResetClicks(index?: number): Promise<void> {
  if (index === undefined) {
    for (const e of linkList) e.clicks = 0;
    try {
      await db.update(linksTable).set({ clicks: 0 });
    } catch (err) {
      logger.error({ err }, "Failed to reset all clicks");
    }
  } else {
    const entry = linkList[index];
    if (entry) {
      entry.clicks = 0;
      try {
        await db.update(linksTable).set({ clicks: 0 }).where(eq(linksTable.position, index));
      } catch (err) {
        logger.error({ err, index }, "Failed to reset link clicks");
      }
    }
  }
}

export interface AdminStats {
  uniqueUsers: number;
  totalStarts: number;
  totalLinkOpens: number;
  totalLinks: number;
  totalClicks: number;
  totalWarnings: number;
  totalBans: number;
  totalKicks: number;
  totalMutes: number;
  activeWarningPoints: number;
  usersWithWarnings: number;
  topOffers: { index: number; title: string; clicks: number }[];
}

export function adminGetStats(): AdminStats {
  let activeWarnings = 0;
  let usersWithWarnings = 0;
  for (const perChat of warnings.values()) {
    for (const count of perChat.values()) {
      activeWarnings += count;
      if (count > 0) usersWithWarnings += 1;
    }
  }
  const totalClicks = linkList.reduce((sum, e) => sum + (e.clicks ?? 0), 0);
  const topOffers = linkList
    .map((e, i) => ({ index: i, title: e.title, clicks: e.clicks ?? 0 }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);
  return {
    uniqueUsers: knownUsers.size,
    totalStarts: stats.totalStarts,
    totalLinkOpens: stats.totalLinkOpens,
    totalLinks: linkList.length,
    totalClicks,
    totalWarnings: stats.totalWarnings,
    totalBans: stats.totalBans,
    totalKicks: stats.totalKicks,
    totalMutes: stats.totalMutes,
    activeWarningPoints: activeWarnings,
    usersWithWarnings,
    topOffers,
  };
}

export interface BroadcastResult {
  attempted: number;
  delivered: number;
  failed: number;
}

export async function adminBroadcast(text: string): Promise<BroadcastResult> {
  const recipients = Array.from(knownUsers);
  let delivered = 0;
  let failed = 0;
  for (const userId of recipients) {
    try {
      await bot.telegram.sendMessage(userId, text, { parse_mode: "Markdown" });
      delivered += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, userId }, "Broadcast delivery failed");
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return { attempted: recipients.length, delivered, failed };
}
