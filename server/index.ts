import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import prisma from "./prisma.js";
import { getYouTubeVideos, type Videos } from "./getYoutubeVideos.js";

console.log("[socket] DATABASE_URL =", process.env.DATABASE_URL);

const PORT = parseInt(process.env.PORT || "3001");

const app = new Hono();

const httpServer = serve({
  fetch: app.fetch,
  port: PORT,
});

const io = new Server(httpServer as HTTPServer, {
  cors: { origin: "*" },
});

type PlayerScore = { id: string; name: string; points: number };

const ROUND_SECONDS = 30;
const BETWEEN_ROUNDS_SECONDS = 3;

const ANSWERS = ["more songs", "next song", "final song"];

function roomKey(lobbyId: string) {
  return `lobby:${lobbyId}`;
}

function toScores(
  users: Array<{
    clerkId: string;
    name: string | null;
    email: string;
    points: number;
  }>,
): PlayerScore[] {
  return users
    .map((u) => ({
      id: u.clerkId,
      name: u.name ?? u.email ?? "Player",
      points: u.points ?? 0,
    }))
    .sort((a, b) => b.points - a.points);
}

const lobbyTimers = new Map<
  string,
  { tick?: NodeJS.Timeout; between?: NodeJS.Timeout }
>();

function clearLobbyTimers(lobbyId: string) {
  const t = lobbyTimers.get(lobbyId);
  if (t?.tick) clearInterval(t.tick);
  if (t?.between) clearTimeout(t.between);
  lobbyTimers.delete(lobbyId);
}

async function startRoundInDb(
  lobbyId: string,
  round: number,
  musics: { id: string; title: string }[],
) {
  if (musics.length === 0) {
    const key = roomKey(lobbyId);
    await prisma.lobby.update({
      where: { id: Number(lobbyId) },
      data: {
        phase: "FINISHED",
        phaseEndsAt: null,
        roundEndsAt: null,
        currentMusic: null,
      },
    });
    io.to(key).emit("game-finished", { lobbyId, scores: [] });
    return;
  }

  const now = new Date();
  const roundEndsAt = new Date(now.getTime() + ROUND_SECONDS * 1000);
  const randomIndex = Math.floor(Math.random() * musics.length);
  const music = musics[randomIndex];
  const musicsTitles = musics.map((m) => m.title);

  await prisma.lobby.update({
    where: { id: Number(lobbyId) },
    data: {
      phase: "PLAYING",
      round,
      roundEndsAt,
      phaseEndsAt: null,
      currentMusic: music.id,
    },
  });

  const lobby = await prisma.lobby.findFirst({
    where: { id: Number(lobbyId) },
    include: { users: true },
  });
  if (!lobby) return;

  const key = roomKey(lobbyId);

  io.to(key).emit("game-started", {
    lobbyId,
    round: lobby.round,
    timeLeft: ROUND_SECONDS,
    scores: toScores(lobby.users),
    musicId: music.id,
    musicTitle: music.title,
    musicsTitles: musicsTitles,
  });

  clearLobbyTimers(lobbyId);
  const tick = setInterval(async () => {
    const fresh = await prisma.lobby.findFirst({
      where: { id: Number(lobbyId) },
      select: { roundEndsAt: true, phase: true, round: true },
    });
    if (!fresh) {
      clearLobbyTimers(lobbyId);
      return;
    }

    if (String(fresh.phase) !== "PLAYING") return;

    const left = fresh.roundEndsAt
      ? Math.max(
          0,
          Math.ceil((fresh.roundEndsAt.getTime() - Date.now()) / 1000),
        )
      : 0;

    io.to(key).emit("game-tick", {
      lobbyId,
      round: fresh.round,
      timeLeft: left,
    });

    if (left <= 0) {
      clearLobbyTimers(lobbyId);
      musics.splice(randomIndex, 1);
      await revealRoundInDb(lobbyId, musics);
    }
  }, 1000);

  lobbyTimers.set(lobbyId, { tick });
}

async function revealRoundInDb(
  lobbyId: string,
  musics: { id: string; title: string }[],
) {
  const lobby = await prisma.lobby.findFirst({
    where: { id: Number(lobbyId) },
    select: { round: true },
  });
  if (!lobby) return;

  const round = lobby.round;
  const answer = ANSWERS[round - 1] ?? "—";
  const phaseEndsAt = new Date(Date.now() + BETWEEN_ROUNDS_SECONDS * 1000);

  await prisma.lobby.update({
    where: { id: Number(lobbyId) },
    data: { phase: "REVEALING", phaseEndsAt, roundEndsAt: null },
  });

  const key = roomKey(lobbyId);
  io.to(key).emit("round-reveal", { lobbyId, round, answer });

  const between = setTimeout(async () => {
    const fresh = await prisma.lobby.findFirst({
      where: { id: Number(lobbyId) },
      select: { round: true, rounds: true },
    });
    if (!fresh) return;

    if (fresh.round >= fresh.rounds) {
      await prisma.lobby.update({
        where: { id: Number(lobbyId) },
        data: { phase: "FINISHED", phaseEndsAt: null, roundEndsAt: null },
      });

      const withUsers = await prisma.lobby.findFirst({
        where: { id: Number(lobbyId) },
        include: { users: true },
      });

      if (withUsers?.users) {
        withUsers.users.forEach(
          async (user: {
            id: number;
            globalPoints: number;
            points: number;
          }) => {
            await prisma.user.update({
              where: {
                id: user.id,
              },
              data: {
                globalPoints: user.globalPoints + user.points,
                points: 0,
              },
            });
          },
        );
      }

      io.to(key).emit("game-finished", {
        lobbyId,
        scores: toScores(withUsers?.users ?? []),
      });

      return;
    }

    await startRoundInDb(lobbyId, fresh.round + 1, musics);
  }, BETWEEN_ROUNDS_SECONDS * 1000);

  lobbyTimers.set(lobbyId, { between });
}

async function handleLeave(opts: { lobbyId: string; userId: string }) {
  const { lobbyId, userId } = opts;
  const lobbyIdNum = Number(lobbyId);
  if (!Number.isInteger(lobbyIdNum)) return;

  const key = roomKey(lobbyId);

  console.log("USER", userId, "LEFT LOBBY", lobbyId);

  const user = await prisma.user.update({
    where: { clerkId: userId },
    data: { lobbyId: null },
  });

  const lobby = await prisma.lobby.findFirst({
    where: { id: lobbyIdNum },
  });

  const updatedPlayers = await prisma.user.findMany({
    where: { lobbyId: lobbyIdNum },
  });

  if (updatedPlayers.length === 0) {
    clearLobbyTimers(lobbyId);
    await prisma.lobby.delete({ where: { id: lobbyIdNum } });
    console.log("LOBBY", { lobbyId }, "IS DELETED");
    return;
  }

  if (lobby?.hostId === user?.clerkId) {
    io.to(key).emit("leave-lobby");
  } else {
    io.to(key).emit("lobby-updated", { lobbyId, players: updatedPlayers });
  }
}

io.on("connection", async (socket) => {
  console.log("connected", socket.id);

  const pingTimer = setInterval(() => {
    socket.emit("ping", { message: "ping" });
  }, 30000);

  socket.on(
    "join-lobby",
    async (payload: { lobbyId: string; userId: string }) => {
      const { lobbyId, userId } = payload;
      const key = roomKey(lobbyId);

      socket.data.lobbyId = lobbyId;
      socket.data.userId = userId;

      const players = await prisma.user.findMany({
        where: { lobbyId: Number(lobbyId) },
      });

      const lobby = await prisma.lobby.findFirst({
        where: { id: Number(lobbyId) },
      });

      socket.join(key);
      io.to(key).emit("lobby-updated", {
        lobbyId,
        players,
        hostId: lobby?.hostId,
      });
    },
  );

  socket.on(
    "leave-lobby",
    async (payload: { lobbyId: string; userId: string }) => {
      const { lobbyId, userId } = payload;
      socket.leave(roomKey(lobbyId));
      await handleLeave({ lobbyId, userId });
    },
  );

  socket.on(
    "start-game",
    async (payload: { lobbyId: string; userId: string }) => {
      const { lobbyId, userId } = payload;
      const key = roomKey(lobbyId);

      const lobby = await prisma.lobby.findFirst({
        where: { id: Number(lobbyId) },
        include: { users: true },
      });

      const user = await prisma.user.findFirst({
        where: { clerkId: userId },
      });

      if (!lobby || lobby.hostId !== userId) return;

      const playlist = await getYouTubeVideos({
        access_token: user?.access_token || "",
        playlistId: lobby.playlistId || "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj",
      });

      if (!playlist?.items?.length) {
        console.log("PROBLEM WITH PLAYLIST", "USER ACCESS TOKEN", user?.access_token, "PLAYLIST ID", lobby.playlistId)
        return;
      }

      const musics = playlist.items
        .map((item: Videos["items"][number]) => ({
          id: item.contentDetails?.videoId,
          title:
            `${item.snippet?.title ?? ""} - ${item.snippet?.videoOwnerChannelTitle ?? ""}`.trim(),
        }))
        .filter(
          (m): m is { id: string; title: string } =>
            Boolean(m.id) && Boolean(m.title),
        );

      if (musics.length === 0) {
        console.log("MUSICS LENGTH 0")
        return;
      }

      io.to(key).emit("start-game");

      await prisma.user.updateMany({
        where: { lobbyId: Number(lobbyId) },
        data: { points: 0, lastCorrectRound: 0 },
      });

      clearLobbyTimers(lobbyId);
      await prisma.lobby.update({
        where: { id: Number(lobbyId) },
        data: {
          round: 1,
          phase: "WAITING",
          roundEndsAt: null,
          phaseEndsAt: null,
        },
      });

      await startRoundInDb(lobbyId, 1, musics);
    },
  );

  socket.on(
    "submit-guess",
    async (payload: {
      lobbyId: string;
      userId: string;
      guess: string;
      correctAnswer: string;
    }) => {
      const { lobbyId, userId, guess, correctAnswer } = payload;

      const lobby = await prisma.lobby.findFirst({
        where: { id: Number(lobbyId) },
        select: { phase: true, round: true },
      });
      if (!lobby) return;
      if (String(lobby.phase) !== "PLAYING") return;

      if (!correctAnswer || !guess) return;
      if (guess !== correctAnswer) return;

      const updated = await prisma.user.updateMany({
        where: {
          clerkId: userId,
          lobbyId: Number(lobbyId),
          NOT: { lastCorrectRound: lobby.round },
        },
        data: {
          points: { increment: 1 },
          lastCorrectRound: lobby.round,
        },
      });

      if (updated.count > 0) {
        const players = await prisma.user.findMany({
          where: { lobbyId: Number(lobbyId) },
          select: { clerkId: true, name: true, email: true, points: true },
        });

        io.to(roomKey(lobbyId)).emit("scores-updated", {
          lobbyId,
          scores: toScores(players),
        });
      }
    },
  );

  socket.on("disconnect", async () => {
    clearInterval(pingTimer);

    const lobbyId = socket.data.lobbyId as string | undefined;
    const userId = socket.data.userId as string | undefined;

    console.log("disconnected", socket.id, lobbyId, userId);

    if (!lobbyId || !userId) return;
    await handleLeave({ lobbyId, userId });
  });
});

httpServer.on("listening", async () => {
  console.log(`Hono server listening on http://localhost:${PORT}`);
});
