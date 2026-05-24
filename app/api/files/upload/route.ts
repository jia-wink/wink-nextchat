import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  buildPublicFileUrl,
  buildStoredFilename,
  ensureUploadDirFor,
  resolveUploadMaxBytes,
} from "../shared";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        code: 1,
        msg: "file is required",
      },
      { status: 400 },
    );
  }

  const maxBytes = resolveUploadMaxBytes();
  if (file.size > maxBytes) {
    return NextResponse.json(
      {
        code: 1,
        msg: `file is too large, max size is ${maxBytes} bytes`,
      },
      { status: 413 },
    );
  }

  const relativePath = buildStoredFilename(
    file.name,
    file.type.split("/").pop() || undefined,
  );
  const absolutePath = await ensureUploadDirFor(relativePath);
  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(absolutePath, bytes);

  return NextResponse.json({
    code: 0,
    data: buildPublicFileUrl(req.url, relativePath),
    file: {
      name: file.name,
      type: file.type,
      size: file.size,
      path: relativePath.replace(/\\/g, "/"),
    },
  });
}
