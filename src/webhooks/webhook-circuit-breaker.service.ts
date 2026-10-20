import { Injectable, Logger } from "@nestjs/common";
import { WebhookCircuitState } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

export interface CircuitConfig {
  failureThreshold: number;
  recoveryWindowMs: number;
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  recoveryWindowMs: 300_000, // 5 minutes
};

@Injectable()
export class WebhookCircuitBreakerService {
  private readonly logger = new Logger(WebhookCircuitBreakerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initialize circuit state for a webhook if it doesn't exist.
   */
  async initializeCircuit(
    webhookId: string,
    config: Partial<CircuitConfig> = {},
  ): Promise<void> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    await this.prisma.webhookCircuitState.upsert({
      where: { webhookId },
      update: {
        failureThreshold: finalConfig.failureThreshold,
        recoveryWindowMs: finalConfig.recoveryWindowMs,
      },
      create: {
        webhookId,
        state: WebhookCircuitState.CLOSED,
        failureCount: 0,
        failureThreshold: finalConfig.failureThreshold,
        recoveryWindowMs: finalConfig.recoveryWindowMs,
      },
    });
  }

  /**
   * Check if the circuit allows delivery attempts.
   * Returns false if circuit is OPEN.
   */
  async canAttemptDelivery(webhookId: string): Promise<boolean> {
    const circuit = await this.getOrCreateCircuitState(webhookId);
    
    if (circuit.state === WebhookCircuitState.CLOSED) {
      return true;
    }

    if (circuit.state === WebhookCircuitState.OPEN) {
      // Check if recovery window has passed
      if (this.shouldTransitionToHalfOpen(circuit)) {
        await this.transitionToHalfOpen(webhookId);
        return true;
      }
      return false;
    }

    // HALF_OPEN state - allow one probe attempt
    return true;
  }

  /**
   * Record a successful delivery.
   * Closes the circuit and resets failure count.
   */
  async recordSuccess(webhookId: string): Promise<void> {
    const circuit = await this.getOrCreateCircuitState(webhookId);
    
    await this.prisma.webhookCircuitState.update({
      where: { webhookId },
      data: {
        state: WebhookCircuitState.CLOSED,
        failureCount: 0,
        lastSuccessAt: new Date(),
        halfOpenAt: null,
      },
    });

    if (circuit.state !== WebhookCircuitState.CLOSED) {
      this.logger.log(`Circuit for webhook ${webhookId} closed after successful delivery`);
    }
  }

  /**
   * Record a delivery failure.
   * May open the circuit if threshold is reached.
   */
  async recordFailure(webhookId: string, isPermanentFailure: boolean): Promise<void> {
    // Don't count permanent policy failures as circuit failures
    if (isPermanentFailure) {
      return;
    }

    const circuit = await this.getOrCreateCircuitState(webhookId);
    const newFailureCount = circuit.failureCount + 1;
    const shouldOpen = newFailureCount >= circuit.failureThreshold;

    const updateData: any = {
      failureCount: newFailureCount,
      lastFailureAt: new Date(),
    };

    if (circuit.state === WebhookCircuitState.HALF_OPEN) {
      // Failed probe - reopen circuit
      updateData.state = WebhookCircuitState.OPEN;
      updateData.openedAt = new Date();
      updateData.halfOpenAt = null;
    } else if (shouldOpen && circuit.state === WebhookCircuitState.CLOSED) {
      // Threshold reached - open circuit
      updateData.state = WebhookCircuitState.OPEN;
      updateData.openedAt = new Date();
    }

    await this.prisma.webhookCircuitState.update({
      where: { webhookId },
      data: updateData,
    });

    if (shouldOpen && circuit.state === WebhookCircuitState.CLOSED) {
      this.logger.warn(
        `Circuit for webhook ${webhookId} opened after ${newFailureCount} failures`
      );
    } else if (circuit.state === WebhookCircuitState.HALF_OPEN) {
      this.logger.warn(
        `Circuit for webhook ${webhookId} reopened after failed probe`
      );
    }
  }

  /**
   * Get current circuit state for a webhook.
   */
  async getCircuitState(webhookId: string): Promise<WebhookCircuitState | null> {
    const circuit = await this.prisma.webhookCircuitState.findUnique({
      where: { webhookId },
      select: { state: true },
    });
    return circuit?.state || null;
  }

  /**
   * Update circuit configuration.
   * Handles state transitions if thresholds change.
   */
  async updateConfig(
    webhookId: string,
    config: Partial<CircuitConfig>,
  ): Promise<void> {
    const circuit = await this.getOrCreateCircuitState(webhookId);
    
    const updateData: any = {};
    if (config.failureThreshold !== undefined) {
      updateData.failureThreshold = config.failureThreshold;
      
      // If current failure count no longer exceeds new threshold, close circuit
      if (
        circuit.state === WebhookCircuitState.OPEN &&
        circuit.failureCount < config.failureThreshold
      ) {
        updateData.state = WebhookCircuitState.CLOSED;
        updateData.openedAt = null;
      }
    }
    
    if (config.recoveryWindowMs !== undefined) {
      updateData.recoveryWindowMs = config.recoveryWindowMs;
    }

    await this.prisma.webhookCircuitState.update({
      where: { webhookId },
      data: updateData,
    });
  }

  /**
   * Clean up circuit state when webhook is deleted.
   */
  async deleteCircuitState(webhookId: string): Promise<void> {
    await this.prisma.webhookCircuitState.deleteMany({
      where: { webhookId },
    });
  }

  /**
   * Get circuit statistics for monitoring.
   */
  async getCircuitStats(webhookId: string): Promise<{
    state: WebhookCircuitState;
    failureCount: number;
    failureThreshold: number;
    lastFailureAt?: Date;
    lastSuccessAt?: Date;
    openedAt?: Date;
  } | null> {
    const circuit = await this.prisma.webhookCircuitState.findUnique({
      where: { webhookId },
      select: {
        state: true,
        failureCount: true,
        failureThreshold: true,
        lastFailureAt: true,
        lastSuccessAt: true,
        openedAt: true,
      },
    });

    return circuit;
  }

  private async getOrCreateCircuitState(webhookId: string) {
    let circuit = await this.prisma.webhookCircuitState.findUnique({
      where: { webhookId },
    });

    if (!circuit) {
      await this.initializeCircuit(webhookId);
      circuit = await this.prisma.webhookCircuitState.findUniqueOrThrow({
        where: { webhookId },
      });
    }

    return circuit;
  }

  private shouldTransitionToHalfOpen(circuit: any): boolean {
    if (!circuit.openedAt) return false;
    
    const now = Date.now();
    const openedTime = circuit.openedAt.getTime();
    return now - openedTime >= circuit.recoveryWindowMs;
  }

  private async transitionToHalfOpen(webhookId: string): Promise<void> {
    // Use updateMany to prevent race conditions with concurrent transitions
    const result = await this.prisma.webhookCircuitState.updateMany({
      where: {
        webhookId,
        state: WebhookCircuitState.OPEN,
      },
      data: {
        state: WebhookCircuitState.HALF_OPEN,
        halfOpenAt: new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.log(`Circuit for webhook ${webhookId} transitioned to HALF_OPEN for probe`);
    }
  }
}