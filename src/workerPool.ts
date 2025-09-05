import { Worker } from "worker_threads";
import * as os from "os";

export interface WorkerTask<TIn, TOut> {
  id: number;
  payload: TIn;
  resolve: (value: TOut) => void;
  reject: (reason?: any) => void;
}

export class WorkerPool<TIn = any, TOut = any> {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: Array<WorkerTask<TIn, TOut>> = [];
  private nextId = 1;
  private closed = false;

  constructor(private workerPath: string, size?: number) {
    const poolSize = Math.max(1, Math.min(size ?? Math.max(1, os.cpus().length - 1), 8));
    for (let i = 0; i < poolSize; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    const worker = new Worker(this.workerPath);
    const onMessage = (msg: any) => {
      const { id, result, error } = msg || {};
      const taskIndex = this.queue.findIndex((t) => t.id === id && (t as any)._inflight);
      const task = taskIndex >= 0 ? this.queue[taskIndex] : undefined;
      if (!task) {
        // Unexpected; ignore
        return;
      }
      // Remove the inflight flag and the task from queue
      (task as any)._inflight = false;
      this.queue.splice(taskIndex, 1);
      if (error) {
        task.reject(error);
      } else {
        task.resolve(result);
      }
      if (!this.closed) {
        this.idleWorkers.push(worker);
        this.dequeue();
      }
    };
    const onError = (err: any) => {
      // Fail the current inflight task if any
      const inflight = this.queue.find((t) => (t as any)._inflight && (t as any)._worker === worker);
      if (inflight) {
        inflight.reject(err);
        (inflight as any)._inflight = false;
        this.queue = this.queue.filter((t) => t !== inflight);
      }
      // Remove this worker and replace it if pool not closed
      this.workers = this.workers.filter((w) => w !== worker);
      this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
      if (!this.closed) {
        this.addWorker();
      }
    };
    const onExit = () => {
      this.workers = this.workers.filter((w) => w !== worker);
      this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
      if (!this.closed) {
        this.addWorker();
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  run(payload: TIn): Promise<TOut> {
    if (this.closed) {
      return Promise.reject(new Error("WorkerPool is closed"));
    }
    const id = this.nextId++;
    return new Promise<TOut>((resolve, reject) => {
      const task: WorkerTask<TIn, TOut> = { id, payload, resolve, reject } as any;
      (task as any)._inflight = false;
      this.queue.push(task);
      this.dequeue();
    });
  }

  private dequeue() {
    while (this.idleWorkers.length > 0) {
      const nextTaskIndex = this.queue.findIndex((t) => !(t as any)._inflight);
      if (nextTaskIndex === -1) break;
      const task = this.queue[nextTaskIndex];
      const worker = this.idleWorkers.pop()!;
      (task as any)._inflight = true;
      (task as any)._worker = worker;
      worker.postMessage({ id: task.id, payload: task.payload });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.workers];
    this.workers = [];
    this.idleWorkers = [];
    await Promise.allSettled(workers.map((w) => w.terminate()));
  }
}

