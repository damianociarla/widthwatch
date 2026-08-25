export type EgressBudgetScope = "response" | "tunnel" | "total";

export interface EgressTransferLimits {
  maxBytesPerResponse: number;
  maxBytesPerTunnel: number;
  maxTransferredBytes: number;
}

export interface EgressByteMeter {
  readonly bytes: number;
  add(bytes: number): boolean;
}

export class EgressBudgetExceededError extends Error {
  constructor(
    readonly scope: EgressBudgetScope,
    readonly limit: number,
    readonly observedBytes: number,
  ) {
    super(`Hosted egress ${scope} byte budget exceeded (${limit} bytes allowed).`);
    this.name = "EgressBudgetExceededError";
  }
}

export class EgressTransferBudget {
  readonly signal: AbortSignal;
  readonly limits: Readonly<EgressTransferLimits>;
  #controller = new AbortController();
  #transferredBytes = 0;
  #error: EgressBudgetExceededError | undefined;

  constructor(limits: EgressTransferLimits) {
    validateLimits(limits);
    this.limits = Object.freeze({ ...limits });
    this.signal = this.#controller.signal;
  }

  get transferredBytes(): number {
    return this.#transferredBytes;
  }

  get error(): EgressBudgetExceededError | undefined {
    return this.#error;
  }

  assertAvailable(): void {
    if (this.#error) throw this.#error;
  }

  openResponse(contentLength?: number): EgressByteMeter {
    this.assertAvailable();
    if (contentLength !== undefined) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error("Invalid upstream Content-Length.");
      if (contentLength > this.limits.maxBytesPerResponse)
        this.#exhaust(new EgressBudgetExceededError("response", this.limits.maxBytesPerResponse, contentLength));
      else if (this.#transferredBytes + contentLength > this.limits.maxTransferredBytes)
        this.#exhaust(new EgressBudgetExceededError("total", this.limits.maxTransferredBytes, this.#transferredBytes + contentLength));
    }
    return this.#openMeter("response", this.limits.maxBytesPerResponse);
  }

  openTunnel(): EgressByteMeter {
    this.assertAvailable();
    return this.#openMeter("tunnel", this.limits.maxBytesPerTunnel);
  }

  addTransferredBytes(bytes: number): boolean {
    if (!validChunkSize(bytes) || this.#error) return false;
    this.#transferredBytes += bytes;
    if (this.#transferredBytes > this.limits.maxTransferredBytes)
      this.#exhaust(new EgressBudgetExceededError("total", this.limits.maxTransferredBytes, this.#transferredBytes));
    return !this.#error;
  }

  #addScopedBytes(scope: Exclude<EgressBudgetScope, "total">, scopedBytes: number, limit: number, bytes: number): boolean {
    if (!this.addTransferredBytes(bytes)) return false;
    if (scopedBytes > limit) this.#exhaust(new EgressBudgetExceededError(scope, limit, scopedBytes));
    return !this.#error;
  }

  #openMeter(scope: Exclude<EgressBudgetScope, "total">, limit: number): EgressByteMeter {
    let scopedBytes = 0;
    return {
      get bytes() {
        return scopedBytes;
      },
      add: (bytes) => {
        if (!validChunkSize(bytes)) return false;
        scopedBytes += bytes;
        return this.#addScopedBytes(scope, scopedBytes, limit, bytes);
      },
    };
  }

  #exhaust(error: EgressBudgetExceededError): void {
    if (this.#error) return;
    this.#error = error;
    this.#controller.abort(error);
  }
}

function validChunkSize(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0;
}

function validateLimits(limits: EgressTransferLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number of bytes.`);
  }
  if (limits.maxBytesPerResponse > limits.maxTransferredBytes) throw new Error("maxBytesPerResponse cannot exceed maxTransferredBytes.");
  if (limits.maxBytesPerTunnel > limits.maxTransferredBytes) throw new Error("maxBytesPerTunnel cannot exceed maxTransferredBytes.");
}
