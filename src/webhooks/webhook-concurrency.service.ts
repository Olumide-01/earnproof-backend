import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WebhookConcurrencyService {
  private readonly logger = new Logger(WebhookConcurrencyService.name);
  private activeConcurrencyMap = new Map<string, number>();
  private queues = new Map<string, Array<() => Promise<void>>>();

  async acquireLease(endpointId: string, limit: number): Promise<boolean> {
    const current = this.activeConcurrencyMap.get(endpointId) || 0;
    if (current >= limit) {
      return false;
    }
    this.activeConcurrencyMap.set(endpointId, current + 1);
    return true;
  }

  async releaseLease(endpointId: string): Promise<void> {
    const current = this.activeConcurrencyMap.get(endpointId) || 0;
    if (current > 0) {
      this.activeConcurrencyMap.set(endpointId, current - 1);
    }
    this.processNext(endpointId);
  }

  enqueuePartitionTask(partitionKey: string, task: () => Promise<void>): void {
    if (!this.queues.has(partitionKey)) {
      this.queues.set(partitionKey, []);
    }
    this.queues.get(partitionKey)!.push(task);
  }

  private async processNext(partitionKey: string): Promise<void> {
    const queue = this.queues.get(partitionKey);
    if (queue && queue.length > 0) {
      const nextTask = queue.shift();
      if (nextTask) {
        try {
          await nextTask();
        } catch (err) {
          this.logger.error(`Error executing queued task for ${partitionKey}`, err);
        }
      }
    }
  }
}
