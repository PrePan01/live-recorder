import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  chmod,
  readdir,
  rename,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as hwEncode from '../../src/recorder/hw-encode.js';
import { MatroskaLiveParser } from "../../src/recorder/matroska-live.js";
import { YoutubeRecordingEngine } from "../../src/recorder/youtube-recorder.js";
import {
  finalizeYoutube,
  readYoutubeParts,
  saveYoutubeParts,
  youtubeInput,
  youtubeStorageFiles,
  removeYoutubeParts,
} from "../../src/recorder/youtube-media.js";
import { openYoutubePlayback } from "../../src/recorder/youtube-playback.js";
import { resolveBin } from "../../src/utils/ffmpeg.js";
import { exportClipFile } from "../../src/recorder/clip-export.js";
import { convertToMp4 } from "../../src/recorder/pipeline-ffmpeg.js";
import { reserveRecordingPath } from "../../src/storage/file-organizer.js";

describe("YouTube original-media lifecycle", () => {
  let directory: string, fixture: Buffer;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "lr-youtube-media-test-"));
    const sample = path.join(directory, "sample.mkv");
    execFileSync(resolveBin("ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-g",
      "25",
      "-c:a",
      "aac",
      "-f",
      "matroska",
      "-cluster_time_limit",
      "1000",
      sample,
    ]);
    fixture = await readFile(sample);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("atomically reserves distinct names for simultaneous channel and video recordings", async () => {
    const preferred = path.join(directory, "new-creator", "live.mkv");
    const [a, b] = await Promise.all([
      reserveRecordingPath(preferred),
      reserveRecordingPath(preferred),
    ]);
    expect(a).not.toBe(b);
    await writeFile(a, "preserved");
    expect(await reserveRecordingPath(preferred)).not.toBe(a);
    expect(await readFile(a, "utf8")).toBe("preserved");
  });
  it("frames real Matroska clusters across arbitrary network boundaries and extracts media time", () => {
    const parser = new MatroskaLiveParser();
    let count = 0;
    for (let at = 0; at < fixture.length; at += 97)
      count += parser.push(fixture.subarray(at, at + 97)).length;
    expect(parser.header?.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(count).toBeGreaterThanOrEqual(3);
    expect(parser.timestampMs).toBeGreaterThan(2900);
    expect(parser.timestampMs).toBeLessThan(3200);
    expect(parser.canCopyToFlv).toBe(true);
  });
  it("pins an export source without copying video and survives a concurrent rename", async () => {
    const file = path.join(directory, "pinned.mkv");
    await writeFile(file, fixture);
    const input = await youtubeInput(file);
    try {
      await rm(file);
      expect(await input.readHeader()).toEqual(fixture.subarray(0, 128 * 1024));
      const probe = JSON.parse(
        execFileSync(
          resolveBin("ffprobe"),
          ["-v", "error", ...input.args, "-show_streams", "-of", "json"],
          { encoding: "utf8" },
        ),
      );
      expect(probe.streams[0].codec_name).toBe("h264");
    } finally {
      await input.dispose();
    }
  });
  it("rejects a manifest that refers to another recording", async () => {
    const file = path.join(directory, "invalid.mkv");
    await writeFile(
      `${file}.youtube.json`,
      JSON.stringify([
        {
          path: path.join(directory, "sample.mkv"),
          durationMs: 1,
          offsetMs: 0,
        },
      ]),
    );
    await expect(readYoutubeParts(file)).rejects.toThrow(
      "Invalid segment manifest",
    );
    expect(
      (await stat(path.join(directory, "sample.mkv"))).size,
    ).toBeGreaterThan(0);
  });
  it.each(['before-replacement', 'after-replacement'])(
    'recovers publication interrupted %s without concatenating the original content twice', async phase => {
      const file = path.join(directory, `publication-${phase}.mkv`);
      const part = `${file}.part-1.mkv`;
      const temp = `${file}.finalizing.mkv`;
      await writeFile(file, fixture);
      await writeFile(part, fixture);
      const parts = [{ path: file, offsetMs: 0, durationMs: 3023 },
        { path: part, offsetMs: 3023, durationMs: 3023 }];
      await saveYoutubeParts(file, parts);
      const original = await youtubeInput(file, false);
      try { execFileSync(resolveBin('ffmpeg'), ['-v', 'error', ...original.args, '-c', 'copy', temp]); }
      finally { await original.dispose(); }
      const output = await stat(temp);
      const journal = `${file}.youtube-publish.json`;
      await writeFile(journal, JSON.stringify({ version: 1, parts, output: {
        dev: output.dev, ino: output.ino, size: output.size, mtimeMs: output.mtimeMs,
      } }));
      if (phase === 'after-replacement') {
        await rename(temp, file);
        expect(await readYoutubeParts(file)).toEqual([]);
      }
      const input = await youtubeInput(file);
      try {
        const probe = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', ...input.args,
          '-show_entries', 'format=duration', '-of', 'json'], { encoding: 'utf8' }));
        expect(Number(probe.format.duration)).toBeLessThan(6.2);
        expect(Number(probe.format.duration)).toBeGreaterThan(5.9);
        expect(await readYoutubeParts(file)).toEqual([]);
        await expect(stat(part)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
        await finalizeYoutube(file);
      } finally { await input.dispose(); }
    });
  it('pins every part before allowing publication to replace or delete its inputs', async () => {
    const file = path.join(directory, 'concurrent-publication.mkv');
    const part = `${file}.part-1.mkv`;
    await writeFile(file, fixture); await writeFile(part, fixture);
    await saveYoutubeParts(file, [{ path: file, offsetMs: 0, durationMs: 3023 },
      { path: part, offsetMs: 3023, durationMs: 3023 }]);
    let entered!: () => void, release!: () => void;
    const pinning = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = youtubeInput(file, true, async (from, to) => { entered(); await gate; await link(from, to); });
    await pinning;
    const finalizing = finalizeYoutube(file);
    release();
    const input = await reading;
    try {
      await finalizing;
      const probe = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', ...input.args,
        '-show_entries', 'format=duration', '-of', 'json'], { encoding: 'utf8' }));
      expect(Number(probe.format.duration)).toBeGreaterThan(5.9);
      expect(Number(probe.format.duration)).toBeLessThan(6.2);
    } finally { await input.dispose(); }
  });
  it('validates publication ownership and includes all sidecars in explicit deletion', async () => {
    const file = path.join(directory, 'delete-publication.mkv');
    const part = `${file}.part-1.mkv`;
    await writeFile(file, fixture); await writeFile(part, fixture);
    await saveYoutubeParts(file, [{ path: file, offsetMs: 0, durationMs: 3023 },
      { path: part, offsetMs: 3023, durationMs: 3023 }]);
    const info = await stat(file);
    const journal = `${file}.youtube-publish.json`;
    const output = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
    await writeFile(journal, JSON.stringify({ version: 1, output,
      parts: [{ path: path.join(directory, 'sample.mkv'), offsetMs: 0, durationMs: 1 }] }));
    await expect(youtubeInput(file)).rejects.toThrow('Invalid segment manifest');
    expect((await stat(path.join(directory, 'sample.mkv'))).size).toBeGreaterThan(0);
    await writeFile(journal, JSON.stringify({ version: 1, output,
      parts: [{ path: file, offsetMs: 0, durationMs: 3023 }, { path: part, offsetMs: 3023, durationMs: 3023 }] }));
    expect(await youtubeStorageFiles(file)).toContain(part);
    await removeYoutubeParts(file);
    await expect(stat(part)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(file)).size).toBeGreaterThan(0);
  });
  it('uses inherited handles when a volume cannot hard-link, surviving source deletion without copying', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(directory, 'no-hardlinks.mkv');
    await writeFile(file, fixture);
    const input = await youtubeInput(file, true, async () => { throw Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }); });
    try {
      expect(input.fileDescriptors).toHaveLength(1);
      await rm(file);
      expect(await input.readHeader()).toEqual(fixture.subarray(0, 128 * 1024));
      const info = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', ...input.args, '-show_streams', '-of', 'json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', ...input.fileDescriptors],
      }));
      expect(info.streams[0].codec_name).toBe('h264');
    } finally { await input.dispose(); }
  });
  it.each([
    ["libvpx-vp9", "vp9"],
    ["libaom-av1", "av1"],
  ])(
    "preserves %s originals while generating an H.264 preview",
    async (encoder, codec) => {
      const file = path.join(directory, `${codec}.mkv`);
      execFileSync(
        createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg").path,
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=10",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440",
          "-t",
          "1",
          "-c:v",
          encoder!,
          "-cpu-used",
          "8",
          "-threads",
          "1",
          "-c:a",
          "libopus",
          file,
        ],
      );
      const parser = new MatroskaLiveParser();
      parser.push(await readFile(file));
      expect(parser.canCopyToFlv).toBe(false);
      const stream = await openYoutubePlayback(codec!, file, 0, "software");
      const preview = path.join(directory, `${codec}.flv`);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      await writeFile(preview, Buffer.concat(chunks));
      const probe = (target: string) =>
        JSON.parse(
          execFileSync(
            resolveBin("ffprobe"),
            ["-v", "error", "-show_streams", "-of", "json", target],
            { encoding: "utf8" },
          ),
        );
      expect(probe(file).streams[0].codec_name).toBe(codec);
      expect(probe(preview).streams[0].codec_name).toBe("h264");
    },
  );
  it("merges reconnect parts once and retains original codecs", async () => {
    const file = path.join(directory, "recording.mkv");
    const second = `${file}.part-1.mkv`;
    await writeFile(file, fixture);
    await writeFile(second, fixture);
    await saveYoutubeParts(file, [
      { path: file, offsetMs: 0, durationMs: 3023 },
      { path: second, offsetMs: 3023, durationMs: 3023 },
    ]);
    const finalization = finalizeYoutube(file);
    expect(finalizeYoutube(file)).toBe(finalization);
    await finalization;
    const info = JSON.parse(
      execFileSync(
        resolveBin("ffprobe"),
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { encoding: "utf8" },
      ),
    );
    expect(
      info.streams.map((s: { codec_name: string }) => s.codec_name),
    ).toEqual(["h264", "aac"]);
    expect(Number(info.format.duration)).toBeGreaterThan(5.9);
    expect(await readYoutubeParts(file)).toEqual([]);
    expect(await stat(second).catch(() => null)).toBeNull();
    expect(await convertToMp4(file)).not.toBeNull();
    expect((await stat(file)).size).toBeGreaterThan(0);
  });
  it("supports original source clips and bounded compatibility playback", async () => {
    const file = path.join(directory, "sample.mkv");
    const clip = path.join(directory, "clip.mkv");
    expect(
      await exportClipFile(file, clip, 1, 2, { encodingMode: "software" }),
    ).toMatchObject({ ok: true });
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".lr-youtube-read-"),
      ),
    ).toEqual([]);
    const controller = new AbortController();
    const stream = await openYoutubePlayback(
      "test",
      file,
      1,
      "software",
      controller.signal,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 3).toString()).toBe("FLV");
    controller.abort();
  });
  it('keeps valid reconnect content when the first connection produced no media file', async () => {
    const file = path.join(directory, 'empty-first.mkv');
    const next = `${file}.part-1.mkv`;
    await writeFile(next, fixture);
    await saveYoutubeParts(file, [
      { path: file, offsetMs: 0, durationMs: 0 },
      { path: next, offsetMs: 0, durationMs: 3023 },
    ]);
    await finalizeYoutube(file);
    expect((await stat(file)).size).toBeGreaterThan(1000);
    expect(await readYoutubeParts(file)).toEqual([]);
    const info = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
    expect(Number(info.format.duration)).toBeGreaterThan(2.9);
  });
  it("delivers ready preview bytes while the upstream source is paused", async () => {
    if (process.platform === 'win32') return;
    const script = path.join(directory, 'paused-extractor');
    const marker = path.join(directory, 'upstream-resumed');
    await writeFile(script, `#!${process.execPath}\nconst fs=require('fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(directory, 'sample.mkv'))})); setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'resumed');process.exit(0);},5000);\n`);
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    const engine = new YoutubeRecordingEngine({}, 'software');
    let received = false;
    try {
      for await (const event of engine.start({ url: 'https://youtube.com/watch?v=abcdefghijk', format: 'youtube',
        youtube: { videoId: 'abcdefghijk', formatSelector: 'bv+ba/b' } }, null)) {
        if (event.type === 'error') throw new Error(event.error.message);
        if (event.type === 'data' && event.chunk.length > 0) {
          received = true;
          await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          await engine.stop();
          break;
        }
      }
      expect(received).toBe(true);
    } finally {
      await engine.stop();
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
  it.each(["copy", "transcode", "hardware-fallback"])("opens %s preview from an active recording while the upstream is between fragments", async mode => {
    if (process.platform === 'win32') return;
    const source = path.join(directory, `record-first-${mode}.mkv`);
    if (mode !== 'copy') {
      execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', path.join(directory, 'sample.mkv'),
        '-c:v', 'libvpx-vp9', '-cpu-used', '8', '-threads', '1', '-g', '50', '-c:a', 'libopus',
        '-cluster_time_limit', '500', source]);
    } else await writeFile(source, fixture);
    const script = path.join(directory, `record-first-${mode}-extractor`);
    const marker = path.join(directory, `record-first-${mode}-upstream-resumed`);
    await writeFile(script, `#!${process.execPath}\nconst fs=require('fs');process.stdout.write(fs.readFileSync(${JSON.stringify(source)}));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'resumed');process.exit(0);},5000);\n`);
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    const encoderProbe = mode === 'hardware-fallback'
      ? vi.spyOn(hwEncode, 'detectPreviewHwEncoder').mockResolvedValue('h264_videotoolbox')
      : undefined;
    const hardwareArgs = mode === 'hardware-fallback'
      ? vi.spyOn(hwEncode, 'encoderQualityArgs').mockReturnValue(['-invalid_hardware_test', '1'])
      : undefined;
    const engine = new YoutubeRecordingEngine({}, mode === 'hardware-fallback' ? 'auto' : 'software');
    let activate: ReturnType<typeof setTimeout> | undefined;
    let received = false;
    let chunks: Buffer[] = [];
    let reopened = false;
    try {
      for await (const event of engine.start({ url: 'https://youtube.com/watch?v=abcdefghijk', format: 'youtube',
        youtube: { videoId: 'abcdefghijk', formatSelector: 'bv+ba/b' } }, path.join(directory, `record-first-output-${mode}.mkv`))) {
        if (event.type === 'error') throw new Error(event.error.message);
        if (event.type === 'data' && event.mediaTimestampMs !== undefined && !activate) {
          // Let the source loop finish its current batch before opening the viewer.
          activate = setTimeout(() => engine.setPreviewActive(true), 100);
        }
        if (event.type === 'preview_data') {
          chunks.push(event.chunk);
          const flv = Buffer.concat(chunks);
          expect(flv.subarray(0, 3).toString()).toBe('FLV');
          // Wait for a complete AVC keyframe, not merely an FLV header.
          for (let at = 13; at + 15 <= flv.length;) {
            const length = flv.readUIntBE(at + 1, 3) + 15;
            if (at + length > flv.length) break;
            if (flv[at] === 9 && flv[at + 11] === 0x17 && flv[at + 12] === 1) received = true;
            at += length;
          }
          if (received) {
            await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            if (!reopened) {
              reopened = true;
              received = false;
              chunks = [];
              engine.setPreviewActive(false);
              engine.setPreviewActive(true);
              continue;
            }
            await engine.stop();
            break;
          }
        }
      }
      expect(received).toBe(true);
      expect(reopened).toBe(true);
      const preview = path.join(directory, `record-first-${mode}.flv`);
      await writeFile(preview, Buffer.concat(chunks));
      const decoded = spawnSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', preview,
        '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
      expect(decoded.status).toBe(0);
      expect(decoded.stderr).toBe('');
    } finally {
      clearTimeout(activate);
      encoderProbe?.mockRestore();
      hardwareArgs?.mockRestore();
      await engine.stop();
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
  it('attaches a native recorder without another source process, preserves packets and rebases the recording clock', async () => {
    if (process.platform === 'win32') return;
    const script = path.join(directory, 'shared-native-extractor');
    const count = path.join(directory, 'shared-native-source-count');
    await writeFile(script, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'start\\n');process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(directory,'sample.mkv'))}));setTimeout(()=>process.exit(0),5000);\n`);
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    const engine = new YoutubeRecordingEngine({}, 'software');
    const input = { url: 'https://youtube.com/watch?v=abcdefghijk', format: 'youtube' as const,
      youtube: { videoId: 'abcdefghijk', formatSelector: 'bv+ba/b',
        snapshot: { json: JSON.stringify({ formats: [{ height: 90 }, { height: 720 }] }), expiresAt: Date.now() + 15000 } } };
    let ready!: () => void;
    const playing = new Promise<void>(resolve => { ready = resolve; });
    const preview = (async () => {
      for await (const event of engine.start(input, null)) {
        if (event.type === 'error') throw new Error(event.error.message);
        if (event.type === 'data') ready();
      }
    })();
    let recording: ReturnType<YoutubeRecordingEngine['forkRecording']> = null;
    try {
      await playing;
      expect(engine.forkRecording('720p')).toBeNull();
      expect(engine.forkRecording('original')).toBeNull();
      recording = engine.forkRecording('360p');
      expect(recording).not.toBeNull();
      const output = path.join(directory, 'native-shared.mkv');
      const started = performance.now();
      let received = false;
      for await (const event of recording!.start(input, output)) {
        if (event.type === 'error') throw new Error(event.error.message);
        if (event.type === 'data' && event.mediaTimestampMs !== undefined) {
          received = true;
          expect(event.mediaTimestampMs).toBeLessThan(3000);
          await recording!.stop();
        }
      }
      expect(received).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(Number.isFinite(recording!.recordingPreviewOffsetMs!())).toBe(true);
      expect((await readFile(count, 'utf8')).trim().split('\n')).toEqual(['start']);
      const decode = spawnSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', output, '-t', '1', '-f', 'null', '-'], { encoding: 'utf8' });
      expect(decode.status).toBe(0);
      expect(decode.stderr).toBe('');
      const container = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
      expect(Number(container.format.start_time)).toBeLessThan(0.1);
      const hashes = (file: string) => JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_packets', '-show_data_hash', 'md5', '-of', 'json', file], { encoding: 'utf8' })).packets.map((packet: { data_hash: string }) => packet.data_hash);
      const original = new Set(hashes(path.join(directory, 'sample.mkv')));
      const saved = hashes(output);
      expect(saved.length).toBeGreaterThan(20);
      expect(saved.every((hash: string) => original.has(hash))).toBe(true);
    } finally {
      await recording?.stop();
      await engine.stop(); await preview;
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
  it("records streaming originals without a preview encoder, then resumes into a distinct part", async () => {
    if (process.platform === "win32") return;
    const script = path.join(directory, "extractor");
    await writeFile(
      script,
      `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(directory, "sample.mkv"))}));\n`,
    );
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    try {
      const file = path.join(directory, "engine.mkv");
      const input = {
        url: "https://www.youtube.com/watch?v=abcdefghijk",
        format: "youtube" as const,
        youtube: { videoId: "abcdefghijk", formatSelector: "bv+ba/b" },
      };
      let mediaTime = 0,
        previews = 0;
      for await (const event of new YoutubeRecordingEngine().start(
        input,
        file,
      )) {
        if (event.type === "data")
          mediaTime = event.mediaTimestampMs ?? mediaTime;
        if (event.type === "preview_data") previews++;
        expect(event.type).not.toBe("error");
      }
      const firstPart = await readFile(file);
      expect(firstPart.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
      const streams = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })).streams;
      expect(streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(['h264', 'aac']);
      expect(previews).toBe(0);
      expect(mediaTime).toBeGreaterThan(2900);
      for await (const event of new YoutubeRecordingEngine().start(
        input,
        file,
        { append: true, timestampOffsetMs: mediaTime },
      ))
        expect(event.type).not.toBe("error");
      const parts = await readYoutubeParts(file);
      expect(parts).toHaveLength(2);
      expect(parts[0]?.path).not.toBe(parts[1]?.path);
      expect(await readFile(file)).toEqual(firstPart);
    } finally {
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
  it('records AAC from a delayed fragmented MP4 initialization without re-encoding packets', async () => {
    if (process.platform === 'win32') return;
    const aac = path.join(directory, 'raw.aac');
    const source = path.join(directory, 'delayed.mp4');
    execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', path.join(directory, 'sample.mkv'), '-vn', '-c:a', 'copy', '-f', 'adts', aac]);
    execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', path.join(directory, 'sample.mkv'), '-f', 'aac', '-i', aac,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+frag_keyframe+delay_moov+default_base_moof', '-frag_duration', '1000000', source]);
    const script = path.join(directory, 'fragmented-extractor');
    await writeFile(script, `#!${process.execPath}\nconst args=process.argv.slice(2); if(!args.some(a=>a.includes('aac_adtstoasc')&&a.includes('delay_moov'))) process.exit(4);process.stdout.write(require('fs').readFileSync(${JSON.stringify(source)}));\n`);
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    const output = path.join(directory, 'adts-recorded.mkv');
    try {
      for await (const event of new YoutubeRecordingEngine().start({ url: 'https://youtube.com/watch?v=abcdefghijk', format: 'youtube',
        youtube: { videoId: 'abcdefghijk', formatSelector: 'bv+ba/b', audioCodec: 'aac' } }, output)) expect(event.type).not.toBe('error');
      const packets = (file: string) => JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_packets', '-show_data_hash', 'md5', '-of', 'json', file], { encoding: 'utf8' })).packets.map((packet: { data_hash: string }) => packet.data_hash).sort();
      expect(packets(output)).toEqual(packets(source));
    } finally {
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
  it.each(['vp9', 'av1'])('keeps %s and Opus through the streaming remux stage', async codec => {
    if (process.platform === 'win32') return;
    const source = path.join(directory, `${codec}-fragmented.mp4`);
    execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-i', path.join(directory, `${codec}.mkv`), '-c', 'copy', '-strict', '-2',
      '-movflags', '+frag_keyframe+delay_moov+default_base_moof', '-frag_duration', '1000000', source]);
    const script = path.join(directory, `${codec}-extractor`);
    await writeFile(script, `#!${process.execPath}\nif(process.argv.some(a=>a.includes('aac_adtstoasc'))) process.exit(4);process.stdout.write(require('fs').readFileSync(${JSON.stringify(source)}));\n`);
    await chmod(script, 0o755);
    const previous = process.env.LR_YTDLP_PATH;
    process.env.LR_YTDLP_PATH = script;
    const output = path.join(directory, `${codec}-recorded.mkv`);
    try {
      for await (const event of new YoutubeRecordingEngine().start({ url: 'https://youtube.com/watch?v=abcdefghijk', format: 'youtube',
        youtube: { videoId: 'abcdefghijk', formatSelector: 'bv+ba/b', audioCodec: 'opus' } }, output)) expect(event.type).not.toBe('error');
      const info = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
      expect(info.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual([codec, 'opus']);
    } finally {
      if (previous === undefined) delete process.env.LR_YTDLP_PATH;
      else process.env.LR_YTDLP_PATH = previous;
    }
  });
});
