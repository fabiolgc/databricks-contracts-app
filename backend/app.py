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
# Helper Functions
# ============================================================================

def sanitize_table_name(table_name: str) -> str:
    """
    Remove _raw and _chunks suffixes from table name if present.
    This prevents duplicate suffixes like contracts_raw_raw.
    """
    if not table_name:
        return table_name
    # Remove suffixes in order (handle cases like contracts_raw_chunks)
    if table_name.endswith("_chunks"):
        table_name = table_name[:-7]
    if table_name.endswith("_raw"):
        table_name = table_name[:-4]
    return table_name

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

class DeleteDocumentsRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentIds: List[str]  # List of document IDs to delete, or empty for all
    deleteFromVolume: bool = False  # Also delete PDF files from volume

class ChunkingPreviewRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentIds: List[str]  # IDs of documents to preview (max 3)
    strategy: str  # fixed_size, recursive, by_sentence, by_separator, by_page, semantic
    chunkSize: int = 1000
    chunkOverlap: int = 200
    separatorType: str = "paragraph"  # For by_separator: paragraph, line, sentence, custom
    customSeparator: str = ""  # For custom separator

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


def chunk_by_separator(text: str, chunk_size: int, separator_type: str = "paragraph", custom_separator: str = "") -> tuple[List[str], List[str]]:
    """
    Divide text by custom separators with fallback chain.
    Returns (chunks, separators_used) tuple.
    """
    # Define separator hierarchy for fallback
    SEPARATORS = {
        "paragraph": "\n\n",
        "line": "\n",
        "sentence": ". ",
        "space": " "
    }
    
    # Determine primary separator
    if separator_type == "custom" and custom_separator:
        # Handle escape sequences
        primary_sep = custom_separator.replace("\\n\\n", "\n\n").replace("\\n", "\n").replace("\\t", "\t")
    else:
        primary_sep = SEPARATORS.get(separator_type, "\n\n")
    
    # Fallback order
    fallback_order = ["paragraph", "line", "sentence", "space"]
    separators_tried = []
    
    # Try primary separator first
    if primary_sep in text:
        parts = text.split(primary_sep)
        parts = [p.strip() for p in parts if p.strip()]
        if len(parts) > 1:
            # Success with primary separator
            chunks = []
            sep_name = separator_type if separator_type != "custom" else f"custom ({custom_separator})"
            separators_tried.append(sep_name)
            
            # Apply max size constraint
            for part in parts:
                if len(part) <= chunk_size:
                    chunks.append(part)
                else:
                    # Part too large, subdivide by next separator or fixed size
                    sub_chunks = chunk_by_fixed_size(part, chunk_size, 0)
                    chunks.extend(sub_chunks)
            
            return chunks, separators_tried
    
    # Fallback chain
    sep_name = separator_type if separator_type != "custom" else f"custom ({custom_separator})"
    separators_tried.append(f"{sep_name} (não encontrado)")
    
    for fallback_type in fallback_order:
        fallback_sep = SEPARATORS[fallback_type]
        if fallback_sep in text and fallback_sep != primary_sep:
            parts = text.split(fallback_sep)
            parts = [p.strip() for p in parts if p.strip()]
            if len(parts) > 1:
                separators_tried.append(f"{fallback_type} (fallback)")
                
                chunks = []
                for part in parts:
                    if len(part) <= chunk_size:
                        chunks.append(part)
                    else:
                        sub_chunks = chunk_by_fixed_size(part, chunk_size, 0)
                        chunks.extend(sub_chunks)
                
                return chunks, separators_tried
            else:
                separators_tried.append(f"{fallback_type} (não encontrado)")
    
    # Last resort: fixed size
    separators_tried.append("tamanho fixo (fallback final)")
    return chunk_by_fixed_size(text, chunk_size, 0), separators_tried


def apply_chunking(text: str, strategy: str, chunk_size: int = 1000, overlap: int = 200, 
                   separator_type: str = "paragraph", custom_separator: str = "") -> List[str]:
    """Apply chunking strategy to text"""
    if not text or not text.strip():
        return []
    
    if strategy == 'fixed_size':
        return chunk_by_fixed_size(text, chunk_size, overlap)
    elif strategy == 'recursive':
        return chunk_by_recursive(text, chunk_size, overlap)
    elif strategy == 'by_sentence':
        return chunk_by_sentence(text, chunk_size, overlap)
    elif strategy == 'by_separator':
        chunks, _ = chunk_by_separator(text, chunk_size, separator_type, custom_separator)
        return chunks
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
        table_name = sanitize_table_name(table_config.get("tableName", ""))
        
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
    table_name = sanitize_table_name(request.get("tableName", ""))
    
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
    
    # Build full table name - use _raw suffix (sanitize to prevent double suffix)
    table_name = sanitize_table_name(request.tableName)
    raw_table = f"{request.catalog}.{request.schema_name}.{table_name}_raw"
    
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
    
    table_name = sanitize_table_name(request.tableName)
    raw_table = f"{request.catalog}.{request.schema_name}.{table_name}_raw"
    
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


@app.post("/api/raw-documents/delete")
async def delete_documents(
    request: DeleteDocumentsRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Delete documents from _raw and _chunks tables.
    If documentIds is empty, deletes ALL documents.
    Optionally also deletes PDF files from volume.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🗑️ [{request_id}] Delete documents at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    table_name = sanitize_table_name(request.tableName)
    raw_table = f"{request.catalog}.{request.schema_name}.{table_name}_raw"
    chunks_table = f"{request.catalog}.{request.schema_name}.{table_name}_chunks"
    
    document_ids = request.documentIds
    delete_all = len(document_ids) == 0
    
    print(f"📋 [{request_id}] Raw table: {raw_table}")
    print(f"📋 [{request_id}] Chunks table: {chunks_table}")
    print(f"📋 [{request_id}] Delete all: {delete_all}")
    print(f"📋 [{request_id}] Document IDs: {len(document_ids) if document_ids else 'ALL'}")
    print(f"📋 [{request_id}] Delete from volume: {request.deleteFromVolume}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        deleted_raw = 0
        deleted_chunks = 0
        deleted_files = []
        errors = []
        
        # If deleting all, we need to get file names first (for volume deletion)
        file_names_to_delete = []
        if request.deleteFromVolume:
            if delete_all:
                # Get all file names
                get_files_sql = f"SELECT file_name FROM {raw_table}"
            else:
                ids_str = ", ".join([f"'{id}'" for id in document_ids])
                get_files_sql = f"SELECT file_name FROM {raw_table} WHERE id IN ({ids_str})"
            
            try:
                files_result = await execute_sql(config, warehouse_id, get_files_sql, request_id)
                if files_result and files_result.get("data_array"):
                    file_names_to_delete = [row[0] for row in files_result["data_array"] if row[0]]
                print(f"📁 [{request_id}] Files to delete from volume: {len(file_names_to_delete)}")
            except Exception as e:
                print(f"⚠️ [{request_id}] Could not get file names: {str(e)}")
        
        # Delete from _chunks table first (referential integrity)
        print(f"\n🗑️ [{request_id}] Deleting from chunks table...")
        try:
            if delete_all:
                delete_chunks_sql = f"DELETE FROM {chunks_table}"
            else:
                ids_str = ", ".join([f"'{id}'" for id in document_ids])
                delete_chunks_sql = f"DELETE FROM {chunks_table} WHERE document_id IN ({ids_str})"
            
            await execute_sql(config, warehouse_id, delete_chunks_sql, request_id)
            
            # Get count of remaining (to calculate deleted)
            count_result = await execute_sql(config, warehouse_id, f"SELECT COUNT(*) FROM {chunks_table}", request_id)
            remaining_chunks = int(count_result["data_array"][0][0]) if count_result and count_result.get("data_array") else 0
            print(f"✅ [{request_id}] Chunks table cleaned, {remaining_chunks} records remaining")
            deleted_chunks = -1  # Indicates success but unknown count
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" not in error_str:
                print(f"⚠️ [{request_id}] Error deleting chunks: {error_str}")
                errors.append(f"Chunks: {error_str}")
            else:
                print(f"ℹ️ [{request_id}] Chunks table does not exist (OK)")
        
        # Delete from _raw table
        print(f"\n🗑️ [{request_id}] Deleting from raw table...")
        try:
            # Get count before
            count_before = await execute_sql(config, warehouse_id, f"SELECT COUNT(*) FROM {raw_table}", request_id)
            before_count = int(count_before["data_array"][0][0]) if count_before and count_before.get("data_array") else 0
            
            if delete_all:
                delete_raw_sql = f"DELETE FROM {raw_table}"
            else:
                ids_str = ", ".join([f"'{id}'" for id in document_ids])
                delete_raw_sql = f"DELETE FROM {raw_table} WHERE id IN ({ids_str})"
            
            await execute_sql(config, warehouse_id, delete_raw_sql, request_id)
            
            # Get count after
            count_after = await execute_sql(config, warehouse_id, f"SELECT COUNT(*) FROM {raw_table}", request_id)
            after_count = int(count_after["data_array"][0][0]) if count_after and count_after.get("data_array") else 0
            
            deleted_raw = before_count - after_count
            print(f"✅ [{request_id}] Deleted {deleted_raw} records from raw table")
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" not in error_str:
                print(f"❌ [{request_id}] Error deleting from raw table: {error_str}")
                errors.append(f"Raw: {error_str}")
            else:
                print(f"⚠️ [{request_id}] Raw table does not exist")
                errors.append("Raw table not found")
        
        # Delete files from volume (if requested)
        if request.deleteFromVolume and file_names_to_delete:
            print(f"\n📁 [{request_id}] Deleting {len(file_names_to_delete)} files from volume...")
            volume_path = get_volume_base_path(config)
            
            async with httpx.AsyncClient(timeout=60.0) as client:
                for file_name in file_names_to_delete:
                    file_path = f"{volume_path}/{file_name}"
                    url = f"https://{config['host']}/api/2.0/fs/files{file_path}"
                    
                    try:
                        response = await client.delete(
                            url,
                            headers={"Authorization": f"Bearer {config['token']}"}
                        )
                        
                        if response.status_code in [200, 204, 404]:
                            deleted_files.append(file_name)
                            print(f"  ✅ Deleted: {file_name}")
                        else:
                            print(f"  ⚠️ Could not delete: {file_name} (HTTP {response.status_code})")
                    except Exception as e:
                        print(f"  ❌ Error deleting {file_name}: {str(e)}")
            
            print(f"✅ [{request_id}] Deleted {len(deleted_files)} files from volume")
        
        print(f"\n{'=' * 80}")
        print(f"✅ [{request_id}] Deletion complete!")
        print(f"  - Raw records deleted: {deleted_raw}")
        print(f"  - Chunks deleted: {'Yes' if deleted_chunks != 0 else 'No'}")
        print(f"  - Volume files deleted: {len(deleted_files)}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": len(errors) == 0,
            "deletedRaw": deleted_raw,
            "deletedChunks": deleted_chunks != 0,
            "deletedFiles": deleted_files,
            "deletedFilesCount": len(deleted_files),
            "errors": errors if errors else None
        }
        
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
    
    table_name = sanitize_table_name(request.tableName)
    raw_table = f"{request.catalog}.{request.schema_name}.{table_name}_raw"
    
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
                    request.chunkOverlap,
                    request.separatorType,
                    request.customSeparator
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
        table_name = sanitize_table_name(table_config.get("tableName", ""))
        
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
        
        # Step 2: DROP existing chunks table and recreate
        # This ensures only chunks from selected documents will exist
        print(f"\n🗑️ [{request_id}] Dropping existing chunks table: {chunks_table}")
        try:
            await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {chunks_table}", request_id)
            print(f"✅ [{request_id}] Chunks table dropped")
        except Exception as e:
            print(f"⚠️ [{request_id}] Could not drop chunks table: {str(e)}")
        
        # Step 3: Create fresh chunks table
        create_chunks_sql = f"""
        CREATE TABLE {chunks_table} (
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
        print(f"\n📊 [{request_id}] Creating fresh chunks table: {chunks_table}")
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
        table_name = sanitize_table_name(table_config.get("tableName", ""))
        
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        chunk_size = params.get("chunkSize", 1000)
        chunk_overlap = params.get("chunkOverlap", 200)
        
        # Note: Chunks table was already dropped and recreated in init_processing
        # No need to delete individual file chunks here
        
        # Step 1: Get text from _raw table (already extracted in Module 1)
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
        separator_type = params.get("separatorType", "paragraph")
        custom_separator = params.get("customSeparator", "")
        
        print(f"\n✂️ [{request_id}] Creating chunks with '{strategy}' strategy...")
        if strategy == "by_separator":
            print(f"  Separator type: {separator_type}, Custom: '{custom_separator}'")
        
        chunks = create_chunks(raw_text, strategy, chunk_size, chunk_overlap, separator_type, custom_separator)
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


# ============================================================================
# Volume Management API (Module 1)
# ============================================================================

@app.get("/api/volume/files")
async def list_volume_files(
    offset: int = 0,
    limit: int = 10,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """List PDF files from Unity Catalog Volume with pagination"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📁 [{request_id}] List volume files at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        volume_path = get_volume_base_path(config)
        
        print(f"📁 [{request_id}] Listing files in: {volume_path}")
        print(f"📋 [{request_id}] Offset: {offset}, Limit: {limit}")
        
        url = f"https://{config['host']}/api/2.0/fs/directories{volume_path}"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {config['token']}"}
            )
        
        if response.status_code == 404:
            print(f"⚠️ [{request_id}] Volume not found or empty")
            return {
                "success": True,
                "files": [],
                "total": 0,
                "offset": offset,
                "limit": limit,
                "hasMore": False,
                "volumePath": volume_path
            }
        
        if response.status_code != 200:
            print(f"❌ [{request_id}] Error listing files: {response.status_code}")
            raise HTTPException(status_code=response.status_code, detail="Failed to list files")
        
        data = response.json()
        all_files = []
        
        for item in data.get("contents", []):
            if item.get("is_directory", False):
                continue
            
            name = item.get("name", "")
            if name.lower().endswith(".pdf"):
                all_files.append({
                    "name": name,
                    "path": item.get("path", ""),
                    "size": item.get("file_size", 0),
                    "lastModified": item.get("modification_time", "")
                })
        
        # Sort by name
        all_files.sort(key=lambda x: x["name"].lower())
        
        # Apply pagination
        total = len(all_files)
        paginated_files = all_files[offset:offset + limit]
        
        print(f"✅ [{request_id}] Found {total} PDF files, returning {len(paginated_files)}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "files": paginated_files,
            "total": total,
            "offset": offset,
            "limit": limit,
            "hasMore": offset + len(paginated_files) < total,
            "volumePath": volume_path
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteVolumeFilesRequest(BaseModel):
    fileNames: List[str]  # List of file names to delete, or empty for all


class AppConfigRequest(BaseModel):
    """Configuration for app customization (colors, logo, etc.)"""
    primary_color: Optional[str] = None  # Databricks red
    text_color: Optional[str] = None  # Dark color for text
    success_color: Optional[str] = None  # Green for success states
    accent_color: Optional[str] = None  # Blue accent
    logo_url: Optional[str] = None  # Custom logo URL
    app_name: Optional[str] = None  # Custom app name


class AIConfigRequest(BaseModel):
    """Request for AI-powered config generation"""
    company_name: str  # Company name or website URL


@app.post("/api/volume/files/delete")
async def delete_volume_files(
    request: DeleteVolumeFilesRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Delete files from Unity Catalog Volume.
    If fileNames is empty, deletes ALL files.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🗑️ [{request_id}] Delete volume files at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        volume_path = get_volume_base_path(config)
        
        file_names = request.fileNames
        
        # If no specific files, get all files
        if not file_names:
            print(f"⚠️ [{request_id}] No files specified - will delete ALL files")
            
            url = f"https://{config['host']}/api/2.0/fs/directories{volume_path}"
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {config['token']}"}
                )
            
            if response.status_code == 200:
                data = response.json()
                for item in data.get("contents", []):
                    if not item.get("is_directory", False):
                        name = item.get("name", "")
                        if name.lower().endswith(".pdf"):
                            file_names.append(name)
        
        print(f"📋 [{request_id}] Files to delete: {len(file_names)}")
        
        deleted = []
        errors = []
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            for file_name in file_names:
                file_path = f"{volume_path}/{file_name}"
                url = f"https://{config['host']}/api/2.0/fs/files{file_path}"
                
                print(f"  🗑️ [{request_id}] Deleting: {file_name}")
                
                response = await client.delete(
                    url,
                    headers={"Authorization": f"Bearer {config['token']}"}
                )
                
                if response.status_code in [200, 204]:
                    deleted.append(file_name)
                    print(f"    ✅ Deleted: {file_name}")
                elif response.status_code == 404:
                    print(f"    ⚠️ Not found (already deleted?): {file_name}")
                    deleted.append(file_name)  # Count as success
                else:
                    error_msg = f"HTTP {response.status_code}"
                    errors.append({"fileName": file_name, "error": error_msg})
                    print(f"    ❌ Error: {file_name} - {error_msg}")
        
        print(f"\n✅ [{request_id}] Deletion complete: {len(deleted)} deleted, {len(errors)} errors")
        print(f"{'=' * 80}\n")
        
        return {
            "success": len(errors) == 0,
            "deleted": deleted,
            "deletedCount": len(deleted),
            "errors": errors if errors else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# App Configuration API
# ============================================================================

@app.get("/api/app-config")
async def get_app_config(
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get app configuration (colors, logo, etc.) from database"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"⚙️ [{request_id}] Get app config at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    # Default configuration
    default_config = {
        "primary_color": "#FF3621",  # Databricks red
        "text_color": "#1B1B1D",  # Dark text
        "success_color": "#00A972",  # Green
        "accent_color": "#1857B6",  # Blue
        "logo_url": "",  # Empty = use default
        "app_name": "Contracts App"
    }
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            print(f"⚠️ [{request_id}] No warehouse configured, returning defaults")
            return {"success": True, "config": default_config, "source": "default"}
        
        catalog = os.getenv("DATABRICKS_CATALOG", "")
        schema = os.getenv("DATABRICKS_SCHEMA", "")
        config_table = f"{catalog}.{schema}.app_config"
        
        # Try to read from table
        try:
            sql = f"SELECT config_key, config_value FROM {config_table}"
            result = await execute_sql(config, warehouse_id, sql, request_id)
            
            if result and result.get("data_array"):
                db_config = dict(default_config)  # Start with defaults
                for row in result["data_array"]:
                    key, value = row[0], row[1]
                    if key in db_config and value:
                        db_config[key] = value
                
                print(f"✅ [{request_id}] Loaded config from database")
                return {"success": True, "config": db_config, "source": "database"}
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                print(f"ℹ️ [{request_id}] Config table not found, returning defaults")
            else:
                print(f"⚠️ [{request_id}] Error reading config: {error_str}")
        
        return {"success": True, "config": default_config, "source": "default"}
        
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        return {"success": True, "config": default_config, "source": "default"}


@app.post("/api/app-config")
async def save_app_config(
    request: AppConfigRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Save app configuration to database - optimized version"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"💾 [{request_id}] Save app config at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        catalog = os.getenv("DATABRICKS_CATALOG", "")
        schema = os.getenv("DATABRICKS_SCHEMA", "")
        config_table = f"{catalog}.{schema}.app_config"
        
        # Build config dict from request (only non-None values)
        new_values = {}
        if request.primary_color is not None:
            new_values["primary_color"] = request.primary_color
        if request.text_color is not None:
            new_values["text_color"] = request.text_color
        if request.success_color is not None:
            new_values["success_color"] = request.success_color
        if request.accent_color is not None:
            new_values["accent_color"] = request.accent_color
        if request.logo_url is not None:
            new_values["logo_url"] = request.logo_url
        if request.app_name is not None:
            new_values["app_name"] = request.app_name
        
        if not new_values:
            print(f"ℹ️ [{request_id}] No values to save")
            return {"success": True, "message": "No changes to save"}
        
        # Step 1: Try to get existing values to compare (optimization: only save changed values)
        existing_values = {}
        try:
            select_sql = f"SELECT config_key, config_value FROM {config_table}"
            result = await execute_sql(config, warehouse_id, select_sql, request_id)
            if result and result.get("data_array"):
                for row in result["data_array"]:
                    existing_values[row[0]] = row[1]
            print(f"📖 [{request_id}] Loaded {len(existing_values)} existing config values")
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                print(f"ℹ️ [{request_id}] Table doesn't exist yet, will create on first save")
            else:
                print(f"⚠️ [{request_id}] Error reading existing config: {error_str}")
        
        # Step 2: Filter to only changed values
        changed_values = {}
        for key, new_value in new_values.items():
            existing_value = existing_values.get(key)
            if existing_value != new_value:
                changed_values[key] = new_value
                print(f"  🔄 [{request_id}] {key}: '{existing_value}' → '{new_value}'")
            else:
                print(f"  ✓ [{request_id}] {key}: unchanged")
        
        if not changed_values:
            print(f"✅ [{request_id}] No changes detected, skipping save")
            return {"success": True, "message": "No changes detected"}
        
        print(f"📝 [{request_id}] Saving {len(changed_values)} changed value(s)")
        
        # Step 3: Build VALUES clause for MERGE
        values_rows = []
        for key, value in changed_values.items():
            escaped_value = value.replace("'", "''") if value else ""
            values_rows.append(f"('{key}', '{escaped_value}')")
        
        values_clause = ", ".join(values_rows)
        merge_sql = f"""
        MERGE INTO {config_table} AS target
        USING (
            SELECT config_key, config_value 
            FROM VALUES {values_clause} AS source(config_key, config_value)
        ) AS source
        ON target.config_key = source.config_key
        WHEN MATCHED THEN UPDATE SET 
            config_value = source.config_value,
            updated_at = current_timestamp()
        WHEN NOT MATCHED THEN INSERT (config_key, config_value, updated_at)
            VALUES (source.config_key, source.config_value, current_timestamp())
        """
        
        # Step 4: Try MERGE first, create table only if it doesn't exist
        try:
            await execute_sql(config, warehouse_id, merge_sql, request_id)
            print(f"✅ [{request_id}] Config saved successfully")
        except Exception as e:
            error_str = str(e)
            # Check for TABLE_OR_VIEW_NOT_FOUND error
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                print(f"📊 [{request_id}] Table doesn't exist, creating...")
                
                # Create the table
                create_sql = f"""
                CREATE TABLE {config_table} (
                    config_key STRING,
                    config_value STRING,
                    updated_at TIMESTAMP
                )
                USING DELTA
                """
                await execute_sql(config, warehouse_id, create_sql, request_id)
                print(f"✅ [{request_id}] Table created: {config_table}")
                
                # Retry the MERGE
                await execute_sql(config, warehouse_id, merge_sql, request_id)
                print(f"✅ [{request_id}] Config saved successfully (after table creation)")
            else:
                # Re-raise other errors
                raise
        
        return {"success": True, "message": f"Saved {len(changed_values)} configuration(s)"}
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ai-config")
async def generate_ai_config(
    request: AIConfigRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Use AI to generate app configuration based on company branding.
    Uses Databricks ai_gen() function to analyze company identity and suggest colors.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🤖 [{request_id}] AI Config generation at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    print(f"📝 Company: {request.company_name}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Escape the company name for SQL
        company_escaped = request.company_name.replace("'", "''")
        
        # Build the AI prompt for extracting brand colors with full palette
        ai_prompt = f"""You are a brand identity expert and UI/UX designer. Analyze the visual identity of the company or website "{company_escaped}".

Your job:
1) Produce a professional UI color palette in HEX (primary + derived subtle tints).
2) Provide a reliable, publicly accessible logo_url that is a direct link to an image file (PNG, SVG, JPG, or WebP).

IMPORTANT LIMITATION:
You may not have reliable real-time browsing access. Do NOT hallucinate specific logo file URLs from private knowledge. Prefer deterministic, highly reliable URL patterns.

LOGO URL STRATEGY (minimize broken URLs):
A) First, infer the company's most likely official domain (e.g., "databricks.com") from the company_name.
   - If multiple companies match, choose the most likely and proceed only if reasonably confident.
B) Preferred logo_url sources (in order):
   1) A well-known, stable public logo URL (e.g., Wikimedia/Wikipedia media file) ONLY if you are highly confident it is correct and publicly accessible.
   2) The company's official site ONLY if you are highly confident about a standard public logo path AND it is a direct image file URL (ends with .svg/.png/.jpg/.webp). Do NOT guess obscure paths.
   3) Reliable fallback: Google favicon service (returns a direct image and is usually accessible):
      - https://www.google.com/s2/favicons?domain=DOMAIN&sz=256
      Use this when you can infer a plausible DOMAIN with moderate confidence, even if you cannot confirm the exact logo file.
C) If you cannot infer a plausible domain with moderate confidence, set logo_url to "" (empty string).

COLOR PALETTE REQUIREMENTS:
PRIMARY COLORS:
1. primary_color: The main brand color (buttons, links, CTAs)
2. text_color: Color for headings and important text (usually near-black / dark for readability)
3. success_color: Color for success states (usually green tones)
4. accent_color: Secondary/accent color for highlights and information

DERIVED COLORS (lighter versions for backgrounds and UI elements):
5. primary_light: Very light tint of primary for backgrounds (~95% lightness, like Tailwind *-50)
6. primary_lighter: Light tint of primary for hovers (~90% lightness, like Tailwind *-100)
7. success_light: Very light tint of success for backgrounds (~95% lightness)
8. success_lighter: Light tint of success for UI elements (~90% lightness)
9. accent_light: Very light tint of accent for info backgrounds (~95% lightness)
10. accent_lighter: Light tint of accent for info elements (~90% lightness)
11. warning_color: Warning/caution color (amber/yellow tones for alerts)
12. warning_light: Very light tint of warning (for warning backgrounds, like Tailwind amber-50)

ALSO SUGGEST:
13. app_name: A short name for the application (2-4 words max)
14. logo_url: Must be a direct image URL as described above.

QUALITY & CONSISTENCY RULES:
- All colors must be valid HEX in the form "#RRGGBB".
- text_color must be readable on white backgrounds (prefer very dark gray/black tones).
- Derived light colors must be subtle background-friendly tints (not saturated).
- If you do not know the company brand colors, make educated, professional choices based on likely industry and typical brand patterns.
- For logo_url: NEVER output Clearbit logo URLs. Prefer the favicon fallback if unsure.

OUTPUT FORMAT:
Return ONLY a valid JSON object with ALL these exact keys, no additional text:
{{"primary_color": "#XXXXXX", "text_color": "#XXXXXX", "success_color": "#XXXXXX", "accent_color": "#XXXXXX", "primary_light": "#XXXXXX", "primary_lighter": "#XXXXXX", "success_light": "#XXXXXX", "success_lighter": "#XXXXXX", "accent_light": "#XXXXXX", "accent_lighter": "#XXXXXX", "warning_color": "#XXXXXX", "warning_light": "#XXXXXX", "app_name": "Company App", "logo_url": "https://www.google.com/s2/favicons?domain=example.com&sz=256"}}"""
        
        # Call ai_gen function
        ai_sql = f"SELECT ai_gen('{ai_prompt.replace(chr(39), chr(39)+chr(39))}')"
        
        print(f"🤖 [{request_id}] Calling ai_gen()...")
        result = await execute_sql_long(config, warehouse_id, ai_sql, request_id, timeout_minutes=2)
        
        if not result or not result.get("data_array") or not result["data_array"][0]:
            print(f"❌ [{request_id}] No response from ai_gen")
            raise HTTPException(status_code=500, detail="AI did not return a response")
        
        ai_response = result["data_array"][0][0]
        print(f"📤 [{request_id}] AI Response: {ai_response[:200]}...")
        
        # Parse JSON from response
        import json
        try:
            # Try to extract JSON from the response (AI might add extra text)
            json_start = ai_response.find('{')
            json_end = ai_response.rfind('}') + 1
            if json_start >= 0 and json_end > json_start:
                json_str = ai_response[json_start:json_end]
                config_data = json.loads(json_str)
            else:
                raise ValueError("No JSON found in response")
            
            # Validate required base fields
            required_fields = ["primary_color", "text_color", "success_color", "accent_color"]
            for field in required_fields:
                if field not in config_data:
                    raise ValueError(f"Missing field: {field}")
                # Validate hex color format
                color = config_data[field]
                if not color.startswith('#') or len(color) != 7:
                    raise ValueError(f"Invalid color format for {field}: {color}")
            
            # Helper function to generate light tint from a color
            def hex_to_rgb(hex_color):
                hex_color = hex_color.lstrip('#')
                return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
            
            def rgb_to_hex(rgb):
                return '#{:02x}{:02x}{:02x}'.format(*rgb)
            
            def lighten_color(hex_color, factor):
                """Create a lighter version of a color (factor 0.95 = very light, 0.9 = light)"""
                r, g, b = hex_to_rgb(hex_color)
                # Mix with white
                new_r = int(r + (255 - r) * factor)
                new_g = int(g + (255 - g) * factor)
                new_b = int(b + (255 - b) * factor)
                return rgb_to_hex((new_r, new_g, new_b))
            
            # Generate derived colors if not provided by AI
            derived_colors = {
                'primary_light': ('primary_color', 0.92),
                'primary_lighter': ('primary_color', 0.85),
                'success_light': ('success_color', 0.92),
                'success_lighter': ('success_color', 0.85),
                'accent_light': ('accent_color', 0.92),
                'accent_lighter': ('accent_color', 0.85),
            }
            
            for derived_key, (base_key, factor) in derived_colors.items():
                if derived_key not in config_data or not config_data[derived_key].startswith('#'):
                    config_data[derived_key] = lighten_color(config_data[base_key], factor)
                    print(f"   Generated {derived_key} from {base_key}")
            
            # Add warning colors if not provided
            if 'warning_color' not in config_data or not config_data['warning_color'].startswith('#'):
                config_data['warning_color'] = '#F59E0B'  # Amber-500
            if 'warning_light' not in config_data or not config_data['warning_light'].startswith('#'):
                config_data['warning_light'] = lighten_color(config_data['warning_color'], 0.92)
            
            print(f"✅ [{request_id}] Successfully parsed config with full palette:")
            for key, value in config_data.items():
                print(f"   {key}: {value}")
            
            return {
                "success": True,
                "config": config_data,
                "company": request.company_name
            }
            
        except (json.JSONDecodeError, ValueError) as e:
            print(f"⚠️ [{request_id}] Failed to parse AI response: {str(e)}")
            print(f"   Raw response: {ai_response}")
            
            # Return a fallback with the raw response for debugging
            return {
                "success": False,
                "error": f"Failed to parse AI response: {str(e)}",
                "raw_response": ai_response
            }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


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
        table_name = sanitize_table_name(table_config.get("tableName", ""))
        
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


def create_chunks(text: str, strategy: str, chunk_size: int, chunk_overlap: int,
                  separator_type: str = "paragraph", custom_separator: str = "") -> List[str]:
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
    
    elif strategy == "by_separator":
        chunks, separators_used = chunk_by_separator(text, chunk_size, separator_type, custom_separator)
        print(f"  Separators used: {' → '.join(separators_used)}")
        return chunks
    
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
