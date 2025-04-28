import * as http from "node:http";
import type { Socket } from 'node:net';
import * as stream from "node:stream";

type Fetcher = (request: Request, server: Server) => Response | Promise<Response>
type HeadersInit = string[][] | Record<string, string | ReadonlyArray<string>> | Headers;

/**
 * A status that represents the outcome of a sent message.
 *
 * - if **0**, the message was **dropped**.
 * - if **-1**, there is **backpressure** of messages.
 * - if **>0**, it represents the **number of bytes sent**.
 *
 * @example
 * ```js
 * const status = ws.send("Hello!");
 * if (status === 0) {
 *   console.log("Message was dropped");
 * } else if (status === -1) {
 *   console.log("Backpressure was applied");
 * } else {
 *   console.log(`Success! Sent ${status} bytes`);
 * }
 * ```
 */
type ServerWebSocketSendStatus = number;

interface ServeOptions {
  /**
   * The hostname the server is listening on. Does not include the port.
   * This will be undefined when the server is listening on a unix socket.
   * @example
   * "localhost"
   *
   * @default
   * "127.0.0.1"
   */
  readonly hostname?: string
  /**
   * The port the server is listening on.
   *
   * This will be undefined when the server is listening on a unix socket.
   * @example
   * 3000
   * @default
   * 3000
   */
  readonly port?: number
  /**
   * Mock the fetch handler for a running server.
   */
  readonly fetch?: Fetcher
  /**
   * Is the server running in development mode?
   * In development mode, Bun.serve() returns rendered error messages with stack traces instead of a generic 500 error.
   * This makes debugging easier, but development mode shouldn't be used in production or you will risk leaking sensitive information.
   */
  readonly development?: boolean
}

interface Server extends Required<ServeOptions> {
  /**
   * Upgrade a {@link Request} to a {@link ServerWebSocket}
   *
   * @param request The {@link Request} to upgrade
   * @param options Pass headers or attach data to the {@link ServerWebSocket}
   *
   * @returns `true` if the upgrade was successful and `false` if it failed
   *
   * @example
   * ```js
   * import { serve } from "bun";
   *  serve({
   *    websocket: {
   *      open: (ws) => {
   *        console.log("Client connected");
   *      },
   *      message: (ws, message) => {
   *        console.log("Client sent message", message);
   *      },
   *      close: (ws) => {
   *        console.log("Client disconnected");
   *      },
   *    },
   *    fetch(req, server) {
   *      const url = new URL(req.url);
   *      if (url.pathname === "/chat") {
   *        const upgraded = server.upgrade(req);
   *        if (!upgraded) {
   *          return new Response("Upgrade failed", { status: 400 });
   *        }
   *      }
   *      return new Response("Hello World");
   *    },
   *  });
   * ```
   *  What you pass to `data` is available on the {@link ServerWebSocket.data} property
   */
  // eslint-disable-next-line @definitelytyped/no-unnecessary-generics
  upgrade<T = undefined>(
    request: Request,
    options?: {
      /**
       * Send any additional headers while upgrading, like cookies
       */
      headers?: HeadersInit;
      /**
       * This value is passed to the {@link ServerWebSocket.data} property
       */
      data?: T;
    },
  ): boolean;

  /**
   * Send a message to all connected {@link ServerWebSocket} subscribed to a topic
   *
   * @param topic The topic to publish to
   * @param data The data to send
   * @param compress Should the data be compressed? Ignored if the client does not support compression.
   *
   * @returns 0 if the message was dropped, -1 if backpressure was applied, or the number of bytes sent.
   *
   * @example
   *
   * ```js
   * server.publish("chat", "Hello World");
   * ```
   *
   * @example
   * ```js
   * server.publish("chat", new Uint8Array([1, 2, 3, 4]));
   * ```
   *
   * @example
   * ```js
   * server.publish("chat", new ArrayBuffer(4), true);
   * ```
   *
   * @example
   * ```js
   * server.publish("chat", new DataView(new ArrayBuffer(4)));
   * ```
   */
  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
    compress?: boolean,
  ): ServerWebSocketSendStatus;

  /**
   * A count of connections subscribed to a given topic
   *
   * This operation will loop through each topic internally to get the count.
   *
   * @param topic the websocket topic to check how many subscribers are connected to
   * @returns the number of subscribers
   */
  subscriberCount(topic: string): number;

  /**
   * Returns the client IP address and port of the given Request. If the request was closed or is a unix socket, returns null.
   *
   * @example
   * ```js
   * export default {
   *  async fetch(request, server) {
   *    return new Response(server.requestIP(request));
   *  }
   * }
   * ```
   */
  requestIP(request: Request): NodeSocketAddress | null;

  /**
   * Reset the idleTimeout of the given Request to the number in seconds. 0 means no timeout.
   *
   * @example
   * ```js
   * export default {
   *  async fetch(request, server) {
   *    server.timeout(request, 60);
   *    await Node.sleep(30000);
   *    return new Response("30 seconds have passed");
   *  }
   * }
   * ```
   */
  timeout(request: Request, seconds: number): void;
  /**
   * Undo a call to {@link Server.unref}
   *
   * If the Server has already been stopped, this does nothing.
   *
   * If {@link Server.ref} is called multiple times, this does nothing. Think of it as a boolean toggle.
   */
  ref(): void;

  /**
   * Don't keep the process alive if this server is the only thing left.
   * Active connections may continue to keep the process alive.
   *
   * By default, the server is ref'd.
   *
   * To prevent new connections from being accepted, use {@link Server.stop}
   */
  unref(): void;

  readonly url: URL
  /**
   * How many requests are in-flight right now?
   */
  get pendingRequests(): number;

  /**
   * How many {@link ServerWebSocket}s are in-flight right now?
   */
  pendingWebSockets: number;

  /**
   * An identifier of the server instance
   *
   * When bun is started with the `--hot` flag, this ID is used to hot reload the server without interrupting pending requests or websockets.
   *
   * When bun is not started with the `--hot` flag, this ID is currently unused.
   */
  id: string
}

async function httpOnRequestAsync (server: NodeServer, req: http.IncomingMessage, res: http.ServerResponse) {
  const request = intoRequest(req);
  server.state.pendingRequests++
  try {
    const response = await server.fetch(request, server)
    streamResponse(res, response);
  } catch {
    try {
      res.writeHead(500);
      res.end();
    } catch {}
  }
  server.state.pendingRequests--
}

function onrequestClosure(server: NodeServer) {
  const httpOnRequestSync: http.RequestListener<typeof http.IncomingMessage, typeof http.ServerResponse> = (req, res) => {
    httpOnRequestAsync(server, req, res).catch()
  };
  return httpOnRequestSync
}

const defaultFetcher = (request: Request) => {
  return new Response("404")
}

class NodeServer implements Server {
  constructor(
    public readonly development: boolean,
    public readonly port: number,
    public readonly hostname: string,
    public readonly id: string,
    public readonly url: URL,
    public readonly fetch: Fetcher
  ) {
  }

  static fromOptions(options: ServeOptions) {
    const port = options?.port ?? 3000
    const hostname = options?.hostname ?? "127.0.0.1"
    const development = options?.development ?? true
    const url = new URL(`http://${hostname}:${port}`)
    const fetcher = options?.fetch ?? defaultFetcher
    const id = "unknown"
    return new NodeServer(
      development,
      port,
      hostname,
      id,
      url,
      fetcher
    )
  }

  /**
   * Private, don't use if you want correctness guaranteed.
   */
  readonly state = {
    pendingRequests: 0,
    subscriberCount: new Map<string, number>()
  }

  get pendingRequests(): number {
    return this.state.pendingRequests
  }

  get pendingWebSockets(): number {
    return 0
  }

  subscriberCount(topic: string): number {
    return this.state.subscriberCount.get(topic) ?? 0
  }

  publish(topic: string, data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer, compress?: boolean): ServerWebSocketSendStatus {
    return 0
  }

  ref(): void {
    console.log("ref")
  }

  unref(): void {
    console.log("unref")
  }

  requestIP(request: Request): NodeSocketAddress | null {
    /** @ts-expect-error */
    const addr: NodeSocketAddress = request?._addr
    return addr ?? null
  }

  timeout(request: Request, seconds: number): void {

  }

  upgrade<T = undefined>(request: Request, options?: { headers?: HeadersInit; data?: T; }): boolean {
    return false
  }
}

function listen(server: NodeServer) {
  const onrequest = onrequestClosure(server)
  const httpServer = http.createServer(onrequest);
  httpServer.on('request', onrequest)
  httpServer.on("error", console.log);
  httpServer.listen(server.port, () => {
    process.on("SIGINT", () => {
      process.stdout.write("[server] Gracefully shutting down...\r\n");
      const timeout = setTimeout(() => {
        process.exit(0);
      }, 300);
      httpServer.close(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
    });
  });
  return server
}

export function serve(options?: ServeOptions): Server {
  const server = NodeServer.fromOptions(options ?? {});
  listen(server)
  return server
}

const HTDefault = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "X-Requested-With,content-type",
};

const HT = {
    default: new Headers(HTDefault),
    json: new Headers({
        ...HTDefault,
        "Content-Type": "application/json",
    }),
    javascript: new Headers({
        ...HTDefault,
        "Content-Type": "application/javascript",
    }),
    webm: new Headers({
        ...HTDefault,
        "Content-Type": "audio/webm",
    }),
    mp4: new Headers({
        ...HTDefault,
        "Content-Type": "audio/mp4",
    }),
    wav: new Headers({
        ...HTDefault,
        "Content-Type": "audio/wav",
    }),
    flac: new Headers({
        ...HTDefault,
        "Content-Type": "audio/flac",
    }),
};

interface SocketAddress {
  /**
   * The IP address of the client.
   */
  readonly address: string,
  /**
   * The IP family ("IPv4" or "IPv6").
   */
  readonly family: "IPv6" | "IPv4",
  /**
   * The port of the client.
   */
  readonly port: number
}

class NodeSocketAddress implements SocketAddress {
  constructor(
    public readonly address: string,
    public readonly family: "IPv6" | "IPv4",
    public readonly port: number
  ) {}
  static fromSocket(socket: Socket) {
    return new NodeSocketAddress(
      socket.remoteAddress ?? "",
      socket.remoteFamily === "IPv6" ? "IPv6" : "IPv4",
      socket.remotePort ?? -1
    )
  }
}

function intoRequest(message: http.IncomingMessage): Request {
  /** @ts-expect-error */
  const req = new Request(`http://${message.headers.host}${message.url}`, {
      method: message.method,
      headers: message.headers,
  });
  const addr: NodeSocketAddress = NodeSocketAddress.fromSocket(message.socket)
  /** @ts-expect-error */
  req._addr = addr;
  return req
}

export async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function streamResponse(res: http.ServerResponse, response: Response): void {
    for (const [key, value] of response.headers) {
        res.setHeader(key, value);
    }
    res.writeHead(response.status);
    if (response.body) {
      stream.Readable.fromWeb(response.body).pipe(res)
    } else {
      res.end();
    }
}

export default serve;
