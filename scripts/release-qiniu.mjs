import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import qiniu from "qiniu";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const PART_SIZE = 2 * 1024 * 1024;
const DIGEST_METADATA = "release-sha256";

function expectSuccess(operation, key, result) {
  const status = result.resp?.statusCode;
  if (status >= 200 && status < 300) return result.data;
  const requestId = result.resp?.headers?.["x-reqid"];
  throw new Error(`Kodo ${operation} ${key} (${status ?? "no status"})${requestId ? `, request ID ${requestId}` : ""}`);
}

async function publicDigest(baseUrl, key, expectedSize, originHash) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/${path}`, {
    headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(120_000),
  });
  const digest = createHash("sha256");
  let size = 0;
  try {
    if (response.status !== 200) throw new Error(`CDN read HTTP ${response.status}: ${key}`);
    if (!originHash || response.headers.get("etag") !== `"${originHash}"`)
      throw new Error(`CDN ETag does not match the Kodo object: ${key}`);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expectedSize) throw new Error(`Refusing to overwrite CDN object ${key}: size mismatch`);
      digest.update(chunk);
    }
    if (size !== expectedSize) throw new Error(`CDN read returned incomplete bytes: ${key}`);
    return digest.digest("hex");
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

export async function ensureQiniuObject({ bucket, key, file, digest, baseUrl }, { manager, upload }) {
  const size = statSync(file).size;
  const response = await manager.stat(bucket, key);
  if (response.resp?.statusCode === 612) {
    const uploaded = expectSuccess("upload", key, await upload());
    if (uploaded?.key !== key || !uploaded.hash)
      throw new Error(`Kodo upload did not confirm the completed object: ${key}`);
  } else {
    const object = expectSuccess("stat", key, response);
    if (object.status === 1) throw new Error(`Kodo object is disabled: ${key}`);
    if (object.fsize !== size) throw new Error(`Refusing to overwrite CDN object ${key}: size mismatch`);
    const metadata = object["x-qn-meta"];
    const uploadedDigest = metadata?.[DIGEST_METADATA] ?? metadata?.[`x-qn-meta-${DIGEST_METADATA}`];
    const actual = uploadedDigest ?? await publicDigest(baseUrl, key, size, object.hash);
    if (actual !== digest) throw new Error(`Refusing to overwrite CDN object ${key}: SHA-256 mismatch`);
    // 旧版文件已设置缓存策略。新上传中断时仍要补上缓存头。
    if (!uploadedDigest || object.cacheControl === CACHE_CONTROL) return;
  }
  expectSuccess("set cache headers", key, await manager.changeHeaders(bucket, key, {
    "Cache-Control": CACHE_CONTROL,
  }));
}

async function main() {
  const [key, file, digest, resumeDirectory] = process.argv.slice(2);
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, QINIU_BUCKET, QINIU_ACCELERATE_UPLOAD, UPDATE_BASE_URL } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !QINIU_BUCKET || !UPDATE_BASE_URL)
    throw new Error("Missing Kodo release configuration");

  // 单次请求卡住时交给 SDK 切换接入点，外层按确认的分片字节数监控停滞。
  qiniu.conf.RPC_TIMEOUT = 120_000;
  const mac = new qiniu.auth.digest.Mac(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY);
  const config = new qiniu.conf.Config({
    useHttpsDomain: true,
    accelerateUploading: QINIU_ACCELERATE_UPLOAD === "true",
  });
  const manager = new qiniu.rs.BucketManager(mac, config);
  const uploader = new qiniu.resume_up.ResumeUploader(config);
  const upload = () => {
    const policy = new qiniu.rs.PutPolicy({ scope: `${QINIU_BUCKET}:${key}`, insertOnly: 1, expires: 3600 });
    const extra = qiniu.resume_up.PutExtra.create(
      undefined, undefined, undefined, undefined,
      (bytes, total) => console.log(`Uploaded ${bytes}/${total} bytes`),
      PART_SIZE, "v2", { [`x-qn-meta-${DIGEST_METADATA}`]: digest },
      qiniu.resume_up.createResumeRecorderSync(resumeDirectory),
      createHash("sha256").update(JSON.stringify([AWS_ACCESS_KEY_ID, QINIU_BUCKET, key, digest])).digest("hex"),
    );
    return uploader.putFileV2(policy.uploadToken(mac), key, file, extra);
  };
  await ensureQiniuObject({ bucket: QINIU_BUCKET, key, file, digest, baseUrl: UPDATE_BASE_URL }, { manager, upload });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
