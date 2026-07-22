/**
 * Bounded per-message serialization for message logging lifecycle events.
 *
 * Each message ID owns an independent FIFO "lane": tasks queued for the same ID
 * run one at a time in submission order, while tasks for different IDs proceed
 * concurrently. A task failure never blocks later tasks on the same lane, and a
 * lane's bookkeeping is removed once it drains so the queue stays bounded.
 */
export class MessageLaneQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Number of message lanes that currently have queued or running work. */
  public get size(): number {
    return this.tails.size;
  }

  /**
   * Run `task` on the lane for `key`, after every previously queued task for that
   * key. The returned promise settles with `task`'s outcome; the internal chain
   * swallows failures so a rejection cannot poison later tasks on the same lane.
   */
  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /**
   * Run `task` exactly once, serialized across every lane in `keys`. `task` starts
   * only after all previously queued work on each key has drained, and each key's
   * lane stays reserved until `task` settles, so a bulk operation cannot race
   * single-message handlers for any member ID. Enqueueing only ever appends to a
   * lane (it never blocks holding one lane while waiting for another), which keeps
   * this deadlock-free even when bulk and single-message handlers share IDs.
   */
  public runMany(
    keys: readonly string[],
    task: () => Promise<void>,
  ): Promise<void> {
    const unique = [...new Set(keys)].sort();
    if (unique.length === 0) return task();
    let reached = 0;
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let shared: Promise<void> | null = null;
    const laneTask = async (): Promise<void> => {
      reached += 1;
      if (reached === unique.length) open();
      await gate;
      if (shared === null) shared = Promise.resolve().then(task);
      await shared;
    };
    const lanes = unique.map((key) => this.run(key, laneTask));
    return Promise.all(lanes).then(() => undefined);
  }
}
