// navigation-bootstrap.ts — Signed identity carried by a tab-scoped DNR redirect.
//
// DNR is the only MV3 request-time primitive that can communicate a Profile
// binding to a document before page JavaScript. The values below are public
// identity assertions, not cookie material or a secret. The MAIN-world proxy
// verifies the signature against its packaged public key before using them.

import { BOOTSTRAP_PRIVATE_KEY } from './bootstrap-authority.js'

export const NAVIGATION_BOOTSTRAP_PAYLOAD_PARAM = '__sessionshift_bootstrap'
export const NAVIGATION_BOOTSTRAP_PROOF_PARAM = '__sessionshift_bootstrap_sig'

type NavigationBootstrapPayload = {
  version: 1
  sessionId: string
  navigationToken: string
}

let signerPromise: Promise<CryptoKey | null> | null = null

function getSigner(): Promise<CryptoKey | null> {
  if (!signerPromise) {
    signerPromise = crypto.subtle.importKey(
      'jwk',
      BOOTSTRAP_PRIVATE_KEY,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    ).catch(() => null)
  }
  return signerPromise
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function createNavigationBootstrapAuthorization(
  sessionId: string,
): Promise<{ payload: string; proof: string } | null> {
  const signer = await getSigner()
  if (!signer) return null
  const payload: NavigationBootstrapPayload = {
    version: 1,
    sessionId,
    navigationToken: crypto.randomUUID(),
  }
  const serialized = JSON.stringify(payload)
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer,
    new TextEncoder().encode(serialized),
  )
  return { payload: serialized, proof: bytesToBase64(signature) }
}
