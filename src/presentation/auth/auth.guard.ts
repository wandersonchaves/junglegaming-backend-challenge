import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Extension point for authentication (README section 2). Not implemented on purpose:
 * it is outside what this challenge scores, and the design is in ARCHITECTURE.md.
 *
 * To turn it on, validate the bearer token here against the identity provider (OIDC: Keycloak or
 * Zitadel), put the provider identity in the request, and check that the `providerId` in the body
 * matches the token. /health/* and /metrics would be marked public and skipped.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
