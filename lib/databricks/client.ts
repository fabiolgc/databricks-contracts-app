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
  try {
    const config = getDatabricksConfig(userToken);
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

    console.log(`🔍 Checking file existence (${config.authMethod}): ${filePath}`);

    // Using Databricks Workspace Files API to get file metadata
    const url = `https://${config.host}/api/2.0/fs/files${filePath}`;

    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    });

    // If HEAD request succeeds, file exists
    if (response.ok) {
      console.log(`📄 File exists: ${filePath}`);
      return { exists: true };
    }

    // 404 means file doesn't exist
    if (response.status === 404) {
      console.log(`✓ File does not exist: ${filePath}`);
      return { exists: false };
    }

    // Other errors
    throw new Error(`Error checking file: ${response.statusText}`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Error checking file existence:", errorMessage);

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
  try {
    const config = getDatabricksConfig(userToken);
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

    console.log(`📤 Starting upload (${config.authMethod}): ${fileName}`);

    // Check if file exists and overwrite is not enabled
    if (!overwrite) {
      const fileCheck = await checkFileExists(fileName, userToken);
      if (fileCheck.exists) {
        console.log(`⚠️ File already exists: ${filePath}`);
        return {
          success: false,
          path: filePath,
          error: "FILE_EXISTS",
        };
      }
    }

    // Using Databricks Workspace Files API
    const url = `https://${config.host}/api/2.0/fs/files${filePath}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: file as unknown as BodyInit,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Databricks upload error (${response.status}):`, errorText);
      
      // Better error messages for common issues
      if (response.status === 403) {
        throw new Error(`Permission denied. User does not have WRITE_VOLUME permission on ${volumePath}`);
      } else if (response.status === 404) {
        throw new Error(`Volume not found: ${volumePath}`);
      } else {
        throw new Error(`Upload failed: ${response.statusText}`);
      }
    }

    console.log(`✅ File uploaded successfully (${config.authMethod}): ${filePath}`);

    return {
      success: true,
      path: filePath,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Error uploading to volume:", errorMessage);

    return {
      success: false,
      path: "",
      error: errorMessage,
    };
  }
}
