type TokenGetter = () => Promise<string>

let _get: TokenGetter | null = null

export function setTokenGetter(fn: TokenGetter) {
  _get = fn
}

export async function getToken(): Promise<string | null> {
  if (!_get) return null
  try {
    return await _get()
  } catch {
    return null
  }
}
