// 处理录制断流、自然断开和写盘失败后的恢复，保证续写前先停旧引擎。
import { type RoomPolicySettings } from "../../config/room-policy.js";
import type { RecordingSourceResult } from "../../platform/adapter.js";
import { AppError } from "../../types/error.js";
import type {
  AppSettings,
  ErrorObject,
  RecordingEndReason,
  Room,
} from "../../types/index.js";
import {
  causeLabel,
  humanizeFailure,
  isWriteFailure,
  reconnectExhausted,
  writeRestartExhausted,
} from "../recording-failure.js";
import type { Services } from "../services.js";
import {
  RECONNECT_ALERT_AFTER_MS,
  RECONNECT_CHAIN_SEC,
  STABLE_RESET_MS,
  WRITE_RESTART_ATTEMPTS,
} from "./constants.js";
import type { ActiveSession } from "./types.js";

interface RecordingRecoveryHost {
  readonly active: Map<string, ActiveSession>;
  finishInterrupted(
    room: Room,
    recordingId: string,
    err: AppError,
    preservePreview?: boolean,
  ): Promise<void>;
  settingsForRecording(room: Room, session?: ActiveSession): AppSettings;
  readonly shuttingDown: boolean;
  completeRecording(
    room: Room,
    recordingId: string,
    size: number,
    endReason: "ended" | "stream_lost",
    options?: {
      preservePreview?: boolean;
      endReason?: RecordingEndReason;
      failure?: ErrorObject | null;
    },
  ): Promise<void>;
  raiseAlert(
    level: "info" | "warning" | "error",
    source: string,
    err: AppError | ErrorObject,
  ): void;
  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(room: Room, settings?: RoomPolicySettings | null): Room;
  runSession(
    room: Room,
    recordingId: string,
    stream: {
      url: string;
      format: "flv" | "hls" | "youtube";
      youtube?: NonNullable<
        import("../../recorder/engine.js").StreamInput["youtube"]
      >;
      headers?: Record<string, string>;
    },
    filePath: string,
    session: ActiveSession,
    attempt: number,
    existingEngine?: import("../../recorder/engine.js").RecordingEngine,
  ): Promise<void>;
}

export class RecordingRecovery {
  constructor(
    private services: Services,
    private host: RecordingRecoveryHost,
  ) {}
  /**
   * 断流重连：退避后重新取地址继续拉流，恢复后接着写同一个文件——不新开文件、不新建记录。
   * 稳定录满 STABLE_RESET_MS 后重置退避；可重试故障持续恢复，确认下播或用户停止才收尾。
   */
  async handleDisconnect(
    room: Room,
    recordingId: string,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    const session = this.host.active.get(room.id);
    if (!session) return;
    // 启动超时与随后的断流可能同时触发重连：只允许一次接力在途。
    await this.withHandoff(session, () =>
      this.handleDisconnectInner(
        room,
        recordingId,
        session,
        error,
        attempt,
        endTimestampMs,
      ),
    );
  }

  private async handleDisconnectInner(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    // 本段写到哪：下一段时间戳从这里接着走，拼接处不会跳回开头。
    if (endTimestampMs > session.timestampOffsetMs)
      session.timestampOffsetMs = endTimestampMs;
    if (endTimestampMs > 0) session.mediaPositionMs = endTimestampMs;
    // 缺失时长从"最后一次收到数据"算起，恢复拿到数据时结算。
    if (session.gapStartAt === null)
      session.gapStartAt = session.lastDataAt || this.services.clock.now();
    session.gapCause = error;
    console.log(
      `[recording-recovery] id=${recordingId} generation=${session.generation} cause=${error.code} trigger=${error.details?.trigger ?? "source_error"} lastDataAgeMs=${Math.max(0, this.services.clock.now() - session.lastDataAt)}`,
    );

    // 写盘类失败与网络无关，网络重试没有意义；但磁盘瞬时故障（USB 抖动/休眠唤醒）值得
    // 自动恢复（PrePan 需求①）：退避限次重启新段续录、每场累计封顶，每次尝试落日志与
    // 失败原因，重启也失败/封顶耗尽才终停（终停必带明确原因）。其他非可重试错误维持直接收尾。
    if (error.retryable === false) {
      if (isWriteFailure(error)) {
        await this.restartAfterWriteFailure(room, recordingId, session, error);
      } else {
        await this.host.finishInterrupted(
          room,
          recordingId,
          humanizeFailure(error),
        );
      }
      return;
    }

    const settings = this.host.settingsForRecording(room, session);
    // Preserve the explicit opt-out; positive legacy attempt counts no longer cap network recovery.
    if (settings.retry.maxAttempts === 0) {
      await this.host.finishInterrupted(
        room,
        recordingId,
        reconnectExhausted(error, 0),
      );
      return;
    }
    // 稳定录满 STABLE_RESET_MS 后重置退避阶段，旧故障不拖慢新的恢复。
    let effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    let cause = error;

    // Transient failures keep recovering. Only confirmed offline, explicit stop,
    // shutdown, deletion, or a non-retryable error ends this loop.
    // 告警周期以实际媒体恢复为界，不跟随退避次数或拉流代次重置。
    if (session.reconnectSince === undefined) {
      session.reconnectSince = this.services.clock.now();
      session.recoveringAlerted = false;
    }
    const reconnectSince = session.reconnectSince;
    for (;;) {
      if (this.host.shuttingDown || this.host.active.get(room.id) !== session)
        return;
      if (session.stopRequested) {
        await this.host.completeRecording(
          room,
          recordingId,
          session.size,
          "ended",
          {
            endReason: session.requestedEndReason ?? "stopped",
          },
        );
        return;
      }
      if (cause.retryable === false) {
        if (isWriteFailure(cause))
          await this.restartAfterWriteFailure(
            room,
            recordingId,
            session,
            cause,
          );
        else
          await this.host.finishInterrupted(
            room,
            recordingId,
            humanizeFailure(cause),
          );
        return;
      }
      if (
        !session.recoveringAlerted &&
        this.services.clock.now() - reconnectSince >= RECONNECT_ALERT_AFTER_MS
      ) {
        session.recoveringAlerted = true;
        // 坑点：告警只提示不改行为——持续重试不停录是产品底线，此处绝不触发收尾。
        this.host.raiseAlert(
          "warning",
          "recorder",
          new AppError("NETWORK_UNAVAILABLE", "正在努力恢复该直播间录制", {
            roomId: room.id,
            retryable: true,
          }),
        );
      }
      const prevState = this.services.rooms.get(room.id)?.monitorState;
      const recording = this.services.recordings.update(recordingId, {
        state: "reconnecting",
        retryCount: effective,
      });
      this.services.rooms.setState(room.id, "reconnecting");
      // 状态真变了才补发房间事件：退避循环每轮重试都会重复 setState，无守卫则每轮广播冗余 room:updated；
      // 而只发 recording:updated 会让监控卡片/列表停留在「录制中」直到下个检测周期（前端靠 room:updated 切「重连中」）。
      if (prevState !== "reconnecting") {
        const fresh = this.services.rooms.get(room.id);
        if (fresh) {
          this.services.events.emit({
            type: "room:updated",
            data: this.host.enrichRoom(fresh),
          });
        }
      }
      this.services.events.emit({ type: "recording:updated", data: recording });

      // Network recovery keeps retrying until confirmed offline or explicitly stopped.
      const delay =
        RECONNECT_CHAIN_SEC[
          Math.min(effective, RECONNECT_CHAIN_SEC.length - 1)
        ] ?? 0;
      console.log(
        `[recording-retry] id=${recordingId} attempt=${effective + 1} cause=${cause.code} trigger=${cause.details?.trigger ?? "source_error"}`,
      );
      const alertedCodes = (session.reconnectAlertCodes ??= new Set());
      if (!alertedCodes.has(cause.code)) {
        this.host.raiseAlert(
          "warning",
          "recorder",
          new AppError(
            cause.code,
            `${causeLabel(cause.code, cause.details)}，正在自动重试（第 ${effective + 1} 次）`,
            {
              roomId: room.id,
              recordingId,
              retryable: true,
              ...(cause.details ? { details: cause.details } : {}),
            },
          ),
        );
        alertedCodes.add(cause.code);
      }

      await this.waitForReconnect(
        session,
        Math.min(30_000, delay * 1000 * (0.8 + Math.random() * 0.4)),
      );
      if (this.host.shuttingDown || this.host.active.get(room.id) !== session)
        return;
      // 退避期间用户点了停止：按手动停止收尾。直接 return 会把记录永远留在"重连中"、占着并发名额，
      // 停止录制的请求也会一直挂在 session.done 上（唯一的出口是重启服务）。
      if (this.host.active.get(room.id)?.stopRequested) {
        await this.host.completeRecording(
          room,
          recordingId,
          session.size,
          "ended",
          {
            endReason: session.requestedEndReason ?? "stopped",
          },
        );
        return;
      }
      const next = effective + 1;
      try {
        const cookie = await this.services.platformCookie(room.platform);
        // 先确认主播还在不在播：只有明确的"未开播"才是正常收尾，不该白等重试再报"失败"。
        const live = await this.resolveRecordingSource(
          room,
          settings.quality,
          cookie,
        );
        if (live.status === "offline") {
          // 连续两次都判未开播才收尾：单次空响应可能只是平台瞬时抖动，不该把正在录的收掉。
          if (await this.confirmOffline(room, cookie)) {
            await this.host.completeRecording(
              room,
              recordingId,
              session.size,
              "ended",
            );
            return;
          }
          cause = new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
            roomId: room.id,
            recordingId,
            retryable: true,
          }).toObject();
          effective = next;
          continue;
        }
        // 探测失败/受限（error/restricted）只是没问到确定结论，不代表下播：继续重试，不据此收尾。
        if (live.status !== "live") {
          cause =
            live.error ??
            new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
              roomId: room.id,
              recordingId,
              retryable: true,
            }).toObject();
          effective = next;
          continue;
        }
        const stream = live.stream;
        const cur = this.host.active.get(room.id);
        if (!cur || this.host.shuttingDown) return;
        if (cur.stopRequested) continue;
        await this.resumeSession(room, recordingId, cur, stream, next);
        return;
      } catch (err) {
        // 取流/探测抛错同样属于可重试的中断：消耗一次额度继续下一轮，额度耗尽才按真正原因收尾。
        cause = err instanceof AppError ? err.toObject() : cause;
        effective = next;
      }
    }
  }

  /**
   * 写盘失败自动恢复录制（PrePan 钦定 2026-09-29）：磁盘出错不停死录制，
   * **失败后立即重启、不间隔、共 3 次**；每次尝试落 [record] 日志与失败原因；
   * 3 次都失败才终停（历史必带明确原因）；用户手动介入（点停止/点录制）立即让位。
   */
  private async restartAfterWriteFailure(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    error: ErrorObject,
  ): Promise<void> {
    session.writeRestartPending = true;
    let resolveDone!: () => void;
    session.writeRestartDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    try {
      // 稳定录满一段后归还额度（与重连额度同口径）：旧故障不拖累现在这一次。
      if (
        this.services.clock.now() - session.lastRecoveryAt >=
        STABLE_RESET_MS
      ) {
        session.writeRestartCount = 0;
      }
      const settings = this.host.settingsForRecording(room, session);
      let cause = error;
      while (session.writeRestartCount < WRITE_RESTART_ATTEMPTS) {
        // 用户手动介入（点停止/点录制接管）：立即让位，绝不再自动重启（PrePan 钦定边界）。
        if (session.stopRequested || session.writeRestartCancelled) {
          await this.host.completeRecording(
            room,
            recordingId,
            session.size,
            "ended",
            {
              endReason: session.requestedEndReason ?? "stopped",
            },
          );
          return;
        }
        session.writeRestartCount += 1;
        const nth = session.writeRestartCount;
        // 每次尝试落日志与失败原因（诊断盲区教训：失败原因必须进 backend.log）。
        console.log(
          `[record] 写盘失败自动重启 ${recordingId}（第 ${nth}/${WRITE_RESTART_ATTEMPTS} 次）：${cause.message}`,
        );
        const prevState = this.services.rooms.get(room.id)?.monitorState;
        const recording = this.services.recordings.update(recordingId, {
          state: "reconnecting",
          retryCount: nth,
          failureReason: cause,
        });
        this.services.rooms.setState(room.id, "reconnecting");
        // 与重连循环同款：状态真变才广播 room:updated，避免冗余推送。
        if (prevState !== "reconnecting") {
          const fresh = this.services.rooms.get(room.id);
          if (fresh) {
            this.services.events.emit({
              type: "room:updated",
              data: this.host.enrichRoom(fresh),
            });
          }
        }
        this.services.events.emit({
          type: "recording:updated",
          data: recording,
        });
        try {
          const cookie = await this.services.platformCookie(room.platform);
          // 与重连同款双探：只有明确未开播才正常收尾，探测无结论不据此收尾。
          const live = await this.resolveRecordingSource(
            room,
            settings.quality,
            cookie,
          );
          if (live.status === "offline") {
            if (await this.confirmOffline(room, cookie)) {
              await this.host.completeRecording(
                room,
                recordingId,
                session.size,
                "ended",
              );
              return;
            }
            cause = new AppError(
              "NETWORK_UNAVAILABLE",
              "暂时无法确认直播状态",
              {
                roomId: room.id,
                recordingId,
                retryable: true,
              },
            ).toObject();
            continue;
          }
          if (live.status !== "live") {
            cause =
              live.error ??
              new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
                roomId: room.id,
                recordingId,
                retryable: true,
              }).toObject();
            continue;
          }
          const stream = live.stream;
          // 取流回来再查一次手动介入：手动开录/停止必须立即让位（并发判定收窄）。
          if (session.stopRequested || session.writeRestartCancelled) {
            await this.host.completeRecording(
              room,
              recordingId,
              session.size,
              "ended",
              {
                endReason: session.requestedEndReason ?? "stopped",
              },
            );
            return;
          }
          const cur = this.host.active.get(room.id);
          if (!cur) return;
          await this.resumeSession(room, recordingId, cur, stream, nth);
          // 恢复成功：清掉尝试期的失败原因，历史页只在真正失败/中断时显示原因。
          this.services.recordings.update(recordingId, { failureReason: null });
          return;
        } catch (err) {
          cause = err instanceof AppError ? err.toObject() : cause;
        }
      }
      await this.host.finishInterrupted(
        room,
        recordingId,
        writeRestartExhausted(cause, session.writeRestartCount),
      );
    } finally {
      session.writeRestartPending = false;
      session.writeRestartDone = undefined;
      resolveDone();
    }
  }

  private async resolveRecordingSource(
    room: Room,
    quality: import("../../types/index.js").Quality,
    cookie?: string,
  ): Promise<RecordingSourceResult> {
    const adapter = this.services.adapterFor(room.platform);
    if (adapter.resolveRecordingSource)
      return room.platform === "xiaohongshu" || room.platform === "youtube"
        ? adapter.resolveRecordingSource(room.url, quality, cookie, {
            streamSessionId:
              this.host.active.get(room.id)?.streamSessionId ?? null,
          })
        : adapter.resolveRecordingSource(room.url, quality, cookie);
    const live = await adapter.checkLiveStatus(room.url, cookie);
    if (live.status === "offline") return { status: "offline" };
    if (live.status !== "live")
      return {
        status: live.status,
        error:
          live.error ??
          new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
            retryable: true,
          }).toObject(),
      };
    return {
      status: "live",
      stream: await adapter.getStreamUrl(room.url, quality, cookie),
    };
  }

  /**
   * 判定"主播是否真的下播"：单次探测到 offline 可能只是平台的瞬时响应（抖音下播前后遇到过
   * 空响应），所以紧接再探一次，只有连续两次都说未开播才认定下播——避免一次瞬时空响应
   * 把正在进行的录制提前收掉。第二次探测失败一律按"没确认"处理（继续重试，不据此收尾）。
   */
  private async confirmOffline(
    room: Room,
    cookie: string | undefined,
  ): Promise<boolean> {
    try {
      const again = await this.resolveRecordingSource(
        room,
        this.host.settingsForRecording(room, this.host.active.get(room.id))
          .quality,
        cookie,
      );
      return again.status === "offline";
    } catch {
      return false;
    }
  }

  /**
   * 恢复续录：先把上一路拉流彻底停掉（含关闭写流），再接着写同一个文件，而不是新开一个。
   * 顺序不能反：启动超时重试时旧连接可能还挂着，若不等它收尾，新旧两个写流会同时写同一个文件。
   */
  private async resumeSession(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    stream: {
      url: string;
      format: "flv" | "hls" | "youtube";
      youtube?: NonNullable<
        import("../../recorder/engine.js").StreamInput["youtube"]
      >;
      headers?: Record<string, string>;
    },
    attempt: number,
  ): Promise<void> {
    // 先推进代次让旧会话失效，否则它收到错误事件后会再走一遍重连、重复处理。
    session.generation += 1;
    await session.engine?.stop().catch(() => undefined);
    await this.waitForPullToStop(session);
    session.segments += 1;
    session.lastRecoveryAt = this.services.clock.now();
    const run = this.host.runSession(
      room,
      recordingId,
      stream,
      session.filePath!,
      session,
      attempt,
    );
    session.pullDone = run;
    void run.catch(() => undefined);
  }

  /**
   * 接力互斥：启动超时、断流、流自然结束可能同时触发续录。
   * 若两次接力同时在跑，各自会起一路拉流、两路都往同一个文件写，文件必然损坏，因此同一会话只允许一次在途。
   */
  private async withHandoff(
    session: ActiveSession,
    action: () => Promise<void>,
  ): Promise<void> {
    if (session.handingOff) return;
    session.handingOff = true;
    try {
      await action();
    } finally {
      session.handingOff = false;
    }
  }

  /** Stop and shutdown wake the backoff immediately and remove its timer. */
  private waitForReconnect(session: ActiveSession, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.services.clock.clearTimeout(timer);
        if (session.wakeReconnect === wake) delete session.wakeReconnect;
        resolve();
      };
      const timer = this.services.clock.setTimeout(wake, ms);
      session.wakeReconnect = wake;
    });
  }

  /** 等旧拉流收尾（正常会被 stop() 立刻打断）；引擎万一不响应 stop，也不能把重连永久卡住。 */
  private async waitForPullToStop(session: ActiveSession): Promise<void> {
    const pull = session.pullDone;
    if (!pull) return;
    // Waiting longer is safer than opening another writer on the same file.
    // The buffered writer bounds a stalled target write and preserves its spool.
    await pull.catch(() => undefined);
  }

  /**
   * 自然结束（流连接正常关闭但房间可能仍开播）：重新拉流接着写同一个文件，
   * 既避免等调度器下一轮（60s）造成的数据缺口，也不再产生"多出一个文件 + 中途一次录制完成提示"。
   * rapid 用于限制连断连拉的快速循环。
   */
  async handleNaturalEnd(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    // 与断流重连互斥：同一时刻只允许一次接力，避免两路拉流写同一个文件。
    await this.withHandoff(session, () =>
      this.handleNaturalEndInner(
        room,
        recordingId,
        size,
        session,
        attempt,
        endTimestampMs,
      ),
    );
  }

  private async handleNaturalEndInner(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    if (session.stopRequested) {
      await this.host.completeRecording(room, recordingId, size, "ended", {
        endReason: session.requestedEndReason ?? "stopped",
      });
      return;
    }
    const settings = this.host.settingsForRecording(room, session);
    if (settings.retry.maxAttempts === 0) {
      await this.host.completeRecording(room, recordingId, size, "ended");
      return;
    }
    if (endTimestampMs > session.timestampOffsetMs)
      session.timestampOffsetMs = endTimestampMs;
    if (endTimestampMs > 0) session.mediaPositionMs = endTimestampMs;
    if (session.gapStartAt === null)
      session.gapStartAt = session.lastDataAt || this.services.clock.now();
    const effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    const rapid =
      RECONNECT_CHAIN_SEC[
        Math.min(effective, RECONNECT_CHAIN_SEC.length - 1)
      ] ?? 0;
    await this.waitForReconnect(
      session,
      Math.min(30_000, rapid * 1000 * (0.8 + Math.random() * 0.4)),
    );
    if (this.host.shuttingDown || this.host.active.get(room.id) !== session)
      return;
    if (this.host.active.get(room.id)?.stopRequested) {
      await this.host.completeRecording(room, recordingId, size, "ended", {
        endReason: session.requestedEndReason ?? "stopped",
      });
      return;
    }
    try {
      const cookie = await this.services.platformCookie(room.platform);
      // 先确认主播仍开播：已下播则正常收口，避免对结束的直播反复重连。
      const live = await this.resolveRecordingSource(
        room,
        settings.quality,
        cookie,
      );
      if (
        live.status === "offline" &&
        (await this.confirmOffline(room, cookie))
      ) {
        await this.host.completeRecording(room, recordingId, size, "ended");
        return;
      }
      if (live.status !== "live") {
        // 没确认下播（或探测失败）不能当"直播正常结束"：按可重试的中断走，额度耗尽时按真正原因收尾。
        const offlineCause =
          live.error ??
          new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
            roomId: room.id,
            recordingId,
            retryable: true,
          }).toObject();
        await this.handleDisconnectInner(
          room,
          recordingId,
          session,
          offlineCause,
          effective + 1,
          session.timestampOffsetMs,
        );
        return;
      }
      const stream = live.stream;
      const cur = this.host.active.get(room.id);
      if (!cur || this.host.shuttingDown) return;
      if (cur.stopRequested) {
        await this.host.completeRecording(
          room,
          recordingId,
          cur.size,
          "ended",
          {
            endReason: cur.requestedEndReason ?? "stopped",
          },
        );
        return;
      }
      await this.resumeSession(room, recordingId, cur, stream, effective + 1);
    } catch (err) {
      // 主播刚探测到还在播、这里只是取流/探测失败：属于可重试的中断，必须走退避重试并在额度耗尽时记录原因，
      // 不能像以前那样当成"直播正常结束"静默收尾（用户会完全不知道录制为什么停了）。
      // 本方法已在 withHandoff 内，直接进 Inner，避免重复取互斥锁。
      const cause =
        err instanceof AppError
          ? err.toObject()
          : new AppError("NETWORK_UNAVAILABLE", "取流失败", {
              roomId: room.id,
              recordingId,
              retryable: true,
            }).toObject();
      await this.handleDisconnectInner(
        room,
        recordingId,
        session,
        cause,
        effective + 1,
        session.timestampOffsetMs,
      );
    }
  }
}
