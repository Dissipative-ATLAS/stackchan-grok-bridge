import { DurableObject } from 'cloudflare:workers';
import { MailboxCore, routeRelayRequest } from './relay-core.mjs';

export class CallbackMailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mailbox = new MailboxCore({ storage: ctx.storage, masterToken: env.RELAY_MASTER_TOKEN });
  }

  fetch(request) { return this.mailbox.fetch(request); }
  alarm() { return this.mailbox.alarm(); }
}

export default { fetch: routeRelayRequest };
