import { listUploads, MAX_UPLOAD_BYTES, saveUpload, uploadKind } from "@/server/services/uploads";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** Upload files for the assistant (multipart field "file", repeatable). */
export async function POST(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES * 3) return Response.json({ error: "Upload too large" }, { status: 413 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return Response.json({ error: "No file" }, { status: 400 });
  try {
    const saved = [];
    for (const f of files.slice(0, 10)) {
      const u = saveUpload(user.id, {
        filename: f.name || "upload",
        mimeType: f.type,
        data: Buffer.from(await f.arrayBuffer()),
      });
      saved.push({ id: u.id, filename: u.filename, size: u.size, kind: uploadKind(u.mimeType, u.filename) });
    }
    return Response.json(saved);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(listUploads(user.id));
}
