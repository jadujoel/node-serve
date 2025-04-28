import * as http from "node:http";
import * as stream from "node:stream";
import * as fs from "node:fs"

type Fetcher = (request: Request, server: Server) => Response | Promise<Response>

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
  readonly url: URL

}

function onrequestClosure(fetcher: Fetcher, server: Server) {
  const httpOnRequest: http.RequestListener<typeof http.IncomingMessage, typeof http.ServerResponse> = (req, res) => {
    const request = intoRequest(req);
    const stream = async () => {
      try {
        const response = await fetcher(request, server)
        return streamResponse(res, response);
      } catch {
        res.writeHead(500);
        res.end();
      }
    }
    stream().catch()
  };
  return httpOnRequest
}


const defaultFetcher = (request: Request) => {
  return new Response("404")
}

export function serve(options?: ServeOptions): Server {
  const port = options?.port ?? 3000
  const hostname = options?.hostname ?? "127.0.0.1"
  const development = options?.development ?? true
  const url = new URL(`http://${hostname}:${port}`)
  const fetcher: Fetcher = options?.fetch ?? defaultFetcher

  const server: Server = {
    port,
    development,
    hostname,
    url,
    fetch: fetcher,
  }

  const onrequest = onrequestClosure(fetcher, server)
  const httpServer = http.createServer(onrequest);

  httpServer.on('request', onrequest)
  httpServer.on("error", console.log);

  httpServer.listen(port, () => {
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

function intoRequest(message: http.IncomingMessage) {
  /** @ts-expect-error */
  return new Request(`http://${message.headers.host}${message.url}`, {
      method: message.method,
      headers: message.headers,
  });
}

async function streamResponse(res: http.ServerResponse, response: Response) {
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

if (import.meta.main) {
  // const s = Bun.serve({
  //   fetch(request, server) {
  //     return new Response("404")
  //   },
  // })
  const s = serve({
    fetch(req, server) {
      console.log(`${req.method}: ${req.url}`, server.hostname)
      const url = new URL(req.url)
      let pathname = `public${url.pathname}`
      if (pathname === "public/") {
        pathname = "public/index.html"
      }
      const contents = fs.readFileSync(pathname)
      return new Response(contents)
    }
  })
  console.log(s.url.origin)
}
