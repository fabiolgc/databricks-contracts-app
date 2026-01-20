import { NextRequest, NextResponse } from "next/server";
import { uploadToVolume } from "@/lib/databricks/client";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large file uploads

/**
 * POST /api/upload
 * Upload PDF files to Databricks Volume
 * 
 * Supports OBO (On-Behalf-Of) authentication:
 * - If x-forwarded-access-token header is present, uses user's token (respects UC permissions)
 * - Otherwise, falls back to Service Principal token
 */
export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID().substring(0, 8);
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📤 [${requestId}] Upload request received at ${new Date().toISOString()}`);
  console.log(`${"=".repeat(80)}`);

  try {
    // Log all environment variables (without sensitive data)
    console.log(`🔧 [${requestId}] Environment check:`);
    console.log(`  - DATABRICKS_HOST: ${process.env.DATABRICKS_HOST ? "✅ Set" : "❌ Missing"}`);
    console.log(`  - DATABRICKS_SERVER_HOSTNAME: ${process.env.DATABRICKS_SERVER_HOSTNAME ? "✅ Set" : "❌ Missing"}`);
    console.log(`  - DATABRICKS_CLIENT_SECRET: ${process.env.DATABRICKS_CLIENT_SECRET ? "✅ Set (***)" : "❌ Missing"}`);
    console.log(`  - DATABRICKS_CLIENT_ID: ${process.env.DATABRICKS_CLIENT_ID || "❌ Missing"}`);
    console.log(`  - DATABRICKS_CATALOG: ${process.env.DATABRICKS_CATALOG || "❌ Missing"}`);
    console.log(`  - DATABRICKS_SCHEMA: ${process.env.DATABRICKS_SCHEMA || "❌ Missing"}`);
    console.log(`  - DATABRICKS_VOLUME: ${process.env.DATABRICKS_VOLUME || "❌ Missing"}`);

    // Log all headers (without sensitive data)
    console.log(`\n📋 [${requestId}] Request headers:`);
    const headerEntries: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (key.toLowerCase().includes("token") || key.toLowerCase().includes("auth")) {
        headerEntries[key] = value ? "✅ Present (***)" : "❌ Missing";
      } else {
        headerEntries[key] = value;
      }
    });
    console.log(JSON.stringify(headerEntries, null, 2));

    // Extract user token for OBO authentication (if available)
    const userToken = request.headers.get("x-forwarded-access-token");
    const authMethod = userToken ? "OBO (user token)" : "Service Principal";
    console.log(`\n🔐 [${requestId}] Authentication method: ${authMethod}`);
    if (userToken) {
      console.log(`  - User token length: ${userToken.length} chars`);
      console.log(`  - User token prefix: ${userToken.substring(0, 20)}...`);
    }

    console.log(`\n📦 [${requestId}] Parsing form data...`);
    const formData = await request.formData();
    console.log(`✅ [${requestId}] Form data parsed successfully`);

    const file = formData.get("file") as File;
    const overwriteParam = formData.get("overwrite") as string;
    const overwrite = overwriteParam === "true";

    console.log(`📋 [${requestId}] Form data contents:`);
    console.log(`  - file: ${file ? "✅ Present" : "❌ Missing"}`);
    console.log(`  - overwrite: ${overwrite ? "Yes" : "No"}`);

    if (!file) {
      console.error(`❌ [${requestId}] No file provided in request`);
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate file type
    console.log(`\n🔍 [${requestId}] Validating file...`);
    console.log(`  - Name: ${file.name}`);
    console.log(`  - Type: ${file.type}`);
    console.log(`  - Size: ${file.size} bytes (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    if (file.type !== "application/pdf") {
      console.error(`❌ [${requestId}] Invalid file type: ${file.type}`);
      return NextResponse.json(
        { error: "Only PDF files are allowed" },
        { status: 400 }
      );
    }
    console.log(`✅ [${requestId}] File type is valid (PDF)`);

    // Validate file size (max 100MB)
    const maxSize = 100 * 1024 * 1024; // 100MB
    if (file.size > maxSize) {
      console.error(`❌ [${requestId}] File too large: ${file.size} bytes (max: ${maxSize})`);
      return NextResponse.json(
        { error: "File size exceeds 100MB limit" },
        { status: 400 }
      );
    }
    console.log(`✅ [${requestId}] File size is valid`);

    console.log(`\n📄 [${requestId}] Processing file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)${overwrite ? " [OVERWRITE MODE]" : ""}`);

    // Convert file to buffer
    console.log(`🔄 [${requestId}] Converting file to buffer...`);
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    console.log(`✅ [${requestId}] Buffer created: ${buffer.length} bytes`);

    // Upload to Databricks Volume with OBO support
    console.log(`\n🚀 [${requestId}] Starting upload to Databricks Volume...`);
    console.log(`  - Auth method: ${authMethod}`);
    console.log(`  - Overwrite: ${overwrite}`);
    
    // If userToken is provided, upload respects user's Unity Catalog permissions
    const result = await uploadToVolume(buffer, file.name, overwrite, userToken || undefined);
    
    console.log(`\n📊 [${requestId}] Upload result:`, JSON.stringify({
      success: result.success,
      path: result.path,
      error: result.error || "none"
    }, null, 2));

    if (!result.success) {
      // Special case for file exists
      if (result.error === "FILE_EXISTS") {
        console.log(`\n⚠️ [${requestId}] File already exists: ${file.name}`);
        console.log(`  - Path: ${result.path}`);
        console.log(`  - Returning HTTP 409 (Conflict)`);
        console.log(`${"=".repeat(80)}\n`);
        
        return NextResponse.json(
          {
            fileExists: true,
            fileName: file.name,
            path: result.path,
          },
          { status: 409 } // Conflict
        );
      }

      console.error(`\n❌ [${requestId}] Upload failed for ${file.name}:`);
      console.error(`  - Error: ${result.error}`);
      console.error(`  - Returning HTTP 500`);
      console.log(`${"=".repeat(80)}\n`);
      
      return NextResponse.json(
        {
          error: result.error || "Upload failed",
          fileName: file.name,
        },
        { status: 500 }
      );
    }

    console.log(`\n✅ [${requestId}] Upload successful!`);
    console.log(`  - File: ${file.name}`);
    console.log(`  - Path: ${result.path}`);
    console.log(`  - Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  - Returning HTTP 200`);
    console.log(`${"=".repeat(80)}\n`);

    return NextResponse.json({
      success: true,
      fileName: file.name,
      path: result.path,
      size: file.size,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : "No stack trace";
    
    console.error(`\n💥 [${requestId}] EXCEPTION in upload handler:`);
    console.error(`  - Error: ${errorMessage}`);
    console.error(`  - Type: ${error?.constructor?.name || typeof error}`);
    console.error(`  - Stack trace:\n${errorStack}`);
    console.error(`  - Returning HTTP 500`);
    console.log(`${"=".repeat(80)}\n`);

    return NextResponse.json(
      {
        error: "Internal server error during upload",
        details: errorMessage,
      },
      { status: 500 }
    );
  }
}
