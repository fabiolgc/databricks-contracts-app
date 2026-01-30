"""
FastAPI backend for Databricks Contracts App
Serves static Next.js files and provides API endpoints for:
- Module 1: File upload to Unity Catalog Volumes
- Module 2: Data preparation, chunking, and Delta table management
"""

import os
import re
import uuid
import json
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
# Background Job Storage for Auto Process (avoids gateway timeouts)
# ============================================================================
auto_process_jobs: Dict[str, Dict[str, Any]] = {}

# ============================================================================
# Helper Functions
# ============================================================================

def sanitize_table_name(table_name: str) -> str:
    """
    Remove _parsed and _chunks suffixes from table name if present.
    This prevents duplicate suffixes like contracts_parsed_parsed.
    """
    if not table_name:
        return table_name
    # Remove suffixes in order (handle cases like contracts_parsed_chunks)
    if table_name.endswith("_chunks"):
        table_name = table_name[:-7]
    if table_name.endswith("_parsed"):
        table_name = table_name[:-7]
    # Also handle legacy _raw suffix for backwards compatibility
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
    tableName: str  # Base name like "contracts" - will append "_parsed"
    offset: int = 0
    limit: int = 10

class RawDocumentTextRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentId: str

class CheckFileExistsRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    fileName: str

class DeleteDocumentsRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentIds: List[str]  # List of document IDs to delete, or empty for all
    deleteFromVolume: bool = False  # Also delete PDF files from volume

class VectorSearchEndpointRequest(BaseModel):
    endpoint_name: str

class CreateVectorIndexRequest(BaseModel):
    tableConfig: Dict[str, str]  # catalog, schema, tableName
    endpoint_name: str
    embedding_model: str = "databricks-gte-large-en"
    sync_type: str = "TRIGGERED"  # TRIGGERED or CONTINUOUS

class ChunkingPreviewRequest(BaseModel):
    catalog: str
    schema_name: str
    tableName: str
    documentIds: List[str]  # IDs of documents to preview (max 3)
    strategy: str  # fixed_size, recursive, by_sentence, by_separator, semantic, hybrid_ai
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


def get_service_principal_config():
    """Get Databricks configuration using Service Principal only.
    Used for operations that don't have OAuth scopes available (e.g., vector search endpoints).
    """
    sp_token = os.getenv("DATABRICKS_CLIENT_SECRET") or os.getenv("DATABRICKS_TOKEN")
    
    config = {
        "host": os.getenv("DATABRICKS_SERVER_HOSTNAME") or os.getenv("DATABRICKS_HOST"),
        "token": sp_token,
        "catalog": os.getenv("DATABRICKS_CATALOG", "fabio_goncalves"),
        "schema": os.getenv("DATABRICKS_SCHEMA", "customer_cielo"),
        "volume": os.getenv("DATABRICKS_VOLUME", "pdf"),
        "auth_method": "Service Principal (forced)",
    }
    
    if not config["host"]:
        raise ValueError("DATABRICKS_SERVER_HOSTNAME or DATABRICKS_HOST is not configured")
    
    if not config["token"]:
        raise ValueError("Service Principal token (DATABRICKS_CLIENT_SECRET) not available")
    
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
    elif strategy == 'semantic' or strategy == 'hybrid_ai':
        # Both use recursive as base chunking - hybrid_ai adds AI metadata enrichment
        return chunk_by_recursive(text, chunk_size, overlap)
    else:
        return chunk_by_fixed_size(text, chunk_size, overlap)


async def extract_document_metadata_with_ai(
    config: dict,
    warehouse_id: str,
    text: str,
    file_name: str,
    request_id: str
) -> dict:
    """
    Extract document metadata using AI_GEN function.
    Returns structured metadata about document type, parties, key clauses, etc.
    """
    # Truncate text if too long (ai_gen has token limits)
    max_chars = 15000  # ~4000 tokens approximately
    text_sample = text[:max_chars] if len(text) > max_chars else text
    
    # Escape text for SQL
    escaped_text = text_sample.replace("'", "''").replace("\\", "\\\\")
    escaped_filename = file_name.replace("'", "''")
    
    ai_prompt = f"""Analise este documento e extraia metadados estruturados.

DOCUMENTO: {escaped_filename}
CONTEÚDO (amostra):
{escaped_text[:8000]}

EXTRAIA E RETORNE APENAS um JSON válido com:
{{
  "document_type": "tipo do documento (arquivo demo, contrato, NDA, acordo, aditivo, procuração, etc)",
  "language": "idioma principal (pt-BR, en-US, es, etc)",
  "parties": ["lista de partes envolvidas"],
  "subject": "assunto principal em 1-2 frases",
  "key_clauses": ["lista de cláusulas importantes identificadas"],
  "dates": {{"signature": "data assinatura se houver", "effective": "data vigência", "expiration": "data término"}},
  "summary": "resumo executivo em 2-3 frases",
  "keywords": ["palavras-chave relevantes para busca"]
}}

IMPORTANTE: Retorne APENAS o JSON, sem texto adicional."""

    # Escape prompt for SQL
    escaped_prompt = ai_prompt.replace("'", "''")
    
    sql = f"SELECT ai_gen('{escaped_prompt}') as metadata"
    
    try:
        print(f"🤖 [{request_id}] Extracting document metadata with AI...")
        result = await execute_sql_long(config, warehouse_id, sql, request_id, timeout_minutes=2)
        
        if result and result.get("data_array") and len(result["data_array"]) > 0:
            metadata_str = result["data_array"][0][0]
            
            # Try to parse as JSON
            try:
                # Clean up the response - sometimes AI adds markdown code blocks
                clean_str = metadata_str.strip()
                if clean_str.startswith("```json"):
                    clean_str = clean_str[7:]
                if clean_str.startswith("```"):
                    clean_str = clean_str[3:]
                if clean_str.endswith("```"):
                    clean_str = clean_str[:-3]
                clean_str = clean_str.strip()
                
                import json
                metadata = json.loads(clean_str)
                print(f"✅ [{request_id}] AI metadata extracted successfully")
                print(f"   Type: {metadata.get('document_type', 'N/A')}")
                print(f"   Subject: {metadata.get('subject', 'N/A')[:50] if metadata.get('subject') else 'N/A'}...")
                print(f"   Parties: {metadata.get('parties', [])}")
                print(f"   Keywords: {metadata.get('keywords', [])}")
                return metadata
            except json.JSONDecodeError as e:
                print(f"⚠️ [{request_id}] Could not parse AI metadata as JSON: {str(e)}")
                # Return raw string as fallback
                return {"raw_analysis": metadata_str, "parse_error": True}
        
        return {"error": "No response from AI"}
        
    except Exception as e:
        print(f"⚠️ [{request_id}] Error extracting AI metadata: {str(e)}")
        return {"error": str(e)}


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
    catalog = os.getenv("DATABRICKS_CATALOG", "")
    schema = os.getenv("DATABRICKS_SCHEMA", "")
    volume = os.getenv("DATABRICKS_VOLUME", "")
    host = os.getenv("DATABRICKS_SERVER_HOSTNAME", "")
    vs_endpoint = os.getenv("VECTOR_SEARCH_ENDPOINT", "one-env-shared-endpoint-12")
    
    print(f"[CONFIG] Returning config:")
    print(f"  - catalog: {catalog}")
    print(f"  - schema: {schema}")
    print(f"  - volume: {volume}")
    print(f"  - host: {host}")
    print(f"  - vectorSearchEndpoint: {vs_endpoint}")
    
    return {
        "catalog": catalog,
        "schema": schema,
        "volume": volume,
        "host": host,
        "vectorSearchEndpoint": vs_endpoint,
    }


# ============================================================================
# Vector Search API Routes
# ============================================================================

@app.post("/api/vector-search/endpoint/check")
async def check_vector_search_endpoint(
    request: VectorSearchEndpointRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Check if a Vector Search endpoint exists and get its status"""
    request_id = str(uuid.uuid4())[:8]
    endpoint_name = request.endpoint_name
    
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Check Vector Search endpoint: {endpoint_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        # Detailed logging for debugging
        print(f"📋 [{request_id}] Configuration:")
        print(f"  - Host: {host}")
        print(f"  - Auth method: {config.get('auth_method', 'unknown')}")
        print(f"  - Token present: {'Yes' if token else 'No'}")
        print(f"  - Token length: {len(token) if token else 0}")
        print(f"  - Token starts with: {token[:20]}..." if token and len(token) > 20 else f"  - Token: {token}")
        print(f"  - OBO token provided: {'Yes' if x_forwarded_access_token else 'No'}")
        
        url = f"https://{host}/api/2.0/vector-search/endpoints/{endpoint_name}"
        print(f"  - URL: {url}")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}"}
            )
            
            print(f"📡 [{request_id}] Response:")
            print(f"  - Status code: {response.status_code}")
            print(f"  - Headers: {dict(response.headers)}")
            
            if response.status_code == 200:
                data = response.json()
                status = data.get("endpoint_status", {}).get("state", "UNKNOWN")
                print(f"✅ [{request_id}] Endpoint exists with status: {status}")
                return {
                    "success": True,
                    "exists": True,
                    "status": status,
                    "endpoint": data
                }
            elif response.status_code == 404:
                print(f"ℹ️ [{request_id}] Endpoint does not exist")
                return {
                    "success": True,
                    "exists": False,
                    "status": "NOT_FOUND"
                }
            else:
                # Log detailed error information
                print(f"⚠️ [{request_id}] API returned status {response.status_code}")
                print(f"  - Response body: {response.text[:1000] if response.text else 'empty'}")
                
                # Try to parse error details
                error_detail = f"API returned status {response.status_code}"
                try:
                    error_json = response.json()
                    if "message" in error_json:
                        error_detail = f"{response.status_code}: {error_json['message']}"
                    elif "error" in error_json:
                        error_detail = f"{response.status_code}: {error_json['error']}"
                except:
                    pass
                
                return {
                    "success": False,
                    "error": error_detail,
                    "status_code": response.status_code,
                    "auth_method": config.get('auth_method', 'unknown')
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        import traceback
        print(f"  Traceback: {traceback.format_exc()}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/endpoint/create")
async def create_vector_search_endpoint(
    request: VectorSearchEndpointRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Create a new Vector Search endpoint"""
    request_id = str(uuid.uuid4())[:8]
    endpoint_name = request.endpoint_name
    
    print(f"\n{'=' * 80}")
    print(f"🚀 [{request_id}] Create Vector Search endpoint: {endpoint_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        url = f"https://{host}/api/2.0/vector-search/endpoints"
        
        payload = {
            "name": endpoint_name,
            "endpoint_type": "STANDARD"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"
                },
                json=payload
            )
            
            if response.status_code in [200, 201]:
                data = response.json()
                print(f"✅ [{request_id}] Endpoint creation initiated")
                return {
                    "success": True,
                    "message": "Endpoint creation initiated",
                    "endpoint": data
                }
            else:
                error_text = response.text
                print(f"⚠️ [{request_id}] API returned status {response.status_code}: {error_text}")
                return {
                    "success": False,
                    "error": f"Failed to create endpoint: {error_text}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/check")
async def check_vector_index(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Check if a Vector Index exists"""
    request_id = str(uuid.uuid4())[:8]
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Check Vector Index: {index_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        # URL encode the index name
        encoded_index_name = index_name.replace(".", "%2E")
        url = f"https://{host}/api/2.0/vector-search/indexes/{encoded_index_name}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}"}
            )
            
            if response.status_code == 200:
                data = response.json()
                status = data.get("status", {}).get("ready", False)
                index_status = data.get("status", {}).get("index_status", "UNKNOWN")
                current_endpoint = data.get("endpoint_name", "")
                print(f"✅ [{request_id}] Index exists, ready: {status}, status: {index_status}, endpoint: {current_endpoint}")
                return {
                    "success": True,
                    "exists": True,
                    "ready": status,
                    "index_status": index_status,
                    "endpoint_name": current_endpoint,
                    "index": data
                }
            elif response.status_code == 404:
                print(f"ℹ️ [{request_id}] Index does not exist")
                return {
                    "success": True,
                    "exists": False
                }
            else:
                print(f"⚠️ [{request_id}] API returned status {response.status_code}")
                return {
                    "success": False,
                    "error": f"API returned status {response.status_code}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/sync")
async def sync_vector_index(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Trigger a sync for an existing Vector Index"""
    request_id = str(uuid.uuid4())[:8]
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    print(f"\n{'=' * 80}")
    print(f"🔄 [{request_id}] Trigger Sync for Vector Index: {index_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        # URL encode the index name
        encoded_index_name = index_name.replace(".", "%2E")
        url = f"https://{host}/api/2.0/vector-search/indexes/{encoded_index_name}/sync"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"
                }
            )
            
            print(f"📡 [{request_id}] Sync response: {response.status_code}")
            
            if response.status_code in [200, 201, 202]:
                print(f"✅ [{request_id}] Sync triggered successfully")
                return {
                    "success": True,
                    "message": "Sync triggered",
                    "index_name": index_name
                }
            else:
                error_text = response.text
                print(f"⚠️ [{request_id}] Sync failed: {error_text}")
                return {
                    "success": False,
                    "error": f"Failed to trigger sync: {error_text}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/status")
async def get_vector_index_status(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get the current status of a Vector Index (for polling during sync)"""
    request_id = str(uuid.uuid4())[:8]
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        encoded_index_name = index_name.replace(".", "%2E")
        url = f"https://{host}/api/2.0/vector-search/indexes/{encoded_index_name}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}"}
            )
            
            if response.status_code == 200:
                data = response.json()
                status_obj = data.get("status", {})
                ready = status_obj.get("ready", False)
                index_status = status_obj.get("index_status", "UNKNOWN")
                message = status_obj.get("message", "")
                
                # Check delta_sync_index_spec for more details
                delta_sync = data.get("delta_sync_index_spec", {})
                pipeline_id = delta_sync.get("pipeline_id", "")
                
                print(f"📊 [{request_id}] Index status: ready={ready}, status={index_status}")
                
                return {
                    "success": True,
                    "ready": ready,
                    "index_status": index_status,
                    "message": message,
                    "pipeline_id": pipeline_id,
                    "index_name": index_name
                }
            else:
                return {
                    "success": False,
                    "error": f"Failed to get status: {response.status_code}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/create")
async def create_vector_index(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Create a new Vector Index using Delta Sync (async - returns immediately)"""
    request_id = str(uuid.uuid4())[:8]
    
    # Get timeout from env config (default 60s for API call, index creation is async)
    api_timeout = int(os.getenv("API_REQUEST_TIMEOUT", "60"))
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    
    source_table = f"{catalog}.{schema}.{table_name}_chunks"
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    endpoint_name = request.endpoint_name
    embedding_model = request.embedding_model
    sync_type = request.sync_type
    
    print(f"\n{'=' * 80}")
    print(f"🚀 [{request_id}] Create Vector Index (async)")
    print(f"   Index: {index_name}")
    print(f"   Source Table: {source_table}")
    print(f"   Endpoint: {endpoint_name}")
    print(f"   Embedding Model: {embedding_model}")
    print(f"   Sync Type: {sync_type}")
    print(f"   API Timeout: {api_timeout}s")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        url = f"https://{host}/api/2.0/vector-search/indexes"
        
        payload = {
            "name": index_name,
            "endpoint_name": endpoint_name,
            "primary_key": "id",
            "index_type": "DELTA_SYNC",
            "delta_sync_index_spec": {
                "source_table": source_table,
                "pipeline_type": sync_type,
                "embedding_source_columns": [
                    {
                        "name": "chunk_content",
                        "embedding_model_endpoint_name": embedding_model
                    }
                ]
            }
        }
        
        print(f"📤 [{request_id}] Payload: {json.dumps(payload, indent=2)}")
        
        async with httpx.AsyncClient(timeout=float(api_timeout)) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"
                },
                json=payload
            )
            
            if response.status_code in [200, 201]:
                data = response.json()
                print(f"✅ [{request_id}] Index creation initiated - use /status endpoint to poll")
                return {
                    "success": True,
                    "message": "Index creation initiated. Poll /status for completion.",
                    "index_name": index_name,
                    "index": data
                }
            else:
                error_text = response.text
                print(f"⚠️ [{request_id}] API returned status {response.status_code}: {error_text}")
                return {
                    "success": False,
                    "error": f"Failed to create index: {error_text}"
                }
                
    except httpx.TimeoutException:
        print(f"⏱️ [{request_id}] Timeout after {api_timeout}s - index may still be creating")
        return {
            "success": True,
            "message": "Request sent but timed out. Index may still be creating - poll /status.",
            "index_name": index_name,
            "timeout": True
        }
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/status")
async def get_vector_index_status(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get the status of a Vector Index"""
    request_id = str(uuid.uuid4())[:8]
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    print(f"\n{'=' * 80}")
    print(f"📊 [{request_id}] Getting status for Vector Index: {index_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        # URL encode the index name
        encoded_index_name = index_name.replace(".", "%2E")
        url = f"https://{host}/api/2.0/vector-search/indexes/{encoded_index_name}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                status = data.get("status", {})
                index_status = status.get("ready", False)
                message = status.get("message", "")
                detailed_state = status.get("detailed_state", "")
                indexed_row_count = status.get("indexed_row_count", 0)
                
                print(f"📊 [{request_id}] Index status: ready={index_status}, state={detailed_state}, rows={indexed_row_count}")
                
                return {
                    "success": True,
                    "index_name": index_name,
                    "ready": index_status,
                    "detailed_state": detailed_state,
                    "message": message,
                    "indexed_row_count": indexed_row_count
                }
            elif response.status_code == 404:
                print(f"❌ [{request_id}] Index not found")
                return {
                    "success": False,
                    "error": "Index not found",
                    "index_name": index_name
                }
            else:
                error_text = response.text
                print(f"⚠️ [{request_id}] Status check failed: {error_text}")
                return {
                    "success": False,
                    "error": f"Failed to get status: {error_text}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


@app.post("/api/vector-search/index/delete")
async def delete_vector_index(
    request: CreateVectorIndexRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Delete an existing Vector Index"""
    request_id = str(uuid.uuid4())[:8]
    
    catalog = request.tableConfig.get("catalog", "")
    schema = request.tableConfig.get("schema", "")
    table_name = request.tableConfig.get("tableName", "")
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    print(f"\n{'=' * 80}")
    print(f"🗑️ [{request_id}] Delete Vector Index: {index_name}")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        host = config["host"]
        token = config["token"]
        
        # URL encode the index name
        encoded_index_name = index_name.replace(".", "%2E")
        url = f"https://{host}/api/2.0/vector-search/indexes/{encoded_index_name}"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.delete(
                url,
                headers={"Authorization": f"Bearer {token}"}
            )
            
            print(f"📡 [{request_id}] Delete response: {response.status_code}")
            
            if response.status_code in [200, 204]:
                print(f"✅ [{request_id}] Index deleted successfully")
                return {
                    "success": True,
                    "message": f"Index {index_name} deleted",
                    "index_name": index_name
                }
            elif response.status_code == 404:
                print(f"ℹ️ [{request_id}] Index does not exist")
                return {
                    "success": True,
                    "message": "Index does not exist",
                    "index_name": index_name
                }
            else:
                error_text = response.text
                print(f"⚠️ [{request_id}] Delete failed: {error_text}")
                return {
                    "success": False,
                    "error": f"Failed to delete index: {error_text}"
                }
                
    except Exception as e:
        print(f"💥 [{request_id}] Error: {str(e)}")
        return {"success": False, "error": str(e)}


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
        
        # Use _parsed suffix for parsed documents table (Module 1)
        parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
        volume_path = get_volume_base_path(config)
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        print(f"📋 [{request_id}] Configuration:")
        print(f"  - Table: {parsed_table}")
        print(f"  - Volume: {volume_path}")
        print(f"  - File: {file_name}")
        print(f"  - Mode: {mode}")
        
        # Step 1: Create parsed documents table if not exists
        create_table_sql = f"""
        CREATE TABLE IF NOT EXISTS {parsed_table} (
            id STRING,
            file_name STRING,
            file_path STRING,
            parsed_text STRING,
            text_length INT,
            page_count INT,
            created_at TIMESTAMP,
            updated_at TIMESTAMP,
            metadata STRING
        )
        USING DELTA
        """
        print(f"\n📊 [{request_id}] Ensuring parsed table exists...")
        await execute_sql(config, warehouse_id, create_table_sql, request_id)
        
        # Step 2: Check if document already exists
        escaped_file_name = file_name.replace("'", "''")
        check_sql = f"SELECT id FROM {parsed_table} WHERE file_name = '{escaped_file_name}'"
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
        # Based on Databricks official documentation example
        print(f"\n🤖 [{request_id}] Extracting text with ai_parse_document...")
        
        extract_sql = f"""
        WITH parsed_documents AS (
            SELECT
                path,
                ai_parse_document(content) AS parsed
            FROM READ_FILES('{volume_path}', format => 'binaryFile')
            WHERE path LIKE '%/{escaped_file_name}'
            LIMIT 1
        ),
        parsed_text AS (
            SELECT
                path,
                parsed,
                concat_ws(
                    '\\n\\n',
                    transform(
                        try_cast(parsed:document:elements AS ARRAY<VARIANT>),
                        element -> try_cast(element:content AS STRING)
                    )
                ) AS text,
                size(try_cast(parsed:document:pages AS ARRAY<VARIANT>)) AS num_pages
            FROM parsed_documents
            WHERE try_cast(parsed:error_status AS STRING) IS NULL
        )
        SELECT
            path,
            text,
            num_pages,
            to_json(parsed:metadata) AS doc_metadata
        FROM parsed_text
        WHERE text IS NOT NULL
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
        file_path = row[0] if row[0] else ""
        raw_text = row[1] if row[1] else ""
        page_count = int(row[2]) if row[2] else 0
        doc_metadata = row[3] if len(row) > 3 and row[3] else "{}"
        
        print(f"✅ [{request_id}] Extracted {len(raw_text)} characters from {page_count} pages")
        if doc_metadata and len(doc_metadata) > 200:
            print(f"   Metadata: {doc_metadata[:200]}...")
        else:
            print(f"   Metadata: {doc_metadata}")
        
        if not raw_text.strip():
            return {
                "success": False,
                "fileName": file_name,
                "error": "Extracted text is empty"
            }
        
        # Step 4: Save to parsed table (INSERT or UPDATE)
        print(f"\n💾 [{request_id}] Saving to parsed table...")
        
        escaped_parsed_text = raw_text.replace("'", "''").replace("\\", "\\\\")
        escaped_path = file_path.replace("'", "''")
        
        # Escape metadata for SQL
        escaped_metadata = doc_metadata.replace("'", "''") if doc_metadata else "{}"
        
        if existing_doc_id:
            # Update existing document
            update_sql = f"""
            UPDATE {parsed_table}
            SET parsed_text = '{escaped_parsed_text}',
                text_length = {len(raw_text)},
                page_count = {page_count},
                metadata = '{escaped_metadata}',
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
            INSERT INTO {parsed_table}
            (id, file_name, file_path, parsed_text, text_length, page_count, created_at, updated_at, metadata)
            VALUES (
                '{doc_id}',
                '{escaped_file_name}',
                '{escaped_path}',
                '{escaped_parsed_text}',
                {len(raw_text)},
                {page_count},
                current_timestamp(),
                current_timestamp(),
                '{escaped_metadata}'
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
    
    # Table names: _parsed (from Module 1) and _chunks (Module 2)
    parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
    chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
    
    print(f"📋 [{request_id}] Checking tables:")
    print(f"  - Parsed: {parsed_table}")
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
                    "parsedTable": parsed_table,
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
            "parsedTable": parsed_table,
            "chunksTable": chunks_table
        }
            
    except Exception as e:
        error_str = str(e)
        print(f"💥 [{request_id}] Exception: {error_str}")
        if "TABLE_OR_VIEW_NOT_FOUND" in error_str or "SCHEMA_NOT_FOUND" in error_str:
            return {
                "exists": False, 
                "recordCount": 0,
                "parsedTable": parsed_table,
                "chunksTable": chunks_table
            }
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Module 2: Parsed Documents API (for chunking preparation)
# ============================================================================

@app.post("/api/parsed-documents")
async def get_parsed_documents(
    request: RawDocumentsRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get documents from the _parsed table with pagination"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📄 [{request_id}] Get parsed documents at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    # Build full table name - use _parsed suffix (sanitize to prevent double suffix)
    table_name = sanitize_table_name(request.tableName)
    parsed_table = f"{request.catalog}.{request.schema_name}.{table_name}_parsed"
    
    print(f"📋 [{request_id}] Table: {parsed_table}")
    print(f"📋 [{request_id}] Offset: {request.offset}, Limit: {request.limit}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Get total count
        count_sql = f"SELECT COUNT(*) as total FROM {parsed_table}"
        count_result = await execute_sql(config, warehouse_id, count_sql, request_id)
        
        total_count = 0
        if count_result and count_result.get("data_array"):
            total_count = int(count_result["data_array"][0][0])
        
        print(f"📊 [{request_id}] Total records: {total_count}")
        
        # Get documents (without parsed_text for list view - it can be large)
        docs_sql = f"""
        SELECT 
            id,
            file_name,
            file_path,
            text_length,
            page_count,
            created_at
        FROM {parsed_table}
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


@app.post("/api/parsed-documents/text")
async def get_parsed_document_text(
    request: RawDocumentTextRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Get the parsed_text of a specific document"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"📝 [{request_id}] Get document text at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    table_name = sanitize_table_name(request.tableName)
    parsed_table = f"{request.catalog}.{request.schema_name}.{table_name}_parsed"
    
    print(f"📋 [{request_id}] Table: {parsed_table}")
    print(f"📋 [{request_id}] Document ID: {request.documentId}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Get document with parsed_text
        sql = f"""
        SELECT 
            id,
            file_name,
            parsed_text,
            text_length,
            page_count
        FROM {parsed_table}
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
                    "parsedText": row[2],
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


@app.post("/api/parsed-documents/check")
async def check_file_exists_in_table(
    request: CheckFileExistsRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Check if a file already exists in the _parsed table"""
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🔍 [{request_id}] Check file exists at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    table_name = sanitize_table_name(request.tableName)
    parsed_table = f"{request.catalog}.{request.schema_name}.{table_name}_parsed"
    
    print(f"📋 [{request_id}] Table: {parsed_table}")
    print(f"📋 [{request_id}] File Name: {request.fileName}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        # Escape single quotes in file name for SQL
        escaped_file_name = request.fileName.replace("'", "''")
        
        # Check if file exists in table
        sql = f"""
        SELECT COUNT(*) as cnt FROM {parsed_table}
        WHERE file_name = '{escaped_file_name}'
        """
        
        result = await execute_sql(config, warehouse_id, sql, request_id)
        
        exists = False
        if result and result.get("data_array") and len(result["data_array"]) > 0:
            count = int(result["data_array"][0][0])
            exists = count > 0
        
        print(f"✅ [{request_id}] File exists: {exists}")
        
        return {
            "success": True,
            "exists": exists,
            "fileName": request.fileName
        }
        
    except Exception as e:
        error_str = str(e)
        print(f"💥 [{request_id}] Exception: {error_str}")
        # If table doesn't exist, file doesn't exist either
        if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
            return {
                "success": True,
                "exists": False,
                "fileName": request.fileName
            }
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/parsed-documents/delete")
async def delete_documents(
    request: DeleteDocumentsRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Delete documents from _parsed and _chunks tables.
    If documentIds is empty, deletes ALL documents.
    Optionally also deletes PDF files from volume.
    """
    request_id = str(uuid.uuid4())[:8]
    print(f"\n{'=' * 80}")
    print(f"🗑️ [{request_id}] Delete documents at {datetime.now().isoformat()}")
    print(f"{'=' * 80}")
    
    table_name = sanitize_table_name(request.tableName)
    parsed_table = f"{request.catalog}.{request.schema_name}.{table_name}_parsed"
    chunks_table = f"{request.catalog}.{request.schema_name}.{table_name}_chunks"
    
    document_ids = request.documentIds
    delete_all = len(document_ids) == 0
    
    print(f"📋 [{request_id}] Parsed table: {parsed_table}")
    print(f"📋 [{request_id}] Chunks table: {chunks_table}")
    print(f"📋 [{request_id}] Delete all: {delete_all}")
    print(f"📋 [{request_id}] Document IDs: {len(document_ids) if document_ids else 'ALL'}")
    print(f"📋 [{request_id}] Delete from volume: {request.deleteFromVolume}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse not configured")
        
        deleted_parsed = 0
        deleted_chunks = 0
        deleted_files = []
        errors = []
        
        # If deleting all, we need to get file names first (for volume deletion)
        file_names_to_delete = []
        if request.deleteFromVolume:
            if delete_all:
                # Get all file names
                get_files_sql = f"SELECT file_name FROM {parsed_table}"
            else:
                ids_str = ", ".join([f"'{id}'" for id in document_ids])
                get_files_sql = f"SELECT file_name FROM {parsed_table} WHERE id IN ({ids_str})"
            
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
        
        # Delete from _parsed table
        print(f"\n🗑️ [{request_id}] Deleting from parsed table...")
        try:
            # Get count before
            count_before = await execute_sql(config, warehouse_id, f"SELECT COUNT(*) FROM {parsed_table}", request_id)
            before_count = int(count_before["data_array"][0][0]) if count_before and count_before.get("data_array") else 0
            
            if delete_all:
                delete_parsed_sql = f"DELETE FROM {parsed_table}"
            else:
                ids_str = ", ".join([f"'{id}'" for id in document_ids])
                delete_parsed_sql = f"DELETE FROM {parsed_table} WHERE id IN ({ids_str})"
            
            await execute_sql(config, warehouse_id, delete_parsed_sql, request_id)
            
            # Get count after
            count_after = await execute_sql(config, warehouse_id, f"SELECT COUNT(*) FROM {parsed_table}", request_id)
            after_count = int(count_after["data_array"][0][0]) if count_after and count_after.get("data_array") else 0
            
            deleted_parsed = before_count - after_count
            print(f"✅ [{request_id}] Deleted {deleted_parsed} records from parsed table")
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" not in error_str:
                print(f"❌ [{request_id}] Error deleting from parsed table: {error_str}")
                errors.append(f"Parsed: {error_str}")
            else:
                print(f"⚠️ [{request_id}] Parsed table does not exist")
                errors.append("Parsed table not found")
        
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
        print(f"  - Parsed records deleted: {deleted_parsed}")
        print(f"  - Chunks deleted: {'Yes' if deleted_chunks != 0 else 'No'}")
        print(f"  - Volume files deleted: {len(deleted_files)}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": len(errors) == 0,
            "deletedParsed": deleted_parsed,
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
    parsed_table = f"{request.catalog}.{request.schema_name}.{table_name}_parsed"
    
    print(f"📋 [{request_id}] Table: {parsed_table}")
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
        
        # Get documents with parsed_text
        ids_list = "', '".join(doc_ids)
        sql = f"""
        SELECT 
            id,
            file_name,
            parsed_text
        FROM {parsed_table}
        WHERE id IN ('{ids_list}')
        """
        
        result = await execute_sql(config, warehouse_id, sql, request_id)
        
        preview_results = []
        
        if result and result.get("data_array"):
            for row in result["data_array"]:
                doc_id = row[0]
                file_name = row[1]
                parsed_text = row[2] or ""
                
                # Apply chunking
                chunks = apply_chunking(
                    parsed_text, 
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
                    "textLength": len(parsed_text)
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
        
        # Parsed documents table (created in Module 1) - we just verify it exists
        parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
        # Chunks table stores chunked content
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        # Step 1: Verify _parsed table exists (created in Module 1)
        print(f"\n📋 [{request_id}] Verifying parsed table exists: {parsed_table}")
        verify_sql = f"SELECT COUNT(*) FROM {parsed_table} LIMIT 1"
        try:
            await execute_sql(config, warehouse_id, verify_sql, request_id)
            print(f"✅ [{request_id}] Parsed table exists")
        except Exception as e:
            error_str = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in error_str:
                raise HTTPException(
                    status_code=400, 
                    detail=f"Tabela _parsed não encontrada. Importe documentos primeiro no Módulo 1."
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
        
        # Step 3: Create fresh chunks table (with metadata support for hybrid_ai strategy)
        # Enable Change Data Feed for Vector Search compatibility
        create_chunks_sql = f"""
        CREATE TABLE {chunks_table} (
            id STRING,
            document_id STRING,
            file_name STRING,
            chunk_index INT,
            total_chunks INT,
            chunk_content STRING,
            chunk_context STRING,
            strategy STRING,
            chunk_size INT,
            chunk_overlap INT,
            doc_metadata STRING,
            created_at TIMESTAMP
        )
        USING DELTA
        TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true')
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
            "parsedTable": parsed_table,
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
        
        # Step 1: Get text from _parsed table (already extracted in Module 1)
        escaped_file_name = file_name.replace("'", "''")
        parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
        
        print(f"\n📖 [{request_id}] Fetching text from _parsed table: {parsed_table}")
        
        fetch_sql = f"""
        SELECT id, file_path, parsed_text, text_length, page_count
        FROM {parsed_table}
        WHERE file_name = '{escaped_file_name}'
        LIMIT 1
        """
        
        result = await execute_sql(config, warehouse_id, fetch_sql, request_id)
        
        if not result or not result.get("data_array") or len(result.get("data_array", [])) == 0:
            print(f"❌ [{request_id}] Document not found in _parsed table: {file_name}")
            return {
                "success": False,
                "fileName": file_name,
                "error": "Document not found. Please import documents first in Module 1.",
                "chunksCreated": 0
            }
        
        row = result["data_array"][0]
        doc_id = row[0]
        extracted_path = row[1] or ""
        parsed_text = row[2] or ""
        text_length = int(row[3]) if row[3] else 0
        page_count = int(row[4]) if row[4] else 0
        
        print(f"✅ [{request_id}] Found document: {text_length} characters, {page_count} pages")
        
        if not parsed_text.strip():
            return {
                "success": False,
                "fileName": file_name,
                "error": "Document has no text content",
                "chunksCreated": 0
            }
        
        # Step 4: Extract AI metadata if using hybrid_ai strategy
        doc_metadata = {}
        doc_context = ""
        
        if strategy == "hybrid_ai":
            print(f"\n🤖 [{request_id}] Extracting document metadata with AI...")
            doc_metadata = await extract_document_metadata_with_ai(
                config, warehouse_id, parsed_text, file_name, request_id
            )
            
            # Build context string for chunk enrichment
            if doc_metadata and not doc_metadata.get("error") and not doc_metadata.get("parse_error"):
                doc_type = doc_metadata.get("document_type", "documento")
                subject = doc_metadata.get("subject", "")
                parties = doc_metadata.get("parties", [])
                summary = doc_metadata.get("summary", "")
                
                parties_str = ", ".join(parties) if parties else ""
                doc_context = f"[Tipo: {doc_type}]"
                if parties_str:
                    doc_context += f" [Partes: {parties_str}]"
                if subject:
                    doc_context += f" [Assunto: {subject}]"
                
                print(f"✅ [{request_id}] Document context: {doc_context[:100]}...")
        
        # Step 5: Create chunks
        separator_type = params.get("separatorType", "paragraph")
        custom_separator = params.get("customSeparator", "")
        
        print(f"\n✂️ [{request_id}] Creating chunks with '{strategy}' strategy...")
        if strategy == "by_separator":
            print(f"  Separator type: {separator_type}, Custom: '{custom_separator}'")
        
        chunks = create_chunks(parsed_text, strategy, chunk_size, chunk_overlap, separator_type, custom_separator)
        print(f"✅ [{request_id}] Created {len(chunks)} chunks")
        
        # Step 6: Save chunks to chunks table
        print(f"\n💾 [{request_id}] Saving {len(chunks)} chunks...")
        
        # Serialize metadata as JSON
        import json
        metadata_json = json.dumps(doc_metadata, ensure_ascii=False) if doc_metadata else "{}"
        escaped_metadata = metadata_json.replace("'", "''")
        escaped_context = doc_context.replace("'", "''") if doc_context else ""
        
        for idx, chunk in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
            
            # For hybrid_ai, prepend context to chunk content for better RAG results
            if strategy == "hybrid_ai" and doc_context:
                enriched_chunk = f"{doc_context}\n\n{chunk}"
                escaped_enriched = enriched_chunk.replace("'", "''").replace("\\", "\\\\")
            else:
                escaped_enriched = escaped_chunk
            
            insert_chunk_sql = f"""
            INSERT INTO {chunks_table}
            (id, document_id, file_name, chunk_index, total_chunks, chunk_content, 
             chunk_context, strategy, chunk_size, chunk_overlap, doc_metadata, created_at)
            VALUES (
                '{chunk_id}',
                '{doc_id}',
                '{escaped_file_name}',
                {idx},
                {len(chunks)},
                '{escaped_enriched}',
                '{escaped_context}',
                '{strategy}',
                {chunk_size},
                {chunk_overlap},
                '{escaped_metadata}',
                current_timestamp()
            )
            """
            await execute_sql(config, warehouse_id, insert_chunk_sql, request_id)
        
        print(f"\n✅ [{request_id}] File processing complete!")
        print(f"  - Document ID: {doc_id}")
        print(f"  - Text length: {len(parsed_text)} chars")
        print(f"  - Chunks created: {len(chunks)}")
        if strategy == "hybrid_ai":
            print(f"  - AI Metadata: {'Extracted' if doc_metadata and not doc_metadata.get('error') else 'Failed'}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "fileName": file_name,
            "documentId": doc_id,
            "textLength": len(parsed_text),
            "pageCount": page_count,
            "chunksCreated": len(chunks),
            "hasMetadata": bool(doc_metadata and not doc_metadata.get("error"))
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
    vs_endpoint_name: Optional[str] = None  # Vector Search endpoint name
    embedding_model: Optional[str] = None  # Embedding model for vector search
    index_sync_type: Optional[str] = None  # TRIGGERED or CONTINUOUS


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
        "app_name": "Contracts App",
        "vs_endpoint_name": "",  # Vector Search endpoint - empty by default
        "embedding_model": "databricks-gte-large-en",  # Default embedding model
        "index_sync_type": "TRIGGERED"  # Default sync type (manual)
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
        if request.vs_endpoint_name is not None:
            new_values["vs_endpoint_name"] = request.vs_endpoint_name
        if request.embedding_model is not None:
            new_values["embedding_model"] = request.embedding_model
        if request.index_sync_type is not None:
            new_values["index_sync_type"] = request.index_sync_type
        
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
# Auto Process with Chunking Evaluation
# ============================================================================

class AutoProcessRequest(BaseModel):
    tableConfig: Dict[str, str]
    files: List[str]

class ChunkingEvaluation(BaseModel):
    strategy: str
    avg_score: float
    precision: float
    chunks_evaluated: int
    sample_questions: List[Dict[str, Any]]


# ============================================================================
# Background Job Endpoints for Auto Process (avoids gateway timeouts)
# ============================================================================

@app.post("/api/process/auto/start")
async def start_auto_process(
    request: AutoProcessRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """Start auto process in background and return job_id for polling"""
    job_id = str(uuid.uuid4())[:8]
    
    print(f"\n🚀 [{job_id}] Starting background auto process job...")
    
    # Initialize job status
    auto_process_jobs[job_id] = {
        "status": "running",
        "step": "starting",
        "message": "Iniciando processamento...",
        "progress": 0,
        "started_at": datetime.now().isoformat(),
        "result": None,
        "error": None
    }
    
    # Start background task
    asyncio.create_task(run_auto_process_background(job_id, request, x_forwarded_access_token))
    
    return {"jobId": job_id, "status": "started"}


@app.get("/api/process/auto/status/{job_id}")
async def get_auto_process_status(job_id: str):
    """Get status of auto process job"""
    if job_id not in auto_process_jobs:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    job = auto_process_jobs[job_id]
    return job


async def run_auto_process_background(job_id: str, request: AutoProcessRequest, user_token: Optional[str]):
    """Background task for auto process"""
    try:
        # Run the actual processing
        result = await execute_auto_process(job_id, request, user_token)
        
        auto_process_jobs[job_id]["status"] = "completed"
        auto_process_jobs[job_id]["step"] = "done"
        auto_process_jobs[job_id]["progress"] = 100
        auto_process_jobs[job_id]["result"] = result
        auto_process_jobs[job_id]["completed_at"] = datetime.now().isoformat()
        
    except Exception as e:
        print(f"💥 [{job_id}] Background job failed: {str(e)}")
        import traceback
        traceback.print_exc()
        
        auto_process_jobs[job_id]["status"] = "failed"
        auto_process_jobs[job_id]["error"] = str(e)
        auto_process_jobs[job_id]["completed_at"] = datetime.now().isoformat()


async def execute_auto_process(job_id: str, request: AutoProcessRequest, user_token: Optional[str]) -> dict:
    """Execute auto process logic (extracted from endpoint for background use)"""
    config = get_databricks_config(user_token)
    warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
    
    if not warehouse_id:
        raise Exception("Warehouse ID not configured")
    
    table_config = request.tableConfig
    files = request.files
    total_files = len(files)
    
    catalog = table_config.get("catalog", "")
    schema = table_config.get("schema", "")
    table_name = sanitize_table_name(table_config.get("tableName", ""))
    
    parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
    chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
    
    # Use 3 RANDOM sample files for evaluation
    import random
    sample_count = min(3, len(files))
    sample_files = random.sample(files, sample_count) if len(files) > 3 else files[:sample_count]
    
    print(f"  [{job_id}] Total files: {total_files}, Sample files: {sample_count}")
    print(f"  [{job_id}] Samples: {sample_files}")
    
    # Update job status
    def update_job(step: str, message: str, progress: int, **extra):
        auto_process_jobs[job_id].update({
            "step": step,
            "message": message,
            "progress": progress,
            **extra
        })
    
    # =====================================================================
    # STEP 1: Generate evaluation questions
    # =====================================================================
    update_job("generating_questions", "Gerando perguntas de avaliação...", 5)
    print(f"\n📝 [{job_id}] Step 1: Generating evaluation questions...")
    
    sample_texts = []
    for sf in sample_files:
        escaped_sf = sf.replace("'", "''")
        sample_sql = f"SELECT parsed_text FROM {parsed_table} WHERE file_name = '{escaped_sf}' LIMIT 1"
        sample_result = await execute_sql(config, warehouse_id, sample_sql, job_id)
        if sample_result and sample_result.get("data_array"):
            text = sample_result["data_array"][0][0] or ""
            sample_texts.append(text[:1500])
    
    if not sample_texts:
        raise Exception("No documents found")
    
    combined_sample = "\n\n---\n\n".join(sample_texts)[:4000]
    
    eval_questions = []
    qa_prompt = f"""Baseado nos textos, gere 5 perguntas específicas.
Para cada pergunta, inclua um trecho curto (máx 100 chars) com a resposta.

Textos:
{combined_sample[:3000]}

Responda APENAS com JSON:
[{{"pergunta": "...", "trecho": "..."}}]"""
    
    qa_sql = f"SELECT ai_query('databricks-meta-llama-3-3-70b-instruct', '{qa_prompt.replace(chr(39), chr(39)+chr(39))}')"
    
    try:
        qa_result = await execute_sql_long(config, warehouse_id, qa_sql, job_id, timeout_minutes=2)
        if qa_result and qa_result.get("data_array"):
            qa_response = qa_result["data_array"][0][0]
            json_start = qa_response.find('[')
            json_end = qa_response.rfind(']') + 1
            if json_start >= 0 and json_end > json_start:
                eval_questions = json.loads(qa_response[json_start:json_end])[:5]
                print(f"✅ [{job_id}] Generated {len(eval_questions)} questions")
    except Exception as e:
        print(f"⚠️ [{job_id}] Q&A generation failed: {e}")
    
    if len(eval_questions) < 3:
        eval_questions = [
            {"pergunta": "Qual é o assunto principal?", "trecho": combined_sample[:200]},
            {"pergunta": "Quais são as partes envolvidas?", "trecho": combined_sample[:200]},
            {"pergunta": "Quais são as condições?", "trecho": combined_sample[:200]}
        ]
    
    update_job("generating_questions", f"Geradas {len(eval_questions)} perguntas", 10, 
               questions=[q.get("pergunta", "") for q in eval_questions])
    
    # =====================================================================
    # STEP 2-4: Test each strategy on samples
    # =====================================================================
    strategies = [
        {"name": "recursive", "func": chunk_recursive, "label": "Recursivo", "icon": "🔷"},
        {"name": "fixed_size", "func": chunk_fixed_size, "label": "Tamanho Fixo", "icon": "🔶"},
        {"name": "structural", "func": chunk_structural, "label": "Estrutural", "icon": "⭐"}
    ]
    
    temp_tables = {}
    strategy_results = {}
    
    for strat_idx, strategy in enumerate(strategies):
        strat_name = strategy["name"]
        strat_func = strategy["func"]
        strat_label = strategy["label"]
        strat_icon = strategy["icon"]
        
        step_name = f"chunking_{['a', 'b', 'c'][strat_idx]}"
        base_progress = 15 + strat_idx * 15
        
        update_job(step_name, f"{strat_label}: Iniciando...", base_progress, currentStrategy=strat_label)
        print(f"\n{strat_icon} [{job_id}] Step {strat_idx + 2}: Testing {strat_label} on {sample_count} samples...")
        
        temp_table = f"{chunks_table}_temp_{strat_name[:3]}"
        temp_tables[strat_name] = temp_table
        
        await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_table}", job_id)
        
        create_temp_sql = f"""
        CREATE TABLE {temp_table} (
            id STRING, document_id STRING, file_name STRING,
            chunk_index INT, total_chunks INT, chunk_content STRING,
            strategy STRING, created_at TIMESTAMP
        )"""
        await execute_sql(config, warehouse_id, create_temp_sql, job_id)
        
        chunk_count = 0
        sample_chunks = []
        
        for file_idx, file_name in enumerate(sample_files):
            escaped_file = file_name.replace("'", "''")
            progress = base_progress + int((file_idx + 1) / sample_count * 12)
            update_job(step_name, f"{strat_label}: {file_name} ({file_idx + 1}/{sample_count})", progress,
                      currentFile=file_name, currentFileIndex=file_idx + 1, sampleFiles=sample_count)
            
            print(f"  📄 [{job_id}] {strat_label}: Sample {file_idx + 1}/{sample_count}: {file_name}")
            
            text_sql = f"SELECT id, parsed_text FROM {parsed_table} WHERE file_name = '{escaped_file}' LIMIT 1"
            text_result = await execute_sql(config, warehouse_id, text_sql, job_id)
            
            if text_result and text_result.get("data_array"):
                doc_id = text_result["data_array"][0][0]
                parsed_text = text_result["data_array"][0][1] or ""
                chunks = strat_func(parsed_text, 1000, 200)
                chunk_count += len(chunks)
                
                # Store sample chunks for preview (max 3 per file, max 9 total)
                for idx, chunk in enumerate(chunks[:3]):
                    if len(sample_chunks) < 9:
                        sample_chunks.append({
                            "file_name": file_name,
                            "chunk_index": idx,
                            "total_chunks": len(chunks),
                            "content": chunk[:500],
                            "char_count": len(chunk)
                        })
                
                if chunks:
                    values_list = []
                    for idx, chunk in enumerate(chunks):
                        chunk_id = str(uuid.uuid4())
                        escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
                        values_list.append(f"('{chunk_id}', '{doc_id}', '{escaped_file}', {idx}, {len(chunks)}, '{escaped_chunk}', '{strat_name}', current_timestamp())")
                    
                    for i in range(0, len(values_list), 50):
                        batch = values_list[i:i + 50]
                        insert_sql = f"INSERT INTO {temp_table} VALUES {', '.join(batch)}"
                        await execute_sql(config, warehouse_id, insert_sql, job_id)
        
        strategy_results[strat_name] = {
            "chunks_count": chunk_count,
            "sample_chunks": sample_chunks,
            "temp_table": temp_table
        }
        
        # Update job with strategy results so frontend can show them during processing
        strategy_key = ["A", "B", "C"][strat_idx]
        strategy_eval_key = f"evaluation{strategy_key}"
        auto_process_jobs[job_id][strategy_eval_key] = {
            "strategy": strat_name,
            "label": strat_label,
            "chunks_count": chunk_count,
            "sample_chunks": sample_chunks,
            "avg_score": 0,  # Will be updated after evaluation
            "precision": 0
        }
        
        # Also update tables info
        table_key_map = {"recursive": "tempRecursive", "fixed_size": "tempFixedSize", "structural": "tempStructural"}
        if "tables" not in auto_process_jobs[job_id]:
            auto_process_jobs[job_id]["tables"] = {
                "chunks": chunks_table,
                "tempRecursive": "",
                "tempFixedSize": "",
                "tempStructural": ""
            }
        auto_process_jobs[job_id]["tables"][table_key_map.get(strat_name, "")] = temp_table
        
        print(f"  ✅ [{job_id}] {strat_label}: {chunk_count} chunks from {sample_count} samples")
    
    # =====================================================================
    # STEP 5: Evaluate strategies
    # =====================================================================
    update_job("evaluating", "Avaliando A: Recursivo...", 60)
    print(f"\n📊 [{job_id}] Step 5: Evaluating 3 strategies...")
    
    async def evaluate_single_question(temp_table: str, strat_label: str, question: dict, q_idx: int) -> float:
        q_text = question.get("pergunta", "").replace("'", "''")
        expected = question.get("trecho", "").replace("'", "''")
        
        eval_sql = f"""
        SELECT chunk_content FROM {temp_table}
        WHERE LOWER(chunk_content) LIKE LOWER('%{q_text[:50]}%')
           OR LOWER(chunk_content) LIKE LOWER('%{expected[:30]}%')
        LIMIT 1
        """
        
        result = await execute_sql(config, warehouse_id, eval_sql, job_id)
        
        if result and result.get("data_array"):
            retrieved = result["data_array"][0][0] or ""
            
            score_prompt = f"""Avalie de 1-10 o quão bem o chunk recuperado responde a pergunta.
Pergunta: {q_text[:200]}
Esperado: {expected[:100]}
Chunk: {retrieved[:500]}
Responda APENAS com um número de 1 a 10."""
            
            score_sql = f"SELECT ai_query('databricks-meta-llama-3-3-70b-instruct', '{score_prompt.replace(chr(39), chr(39)+chr(39))}')"
            
            try:
                score_result = await execute_sql_long(config, warehouse_id, score_sql, job_id, timeout_minutes=1)
                if score_result and score_result.get("data_array"):
                    score_text = score_result["data_array"][0][0]
                    import re
                    numbers = re.findall(r'\d+', score_text)
                    if numbers:
                        score = min(10, max(1, int(numbers[0])))
                        print(f"    Q{q_idx + 1} [{strat_label}]: {score}")
                        return score
            except Exception as e:
                print(f"    Q{q_idx + 1} [{strat_label}]: Error - {e}")
        
        return 5.0
    
    evaluations = {}
    questions_to_eval = eval_questions[:3]
    best_score = -1
    best_strategy = None
    
    for strat_idx, strategy in enumerate(strategies):
        strat_name = strategy["name"]
        strat_label = strategy["label"]
        temp_table = temp_tables[strat_name]
        
        update_job("evaluating", f"Avaliando {['A', 'B', 'C'][strat_idx]}: {strat_label}...", 62 + strat_idx * 6,
                  evaluatingStrategy=strat_label)
        
        print(f"  Evaluating {strat_label}...")
        scores = []
        for q_idx, question in enumerate(questions_to_eval):
            score = await evaluate_single_question(temp_table, strat_label, question, q_idx)
            scores.append(score)
        
        avg_score = sum(scores) / len(scores) if scores else 5.0
        precision = len([s for s in scores if s >= 7]) / len(scores) if scores else 0.5
        
        evaluations[strat_name] = {
            "strategy": strat_name,
            "label": strat_label,
            "avg_score": round(avg_score, 2),
            "precision": round(precision, 2),
            "chunks_count": strategy_results[strat_name]["chunks_count"],
            "sample_chunks": strategy_results[strat_name].get("sample_chunks", [])
        }
        
        # Update job with evaluation results in real-time
        strategy_key = ["A", "B", "C"][strat_idx]
        strategy_eval_key = f"evaluation{strategy_key}"
        auto_process_jobs[job_id][strategy_eval_key] = evaluations[strat_name]
        
        if avg_score > best_score:
            best_score = avg_score
            best_strategy = strat_name
        
        # Update best strategy in real-time
        auto_process_jobs[job_id]["bestStrategy"] = best_strategy
    
    print(f"\n📈 [{job_id}] Results:")
    for strat_name, eval_data in evaluations.items():
        print(f"  {eval_data['label']}: score={eval_data['avg_score']:.2f}, precision={eval_data['precision']:.2f}, chunks={eval_data['chunks_count']}")
    
    best_chunk_func = get_chunk_function(best_strategy)
    best_label = next((s["label"] for s in strategies if s["name"] == best_strategy), best_strategy)
    print(f"\n🏆 [{job_id}] Best strategy: {best_strategy}")
    
    # =====================================================================
    # STEP 6: Apply best strategy to ALL files
    # =====================================================================
    update_job("applying", f"Aplicando {best_label} em {total_files} arquivos...", 80,
              bestStrategy=best_strategy, bestLabel=best_label)
    print(f"\n🚀 [{job_id}] Step 6: Applying {best_strategy} to all {total_files} files...")
    
    await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {chunks_table}", job_id)
    
    create_final_sql = f"""
    CREATE TABLE {chunks_table} (
        id STRING, document_id STRING, file_name STRING,
        chunk_index INT, total_chunks INT, chunk_content STRING,
        strategy STRING, created_at TIMESTAMP
    )"""
    await execute_sql(config, warehouse_id, create_final_sql, job_id)
    print(f"✅ [{job_id}] Table {chunks_table} created")
    
    final_chunks = 0
    for file_idx, file_name in enumerate(files):
        escaped_file = file_name.replace("'", "''")
        progress = 80 + int((file_idx + 1) / total_files * 15)
        update_job("applying", f"{best_label}: {file_name} ({file_idx + 1}/{total_files})", progress,
                  currentFile=file_name, currentFileIndex=file_idx + 1, totalFiles=total_files)
        
        print(f"  📄 [{job_id}] Processing {file_idx + 1}/{total_files}: {file_name}")
        
        text_sql = f"SELECT id, parsed_text FROM {parsed_table} WHERE file_name = '{escaped_file}' LIMIT 1"
        text_result = await execute_sql(config, warehouse_id, text_sql, job_id)
        
        if text_result and text_result.get("data_array"):
            doc_id = text_result["data_array"][0][0]
            parsed_text = text_result["data_array"][0][1] or ""
            chunks = best_chunk_func(parsed_text, 1000, 200)
            final_chunks += len(chunks)
            
            if chunks:
                values_list = []
                for idx, chunk in enumerate(chunks):
                    chunk_id = str(uuid.uuid4())
                    escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
                    values_list.append(f"('{chunk_id}', '{doc_id}', '{escaped_file}', {idx}, {len(chunks)}, '{escaped_chunk}', '{best_strategy}', current_timestamp())")
                
                for i in range(0, len(values_list), 50):
                    batch = values_list[i:i + 50]
                    insert_sql = f"INSERT INTO {chunks_table} VALUES {', '.join(batch)}"
                    await execute_sql(config, warehouse_id, insert_sql, job_id)
    
    print(f"✅ [{job_id}] Final: {final_chunks} chunks created with {best_strategy}")
    
    # Cleanup temp tables
    print(f"\n🧹 [{job_id}] Cleaning up temp tables...")
    for strat_name, temp_table in temp_tables.items():
        await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_table}", job_id)
    print(f"✅ [{job_id}] {len(temp_tables)} temp tables dropped")
    
    index_name = f"{catalog}.{schema}.{table_name}_vs"
    
    print(f"\n✅ [{job_id}] AUTO PROCESS COMPLETE")
    print(f"  - Best strategy: {best_strategy}")
    print(f"  - Final chunks: {final_chunks}")
    print(f"  - Files processed: {total_files}")
    print(f"{'=' * 80}\n")
    
    return {
        "success": True,
        "bestStrategy": best_strategy,
        "evaluations": evaluations,
        "finalChunks": final_chunks,
        "filesProcessed": total_files,
        "sampleFilesUsed": sample_count,
        "questions": [q.get("pergunta", "") for q in eval_questions[:3]],
        "tables": {
            "chunks": chunks_table,
            "tempRecursive": f"{chunks_table}_temp_rec",
            "tempFixedSize": f"{chunks_table}_temp_fix",
            "tempStructural": f"{chunks_table}_temp_str"
        },
        "indexName": index_name
    }


@app.post("/api/process/auto")
async def auto_process_with_evaluation(
    request: AutoProcessRequest,
    x_forwarded_access_token: Optional[str] = Header(None, alias="x-forwarded-access-token")
):
    """
    Optimized processing pipeline:
    1. Generate evaluation questions from 3 sample documents
    2. Test Strategy A (recursive) on 3 samples only
    3. Test Strategy B (fixed_size) on 3 samples only
    4. Evaluate and select best strategy
    5. Apply best strategy to ALL documents
    6. Create Vector Index
    """
    request_id = str(uuid.uuid4())[:8]
    
    print(f"\n{'=' * 80}")
    print(f"🤖 [{request_id}] OPTIMIZED AUTO PROCESS")
    print(f"{'=' * 80}")
    
    try:
        config = get_databricks_config(x_forwarded_access_token)
        warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
        
        if not warehouse_id:
            raise HTTPException(status_code=500, detail="Warehouse ID not configured")
        
        table_config = request.tableConfig
        files = request.files
        total_files = len(files)
        
        catalog = table_config.get("catalog", "")
        schema = table_config.get("schema", "")
        table_name = sanitize_table_name(table_config.get("tableName", ""))
        
        parsed_table = f"{catalog}.{schema}.{table_name}_parsed"
        chunks_table = f"{catalog}.{schema}.{table_name}_chunks"
        
        # Use 3 RANDOM sample files for evaluation (not just first 3)
        import random
        sample_count = min(3, len(files))
        sample_files = random.sample(files, sample_count) if len(files) > 3 else files[:sample_count]
        
        print(f"  Total files: {total_files}, Sample files for evaluation: {sample_count}")
        print(f"  Samples: {sample_files}")
        
        # =====================================================================
        # STEP 1: Generate evaluation questions from 3 samples
        # =====================================================================
        print(f"\n📝 [{request_id}] Step 1: Generating evaluation questions...")
        
        # Collect sample text
        sample_texts = []
        for sf in sample_files:
            escaped_sf = sf.replace("'", "''")
            sample_sql = f"SELECT parsed_text FROM {parsed_table} WHERE file_name = '{escaped_sf}' LIMIT 1"
            sample_result = await execute_sql(config, warehouse_id, sample_sql, request_id)
            if sample_result and sample_result.get("data_array"):
                text = sample_result["data_array"][0][0] or ""
                sample_texts.append(text[:1500])
        
        if not sample_texts:
            raise HTTPException(status_code=404, detail="No documents found")
        
        combined_sample = "\n\n---\n\n".join(sample_texts)[:4000]
        
        # Generate 5 Q&A pairs
        eval_questions = []
        qa_prompt = f"""Baseado nos textos, gere 5 perguntas específicas.
Para cada pergunta, inclua um trecho curto (máx 100 chars) com a resposta.

Textos:
{combined_sample[:3000]}

Responda APENAS com JSON:
[{{"pergunta": "...", "trecho": "..."}}]"""
        
        qa_sql = f"SELECT ai_query('databricks-meta-llama-3-3-70b-instruct', '{qa_prompt.replace(chr(39), chr(39)+chr(39))}')"
        
        try:
            qa_result = await execute_sql_long(config, warehouse_id, qa_sql, request_id, timeout_minutes=2)
            if qa_result and qa_result.get("data_array"):
                qa_response = qa_result["data_array"][0][0]
                json_start = qa_response.find('[')
                json_end = qa_response.rfind(']') + 1
                if json_start >= 0 and json_end > json_start:
                    eval_questions = json.loads(qa_response[json_start:json_end])[:5]
                    print(f"✅ [{request_id}] Generated {len(eval_questions)} questions")
        except Exception as e:
            print(f"⚠️ [{request_id}] Q&A generation failed: {e}")
        
        if len(eval_questions) < 3:
            eval_questions = [
                {"pergunta": "Qual é o assunto principal?", "trecho": combined_sample[:200]},
                {"pergunta": "Quais são as partes envolvidas?", "trecho": combined_sample[:200]},
                {"pergunta": "Quais são as condições?", "trecho": combined_sample[:200]}
            ]
        
        # =====================================================================
        # Define strategies to test (3 strategies for contracts)
        # =====================================================================
        strategies = [
            {"name": "recursive", "func": chunk_recursive, "label": "Recursivo", "icon": "🔷"},
            {"name": "fixed_size", "func": chunk_fixed_size, "label": "Fixo", "icon": "🔶"},
            {"name": "structural", "func": chunk_structural, "label": "Estrutural", "icon": "⭐"}
        ]
        
        temp_tables = {}
        strategy_results = {}
        
        # =====================================================================
        # STEP 2-4: Test each strategy on samples
        # =====================================================================
        for strat_idx, strategy in enumerate(strategies):
            strat_name = strategy["name"]
            strat_func = strategy["func"]
            strat_label = strategy["label"]
            strat_icon = strategy["icon"]
            
            print(f"\n{strat_icon} [{request_id}] Step {strat_idx + 2}: Testing {strat_label} on {sample_count} samples...")
            
            temp_table = f"{chunks_table}_temp_{strat_name[:3]}"
            temp_tables[strat_name] = temp_table
            
            await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_table}", request_id)
            
            create_temp_sql = f"""
            CREATE TABLE {temp_table} (
                id STRING, document_id STRING, file_name STRING,
                chunk_index INT, total_chunks INT, chunk_content STRING,
                strategy STRING, created_at TIMESTAMP
            )"""
            await execute_sql(config, warehouse_id, create_temp_sql, request_id)
            
            chunk_count = 0
            sample_chunks = []  # Store sample chunks for preview
            for file_idx, file_name in enumerate(sample_files):
                escaped_file = file_name.replace("'", "''")
                print(f"  📄 [{request_id}] {strat_label}: Sample {file_idx + 1}/{sample_count}: {file_name}")
                
                text_sql = f"SELECT id, parsed_text FROM {parsed_table} WHERE file_name = '{escaped_file}' LIMIT 1"
                text_result = await execute_sql(config, warehouse_id, text_sql, request_id)
                
                if text_result and text_result.get("data_array"):
                    doc_id = text_result["data_array"][0][0]
                    parsed_text = text_result["data_array"][0][1] or ""
                    chunks = strat_func(parsed_text)
                    chunk_count += len(chunks)
                    
                    # Store first 3 chunks from each file for preview (max 9 total per strategy)
                    for idx, chunk in enumerate(chunks[:3]):
                        if len(sample_chunks) < 9:
                            sample_chunks.append({
                                "file_name": file_name,
                                "chunk_index": idx,
                                "total_chunks": len(chunks),
                                "content": chunk[:500] + ("..." if len(chunk) > 500 else ""),
                                "char_count": len(chunk)
                            })
                    
                    if chunks:
                        values_list = []
                        for idx, chunk in enumerate(chunks):
                            chunk_id = str(uuid.uuid4())
                            escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
                            values_list.append(f"('{chunk_id}', '{doc_id}', '{escaped_file}', {idx}, {len(chunks)}, '{escaped_chunk}', '{strat_name}', current_timestamp())")
                        
                        for i in range(0, len(values_list), 50):
                            batch = values_list[i:i + 50]
                            insert_sql = f"INSERT INTO {temp_table} VALUES {', '.join(batch)}"
                            await execute_sql(config, warehouse_id, insert_sql, request_id)
            
            strategy_results[strat_name] = {"chunks_count": chunk_count, "temp_table": temp_table, "sample_chunks": sample_chunks}
            print(f"✅ [{request_id}] {strat_label}: {chunk_count} chunks from {sample_count} samples")
        
        # =====================================================================
        # STEP 5: Evaluate all strategies with LLM
        # =====================================================================
        print(f"\n📊 [{request_id}] Step 5: Evaluating {len(strategies)} strategies...")
        
        questions_to_eval = eval_questions[:3]
        
        async def evaluate_single_question(temp_table: str, strategy_name: str, question: Dict, q_idx: int) -> float:
            """Evaluate a single question against chunks"""
            pergunta = question.get("pergunta", "").replace("'", "''")
            trecho = question.get("trecho", "").replace("'", "''")[:100]
            
            search_sql = f"SELECT chunk_content FROM {temp_table} WHERE LOWER(chunk_content) LIKE LOWER('%{trecho[:30]}%') LIMIT 1"
            chunk_result = await execute_sql(config, warehouse_id, search_sql, request_id)
            
            if not chunk_result or not chunk_result.get("data_array"):
                search_sql2 = f"SELECT chunk_content FROM {temp_table} LIMIT 3"
                chunk_result = await execute_sql(config, warehouse_id, search_sql2, request_id)
            
            if not chunk_result or not chunk_result.get("data_array"):
                return 5.0
            
            chunk_content = chunk_result["data_array"][0][0][:800]
            escaped_chunk = chunk_content.replace("'", "''")
            
            eval_prompt = f"""Avalie se o chunk de contrato contém informação para responder a pergunta jurídica.
Nota de 0 a 10: 0-3=não contém, 4-6=parcial, 7-10=completa e contexto preservado.

Pergunta: {pergunta}
Chunk: {escaped_chunk[:500]}

Responda APENAS com um número de 0 a 10:"""
            
            eval_sql = f"SELECT ai_query('databricks-meta-llama-3-3-70b-instruct', '{eval_prompt.replace(chr(39), chr(39)+chr(39))}')"
            
            try:
                eval_result = await execute_sql_long(config, warehouse_id, eval_sql, request_id, timeout_minutes=1)
                if eval_result and eval_result.get("data_array"):
                    response = eval_result["data_array"][0][0].strip()
                    import re
                    numbers = re.findall(r'\d+(?:\.\d+)?', response)
                    if numbers:
                        score = min(10.0, max(0.0, float(numbers[0])))
                        print(f"    Q{q_idx+1} [{strategy_name}]: {score}")
                        return score
            except Exception as e:
                print(f"    Q{q_idx+1} [{strategy_name}]: error")
            
            return 5.0
        
        evaluations = {}
        best_score = -1
        best_strategy = None
        
        for strategy in strategies:
            strat_name = strategy["name"]
            strat_label = strategy["label"]
            temp_table = temp_tables[strat_name]
            
            print(f"  Evaluating {strat_label}...")
            scores = []
            for q_idx, question in enumerate(questions_to_eval):
                score = await evaluate_single_question(temp_table, strat_label, question, q_idx)
                scores.append(score)
            
            avg_score = sum(scores) / len(scores) if scores else 5.0
            precision = len([s for s in scores if s >= 7]) / len(scores) if scores else 0.5
            
            evaluations[strat_name] = {
                "strategy": strat_name,
                "label": strat_label,
                "avg_score": round(avg_score, 2),
                "precision": round(precision, 2),
                "chunks_count": strategy_results[strat_name]["chunks_count"],
                "sample_chunks": strategy_results[strat_name].get("sample_chunks", [])
            }
            
            if avg_score > best_score:
                best_score = avg_score
                best_strategy = strat_name
        
        print(f"\n📈 [{request_id}] Results:")
        for strat_name, eval_data in evaluations.items():
            print(f"  {eval_data['label']}: score={eval_data['avg_score']:.2f}, precision={eval_data['precision']:.2f}, chunks={eval_data['chunks_count']}")
        
        best_chunk_func = get_chunk_function(best_strategy)
        print(f"\n🏆 [{request_id}] Best strategy: {best_strategy}")
        
        # =====================================================================
        # STEP 5: Apply best strategy to ALL files
        # =====================================================================
        print(f"\n🚀 [{request_id}] Step 5: Applying {best_strategy} to all {total_files} files...")
        
        # Drop and recreate final chunks table
        await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {chunks_table}", request_id)
        
        create_final_sql = f"""
        CREATE TABLE {chunks_table} (
            id STRING, document_id STRING, file_name STRING,
            chunk_index INT, total_chunks INT, chunk_content STRING,
            strategy STRING, created_at TIMESTAMP
        )"""
        await execute_sql(config, warehouse_id, create_final_sql, request_id)
        print(f"✅ [{request_id}] Table {chunks_table} created")
        
        final_chunks = 0
        for file_idx, file_name in enumerate(files):
            escaped_file = file_name.replace("'", "''")
            print(f"  📄 [{request_id}] Processing {file_idx + 1}/{total_files}: {file_name}")
            
            text_sql = f"SELECT id, parsed_text FROM {parsed_table} WHERE file_name = '{escaped_file}' LIMIT 1"
            text_result = await execute_sql(config, warehouse_id, text_sql, request_id)
            
            if text_result and text_result.get("data_array"):
                doc_id = text_result["data_array"][0][0]
                parsed_text = text_result["data_array"][0][1] or ""
                chunks = best_chunk_func(parsed_text, 1000, 200)
                final_chunks += len(chunks)
                
                if chunks:
                    values_list = []
                    for idx, chunk in enumerate(chunks):
                        chunk_id = str(uuid.uuid4())
                        escaped_chunk = chunk.replace("'", "''").replace("\\", "\\\\")
                        values_list.append(f"('{chunk_id}', '{doc_id}', '{escaped_file}', {idx}, {len(chunks)}, '{escaped_chunk}', '{best_strategy}', current_timestamp())")
                    
                    for i in range(0, len(values_list), 50):
                        batch = values_list[i:i + 50]
                        insert_sql = f"INSERT INTO {chunks_table} VALUES {', '.join(batch)}"
                        await execute_sql(config, warehouse_id, insert_sql, request_id)
        
        print(f"✅ [{request_id}] Final: {final_chunks} chunks created with {best_strategy}")
        
        # Cleanup all temp tables
        print(f"\n🧹 [{request_id}] Cleaning up temp tables...")
        for strat_name, temp_table in temp_tables.items():
            await execute_sql(config, warehouse_id, f"DROP TABLE IF EXISTS {temp_table}", request_id)
        print(f"✅ [{request_id}] {len(temp_tables)} temp tables dropped")
        
        # Build index name for reference
        index_name = f"{catalog}.{schema}.{table_name}_vs"
        
        print(f"\n✅ [{request_id}] AUTO PROCESS COMPLETE")
        print(f"  - Best strategy: {best_strategy}")
        print(f"  - Final chunks: {final_chunks}")
        print(f"  - Files processed: {total_files}")
        print(f"  - Strategies evaluated: {len(evaluations)}")
        print(f"  - Chunks table: {chunks_table}")
        print(f"  - Index name: {index_name}")
        print(f"{'=' * 80}\n")
        
        return {
            "success": True,
            "bestStrategy": best_strategy,
            "evaluations": evaluations,
            "finalChunks": final_chunks,
            "filesProcessed": total_files,
            "sampleFilesUsed": sample_count,
            "questions": [q.get("pergunta", "") for q in eval_questions[:3]],
            "tables": {
                "chunks": chunks_table,
                "tempRecursive": f"{chunks_table}_temp_rec",
                "tempFixedSize": f"{chunks_table}_temp_fix",
                "tempStructural": f"{chunks_table}_temp_str"
            },
            "indexName": index_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"💥 [{request_id}] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
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
        # For DDL statements (CREATE, DROP, etc.) result may be empty - that's OK
        return result.get("result", {"success": True})
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
    
    elif strategy == "by_sentence":
        return chunk_by_sentence(text, chunk_size, chunk_overlap)
    
    elif strategy == "semantic":
        # Semantic chunking would require embeddings - use recursive as fallback
        return chunk_recursive(text, chunk_size, chunk_overlap)
    
    elif strategy == "hybrid_ai":
        # Hybrid AI uses recursive chunking as base - AI metadata is added in process_single_file
        return chunk_recursive(text, chunk_size, chunk_overlap)
    
    else:
        # Default to fixed size
        return chunk_fixed_size(text, chunk_size, chunk_overlap)


def chunk_fixed_size(text: str, chunk_size: int = 800, overlap: int = 150) -> List[str]:
    """
    Fixed-size chunking with overlap.
    Optimized for contracts: 800 chars (~200 tokens), 150 overlap (~40 tokens)
    """
    chunks = []
    text = text.strip()
    if not text:
        return chunks
    
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        
        # Try to break at sentence end
        if end < len(text):
            for sep in ['. ', '.\n', '; ', ';\n']:
                last_sep = text[start:end].rfind(sep)
                if last_sep > chunk_size * 0.5:
                    end = start + last_sep + len(sep)
                    break
        
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        
        start = end - overlap if end < len(text) else end
        if start <= 0 or start >= len(text):
            break
    
    return chunks


def chunk_recursive(text: str, chunk_size: int = 800, overlap: int = 150) -> List[str]:
    """
    Recursive character text splitting.
    Uses paragraph and sentence boundaries for natural breaks.
    """
    text = text.strip()
    if not text:
        return []
    
    separators = ["\n\n", "\n", ". ", "; ", ", ", " "]
    
    def split_text(txt: str, sep_idx: int = 0) -> List[str]:
        if len(txt) <= chunk_size:
            return [txt.strip()] if txt.strip() else []
        
        if sep_idx >= len(separators):
            return chunk_fixed_size(txt, chunk_size, overlap)
        
        sep = separators[sep_idx]
        if sep not in txt:
            return split_text(txt, sep_idx + 1)
        
        parts = txt.split(sep)
        chunks = []
        current = ""
        
        for part in parts:
            candidate = (current + sep + part) if current else part
            if len(candidate) <= chunk_size:
                current = candidate
            else:
                if current.strip():
                    chunks.append(current.strip())
                if len(part) > chunk_size:
                    chunks.extend(split_text(part, sep_idx + 1))
                    current = ""
                else:
                    current = part
        
        if current.strip():
            chunks.append(current.strip())
        
        return chunks
    
    return split_text(text)


def chunk_structural(text: str, chunk_size: int = 800, overlap: int = 150) -> List[str]:
    """
    Structural chunking for legal contracts (BEST for contracts).
    
    Strategy:
    1. First splits by clauses (legal structure)
    2. Then applies fixed chunking WITHIN each clause
    3. Never crosses clause boundaries
    
    Recognizes patterns:
    - Numbered clauses: "1. Título", "2. Título"
    - Named sections: "CLÁUSULA X", "Artigo X", "Seção X"
    - Annexes: "Anexo A —", "Anexo B"
    - Subsections: "1.1", "1.2.1", "a)", "I)"
    """
    import re
    
    text = text.strip()
    if not text:
        return []
    
    # Clean page markers and headers
    text = re.sub(r'-- \d+ of \d+ --', '', text)
    text = re.sub(r'Página \d+', '', text)
    text = re.sub(r'DOCUMENTO FICTÍCIO.*?PRODUÇÃO\s*', '', text)
    
    # Patterns for clause detection (Portuguese legal)
    clause_patterns = [
        r'(?=\n\d+\.\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç])',  # "1. Título"
        r'(?=\nCLÁUSULA\s+\d+)',  # "CLÁUSULA 1"
        r'(?=\nCláusula\s+\d+)',  # "Cláusula 1"
        r'(?=\nArtigo\s+\d+)',    # "Artigo 1"
        r'(?=\nArt\.\s*\d+)',     # "Art. 1"
        r'(?=\nSeção\s+\d+)',     # "Seção 1"
        r'(?=\nCapítulo\s+\d+)',  # "Capítulo 1"
        r'(?=\nAnexo\s+[A-Z]?\s*[—–-])',  # "Anexo A —"
        r'(?=\nAnexo\s+[A-Z]?\s*\n)',      # "Anexo A\n"
        r'(?=\n[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç\s]+(?:,\s*[A-Z][a-záéíóúâêôãõç\s]+)*\n)',  # Section titles
    ]
    
    # Combine patterns
    combined_pattern = '|'.join(clause_patterns)
    
    # Split by clauses
    clauses = re.split(combined_pattern, '\n' + text)
    clauses = [c.strip() for c in clauses if c and c.strip()]
    
    # If no clauses detected, fallback to paragraph-based splitting
    if len(clauses) <= 1:
        clauses = re.split(r'\n\n+', text)
        clauses = [c.strip() for c in clauses if c and c.strip()]
    
    chunks = []
    
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        
        # Extract clause header for context
        header_match = re.match(r'^(\d+\.?\s*[^\n]+|\w+\s+\d+[^\n]*|Anexo[^\n]+)', clause)
        header = header_match.group(0).strip() if header_match else ""
        
        if len(clause) <= chunk_size:
            chunks.append(clause)
        else:
            # Split large clauses with fixed chunking, preserving header context
            clause_chunks = chunk_fixed_size(clause, chunk_size, overlap)
            
            for i, chunk in enumerate(clause_chunks):
                # Add header reference to continuation chunks
                if i > 0 and header and not chunk.startswith(header[:20]):
                    chunk = f"[{header[:50]}...] {chunk}"
                chunks.append(chunk)
    
    return chunks


def get_chunk_function(strategy: str):
    """Get chunking function by strategy name"""
    strategies = {
        "fixed_size": chunk_fixed_size,
        "recursive": chunk_recursive,
        "structural": chunk_structural
    }
    return strategies.get(strategy, chunk_recursive)


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
