/**
 * Databricks client utilities
 * Supports both Service Principal and OBO (On-Behalf-Of) authentication
 * 
 * OBO (recommended): Uses user's token to respect Unity Catalog permissions
 * Service Principal: Uses app's token when user token is not available
 */

export function getDatabricksConfig(userToken?: string) {
  // Databricks Apps automatically injects these environment variables
  const config = {
    host: process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST,
    // Priority: User token (OBO) > Service Principal > Local dev token
    token: userToken || process.env.DATABRICKS_CLIENT_SECRET || process.env.DATABRICKS_TOKEN,
    catalog: process.env.DATABRICKS_CATALOG || "fabio_goncalves",
    schema: process.env.DATABRICKS_SCHEMA || "customer_cielo",
    volume: process.env.DATABRICKS_VOLUME || "pdf",
    // Track which auth method is being used for logging
    authMethod: userToken ? "OBO" : "Service Principal",
  };

  if (!config.host) {
    throw new Error("DATABRICKS_SERVER_HOSTNAME or DATABRICKS_HOST is not configured");
  }

  if (!config.token) {
    throw new Error("Authentication token not available (DATABRICKS_CLIENT_SECRET, DATABRICKS_TOKEN, or user token required)");
  }

  return config;
}

export function getVolumeBasePath() {
  const { catalog, schema, volume } = getDatabricksConfig();
  return `/Volumes/${catalog}/${schema}/${volume}`;
}

/**
 * Check if file exists in Databricks Volume
 * @param fileName - Name of the file to check
 * @param userToken - Optional user token for OBO authentication
 */
export async function checkFileExists(
  fileName: string,
  userToken?: string
): Promise<{ exists: boolean; error?: string }> {
  const checkId = crypto.randomUUID().substring(0, 8);
  
  try {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🔍 [CHECK-${checkId}] Checking file existence`);
    console.log(`${"─".repeat(60)}`);
    
    const config = getDatabricksConfig(userToken);
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

    console.log(`📋 [CHECK-${checkId}] Configuration:`);
    console.log(`  - Auth method: ${config.authMethod}`);
    console.log(`  - Host: ${config.host}`);
    console.log(`  - Catalog: ${config.catalog}`);
    console.log(`  - Schema: ${config.schema}`);
    console.log(`  - Volume: ${config.volume}`);
    console.log(`  - File path: ${filePath}`);

    // Using Databricks Workspace Files API to get file metadata
    const url = `https://${config.host}/api/2.0/fs/files${filePath}`;
    console.log(`\n🌐 [CHECK-${checkId}] Making HTTP HEAD request:`);
    console.log(`  - URL: ${url}`);
    console.log(`  - Method: HEAD`);
    console.log(`  - Authorization: Bearer ${config.token?.substring(0, 20) || "missing"}...`);

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    });
    const duration = Date.now() - startTime;

    console.log(`\n📡 [CHECK-${checkId}] HTTP Response received (${duration}ms):`);
    console.log(`  - Status: ${response.status} ${response.statusText}`);
    console.log(`  - Headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

    // If HEAD request succeeds, file exists
    if (response.ok) {
      console.log(`✅ [CHECK-${checkId}] File EXISTS: ${filePath}`);
      console.log(`${"─".repeat(60)}\n`);
      return { exists: true };
    }

    // 404 means file doesn't exist
    if (response.status === 404) {
      console.log(`✓ [CHECK-${checkId}] File DOES NOT exist: ${filePath}`);
      console.log(`${"─".repeat(60)}\n`);
      return { exists: false };
    }

    // Other errors
    const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
    console.error(`❌ [CHECK-${checkId}] Error: ${errorMsg}`);
    console.log(`${"─".repeat(60)}\n`);
    throw new Error(`Error checking file: ${errorMsg}`);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : "No stack trace";
    
    console.error(`\n💥 [CHECK-${checkId}] EXCEPTION:`);
    console.error(`  - Error: ${errorMessage}`);
    console.error(`  - Type: ${error?.constructor?.name || typeof error}`);
    console.error(`  - Stack:\n${errorStack}`);
    console.log(`${"─".repeat(60)}\n`);

    return {
      exists: false,
      error: errorMessage,
    };
  }
}

/**
 * Upload file to Databricks Volume using Workspace Files API
 * @param file - File buffer to upload
 * @param fileName - Name of the file
 * @param overwrite - Whether to overwrite existing file
 * @param userToken - Optional user token for OBO authentication
 */
export async function uploadToVolume(
  file: Buffer,
  fileName: string,
  overwrite: boolean = false,
  userToken?: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const uploadId = crypto.randomUUID().substring(0, 8);
  
  try {
    console.log(`\n${"═".repeat(80)}`);
    console.log(`📤 [UPLOAD-${uploadId}] Starting upload process`);
    console.log(`${"═".repeat(80)}`);
    
    const config = getDatabricksConfig(userToken);
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

    console.log(`📋 [UPLOAD-${uploadId}] Upload configuration:`);
    console.log(`  - File name: ${fileName}`);
    console.log(`  - File size: ${file.length} bytes (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  - Auth method: ${config.authMethod}`);
    console.log(`  - Overwrite mode: ${overwrite ? "YES" : "NO"}`);
    console.log(`  - Host: ${config.host}`);
    console.log(`  - Volume path: ${volumePath}`);
    console.log(`  - Full file path: ${filePath}`);

    // Check if file exists and overwrite is not enabled
    if (!overwrite) {
      console.log(`\n🔍 [UPLOAD-${uploadId}] Overwrite disabled - checking if file exists...`);
      const fileCheck = await checkFileExists(fileName, userToken);
      
      if (fileCheck.error) {
        console.log(`⚠️ [UPLOAD-${uploadId}] Error checking file existence, continuing anyway: ${fileCheck.error}`);
      }
      
      if (fileCheck.exists) {
        console.log(`⚠️ [UPLOAD-${uploadId}] File already exists: ${filePath}`);
        console.log(`  - Returning FILE_EXISTS error`);
        console.log(`${"═".repeat(80)}\n`);
        
        return {
          success: false,
          path: filePath,
          error: "FILE_EXISTS",
        };
      }
      console.log(`✓ [UPLOAD-${uploadId}] File does not exist, proceeding with upload`);
    } else {
      console.log(`\n⚠️ [UPLOAD-${uploadId}] Overwrite mode ENABLED - skipping existence check`);
    }

    // Using Databricks Workspace Files API
    const url = `https://${config.host}/api/2.0/fs/files${filePath}`;
    
    console.log(`\n🌐 [UPLOAD-${uploadId}] Making HTTP PUT request:`);
    console.log(`  - URL: ${url}`);
    console.log(`  - Method: PUT`);
    console.log(`  - Content-Type: application/octet-stream`);
    console.log(`  - Authorization: Bearer ${config.token?.substring(0, 20) || "missing"}...`);
    console.log(`  - Body size: ${file.length} bytes`);

    const startTime = Date.now();
    
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: file as unknown as BodyInit,
    });
    
    const duration = Date.now() - startTime;

    console.log(`\n📡 [UPLOAD-${uploadId}] HTTP Response received (${duration}ms):`);
    console.log(`  - Status: ${response.status} ${response.statusText}`);
    console.log(`  - Headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

    if (!response.ok) {
      const errorText = await response.text();
      
      console.error(`\n❌ [UPLOAD-${uploadId}] Upload failed!`);
      console.error(`  - HTTP Status: ${response.status} ${response.statusText}`);
      console.error(`  - Response body: ${errorText}`);
      
      // Better error messages for common issues
      let errorMessage: string;
      
      if (response.status === 403) {
        errorMessage = `Permission denied. User does not have WRITE_VOLUME permission on ${volumePath}`;
        console.error(`  - Issue: PERMISSION DENIED`);
        console.error(`  - Likely cause: Service Principal or User lacks WRITE_VOLUME grant`);
        console.error(`  - Solution: Run SQL: GRANT WRITE VOLUME ON VOLUME ${config.catalog}.${config.schema}.${config.volume} TO principal`);
      } else if (response.status === 404) {
        errorMessage = `Volume not found: ${volumePath}`;
        console.error(`  - Issue: VOLUME NOT FOUND`);
        console.error(`  - Likely cause: Volume path is incorrect or Volume doesn't exist`);
        console.error(`  - Solution: Verify Volume exists: SHOW VOLUMES IN ${config.catalog}.${config.schema}`);
      } else if (response.status === 401) {
        errorMessage = `Authentication failed. Token may be invalid or expired`;
        console.error(`  - Issue: AUTHENTICATION FAILED`);
        console.error(`  - Likely cause: Token is invalid, expired, or missing`);
        console.error(`  - Solution: Check DATABRICKS_CLIENT_SECRET or x-forwarded-access-token`);
      } else {
        errorMessage = `Upload failed: ${response.statusText}`;
        console.error(`  - Issue: UNKNOWN ERROR`);
        console.error(`  - Full response: ${errorText}`);
      }
      
      console.log(`${"═".repeat(80)}\n`);
      throw new Error(errorMessage);
    }

    const responseBody = await response.text();
    
    console.log(`\n✅ [UPLOAD-${uploadId}] Upload SUCCESSFUL!`);
    console.log(`  - File: ${fileName}`);
    console.log(`  - Path: ${filePath}`);
    console.log(`  - Size: ${(file.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  - Duration: ${duration}ms`);
    console.log(`  - Auth: ${config.authMethod}`);
    if (responseBody) {
      console.log(`  - Response: ${responseBody}`);
    }
    console.log(`${"═".repeat(80)}\n`);

    return {
      success: true,
      path: filePath,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : "No stack trace";
    
    console.error(`\n💥 [UPLOAD-${uploadId}] EXCEPTION during upload:`);
    console.error(`  - Error: ${errorMessage}`);
    console.error(`  - Type: ${error?.constructor?.name || typeof error}`);
    console.error(`  - Stack:\n${errorStack}`);
    console.log(`${"═".repeat(80)}\n`);

    return {
      success: false,
      path: "",
      error: errorMessage,
    };
  }
}
