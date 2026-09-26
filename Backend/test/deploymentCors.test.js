import test from 'node:test';
import assert from 'node:assert/strict';

test('Vercel API allows only configured frontend preflights', async () => {
  process.env.VERCEL = '1';
  process.env.JWT_SECRET = 'test-secret-with-at-least-thirty-two-characters';
  process.env.FRONTEND_ORIGINS = 'https://trashquest.example';
  const { default: app } = await import('../src/server.js');
  const server = app.listen(0);
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/api/auth/login`;
    const allowed = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://trashquest.example' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://trashquest.example');

    const denied = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
