import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './_worker.js';

test('GitHub OAuth callback, user restriction, and signed session', async (t) => {
    const env = {
        OAUTH_BASE_URL: 'https://github.com/',
        OAUTH_CLIENT_ID: 'test-client',
        OAUTH_CLIENT_SECRET: 'test-client-secret',
        OAUTH_REDIRECT_URI: 'https://2fa.example/api/oauth/callback',
        OAUTH_ID: '12345',
        JWT_SECRET: 'test-only-signing-secret',
        USER_DATA: { get: async () => null }
    };
    const authorize = await worker.fetch(new Request('https://2fa.example/api/oauth/authorize'), env);
    assert.equal(authorize.status, 302);
    const url = new URL(authorize.headers.get('Location'));
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), env.OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), env.OAUTH_REDIRECT_URI);
    const state = url.searchParams.get('state');
    assert.ok(state);
    const cookie = authorize.headers.get('Set-Cookie');
    assert.ok(cookie.startsWith(`oauth_state=${state};`));
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);

    let userId = 12345;
    let tokenRejected = false;
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (target, options) => {
        calls.push(target);
        if (target === 'https://github.com/login/oauth/access_token') {
            assert.equal(options.method, 'POST');
            assert.equal(options.headers.Accept, 'application/json');
            assert.equal(options.body.get('client_secret'), env.OAUTH_CLIENT_SECRET);
            assert.equal(options.body.get('redirect_uri'), env.OAUTH_REDIRECT_URI);
            assert.equal(options.body.get('code'), 'test-code');
            return Response.json(tokenRejected ? { error: 'bad_verification_code' } : { access_token: 'test-token' });
        }
        assert.equal(target, 'https://api.github.com/user');
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        return Response.json({ id: userId, login: 'test-user', name: '测试用户 🔐', email: null, avatar_url: 'https://avatars.githubusercontent.com/u/12345' });
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});

    const callback = (callbackState = state) => worker.fetch(new Request(env.OAUTH_REDIRECT_URI, {
        method: 'POST',
        headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'test-code', state: callbackState })
    }), env);

    const landing = await worker.fetch(new Request(`${env.OAUTH_REDIRECT_URI}?code=test-code&state=${state}`), env);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /processOAuthCallback/);

    assert.equal((await callback('wrong-state')).status, 400);
    assert.equal(calls.length, 0, 'state mismatch must not contact GitHub');
    const response = await callback();
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.userInfo.username, 'test-user');
    assert.equal(data.userInfo.nickname, '测试用户 🔐');
    assert.equal(data.userInfo.avatar_template, 'https://avatars.githubusercontent.com/u/12345');
    const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(payload.userInfo.nickname, '测试用户 🔐');
    const accounts = await worker.fetch(new Request('https://2fa.example/api/accounts', {
        headers: { Authorization: `Bearer ${data.token}` }
    }), env);
    assert.equal(accounts.status, 200);
    assert.deepEqual(await accounts.json(), { accounts: [] });
    const invalidSession = await worker.fetch(new Request('https://2fa.example/api/accounts', {
        headers: { Authorization: `Bearer ${data.token}` }
    }), { ...env, JWT_SECRET: 'wrong-secret' });
    assert.equal(invalidSession.status, 401);

    userId = 99999;
    assert.equal((await callback()).status, 403, 'other GitHub users must be rejected');
    tokenRejected = true;
    const before = calls.length;
    assert.equal((await callback()).status, 500);
    assert.equal(calls.length, before + 1, 'failed token exchange must not fetch a user');
});

test('existing OAuth service retains its endpoints and user mapping', async (t) => {
    const env = {
        OAUTH_BASE_URL: 'https://oauth.example', OAUTH_CLIENT_ID: 'client',
        OAUTH_CLIENT_SECRET: 'secret', OAUTH_REDIRECT_URI: 'https://2fa.example/api/oauth/callback',
        OAUTH_ID: '12345', JWT_SECRET: 'test-only-secret'
    };
    const authorize = await worker.fetch(new Request('https://2fa.example/api/oauth/authorize'), env);
    const url = new URL(authorize.headers.get('Location'));
    assert.equal(url.origin + url.pathname, 'https://oauth.example/oauth2/authorize');
    t.mock.method(globalThis, 'fetch', async (target) => {
        if (target === 'https://oauth.example/oauth2/token') return Response.json({ access_token: 'token' });
        assert.equal(target, 'https://oauth.example/api/user');
        return Response.json({ id: 12345, username: 'original-user' });
    });
    t.mock.method(console, 'log', () => {});
    const response = await worker.fetch(new Request(env.OAUTH_REDIRECT_URI, {
        method: 'POST', headers: { Cookie: authorize.headers.get('Set-Cookie').split(';')[0] },
        body: JSON.stringify({ code: 'code', state: url.searchParams.get('state') })
    }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).userInfo.username, 'original-user');
});
