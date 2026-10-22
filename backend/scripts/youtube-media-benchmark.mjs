import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MatroskaLiveParser } from "../dist/recorder/matroska-live.js";
import { resolveBin } from "../dist/utils/ffmpeg.js";

const directory = await mkdtemp(join(tmpdir(), "lr-youtube-benchmark-"));
try {
  const file = join(directory, "sample.mkv");
  execFileSync(resolveBin("ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-g",
    "30",
    "-cluster_time_limit",
    "1000",
    file,
  ]);
  const data = await readFile(file);
  global.gc?.();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  let clusters = 0;
  for (let iteration = 0; iteration < 200; iteration++) {
    const parser = new MatroskaLiveParser();
    for (let offset = 0; offset < data.length; offset += 64 * 1024)
      clusters += parser.push(data.subarray(offset, offset + 64 * 1024)).length;
  }
  const elapsed = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  global.gc?.();
  const after = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        inputMiB: +((data.length * 200) / 1024 ** 2).toFixed(1),
        wallMs: +elapsed.toFixed(1),
        cpuMs: (usage.user + usage.system) / 1000,
        throughputMiBPerSecond: +(
          (data.length * 200) /
          1024 ** 2 /
          (elapsed / 1000)
        ).toFixed(1),
        retainedHeapMiB: +(
          (after.heapUsed - before.heapUsed) /
          1024 ** 2
        ).toFixed(2),
        retainedBufferMiB: +(
          (after.arrayBuffers - before.arrayBuffers) /
          1024 ** 2
        ).toFixed(2),
        clusters,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
