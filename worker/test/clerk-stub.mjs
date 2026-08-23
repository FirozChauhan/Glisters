/* Mock @clerk/backend for worker smoke tests. Any Bearer token other than
   'good-token' fails verification (simulating invalid/expired/forged). */
export function createClerkClient() {
  return {
    async verifyToken(token) {
      if (token === 'good-token') return { sub: 'user_123', exp: 9999999999 };
      throw new Error('invalid token');
    },
  };
}
