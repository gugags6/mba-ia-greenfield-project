import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * For routes marked `@Public()` that still want to know who the caller is
 * when a valid token happens to be present (e.g. owner-only visibility on an
 * otherwise-public endpoint). Never rejects the request: a missing or
 * invalid token simply leaves `request.user` unset, so downstream code
 * treats the caller as anonymous. The route's own business rule — not this
 * guard — decides what anonymous vs. authenticated callers may see.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      return true;
    }

    const token = authHeader.slice(BEARER_PREFIX.length);
    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      // Invalid/expired token on an optional-auth route — proceed as anonymous.
    }
    return true;
  }
}
