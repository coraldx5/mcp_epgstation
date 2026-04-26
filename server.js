import { createServer } from "node:http";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { registerEpgStationTools, buildReservesTextFromItems, buildReservesWidgetHtml, getReservesWidgetData } from "./epgstation.js";

const RESERVES_WIDGET_URI = "ui://widget/reserves.html";

function createWidgetMeta(description) {
  return {
    "openai/widgetDescription": description,
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": {
      connect_domains: [],
      resource_domains: [],
    },
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: [],
        resourceDomains: [],
      },
    },
  };
}

function createWidgetToolMeta(resourceUri, invoking, invoked) {
  return {
    ui: { resourceUri },
    "openai/outputTemplate": resourceUri,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function createHtmlResource(uri, text, description) {
  return {
    uri,
    mimeType: RESOURCE_MIME_TYPE,
    text,
    _meta: createWidgetMeta(description),
  };
}

// ── MCP server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "epgstation-app",
    version: "0.1.0",
  });
  registerEpgStationTools(server);

  registerAppResource(
    server,
    "epg-reserves-widget",
    RESERVES_WIDGET_URI,
    {},
    async () => ({
      contents: [
        createHtmlResource(
          RESERVES_WIDGET_URI,
          await buildReservesWidgetHtml(),
          "録画予約一覧をロゴ・時間・番組名で表示するウィジェットです。"
        )
      ]
    })
  );

  registerAppTool(
    server,
    "epg_get_reserves_w_logo",
    {
      title: "録画予約一覧（ロゴ付き）",
      description: "録画予約の一覧をロゴ・時間・番組名を含む表形式のウィジェットで表示します。指定期間が過去のみの場合は録画済み一覧を表示します。",
      inputSchema: {
        type: z.enum(["all", "normal", "conflict", "skip", "overlap"]).default("all").describe("取得する予約の種類"),
        limit: z.number().int().min(1).max(200).default(200).describe("最大取得件数"),
        startDate: z.string().optional().describe("開始日 (YYYY-MM-DD)。この日以降の予約のみ表示"),
        endDate: z.string().optional().describe("終了日 (YYYY-MM-DD)。この日までの予約のみ表示"),
      },
      _meta: createWidgetToolMeta(
        RESERVES_WIDGET_URI,
        "録画予約を取得しています…",
        "録画予約一覧を表示しました"
      )
    },
    async ({ type, limit, startDate, endDate }) => {
      const widgetData = await getReservesWidgetData(type, limit, startDate, endDate);
      const text = buildReservesTextFromItems(
        widgetData.items,
        widgetData.startDate,
        widgetData.endDate,
        widgetData.title,
        widgetData.emptyMessage
      );
      return {
        content: [{ type: "text", text }],
        structuredContent: widgetData,
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (req.url === "/mcp") {
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

    let parsedBody = undefined;
    if (rawBody.length > 0) {
      try { parsedBody = JSON.parse(rawBody.toString()); } catch { /* non-JSON body */ }
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

const port = Number(process.env.PORT ?? 3001);

async function startListen() {
  for (let i = 10; i >= 0; i--) {
    const ok = await new Promise((resolve) => {
      function onError(err) {
        httpServer.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          httpServer.close(() => resolve(false));
        } else {
          console.error("[server] Fatal:", err);
          process.exit(1);
        }
      }
      function onListening() {
        httpServer.removeListener("error", onError);
        resolve(true);
      }
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port);
    });
    if (ok) {
      console.log(`MCP server listening on http://localhost:${port}/mcp`);
      return;
    }
    if (i === 0) { console.error(`[server] Port ${port} still busy after retries. Exiting.`); process.exit(1); }
    console.warn(`[server] Port ${port} busy, retrying in 500ms… (${i} left)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
startListen();

// アクティブな接続を追跡して shutdown 時に強制 destroy する
const activeConnections = new Set();
httpServer.on("connection", (socket) => {
  activeConnections.add(socket);
  socket.on("close", () => activeConnections.delete(socket));
});

// --watch モードでファイル変更時に送られる SIGTERM/SIGINT を受けてから
// ポートを解放してプロセスを終了する（EADDRINUSE を防ぐ）
function shutdown(signal) {
  console.log(`[server] ${signal} received, closing HTTP server…`);
  // SSE 等の長生き接続を強制切断
  for (const socket of activeConnections) socket.destroy();
  activeConnections.clear();
  httpServer.close(() => {
    console.log("[server] HTTP server closed.");
    process.exit(0);
  });
  // 2秒以内に閉じなければ強制終了
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));