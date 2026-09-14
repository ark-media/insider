import { createCatchAllHandler } from '../server/api.js'

export default createCatchAllHandler(process.env as Record<string, string>)
