"use strict";

const { Sequelize, DataTypes } = require("sequelize");

const sequelize = new Sequelize({
  dialect: "postgres",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB ?? "pavel_payments",
  username: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD,
  logging: process.env.NODE_ENV === "development" ? console.log : false,
});

// ── User ──────────────────────────────────────────────────────────────────────
const User = sequelize.define("User", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  nfcUid: { type: DataTypes.STRING, allowNull: false, unique: true },
  walletAddress: { type: DataTypes.STRING },
  preferredCurrency: { type: DataTypes.STRING(3), defaultValue: "USD" },
  isPremium: { type: DataTypes.BOOLEAN, defaultValue: false },
});

// ── Mandate ───────────────────────────────────────────────────────────────────
const Mandate = sequelize.define("Mandate", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, references: { model: User, key: "id" } },
  accessToken: { type: DataTypes.TEXT, allowNull: false },
  manageUrl: { type: DataTypes.STRING },
  expiresAt: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
});

// ── Transaction ───────────────────────────────────────────────────────────────
const Transaction = sequelize.define("Transaction", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.STRING, allowNull: false },
  walletAddress: { type: DataTypes.STRING },
  paymentId: { type: DataTypes.STRING },
  amount: { type: DataTypes.INTEGER, allowNull: false },
  currency: { type: DataTypes.STRING(3), defaultValue: "USD" },
  description: { type: DataTypes.STRING },
  status: {
    type: DataTypes.ENUM("pending", "completed", "failed"),
    defaultValue: "pending",
  },
});

// ── Subscription ──────────────────────────────────────────────────────────────
// Stores a user's chosen billing plan for gym or streaming.
const Subscription = sequelize.define("Subscription", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: "id" } },
  mandateId: { type: DataTypes.UUID, references: { model: Mandate, key: "id" } },
  serviceType: {
    type: DataTypes.ENUM("gym", "streaming"),
    allowNull: false,
  },
  // "dynamic" = pay-per-use with duration discounts
  // "static"  = flat fee charged at the interval start
  subscriptionType: {
    type: DataTypes.ENUM("dynamic", "static"),
    allowNull: false,
    defaultValue: "dynamic",
  },
  // Billing interval — how often a charge cycle occurs
  tier: {
    type: DataTypes.ENUM("daily", "weekly", "monthly", "yearly"),
    allowNull: false,
    defaultValue: "daily",
  },
  // Base rate in cents for this tier (overridable per gym/service)
  baseRateCents: { type: DataTypes.INTEGER, allowNull: false },
  startDate: { type: DataTypes.DATEONLY, allowNull: false },
  nextBillingDate: { type: DataTypes.DATEONLY, allowNull: false },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: false }, // activated after GNAP consent
});

// ── GymSession ────────────────────────────────────────────────────────────────
// One record per tap-in/tap-out visit. Multiple sessions per day are summed
// at midnight settlement.
const GymSession = sequelize.define("GymSession", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: "id" } },
  terminalId: { type: DataTypes.STRING, allowNull: false },
  tapInAt: { type: DataTypes.DATE, allowNull: false },
  tapOutAt: { type: DataTypes.DATE }, // null = user is currently inside
  minutesAccumulated: { type: DataTypes.INTEGER, defaultValue: 0 },
  // DATEONLY for grouping all sessions belonging to the same calendar day
  date: { type: DataTypes.DATEONLY, allowNull: false },
});

// ── DailySettlement ───────────────────────────────────────────────────────────
// One record per user per calendar day — written by the midnight cron job.
const DailySettlement = sequelize.define("DailySettlement", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: "id" } },
  serviceType: { type: DataTypes.ENUM("gym", "streaming"), allowNull: false },
  settlementDate: { type: DataTypes.DATEONLY, allowNull: false },
  totalMinutes: { type: DataTypes.INTEGER, defaultValue: 0 },
  chargeAmountCents: { type: DataTypes.INTEGER, allowNull: false },
  currency: { type: DataTypes.STRING(3), defaultValue: "USD" },
  transactionId: { type: DataTypes.UUID, references: { model: Transaction, key: "id" } },
  status: {
    type: DataTypes.ENUM("pending", "charged", "failed", "skipped"),
    defaultValue: "pending",
  },
  breakdown: { type: DataTypes.JSONB }, // { base, durationDiscount, peakAdjustment }
});

// ── StreamSession ─────────────────────────────────────────────────────────────
// One record per play/pause cycle. Settled at midnight like gym sessions.
const StreamSession = sequelize.define("StreamSession", {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: "id" } },
  contentId: { type: DataTypes.STRING, allowNull: false },
  contentTitle: { type: DataTypes.STRING },
  contentType: {
    type: DataTypes.ENUM("movie", "show", "live"),
    defaultValue: "movie",
  },
  startedAt: { type: DataTypes.DATE, allowNull: false },
  endedAt: { type: DataTypes.DATE }, // null = currently watching
  minutesWatched: { type: DataTypes.INTEGER, defaultValue: 0 },
  date: { type: DataTypes.DATEONLY, allowNull: false },

  // ── Web Monetization streaming ────────────────────────────────────────────
  // Payment is streamed in real time by the viewer's Web Monetization agent
  // directly to the service wallet. `streamedCents` accumulates the amount the
  // browser reported via `monetization` events over the life of the session.
  durationSeconds: { type: DataTypes.INTEGER, defaultValue: 0 },
  secondsWatched: { type: DataTypes.INTEGER, defaultValue: 0 },
  streamedCents: { type: DataTypes.INTEGER, defaultValue: 0 },
  assetCode: { type: DataTypes.STRING, defaultValue: "USD" },

  // ── Legacy upfront / refund fields (retained for historical rows) ──────────
  priceCents: { type: DataTypes.INTEGER, defaultValue: 0 },
  upfrontCents: { type: DataTypes.INTEGER, defaultValue: 0 },
  watchedFraction: { type: DataTypes.FLOAT, defaultValue: 0 },
  actualChargeCents: { type: DataTypes.INTEGER, defaultValue: 0 },
  refundCents: { type: DataTypes.INTEGER, defaultValue: 0 },
  refundStatus: {
    type: DataTypes.ENUM("none", "pending", "refunded", "failed"),
    defaultValue: "none",
  },
});

// ── Associations ──────────────────────────────────────────────────────────────
User.hasMany(Mandate, { foreignKey: "userId" });
Mandate.belongsTo(User, { foreignKey: "userId" });

User.hasMany(Subscription, { foreignKey: "userId" });
Subscription.belongsTo(User, { foreignKey: "userId" });
Subscription.belongsTo(Mandate, { foreignKey: "mandateId" });

User.hasMany(GymSession, { foreignKey: "userId" });
GymSession.belongsTo(User, { foreignKey: "userId" });

User.hasMany(DailySettlement, { foreignKey: "userId" });
DailySettlement.belongsTo(User, { foreignKey: "userId" });
DailySettlement.belongsTo(Transaction, { foreignKey: "transactionId" });

User.hasMany(StreamSession, { foreignKey: "userId" });
StreamSession.belongsTo(User, { foreignKey: "userId" });

// ── Sync (dev only) ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "development") {
  sequelize.sync({ alter: true }).catch(console.error);
}

module.exports = {
  sequelize,
  User,
  Mandate,
  Transaction,
  Subscription,
  GymSession,
  DailySettlement,
  StreamSession,
};
