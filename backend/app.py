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
    # Note: mode removed - always delete existing chunks and create new ones

class ProcessSingleFileRequest(BaseModel):
    tableConfig: Dict[str, str]
    fileName: str
    strategy: str
    params: Dict[str, Any]
    # Note: mode removed - always delete existing chunks for this file and create new ones

class ExtractTextRequest(BaseModel):
    tableConfig: Dict[str, str]
    fileName: str
    mode: str = "replace"  # replace (if exists) or skip

class ChunkPreviewRequest(BaseModel):
    tableConfig: Dict[str, str]
    limit: int = 50
    fileNames: Optional[List[str]] = None  # Filter by specific file names

class RawDocumentsRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str  # Base name like "contracts" - will append "_raw"
    offset: int = 0
    limit: int = 10

class RawDocumentTextRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentId: str

class ChunkingPreviewRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentIds: List[str]  # IDs of documents to preview (max 3)
    strategy: str  # fixed_size, recursive, by_sentence, by_page, semantic
    chunkSize: int = 1000
    chunkOverlap: int = 200

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


# ============================================================================
# Chunking Functions
# ============================================================================

def chunk_by_fixed_size(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Divide text into fixed-size chunks with overlap"""
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start = end - overlap
        if start >= len(text) - overlap:
            break
    return chunks


def chunk_by_recursive(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Divide text recursively by natural separators"""
    separators = ['\n\n', '\n', '. ', ' ']
    
    def split_text(txt: str, sep_index: int) -> List[str]:
        if len(txt) <= chunk_size:
            return [txt]
        if sep_index >= len(separators):
            return chunk_by_fixed_size(txt, chunk_size, overlap)
        
        sep = separators[sep_index]
        parts = txt.split(sep)
        result = []
        current = ''
        
        for part in parts:
            candidate = current + sep + part if current else part
            if len(candidate) <= chunk_size:
                current = candidate
            else:
                if current:
                    result.append(current)
                if len(part) > chunk_size:
                    result.extend(split_text(part, sep_index + 1))
                    current = ''
                else:
                    current = part
        if current:
            result.append(current)
        return result
    
    return split_text(text, 0)


def chunk_by_sentence(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Divide text by sentences, grouping until max size"""
    import re
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current = ''
    
    for sentence in sentences:
        if len(current + ' ' + sentence) <= chunk_size:
            current = current + ' ' + sentence if current else sentence
        else:
            if current:
                chunks.append(current.strip())
            current = sentence
    if current:
        chunks.append(current.strip())
    
    # Apply overlap
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev = chunks[i - 1]
            overlap_text = prev[-overlap:] if len(prev) > overlap else prev
            overlapped.append(overlap_text + ' ' + chunks[i])
        return overlapped
    
    return chunks


def chunk_by_page(text: str) -> List[str]:
    """Divide text by page markers (triple newlines)"""
    pages = re.split(r'\n\n\n+', text)
    return [p.strip() for p in pages if p.strip()]


def apply_chunking(text: str, strategy: str, chunk_size: int = 1000, overlap: int = 200) -> List[str]:
    """Apply chunking strategy to text"""
    if not text or not text.strip():
        return []
    
    if strategy == 'fixed_size':
        return chunk_by_fixed_size(text, chunk_size, overlap)
    elif strategy == 'recursive':
        return chunk_by_recursive(text, chunk_size, overlap)
    elif strategy == 'by_sentence':
        return chunk_by_sentence(text, chunk_size, overlap)
    elif strategy == 'by_page':
        return chunk_by_page(text)
    elif strategy == 'semantic':
        # Semantic would need embeddings - fallback to recursive for now
        return chunk_by_recursive(text, chunk_size, overlap)
    else:
        return chunk_by_fixed_size(text, chunk_size, overlap)


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


@app.post("/api/extract-text")
async def extract_text_from_file(
    request: ExtractTextRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Extract text from a PDF file using ai_parse_document and save to documents table.
    Called after successful upload to volume.
    """
    request_id = str(uuid.uuid4())[:8]
    file_name = request.fileName
    mode = request.mode
    
    print(f"\n{'=' * 80}")
    print(f"📝 [{request_id}] Extract text request: {file_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        
        # Use _raw suffix for raw documents table (Module 1)
        raw_table = f"{catalog}.{schema}.{table_name}_raw"
        volume_path = get_volume_base_path(config)
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        print(f"📋 [{request_id}] Configuration:")
        print(f"  - Table: {raw_table}")
        print(f"  - Volume: {volume_path}")
        print(f"  - File: {file_name}")
        print(f"  - Mode: {mode}")
        
        # Step 1: Create raw documents table if not exists
        create_table_sql = f"""
        CREATE TABLE IF NOT EXISTS {raw_table} (
            id STRING,
            file_name STRING,
            file_path STRING,
            raw_text STRING,
            text_length INT,
            page_count INT,
            created_at TIMESTAMP,
            updated_at TIMESTAMP,
            metadata STRING
        )
        USING DELTA
        """
        print(f"\n📊 [{request_id}] Ensuring raw table exists...")
        await execute_sql(config, warehouse_id, create_table_sql, request_id)
        
        # Step 2: Check if document already exists
        escaped_file_name = file_name.replace("'", "''")
        check_sql = f"SELECT id FROM {raw_table} WHERE file_name = '{escaped_file_name}'"
        check_result = await execute_sql(config, warehouse_id, check_sql, request_id)
        
        existing_doc_id = None
        if check_result and check_result.get("data_array") and len(check_result["data_array"]) > 0:
            existing_doc_id = check_result["data_array"][0][0]
            print(f"📁 [{request_id}] Document already exists with ID: {existing_doc_id}")
            
            if mode == "skip":
                print(f"⏭️ [{request_id}] Skipping extraction (document exists)")
                return {
                    "success": True,
                    "fileName": file_name,
                    "documentId": existing_doc_id,
                    "skipped": True,
                    "message": "Document already exists"
                }
        
        # Step 3: Extract text using ai_parse_document
        print(f"\n🤖 [{request_id}] Extracting text with ai_parse_document...")
        
        extract_sql = f"""
        WITH source_file AS (
            SELECT path, content
            FROM READ_FILES('{volume_path}', format => 'binaryFile')
            WHERE path LIKE '%/{escaped_file_name}'
            LIMIT 1
        ),
        parsed AS (
            SELECT 
                path,
                ai_parse_document(content) as parsed
            FROM source_file
        ),
        extracted AS (
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
                FROM parsed
                WHERE try_cast(parsed:error_status AS STRING) IS NULL
            )
        )
        SELECT
            path,
            concat_ws('\\n\\n', collect_list(content)) AS full_text,
            COUNT(*) as page_count
        FROM extracted
        WHERE content IS NOT NULL
        GROUP BY path
        """
        
        result = await execute_sql_long(config, warehouse_id, extract_sql, request_id, timeout_minutes=5)
        
        if not result or not result.get("data_array") or len(result.get("data_array", [])) == 0:
            print(f"❌ [{request_id}] No text extracted from {file_name}")
            return {
                "success": False,
                "fileName": file_name,
                "error": "No text could be extracted from this file"
            }
        
        row = result["data_array"][0]
        file_path = row[0]
        raw_text = row[1] or ""
        page_count = int(row[2]) if row[2] else 0
        
        print(f"✅ [{request_id}] Extracted {len(raw_text)} characters from {page_count} pages")
        
        if not raw_text.strip():
            return {
                "success": False,
                "fileName": file_name,
                "error": "Extracted text is empty"
            }
        
        # Step 4: Save to raw table (INSERT or UPDATE)
        print(f"\n💾 [{request_id}] Saving to raw table...")
        
        escaped_raw_text = raw_text.replace("'", "''").replace("\\", "\\\\")
        escaped_path = file_path.replace("'", "''")
        
        if existing_doc_id:
            # Update existing document
            update_sql = f"""
            UPDATE {raw_table}
            SET raw_text = '{escaped_raw_text}',
                text_length = {len(raw_text)},
                page_count = {page_count},
                updated_at = current_timestamp()
            WHERE id = '{existing_doc_id}'
            """
            await execute_sql(config, warehouse_id, update_sql, request_id)
            doc_id = existing_doc_id
            print(f"✅ [{request_id}] Document updated: {doc_id}")
        else:
            # Insert new document
            doc_id = str(uuid.uuid4())
            insert_sql = f"""
            INSERT INTO {raw_table}
            (id, file_name, file_path, raw_text, text_length, page_count, created_at, updated_at, metadata)
            VALUES (
                '{doc_id}',
                '{escaped_file_name}',
                '{escaped_path}',
                '{escaped_raw_text}',
                {len(raw_text)},
                {page_count},
                current_timestamp(),
                current_timestamp(),
                '{{}}'
            )
            """
            await execute_sql(config, warehouse_id, insert_sql, request_id)
            print(f"✅ [{request_id}] Document inserted: {doc_id}")
        
        print(f"\n✅ [{request_id}] Text extraction complete!")
        print(f"  - Document ID: {doc_id}")
        print(f"  - Text length: {len(raw_text)} chars")
        print(f"  - Page count: {page_count}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "fileName": file_name,
            "documentId": doc_id,
            "textLength": len(raw_text),
            "pageCount": page_count,
            "updated": existing_doc_id is not None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "fileName": file_name,
            "error": str(e)
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
    """Check if Delta tables exist and get record counts"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Check table request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    catalog = request.get("catalog", "")
    schema = request.get("schema", "")
    table_name = request.get("tableName", "")
    
    # Table names: _raw (from Module 1) and _chunks (Module 2)
    raw_table = f"{catalog}.{schema}.{table_name}_raw"
    chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
    
    print(f"📋 [{request_id}] Checking tables:")
    print(f"  - Raw: {raw_table}")
    print(f"  - Chunks: {chunks_table}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            print(f"⚠️ [{request_id}] No warehouse ID configured")
            return {"exists": False, "recordCount": 0, "message": "Warehouse not configured"}
        
        # Check chunks table (main table for Module 2)
        try:
            chunks_result = await execute_sql(config, warehouse_id, 
                f"SELECT COUNT(*) as count FROM {chunks_table}", request_id)
            
            if chunks_result and chunks_result.get("data_array"):
                count = int(chunks_result["data_array"][0][0]) if chunks_result["data_array"] else 0
                print(f"✅ [{request_id}] Chunks table exists with {count} records")
                
                return {
                    "exists": True, 
                    "recordCount": count,
                    "rawTable": raw_table,
                    "chunksTable": chunks_table
                }
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                print(f"ℹ️ [{request_id}] Chunks table does not exist yet")
            else:
                print(f"⚠️ [{request_id}] Error checking chunks table: {error_str}")
        
        # Table doesn't exist
        print(f"ℹ️ [{request_id}] Tables do not exist yet")
        return {
            "exists": False, 
            "recordCount": 0,
            "rawTable": raw_table,
            "chunksTable": chunks_table
        }
            
    except Exception as e:
        error_str = str(e)
        print(f"💥 [{request_id}] Exception: {error_str}")
        if "TABLE_OR_VIEW_NOT_FOUND" in error_str or "SCHEMA_NOT_FOUND" in error_str:
            return {
                "exists": False, 
                "recordCount": 0,
                "rawTable": raw_table,
                "chunksTable": chunks_table
            }
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Module 2: Raw Documents API (for chunking preparation)
# ============================================================================

@app.post("/api/raw-documents")
async def get_raw_documents(
    request: RawDocumentsRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get documents from the _raw table with pagination"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📄 [{request_id}] Get raw documents at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    # Build full table name - use _raw suffix
    raw_table = f"{request.catalog}.{request.schema_name}.{request.tableName}_raw"
    
    print(f"📋 [{request_id}] Table: {raw_table}")
    print(f"📋 [{request_id}] Offset: {request.offset}, Limit: {request.limit}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Get total count
        count_sql = f"SELECT COUNT(*) as total FROM {raw_table}"
        count_result = await execute_sql(config, warehouse_id, count_sql, request_id)
        
        total_count = 0
        if count_result and count_result.get("data_array"):
            total_count = int(count_result["data_array"][0][0])
        
        print(f"📊 [{request_id}] Total records: {total_count}")
        
        # Get documents (without raw_text for list view - it can be large)
        docs_sql = f"""
        SELECT 
            id,
            file_name,
            file_path,
            text_length,
            page_count,
            created_at
        FROM {raw_table}
        ORDER BY created_at DESC
        LIMIT {request.limit}
        OFFSET {request.offset}
        """
        
        docs_result = await execute_sql(config, warehouse_id, docs_sql, request_id)
        
        documents = []
        if docs_result and docs_result.get("data_array"):
            for row in docs_result["data_array"]:
                documents.append({
                    "id": row[0],
                    "fileName": row[1],
                    "filePath": row[2],
                    "textLength": int(row[3]) if row[3] else 0,
                    "pageCount": int(row[4]) if row[4] else 0,
                    "createdAt": row[5]
                })
        
        print(f"✅ [{request_id}] Returned {len(documents)} documents")
        
        return {
            "success": True,
            "documents": documents,
            "total": total_count,
            "offset": request.offset,
            "limit": request.limit,
            "hasMore": request.offset + len(documents) < total_count
        }
        
    except Exception as e:
        error_str = str(e)
        print(f"💥 [{request_id}] Exception: {error_str}")
        if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
            return {
                "success": False,
                "documents": [],
                "total": 0,
                "error": "Tabela não encontrada. Importe documentos primeiro no Módulo 1.",
                "tableNotFound": True
            }
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/raw-documents/text")
async def get_raw_document_text(
    request: RawDocumentTextRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get the raw_text of a specific document"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📝 [{request_id}] Get document text at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    raw_table = f"{request.catalog}.{request.schema_name}.{request.tableName}_raw"
    
    print(f"📋 [{request_id}] Table: {raw_table}")
    print(f"📋 [{request_id}] Document ID: {request.documentId}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Get document with raw_text
        sql = f"""
        SELECT 
            id,
            file_name,
            raw_text,
            text_length,
            page_count
        FROM {raw_table}
        WHERE id = '{request.documentId}'
        """
        
        result = await execute_sql(config, warehouse_id, sql, request_id)
        
        if result and result.get("data_array") and len(result["data_array"]) > 0:
            row = result["data_array"][0]
            print(f"✅ [{request_id}] Found document: {row[1]}")
            return {
                "success": True,
                "document": {
                    "id": row[0],
                    "fileName": row[1],
                    "rawText": row[2],
                    "textLength": int(row[3]) if row[3] else 0,
                    "pageCount": int(row[4]) if row[4] else 0
                }
            }
        else:
            print(f"⚠️ [{request_id}] Document not found")
            raise HTTPException(status_code=404, detail="Documento não encontrado")
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chunking/preview")
async def get_chunking_preview(
    request: ChunkingPreviewRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Generate a preview of how chunks would look for selected documents"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Chunking preview at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    raw_table = f"{request.catalog}.{request.schema_name}.{request.tableName}_raw"
    
    print(f"📋 [{request_id}] Table: {raw_table}")
    print(f"📋 [{request_id}] Documents: {len(request.documentIds)}")
    print(f"📋 [{request_id}] Strategy: {request.strategy}")
    print(f"📋 [{request_id}] Chunk size: {request.chunkSize}, Overlap: {request.chunkOverlap}")
    
    # Limit to max 3 documents for preview
    doc_ids = request.documentIds[:3]
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Get documents with raw_text
        ids_list = "', '".join(doc_ids)
        sql = f"""
        SELECT 
            id,
            file_name,
            raw_text
        FROM {raw_table}
        WHERE id IN ('{ids_list}')
        """
        
        result = await execute_sql(config, warehouse_id, sql, request_id)
        
        preview_results = []
        
        if result and result.get("data_array"):
            for row in result["data_array"]:
                doc_id = row[0]
                file_name = row[1]
                raw_text = row[2] or ""
                
                # Apply chunking
                chunks = apply_chunking(
                    raw_text, 
                    request.strategy, 
                    request.chunkSize, 
                    request.chunkOverlap
                )
                
                print(f"✅ [{request_id}] {file_name}: {len(chunks)} chunks")
                
                preview_results.append({
                    "id": doc_id,
                    "fileName": file_name,
                    "totalChunks": len(chunks),
                    "chunks": [
                        {
                            "index": i,
                            "content": chunk[:500] + "..." if len(chunk) > 500 else chunk,
                            "length": len(chunk)
                        }
                        for i, chunk in enumerate(chunks[:10])  # Limit to first 10 chunks per doc
                    ],
                    "textLength": len(raw_text)
                })
        
        return {
            "success": True,
            "strategy": request.strategy,
            "chunkSize": request.chunkSize,
            "chunkOverlap": request.chunkOverlap,
            "documents": preview_results,
            "totalDocuments": len(preview_results)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/process/init")
async def init_processing(
    request: ProcessRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Initialize tables for processing.
    Creates documents table and chunks table.
    Returns list of files to process.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🚀 [{request_id}] Init processing at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        files = request.files
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        
        # Raw documents table (created in Module 1) - we just verify it exists
        raw_table = f"{catalog}.{schema}.{table_name}_raw"
        # Chunks table stores chunked content
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        # Step 1: Verify _raw table exists (created in Module 1)
        print(f"\n📋 [{request_id}] Verifying raw table exists: {raw_table}")
        verify_sql = f"SELECT COUNT(*) FROM {raw_table} LIMIT 1"
        try:
            await execute_sql(config, warehouse_id, verify_sql, request_id)
            print(f"✅ [{request_id}] Raw table exists")
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                raise HTTPException(
                    status_code=400, 
                    detail=f"Tabela _raw não encontrada. Importe documentos primeiro no Módulo 1."
                )
            raise
        
        # Step 2: Create chunks table (if not exists)
        # Note: Existing chunks for selected files will be deleted in process_single_file
        create_chunks_sql = f"""
        CREATE TABLE IF NOT EXISTS {chunks_table} (
            id STRING,
            document_id STRING,
            file_name STRING,
            chunk_index INT,
            total_chunks INT,
            chunk_content STRING,
            strategy STRING,
            chunk_size INT,
            chunk_overlap INT,
            created_at TIMESTAMP
        )
        USING DELTA
        """
        print(f"\n📊 [{request_id}] Creating chunks table: {chunks_table}")
        await execute_sql(config, warehouse_id, create_chunks_sql, request_id)
        
        # All selected files will be processed
        # Existing chunks will be deleted and new ones created with new strategy
        files_to_process = files
        skipped_files = []
        
        print(f"\n✅ [{request_id}] Init complete!")
        print(f"  - Files to process: {len(files_to_process)}")
        print(f"  - Mode: overwrite (chunks will be deleted and regenerated)")
        
        return {
            "success": True,
            "rawTable": raw_table,
            "chunksTable": chunks_table,
            "filesToProcess": files_to_process,
            "skippedFiles": skipped_files
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/process/file")
async def process_single_file(
    request: ProcessSingleFileRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Process a single PDF file:
    1. Extract text using ai_parse_document
    2. Save raw text to documents table
    3. Create chunks based on strategy
    4. Save chunks to chunks table
    """
    request_id = str(uuid.uuid4())[:8]
    file_name = request.fileName
    
    print(f"\n{'=' * 80}")
    print(f"📄 [{request_id}] Processing file: {file_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        strategy = request.strategy
        params = request.params
        # Note: mode removed - always delete existing chunks and create new ones
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        chunk_size = params.get("chunkSize", 1000)
        chunk_overlap = params.get("chunkOverlap", 200)
        
        # Step 1: Always delete existing chunks for this file before creating new ones
        # This ensures the new chunking strategy is applied fresh
        print(f"🗑️ [{request_id}] Deleting existing chunks for: {file_name}")
        escaped_name = file_name.replace("'", "''")
        try:
            await execute_sql(config, warehouse_id, 
                f"DELETE FROM {chunks_table} WHERE file_name = '{escaped_name}'", request_id)
        except Exception as e:
            # Table might not exist yet, that's OK
            print(f"⚠️ [{request_id}] Could not delete from chunks table (might not exist): {str(e)}")
        
        # Step 2: Get text from _raw table (already extracted in Module 1)
        escaped_file_name = file_name.replace("'", "''")
        raw_table = f"{catalog}.{schema}.{table_name}_raw"
        
        print(f"\n📖 [{request_id}] Fetching text from _raw table: {raw_table}")
        
        fetch_sql = f"""
        SELECT id, file_path, raw_text, text_length, page_count
        FROM {raw_table}
        WHERE file_name = '{escaped_file_name}'
        LIMIT 1
        """
        
        result = await execute_sql(config, warehouse_id, fetch_sql, request_id)
        
        if not result or not result.get("data_array") or len(result.get("data_array", [])) == 0:
            print(f"❌ [{request_id}] Document not found in _raw table: {file_name}")
            return {
                "success": False,
                "fileName": file_name,
                "error": "Document not found. Please import documents first in Module 1.",
                "chunksCreated": 0
            }
        
        row = result["data_array"][0]
        doc_id = row[0]
        extracted_path = row[1] or ""
        raw_text = row[2] or ""
        text_length = int(row[3]) if row[3] else 0
        page_count = int(row[4]) if row[4] else 0
        
        print(f"✅ [{request_id}] Found document: {text_length} characters, {page_count} pages")
        
        if not raw_text.strip():
            return {
                "success": False,
                "fileName": file_name,
                "error": "Document has no text content",
                "chunksCreated": 0
            }
        
        # Step 4: Create chunks
        print(f"\n✂️ [{request_id}] Creating chunks with '{strategy}' strategy...")
        chunks = create_chunks(raw_text, strategy, chunk_size, chunk_overlap)
        print(f"✅ [{request_id}] Created {len(chunks)} chunks")
        
        # Step 5: Save chunks to chunks table
        print(f"\n💾 [{request_id}] Saving {len(chunks)} chunks...")
        
        for idx, chunk in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
            
            insert_chunk_sql = f"""
            INSERT INTO {chunks_table}
            (id, document_id, file_name, chunk_index, total_chunks, chunk_content, 
             strategy, chunk_size, chunk_overlap, created_at)
            VALUES (
                '{chunk_id}',
                '{doc_id}',
                '{escaped_file_name}',
                {idx},
                {len(chunks)},
                '{escaped_chunk}',
                '{strategy}',
                {chunk_size},
                {chunk_overlap},
                current_timestamp()
            )
            """
            await execute_sql(config, warehouse_id, insert_chunk_sql, request_id)
        
        print(f"\n✅ [{request_id}] File processing complete!")
        print(f"  - Document ID: {doc_id}")
        print(f"  - Text length: {len(raw_text)} chars")
        print(f"  - Chunks created: {len(chunks)}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "fileName": file_name,
            "documentId": doc_id,
            "textLength": len(raw_text),
            "pageCount": page_count,
            "chunksCreated": len(chunks)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "fileName": file_name,
            "error": str(e),
            "chunksCreated": 0
        }


@app.post("/api/process")
async def process_documents(
    request: ProcessRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Legacy endpoint - redirects to new file-by-file processing.
    Kept for backwards compatibility.
    """
    # Initialize tables first
    init_result = await init_processing(request, x_forwarded_access_token)
    
    if not init_result.get("success"):
        return init_result
    
    # Process each file
    files_to_process = init_result.get("filesToProcess", [])
    total_chunks = 0
    files_processed = 0
    errors = []
    
    for file_name in files_to_process:
        file_request = ProcessSingleFileRequest(
            tableConfig=request.tableConfig,
            fileName=file_name,
            strategy=request.strategy,
            params=request.params
        )
        
        result = await process_single_file(file_request, x_forwarded_access_token)
        
        if result.get("success"):
            files_processed += 1
            total_chunks += result.get("chunksCreated", 0)
        else:
            errors.append({"file": file_name, "error": result.get("error")})
    
    return {
        "success": len(errors) == 0,
        "filesProcessed": files_processed,
        "chunksCreated": total_chunks,
        "rawTable": init_result.get("rawTable"),
        "chunksTable": init_result.get("chunksTable"),
        "errors": errors if errors else None
    }


@app.post("/api/chunks/preview")
async def preview_chunks(
    request: ChunkPreviewRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get preview of chunks from the Delta table, optionally filtered by file names"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"👁️ [{request_id}] Preview chunks request at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        
        table_config = request.tableConfig
        limit = request.limit
        file_names = request.fileNames
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = table_config.get("tableName", "")
        
        # Use the chunks table (with _chunks suffix)
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        # Build SQL with optional file name filter
        where_clause = ""
        if file_names and len(file_names) > 0:
            # Escape and quote file names
            escaped_names = [f"'{name.replace(chr(39), chr(39)+chr(39))}'" for name in file_names]
            where_clause = f"WHERE file_name IN ({', '.join(escaped_names)})"
            print(f"📁 [{request_id}] Filtering by {len(file_names)} file(s)")
        
        sql = f"""
        SELECT file_name, chunk_index, total_chunks, chunk_content
        FROM {chunks_table}
        {where_clause}
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
                    "content": row[3] if row[3] else "",  # Full content for processed files
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
                "wait_timeout": "50s"  # Max allowed is 50s
            }
        )
    
    if response.status_code != 200:
        print(f"❌ [{request_id}] SQL execution failed: {response.status_code}")
        print(f"  SQL: {sql[:100]}...")
        print(f"  Response: {response.text[:500]}")
        return None
    
    result = response.json()
    status = result.get("status", {}).get("state", "")
    statement_id = result.get("statement_id", "")
    
    # If still running after wait_timeout, poll for completion
    if status in ["PENDING", "RUNNING"]:
        print(f"  ⏳ [{request_id}] Query still running, polling...")
        return await poll_sql_statement(config, statement_id, request_id)
    
    if status == "SUCCEEDED":
        return result.get("result", {})
    else:
        error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
        print(f"⚠️ [{request_id}] SQL status: {status}, error: {error_msg}")
        return None


async def poll_sql_statement(config: dict, statement_id: str, request_id: str, max_attempts: int = 60) -> dict:
    """Poll for SQL statement completion"""
    url = f"https://{config['host']}/api/2.0/sql/statements/{statement_id}"
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        for attempt in range(max_attempts):
            await asyncio.sleep(5)  # Wait 5 seconds between polls
            
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {config['token']}"}
            )
            
            if response.status_code != 200:
                print(f"  ⚠️ [{request_id}] Poll failed: {response.status_code}")
                continue
            
            result = response.json()
            status = result.get("status", {}).get("state", "")
            
            if status == "SUCCEEDED":
                print(f"  ✅ [{request_id}] Query completed after {(attempt + 1) * 5}s")
                return result.get("result", {})
            elif status in ["FAILED", "CANCELED", "CLOSED"]:
                error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
                print(f"  ❌ [{request_id}] Query {status}: {error_msg}")
                return None
            else:
                if attempt % 6 == 0:  # Log every 30 seconds
                    print(f"  🔄 [{request_id}] Still running... ({(attempt + 1) * 5}s)")
    
    print(f"  ❌ [{request_id}] Query timed out after {max_attempts * 5}s")
    return None


async def execute_sql_long(config: dict, warehouse_id: str, sql: str, request_id: str, timeout_minutes: int = 10) -> dict:
    """
    Execute long-running SQL statement (like ai_parse_document) with async polling.
    Uses wait_timeout=0s to immediately return and poll for completion.
    """
    url = f"https://{config['host']}/api/2.0/sql/statements"
    
    print(f"  🔄 [{request_id}] Executing long-running SQL (max {timeout_minutes} min)...")
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        # Submit statement with wait_timeout=0s (immediate return, use polling)
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {config['token']}",
                "Content-Type": "application/json"
            },
            json={
                "warehouse_id": warehouse_id,
                "statement": sql,
                "wait_timeout": "0s"  # Disable wait, use polling
            }
        )
    
    if response.status_code != 200:
        print(f"❌ [{request_id}] Long SQL submission failed: {response.status_code}")
        print(f"  Response: {response.text[:500]}")
        return None
    
    result = response.json()
    status = result.get("status", {}).get("state", "")
    statement_id = result.get("statement_id", "")
    
    print(f"  📋 [{request_id}] Statement ID: {statement_id}, Initial status: {status}")
    
    # If already succeeded (unlikely with wait_timeout=0s but possible for cached results)
    if status == "SUCCEEDED":
        return result.get("result", {})
    
    # Poll for completion
    if status in ["PENDING", "RUNNING"]:
        print(f"  ⏳ [{request_id}] Polling for completion...")
        max_attempts = timeout_minutes * 6  # Poll every 10 seconds
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            for attempt in range(max_attempts):
                await asyncio.sleep(10)  # Wait 10 seconds between polls
                
                poll_response = await client.get(
                    f"{url}/{statement_id}",
                    headers={"Authorization": f"Bearer {config['token']}"}
                )
                
                if poll_response.status_code != 200:
                    print(f"  ⚠️ [{request_id}] Poll request failed: {poll_response.status_code}")
                    continue
                
                poll_result = poll_response.json()
                status = poll_result.get("status", {}).get("state", "")
                
                if status == "SUCCEEDED":
                    elapsed = (attempt + 1) * 10
                    print(f"  ✅ [{request_id}] Long SQL completed after {elapsed}s")
                    return poll_result.get("result", {})
                elif status in ["FAILED", "CANCELED", "CLOSED"]:
                    error_msg = poll_result.get("status", {}).get("error", {}).get("message", "Unknown error")
                    print(f"  ❌ [{request_id}] Long SQL {status}: {error_msg}")
                    return None
                else:
                    # Log progress every minute
                    if attempt % 6 == 0 and attempt > 0:
                        elapsed = (attempt + 1) * 10
                        print(f"  🔄 [{request_id}] Still running... ({elapsed}s elapsed)")
        
        print(f"  ❌ [{request_id}] Long SQL timed out after {timeout_minutes} minutes")
        return None
    
    # Failed immediately
    error_msg = result.get("status", {}).get("error", {}).get("message", "Unknown error")
    print(f"❌ [{request_id}] Long SQL failed immediately: {status}, error: {error_msg}")
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
