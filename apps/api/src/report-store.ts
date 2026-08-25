import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

interface S3Sender {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
}

export class ReportStore {
  readonly #bucket: string | undefined;
  readonly #client: S3Sender | undefined;

  constructor(bucket = process.env.REPORT_BUCKET, client?: S3Sender) {
    this.#bucket = bucket?.trim() || undefined;
    this.#client = this.#bucket ? (client ?? new S3Client({})) : undefined;
  }

  get persistent(): boolean {
    return Boolean(this.#bucket && this.#client);
  }

  async put(id: string, html: string): Promise<void> {
    if (!this.#bucket || !this.#client) return;
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: keyFor(id),
        Body: html,
        ContentType: "text/html; charset=utf-8",
        CacheControl: "private, max-age=60",
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async get(id: string): Promise<string | undefined> {
    if (!this.#bucket || !this.#client) return undefined;
    try {
      const result = (await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: keyFor(id) }))) as {
        Body?: { transformToString(): Promise<string> };
      };
      return result.Body?.transformToString();
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
}

export async function persistReportBestEffort(
  store: Pick<ReportStore, "put">,
  id: string,
  html: string,
  onError: (error: unknown) => void = (error) => console.error("WidthWatch report persistence failed:", error),
): Promise<boolean> {
  try {
    await store.put(id, html);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

function keyFor(id: string): string {
  if (!/^[a-f0-9-]+$/.test(id)) throw new Error("Invalid report id.");
  return `reports/${id}.html`;
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}
