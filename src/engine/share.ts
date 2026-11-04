// URL-hash state: JSON -> deflate-raw -> base64url.

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export async function encodeState(state: unknown): Promise<string> {
  const z = await pipe(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream('deflate-raw'))
  let s = ''
  for (const b of z) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function decodeState<T>(hash: string): Promise<T | null> {
  try {
    const b64 = hash.replace(/^#/, '').replace(/^s=/, '').replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')))
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
