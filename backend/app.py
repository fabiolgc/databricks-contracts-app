"""
FastAPI backend for Databricks Contracts App
Serves static Next.js files and provides API endpoints for:
- Module 1: File upload to Unity Catalog Volumes
- Module 2: Data preparation, chunking, and Delta table management
"""

import os
import re
import uuid
import asyncio
from datetime import datetime
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, File, UploadFile, Form, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import httpx

app = FastAPI(title="Databricks Contracts App")

# ============================================================================
# Pydantic Models for Module 2
# ============================================================================

class TableConfig(BaseModel):
    catalog: str
    schema_: str = None  # 'schema' is reserved in Pydantic
    schema_name: str = None  # alias
    tableName: str
    
    def get_schema(self) -> str:
        return self.schema_ or self.schema_name or ""
    
    class Config:
        populate_by_name = True

class ProcessRequest(BaseModel):
    tableConfig: Dict[str, str]
    files: List[str]
    strategy: str
    params: Dict[str, Any]
    mode: str  # append, overwrite, clean

class ChunkPreviewRequest(BaseModel):
    tableConfig: Dict[str, str]
    limit: int = 50

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
# Module 2: Data Preparation API Routes
# ============================================================================

@app.get("/api/config")
async def get_config():
    """Get default configuration from environment"""
    return {
        "catalog": os.getenv("DATABRICKS_CATALOG", ""),
        "schema": os.getenv("DATABRICKS_SCHEMA", ""),
        "volume": os.getenv("DATABRICKS_VOLUME", ""),
        "host": os.getenv("DATABRICKS_SERVER_HOSTNAME", ""),
    }


@app.get("/api/documents")
async def list_documents(
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """List PDF files from the Unity Catalog Volume"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📄 [{request_id}] List documents request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        volume_path = get_volume_base_path(config)
        
        print(f"📁 [{request_id}] Listing files in: {volume_path}")
        
        # Use Databricks Workspace Files API to list directory
        url = f"https://{config['host']}/api/2.0/fs/directories{volume_path}"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {config['token']}"}
            )
        
        if response.status_code != 200:
            print(f"❌ [{request_id}] Error listing files: {response.status_code}")
            print(f"  Response: {response.text}")
            raise HTTPException(status_code=response.status_code, detail="Failed to list files")
        
        data = response.json()
        files = []
        
        for item in data.get("contents", []):
            if item.get("is_directory", False):
                continue
            
            name = item.get("name", "")
            if name.lower().endswith(".pdf"):
                files.append({
                    "name": name,
                    "path": item.get("path", ""),
                    "size": item.get("file_size", 0),
                    "lastModified": item.get("modification_time", ""),
                    "isImported": False  # Will be updated when we check the Delta table
                })
        
        print(f"✅ [{request_id}] Found {len(files)} PDF files")
        print(f"{'=' * 80}\n")
        
        return {"files": files}
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/table/check")
async def check_table(
    request: Dict[str, str],
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Check if Delta table exists and get record count"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Check table request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    catalog = request.get("catalog", "")
    schema = request.get("schema", "")
    table_name = request.get("tableName", "")
    
    print(f"📋 [{request_id}] Checking table: {catalog}.{schema}.{table_name}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        # Use Databricks SQL Statement API to check table existence
        url = f"https://{config['host']}/api/2.0/sql/statements"
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            print(f"⚠️ [{request_id}] No warehouse ID configured")
            return {"exists": False, "recordCount": 0, "message": "Warehouse not configured"}
        
        sql = f"""
        SELECT COUNT(*) as count FROM {catalog}.{schema}.{table_name}
        """
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {config['token']}",
                    "Content-Type": "application/json"
                },
                json={
                    "warehouse_id": warehouse_id,
                    "statement": sql,
                    "wait_timeout": "30s"
                }
            )
        
        if response.status_code == 200:
            result = response.json()
            status = result.get("status", {}).get("state", "")
            
            if status == "SUCCEEDED":
                data = result.get("result", {}).get("data_array", [[0]])
                count = int(data[0][0]) if data else 0
                print(f"✅ [{request_id}] Table exists with {count} records")
                return {"exists": True, "recordCount": count}
            elif "TABLE_OR_VIEW_NOT_FOUND" in str(result) or "SCHEMA_NOT_FOUND" in str(result):
                print(f"ℹ️ [{request_id}] Table does not exist")
                return {"exists": False, "recordCount": 0}
            else:
                error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
                if "TABLE_OR_VIEW_NOT_FOUND" in error_msg or "SCHEMA_NOT_FOUND" in error_msg:
                    print(f"ℹ️ [{request_id}] Table does not exist")
                    return {"exists": False, "recordCount": 0}
                print(f"⚠️ [{request_id}] Query status: {status}, error: {error_msg}")
                return {"exists": False, "recordCount": 0, "message": error_msg}
        else:
            error_text = response.text
            if "TABLE_OR_VIEW_NOT_FOUND" in error_text or "SCHEMA_NOT_FOUND" in error_text:
                print(f"ℹ️ [{request_id}] Table does not exist")
                return {"exists": False, "recordCount": 0}
            print(f"❌ [{request_id}] API error: {response.status_code}")
            return {"exists": False, "recordCount": 0, "message": f"API error: {response.status_code}"}
            
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        if "TABLE_OR_VIEW_NOT_FOUND" in str(e) or "SCHEMA_NOT_FOUND" in str(e):
            return {"exists": False, "recordCount": 0}
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/process")
async def process_documents(
    request: ProcessRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Process PDF files using Databricks ai_parse_document function.
    Extracts text, creates chunks, and saves to Delta table.
    
    Uses Databricks native AI function for superior PDF text extraction including OCR.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"⚙️ [{request_id}] Process documents request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        files = request.files
        strategy = request.strategy
        params = request.params
        mode = request.mode
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        full_table_name = f"{catalog}.{schema}.{table_name}"
        volume_path = get_volume_base_path(config)
        
        print(f"📋 [{request_id}] Processing configuration:")
        print(f"  - Table: {full_table_name}")
        print(f"  - Files: {len(files)}")
        print(f"  - Strategy: {strategy}")
        print(f"  - Mode: {mode}")
        print(f"  - Params: {params}")
        print(f"  - Volume: {volume_path}")
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        # Step 1: If mode is 'clean', drop existing data
        if mode == "clean":
            print(f"\n🗑️ [{request_id}] Cleaning existing data...")
            drop_sql = f"DROP TABLE IF EXISTS {full_table_name}"
            await execute_sql(config, warehouse_id, drop_sql, request_id)
        
        # Step 2: Create chunks table if not exists
        create_table_sql = f"""
        CREATE TABLE IF NOT EXISTS {full_table_name} (
            id STRING,
            file_name STRING,
            file_path STRING,
            chunk_index INT,
            total_chunks INT,
            content STRING,
            chunk_content STRING,
            strategy STRING,
            chunk_size INT,
            chunk_overlap INT,
            created_at TIMESTAMP,
            metadata STRING
        )
        USING DELTA
        """
        print(f"\n📊 [{request_id}] Ensuring chunks table exists...")
        await execute_sql(config, warehouse_id, create_table_sql, request_id)
        
        # Step 3: Get list of already imported files if mode is 'append'
        existing_files = set()
        if mode == "append":
            check_sql = f"SELECT DISTINCT file_name FROM {full_table_name}"
            result = await execute_sql(config, warehouse_id, check_sql, request_id)
            if result and result.get("data_array"):
                existing_files = set(row[0] for row in result.get("data_array", []))
            print(f"📁 [{request_id}] Already imported: {len(existing_files)} files")
        
        # Filter files to process
        files_to_process = []
        for file_name in files:
            if mode == "append" and file_name in existing_files:
                print(f"⏭️ [{request_id}] Skipping already imported: {file_name}")
                continue
            files_to_process.append(file_name)
        
        if not files_to_process:
            return {
                "success": True,
                "filesProcessed": 0,
                "chunksCreated": 0,
                "table": full_table_name,
                "message": "No new files to process"
            }
        
        # Step 4: If overwrite mode, delete existing chunks for selected files
        if mode == "overwrite":
            for file_name in files_to_process:
                delete_sql = f"DELETE FROM {full_table_name} WHERE file_name = '{file_name}'"
                await execute_sql(config, warehouse_id, delete_sql, request_id)
                print(f"🗑️ [{request_id}] Deleted existing chunks for: {file_name}")
        
        # Step 5: Create temp table name for parsed documents
        temp_parsed_table = f"{catalog}.{schema}._temp_parsed_{request_id.replace('-', '_')}"
        
        # Step 6: Build file filter for ai_parse_document
        # Filter to only process selected files
        file_filter = " OR ".join([f"path LIKE '%{f}'" for f in files_to_process])
        
        # Step 7: Use ai_parse_document to extract text from PDFs
        # This is the Databricks native function for document parsing
        print(f"\n🤖 [{request_id}] Extracting text using ai_parse_document...")
        
        ai_parse_sql = f"""
        CREATE OR REPLACE TABLE {temp_parsed_table} AS (
            WITH source_files AS (
                SELECT
                    path,
                    content
                FROM READ_FILES('{volume_path}', format => 'binaryFile')
                WHERE ({file_filter})
            ),
            parsed_documents AS (
                SELECT
                    path,
                    ai_parse_document(content) as parsed
                FROM source_files
                WHERE lower(path) LIKE '%.pdf'
            ),
            extracted_content AS (
                SELECT
                    path,
                    element:content AS content,
                    idx
                FROM (
                    SELECT
                        path,
                        posexplode(
                            CASE
                                WHEN try_cast(parsed:metadata:version AS STRING) = '1.0' 
                                THEN try_cast(parsed:document:pages AS ARRAY<VARIANT>)
                                ELSE try_cast(parsed:document:elements AS ARRAY<VARIANT>)
                            END
                        ) AS (idx, element)
                    FROM parsed_documents
                    WHERE try_cast(parsed:error_status AS STRING) IS NULL
                )
            ),
            concatenated AS (
                SELECT
                    path,
                    concat_ws('\n\n', collect_list(content)) AS full_text
                FROM extracted_content
                WHERE content IS NOT NULL
                GROUP BY path
            )
            SELECT
                regexp_extract(path, r'([^/]+)$', 1) as file_name,
                path as file_path,
                full_text as content
            FROM concatenated
        )
        """
        
        # Execute with extended timeout for AI processing
        print(f"  📄 Parsing {len(files_to_process)} files with AI...")
        await execute_sql_long(config, warehouse_id, ai_parse_sql, request_id, timeout="300s")
        
        # Step 8: Read extracted text from temp table
        print(f"\n📖 [{request_id}] Reading extracted text...")
        read_sql = f"SELECT file_name, file_path, content FROM {temp_parsed_table}"
        parsed_result = await execute_sql(config, warehouse_id, read_sql, request_id)
        
        if not parsed_result or not parsed_result.get("data_array"):
            # Cleanup temp table
            await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_parsed_table}", request_id)
            return {
                "success": False,
                "error": "No text could be extracted from the documents",
                "filesProcessed": 0,
                "chunksCreated": 0
            }
        
        # Step 9: Process chunks and insert into target table
        total_chunks = 0
        files_processed = 0
        chunk_size = params.get("chunkSize", 1000)
        chunk_overlap = params.get("chunkOverlap", 200)
        
        for row in parsed_result.get("data_array", []):
            file_name = row[0]
            file_path = row[1]
            text_content = row[2] or ""
            
            print(f"\n📄 [{request_id}] Processing: {file_name}")
            print(f"  📝 Extracted {len(text_content)} characters")
            
            if not text_content.strip():
                print(f"  ⚠️ No text content extracted, skipping")
                continue
            
            # Create chunks based on strategy
            chunks = create_chunks(text_content, strategy, chunk_size, chunk_overlap)
            print(f"  ✂️ Created {len(chunks)} chunks using '{strategy}' strategy")
            
            # Insert chunks into Delta table
            for idx, chunk in enumerate(chunks):
                chunk_id = str(uuid.uuid4())
                # Escape single quotes for SQL
                escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
                escaped_content = text_content[:500].replace("'", "''").replace("\\", "\\\\") if idx == 0 else ""
                escaped_file_name = file_name.replace("'", "''")
                escaped_file_path = file_path.replace("'", "''")
                
                insert_sql = f"""
                INSERT INTO {full_table_name} 
                (id, file_name, file_path, chunk_index, total_chunks, content, chunk_content, 
                 strategy, chunk_size, chunk_overlap, created_at, metadata)
                VALUES (
                    '{chunk_id}',
                    '{escaped_file_name}',
                    '{escaped_file_path}',
                    {idx},
                    {len(chunks)},
                    '{escaped_content}',
                    '{escaped_chunk}',
                    '{strategy}',
                    {chunk_size},
                    {chunk_overlap},
                    current_timestamp(),
                    '{{}}'
                )
                """
                await execute_sql(config, warehouse_id, insert_sql, request_id)
            
            total_chunks += len(chunks)
            files_processed += 1
        
        # Step 10: Cleanup temp table
        print(f"\n🧹 [{request_id}] Cleaning up temp table...")
        await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_parsed_table}", request_id)
        
        print(f"\n✅ [{request_id}] Processing complete!")
        print(f"  - Files processed: {files_processed}")
        print(f"  - Total chunks: {total_chunks}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "filesProcessed": files_processed,
            "chunksCreated": total_chunks,
            "table": full_table_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chunks/preview")
async def preview_chunks(
    request: ChunkPreviewRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get preview of chunks from the Delta table"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"👁️ [{request_id}] Preview chunks request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        limit = request.limit
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        full_table_name = f"{catalog}.{schema}.{table_name}"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        sql = f"""
        SELECT file_name, chunk_index, total_chunks, chunk_content
        FROM {full_table_name}
        ORDER BY file_name, chunk_index
        LIMIT {limit}
        """
        
        result = await execute_sql(config, warehouse_id, sql, request_id)
        
        chunks = []
        if result and result.get("data_array"):
            for row in result.get("data_array", []):
                chunks.append({
                    "documentName": row[0],
                    "chunkIndex": int(row[1]),
                    "totalChunks": int(row[2]),
                    "content": row[3][:1000] if row[3] else "",  # Limit content for preview
                    "metadata": {}
                })
        
        print(f"✅ [{request_id}] Returning {len(chunks)} chunk previews")
        return {"chunks": chunks}
        
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Helper Functions for Module 2
# ============================================================================

async def execute_sql(config: dict, warehouse_id: str, sql: str, request_id: str) -> dict:
    """Execute SQL statement via Databricks SQL Statement API"""
    url = f"https://{config['host']}/api/2.0/sql/statements"
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {config['token']}",
                "Content-Type": "application/json"
            },
            json={
                "warehouse_id": warehouse_id,
                "statement": sql,
                "wait_timeout": "60s"
            }
        )
    
    if response.status_code != 200:
        print(f"❌ [{request_id}] SQL execution failed: {response.status_code}")
        print(f"  SQL: {sql[:100]}...")
        print(f"  Response: {response.text[:500]}")
        return None
    
    result = response.json()
    status = result.get("status", {}).get("state", "")
    
    if status == "SUCCEEDED":
        return result.get("result", {})
    else:
        error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
        print(f"⚠️ [{request_id}] SQL status: {status}, error: {error_msg}")
        return None


async def execute_sql_long(config: dict, warehouse_id: str, sql: str, request_id: str, timeout: str = "300s") -> dict:
    """
    Execute long-running SQL statement (like ai_parse_document) with extended timeout.
    Uses statement API with async polling for completion.
    """
    url = f"https://{config['host']}/api/2.0/sql/statements"
    
    print(f"  🔄 [{request_id}] Executing long-running SQL (timeout: {timeout})...")
    
    async with httpx.AsyncClient(timeout=600.0) as client:  # 10 min HTTP timeout
        # Submit statement
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {config['token']}",
                "Content-Type": "application/json"
            },
            json={
                "warehouse_id": warehouse_id,
                "statement": sql,
                "wait_timeout": timeout
            }
        )
    
    if response.status_code != 200:
        print(f"❌ [{request_id}] Long SQL execution failed: {response.status_code}")
        print(f"  Response: {response.text[:500]}")
        return None
    
    result = response.json()
    status = result.get("status", {}).get("state", "")
    statement_id = result.get("statement_id", "")
    
    print(f"  📋 [{request_id}] Statement ID: {statement_id}, Status: {status}")
    
    # If still running, poll for completion
    if status in ["PENDING", "RUNNING"]:
        print(f"  ⏳ [{request_id}] Statement running, polling for completion...")
        poll_url = f"{url}/{statement_id}"
        max_attempts = 60  # 10 min max (10s intervals)
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            for attempt in range(max_attempts):
                await asyncio.sleep(10)  # Wait 10 seconds between polls
                
                poll_response = await client.get(
                    poll_url,
                    headers={"Authorization": f"Bearer {config['token']}"}
                )
                
                if poll_response.status_code != 200:
                    print(f"❌ [{request_id}] Poll failed: {poll_response.status_code}")
                    continue
                
                poll_result = poll_response.json()
                status = poll_result.get("status", {}).get("state", "")
                print(f"  📊 [{request_id}] Poll {attempt + 1}: {status}")
                
                if status == "SUCCEEDED":
                    return poll_result.get("result", {})
                elif status in ["FAILED", "CANCELED", "CLOSED"]:
                    error_msg = poll_result.get("status", {}).get("error", {}).get("message", "Unknown error")
                    print(f"❌ [{request_id}] Statement failed: {error_msg}")
                    return None
        
        print(f"❌ [{request_id}] Statement timed out after polling")
        return None
    
    elif status == "SUCCEEDED":
        return result.get("result", {})
    else:
        error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
        print(f"❌ [{request_id}] Long SQL failed: {status}, error: {error_msg}")
        return None


async def read_file_from_volume(config: dict, file_path: str, request_id: str) -> bytes:
    """Read file content from Databricks Volume"""
    url = f"https://{config['host']}/api/2.0/fs/files{file_path}"
    
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {config['token']}"}
            )
        
        if response.status_code == 200:
            return response.content
        else:
            print(f"❌ [{request_id}] Failed to read file: {response.status_code}")
            return None
    except Exception as e:
        print(f"💥 [{request_id}] Error reading file: {str(e)}")
        return None


def extract_text_placeholder(file_content: bytes, file_name: str) -> str:
    """
    Placeholder for PDF text extraction.
    In production, use PyPDF2 or pdfplumber.
    For now, returns a placeholder with file info.
    """
    # NOTE: Real implementation would use:
    # from pypdf import PdfReader
    # reader = PdfReader(io.BytesIO(file_content))
    # text = ""
    # for page in reader.pages:
    #     text += page.extract_text() + "\n"
    
    return f"""
[Document: {file_name}]
[Size: {len(file_content)} bytes]

Este é um placeholder para o conteúdo extraído do PDF.
Em produção, use PyPDF2 ou pdfplumber para extrair o texto real do documento.

O arquivo contém {len(file_content)} bytes de dados binários PDF.
Para implementar a extração real, adicione 'pypdf' ao requirements.txt e
use PdfReader para extrair o texto de cada página.

Exemplo de implementação:
```python
from pypdf import PdfReader
import io

reader = PdfReader(io.BytesIO(file_content))
text = ""
for page in reader.pages:
    text += page.extract_text() + "\\n"
```

[Fim do documento]
"""


def create_chunks(text: str, strategy: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    """
    Create text chunks based on the selected strategy.
    Based on: https://community.databricks.com/t5/technical-blog/the-ultimate-guide-to-chunking-strategies-for-rag-applications/ba-p/113089
    """
    if not text:
        return []
    
    if strategy == "fixed_size":
        return chunk_fixed_size(text, chunk_size, chunk_overlap)
    
    elif strategy == "recursive":
        return chunk_recursive(text, chunk_size, chunk_overlap)
    
    elif strategy == "by_page":
        # For placeholder, simulate page breaks
        pages = text.split("[Page Break]") if "[Page Break]" in text else [text]
        return [page.strip() for page in pages if page.strip()]
    
    elif strategy == "by_sentence":
        return chunk_by_sentence(text, chunk_size, chunk_overlap)
    
    elif strategy == "semantic":
        # Semantic chunking would require embeddings - use recursive as fallback
        return chunk_recursive(text, chunk_size, chunk_overlap)
    
    else:
        # Default to fixed size
        return chunk_fixed_size(text, chunk_size, chunk_overlap)


def chunk_fixed_size(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Fixed-size chunking with overlap"""
    chunks = []
    start = 0
    
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        
        if chunk.strip():
            chunks.append(chunk.strip())
        
        # Move start, accounting for overlap
        start = end - overlap if overlap > 0 else end
        
        # Avoid infinite loop
        if start >= len(text) - overlap:
            break
    
    return chunks


def chunk_recursive(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Recursive character text splitting"""
    separators = ["\n\n", "\n", ". ", " ", ""]
    
    def split_text(text: str, separators: List[str]) -> List[str]:
        if len(text) <= chunk_size:
            return [text] if text.strip() else []
        
        for sep in separators:
            if sep in text:
                parts = text.split(sep)
                chunks = []
                current_chunk = ""
                
                for part in parts:
                    if len(current_chunk) + len(part) + len(sep) <= chunk_size:
                        current_chunk = current_chunk + sep + part if current_chunk else part
                    else:
                        if current_chunk.strip():
                            chunks.append(current_chunk.strip())
                        current_chunk = part
                
                if current_chunk.strip():
                    chunks.append(current_chunk.strip())
                
                return chunks
        
        # No separator found, use fixed size
        return chunk_fixed_size(text, chunk_size, overlap)
    
    return split_text(text, separators)


def chunk_by_sentence(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Chunk by complete sentences"""
    # Simple sentence splitting
    sentence_endings = re.compile(r'(?<=[.!?])\s+')
    sentences = sentence_endings.split(text)
    
    chunks = []
    current_chunk = ""
    
    for sentence in sentences:
        if len(current_chunk) + len(sentence) <= chunk_size:
            current_chunk = current_chunk + " " + sentence if current_chunk else sentence
        else:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            current_chunk = sentence
    
    if current_chunk.strip():
        chunks.append(current_chunk.strip())
    
    return chunks


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
