"""
FastAPI backend for Databricks Contracts App
Serves static Next.js files and provides API endpoints for file upload
"""

import os
import uuid
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, File, UploadFile, Form, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx

app = FastAPI(title="Databricks Contracts App")

# CORS middleware (adjust origins as needed for your environment)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your domains
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# Databricks Client Functions
# ============================================================================

def get_databricks_config(user_token: Optional[str] = None):
    """Get Databricks configuration with authentication token"""
    config = {
        "host": os.getenv("DATABRICKS_SERVER_HOSTNAME") or os.getenv("DATABRICKS_HOST"),
        # Priority: User token (OBO) > Service Principal > Local dev token
        "token": user_token or os.getenv("DATABRICKS_CLIENT_SECRET") or os.getenv("DATABRICKS_TOKEN"),
        "catalog": os.getenv("DATABRICKS_CATALOG", "fabio_goncalves"),
        "schema": os.getenv("DATABRICKS_SCHEMA", "customer_cielo"),
        "volume": os.getenv("DATABRICKS_VOLUME", "pdf"),
        "auth_method": "OBO" if user_token else "Service Principal",
    }
    
    if not config["host"]:
        raise ValueError("DATABRICKS_SERVER_HOSTNAME or DATABRICKS_HOST is not configured")
    
    if not config["token"]:
        raise ValueError("Authentication token not available")
    
    return config


def get_volume_base_path(config: dict) -> str:
    """Construct volume base path"""
    return f"/Volumes/{config['catalog']}/{config['schema']}/{config['volume']}"


async def check_file_exists(
    file_name: str, 
    user_token: Optional[str] = None
) -> dict:
    """Check if file exists in Databricks Volume"""
    check_id = str(uuid.uuid4())[:8]
    
    try:
        print(f"\n{'─' * 60}")
        print(f"🔍 [CHECK-{check_id}] Checking file existence")
        print(f"{'─' * 60}")
        
        config = get_databricks_config(user_token)
        volume_path = get_volume_base_path(config)
        file_path = f"{volume_path}/{file_name}"
        
        print(f"📋 [CHECK-{check_id}] Configuration:")
        print(f"  - Auth method: {config['auth_method']}")
        print(f"  - Host: {config['host']}")
        print(f"  - File path: {file_path}")
        
        url = f"https://{config['host']}/api/2.0/fs/files{file_path}"
        print(f"\n🌐 [CHECK-{check_id}] Making HTTP HEAD request:")
        print(f"  - URL: {url}")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.head(
                url,
                headers={"Authorization": f"Bearer {config['token']}"}
            )
        
        print(f"\n📡 [CHECK-{check_id}] Response: {response.status_code}")
        
        if response.status_code == 200:
            print(f"✅ [CHECK-{check_id}] File EXISTS: {file_path}")
            print(f"{'─' * 60}\n")
            return {"exists": True}
        
        if response.status_code == 404:
            print(f"✓ [CHECK-{check_id}] File DOES NOT exist: {file_path}")
            print(f"{'─' * 60}\n")
            return {"exists": False}
        
        error_msg = f"HTTP {response.status_code}: {response.text}"
        print(f"❌ [CHECK-{check_id}] Error: {error_msg}")
        print(f"{'─' * 60}\n")
        return {"exists": False, "error": error_msg}
        
    except Exception as e:
        print(f"\n💥 [CHECK-{check_id}] EXCEPTION: {str(e)}")
        print(f"{'─' * 60}\n")
        return {"exists": False, "error": str(e)}


async def upload_to_volume(
    file_content: bytes,
    file_name: str,
    overwrite: bool = False,
    user_token: Optional[str] = None
) -> dict:
    """Upload file to Databricks Volume"""
    upload_id = str(uuid.uuid4())[:8]
    
    try:
        print(f"\n{'═' * 80}")
        print(f"📤 [UPLOAD-{upload_id}] Starting upload process")
        print(f"{'═' * 80}")
        
        config = get_databricks_config(user_token)
        volume_path = get_volume_base_path(config)
        file_path = f"{volume_path}/{file_name}"
        
        print(f"📋 [UPLOAD-{upload_id}] Upload configuration:")
        print(f"  - File name: {file_name}")
        print(f"  - File size: {len(file_content)} bytes ({len(file_content) / 1024 / 1024:.2f} MB)")
        print(f"  - Auth method: {config['auth_method']}")
        print(f"  - Overwrite mode: {'YES' if overwrite else 'NO'}")
        print(f"  - Full file path: {file_path}")
        
        # Check if file exists (unless overwrite is enabled)
        if not overwrite:
            print(f"\n🔍 [UPLOAD-{upload_id}] Checking if file exists...")
            file_check = await check_file_exists(file_name, user_token)
            
            if file_check.get("exists"):
                print(f"⚠️ [UPLOAD-{upload_id}] File already exists: {file_path}")
                print(f"{'═' * 80}\n")
                return {
                    "success": False,
                    "path": file_path,
                    "error": "FILE_EXISTS"
                }
            print(f"✓ [UPLOAD-{upload_id}] File does not exist, proceeding")
        else:
            print(f"\n⚠️ [UPLOAD-{upload_id}] Overwrite ENABLED - skipping check")
        
        # Upload file
        url = f"https://{config['host']}/api/2.0/fs/files{file_path}"
        print(f"\n🌐 [UPLOAD-{upload_id}] Making HTTP PUT request:")
        print(f"  - URL: {url}")
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.put(
                url,
                headers={
                    "Authorization": f"Bearer {config['token']}",
                    "Content-Type": "application/octet-stream"
                },
                content=file_content
            )
        
        print(f"\n📡 [UPLOAD-{upload_id}] Response: {response.status_code}")
        
        # 200 = OK, 201 = Created, 204 = No Content (all are success codes)
        if response.status_code not in [200, 201, 204]:
            error_text = response.text
            print(f"\n❌ [UPLOAD-{upload_id}] Upload failed!")
            print(f"  - Status: {response.status_code}")
            print(f"  - Response: {error_text}")
            
            # Better error messages
            if response.status_code == 403:
                error_msg = f"Permission denied. Check WRITE_VOLUME permission on {volume_path}"
            elif response.status_code == 404:
                error_msg = f"Volume not found: {volume_path}"
            elif response.status_code == 401:
                error_msg = "Authentication failed. Token may be invalid or expired"
            else:
                error_msg = f"Upload failed: HTTP {response.status_code}"
            
            print(f"{'═' * 80}\n")
            return {"success": False, "path": file_path, "error": error_msg}
        
        print(f"\n✅ [UPLOAD-{upload_id}] Upload SUCCESSFUL!")
        print(f"  - File: {file_name}")
        print(f"  - Path: {file_path}")
        print(f"  - Size: {len(file_content) / 1024 / 1024:.2f} MB")
        print(f"{'═' * 80}\n")
        
        return {"success": True, "path": file_path}
        
    except Exception as e:
        print(f"\n💥 [UPLOAD-{upload_id}] EXCEPTION: {str(e)}")
        print(f"{'═' * 80}\n")
        return {"success": False, "path": "", "error": str(e)}


# ============================================================================
# API Routes
# ============================================================================

@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    overwrite: str = Form("false"),
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Upload PDF files to Databricks Volume
    
    Supports OBO (On-Behalf-Of) authentication:
    - If x-forwarded-access-token header is present, uses user's token
    - Otherwise, falls back to Service Principal token
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📤 [{request_id}] Upload request received at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        # Log environment
        print(f"🔧 [{request_id}] Environment check:")
        print(f"  - DATABRICKS_HOST: {'✅ Set' if os.getenv('DATABRICKS_SERVER_HOSTNAME') or os.getenv('DATABRICKS_HOST') else '❌ Missing'}")
        print(f"  - DATABRICKS_CLIENT_SECRET: {'✅ Set (***)' if os.getenv('DATABRICKS_CLIENT_SECRET') else '❌ Missing'}")
        print(f"  - DATABRICKS_CATALOG: {os.getenv('DATABRICKS_CATALOG', '❌ Missing')}")
        print(f"  - DATABRICKS_SCHEMA: {os.getenv('DATABRICKS_SCHEMA', '❌ Missing')}")
        print(f"  - DATABRICKS_VOLUME: {os.getenv('DATABRICKS_VOLUME', '❌ Missing')}")
        
        auth_method = "OBO (user token)" if x_forwarded_access_token else "Service Principal"
        print(f"\n🔐 [{request_id}] Authentication method: {auth_method}")
        
        # Validate file
        print(f"\n🔍 [{request_id}] Validating file...")
        print(f"  - Name: {file.filename}")
        print(f"  - Content-Type: {file.content_type}")
        
        if file.content_type != "application/pdf":
            print(f"❌ [{request_id}] Invalid file type: {file.content_type}")
            raise HTTPException(status_code=400, detail="Only PDF files are allowed")
        
        # Read file content
        print(f"🔄 [{request_id}] Reading file content...")
        file_content = await file.read()
        file_size = len(file_content)
        print(f"✅ [{request_id}] File read: {file_size} bytes ({file_size / 1024 / 1024:.2f} MB)")
        
        # Validate file size (max 100MB)
        max_size = 100 * 1024 * 1024
        if file_size > max_size:
            print(f"❌ [{request_id}] File too large: {file_size} bytes")
            raise HTTPException(status_code=400, detail="File size exceeds 100MB limit")
        
        # Upload to Databricks
        overwrite_bool = overwrite.lower() == "true"
        print(f"\n🚀 [{request_id}] Starting upload to Databricks...")
        
        result = await upload_to_volume(
            file_content,
            file.filename,
            overwrite_bool,
            x_forwarded_access_token
        )
        
        print(f"\n📊 [{request_id}] Upload result: {result}")
        
        if not result["success"]:
            # Special case for file exists
            if result.get("error") == "FILE_EXISTS":
                print(f"\n⚠️ [{request_id}] File already exists: {file.filename}")
                print(f"{'=' * 80}\n")
                return JSONResponse(
                    status_code=409,
                    content={
                        "fileExists": True,
                        "fileName": file.filename,
                        "path": result["path"]
                    }
                )
            
            print(f"\n❌ [{request_id}] Upload failed: {result.get('error')}")
            print(f"{'=' * 80}\n")
            raise HTTPException(
                status_code=500,
                detail=result.get("error", "Upload failed")
            )
        
        print(f"\n✅ [{request_id}] Upload successful!")
        print(f"  - File: {file.filename}")
        print(f"  - Path: {result['path']}")
        print(f"  - Size: {file_size / 1024 / 1024:.2f} MB")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "fileName": file.filename,
            "path": result["path"],
            "size": file_size
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"\n💥 [{request_id}] EXCEPTION: {str(e)}")
        print(f"{'=' * 80}\n")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "environment": {
            "host_configured": bool(os.getenv("DATABRICKS_SERVER_HOSTNAME") or os.getenv("DATABRICKS_HOST")),
            "token_configured": bool(os.getenv("DATABRICKS_CLIENT_SECRET") or os.getenv("DATABRICKS_TOKEN")),
            "catalog": os.getenv("DATABRICKS_CATALOG"),
            "schema": os.getenv("DATABRICKS_SCHEMA"),
            "volume": os.getenv("DATABRICKS_VOLUME"),
        }
    }


# ============================================================================
# Serve Static Files (Next.js build)
# Must be last to not override API routes
# ============================================================================

# Mount static files from 'static' directory (Next.js build output)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
    print("✅ Static files mounted from 'static' directory")
except RuntimeError as e:
    print(f"⚠️ Warning: Could not mount static files: {e}")
    print("   This is expected during development before running deploy.sh")
