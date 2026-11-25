import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens,
  type StoredOAuthClientInformation,
  type OAuthClientInformationContext,
} from '@modelcontextprotocol/client';

const snapshotSchema = z.object({
  version: z.literal(1),
  clients: z.array(z.tuple([z.string(), z.object({ client_id: z.string() }).passthrough()])),
  tokens: z.array(
    z.tuple([
      z.string(),
      z.object({ access_token: z.string(), token_type: z.string() }).passthrough(),
    ]),
  ),
  latest: z.object({ access_token: z.string(), token_type: z.string() }).passthrough().optional(),
});
export type OAuthSnapshot = {
  version: 1;
  clients: Array<[string, StoredOAuthClientInformation]>;
  tokens: Array<[string, StoredOAuthTokens]>;
  latest?: StoredOAuthTokens;
};

/** Only durable credentials are exported; PKCE, callbacks and discovery stay in memory. */
export class McpOAuthSession implements OAuthClientProvider {
  redirectUrl = '';
  private verifier = '';
  private nonce = randomBytes(32).toString('hex');
  private clients = new Map<string, StoredOAuthClientInformation>();
  private savedTokens = new Map<string, StoredOAuthTokens>();
  private latest?: StoredOAuthTokens;
  private discovery?: OAuthDiscoveryState;
  private redirect?: (url: URL) => Promise<void>;
  private cancelPending?: () => void;
  private cancelled = false;
  cancelLogin() {
    this.cancelled = true;
    this.cancelPending?.();
  }
  constructor(
    private clientId?: string,
    private changed?: (state: OAuthSnapshot) => void,
  ) {}
  snapshot(): OAuthSnapshot {
    return structuredClone({
      version: 1,
      clients: [...this.clients],
      tokens: [...this.savedTokens],
      latest: this.latest,
    });
  }
  restore(value: unknown) {
    const state = snapshotSchema.parse(value) as OAuthSnapshot;
    this.clients = new Map(state.clients);
    this.savedTokens = new Map(state.tokens);
    this.latest = state.latest;
  }
  attachPersistence(changed: (state: OAuthSnapshot) => void) {
    this.changed = changed;
  }
  detachPersistence() {
    this.changed = undefined;
  }
  get clientMetadata() {
    return {
      client_name: 'Bruin',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return this.nonce;
  }
  clientInformation(ctx?: OAuthClientInformationContext) {
    return this.clientId ? { client_id: this.clientId } : this.clients.get(ctx?.issuer ?? '');
  }
  saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
    this.clients.set(ctx?.issuer ?? '', value);
    this.changed?.(this.snapshot());
  }
  tokens(ctx?: OAuthClientInformationContext) {
    return ctx ? this.savedTokens.get(ctx.issuer) : this.latest;
  }
  saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
    this.savedTokens.set(ctx?.issuer ?? '', value);
    this.latest = value;
    this.changed?.(this.snapshot());
  }
  saveCodeVerifier(value: string) {
    this.verifier = value;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('OAuth PKCE 校验信息缺失');
    return this.verifier;
  }
  saveDiscoveryState(value: OAuthDiscoveryState) {
    this.discovery = value;
  }
  discoveryState() {
    return this.discovery;
  }
  private assertSafeEndpoint(url: URL, label = 'OAuth 端点') {
    if (url.username || url.password) throw new Error(`${label}不允许包含内嵌凭据`);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error(`${label}必须使用 HTTPS`);
  }
  async redirectToAuthorization(url: URL) {
    if (!this.redirect) throw new Error('MCP 需要 OAuth 登录，请在 MCP 设置中点击登录');
    this.assertSafeEndpoint(url, 'OAuth 授权地址');
    await this.redirect(url);
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') {
      this.savedTokens.clear();
      this.latest = undefined;
    }
    if (scope === 'all' || scope === 'client') this.clients.clear();
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    this.changed?.(this.snapshot());
  }
  async login(
    serverUrl: string,
    open: (url: string) => Promise<void>,
    port = 0,
    timeoutMs = 120_000,
  ) {
    this.cancelled = false;
    this.nonce = randomBytes(32).toString('hex');
    let resolve!: (params: URLSearchParams) => void;
    let reject!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    void callback.catch(() => {});
    let consumed = false;
    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', this.redirectUrl);
      } catch {
        res.writeHead(400);
        res.end('Invalid OAuth callback');
        return;
      }
      const state = url.searchParams.get('state') ?? '';
      const valid =
        /^[a-f0-9]{64}$/.test(state) &&
        timingSafeEqual(Buffer.from(state), Buffer.from(this.nonce));
      if (consumed || req.method !== 'GET' || url.pathname !== '/callback' || !valid) {
        res.writeHead(400);
        res.end('Invalid OAuth callback');
        return;
      }
      if (url.searchParams.has('error')) {
        consumed = true;
        res.writeHead(400);
        res.end('Authorization denied');
        reject(new Error('OAuth 授权被拒绝'));
        return;
      }
      if (!url.searchParams.get('code')) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }
      consumed = true;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('已收到授权，正在完成登录。可关闭此页面并返回 Bruin。');
      resolve(url.searchParams);
    });
    await new Promise<void>((ok, fail) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        fail(err);
      };
      const onListening = () => {
        server.off('error', onError);
        ok();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    const onRuntimeError = (err: Error) => {
      reject(err);
    };
    server.on('error', onRuntimeError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.cancelled) throw new Error('OAuth 登录已取消');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('OAuth 回调监听失败');
      this.redirectUrl = `http://127.0.0.1:${address.port}/callback`;
      const controller = new AbortController();
      this.cancelPending = () => {
        controller.abort();
        reject(new Error('OAuth 登录已取消'));
      };
      if (this.cancelled) throw new Error('OAuth 登录已取消');
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('OAuth 登录超时'));
      }, timeoutMs);
      timer.unref();
      const fetchFn: typeof fetch = (input, init) => {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        this.assertSafeEndpoint(new URL(rawUrl), 'OAuth 端点');
        const signal = init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;
        return fetch(input, { ...init, redirect: 'error', signal });
      };
      this.redirect = async (url) => open(url.href);
      const response = await fetchFn(serverUrl, { method: 'GET' });
      const challenge = response.status === 401 ? extractWWWAuthenticateParams(response) : {};
      await response.body?.cancel();
      const result = await auth(this, {
        serverUrl,
        fetchFn,
        ...challenge,
        forceReauthorization: true,
      });
      if (result === 'REDIRECT') {
        const params = await callback;
        if (
          (await auth(this, {
            serverUrl,
            authorizationCode: params.get('code')!,
            iss: params.get('iss') ?? undefined,
            fetchFn,
          })) !== 'AUTHORIZED'
        )
          throw new Error('OAuth 登录未完成');
      }
    } catch (error) {
      this.invalidateCredentials('all');
      throw error;
    } finally {
      clearTimeout(timer);
      server.off('error', onRuntimeError);
      this.cancelPending = undefined;
      this.redirect = undefined;
      this.verifier = '';
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }
}
