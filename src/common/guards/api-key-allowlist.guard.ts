import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
function inRange(ip: string, cidr: string): boolean {
  if (ip === cidr) return true;
  if (!cidr.includes("/")) return ip === cidr;
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits)) return false;
  const ipParts = ip.split(".").map(Number);
  const rangeParts = range.split(".").map(Number);
  if (ipParts.length === 4 && rangeParts.length === 4) {
    const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
    const rangeNum = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }
  return false;
}

@Injectable()
export class ApiKeyAllowlistGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request['apiKey']; // Populated by prior Auth Guard
    if (!apiKey || !apiKey.allowlistCidrs || apiKey.allowlistCidrs.length === 0) {
      return true; // Empty allowlist preserves default behavior
    }

    const clientIp = this.extractClientIp(request);
    if (!clientIp) {
      throw new ForbiddenException('Unable to resolve client IP address');
    }

    const isAllowed = apiKey.allowlistCidrs.some((cidr: string) =>
      inRange(clientIp, cidr),
    );

    if (!isAllowed) {
      throw new ForbiddenException(`IP address ${clientIp} is not authorized`);
    }

    return true;
  }

  private extractClientIp(req: any): string {
    const trustedProxyHeader = req.headers['x-forwarded-for'];
    if (trustedProxyHeader) {
      const ips = trustedProxyHeader.split(',').map((ip: string) => ip.trim());
      return ips[0];
    }
    return req.socket?.remoteAddress || req.ip;
  }
}
