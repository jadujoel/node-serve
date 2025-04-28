import * as Node from "./dist/index.js"
import * as fs from "node:fs"

const server = Node.serve({
  async fetch(request, server) {
    console.log(`${request.method}: ${request.url}`)
    console.log(`client:`, server.requestIP(request))
    const url = new URL(request.url)
    let pathname = `public${url.pathname}`
    if (pathname === "public/") {
      pathname = "public/index.html"
    }
    const contents = await fs.promises.readFile(pathname, { encoding: "utf-8" });
    return new Response(contents, {
      headers: {
        "Content-Type": "text/html"
      }
    })
  }
})
console.log(server.url.origin)
