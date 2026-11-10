const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");

const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
const server = new McpServer({ name: "t", version: "1.0.0" });
await server.connect(transport);

const req = new Request("http://localhost:3000/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
});
try {
  const res = await transport.handleRequest(req);
  console.log("STATUS:", res.status);
  console.log("BODY:", (await res.text()).slice(0, 500));
} catch (e) {
  console.error("THROWN:", e);
}
