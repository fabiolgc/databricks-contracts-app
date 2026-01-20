import { NextRequest, NextResponse } from "next/server";
import { uploadToVolume } from "@/lib/databricks/client";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large file uploads

/**
 * POST /api/upload
 * Upload PDF files to Databricks Volume
 */
export async function POST(request: NextRequest) {
  console.log("📤 Upload request received");

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const overwriteParam = formData.get("overwrite") as string;
    const overwrite = overwriteParam === "true";

    if (!file) {
      console.error("❌ No file provided in request");
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate file type
    if (file.type !== "application/pdf") {
      console.error(`❌ Invalid file type: ${file.type}`);
      return NextResponse.json(
        { error: "Only PDF files are allowed" },
        { status: 400 }
      );
    }

    // Validate file size (max 100MB)
    const maxSize = 100 * 1024 * 1024; // 100MB
    if (file.size > maxSize) {
      console.error(`❌ File too large: ${file.size} bytes`);
      return NextResponse.json(
        { error: "File size exceeds 100MB limit" },
        { status: 400 }
      );
    }

    console.log(`📄 Processing file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)${overwrite ? " [OVERWRITE]" : ""}`);

    // Convert file to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Upload to Databricks Volume
    const result = await uploadToVolume(buffer, file.name, overwrite);

    if (!result.success) {
      // Special case for file exists
      if (result.error === "FILE_EXISTS") {
        console.log(`⚠️ File already exists: ${file.name}`);
        return NextResponse.json(
          {
            fileExists: true,
            fileName: file.name,
            path: result.path,
          },
          { status: 409 } // Conflict
        );
      }

      console.error(`❌ Upload failed for ${file.name}:`, result.error);
      return NextResponse.json(
        {
          error: result.error || "Upload failed",
          fileName: file.name,
        },
        { status: 500 }
      );
    }

    console.log(`✅ Upload successful: ${result.path}`);

    return NextResponse.json({
      success: true,
      fileName: file.name,
      path: result.path,
      size: file.size,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Upload error:", errorMessage, error);

    return NextResponse.json(
      {
        error: "Internal server error during upload",
        details: errorMessage,
      },
      { status: 500 }
    );
  }
}
