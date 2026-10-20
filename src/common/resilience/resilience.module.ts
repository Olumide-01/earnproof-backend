import { Global, Module } from "@nestjs/common";
import { CircuitBreakerRegistry } from "./circuit-breaker.registry";

/**
 * Provides the shared {@link CircuitBreakerRegistry}.
 *
 * Global for the same reason as observability: the registry is only useful if
 * every dependency call site and the health module resolve the *same* instance.
 * A per-module provider would give each importer its own registry, and two
 * registries protecting the same dependency is two half-informed breakers.
 */
@Global()
@Module({
  providers: [CircuitBreakerRegistry],
  exports: [CircuitBreakerRegistry],
})
export class ResilienceModule {}
