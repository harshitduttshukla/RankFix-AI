import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkPolicy } from '../src/services/crawler/safe-fetch.js';
import { DEFAULT_POLICY } from '../src/services/crawler/safe-fetch.js';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
export type Route = string | { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string> } | Handler;

/** Tiny HTTP server for crawler tests. Hostname `*.test` resolves to it via testPolicy(). */
export class FixtureSite {
  routes = new Map<string, Route>();
  hits: string[] = [];
  userAgents: string[] = [];
  private server: Server | null = null;
  port = 0;

  async start() {
    this.server = createServer((req, res) => {
      const path = req.url ?? '/';
      this.hits.push(path);
      this.userAgents.push(String(req.headers['user-agent']));
      const route = this.routes.get(path) ?? this.routes.get(path.split('?')[0]!);
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
        return;
      }
      if (typeof route === 'function') return route(req, res);
      if (typeof route === 'string') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(route);
        return;
      }
      res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'text/html; charset=utf-8', ...route.headers }).end(route.body ?? '');
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
    return this;
  }

  url(host: string, path = '/') {
    return `http://${host}:${this.port}${path}`;
  }

  async stop() {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}

/** Allows loopback and any port, and resolves *.test to 127.0.0.1. Test-only. */
export function testPolicy(): NetworkPolicy {
  return {
    allowPrivate: true,
    allowedPorts: null,
    resolve: async (hostname) =>
      hostname.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 }] : DEFAULT_POLICY.resolve(hostname),
  };
}
