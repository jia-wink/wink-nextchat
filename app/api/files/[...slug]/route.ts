import path from "node:path";
import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  getContentTypeFromFilename,
  resolveUploadDir,
  sanitizeSlug,
} from "../shared";

export const runtime = "nodejs";

function resolveAbsolutePath(slug: string[]): string | null {
  const safeSlug = sanitizeSlug(slug);
  if (safeSlug.length === 0) {
    return null;
  }
  return path.join(resolveUploadDir(), ...safeSlug);
}

export async function GET(
  _req: NextRequest,
  context: { params: { slug: string[] } },
) {
  const absolutePath = resolveAbsolutePath(context.params.slug);
  if (!absolutePath) {
    return new NextResponse("Not Found", { status: 404 });
  }
  try {
    const file = await fs.readFile(absolutePath);
    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": getContentTypeFromFilename(absolutePath),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: { slug: string[] } },
) {
  const absolutePath = resolveAbsolutePath(context.params.slug);
  if (!absolutePath) {
    return NextResponse.json({ code: 1, msg: "not found" }, { status: 404 });
  }
  try {
    await fs.unlink(absolutePath);
  } catch {
    return NextResponse.json({ code: 1, msg: "not found" }, { status: 404 });
  }
  return NextResponse.json({ code: 0 });
}
