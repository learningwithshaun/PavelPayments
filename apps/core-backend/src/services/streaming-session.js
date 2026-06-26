/**
 * streaming-session.js
 *
 * Manages streaming play/pause session tracking.
 *
 * Billing model: Web Monetization. While a user watches, their Web Monetization
 * agent streams micropayments straight to the service wallet (Interledger
 * Open Payments under the hood). The backend does NOT charge the user — it only
 * records the amount the browser reports via `monetization` events so the
 * dashboard and history can show what was streamed.
 *
 * startStream    → opens a StreamSession (endedAt = null)
 * recordPayment  → adds a streamed micropayment to the open session
 * endStream      → closes the session, computes minutes/seconds watched
 */

"use strict";

const { User, StreamSession } = require("../models");

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Start a streaming session (user pressed play).
 * Auto-closes any prior open session for the same user.
 *
 * No money is held or charged up front — payment is streamed in real time by
 * the viewer's Web Monetization agent.
 *
 * @param {{ nfcUid: string, contentId: string, contentTitle?: string,
 *           contentType?: string, durationSeconds?: number }} params
 * @returns {Promise<StreamSession>}
 */
async function startStream({
  nfcUid,
  contentId,
  contentTitle = "",
  contentType = "movie",
  durationSeconds = 0,
}) {
  // Streaming uses Web Monetization, so any viewer id is valid — provision it on
  // first play instead of requiring a pre-registered NFC user.
  const [user] = await User.findOrCreate({ where: { nfcUid }, defaults: { nfcUid } });

  // Close any forgotten open session
  const open = await StreamSession.findOne({ where: { userId: user.id, endedAt: null } });
  if (open) {
    await closeSession(open);
  }

  const session = await StreamSession.create({
    userId: user.id,
    contentId,
    contentTitle,
    contentType,
    startedAt: new Date(),
    date: todayDate(),
    durationSeconds: Math.max(0, Math.round(durationSeconds)),
    streamedCents: 0,
    refundStatus: "none",
  });

  return session;
}

/**
 * Record a Web Monetization micropayment against the open session.
 * Called each time the viewer's monetization agent reports an `amountSent`.
 *
 * @param {{ sessionId: string, amountCents: number, assetCode?: string }} params
 * @returns {Promise<StreamSession>}
 */
async function recordPayment({ sessionId, amountCents, assetCode }) {
  const session = await StreamSession.findByPk(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const cents = Math.max(0, Math.round(amountCents ?? 0));
  await session.update({
    streamedCents: (session.streamedCents ?? 0) + cents,
    assetCode: assetCode || session.assetCode || "USD",
  });

  return session;
}

/**
 * Close a session, computing minutes, watched fraction, actual charge and refund.
 * Falls back to wall-clock time if the caller did not report watched seconds.
 *
 * @param {StreamSession} session
 * @param {{ secondsWatched?: number, durationSeconds?: number }} [report]
 */
async function closeSession(session, report = {}) {
  const now = new Date();
  const wallClockSeconds = Math.max(0, Math.round((now - new Date(session.startedAt)) / 1000));

  const durationSeconds = Math.max(
    0,
    Math.round(report.durationSeconds ?? session.durationSeconds ?? 0)
  );

  // Prefer reported watched seconds (from the video element); otherwise use
  // the wall-clock elapsed time, capped to the content duration when known.
  let secondsWatched = report.secondsWatched != null
    ? Math.max(0, Math.round(report.secondsWatched))
    : wallClockSeconds;
  if (durationSeconds > 0) secondsWatched = Math.min(secondsWatched, durationSeconds);

  const minutesWatched = Math.round(secondsWatched / 60);

  await session.update({
    endedAt: now,
    minutesWatched,
    secondsWatched,
    durationSeconds,
  });

  return session;
}

/**
 * Update watched time on an OPEN session without closing it. Used by the
 * player's heartbeat so today's minutes accumulate live while watching.
 * Progress never moves backwards (scrubbing back won't shrink the total).
 *
 * @param {{ sessionId: string, secondsWatched?: number, durationSeconds?: number }} params
 * @returns {Promise<StreamSession>}
 */
async function recordProgress({ sessionId, secondsWatched, durationSeconds }) {
  const session = await StreamSession.findByPk(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.endedAt) return session; // already closed

  const dur = Math.max(0, Math.round(durationSeconds ?? session.durationSeconds ?? 0));
  let secs = Math.max(0, Math.round(secondsWatched ?? 0));
  if (dur > 0) secs = Math.min(secs, dur);
  secs = Math.max(secs, session.secondsWatched ?? 0);

  await session.update({
    secondsWatched: secs,
    minutesWatched: Math.round(secs / 60),
    durationSeconds: dur || session.durationSeconds,
  });

  return session;
}

/**
 * End a streaming session (user paused or stopped).
 *
 * @param {{ sessionId: string, secondsWatched?: number, durationSeconds?: number }} params
 * @returns {Promise<StreamSession>}
 */
async function endStream({ sessionId, secondsWatched, durationSeconds }) {
  const session = await StreamSession.findByPk(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.endedAt) throw new Error(`Session already ended: ${sessionId}`);

  return closeSession(session, { secondsWatched, durationSeconds });
}

/**
 * Get current open stream session and today's totals for a user.
 *
 * @param {{ nfcUid: string }} params
 */
async function getStreamStatus({ nfcUid }) {
  const [user] = await User.findOrCreate({ where: { nfcUid }, defaults: { nfcUid } });

  const currentSession = await StreamSession.findOne({
    where: { userId: user.id, endedAt: null },
  });

  const today = todayDate();
  const sessions = await StreamSession.findAll({
    where: { userId: user.id, date: today },
  });

  const todayMinutes = sessions.reduce((sum, s) => sum + (s.minutesWatched ?? 0), 0);
  const todayStreamedCents = sessions.reduce((sum, s) => sum + (s.streamedCents ?? 0), 0);

  return {
    currentSession,
    todayMinutes,
    todayStreamedCents,
    user,
  };
}

/**
 * Auto-close all open stream sessions for a user (called by settlement cron).
 * @param {string} userId
 */
async function closeOpenStreamSessions(userId) {
  const open = await StreamSession.findAll({ where: { userId, endedAt: null } });
  for (const s of open) {
    await closeSession(s);
  }
}

module.exports = {
  startStream,
  recordPayment,
  recordProgress,
  endStream,
  getStreamStatus,
  closeOpenStreamSessions,
};
