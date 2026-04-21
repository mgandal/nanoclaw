import { handleRequest, type Env } from './handler.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
} satisfies ExportedHandler<Env>;
