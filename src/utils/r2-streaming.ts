import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "weebin-storage";

type VideoS3Config = {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
};

export type StreamingVideoSummary = {
  videoId: string;
  prefix: string;
  masterKey: string;
  masterUrl: string;
  objectCount: number;
  totalSize: number;
  lastModified: string | null;
  resolutions: number[];
  hasMaster: boolean;
};

export type StreamingVideoListResult = {
  items: StreamingVideoSummary[];
  nextCursor: string | null;
  bucket: string;
};

let client: S3Client | null = null;
let cachedConfig: VideoS3Config | null = null;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function getStreamingConfig(): VideoS3Config {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    endpoint: requiredEnv("VIDEO_S3_ENDPOINT"),
    region: process.env.VIDEO_S3_REGION?.trim() || "us-east-1",
    forcePathStyle: booleanEnv("VIDEO_S3_FORCE_PATH_STYLE", true),
    accessKeyId: requiredEnv("VIDEO_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("VIDEO_S3_SECRET_ACCESS_KEY"),
    bucket: process.env.VIDEO_S3_BUCKET?.trim() || DEFAULT_BUCKET,
    publicUrl: requiredEnv("VIDEO_S3_PUBLIC_URL"),
  };

  return cachedConfig;
}

function getStreamingClient(): S3Client {
  if (client) return client;

  const config = getStreamingConfig();
  client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

  return client;
}

function publicUrlForKey(publicUrl: string, key: string) {
  return `${publicUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

export function getStreamingPublicUrl(key: string) {
  return publicUrlForKey(getStreamingConfig().publicUrl, key);
}

export async function uploadStreamingObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}) {
  const config = getStreamingConfig();
  const key = input.key.replace(/^\/+/, "");

  await getStreamingClient().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl ?? "public, max-age=31536000, immutable",
    }),
  );

  return {
    key,
    url: publicUrlForKey(config.publicUrl, key),
    size: input.body.length,
    bucket: config.bucket,
  };
}

export async function streamingObjectExists(key: string) {
  const config = getStreamingConfig();
  try {
    await getStreamingClient().send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key.replace(/^\/+/, ""),
      }),
    );
    return true;
  } catch (error) {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (
      err.$metadata?.httpStatusCode === 404 ||
      err.name === "NotFound" ||
      err.name === "NoSuchKey"
    ) {
      return false;
    }
    throw error;
  }
}

export async function deleteStreamingObject(key: string) {
  const config = getStreamingConfig();
  await getStreamingClient().send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key.replace(/^\/+/, ""),
    }),
  );
}

async function listKeysByPrefix(prefix: string) {
  const config = getStreamingConfig();
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await getStreamingClient().send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix.replace(/^\/+/, ""),
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys;
}

async function summarizeStreamingVideoPrefix(
  prefix: string,
): Promise<StreamingVideoSummary | null> {
  const config = getStreamingConfig();
  const cleanPrefix = prefix.replace(/^\/+/, "");
  const match = cleanPrefix.match(/^videos\/([^/]+)\//);
  if (!match) return null;

  const videoId = match[1];
  const resolutions = new Set<number>();
  let objectCount = 0;
  let totalSize = 0;
  let lastModified: Date | null = null;
  let hasMaster = false;
  let continuationToken: string | undefined;

  do {
    const response = await getStreamingClient().send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: cleanPrefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of response.Contents ?? []) {
      const key = item.Key ?? "";
      objectCount += 1;
      totalSize += Number(item.Size ?? 0);
      if (item.LastModified && (!lastModified || item.LastModified > lastModified)) {
        lastModified = item.LastModified;
      }
      if (key === `${cleanPrefix}master.m3u8`) hasMaster = true;

      const resolution = key.match(/\/(\d{3,4})p\//);
      if (resolution) resolutions.add(Number(resolution[1]));
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  const masterKey = `${cleanPrefix}master.m3u8`;
  return {
    videoId,
    prefix: cleanPrefix,
    masterKey,
    masterUrl: publicUrlForKey(config.publicUrl, masterKey),
    objectCount,
    totalSize,
    lastModified: lastModified?.toISOString() ?? null,
    resolutions: Array.from(resolutions).sort((a, b) => a - b),
    hasMaster,
  };
}

export async function listStreamingVideos(input: {
  cursor?: string | null;
  limit?: number;
} = {}): Promise<StreamingVideoListResult> {
  const config = getStreamingConfig();
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));

  const response = await getStreamingClient().send(
    new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: "videos/",
      Delimiter: "/",
      MaxKeys: limit,
      ContinuationToken: input.cursor || undefined,
    }),
  );

  const summaries = await Promise.all(
    (response.CommonPrefixes ?? [])
      .map((item) => item.Prefix)
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => summarizeStreamingVideoPrefix(prefix)),
  );

  return {
    items: summaries.filter(
      (item): item is StreamingVideoSummary => Boolean(item),
    ),
    nextCursor: response.NextContinuationToken ?? null,
    bucket: config.bucket,
  };
}

export async function deleteStreamingVideo(videoId: string) {
  const config = getStreamingConfig();
  const cleanVideoId = videoId.trim();
  const prefix = `videos/${cleanVideoId}/`;
  const keys = await listKeysByPrefix(prefix);

  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await getStreamingClient().send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: chunk.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
  }

  return {
    videoId: cleanVideoId,
    prefix,
    deletedCount: keys.length,
    bucket: config.bucket,
  };
}

export function getStreamingBucket(): string {
  return getStreamingConfig().bucket;
}
