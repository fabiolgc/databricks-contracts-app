/**
 * Databricks client utilities
 * Uses service principal authentication (no OBO)
 */

export function getDatabricksConfig() {
  const config = {
    host: process.env.DATABRICKS_SERVER_HOSTNAME,
    token: process.env.DATABRICKS_TOKEN,
    catalog: process.env.DATABRICKS_CATALOG || "fabio_goncalves",
    schema: process.env.DATABRICKS_SCHEMA || "customer_cielo",
    volume: process.env.DATABRICKS_VOLUME || "pdf",
  };

  if (!config.host) {
    throw new Error("DATABRICKS_SERVER_HOSTNAME is not configured");
  }

  return config;
}

export function getVolumeBasePath() {
  const { catalog, schema, volume } = getDatabricksConfig();
  return `/Volumes/${catalog}/${schema}/${volume}`;
}

/**
 * Check if file exists in Databricks Volume
 */
export async function checkFileExists(
  fileName: string
): Promise<{ exists: boolean; error?: string }> {
  try {
    const config = getDatabricksConfig();
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

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
 */
export async function uploadToVolume(
  file: Buffer,
  fileName: string,
  overwrite: boolean = false
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    const config = getDatabricksConfig();
    const volumePath = getVolumeBasePath();
    const filePath = `${volumePath}/${fileName}`;

    // Check if file exists and overwrite is not enabled
    if (!overwrite) {
      const fileCheck = await checkFileExists(fileName);
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
      body: file,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Databricks upload error:", errorText);
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    console.log(`✅ File uploaded successfully: ${filePath}`);

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
