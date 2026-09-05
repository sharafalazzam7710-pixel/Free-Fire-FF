import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, activityLogsTable, matchesTable, teamPlayersTable, teamsTable, tournamentInfoTable, tournamentsTable } from "@workspace/db";
import {
  GetAdminActivityResponse,
  GetAdminDashboardResponse,
  GetAdminMatchesResponse,
  GetAdminTeamsResponse,
  GetCurrentTournamentResponse,
  GetPublicScheduleResponse,
  GetPublicTournamentInfoResponse,
  AddTeamPlayerBody,
  UpdateTeamDetailsBody,
  UpdateTeamPlayerBody,
  RecordMatchResultBody,
  RegisterTeamBody,
  RegisterTeamResponse,
  UpdateTournamentInfoBody,
  UpdateTournamentStatusBody,
  UpdateTeamStatusBody,
  WithdrawFromMatchBody,
} from "@workspace/api-zod";

const router: IRouter = Router();
const DEMO_ADMIN_TOKEN = "demo-admin-access";
const PRIVATE_TOURNAMENT_NAME = "البطولة الخاصة";

function adminGuard(req: Request, res: Response, next: NextFunction): void {
  const configuredToken = process.env.ADMIN_ACCESS_TOKEN;
  const token = req.header("x-admin-token");
  if ((configuredToken ?? (process.env.NODE_ENV === "development" ? DEMO_ADMIN_TOKEN : "")) !== token) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }
  next();
}

function parseId(raw: string | string[] | undefined): number {
  return Number.parseInt(Array.isArray(raw) ? raw[0] : raw ?? "", 10);
}

function roundName(size: number): string {
  if (size <= 2) return "النهائي";
  if (size <= 4) return "نصف النهائي";
  if (size <= 8) return "ربع النهائي";
  return `دور الـ${size}`;
}

async function currentTournament() {
  let [tournament] = await db.select().from(tournamentsTable).orderBy(desc(tournamentsTable.id)).limit(1);
  if (!tournament) {
    [tournament] = await db.insert(tournamentsTable).values({
      name: PRIVATE_TOURNAMENT_NAME,
      status: "registration_open",
      registrationStatus: "open",
      maxTeams: 16,
    }).returning();
    await db.insert(tournamentInfoTable).values({
      tournamentId: tournament.id,
      content: "نظام البطولة: Clash Squad\nعدد اللاعبين: 2 لكل فريق\nنظام المنافسة: تصفيات إقصائية\n\nالقوانين:\n- الالتزام بموعد المباراة.\n- يمنع استخدام أي برامج خارجية.\n- قرار الحكم نهائي أثناء المباراة.",
    });
    const seedTeams = [
      ["Falcons", "Omar", "FF-9081", "Laith", "FF-1452"],
      ["Night Raid", "Zaid", "FF-2274", "Kareem", "FF-6019"],
      ["Desert Wolves", "Yazan", "FF-3308", "Sami", "FF-7790"],
      ["Nova Squad", "Tareq", "FF-4126", "Hadi", "FF-8820"],
      ["Red Zone", "Ahmad", "FF-5207", "Bassel", "FF-9304"],
      ["Royal Aim", "Fares", "FF-6412", "Rami", "FF-1178"],
    ];
    await db.insert(teamsTable).values(seedTeams.map((team, index) => ({
      tournamentId: tournament.id,
      number: index + 1,
      name: team[0],
      playerOneName: team[1],
      playerOneId: team[2],
      playerTwoName: team[3],
      playerTwoId: team[4],
    })));
    await addActivity(tournament.id, "tournament_created", "تم تجهيز البطولة الحالية بالبيانات الأساسية");
  } else if (tournament.name !== PRIVATE_TOURNAMENT_NAME) {
    [tournament] = await db.update(tournamentsTable)
      .set({ name: PRIVATE_TOURNAMENT_NAME })
      .where(eq(tournamentsTable.id, tournament.id))
      .returning();
  } else if (tournament.status === "empty") {
    [tournament] = await db.update(tournamentsTable)
      .set({ status: "registration_closed", registrationStatus: "closed" })
      .where(eq(tournamentsTable.id, tournament.id))
      .returning();
  }
  return tournament;
}

async function addActivity(tournamentId: number, action: string, description: string, actor = "admin") {
  await db.insert(activityLogsTable).values({ tournamentId, action, description, actor });
}

async function getTeams(tournamentId: number) {
  return db.select().from(teamsTable).where(eq(teamsTable.tournamentId, tournamentId)).orderBy(asc(teamsTable.number));
}

async function getActiveTeams(tournamentId: number) {
  return db.select().from(teamsTable).where(and(eq(teamsTable.tournamentId, tournamentId), ne(teamsTable.status, "withdrawn"))).orderBy(asc(teamsTable.number));
}

async function getTeamPlayers(team: typeof teamsTable.$inferSelect) {
  let players = await db.select().from(teamPlayersTable).where(eq(teamPlayersTable.teamId, team.id)).orderBy(asc(teamPlayersTable.id));
  if (!players.length) {
    players = await db.insert(teamPlayersTable).values([
      { teamId: team.id, name: team.playerOneName, playerId: team.playerOneId },
      { teamId: team.id, name: team.playerTwoName, playerId: team.playerTwoId },
    ]).returning();
  }
  return players;
}

async function mapAdminTeam(team: typeof teamsTable.$inferSelect) {
  return { ...team, players: await getTeamPlayers(team) };
}

async function syncTeamPlayerColumns(teamId: number) {
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  if (!team) return null;
  const players = await getTeamPlayers(team);
  const first = players[0];
  const second = players[1];
  const [updated] = await db.update(teamsTable).set({
    playerOneName: first?.name ?? "",
    playerOneId: first?.playerId ?? "",
    playerTwoName: second?.name ?? "",
    playerTwoId: second?.playerId ?? "",
  }).where(eq(teamsTable.id, teamId)).returning();
  return updated;
}

function validPlayerValue(value: string) {
  return value.trim().length >= 2 && value.trim().length <= 80 && /^[\p{L}\p{N}_.\- ]+$/u.test(value.trim());
}

async function mapMatches(tournamentId: number) {
  const matches = await db.select().from(matchesTable).where(eq(matchesTable.tournamentId, tournamentId)).orderBy(asc(matchesTable.scheduledAt));
  const ids = matches.flatMap((match) => [match.teamOneId, match.teamTwoId, match.winnerTeamId, match.withdrawnTeamId]).filter((id): id is number => id !== null);
  const teams = ids.length ? await db.select().from(teamsTable).where(inArray(teamsTable.id, [...new Set(ids)])) : [];
  const byId = new Map(teams.map((team) => [team.id, team]));
  return matches.map((match) => ({
    id: match.id,
    matchNumber: match.matchNumber,
    round: match.round,
    teamOne: match.teamOneId ? byId.get(match.teamOneId) ?? null : null,
    teamTwo: match.teamTwoId ? byId.get(match.teamTwoId) ?? null : null,
    winnerTeamId: match.winnerTeamId,
    withdrawnTeamId: match.withdrawnTeamId,
    status: match.status,
    resolution: match.resolution,
    scheduledAt: match.scheduledAt,
    resolvedAt: match.resolvedAt,
  }));
}

async function publicTournament() {
  const tournament = await currentTournament();
  const [next] = await db.select({ scheduledAt: matchesTable.scheduledAt })
    .from(matchesTable)
    .where(and(eq(matchesTable.tournamentId, tournament.id), eq(matchesTable.status, "upcoming")))
    .orderBy(asc(matchesTable.scheduledAt))
    .limit(1);
  return {
    ...tournament,
    teamCount: (await getActiveTeams(tournament.id)).length,
    scheduleVisible: tournament.status === "live" || tournament.status === "finished",
    nextMatchAt: next?.scheduledAt ?? null,
  };
}

router.get("/tournaments/current", async (_req, res): Promise<void> => {
  const result = await publicTournament();
  res.json(GetCurrentTournamentResponse.parse(result));
});

router.post("/tournaments/current/registrations", async (req, res): Promise<void> => {
  const parsed = RegisterTeamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tournament = await currentTournament();
  const userKey = req.header("x-user-id")?.trim();
  if (!userKey) {
    res.status(400).json({ error: "تعذر تحديد المستخدم المسجل" });
    return;
  }
  if (tournament.registrationStatus !== "open" || tournament.status !== "registration_open") {
    res.status(400).json({ error: "التسجيل مغلق حاليًا" });
    return;
  }
  const allTeams = await getTeams(tournament.id);
  const existingTeams = allTeams.filter((team) => team.status !== "withdrawn");
  if (existingTeams.length >= tournament.maxTeams) {
    res.status(400).json({ error: "اكتمل عدد الفرق المسموح به" });
    return;
  }
  const activeTeamIds = existingTeams.map((team) => team.id);
  const storedPlayers = activeTeamIds.length
    ? await db.select().from(teamPlayersTable).where(inArray(teamPlayersTable.teamId, activeTeamIds))
    : [];
  const submittedPlayerIds = [parsed.data.playerOneId.trim().toLowerCase(), parsed.data.playerTwoId.trim().toLowerCase()];
  const duplicatePlayer = existingTeams.some((team) =>
    team.registrationOwnerId === userKey ||
    team.playerOneId.trim().toLowerCase() === submittedPlayerIds[0] ||
    team.playerOneId.trim().toLowerCase() === submittedPlayerIds[1] ||
    team.playerTwoId.trim().toLowerCase() === submittedPlayerIds[0] ||
    team.playerTwoId.trim().toLowerCase() === submittedPlayerIds[1],
  ) || storedPlayers.some((player) => submittedPlayerIds.includes(player.playerId.trim().toLowerCase()));
  if (duplicatePlayer) {
    res.status(409).json({ error: "هذا الحساب مسجل مسبقًا في البطولة" });
    return;
  }
  let team: typeof teamsTable.$inferSelect | undefined;
  try {
    await db.transaction(async (tx) => {
      const [createdTeam] = await tx.insert(teamsTable).values({
        tournamentId: tournament.id,
        registrationOwnerId: userKey,
        number: allTeams.reduce((highest, current) => Math.max(highest, current.number), 0) + 1,
        ...parsed.data,
      }).returning();
      team = createdTeam;
      await tx.insert(teamPlayersTable).values([
        { teamId: createdTeam.id, name: parsed.data.playerOneName, playerId: parsed.data.playerOneId },
        { teamId: createdTeam.id, name: parsed.data.playerTwoName, playerId: parsed.data.playerTwoId },
      ]);
      await tx.insert(activityLogsTable).values({
        tournamentId: tournament.id,
        action: "team_registered",
        description: `تم تسجيل فريق ${createdTeam.name}`,
        actor: "user",
      });
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "هذا المستخدم لديه مشاركة نشطة بالفعل في البطولة" });
      return;
    }
    throw error;
  }
  if (!team) {
    res.status(500).json({ error: "تعذر تثبيت التسجيل" });
    return;
  }
  res.status(201).json(RegisterTeamResponse.parse(team));
});

router.get("/tournaments/current/registrations/me", async (req, res): Promise<void> => {
  const tournament = await currentTournament();
  const userKey = req.header("x-user-id")?.trim();
  if (!userKey) {
    res.json(null);
    return;
  }
  const [team] = await db.select().from(teamsTable).where(and(
    eq(teamsTable.tournamentId, tournament.id),
    eq(teamsTable.registrationOwnerId, userKey),
    ne(teamsTable.status, "withdrawn"),
  )).limit(1);
  res.json(team ? RegisterTeamResponse.parse(team) : null);
});

router.post("/tournaments/current/registrations/withdraw", async (req, res): Promise<void> => {
  const tournament = await currentTournament();
  if (tournament.status === "live" || tournament.status === "finished") {
    res.status(400).json({ error: "لا يمكن الانسحاب بعد بدء البطولة" });
    return;
  }
  const userKey = req.header("x-user-id")?.trim();
  if (!userKey) {
    res.status(400).json({ error: "تعذر تحديد الفريق المسجل" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(and(
    eq(teamsTable.tournamentId, tournament.id),
    eq(teamsTable.registrationOwnerId, userKey),
    ne(teamsTable.status, "withdrawn"),
  )).limit(1);
  if (!team) {
    res.status(404).json({ error: "لا يوجد تسجيل نشط لهذا المستخدم" });
    return;
  }
  const [updated] = await db.transaction(async (tx) => {
    const [withdrawnTeam] = await tx.update(teamsTable)
      .set({ status: "withdrawn" })
      .where(and(
        eq(teamsTable.id, team.id),
        ne(teamsTable.status, "withdrawn"),
      ))
      .returning();
    if (!withdrawnTeam) return [];
    await tx.insert(activityLogsTable).values({
      tournamentId: tournament.id,
      action: "team_withdrawn",
      description: `انسحب فريق ${team.name} من التسجيل`,
      actor: "user",
    });
    return [withdrawnTeam];
  });
  if (!updated) {
    res.status(409).json({ error: "تم تحديث المشاركة مسبقًا" });
    return;
  }
  res.json(RegisterTeamResponse.parse(updated));
});

router.get("/tournaments/current/schedule", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  const matches = await mapMatches(tournament.id);
  res.json(GetPublicScheduleResponse.parse(matches));
});

router.get("/tournaments/current/info", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  let [info] = await db.select().from(tournamentInfoTable).where(eq(tournamentInfoTable.tournamentId, tournament.id)).limit(1);
  if (!info) {
    [info] = await db.insert(tournamentInfoTable).values({ tournamentId: tournament.id, content: "معلومات البطولة قيد الإعداد." }).returning();
  }
  res.json(GetPublicTournamentInfoResponse.parse({
    tournamentId: info.tournamentId,
    content: info.content,
    updatedAt: info.updatedAt,
  }));
});

router.use("/admin", adminGuard);

router.get("/admin/dashboard", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  const teams = await getTeams(tournament.id);
  const participatingTeams = teams.filter((team) => team.status !== "withdrawn");
  const matches = await db.select().from(matchesTable).where(eq(matchesTable.tournamentId, tournament.id));
  const activity = await db.select().from(activityLogsTable).where(eq(activityLogsTable.tournamentId, tournament.id)).orderBy(desc(activityLogsTable.createdAt)).limit(8);
  const resolvedMatches = matches.filter((match) => match.status === "completed" || match.status === "cancelled").length;
  res.json(GetAdminDashboardResponse.parse({
    tournament: { ...tournament, teamCount: participatingTeams.length },
    totalTeams: participatingTeams.length,
    activeTeams: teams.filter((team) => team.status === "active").length,
    resolvedMatches,
    totalMatches: matches.length,
    completionPercent: matches.length ? Math.round((resolvedMatches / matches.length) * 100) : 0,
    recentActivity: activity,
  }));
});

router.get("/admin/teams", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  const teams = await getTeams(tournament.id);
  res.json(GetAdminTeamsResponse.parse(await Promise.all(teams.map(mapAdminTeam))));
});

router.patch("/admin/teams/:teamId", async (req, res): Promise<void> => {
  const teamId = parseId(req.params.teamId);
  const parsed = UpdateTeamDetailsBody.safeParse(req.body);
  if (!Number.isFinite(teamId) || !parsed.success || parsed.data.name.trim().length < 2) {
    res.status(400).json({ error: "اسم الفريق غير صالح" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  if (!team) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  const [updated] = await db.update(teamsTable).set({ name: parsed.data.name.trim() }).where(eq(teamsTable.id, teamId)).returning();
  await addActivity(team.tournamentId, "team_updated", `تم تعديل بيانات فريق ${updated.name}`);
  res.json(await mapAdminTeam(updated));
});

router.post("/admin/teams/:teamId/players", async (req, res): Promise<void> => {
  const teamId = parseId(req.params.teamId);
  const parsed = AddTeamPlayerBody.safeParse(req.body);
  if (!Number.isFinite(teamId) || !parsed.success || !validPlayerValue(parsed.data.name) || !validPlayerValue(parsed.data.playerId)) {
    res.status(400).json({ error: "بيانات اللاعب غير صالحة" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  if (!team) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  const players = await getTeamPlayers(team);
  const playerId = parsed.data.playerId.trim();
  if (players.some((player) => player.playerId.toLowerCase() === playerId.toLowerCase())) {
    res.status(409).json({ error: "هذا ID مسجل مسبقًا في الفريق" });
    return;
  }
  await db.insert(teamPlayersTable).values({ teamId, name: parsed.data.name.trim(), playerId });
  const updated = await syncTeamPlayerColumns(teamId);
  if (!updated) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  await addActivity(team.tournamentId, "team_player_added", `تمت إضافة لاعب إلى فريق ${team.name}`);
  res.json(await mapAdminTeam(updated));
});

router.patch("/admin/teams/:teamId/players/:playerId", async (req, res): Promise<void> => {
  const teamId = parseId(req.params.teamId);
  const playerRecordId = parseId(req.params.playerId);
  const parsed = UpdateTeamPlayerBody.safeParse(req.body);
  if (!Number.isFinite(teamId) || !Number.isFinite(playerRecordId) || !parsed.success || !validPlayerValue(parsed.data.name) || !validPlayerValue(parsed.data.playerId)) {
    res.status(400).json({ error: "بيانات اللاعب غير صالحة" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  const [player] = await db.select().from(teamPlayersTable).where(and(eq(teamPlayersTable.id, playerRecordId), eq(teamPlayersTable.teamId, teamId)));
  if (!team || !player) {
    res.status(404).json({ error: "الفريق أو اللاعب غير موجود" });
    return;
  }
  const playerId = parsed.data.playerId.trim();
  const players = await getTeamPlayers(team);
  if (players.some((item) => item.id !== playerRecordId && item.playerId.toLowerCase() === playerId.toLowerCase())) {
    res.status(409).json({ error: "هذا ID مسجل مسبقًا في الفريق" });
    return;
  }
  await db.update(teamPlayersTable).set({ name: parsed.data.name.trim(), playerId }).where(eq(teamPlayersTable.id, playerRecordId));
  const updated = await syncTeamPlayerColumns(teamId);
  if (!updated) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  await addActivity(team.tournamentId, "team_player_updated", `تم تعديل لاعب في فريق ${team.name}`);
  res.json(await mapAdminTeam(updated));
});

router.delete("/admin/teams/:teamId/players/:playerId", async (req, res): Promise<void> => {
  const teamId = parseId(req.params.teamId);
  const playerRecordId = parseId(req.params.playerId);
  if (!Number.isFinite(teamId) || !Number.isFinite(playerRecordId)) {
    res.status(400).json({ error: "معرّف اللاعب غير صالح" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  const players = team ? await getTeamPlayers(team) : [];
  const player = players.find((item) => item.id === playerRecordId);
  if (!team || !player) {
    res.status(404).json({ error: "الفريق أو اللاعب غير موجود" });
    return;
  }
  if (players.length <= 1) {
    res.status(400).json({ error: "يجب أن يبقى لاعب واحد على الأقل في الفريق" });
    return;
  }
  await db.delete(teamPlayersTable).where(and(eq(teamPlayersTable.id, playerRecordId), eq(teamPlayersTable.teamId, teamId)));
  const updated = await syncTeamPlayerColumns(teamId);
  if (!updated) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  await addActivity(team.tournamentId, "team_player_deleted", `تم حذف لاعب من فريق ${team.name}`);
  res.json(await mapAdminTeam(updated));
});

router.get("/admin/matches", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  res.json(GetAdminMatchesResponse.parse(await mapMatches(tournament.id)));
});

router.get("/admin/activity", async (_req, res): Promise<void> => {
  const tournament = await currentTournament();
  const activity = await db.select().from(activityLogsTable).where(eq(activityLogsTable.tournamentId, tournament.id)).orderBy(desc(activityLogsTable.createdAt)).limit(20);
  res.json(GetAdminActivityResponse.parse(activity));
});

router.patch("/admin/tournaments/current", async (req, res): Promise<void> => {
  const parsed = UpdateTournamentStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tournament = await currentTournament();
  if (parsed.data.action === "open_registration" && tournament.status !== "registration_closed") {
    res.status(400).json({ error: "لا يمكن فتح التسجيل إلا بعد إغلاقه" });
    return;
  }
  if (parsed.data.action === "close_registration" && tournament.status !== "registration_open") {
    res.status(400).json({ error: "التسجيل مغلق بالفعل أو أن البطولة بدأت" });
    return;
  }
  if (parsed.data.action === "start" && tournament.status !== "registration_closed") {
    res.status(400).json({ error: "يجب إغلاق التسجيل قبل بدء البطولة" });
    return;
  }
  if (parsed.data.action === "finish" && tournament.status !== "live") {
    res.status(400).json({ error: "لا يمكن إنهاء البطولة قبل بدء المنافسات" });
    return;
  }
  if (parsed.data.action === "start") {
    const teams = (await getTeams(tournament.id)).filter((team) => team.status === "active");
    if (teams.length < 2) {
      res.status(400).json({ error: "تحتاج البطولة إلى فريقين على الأقل" });
      return;
    }
    const size = Math.max(2, 2 ** Math.ceil(Math.log2(teams.length)));
    const firstStart = new Date(Date.now() + 60 * 60 * 1000);
    const existing = await db.select().from(matchesTable).where(eq(matchesTable.tournamentId, tournament.id));
    if (!existing.length) {
      const padded = [...teams, ...Array.from({ length: size - teams.length }, () => null)];
      await db.insert(matchesTable).values(Array.from({ length: size / 2 }, (_, index) => {
        const teamOne = padded[index * 2];
        const teamTwo = padded[index * 2 + 1];
        const bye = !teamOne || !teamTwo;
        return {
          tournamentId: tournament.id,
          matchNumber: index + 1,
          round: roundName(size),
          teamOneId: teamOne?.id ?? null,
          teamTwoId: teamTwo?.id ?? null,
          winnerTeamId: bye ? (teamOne?.id ?? teamTwo?.id ?? null) : null,
          status: bye ? "completed" : "upcoming",
          resolution: bye ? "walkover" : "pending",
          scheduledAt: new Date(firstStart.getTime() + index * 30 * 60 * 1000),
          resolvedAt: bye ? new Date() : null,
        };
      }));
    }
    await db.update(tournamentsTable).set({ status: "live", registrationStatus: "closed", startsAt: new Date() }).where(eq(tournamentsTable.id, tournament.id));
    await addActivity(tournament.id, "tournament_started", "تم بدء البطولة وإنشاء جدول المواجهات");
  } else if (parsed.data.action === "finish") {
    await db.update(tournamentsTable).set({ status: "finished", registrationStatus: "closed" }).where(eq(tournamentsTable.id, tournament.id));
    await addActivity(tournament.id, "tournament_finished", "تمت أرشفة البطولة وإنهاء المنافسات");
  } else {
    const updates = parsed.data.action === "open_registration"
      ? { status: "registration_open" as const, registrationStatus: "open" as const }
      : { status: "registration_closed" as const, registrationStatus: "closed" as const };
    await db.update(tournamentsTable).set(updates).where(eq(tournamentsTable.id, tournament.id));
    await addActivity(tournament.id, `tournament_${parsed.data.action}`, "تم تحديث حالة البطولة");
  }
  const [updated] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournament.id));
  const teamCount = (await getActiveTeams(tournament.id)).length;
  res.json({ ...updated, teamCount });
});

router.patch("/admin/tournaments/current/info", async (req, res): Promise<void> => {
  const parsed = UpdateTournamentInfoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tournament = await currentTournament();
  const [info] = await db.update(tournamentInfoTable).set({ content: parsed.data.content, updatedAt: new Date() }).where(eq(tournamentInfoTable.tournamentId, tournament.id)).returning();
  await addActivity(tournament.id, "info_updated", "تم تحديث معلومات وقوانين البطولة");
  res.json(GetPublicTournamentInfoResponse.parse({ tournamentId: info.tournamentId, content: info.content, updatedAt: info.updatedAt }));
});

async function resolveMatch(matchId: number, winnerTeamId: number, withdrawnTeamId: number | null, resolution: string) {
  const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, matchId));
  if (!match) return null;
  if (match.status === "completed" || match.status === "cancelled") return "resolved";
  const tournamentId = match.tournamentId;
  await db.transaction(async (tx) => {
    await tx.update(matchesTable).set({
      winnerTeamId,
      withdrawnTeamId,
      status: "completed",
      resolution,
      resolvedAt: new Date(),
    }).where(eq(matchesTable.id, matchId));
    const losers = [match.teamOneId, match.teamTwoId].filter((id): id is number => id !== null && id !== winnerTeamId);
    if (losers.length) await tx.update(teamsTable).set({ status: "eliminated" }).where(inArray(teamsTable.id, losers));
    await tx.update(teamsTable).set({ status: "winner" }).where(eq(teamsTable.id, winnerTeamId));
    const allMatches = await tx.select().from(matchesTable).where(eq(matchesTable.tournamentId, tournamentId));
    const currentRoundMatches = allMatches.filter((item) => item.round === match.round);
    const index = currentRoundMatches.findIndex((item) => item.id === matchId);
    const pair = currentRoundMatches[index % 2 === 0 ? index + 1 : index - 1];
    const nextRoundName = pair ? roundName(Math.max(2, currentRoundMatches.length)) : "النهائي";
    if (pair && pair.winnerTeamId) {
      const nextRoundMatches = allMatches.filter((item) => item.round === nextRoundName);
      const next = nextRoundMatches[Math.floor(index / 2)];
      if (next) {
        await tx.update(matchesTable).set(index % 2 === 0 ? { teamOneId: winnerTeamId } : { teamTwoId: winnerTeamId }).where(eq(matchesTable.id, next.id));
      } else {
        await tx.insert(matchesTable).values({
          tournamentId,
          matchNumber: allMatches.length + 1,
          round: nextRoundName,
          teamOneId: index % 2 === 0 ? winnerTeamId : pair.winnerTeamId,
          teamTwoId: index % 2 === 0 ? pair.winnerTeamId : winnerTeamId,
          status: "upcoming",
          resolution: "pending",
          scheduledAt: new Date(Date.now() + 30 * 60 * 1000),
        });
      }
    }
    await tx.insert(activityLogsTable).values({
      tournamentId,
      action: resolution === "walkover" ? "match_withdrawal" : "match_result",
      description: resolution === "walkover" ? "حُسمت المباراة بسبب انسحاب فريق" : "تم تسجيل نتيجة المباراة",
      actor: "admin",
    });
  });
  return true;
}

router.post("/admin/matches/:matchId/result", async (req, res): Promise<void> => {
  const paramsId = parseId(req.params.matchId);
  const parsed = RecordMatchResultBody.safeParse(req.body);
  if (!Number.isFinite(paramsId) || !parsed.success) {
    res.status(400).json({ error: "بيانات نتيجة المباراة غير صالحة" });
    return;
  }
  const result = await resolveMatch(paramsId, parsed.data.winnerTeamId, null, "normal_win");
  if (result === "resolved") {
    res.status(409).json({ error: "تم حسم هذه المباراة مسبقًا" });
    return;
  }
  if (!result) {
    res.status(404).json({ error: "المباراة غير موجودة" });
    return;
  }
  const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, paramsId));
  const mapped = (await mapMatches(match.tournamentId)).find((item) => item.id === paramsId);
  res.json(mapped);
});

router.post("/admin/matches/:matchId/withdraw", async (req, res): Promise<void> => {
  const paramsId = parseId(req.params.matchId);
  const parsed = WithdrawFromMatchBody.safeParse(req.body);
  if (!Number.isFinite(paramsId) || !parsed.success) {
    res.status(400).json({ error: "بيانات الانسحاب غير صالحة" });
    return;
  }
  const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, paramsId));
  if (!match || match.status === "completed" || match.status === "cancelled") {
    res.status(409).json({ error: "لا يمكن تعديل مباراة محسومة" });
    return;
  }
  const winner = match.teamOneId === parsed.data.withdrawnTeamId ? match.teamTwoId : match.teamOneId;
  if (!winner) {
    res.status(400).json({ error: "لا يوجد خصم مؤهل تلقائيًا" });
    return;
  }
  await db.update(teamsTable).set({ status: "withdrawn" }).where(eq(teamsTable.id, parsed.data.withdrawnTeamId));
  await resolveMatch(paramsId, winner, parsed.data.withdrawnTeamId, "walkover");
  const mapped = (await mapMatches(match.tournamentId)).find((item) => item.id === paramsId);
  res.json(mapped);
});

router.post("/admin/teams/:teamId/status", async (req, res): Promise<void> => {
  const teamId = parseId(req.params.teamId);
  const parsed = UpdateTeamStatusBody.safeParse(req.body);
  if (!Number.isFinite(teamId) || !parsed.success) {
    res.status(400).json({ error: "بيانات حالة الفريق غير صالحة" });
    return;
  }
  const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  if (!team) {
    res.status(404).json({ error: "الفريق غير موجود" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(teamsTable).set({ status: parsed.data.status }).where(eq(teamsTable.id, teamId));
    if (parsed.data.cascadeToMatches && ["withdrawn", "expelled"].includes(parsed.data.status)) {
      const related = await tx.select().from(matchesTable).where(and(eq(matchesTable.tournamentId, team.tournamentId), sql`${matchesTable.status} = 'upcoming' AND (${matchesTable.teamOneId} = ${teamId} OR ${matchesTable.teamTwoId} = ${teamId})`));
      if (related.length) {
        await tx.update(matchesTable).set({ status: "cancelled", resolution: "cancelled_withdrawal", withdrawnTeamId: teamId, resolvedAt: new Date() }).where(inArray(matchesTable.id, related.map((match) => match.id)));
      }
    }
    await tx.insert(activityLogsTable).values({ tournamentId: team.tournamentId, action: "team_status_changed", description: `تم تحديث حالة ${team.name} إلى ${parsed.data.status}`, actor: "admin" });
  });
  const [updated] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  res.json(updated);
});

export default router;