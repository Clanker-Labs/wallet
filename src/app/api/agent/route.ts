import { z } from "zod";
import { agentStatus, runAgent } from "@/server/agent/runner";
import type { AgentEvent } from "@/server/agent/events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().optional(),
  channel: z.enum(["web", "telegram"]).default("web"),
  stream: z.boolean().optional(),
});

/** Assistant status: which backend is configured and whether it's usable. */
export function GET() {
  return Response.json(agentStatus());
}

/**
 * Chat with the wallet assistant.
 * - JSON:  POST {message, conversationId?} → {conversationId, text}
 * - SSE:   same body with `"stream": true` or `Accept: text/event-stream`
 *          → `data: <AgentEvent JSON>` lines until a `done` or `error` event.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const body = parsed.data;
  const wantsStream = body.stream ?? request.headers.get("accept")?.includes("text/event-stream") ?? false;

  if (!wantsStream) {
    try {
      const res = await runAgent({ ...body, signal: request.signal });
      return Response.json(res);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // client went away
        }
      };
      try {
        await runAgent({ ...body, signal: request.signal, onEvent: send });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
