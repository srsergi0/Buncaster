import fs from "fs";
import path from "path";
import { McpServer } from "mcp-lite";
import { createInterface } from "readline";

// Load .env explicitly to read configurations (like PORT, ADMIN_USER, ADMIN_PASSWORD)
// in environments that do not load .env automatically.
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (match) {
        const key = match[1]!.trim();
        let val = match[2]!.trim();
        // Remove surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const PORT = process.env.PORT || "4321";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const API_URL = process.env.BUNRADIO_API_URL || `http://localhost:${PORT}`;

/**
 * Helper function to call the BunRadio HTTP REST API.
 */
async function callApi(endpoint: string, method: "GET" | "POST" = "GET", body?: any) {
  const headers: Record<string, string> = {};

  if (ADMIN_USER || ADMIN_PASSWORD) {
    const credentials = btoa(`${ADMIN_USER}:${ADMIN_PASSWORD}`);
    headers["Authorization"] = `Basic ${credentials}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const url = `${API_URL}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API returned status ${response.status}: ${text || response.statusText}`);
  }

  return response.json();
}

// Create the MCP server
const server = new McpServer({
  name: "bunradio-mcp-server",
  version: "1.0.0",
});

// Register MCP tools using the standard McpServer.tool(name, def) signature

// 1. Get Status
server.tool("get_status", {
  description: "Get the current status of the radio station, including broadcasting state, listener counts, and active track details",
  handler: async () => {
    try {
      const status = await callApi("/status");
      let currentTrack = null;
      try {
        const current = await callApi("/admin/api/current");
        currentTrack = current.currentTrack;
      } catch {
        // Ignore auth failures if not configured or endpoints are disabled
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ...status, currentTrack }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error connecting to BunRadio API: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 2. Get Queue
server.tool("get_queue", {
  description: "Retrieve the current playback priority queue",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/queue");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 3. Push to Queue
server.tool("push_to_queue", {
  description: "Add a local audio file path or remote stream URL (e.g. http/rtmp) to the playback queue",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path to the local file or URL to enqueue" }
    },
    required: ["file"]
  },
  handler: async ({ file }: any) => {
    try {
      const res = await callApi("/admin/api/queue/push", "POST", { file });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 4. Remove from Queue
server.tool("remove_from_queue", {
  description: "Remove an item from the priority queue by its 0-based index",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 0, description: "The index of the item to remove" }
    },
    required: ["index"]
  },
  handler: async ({ index }: any) => {
    try {
      const res = await callApi("/admin/api/queue/remove", "POST", { index });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 5. Clear Queue
server.tool("clear_queue", {
  description: "Clear all tracks from the priority queue",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/queue/clear", "POST");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 6. Move in Queue
server.tool("move_in_queue", {
  description: "Move a track in the priority queue from one position to another",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "integer", minimum: 0, description: "Source index of the track" },
      to: { type: "integer", minimum: 0, description: "Destination index of the track" }
    },
    required: ["from", "to"]
  },
  handler: async ({ from, to }: any) => {
    try {
      const res = await callApi("/admin/api/queue/move", "POST", { from, to });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 7. Skip Track
server.tool("skip_track", {
  description: "Skip the current song. Note: Live RTMP streams cannot be skipped, only fallback tracks",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/skip", "POST");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 8. Shuffle Playlist
server.tool("shuffle_playlist", {
  description: "Reshuffle the fallback playlist and restart playback from the first track",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/playlist/shuffle", "POST");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 9. List Files
server.tool("list_files", {
  description: "List the available audio files in the local fallback directory configured on the server",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/files");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 10. Toggle Fallback
server.tool("toggle_fallback", {
  description: "Toggle (pause or resume) fallback music playback when no live stream is active",
  handler: async () => {
    try {
      const res = await callApi("/admin/api/fallback/toggle", "POST");
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

export { server as mcpServer };

// Stdio transport implementation using readline interface, run only if called directly
if (import.meta.main) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      const response = await server._dispatch(request);
      if (response) {
        console.log(JSON.stringify(response));
      }
    } catch (error: any) {
      const errResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error.message}`,
        },
      };
      console.log(JSON.stringify(errResponse));
    }
  });

  console.error("BunRadio MCP Server is running over Stdio.");
}
