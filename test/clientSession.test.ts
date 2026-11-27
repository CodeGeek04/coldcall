import { describe, expect, it } from "vitest";
import { loadPlaybook } from "../src/core/playbook";
import { ClientSession, labelFor, listTranscripts, playbookView } from "../src/server/clientSession";
import type { ServerMsg } from "../src/shared/protocol";

function fakeSocket() {
  const sent: ServerMsg[] = [];
  let onMessage: (data: Buffer, isBinary: boolean) => void = () => {};
  const socket = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as ServerMsg),
    on: (event: string, cb: (data: Buffer, isBinary: boolean) => void) => {
      if (event === "message") onMessage = cb;
    },
  };
  return { socket, sent, receive: (msg: unknown) => onMessage(Buffer.from(JSON.stringify(msg)), false) };
}

const playbook = loadPlaybook("playbook.yaml");
const lastError = (sent: ServerMsg[]) => sent.filter((m) => m.type === "error").at(-1);

describe("ClientSession", () => {
  it("greets with the playbook, transcripts and available classifiers", () => {
    const { socket, sent } = fakeSocket();
    new ClientSession(socket, playbook, {});
    const hello = sent[0];
    expect(hello?.type).toBe("hello");
    if (hello?.type !== "hello") return;
    expect(hello.classifiers).toEqual(["mock"]);
    expect(hello.canTranscribe).toBe(false);
    expect(hello.transcripts.map((t) => t.file)).toContain("sample-booked.json");
    expect(hello.playbook.blocks[0]).toMatchObject({ id: "gatekeeper", key: 1 });
  });

  it("refuses transcript paths outside the transcripts folder", async () => {
    const { socket, sent, receive } = fakeSocket();
    new ClientSession(socket, playbook, {});
    receive({ type: "start", transcript: "../package.json", classifier: "mock", speed: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(lastError(sent)).toMatchObject({ message: expect.stringContaining("was not found") });
  });

  it("refuses recorded and live calls without a transcriber key", async () => {
    const { socket, sent, receive } = fakeSocket();
    new ClientSession(socket, playbook, {});
    receive({ type: "listen", classifier: "mock", record: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(lastError(sent)).toMatchObject({ message: expect.stringContaining("DEEPGRAM_API_KEY") });
  });

  it("refuses Jev without a key, overrides before a run, and malformed messages", async () => {
    const { socket, sent, receive } = fakeSocket();
    new ClientSession(socket, playbook, {});
    receive({ type: "start", transcript: "sample-booked.json", classifier: "jev", speed: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(lastError(sent)).toMatchObject({ message: expect.stringContaining("TYPESAFE_API_KEY") });
    receive({ type: "override", block: "pitch" });
    expect(lastError(sent)).toMatchObject({ message: expect.stringContaining("Start a call") });
    receive({ type: "start", transcript: "sample-booked.json", classifier: "mock", speed: 100 });
    expect(lastError(sent)?.type).toBe("error");
  });
});

describe("helpers", () => {
  it("maps the first 9 blocks to number keys", () => {
    expect(playbookView(playbook).blocks.map((b) => b.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("lists valid transcripts with their length", () => {
    const booked = listTranscripts().find((t) => t.file === "sample-booked.json");
    expect(booked).toMatchObject({ id: "sample-booked", segments: 27, seconds: 119 });
  });
});

describe("labelFor", () => {
  const lines = [
    { speaker: "them", start: 0, end: 3, label: { block: "gatekeeper", stance: "neutral" } },
    { speaker: "you", start: 3.5, end: 6, label: { block: "opener", stance: "neutral" } },
    { speaker: "them", start: 6.5, end: 9, label: { block: "reluctant", stance: "hostile" } },
  ];
  it("takes the label of the same speaker's line that overlaps the sentence most", () => {
    const seg = { id: "x", speaker: "them" as const, text: "No.", start: 6.6, end: 7.1 };
    expect(labelFor(seg, lines)).toEqual({ block: "reluctant", stance: "hostile" });
    expect(labelFor({ ...seg, speaker: "you", start: 20, end: 21 }, lines)).toBeUndefined();
  });
});
