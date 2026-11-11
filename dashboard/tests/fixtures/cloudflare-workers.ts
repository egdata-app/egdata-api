/**
 * Node-based unit tests cannot resolve the workerd `cloudflare:workers`
 * module. This minimal stub mirrors the DurableObject base surface used by the
 * quota class so tests can instantiate it with a fake SQL storage.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
