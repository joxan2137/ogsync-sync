// Per-place op admission. Studio runs every DataModel of a place on one main
// thread, so fan-out from parallel agents only starves its renderer; ops run
// `concurrency` at a time and clients take turns round-robin, so one chatty
// session cannot push another's single call to the back of a long line.

export class FairScheduler<T> {
  readonly #concurrency: number;
  readonly #queues = new Map<string, T[]>();
  readonly #ring: string[] = [];
  readonly #starters = new Map<T, (item: T) => void>();
  readonly #active = new Set<T>();
  /** Client of the most recent start: it yields to anyone else waiting. */
  #lastClient: string | null = null;

  constructor(concurrency = 1) {
    this.#concurrency = Math.max(1, concurrency);
  }

  get running(): number {
    return this.#active.size;
  }

  get waiting(): number {
    let total = 0;
    for (const queue of this.#queues.values()) total += queue.length;
    return total;
  }

  submit(client: string, item: T, start: (item: T) => void): void {
    this.#starters.set(item, start);
    const queue = this.#queues.get(client);
    if (queue) queue.push(item);
    else {
      this.#queues.set(client, [item]);
      this.#ring.push(client);
    }
    this.#pump();
  }

  /** Drops a waiting item; false when it already started (release it instead). */
  cancel(item: T): boolean {
    for (const [client, queue] of this.#queues) {
      const index = queue.indexOf(item);
      if (index === -1) continue;
      queue.splice(index, 1);
      this.#starters.delete(item);
      if (queue.length === 0) this.#forget(client);
      return true;
    }
    return false;
  }

  release(item: T): void {
    if (!this.#active.delete(item)) return;
    this.#pump();
  }

  #pump(): void {
    while (this.#active.size < this.#concurrency && this.#ring.length > 0) {
      const turn = this.#ring.findIndex((candidate) => candidate !== this.#lastClient);
      const client = this.#ring.splice(turn === -1 ? 0 : turn, 1)[0]!;
      this.#lastClient = client;
      const queue = this.#queues.get(client)!;
      const item = queue.shift()!;
      if (queue.length > 0) this.#ring.push(client);
      else this.#queues.delete(client);
      const start = this.#starters.get(item)!;
      this.#starters.delete(item);
      this.#active.add(item);
      start(item);
    }
  }

  #forget(client: string): void {
    this.#queues.delete(client);
    const index = this.#ring.indexOf(client);
    if (index !== -1) this.#ring.splice(index, 1);
  }
}
