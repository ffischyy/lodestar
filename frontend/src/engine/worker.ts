import { runJob, type Job } from "./lab";

/** Runs long model jobs off the main thread so the interface stays responsive. */
self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const result = runJob(e.data, (p, message, partial) => self.postMessage({ p, message, partial }));
    self.postMessage({ done: true, result });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
