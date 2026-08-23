/* Mock @clerk/backend for worker smoke tests. Any Bearer token other than
   'good-token' fails verification (simulating invalid/expired/forged).

   Mirrors the REAL @clerk/backend API surface the worker uses: createClerkClient
   (for the JWKS-cache client) and the TOP-LEVEL verifyToken export. Note the
   real createClerkClient() has NO verifyToken method — verifyToken is a
   standalone export — which is what the mock must replicate. */
export function createClerkClient() {
  return { /* the real client has resources like users/sessions — none used */ };
}

export async function verifyToken(token, opts) {
  if (token === 'good-token') return { sub: 'user_123', exp: 9999999999 };
  throw new Error('invalid token');
}
