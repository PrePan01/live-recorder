// 执行外部命令，控制超时、重试、上传进度和并发数量。
import { spawn, execFileSync } from "node:child_process";

export async function transferFiles(entries, transfer) {
  for (let offset = 0; offset < entries.length; offset += 2) {
    const results = await Promise.allSettled(
      entries.slice(offset, offset + 2).map(transfer),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

export function command(program, args) {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (error) {
    throw new Error(
      `${program} ${args[0]} failed: ${error.stderr?.toString() || error.message}`,
    );
  }
}
export function asyncCommand(program, args, options = {}) {
  const { label = program, timeout = 300000, liveOutput = false, idleTimeout = 0, ...execution } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastProgress = started, lastAmount = 0, progress = 'waiting for output';
    const progressTails = ['', ''];
    let stdout = '', stderr = '', stopped, forceKill, settled = false;
    const child = spawn(program, args, { ...execution, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 10000);
    };
    const deadline = setTimeout(() => stop(`${label} timed out after ${Math.round(timeout / 1000)}s`), timeout);
    const heartbeat = setInterval(() => {
      console.log(`[${label}] ${Math.round((Date.now() - started) / 1000)}s: ${progress}`);
    }, 15000);
    const idle = idleTimeout ? setInterval(() => {
      if (Date.now() - lastProgress > idleTimeout) stop(`${label}: no upload progress for ${Math.round(idleTimeout / 1000)}s`);
    }, Math.min(15000, idleTimeout / 2)) : undefined;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(forceKill); clearInterval(heartbeat); clearInterval(idle);
      if (error) reject(error);
      else { console.log(`[${label}] completed in ${Math.round((Date.now() - started) / 1000)}s`); resolve(stdout); }
    };
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', chunk => {
      const output = chunk.toString();
      if (isError) stderr += output; else stdout += output;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) stop(`${label}: output limit exceeded`);
      if (liveOutput) process.stdout.write(output.replace(/\r/g, '\n'));
      progress = output.trim().split(/[\r\n]+/).at(-1) || progress;
      // 进度行可能分批到达，保留末尾片段；字节数增加才算传输有进展。
      const streamIndex = isError ? 1 : 0;
      const progressOutput = progressTails[streamIndex] + output;
      for (const match of progressOutput.matchAll(/Completed ([\d.]+) (Bytes|KiB|MiB|GiB)\//g)) {
        const amount = Number(match[1]) * ({ Bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 })[match[2]];
        if (amount > lastAmount) { lastAmount = amount; lastProgress = Date.now(); }
      }
      progressTails[streamIndex] = progressOutput.slice(-128);
    });
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      if (stopped) finish(new Error(stopped));
      else if (code !== 0 || signal) finish(new Error(`${label} failed: ${stderr || signal || code}`));
      else finish();
    });
  });
}

function isS3PermissionError(error) {
  return /\((403|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch)\) when calling the \w+ operation/i.test(error.message);
}

export async function retryTransfer(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        attempt === 3 || isS3PermissionError(error) ||
        /HTTP 404|\((404|NoSuchKey|NotFound)\)|Refusing to overwrite|refusing to modify|upload budget exceeded/.test(
          error.message,
        )
      )
        throw error;
      console.warn(`Transfer failed; retry ${attempt + 2}/4 in ${2 ** attempt}s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
export function retry(fn) {
  let error;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return fn();
    } catch (e) {
      error = e;
      if (isS3PermissionError(e) || /HTTP 404|\((404|NoSuchKey|NotFound)\)/.test(e.message)) throw e;
      if (attempt < 3)
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          1000 * 2 ** attempt,
        );
    }
  }
  throw error;
}

