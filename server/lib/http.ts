// HTTP helpers shared by every route in server/routes. Kept tiny on purpose
// — anything that needs more shape goes in its own module.

import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonRes = (status: number, body: unknown) => void

export function makeJsonRes(res: ServerResponse): JsonRes {
  return (status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const buf = await readBody(req)
  if (!buf.length) return null
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    return null
  }
}
