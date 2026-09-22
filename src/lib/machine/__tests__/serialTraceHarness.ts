/**
 * Unified ordered test harness for serial command recording.
 * Records every invoke() call in order with command name, args, and a controllable promise.
 * Default: immediate resolution through onSend callback (backward compatible).
 * Opt-in deferral per command name.
 * Derived views sentCommands() and sentBytes() preserve backward compatibility with existing assertions.
 */

interface InvokeRecord {
  command: string;
  args: Record<string, unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  result?: unknown;
}

interface NativeJobEvent {
  type: "progress" | "console" | "status" | "finished";
  lineIndex?: number;
  total?: number;
  text?: string;
  status?: string;
  result?: string;
}

export class SerialTraceRecorder {
  private records: InvokeRecord[] = [];
  private deferredCommands = new Set<string>();
  private channelHandlers = new Map<string, ((event: unknown) => void) | null>();
  private startedJobPromises: Promise<unknown>[] = [];
  private onSend: ((command: string) => { responses: string[]; drained: string[] }) | null = null;
  private _jobEpoch = 0;

  constructor(
    onSend?: (command: string) => { responses: string[]; drained: string[] }
  ) {
    this.onSend = onSend || null;
  }

  /**
   * Mark a command name as deferred (returns controllable promise).
   * Default: immediate resolution through onSend callback.
   */
  defer(commandName: string): void {
    this.deferredCommands.add(commandName);
  }

  /**
   * The invoke handler to wire into mockInvoke.mockImplementation.
   * Records each command and returns a promise: immediate if not deferred, controllable if deferred.
   */
  handler = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const resolverPair: {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    } = { resolve: () => {}, reject: () => {} };

    const promise = new Promise<unknown>((resolve, reject) => {
      resolverPair.resolve = resolve;
      resolverPair.reject = reject;
    });

    const record: InvokeRecord = {
      command: cmd,
      args: args || {},
      promise,
      resolve: resolverPair.resolve,
      reject: resolverPair.reject,
    };
    this.records.push(record);

    // Handle special cases first
    if (cmd === "list_serial_ports") {
      const result: unknown[] = [];
      record.result = result;
      resolverPair.resolve(result);
      return result;
    }

    // Capture serial_stream_job channel for event delivery.
    // Use the record's actual index (length - 1, since it was just pushed).
    if (cmd === "serial_stream_job") {
      const channelArg = args?.channel as any;
      if (channelArg) {
        this.channelHandlers.set(`stream_${this.records.length - 1}`, channelArg.onmessage);
      }
    }

    // If deferred, leave the promise pending for manual release
    if (this.deferredCommands.has(cmd)) {
      return promise;
    }

    // Default: immediate resolution through onSend callback
    if (cmd === "serial_send" && this.onSend) {
      const result = this.onSend((args?.command as string) || "");
      record.result = result;
      resolverPair.resolve(result);
      return result;
    }

    if (cmd === "serial_send_byte") {
      // No-op for bytes by default
      record.result = undefined;
      resolverPair.resolve(undefined);
      return undefined;
    }

    if (cmd === "serial_get_status") {
      // Default status response
      record.result = { status: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>", events: [] };
      resolverPair.resolve(record.result);
      return record.result;
    }

    // B3: backend job lifecycle commands.
    if (cmd === "serial_job_begin") {
      const jobId = ++this._jobEpoch;
      record.result = jobId;
      resolverPair.resolve(jobId);
      return jobId;
    }

    if (cmd === "serial_job_end") {
      record.result = undefined;
      resolverPair.resolve(undefined);
      return undefined;
    }

    // Generic default: resolve to undefined
    record.result = undefined;
    resolverPair.resolve(undefined);
    return undefined;
  };

  /**
   * Wait until a command with the given name appears in the recorder.
   * Rejects with timeout if it doesn't arrive within timeoutMs.
   */
  async waitUntilInvoked(
    commandName: string,
    options?: { timeoutMs?: number }
  ): Promise<number> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const index = this.records.findIndex((r) => r.command === commandName);
      if (index >= 0) return index;
      await new Promise((r) => setTimeout(r, 10));
    }

    const recordSummary = this.records
      .map((r, i) => `${i}: ${r.command}`)
      .join("; ");
    throw new Error(
      `Timeout waiting for "${commandName}" (${timeoutMs}ms). Recorded: ${recordSummary}`
    );
  }

  /**
   * Resolve a deferred invoke at the given index.
   * Resolves the promise with the provided result.
   */
  releaseInvoke(index: number, result: unknown): void {
    if (index < 0 || index >= this.records.length) {
      throw new Error(`Invalid record index: ${index} (length: ${this.records.length})`);
    }
    const record = this.records[index];
    record.result = result;
    record.resolve(result);
  }

  /**
   * Deliver a native job event to the stream channel.
   * Used to simulate events from the Rust side.
   */
  emit(fixture: NativeJobEvent): void {
    // Find the most recent serial_stream_job invocation
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].command === "serial_stream_job") {
        const channelKey = `stream_${i}`;
        const onmessage = this.channelHandlers.get(channelKey);
        if (onmessage) {
          onmessage(fixture);
          return;
        }
      }
    }
    throw new Error("No active serial_stream_job channel to emit to");
  }

  /**
   * Derived view: all serial_send commands in order.
   * Backward compatible with existing tests that use sentCommands().
   */
  sentCommands(): string[] {
    return this.records
      .filter((r) => r.command === "serial_send")
      .map((r) => (r.args.command as string) || "");
  }

  /**
   * Derived view: all serial_send_byte calls in order.
   * Backward compatible with existing tests that use sentBytes().
   */
  sentBytes(): number[] {
    return this.records
      .filter((r) => r.command === "serial_send_byte")
      .map((r) => (r.args.byte as number) || 0);
  }

  /**
   * Get all recorded invocations in order.
   * Each record includes command name, args, and result.
   */
  allRecords(): Array<{ command: string; args: Record<string, unknown>; result?: unknown }> {
    return this.records.map((r) => ({
      command: r.command,
      args: r.args,
      result: r.result,
    }));
  }

  /**
   * Find records by command name.
   */
  findRecords(commandName: string): Array<{ args: Record<string, unknown>; result?: unknown }> {
    return this.records
      .filter((r) => r.command === commandName)
      .map((r) => ({
        args: r.args,
        result: r.result,
      }));
  }

  /**
   * Get the index of a specific record for later use with releaseInvoke.
   */
  getRecordIndex(commandName: string, occurence = 0): number {
    let count = 0;
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].command === commandName) {
        if (count === occurence) return i;
        count++;
      }
    }
    return -1;
  }

  /**
   * Clean up: reject all pending deferreds and await any started job promise.
   * Must be called in afterEach to prevent leaks.
   */
  async dispose(): Promise<void> {
    const error = new Error("Recorder disposed");
    for (const record of this.records) {
      if (!record.result && this.deferredCommands.has(record.command)) {
        record.reject(error);
      }
    }
    // Await any job promises that were started
    if (this.startedJobPromises.length > 0) {
      try {
        await Promise.race([
          Promise.all(this.startedJobPromises),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Job cleanup timeout")), 1000)),
        ]);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.records = [];
    this.channelHandlers.clear();
    this.startedJobPromises = [];
  }

  /**
   * Track a job promise for cleanup.
   */
  trackJobPromise(promise: Promise<unknown>): void {
    this.startedJobPromises.push(promise);
  }
}
