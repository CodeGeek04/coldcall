import { createReadStream } from "node:fs";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { loadEnv } from "../core/env";
import { loadPlaybook } from "../core/playbook";
import { ClientSession, listAudio } from "./clientSession";

loadEnv();
const PORT = Number(process.env.PORT ?? 8787);

// The server holds the API keys; the browser only ever talks to this process.
const app = Fastify({ logger: { level: "info" } });
await app.register(websocket);

app.get("/api/health", async () => ({ ok: true }));

// Audio for recorded calls, so the browser can play what the transcriber hears. Listed files only.
app.get<{ Params: { file: string } }>("/api/audio/:file", async (req, reply) => {
  const entry = listAudio().find((a) => a.file === req.params.file);
  if (!entry) return reply.code(404).send({ error: "No such recording" });
  return reply.type("audio/wav").send(createReadStream(entry.path));
});

app.get("/ws", { websocket: true }, (socket) => {
  // Re-read the playbook per connection, so a browser reload picks up edits.
  try {
    new ClientSession(socket, loadPlaybook(), {
      typesafeKey: process.env.TYPESAFE_API_KEY,
      jevModel: process.env.JEV_MODEL,
      deepgramKey: process.env.DEEPGRAM_API_KEY,
    });
  } catch (err) {
    socket.send(JSON.stringify({ type: "error", message: String(err) }));
    socket.close();
  }
});

await app.listen({ port: PORT, host: "127.0.0.1" });
