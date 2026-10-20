import { Injectable, NotFoundException } from "@nestjs/common";
import { PaymentClassification } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  PaymentClassificationHistoryDto,
  ListPaymentClassificationHistoryDto,
} from "./dto/payment-classification-history.dto";

@Injectable()
export class PaymentClassificationHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get classification history for a payment.
   * Only the payment owner can view the history.
   */
  async getPaymentHistory(
    user: AuthenticatedUser,
    paymentId: string,
    query: ListPaymentClassificationHistoryDto,
  ): Promise<{
    items: PaymentClassificationHistoryDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    // Verify payment ownership
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId: user.id,
      },
      select: { id: true },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.paymentClassificationHistory.findMany({
        where: { paymentId },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.paymentClassificationHistory.count({
        where: { paymentId },
      }),
    ]);

    return {
      items: items.map((item) => this.toDto(item)),
      total,
      page,
      limit,
    };
  }

  /**
   * Record a classification change in history.
   * This is called internally by the payments service during atomic updates.
   */
  async recordClassificationChange(
    paymentId: string,
    actorId: string,
    previousClassification: PaymentClassification,
    newClassification: PaymentClassification,
    reasonCode: string,
    classificationRevision: number,
  ): Promise<void> {
    await this.prisma.paymentClassificationHistory.create({
      data: {
        paymentId,
        actorId,
        previousClassification,
        newClassification,
        reasonCode,
        classificationRevision,
      },
    });
  }

  private toDto(history: any): PaymentClassificationHistoryDto {
    return {
      id: history.id,
      paymentId: history.paymentId,
      actorId: history.actorId,
      previousClassification: history.previousClassification,
      newClassification: history.newClassification,
      reasonCode: history.reasonCode,
      classificationRevision: history.classificationRevision,
      createdAt: history.createdAt,
    };
  }
}