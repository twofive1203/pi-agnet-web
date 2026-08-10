import { NextRequest, NextResponse } from "next/server";
import {
  FileUploadError,
  MAX_UPLOAD_BYTES,
  generateUploadSessionId,
  getUploadRoot,
  lazyCleanupUploads,
  prepareUploadTarget,
  writeUploadFileExclusive,
} from "@/lib/file-upload";

/**
 * POST /api/files/upload
 * Accepts multipart/form-data with a "file" field.
 * Runs lazy cleanup before saving.
 * Returns { name, path, size, storageName } where path is absolute and confined
 * to the controlled upload root (PI_CODING_AGENT_DIR/uploads or ~/.pi/agent/uploads).
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const fileField = formData.get("file");

    if (!fileField || !(fileField instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const file = fileField as File;
    const originalName = typeof file.name === "string" ? file.name : "";

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    const uploadRoot = getUploadRoot();
    lazyCleanupUploads(uploadRoot);

    const prepared = prepareUploadTarget(originalName, {
      uploadRoot,
      uploadId: generateUploadSessionId(),
    });

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    const written = writeUploadFileExclusive(prepared.sessionDir, originalName, buffer);

    return NextResponse.json({
      name: written.displayName,
      storageName: written.storageName,
      path: written.targetPath,
      size: written.size,
    });
  } catch (error) {
    if (error instanceof FileUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("File upload failed:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
