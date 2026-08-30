import { existsSync, statSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

export class Telemetry {
  constructor() {
    this.startedAt = Date.now();
    this.messages = [];
    this.callErrors = 0;
    this.iceRestarts = 0;
    this.turnFailures = 0;
    this.calls = new Map();
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = process.hrtime.bigint();
  }

  message() {
    const now = Date.now();
    this.messages.push(now);
    while (this.messages[0] < now - 60_000) this.messages.shift();
  }

  joinCall(channelId, userId, mode) {
    const call = this.calls.get(channelId) ?? { mode, users: new Set() };
    call.users.add(userId);
    this.calls.set(channelId, call);
  }

  leaveCall(channelId, userId) {
    const call = this.calls.get(channelId);
    if (!call) return;
    call.users.delete(userId);
    if (!call.users.size) this.calls.delete(channelId);
  }

  callError() { this.callErrors += 1; }
  iceRestart() { this.iceRestarts += 1; }
  turnFailure() { this.turnFailures += 1; }

  cpuPercent() {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage(this.previousCpu);
    const elapsedMicros = Number(now - this.previousCpuAt) / 1000;
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = now;
    return elapsedMicros > 0 ? Math.min(100, Math.round(((usage.user + usage.system) / elapsedMicros) * 1000) / 10) : 0;
  }

  snapshot(io, database, onlineUsers) {
    const memory = process.memoryUsage();
    const filename = database.name;
    const fileSize = filename && filename !== ":memory:" && existsSync(filename) ? statSync(filename).size : 0;
    const walPath = filename && filename !== ":memory:" ? `${filename}-wal` : null;
    const walSize = walPath && existsSync(walPath) ? statSync(walPath).size : 0;
    let usersInCalls = 0;
    let p2p = 0;
    let sfu = 0;
    for (const call of this.calls.values()) {
      usersInCalls += call.users.size;
      if (call.mode === "sfu") sfu += 1;
      else p2p += 1;
    }
    return {
      server: {
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuPercent: this.cpuPercent(),
        eventLoopP95Ms: Math.round(this.eventLoop.percentile(95) / 1e6 * 10) / 10,
        socketClients: io.engine.clientsCount,
      },
      users: { online: onlineUsers },
      calls: { active: this.calls.size, users: usersInCalls, p2p, sfu, errors: this.callErrors, iceRestarts: this.iceRestarts, turnFailures: this.turnFailures },
      chat: { messagesPerMinute: this.messages.length },
      database: {
        sizeBytes: fileSize,
        walBytes: walSize,
        pageCount: database.pragma("page_count", { simple: true }),
        freelistPages: database.pragma("freelist_count", { simple: true }),
      },
    };
  }

  close() { this.eventLoop.disable(); }
}
