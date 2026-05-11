import { createCatchAllHandler } from '../server/dev-api.js'

export default createCatchAllHandler(process.env as Record<string, string>)
