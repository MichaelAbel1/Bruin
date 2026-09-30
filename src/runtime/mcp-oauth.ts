import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens,
  type StoredOAuthClientInformation,
  type OAuthClientInformationContext,
} from '@modelcontextprotocol/client';

/** Credentials are isolated by server configuration and stay in host memory. */
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
  cancelLogin() {
    this.cancelPending?.();
  }
  constructor(private clientId?: string) {}
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
  }
  tokens(ctx?: OAuthClientInformationContext) {
    return ctx ? this.savedTokens.get(ctx.issuer) : this.latest;
  }
  saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
    this.savedTokens.set(ctx?.issuer ?? '', value);
    this.latest = value;
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
  async redirectToAuthorization(url: URL) {
    if (!this.redirect) throw new Error('MCP 需要 OAuth 登录，请在 MCP 设置中点击登录');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error('OAuth 授权地址必须使用 HTTPS');
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
  }
  async login(
    serverUrl: string,
    open: (url: string) => Promise<void>,
    port = 0,
    timeoutMs = 120_000,
  ) {
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
      server.once('error', fail);
      server.listen(port, '127.0.0.1', ok);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth 回调监听失败');
    this.redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    const controller = new AbortController();
    this.cancelPending = () => {
      controller.abort();
      reject(new Error('OAuth 登录已取消'));
    };
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('OAuth 登录超时'));
    }, timeoutMs);
    const fetchFn: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: controller.signal });
    this.redirect = async (url) => open(url.href);
    try {
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
      this.cancelPending = undefined;
      this.redirect = undefined;
      this.verifier = '';
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }
}
