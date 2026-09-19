/* ===================================================================
   The booking API.

   Mounted from server.js with the handful of things it needs, rather
   than reaching for them: this file never reads an environment
   variable, and every decision it makes about capacity, deadlines or
   time zones comes from server/booking-store.js, which is pure and
   tested.

   Four collections, all created lazily:

     booking_schedules   one per campaign — timezone, status, tokens
     booking_slots       one per date x time — capacity and booked
     booking_invites     _id IS the token; one per creator
     campaign_bookings   the booking itself

   booking_invites is its own collection for one reason: the partner
   page resolves its token by loading the whole workspace document,
   which is 862 KB. That is tolerable for a staff-adjacent page opened
   on a laptop. It is not tolerable for a creator opening a link on
   mobile data, so an invite resolves with one indexed _id lookup.

   The public routes here are the first unauthenticated writes this
   server has besides partner comments, so they are rate limited and
   their bodies are capped well below the global 10 MB.
   =================================================================== */

const crypto = require("crypto");
const B = require("./booking-store.js");

const token = (bytes) => crypto.randomBytes(bytes || 24).toString("base64url");
const newId = (p) => p + "_" + crypto.randomBytes(9).toString("base64url");

/* ---- rate limiting -------------------------------------------------

   In memory, which is right for a single Render instance and wrong the
   moment there are two — at which point this wants a Mongo-backed
   counter. Written so that swap is one function. A fixed window rather
   than a sliding one: cheaper, and the imprecision at the boundary does
   not matter for what this is defending against. */
function rateLimiter(opts) {
  const windowMs = opts.windowMs, max = opts.max;
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const slot = Math.floor(now / windowMs);
    const k = slot + "|" + key;
    /* the previous window's keys are dead weight; drop them lazily so
       there is no timer to leak on a process that never restarts */
    if (hits.size > 5000) {
      hits.forEach((_, old) => { if (+String(old).split("|")[0] < slot) hits.delete(old); });
    }
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    return n <= max;
  };
}

const ipOf = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.ip || req.connection?.remoteAddress || "unknown";

/* ---- mount ---------------------------------------------------------- */

function mountBookingRoutes(app, deps) {
  const {
    getMongoClient, MONGODB_DB, MONGODB_URI,
    loadWorkspaceDoc, requireStaff
  } = deps;

  const col = async (name) => {
    const client = await getMongoClient();
    if (!client) return null;
    return client.db(MONGODB_DB).collection(name);
  };
  const schedules = () => col("booking_schedules");
  const slots = () => col("booking_slots");
  const invites = () => col("booking_invites");
  const bookings = () => col("campaign_bookings");

  const needsDb = (res) => {
    if (MONGODB_URI) return false;
    res.status(503).json({ error: "Database not configured on the server yet — set MONGODB_URI." });
    return true;
  };

  /* Generous on purpose. Mobile carriers in Korea put a great many
     people behind one address, and a campaign link is handed to thirty
     or forty creators at once — so a limit tight enough to be a real
     defence against scripted abuse would also lock out a roomful of
     creators booking in the same minute. Correctness does not rest here
     in any case: the atomic claim is what makes double booking
     impossible, and this only keeps the volume sane. */
  const readLimit = rateLimiter({ windowMs: 60000, max: 120 });
  const writeLimit = rateLimiter({ windowMs: 60000, max: 40 });

  /* Bodies here carry a name, a handle and a slot id. A kilobyte is
     generous; the global 10 MB limit is for workspace saves. */
  function tooBig(req, res) {
    const len = Number(req.headers["content-length"] || 0);
    if (len > 4096) { res.status(413).json({ error: "That request is too large." }); return true; }
    return false;
  }

  function limited(req, res, limiter, keyExtra) {
    const key = ipOf(req) + "|" + (keyExtra || "");
    if (limiter(key)) return false;
    res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
    return true;
  }

  /* ---- shared reads ------------------------------------------------- */

  async function scheduleByToken(tok) {
    const s = await schedules();
    return s ? s.findOne({ publicToken: tok, status: { $ne: "closed" } }) : null;
  }

  async function inviteByToken(tok) {
    const i = await invites();
    if (!i) return null;
    const inv = await i.findOne({ _id: tok });
    if (!inv || inv.revokedAt) return null;
    return inv;
  }

  /* What a creator's page is allowed to know. Never capacity, never
     booked — a number computed here, or nothing. */
  async function publicView(schedule, now) {
    const s = await slots();
    const rows = await s.find({ scheduleId: schedule._id }).sort({ date: 1, time: 1 }).toArray();
    const closed = new Set(schedule.closedDates || []);
    const byDate = new Map();

    rows.forEach((r) => {
      const past = B.deadlinePassed(r.startsAt, schedule.deadlineHours, now);
      const left = closed.has(r.date) || past ? 0 : B.spotsLeft(r);
      const day = byDate.get(r.date) || { date: r.date, blocked: closed.has(r.date), spotsLeft: 0, slots: [] };
      day.spotsLeft += left;
      day.slots.push({ id: r._id, time: r.time, spotsLeft: left, note: r.note || "" });
      byDate.set(r.date, day);
    });

    return {
      venueName: schedule.venueName || "",
      timezone: schedule.timezone,
      noteForCreator: schedule.noteForCreator || "",
      maxPartySize: schedule.maxPartySize || 1,
      status: schedule.status,
      dates: [...byDate.values()]
    };
  }

  /* ---- staff: the schedule ------------------------------------------ */

  app.post("/api/booking/schedule", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const body = req.body || {};
    const campaignId = String(body.campaignId || "").trim();
    if (!campaignId) return res.status(400).json({ error: "Which campaign?" });

    const tz = String(body.timezone || "Asia/Seoul").trim();
    if (B.wallClockToInstant("2026-01-01", "12:00", tz) == null) {
      return res.status(400).json({ error: "That time zone is not one this server recognises." });
    }

    try {
      const s = await schedules();
      const existing = await s.findOne({ campaignId });
      const patch = {
        timezone: tz,
        slotMinutes: Math.max(5, Math.floor(Number(body.slotMinutes) || 90)),
        status: ["open", "paused", "closed"].includes(body.status) ? body.status : (existing ? existing.status : "open"),
        deadlineHours: Math.max(0, Math.floor(Number(body.deadlineHours) || 0)),
        maxPartySize: Math.max(1, Math.floor(Number(body.maxPartySize) || 1)),
        venueName: String(body.venueName || "").slice(0, 200),
        noteForCreator: String(body.noteForCreator || "").slice(0, 2000),
        updatedAt: new Date()
      };
      if (Array.isArray(body.closedDates)) {
        patch.closedDates = body.closedDates.map(B.normDate).filter(Boolean);
      }

      if (existing) {
        await s.updateOne({ _id: existing._id }, { $set: patch });
        return res.json({ ok: true, schedule: { ...existing, ...patch } });
      }
      const doc = {
        _id: newId("sch"), campaignId, publicToken: token(24),
        closedDates: patch.closedDates || [], createdAt: new Date(), ...patch
      };
      await s.insertOne(doc);
      return res.json({ ok: true, schedule: doc });
    } catch (err) {
      console.error("POST /api/booking/schedule failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* Everything staff needs for one campaign, in one request: the
     schedule, its slots with real numbers, and the bookings. */
  app.get("/api/booking/campaign/:campaignId", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    try {
      const s = await schedules();
      const schedule = await s.findOne({ campaignId: req.params.campaignId });
      if (!schedule) return res.json({ ok: true, schedule: null, slots: [], bookings: [], invites: [] });

      const [slotRows, bookingRows, inviteRows] = await Promise.all([
        (await slots()).find({ scheduleId: schedule._id }).sort({ date: 1, time: 1 }).toArray(),
        (await bookings()).find({ campaignId: req.params.campaignId, status: "confirmed" })
          .sort({ startsAt: 1 }).toArray(),
        (await invites()).find({ campaignId: req.params.campaignId, revokedAt: null }).toArray()
      ]);
      return res.json({ ok: true, schedule, slots: slotRows, bookings: bookingRows, invites: inviteRows });
    } catch (err) {
      console.error("GET /api/booking/campaign failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* ---- staff: slots -------------------------------------------------- */

  app.post("/api/booking/slot", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const body = req.body || {};
    const check = B.validateSlot(body);
    if (!check.ok) return res.status(400).json({ error: check.message, code: check.code });

    try {
      const s = await schedules();
      const schedule = await s.findOne({ _id: String(body.scheduleId || "") });
      if (!schedule) return res.status(404).json({ error: "No booking schedule for that campaign yet." });

      const startsAt = B.wallClockToInstant(check.date, check.time, schedule.timezone);
      if (!startsAt) return res.status(400).json({ error: "That date and time could not be resolved in " + schedule.timezone + "." });
      const endsAt = new Date(startsAt.getTime() + (schedule.slotMinutes || 90) * 60000);

      const doc = {
        _id: newId("slt"), scheduleId: schedule._id, campaignId: schedule.campaignId,
        date: check.date, time: check.time, startsAt, endsAt, timezone: schedule.timezone,
        capacity: check.capacity, booked: 0, status: "open",
        note: String(body.note || "").slice(0, 200),
        createdAt: new Date(), updatedAt: new Date()
      };
      await (await slots()).insertOne(doc);
      return res.json({ ok: true, slot: doc });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "That time already exists on that date." });
      }
      console.error("POST /api/booking/slot failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  app.patch("/api/booking/slot/:id", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const body = req.body || {};
    try {
      const sl = await slots();
      const slot = await sl.findOne({ _id: req.params.id });
      if (!slot) return res.status(404).json({ error: "No such slot." });

      const patch = { updatedAt: new Date() };
      if (body.capacity != null) {
        const c = B.capacityChange(slot, body.capacity);
        if (!c.ok) return res.status(409).json({ error: c.message, code: c.code, booked: c.booked });
        patch.capacity = c.capacity;
      }
      if (body.status === "open" || body.status === "closed") patch.status = body.status;
      if (body.note != null) patch.note = String(body.note).slice(0, 200);

      await sl.updateOne({ _id: slot._id }, { $set: patch });
      return res.json({ ok: true, slot: { ...slot, ...patch } });
    } catch (err) {
      console.error("PATCH /api/booking/slot failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* A slot with bookings on it is not deleted out from under them. */
  app.delete("/api/booking/slot/:id", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    try {
      const sl = await slots();
      const slot = await sl.findOne({ _id: req.params.id });
      if (!slot) return res.status(404).json({ error: "No such slot." });
      if ((slot.booked || 0) > 0) {
        return res.status(409).json({
          error: slot.booked + " already booked on that slot — cancel those bookings first, or close the slot instead.",
          code: "slot-has-bookings"
        });
      }
      await sl.deleteOne({ _id: slot._id });
      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/booking/slot failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* Blocking a whole day leaves each slot's own status alone, so
     un-blocking restores what was there rather than reopening slots
     somebody had closed one at a time. */
  app.post("/api/booking/date", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const body = req.body || {};
    const date = B.normDate(body.date);
    if (!date) return res.status(400).json({ error: "A date as YYYY-MM-DD, please." });
    try {
      const s = await schedules();
      const schedule = await s.findOne({ _id: String(body.scheduleId || "") });
      if (!schedule) return res.status(404).json({ error: "No booking schedule for that campaign yet." });
      const op = body.closed ? { $addToSet: { closedDates: date } } : { $pull: { closedDates: date } };
      await s.updateOne({ _id: schedule._id }, { ...op, $set: { updatedAt: new Date() } });
      const after = await s.findOne({ _id: schedule._id });
      return res.json({ ok: true, closedDates: after.closedDates || [] });
    } catch (err) {
      console.error("POST /api/booking/date failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* ---- staff: invites ------------------------------------------------ */

  app.post("/api/booking/invite", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const body = req.body || {};
    const campaignId = String(body.campaignId || "").trim();
    const participantId = String(body.participantId || "").trim();
    if (!campaignId || !participantId) return res.status(400).json({ error: "A campaign and a roster row are both required." });

    try {
      const s = await schedules();
      const schedule = await s.findOne({ campaignId });
      if (!schedule) return res.status(404).json({ error: "Set up booking for this campaign first." });

      const i = await invites();
      const existing = await i.findOne({ campaignId, participantId, revokedAt: null });
      if (existing) return res.json({ ok: true, invite: existing, reused: true });

      const doc = {
        _id: token(24), campaignId, scheduleId: schedule._id, participantId,
        creatorId: String(body.creatorId || "") || null,
        name: String(body.name || "").slice(0, 120),
        handle: String(body.handle || "").slice(0, 120),
        createdAt: new Date(), usedAt: null, revokedAt: null
      };
      await i.insertOne(doc);
      return res.json({ ok: true, invite: doc });
    } catch (err) {
      console.error("POST /api/booking/invite failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  }));

  /* ---- staff: moving and matching a booking --------------------------

     Staff can do two things a creator cannot: move somebody into a slot
     that is already full, and attach an unmatched public booking to a
     roster row. Both are real decisions a person is entitled to make, so
     they are recorded rather than prevented. */

  app.post("/api/booking/booking/:id/move", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const nextSlotId = String((req.body || {}).slotId || "").trim();
    const over = !!(req.body || {}).overCapacity;
    if (!nextSlotId) return res.status(400).json({ error: "Which slot?" });

    try {
      const bkCol = await bookings();
      const bk = await bkCol.findOne({ _id: req.params.id });
      if (!bk || bk.status !== "confirmed") return res.status(404).json({ error: "No such booking." });
      if (bk.slotId === nextSlotId) return res.json({ ok: true, unchanged: true });

      const sl = await slots();
      const next = await sl.findOne({ _id: nextSlotId, scheduleId: bk.scheduleId });
      if (!next) return res.status(404).json({ error: "No such slot." });

      const previousSlotId = bk.slotId;
      const seats = bk.partySize;

      /* the same claim the creator's move makes; only the fallback differs */
      const plan = B.claimPlan(next._id, seats);
      let claimed = await sl.findOneAndUpdate(plan.filter, plan.update, { returnDocument: "after" });
      if (!claimed) {
        if (!over) {
          return res.status(409).json({
            error: "That slot is full.", code: "slot_full",
            free: Math.max(0, (next.capacity || 0) - (next.booked || 0))
          });
        }
        /* deliberately past capacity, because a person said so. The seat
           count still moves, so the slot reads over-booked rather than
           quietly hiding an extra visitor. */
        await sl.updateOne({ _id: next._id }, { $inc: { booked: seats }, $set: { updatedAt: new Date() } });
      }

      try {
        const done = await bkCol.updateOne(
          { _id: bk._id, status: "confirmed", slotId: previousSlotId },
          { $set: { slotId: next._id, date: next.date, time: next.time, startsAt: next.startsAt,
                    source: "staff", overCapacity: over && !claimed, updatedAt: new Date() },
            $push: { history: { at: new Date(), action: "moved", by: "staff",
                     from: bk.date + " " + bk.time, to: next.date + " " + next.time,
                     overCapacity: over && !claimed } } }
        );
        if (!done.modifiedCount) throw new Error("booking changed underneath the move");
      } catch (err) {
        const back = B.releasePlan(next._id, seats);
        await sl.updateOne(back.filter, back.update);
        throw err;
      }

      const release = B.releasePlan(previousSlotId, seats);
      await sl.updateOne(release.filter, release.update);
      return res.json({ ok: true, overCapacity: over && !claimed });
    } catch (err) {
      console.error("POST /api/booking/booking/move failed:", err.message);
      return res.status(502).json({ error: "Could not move that booking." });
    }
  }));

  /* Points an unmatched booking at a roster row. Creates nothing: if the
     person is not on the roster, adding them is a separate decision made
     in the roster itself. The partial unique index still applies, so a row
     that already has a confirmed booking cannot take a second. */
  app.post("/api/booking/booking/:id/match", requireStaff(async (req, res) => {
    if (needsDb(res)) return;
    const participantId = String((req.body || {}).participantId || "").trim();
    if (!participantId) return res.status(400).json({ error: "Which roster row?" });
    try {
      const bkCol = await bookings();
      const bk = await bkCol.findOne({ _id: req.params.id });
      if (!bk || bk.status !== "confirmed") return res.status(404).json({ error: "No such booking." });
      if (bk.participantId) return res.status(409).json({ error: "That booking is already matched." });

      try {
        await bkCol.updateOne({ _id: bk._id }, {
          $set: { participantId, updatedAt: new Date() },
          $push: { history: { at: new Date(), action: "matched", by: "staff", to: participantId } }
        });
      } catch (err) {
        if (err && err.code === 11000) {
          return res.status(409).json({ error: "That roster row already has a booking on this campaign." });
        }
        throw err;
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/booking/booking/match failed:", err.message);
      return res.status(502).json({ error: "Could not match that booking." });
    }
  }));

  /* ---- the public page ----------------------------------------------- */

  /* Both link shapes land here. An invite carries the creator's name and
     handle, so the page fills them in and the booking matches itself; a
     public link asks, and an unmatched answer waits for staff. */
  app.get("/api/book/:token", async (req, res) => {
    if (needsDb(res)) return;
    if (limited(req, res, readLimit, req.params.token)) return;
    res.set("X-Robots-Tag", "noindex, nofollow");
    try {
      const inv = await inviteByToken(req.params.token);
      let schedule = null, prefill = null;

      if (inv) {
        schedule = await (await schedules()).findOne({ _id: inv.scheduleId });
        prefill = { name: inv.name, handle: inv.handle, locked: true };
      } else {
        schedule = await scheduleByToken(req.params.token);
      }
      if (!schedule) return res.status(404).json({ error: "사용할 수 없는 링크이거나 예약이 마감되었습니다." });
      if (schedule.status === "paused") {
        return res.json({ ok: true, paused: true, venueName: schedule.venueName || "" });
      }

      const view = await publicView(schedule, Date.now());
      view.prefill = prefill;

      /* an invite that has already been used shows the booking rather
         than an empty picker, so the link doubles as the manage link */
      if (inv) {
        const mine = await (await bookings()).findOne({
          campaignId: inv.campaignId, participantId: inv.participantId, status: "confirmed"
        });
        if (mine) {
          view.booking = {
            date: mine.date, time: mine.time, partySize: mine.partySize,
            manageToken: mine.manageToken
          };
        }
      }
      return res.json({ ok: true, ...view });
    } catch (err) {
      console.error("GET /api/book failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  });

  /* The claim. Order matters and is the whole design:

       1. claim the seat atomically — the database decides
       2. insert the booking; the partial unique index decides whether
          this creator already has one
       3. if step 2 fails for any reason, give the seat back

     A leaked seat is invisible and permanent, so step 3 has no early
     return and no condition on why step 2 failed. */
  app.post("/api/book/:token/confirm", async (req, res) => {
    if (needsDb(res)) return;
    if (tooBig(req, res)) return;
    if (limited(req, res, writeLimit, req.params.token)) return;
    res.set("X-Robots-Tag", "noindex, nofollow");

    const body = req.body || {};
    const slotId = String(body.slotId || "").trim();
    if (!slotId) return res.status(400).json({ error: "시간을 먼저 선택해 주세요." });

    try {
      const inv = await inviteByToken(req.params.token);
      const schedule = inv
        ? await (await schedules()).findOne({ _id: inv.scheduleId })
        : await scheduleByToken(req.params.token);
      if (!schedule) return res.status(404).json({ error: "사용할 수 없는 링크이거나 예약이 마감되었습니다." });
      if (schedule.status !== "open") return res.status(409).json({ error: "지금은 예약을 받고 있지 않습니다." });

      const name = String(inv ? inv.name : body.name || "").trim().slice(0, 120);
      const handleRaw = String(inv ? inv.handle : body.handle || "").trim().slice(0, 120);
      const handle = B.normHandle(handleRaw);
      if (!name || !handle) return res.status(400).json({ error: "이름과 인스타그램 아이디를 모두 입력해 주세요." });

      const partySize = Math.min(
        Math.max(1, Math.floor(Number(body.partySize) || 1)),
        schedule.maxPartySize || 1
      );

      const sl = await slots();
      const slot = await sl.findOne({ _id: slotId, scheduleId: schedule._id });
      if (!slot) return res.status(404).json({ error: "선택하신 시간이 더 이상 없습니다." });
      if ((schedule.closedDates || []).includes(slot.date)) {
        return res.status(409).json({ error: "선택하신 날짜는 휴무입니다.", code: "date-blocked" });
      }
      if (B.deadlinePassed(slot.startsAt, schedule.deadlineHours, Date.now())) {
        return res.status(409).json({ error: "예약 가능 시간이 지났습니다.", code: "deadline-passed" });
      }

      /* 1 — the claim */
      const plan = B.claimPlan(slot._id, partySize);
      const claimed = await sl.findOneAndUpdate(plan.filter, plan.update, { returnDocument: "after" });
      if (!claimed) {
        const view = await publicView(schedule, Date.now());
        return res.status(409).json({
          error: "방금 다른 분이 예약했습니다. 다른 시간을 선택해 주세요.",
          code: "slot_taken", ...view
        });
      }

      /* 2 — the booking */
      const doc = {
        _id: newId("bk"), campaignId: schedule.campaignId, scheduleId: schedule._id, slotId: slot._id,
        participantId: inv ? inv.participantId : null,
        creatorId: inv ? inv.creatorId : null,
        date: slot.date, time: slot.time, startsAt: slot.startsAt, timezone: schedule.timezone,
        partySize, status: "confirmed",
        guest: { name, handle: handleRaw, handleNorm: handle },
        manageToken: token(24), source: inv ? "creator" : "public",
        bookedAt: new Date(), updatedAt: new Date(), movedFrom: null,
        history: [{ at: new Date(), action: "confirmed", by: inv ? "creator" : "public" }]
      };

      try {
        await (await bookings()).insertOne(doc);
      } catch (err) {
        /* 3 — give the seat back, whatever went wrong */
        const back = B.releasePlan(slot._id, partySize);
        await sl.updateOne(back.filter, back.update);
        if (err && err.code === 11000) {
          return res.status(409).json({
            error: "이미 예약이 있습니다. 확정 안내의 링크로 시간을 변경해 주세요.",
            code: "already-booked"
          });
        }
        throw err;
      }

      return res.json({
        ok: true,
        booking: {
          date: doc.date, time: doc.time, partySize, manageToken: doc.manageToken,
          timezone: schedule.timezone, venueName: schedule.venueName || ""
        }
      });
    } catch (err) {
      console.error("POST /api/book confirm failed:", err.message);
      return res.status(502).json({ error: "예약을 완료하지 못했습니다." });
    }
  });

  /* ---- manage: move and cancel ---------------------------------------- */

  app.get("/api/book/manage/:manageToken", async (req, res) => {
    if (needsDb(res)) return;
    if (limited(req, res, readLimit, req.params.manageToken)) return;
    res.set("X-Robots-Tag", "noindex, nofollow");
    try {
      const bk = await (await bookings()).findOne({ manageToken: req.params.manageToken });
      if (!bk || bk.status !== "confirmed") {
        return res.status(404).json({ error: "사용할 수 없는 예약 링크입니다." });
      }
      const schedule = await (await schedules()).findOne({ _id: bk.scheduleId });
      if (!schedule) return res.status(404).json({ error: "사용할 수 없는 예약 링크입니다." });

      const view = await publicView(schedule, Date.now());
      view.booking = { date: bk.date, time: bk.time, partySize: bk.partySize };
      return res.json({ ok: true, ...view });
    } catch (err) {
      console.error("GET /api/book/manage failed:", err.message);
      return res.status(502).json({ error: "Could not reach the database." });
    }
  });

  /* Claim the new seat BEFORE releasing the old one.

     The other order loses the creator their seat in the gap if the new
     claim fails — they would end up with nothing, having asked only to
     move. This way a failure leaves them exactly where they were. */
  app.post("/api/book/manage/:manageToken/move", async (req, res) => {
    if (needsDb(res)) return;
    if (tooBig(req, res)) return;
    if (limited(req, res, writeLimit, req.params.manageToken)) return;

    const nextSlotId = String((req.body || {}).slotId || "").trim();
    if (!nextSlotId) return res.status(400).json({ error: "새 시간을 먼저 선택해 주세요." });

    try {
      const bkCol = await bookings();
      const bk = await bkCol.findOne({ manageToken: req.params.manageToken });
      if (!bk || bk.status !== "confirmed") return res.status(404).json({ error: "사용할 수 없는 예약 링크입니다." });
      /* the same slot is not an error, but the page still needs a booking
         to render — returning a bare {unchanged} leaves it with nothing
         to show and the creator looking at a dead screen */
      if (bk.slotId === nextSlotId) {
        return res.json({
          ok: true, unchanged: true,
          booking: { date: bk.date, time: bk.time, partySize: bk.partySize, manageToken: bk.manageToken }
        });
      }

      const schedule = await (await schedules()).findOne({ _id: bk.scheduleId });
      if (!schedule || schedule.status !== "open") return res.status(409).json({ error: "지금은 예약을 받고 있지 않습니다." });

      const sl = await slots();
      const next = await sl.findOne({ _id: nextSlotId, scheduleId: bk.scheduleId });
      if (!next) return res.status(404).json({ error: "선택하신 시간이 더 이상 없습니다." });
      if ((schedule.closedDates || []).includes(next.date)) {
        return res.status(409).json({ error: "선택하신 날짜는 휴무입니다.", code: "date-blocked" });
      }
      if (B.deadlinePassed(next.startsAt, schedule.deadlineHours, Date.now())) {
        return res.status(409).json({ error: "예약 가능 시간이 지났습니다.", code: "deadline-passed" });
      }

      /* 1 — claim the new seat */
      const plan = B.claimPlan(next._id, bk.partySize);
      const claimed = await sl.findOneAndUpdate(plan.filter, plan.update, { returnDocument: "after" });
      if (!claimed) {
        const view = await publicView(schedule, Date.now());
        return res.status(409).json({
          error: "방금 다른 분이 예약했습니다. 기존 예약은 그대로 유지됩니다.",
          code: "slot_taken", ...view
        });
      }

      /* 2 — the move itself, in place.

         An earlier draft closed this booking and inserted a replacement.
         That breaks two things: the manage token is unique, so the new
         row collides with the old one still holding it — and if it did
         not collide, the creator's link would now point at a booking
         marked moved. Since MVP has no notifications, that link is the
         only handle they have on their own booking, so it has to keep
         working. history[] carries the audit trail a second document
         would have provided. */
      /* captured before the update, because after it `bk` is a stale
         description of a row that has moved on */
      const previousSlotId = bk.slotId;
      const seats = bk.partySize;
      const from = bk.date + " " + bk.time;
      const patch = {
        slotId: next._id, date: next.date, time: next.time,
        startsAt: next.startsAt, updatedAt: new Date()
      };

      try {
        const done = await bkCol.updateOne(
          { _id: bk._id, status: "confirmed", slotId: bk.slotId },
          { $set: patch,
            $push: { history: {
              at: new Date(), action: "moved", by: "creator",
              from, to: next.date + " " + next.time
            } } }
        );
        /* somebody moved or cancelled it underneath us — the seat just
           claimed is not ours to keep */
        if (!done.modifiedCount) throw new Error("booking changed underneath the move");
      } catch (err) {
        const back = B.releasePlan(next._id, seats);
        await sl.updateOne(back.filter, back.update);
        throw err;
      }

      /* 3 — only now is the old seat given up */
      const release = B.releasePlan(previousSlotId, seats);
      await sl.updateOne(release.filter, release.update);

      return res.json({
        ok: true,
        booking: { date: next.date, time: next.time, partySize: seats, manageToken: bk.manageToken }
      });
    } catch (err) {
      console.error("POST /api/book move failed:", err.message);
      return res.status(502).json({ error: "시간을 변경하지 못했습니다." });
    }
  });

  /* Guarded on the status transition, so a double-tapped Cancel returns
     the seat exactly once. */
  app.post("/api/book/manage/:manageToken/cancel", async (req, res) => {
    if (needsDb(res)) return;
    if (tooBig(req, res)) return;
    if (limited(req, res, writeLimit, req.params.manageToken)) return;

    try {
      const bkCol = await bookings();
      const bk = await bkCol.findOne({ manageToken: req.params.manageToken });
      if (!bk) return res.status(404).json({ error: "사용할 수 없는 예약 링크입니다." });
      if (bk.status !== "confirmed") return res.json({ ok: true, alreadyCancelled: true });

      const reason = String((req.body || {}).reason || "").slice(0, 500);
      const done = await bkCol.updateOne(
        { _id: bk._id, status: "confirmed" },
        { $set: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() },
          $push: { history: { at: new Date(), action: "cancelled", by: "creator" } } }
      );
      if (!done.modifiedCount) return res.json({ ok: true, alreadyCancelled: true });

      const release = B.releasePlan(bk.slotId, bk.partySize);
      await (await slots()).updateOne(release.filter, release.update);
      return res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/book cancel failed:", err.message);
      return res.status(502).json({ error: "예약을 취소하지 못했습니다." });
    }
  });

  /* ---- what the workspace save needs ---------------------------------- */

  /* Every booking that should currently be projecting onto a participant.
     Small by construction — one row per confirmed booking per campaign —
     and read on every workspace save, so it is indexed on
     { campaignId, status, startsAt }. */
  async function liveBookings() {
    const b = await bookings();
    if (!b) return [];
    return b.find({ status: "confirmed", participantId: { $type: "string" } })
      .project({ _id: 1, participantId: 1, date: 1, time: 1, status: 1 })
      .toArray();
  }

  return { liveBookings };
}

/* ---- indexes --------------------------------------------------------

   Called once on boot. The two partial unique indexes are the ones that
   matter: they are what make "one confirmed booking per creator per
   campaign" a fact the database enforces rather than a race this code
   hopes to win. A partial index that silently failed to build would let
   a double booking through months later, so a failure here is logged
   loudly rather than swallowed. */
async function ensureBookingIndexes(client, dbName) {
  if (!client) return;
  const db = client.db(dbName);
  const plans = [
    ["booking_schedules", { campaignId: 1 }, { unique: true }],
    ["booking_schedules", { publicToken: 1 }, { unique: true }],
    ["booking_slots", { scheduleId: 1, date: 1, time: 1 }, { unique: true }],
    ["booking_slots", { campaignId: 1, startsAt: 1 }, {}],
    ["booking_invites", { campaignId: 1, participantId: 1 }, {}],
    ["campaign_bookings", { manageToken: 1 }, { unique: true }],
    ["campaign_bookings", { campaignId: 1, status: 1, startsAt: 1 }, {}],
    ["campaign_bookings", { campaignId: 1, participantId: 1 },
      { unique: true, partialFilterExpression: { status: "confirmed", participantId: { $type: "string" } } }],
    ["campaign_bookings", { campaignId: 1, "guest.handleNorm": 1 },
      { unique: true, partialFilterExpression: { status: "confirmed", "guest.handleNorm": { $type: "string" } } }]
  ];
  for (const [name, keys, opts] of plans) {
    try {
      await db.collection(name).createIndex(keys, opts);
    } catch (err) {
      console.error("Booking index on %s %j failed: %s", name, keys, err.message);
    }
  }
}

module.exports = { mountBookingRoutes, ensureBookingIndexes, rateLimiter };
