import { CircuitOpenError } from "./errors.ts";
import type { Clock } from "./types.ts";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;
  private readonly clock: Clock;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(clock: Clock, threshold = 3, cooldownMs = 30000) {
    this.clock = clock;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  async run<T>(
    operation: () => Promise<T>,
    countFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    if (this.openedAt !== undefined) {
      // Single-probe half-open: while a probe is in flight, all other callers fail fast
      // even after the cooldown elapses. A probe that hangs keeps this window open until
      // the operation's own timeout resolves it (sendWithRetry enforces one).
      if (this.clock.now() - this.openedAt < this.cooldownMs || this.probing) {
        throw new CircuitOpenError("decision circuit open");
      }
      this.probing = true;
    }

    try {
      const result = await operation();
      this.failures = 0;
      this.openedAt = undefined;
      return result;
    } catch (error) {
      if (countFailure(error)) {
        this.failures++;
        if (this.failures >= this.threshold) this.openedAt = this.clock.now();
      }
      throw error;
    } finally {
      this.probing = false;
    }
  }
}
