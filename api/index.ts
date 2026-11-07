import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServerlessExpressApp } from '../src/main.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getServerlessExpressApp();
  return app(req, res);
}
