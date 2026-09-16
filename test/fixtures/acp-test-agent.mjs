import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const sessions = new Set();
let cancelled = false;

function kimiFixtureDir(sessionId) {
  const home = process.env.KIMI_CODE_HOME;
  if (!home) return undefined;
  const sessionDir = join(home, "sessions", "fixture-workspace", sessionId);
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  appendFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId, sessionDir })}\n`);
  return sessionDir;
}

const app = agent({ name: "fixture-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {} },
    },
    agentInfo: { name: "fixture-agent", title: "Fixture Agent", version: "1.0.0" },
    authMethods: process.env.ACP_FAIL_SESSION_NEW === "1"
      ? [{ id: "fixture-login", name: "Fixture Login" }]
      : [],
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (process.env.ACP_FAIL_SESSION_NEW === "1") throw RequestError.authRequired();
    const sessionId = `fixture-${sessions.size + 1}`;
    sessions.add(sessionId);
    if (process.env.ACP_EMPTY_KIMI_FAILURE === "1") kimiFixtureDir(sessionId);
    process.stderr.write(`cwd=${params.cwd}\n`);
    return { sessionId };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.load, ({ params }) => {
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    cancelled = false;
    const text = params.prompt.find(block => block.type === "text")?.text ?? "";
    if (text === "refuse") return { stopReason: "refusal" };
    if (text === "auth-error") throw RequestError.authRequired();
    if (text === "empty-meta") {
      return {
        stopReason: "end_turn",
        _meta: {
          jetbrains: {
            air: {
              sessionFailure: {
                title: "Provider unavailable",
                details: "The configured gateway returned HTTP 503.",
              },
            },
          },
        },
      };
    }
    if (text === "empty-stderr") {
      process.stderr.write("Error: provider request failed with HTTP 503\n");
      return { stopReason: "end_turn" };
    }
    if (text === "empty-kimi-failure") {
      const sessionDir = kimiFixtureDir(params.sessionId);
      if (sessionDir) {
        writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), `${JSON.stringify({
          type: "turn.ended",
          reason: "failed",
          error: {
            name: "OAuthUnauthorizedError",
            message: 'Token for "kimi-code" has no refresh_token; re-login required.',
          },
        })}\n`);
      }
      return { stopReason: "end_turn" };
    }
    if (text.startsWith("env:")) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-env",
          content: { type: "text", text: process.env[text.slice(4)] ?? "" },
        },
      });
      return { stopReason: "end_turn" };
    }

    const permission = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Fixture write",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "allow", name: "Allow", kind: "allow_always" },
      ],
    });
    if (permission.outcome.outcome !== "selected" || permission.outcome.optionId !== "allow") {
      throw new Error("fixture permission was not allowed");
    }

    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Fixture write",
        kind: "edit",
        status: "in_progress",
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.01, currency: "USD" },
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: text === "large" ? "x".repeat(300_000) : "fixture:" },
      },
    });
    if (text === "ignore-cancel") {
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    if (text === "wait") {
      for (let i = 0; i < 250 && !cancelled; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (cancelled) return { stopReason: "cancelled" };
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, () => {
    cancelled = true;
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const connection = app.connect(ndJsonStream(output, input));
await connection.closed;
