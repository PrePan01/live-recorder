import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Services } from "../../core/services.js";
import {
  recordingFilePath,
  timestampSlug,
} from "../../storage/file-organizer.js";
import { AppError } from "../../types/error.js";

export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Check the container as well as its signature; never persist a truncated upload. */
export function isScreenshotPng(bytes: Buffer): boolean {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return false;
  let offset = 8;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (size > bytes.length - offset - 12) return false;
    if (
      offset === 8 &&
      (type !== "IHDR" ||
        size !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0)
    )
      return false;
    if (type === "IDAT" && size > 0) hasData = true;
    offset += size + 12;
    if (type === "IEND")
      return size === 0 && hasData && offset === bytes.length;
  }
  return false;
}

export async function writeScreenshot(
  directory: string,
  bytes: Buffer,
  iso: string,
): Promise<string> {
  const date = new Date(iso);
  const base = `截图_${timestampSlug(iso)}_${String(date.getMilliseconds()).padStart(3, "0")}`;
  try {
    await mkdir(directory, { recursive: true });
    for (let n = 0; n < 1000; n++) {
      const filePath = path.join(directory, `${base}${n ? ` (${n})` : ""}.png`);
      let handle;
      try {
        handle = await open(filePath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        await handle.writeFile(bytes);
        await handle.close();
        return filePath;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(filePath).catch(() => undefined);
        throw error;
      }
    }
    throw new Error("截图文件重名过多，请稍后重试");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT")
      throw new AppError(
        "DISK_SPACE_INSUFFICIENT",
        "截图保存失败：磁盘空间不足",
      );
    throw new AppError(
      "DIRECTORY_NOT_WRITABLE",
      "截图保存失败：请检查保存目录是否可写、磁盘是否可用",
    );
  }
}

export function registerRoomScreenshotRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  // Keep the binary parser and larger upload limit local to this endpoint.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "image/png",
      { parseAs: "buffer", bodyLimit: MAX_SCREENSHOT_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.setErrorHandler((error, _req, reply) => {
      if ((error as { statusCode?: number }).statusCode === 413)
        return reply
          .status(413)
          .send({
            error: new AppError(
              "CONFIG_INVALID",
              "截图过大，不能超过 32 MiB",
            ).toObject(),
          });
      throw error;
    });
    scope.post<{
      Params: { id: string };
      Querystring: { recordingId?: string };
    }>(
      "/api/v1/rooms/:id/screenshots",
      { bodyLimit: MAX_SCREENSHOT_BYTES },
      async (req, reply) => {
        const room = services.rooms.get(req.params.id);
        if (!room) throw new AppError("RESOURCE_NOT_FOUND", "直播间不存在");
        if (
          !Buffer.isBuffer(req.body) ||
          req.body.length > MAX_SCREENSHOT_BYTES ||
          !isScreenshotPng(req.body)
        ) {
          throw new AppError("CONFIG_INVALID", "截图内容无效，请重新截图");
        }
        const recordingId =
          req.query.recordingId ??
          services.manager.activeRecordingFor(room.id)?.recordingId;
        let directory: string;
        if (recordingId !== undefined) {
          if (typeof recordingId !== "string" || !recordingId)
            throw new AppError("CONFIG_INVALID", "录像标识无效");
          const recording = services.recordings.get(recordingId);
          if (!recording || recording.roomId !== room.id)
            throw new AppError(
              "RESOURCE_NOT_FOUND",
              "关联录像不存在或不属于当前直播间",
            );
          if (!recording.filePath)
            throw new AppError(
              "RECORDING_DIRECTORY_INVALID",
              "关联录像暂无保存路径，请稍后重试",
            );
          directory = path.dirname(recording.filePath);
        } else {
          const settings = services.settings.load();
          if (!settings?.recordingDirectory?.trim())
            throw new AppError(
              "RECORDING_DIRECTORY_INVALID",
              "请先在设置中配置录像保存目录",
            );
          directory = path.dirname(
            recordingFilePath(
              settings.recordingDirectory,
              room.platform,
              room.displayName || room.id,
              services.clock.iso(),
            ),
          );
        }
        const filePath = await writeScreenshot(
          path.join(directory, "截图"),
          req.body,
          services.clock.iso(),
        );
        return reply.send({ filePath });
      },
    );
  });
}
