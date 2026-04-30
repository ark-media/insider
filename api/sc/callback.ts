import { createRouteHandler } from '../../server/dev-api.js'

export default createRouteHandler(
  process.env as Record<string, string>,
  '/api/sc/callback',
)
