import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker from './_worker.js';

function fixture() {
    const data = new Map();
    const env = {
        API_TOKEN: 'test-only-api-token-'.repeat(4),
        JWT_SECRET: 'test-only-jwt-secret',
        ENCRYPTION_KEY: 'test-only-encryption-key',
        USER_DATA: {
            get: async key => data.get(key) ?? null,
            put: async (key, value) => data.set(key, value),
            delete: async key => data.delete(key)
        }
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        userInfo: { id: '123', username: 'test-user' }, exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    const signature = createHmac('sha256', env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    const jwt = `${header}.${payload}.${signature}`;
    const request = (path, method = 'GET', token = env.API_TOKEN, body) => new Request(`https://2fa.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) })
    });
    return { data, env, jwt, request };
}

test('API Token reads encrypted account secrets but cannot mutate accounts or access other APIs', async (t) => {
    const { data, env, jwt, request } = fixture();
    t.mock.method(console, 'log', () => {});
    const account = { service: 'Example', account: 'user@example.com', secret: 'JBSWY3DPEHPK3PXP', period: 30, digits: 6 };
    const created = await worker.fetch(request('/api/accounts', 'POST', jwt, account), env);
    assert.equal(created.status, 200, 'OAuth JWT can still create accounts');
    const id = (await created.json()).account.id;
    assert.ok(data.has('accounts_encrypted'));
    assert.ok(!data.get('accounts_encrypted').includes(account.secret));

    for (const token of [env.API_TOKEN, jwt]) {
        const response = await worker.fetch(request('/api/accounts', 'GET', token), env);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const { accounts } = await response.json();
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].id, id);
        for (const [key, value] of Object.entries(account)) assert.equal(accounts[0][key], value);
    }

    for (const [method, path] of [
        ['POST', '/api/accounts'], ['PUT', `/api/accounts/${id}`], ['DELETE', `/api/accounts/${id}`],
        ['DELETE', '/api/accounts/clear-all'], ['POST', '/api/generate-totp'],
        ['GET', '/api/get-webdav-configs'], ['GET', '/api/export-secure?password=test-password']
    ]) {
        const response = await worker.fetch(request(path, method, env.API_TOKEN, method === 'POST' || method === 'PUT' ? account : undefined), env);
        assert.equal(response.status, 401, `${method} ${path} must require OAuth`);
    }
    const response = await worker.fetch(request('/api/accounts'), env);
    assert.equal((await response.json()).accounts.length, 1, 'denied writes leave stored accounts intact');
});

test('API Token fails closed when absent, incorrect, disabled or rotated', async () => {
    const token = 'test-only-api-token-'.repeat(4);
    let reads = 0;
    const env = {
        API_TOKEN: token, JWT_SECRET: 'test-only-jwt-secret',
        USER_DATA: { get: async key => { if (key !== 'api_key_config') reads++; return null; } }
    };
    for (const [authorization, configuredToken] of [
        [null, token], ['', token], [`Basic ${token}`, token], ['Bearer ', token],
        ['Bearer short', token], [`Bearer ${token.slice(0, -1)}x`, token],
        [`Bearer ${'a'.repeat(513)}`, token], [`Bearer ${token}`, undefined],
        ['Bearer short', 'short'], ['Bearer ' + ' '.repeat(32), ''],
        [`Bearer ${token}`, 'replacement-api-token-'.repeat(4)]
    ]) {
        const response = await worker.fetch(new Request('https://2fa.example/api/accounts', {
            headers: authorization === null ? {} : { Authorization: authorization }
        }), { ...env, API_TOKEN: configuredToken });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
    assert.equal(reads, 0, 'rejected tokens must not read account data');
    const replacement = 'replacement-api-token-'.repeat(4);
    const response = await worker.fetch(new Request('https://2fa.example/api/accounts', {
        headers: { Authorization: `Bearer ${replacement}` }
    }), { ...env, API_TOKEN: replacement });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accounts: [] });
});

test('OAuth manages one-time API Keys, rotation and disable override the environment token', async (t) => {
    const { data, env, jwt, request } = fixture();
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    const manage = (method, token = jwt) => worker.fetch(request('/api/api-key', method, token), env);
    const initial = await manage('GET');
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { enabled: true, source: 'environment', updatedAt: null });
    let previous = env.API_TOKEN;
    for (let i = 0; i < 2; i++) {
        const response = await manage('POST');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const { apiKey, enabled, updatedAt } = await response.json();
        assert.match(apiKey, /^2fa_[a-f0-9]{64}$/);
        assert.equal(enabled, true);
        assert.ok(Number.isFinite(Date.parse(updatedAt)));
        assert.ok(!data.get('api_key_config').includes(apiKey));
        assert.ok(!logs.join('\n').includes(apiKey));
        assert.equal((await worker.fetch(request('/api/accounts', 'GET', apiKey), env)).status, 200);
        assert.equal((await worker.fetch(request('/api/accounts', 'GET', previous), env)).status, 401);
        assert.equal((await worker.fetch(request('/api/accounts', 'POST', apiKey, {}), env)).status, 401);
        const status = await manage('GET');
        assert.deepEqual(await status.json(), { enabled: true, source: 'managed', updatedAt });
        for (const method of ['GET', 'POST', 'DELETE']) {
            assert.equal((await manage(method, apiKey)).status, 401, 'API Key cannot manage itself');
            assert.equal((await manage(method, '')).status, 401, 'management requires OAuth');
        }
        previous = apiKey;
    }
    assert.equal((await manage('PUT')).status, 405);
    const disabled = await manage('DELETE');
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).enabled, false);
    assert.equal(JSON.parse(data.get('api_key_config')).hash, null);
    for (const token of [previous, env.API_TOKEN]) {
        assert.equal((await worker.fetch(request('/api/accounts', 'GET', token), env)).status, 401);
    }
    assert.equal((await worker.fetch(request('/api/accounts', 'GET', jwt), env)).status, 200);
    assert.equal((await (await manage('GET')).json()).enabled, false);
    const restored = (await (await manage('POST')).json()).apiKey;
    assert.equal((await worker.fetch(request('/api/accounts', 'GET', restored), env)).status, 200);
});

test('API Key management fails safely when storage fails', async () => {
    const { env, jwt, request } = fixture();
    const broken = { ...env, USER_DATA: { get: async () => { throw new Error('private storage details'); }, put: async () => { throw new Error('private storage details'); } } };
    for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await worker.fetch(request('/api/api-key', method, jwt), broken);
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const body = await response.json();
        assert.deepEqual(body, { error: 'API Key 配置操作失败，请稍后重试' });
    }
});
