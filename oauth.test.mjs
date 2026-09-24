import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import worker from './_worker.js';

test('homepage restores Base64URL sessions and rejects expired or malformed tokens', async () => {
    const html = await (await worker.fetch(new Request('https://2fa.example/'), {
        OAUTH_BASE_URL: 'https://github.com'
    })).text();
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const userInfo = { nickname: '测试 🔐😀' };
    const payload = { userInfo, exp: Math.floor(Date.now() / 1000) + 3600 };
    const tokenFor = (value) => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
    const validToken = tokenFor(payload);
    assert.match(validToken.split('.')[1], /[-_]/, 'exercise Base64URL characters rejected by plain atob');
    for (const [token, valid] of [
        [validToken, true],
        [tokenFor({ ...payload, exp: 1 }), false],
        ['malformed', false],
        [null, false]
    ]) {
        const storage = new Map([['authToken', token], ['loginTime', String(Date.now())], ['userInfo', JSON.stringify(userInfo)]]);
        const events = [];
        runInNewContext(script + `
            showMainSection = () => events.push('main');
            showLoginSection = () => events.push('login');
            refreshAccounts = () => {};
            startSessionTimer = () => {};
            setupEventListeners = () => {};
            stopCamera = () => {};
            showFloatingMessage = message => events.push(message);
            initializeApp();
        `, {
            localStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
            document: { addEventListener() {} },
            atob, TextDecoder, Uint8Array, events
        });
        assert.deepEqual(events, [valid ? 'main' : 'login']);
        assert.equal(storage.has('authToken'), valid);
    }
});

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

test('OAuth failures identify missing secrets or GitHub errors without exposing credentials', async (t) => {
    const env = {
        OAUTH_BASE_URL: 'https://github.com', OAUTH_CLIENT_ID: 'client',
        OAUTH_CLIENT_SECRET: 'private-client-secret', OAUTH_REDIRECT_URI: 'https://2fa.example/api/oauth/callback',
        OAUTH_ID: '12345', JWT_SECRET: 'private-jwt-secret'
    };
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    let reply;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(reply));
    const cases = [
        [{ ...env, JWT_SECRET: undefined }, null, 'JWT_SECRET', 'MISSING_CONFIG'],
        [{ ...env, OAUTH_CLIENT_SECRET: '' }, null, 'OAUTH_CLIENT_SECRET', 'MISSING_CONFIG'],
        [env, { error: 'incorrect_client_credentials' }, 'Client ID 或 Client Secret 不正确', 'TOKEN_EXCHANGE_FAILED'],
        [env, { error: 'redirect_uri_mismatch' }, '回调地址不匹配', 'TOKEN_EXCHANGE_FAILED'],
        [env, { error: 'bad_verification_code' }, '授权码已失效或已使用', 'TOKEN_EXCHANGE_FAILED'],
        [env, { error: 'unexpected', error_description: 'private-client-secret' }, '令牌交换失败', 'TOKEN_EXCHANGE_FAILED']
    ];
    for (const [index, [config, body, message, code]] of cases.entries()) {
        reply = body;
        const before = fetchMock.mock.callCount();
        const response = await worker.fetch(new Request(env.OAUTH_REDIRECT_URI, {
            method: 'POST',
            headers: { Cookie: 'oauth_state=test-state', 'CF-Connecting-IP': `192.0.2.${index + 1}` },
            body: JSON.stringify({ code: 'code', state: 'test-state' })
        }), config);
        assert.equal(response.status, 500);
        const data = await response.json();
        assert.equal(data.code, code);
        assert.ok(data.error.includes(message));
        assert.ok(!JSON.stringify(data).includes('private-'));
        assert.equal(fetchMock.mock.callCount() - before, body ? 1 : 0);
    }
    const authorize = await worker.fetch(new Request('https://2fa.example/api/oauth/authorize'), { ...env, JWT_SECRET: '' });
    assert.equal(authorize.status, 500);
    assert.match(await authorize.text(), /JWT_SECRET/);
});
