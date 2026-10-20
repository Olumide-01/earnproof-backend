import { Controller, Get, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

@Controller('api/v1/health/capabilities')
export class CapabilitiesController {
  @Get()
  getCapabilities(@Req() req: Request, @Res() res: Response) {
    const capabilityDoc = {
      version: '1.0.0',
      minClientVersion: '1.0.0',
      network: process.env.STELLAR_NETWORK || 'testnet',
      features: {
        webhooks: { concurrencyLimits: true, partitionOrdering: true },
        apiKeys: { cidrAllowlist: true },
        securityNotifications: { outboxDelivery: true },
      },
      limits: {
        maxWebhooksPerOrg: 10,
        defaultApiKeyRateLimit: 1000,
      },
      deploymentId: process.env.DEPLOYMENT_ID || 'earnproof-backend-prod',
    };

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(capabilityDoc))
      .digest('hex');
    const etag = `"${hash}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(HttpStatus.NOT_MODIFIED).send();
    }

    return res
      .setHeader('ETag', etag)
      .setHeader('Cache-Control', 'public, max-age=300, must-revalidate')
      .status(HttpStatus.OK)
      .json(capabilityDoc);
  }
}
