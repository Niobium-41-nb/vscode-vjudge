import * as https from 'https';
import { URL } from 'url';

// VJudge 会主动关闭空闲连接，复用 keep-alive 套接字时容易触发 ECONNRESET。
const agent = new https.Agent({ keepAlive: false });

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  setCookies: string[];
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export function rawRequest(url: string, options: RawRequestOptions): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`无效的 URL：${url}`));
      return;
    }

    if (target.protocol !== 'https:') {
      reject(new Error(`不支持的协议：${target.protocol}`));
      return;
    }

    const body = options.body;
    const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers,
        agent,
        timeout: options.timeoutMs ?? 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const rawSetCookie = res.headers['set-cookie'];
          let setCookies: string[] = [];
          if (Array.isArray(rawSetCookie)) {
            setCookies = rawSetCookie;
          } else if (typeof rawSetCookie === 'string') {
            setCookies = [rawSetCookie];
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
            setCookies,
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('网络请求超时。'));
    });
    req.on('error', (error) => {
      reject(error);
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
