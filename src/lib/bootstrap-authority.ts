// bootstrap-authority.ts — Extension-scoped signing key for the cross-world
// profile bootstrap handshake.
//
// The MAIN-world proxy cannot trust a public key supplied through postMessage:
// page code can forge that message too. The verifier therefore carries the
// matching public key as a trust anchor, while only the service worker imports
// this private key. This is not an application secret; it authenticates the
// packaged extension code to its own MAIN-world proxy and should be rotated if
// a new extension package needs to invalidate older package code.

export const BOOTSTRAP_PRIVATE_KEY: JsonWebKey = {
  kty: 'EC',
  x: 'WBBJCNZvPlR1B70GaUW-FaFHRHVJs_8WU-7JZTSKKQo',
  y: '58WLqE1ehEMRRds74MJmoYMheCXxO3yTOkltWFl77sQ',
  crv: 'P-256',
  d: 'M_E5D7NFHmN1L1oFYm4dZ2u_iBYYXvzF7KkWsSS-eyI',
}
