"use client"

import { useState, useEffect } from "react"
import { 
  Database, 
  FileText, 
  Play, 
  Eye,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
  Plus,
  Layers,
  X,
  Check
} from "lucide-react"
import { toast, Toaster } from "sonner"
import { useTranslation } from "@/lib/i18n"

// Helper function to format time in MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

// Types
interface RawDocument {
  id: string
  fileName: string
  filePath: string
  textLength: number
  pageCount: number
  createdAt: string
}

interface VolumeFile {
  name: string
  path: string
  size: number
  lastModified: string
  isImported: boolean
}

interface TableConfig {
  catalog: string
  schema: string
  tableName: string
}

interface ChunkingStrategy {
  id: string
  name: string
  description: string
  params: {
    chunkSize?: number
    chunkOverlap?: number
    separator?: string
    separatorType?: string
    customSeparator?: string
  }
}

interface ChunkPreview {
  documentName: string
  chunkIndex: number
  totalChunks: number
  content: string
  metadata: Record<string, unknown>
}

interface ProcessingStatus {
  status: "idle" | "checking" | "processing" | "completed" | "error"
  message: string
  progress: number
  totalFiles: number
  processedFiles: number
}

// Types for chunking preview
interface ChunkPreviewData {
  id: string
  fileName: string
  totalChunks: number
  chunks: {
    index: number
    content: string
    length: number
  }[]
  textLength: number
}

// Chunking Strategies based on Databricks best practices
const CHUNKING_STRATEGIES: ChunkingStrategy[] = [
  {
    id: "fixed_size",
    name: "Tamanho Fixo",
    description: "Divide o texto em partes iguais com sobreposição configurável. Simples e eficiente.",
    params: { chunkSize: 1000, chunkOverlap: 200 }
  },
  {
    id: "recursive",
    name: "Recursivo por Caractere",
    description: "Divide respeitando parágrafos e quebras de linha. Mantém o contexto do texto.",
    params: { chunkSize: 1000, chunkOverlap: 200, separator: "\\n\\n" }
  },
  {
    id: "by_separator",
    name: "Por Separador",
    description: "Divide por marcadores específicos (parágrafo, linha, ponto). Flexível e adaptável.",
    params: { chunkSize: 800, separatorType: "paragraph", customSeparator: "" }
  },
  {
    id: "by_page",
    name: "Por Página",
    description: "Cada página do PDF vira um segmento. Ideal para documentos organizados por página.",
    params: {}
  },
  {
    id: "by_sentence",
    name: "Por Sentença",
    description: "Agrupa frases completas até atingir o tamanho máximo. Preserva a estrutura do texto.",
    params: { chunkSize: 1000, chunkOverlap: 100 }
  },
  {
    id: "semantic",
    name: "Semântico",
    description: "Identifica automaticamente onde o assunto muda. Maior precisão, mais lento.",
    params: { chunkSize: 1500 }
  }
]

// Separator types for the "by_separator" strategy
const SEPARATOR_TYPES = [
  { id: "paragraph", name: "Parágrafo (linha dupla)", separator: "\\n\\n" },
  { id: "line", name: "Linha (Enter)", separator: "\\n" },
  { id: "sentence", name: "Sentença (ponto final)", separator: ". " },
  { id: "custom", name: "Personalizado", separator: "" }
]

export default function PreparePage() {
  const { t } = useTranslation()
  
  const [tableConfig, setTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts"  // Base name only - backend adds _raw/_chunks
  })
  const [initialTableConfig, setInitialTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts"
  })
  const [isConfigSaved, setIsConfigSaved] = useState(false)
  
  // Wizard step control - only one step open at a time
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | null>(2) // Start with step 2 open
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set())
  
  // State for raw documents (from _raw table)
  const [rawDocuments, setRawDocuments] = useState<RawDocument[]>([])
  const [selectedDocuments, setSelectedDocuments] = useState<Set<string>>(new Set())
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false)
  const [documentsTotal, setDocumentsTotal] = useState(0)
  const [documentsOffset, setDocumentsOffset] = useState(0)
  const [hasMoreDocuments, setHasMoreDocuments] = useState(false)
  const [tableNotFound, setTableNotFound] = useState(false)
  const DOCUMENTS_PER_PAGE = 10
  
  // State for document text preview modal
  const [showTextModal, setShowTextModal] = useState(false)
  const [selectedDocumentText, setSelectedDocumentText] = useState<{
    id: string
    fileName: string
    rawText: string
    textLength: number
    pageCount: number
  } | null>(null)
  const [isLoadingText, setIsLoadingText] = useState(false)
  const [viewedDocuments, setViewedDocuments] = useState<Set<string>>(new Set())
  
  // Legacy state for volume files (kept for compatibility)
  const [volumeFiles, setVolumeFiles] = useState<VolumeFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  
  // State for chunking
  const [selectedStrategy, setSelectedStrategy] = useState<string>("recursive")
  const [chunkingParams, setChunkingParams] = useState({
    chunkSize: 1000,
    chunkOverlap: 200,
    separatorType: "paragraph",  // For by_separator strategy
    customSeparator: ""          // For custom separator
  })
  
  // State for chunking preview
  const [showChunkingPreview, setShowChunkingPreview] = useState(false)
  const [chunkPreviewData, setChunkPreviewData] = useState<ChunkPreviewData[]>([])
  const [previewDocIndex, setPreviewDocIndex] = useState(0)
  const [previewChunkIndex, setPreviewChunkIndex] = useState(0)
  const [isLoadingChunkPreview, setIsLoadingChunkPreview] = useState(false)
  
  // State for processing
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({
    status: "idle",
    message: "",
    progress: 0,
    totalFiles: 0,
    processedFiles: 0
  })
  
  // State for processing timers
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null)
  const [currentFileStartTime, setCurrentFileStartTime] = useState<number | null>(null)
  const [currentFileTime, setCurrentFileTime] = useState(0)
  const [totalProcessingTime, setTotalProcessingTime] = useState(0)
  
  // State for tracking processed files (to filter "Ver Chunks" view)
  const [lastProcessedFiles, setLastProcessedFiles] = useState<string[]>([])
  
  // State for table configuration validation
  const [tableExists, setTableExists] = useState<boolean | null>(null)
  const [existingRecords, setExistingRecords] = useState<number>(0)
  
  // State for existing chunk preview (from database)
  const [showExistingPreview, setShowExistingPreview] = useState(false)
  const [existingChunkPreviews, setExistingChunkPreviews] = useState<ChunkPreview[]>([])
  const [existingPreviewPage, setExistingPreviewPage] = useState(1)
  const [existingDocIndex, setExistingDocIndex] = useState(0)
  const [existingChunkIndex, setExistingChunkIndex] = useState(0)
  const [isLoadingExistingPreview, setIsLoadingExistingPreview] = useState(false)
  const CHUNKS_PER_PAGE = 5
  
  // State for delete documents modal
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteAllDocuments, setDeleteAllDocuments] = useState(false)
  const [deleteFromVolume, setDeleteFromVolume] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  
  // State for process confirmation modal
  const [showProcessConfirmModal, setShowProcessConfirmModal] = useState(false)

  // Load environment config on mount - use base table name (without _raw or _chunks suffix)
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          // Use base table name - backend will add _raw or _chunks suffix as needed
          const baseTableName = "contracts"
          
          const newConfig = {
            catalog: config.catalog || "",
            schema: config.schema || "",
            tableName: baseTableName
          }
          setTableConfig(newConfig)
          setInitialTableConfig(newConfig) // Store initial config for cancel
          
          // Auto-save if all fields are filled from environment
          if (newConfig.catalog && newConfig.schema && newConfig.tableName) {
            setIsConfigSaved(true)
            // Mark step 1 as completed since config is auto-loaded
            setCompletedSteps(prev => new Set([...prev, 1]))
          }
        }
      } catch (error) {
        console.error("Error loading config:", error)
      }
    }
    loadConfig()
  }, [])
  
  // Auto-load documents when step 2 is active and config is saved
  useEffect(() => {
    if (activeStep === 2 && isConfigSaved && rawDocuments.length === 0 && !isLoadingDocuments) {
      loadRawDocuments()
    }
  }, [activeStep, isConfigSaved])

  // Timer update effect
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null
    
    if (processingStatus.status === "processing" && processingStartTime) {
      interval = setInterval(() => {
        const now = Date.now()
        setTotalProcessingTime(Math.floor((now - processingStartTime) / 1000))
        if (currentFileStartTime) {
          setCurrentFileTime(Math.floor((now - currentFileStartTime) / 1000))
        }
      }, 1000)
    }
    
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [processingStatus.status, processingStartTime, currentFileStartTime])

  // Load files from volume
  async function loadVolumeFiles() {
    setIsLoadingFiles(true)
    try {
      const response = await fetch("/api/documents")
      if (!response.ok) {
        throw new Error("Failed to load files")
      }
      const data = await response.json()
      setVolumeFiles(data.files || [])
      
      if (data.files?.length === 0) {
        toast.info("Nenhum arquivo encontrado no volume", {
          description: "Importe arquivos primeiro usando a página 'Importar Documentos'",
          duration: 5000
        })
      }
    } catch (error) {
      console.error("Error loading files:", error)
      toast.error("Erro ao carregar arquivos", {
        description: error instanceof Error ? error.message : "Erro desconhecido",
        duration: 5000
      })
    } finally {
      setIsLoadingFiles(false)
    }
  }

  // Check if table exists and get record count
  async function checkTableExists() {
    if (!tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName) {
      toast.warning("Configure o catálogo, schema e nome da tabela primeiro")
      return
    }
    
    setProcessingStatus(prev => ({ ...prev, status: "checking", message: "Verificando tabela..." }))
    
    try {
      const response = await fetch("/api/table/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tableConfig)
      })
      
      if (!response.ok) {
        throw new Error("Failed to check table")
      }
      
      const data = await response.json()
      setTableExists(data.exists)
      setExistingRecords(data.recordCount || 0)
      setIsConfigSaved(true)
      
      if (data.exists) {
        toast.success("Tabela encontrada!", {
          description: `${data.recordCount} registros existentes`,
          duration: 4000
        })
      } else {
        toast.info("Tabela será criada automaticamente", {
          duration: 4000
        })
      }
    } catch (error) {
      console.error("Error checking table:", error)
      toast.error("Erro ao verificar tabela", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    } finally {
      setProcessingStatus(prev => ({ ...prev, status: "idle", message: "" }))
    }
  }

  // Load documents from _raw table
  async function loadRawDocuments(loadMore = false) {
    if (!isConfigSaved) {
      toast.warning("Configure e salve a tabela primeiro")
      return
    }
    
    setIsLoadingDocuments(true)
    const newOffset = loadMore ? documentsOffset + DOCUMENTS_PER_PAGE : 0
    
    try {
      const response = await fetch("/api/raw-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog: tableConfig.catalog,
          schema_name: tableConfig.schema,
          tableName: tableConfig.tableName,
          offset: newOffset,
          limit: DOCUMENTS_PER_PAGE
        })
      })
      
      const data = await response.json()
      
      if (!data.success) {
        if (data.tableNotFound) {
          setTableNotFound(true)
          toast.warning("Tabela de documentos não encontrada", {
            description: "Importe documentos primeiro no Módulo 1 (Importar Documentos)",
            duration: 6000
          })
        } else {
          throw new Error(data.error || "Erro ao carregar documentos")
        }
        return
      }
      
      setTableNotFound(false)
      setDocumentsTotal(data.total)
      setHasMoreDocuments(data.hasMore)
      setDocumentsOffset(newOffset)
      
      if (loadMore) {
        // Append to existing documents
        setRawDocuments(prev => [...prev, ...data.documents])
      } else {
        // Replace documents
        setRawDocuments(data.documents)
      }
      
      if (data.total === 0) {
        toast.info("Nenhum documento encontrado", {
          description: "Importe documentos primeiro no Módulo 1",
          duration: 5000
        })
      }
    } catch (error) {
      console.error("Error loading raw documents:", error)
      toast.error("Erro ao carregar documentos", {
        description: error instanceof Error ? error.message : "Erro desconhecido",
        duration: 5000
      })
    } finally {
      setIsLoadingDocuments(false)
    }
  }

  // Load document raw text
  async function loadDocumentText(documentId: string) {
    setIsLoadingText(true)
    
    try {
      const response = await fetch("/api/raw-documents/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog: tableConfig.catalog,
          schema_name: tableConfig.schema,
          tableName: tableConfig.tableName,
          documentId
        })
      })
      
      if (!response.ok) {
        throw new Error("Erro ao carregar texto do documento")
      }
      
      const data = await response.json()
      
      if (data.success && data.document) {
        setSelectedDocumentText({
          id: documentId,
          fileName: data.document.fileName,
          rawText: data.document.rawText,
          textLength: data.document.textLength,
          pageCount: data.document.pageCount
        })
        setShowTextModal(true)
      }
    } catch (error) {
      console.error("Error loading document text:", error)
      toast.error("Erro ao carregar texto", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    } finally {
      setIsLoadingText(false)
    }
  }

  // Toggle document selection
  function toggleDocumentSelection(documentId: string) {
    setSelectedDocuments(prev => {
      const newSet = new Set(prev)
      if (newSet.has(documentId)) {
        newSet.delete(documentId)
      } else {
        newSet.add(documentId)
      }
      return newSet
    })
  }

  // Select all documents
  function selectAllDocuments() {
    if (selectedDocuments.size === rawDocuments.length) {
      setSelectedDocuments(new Set())
    } else {
      setSelectedDocuments(new Set(rawDocuments.map(d => d.id)))
    }
  }

  // Delete documents
  async function deleteDocuments() {
    setIsDeleting(true)
    
    try {
      const documentIds = deleteAllDocuments ? [] : Array.from(selectedDocuments)
      
      const response = await fetch("/api/raw-documents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog: tableConfig.catalog,
          schema_name: tableConfig.schema,
          tableName: tableConfig.tableName,
          documentIds,
          deleteFromVolume
        })
      })
      
      const data = await response.json()
      
      if (data.success) {
        const count = deleteAllDocuments ? documentsTotal : selectedDocuments.size
        toast.success(`${count} documento(s) removido(s)`, {
          description: deleteFromVolume 
            ? `Removidos da tabela e do volume (${data.deletedFilesCount} arquivos)`
            : "Documentos e segmentos removidos",
          duration: 5000
        })
        
        // Reset selection and reload
        setSelectedDocuments(new Set())
        setShowDeleteModal(false)
        setDeleteFromVolume(false)
        setDeleteAllDocuments(false)
        
        // Reload documents
        await loadRawDocuments()
      } else {
        throw new Error(data.errors?.join(", ") || "Erro ao deletar documentos")
      }
    } catch (error) {
      console.error("Error deleting documents:", error)
      toast.error("Erro ao deletar documentos", {
        description: error instanceof Error ? error.message : "Erro desconhecido",
        duration: 5000
      })
    } finally {
      setIsDeleting(false)
    }
  }

  // Open delete modal
  function openDeleteModal(all: boolean) {
    setDeleteAllDocuments(all)
    setDeleteFromVolume(false)
    setShowDeleteModal(true)
  }

  // Load chunking preview from backend
  async function loadChunkingPreview() {
    if (selectedDocuments.size === 0) {
      toast.warning("Selecione pelo menos um documento para visualizar a prévia")
      return
    }
    
    setIsLoadingChunkPreview(true)
    setPreviewDocIndex(0)
    setPreviewChunkIndex(0)
    
    try {
      // Get up to 3 document IDs for preview
      const docIds = Array.from(selectedDocuments).slice(0, 3)
      
      const response = await fetch("/api/chunking/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog: tableConfig.catalog,
          schema_name: tableConfig.schema,
          tableName: tableConfig.tableName,
          documentIds: docIds,
          strategy: selectedStrategy,
          chunkSize: chunkingParams.chunkSize,
          chunkOverlap: chunkingParams.chunkOverlap,
          separatorType: chunkingParams.separatorType,
          customSeparator: chunkingParams.customSeparator
        })
      })
      
      if (!response.ok) {
        throw new Error("Erro ao gerar prévia de chunking")
      }
      
      const data = await response.json()
      
      if (data.success && data.documents) {
        setChunkPreviewData(data.documents)
        setShowChunkingPreview(true)
        
        // Calculate total chunks across all documents
        const totalChunks = data.documents.reduce((sum: number, doc: ChunkPreviewData) => sum + doc.totalChunks, 0)
        toast.success(`Prévia gerada: ${totalChunks} segmentos em ${data.documents.length} documento(s)`, {
          duration: 4000
        })
      }
    } catch (error) {
      console.error("Error loading chunking preview:", error)
      toast.error("Erro ao gerar prévia", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    } finally {
      setIsLoadingChunkPreview(false)
    }
  }

  // Toggle file selection
  function toggleFileSelection(fileName: string) {
    setSelectedFiles(prev => {
      const newSet = new Set(prev)
      if (newSet.has(fileName)) {
        newSet.delete(fileName)
      } else {
        newSet.add(fileName)
      }
      return newSet
    })
  }

  // Select all files
  function selectAllFiles() {
    if (selectedFiles.size === volumeFiles.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(volumeFiles.map(f => f.name)))
    }
  }

  // Start processing
  async function startProcessing() {
    if (selectedDocuments.size === 0) {
      toast.warning("Selecione pelo menos um documento para processar")
      return
    }
    
    if (!isConfigSaved) {
      toast.warning("Salve a configuração da tabela primeiro")
      return
    }
    
    // Always proceed with processing - will delete existing chunks and create new ones
    await executeProcessing()
  }

  // Execute the actual processing - file by file
  // Always deletes existing chunks for selected documents and creates new ones
  async function executeProcessing() {
    
    const strategy = CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)
    // Get file names from selected document IDs
    const selectedDocs = rawDocuments.filter(d => selectedDocuments.has(d.id))
    const filesToProcess = selectedDocs.map(d => d.fileName)
    
    // Initialize timers
    const startTime = Date.now()
    setProcessingStartTime(startTime)
    setCurrentFileStartTime(startTime)
    setCurrentFileTime(0)
    setTotalProcessingTime(0)
    
    setProcessingStatus({
      status: "processing",
      message: "Inicializando tabelas...",
      progress: 0,
      totalFiles: filesToProcess.length,
      processedFiles: 0
    })
    
    try {
      // Step 1: Initialize tables (always overwrite mode - delete existing chunks and create new)
      const initResponse = await fetch("/api/process/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          files: filesToProcess,
          strategy: selectedStrategy,
          params: { ...strategy?.params, ...chunkingParams }
        })
      })
      
      if (!initResponse.ok) {
        const error = await initResponse.json()
        throw new Error(error.detail || "Falha ao inicializar tabelas")
      }
      
      const initResult = await initResponse.json()
      const actualFilesToProcess = initResult.filesToProcess || filesToProcess
      
      if (initResult.skippedFiles?.length > 0) {
        toast.info(`${initResult.skippedFiles.length} arquivo(s) já processado(s), serão pulados`, {
          duration: 4000
        })
      }
      
      if (actualFilesToProcess.length === 0) {
        setProcessingStatus({
          status: "completed",
          message: "Nenhum arquivo novo para processar",
          progress: 100,
          totalFiles: filesToProcess.length,
          processedFiles: filesToProcess.length
        })
        return
      }
      
      // Step 2: Process each file individually
      let processedCount = 0
      let totalChunks = 0
      const errors: Array<{ file: string; error: string }> = []
      const totalFiles = actualFilesToProcess.length
      
      for (let i = 0; i < totalFiles; i++) {
        const fileName = actualFilesToProcess[i]
        const fileNumber = i + 1
        
        // Reset file timer for each new file
        setCurrentFileStartTime(Date.now())
        setCurrentFileTime(0)
        
        // Update status BEFORE processing - show which file is being processed
        setProcessingStatus({
          status: "processing",
          message: `Processando arquivo ${fileNumber} de ${totalFiles}: ${fileName}`,
          progress: Math.round((i / totalFiles) * 100),
          totalFiles: totalFiles,
          processedFiles: processedCount
        })
        
        try {
          const fileResponse = await fetch("/api/process/file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tableConfig,
              fileName,
              strategy: selectedStrategy,
              params: { ...strategy?.params, ...chunkingParams }
            })
          })
          
          if (!fileResponse.ok) {
            const error = await fileResponse.json()
            throw new Error(error.detail || "Falha ao processar arquivo")
          }
          
          const fileResult = await fileResponse.json()
          
          if (fileResult.success) {
            processedCount++
            totalChunks += fileResult.chunksCreated || 0
            
            // Update progress AFTER processing - show completion
            setProcessingStatus({
              status: "processing",
              message: `✓ ${fileName} - ${fileResult.chunksCreated} segmentos criados`,
              progress: Math.round((fileNumber / totalFiles) * 100),
              totalFiles: totalFiles,
              processedFiles: processedCount
            })
            
            toast.success(`Arquivo ${fileNumber}/${totalFiles}: ${fileName}`, {
              description: `${fileResult.textLength?.toLocaleString() || 0} caracteres → ${fileResult.chunksCreated} segmentos`,
              duration: 3000
            })
          } else {
            errors.push({ file: fileName, error: fileResult.error || "Erro desconhecido" })
            
            // Update progress even on error
            setProcessingStatus({
              status: "processing",
              message: `✗ Erro em ${fileName}`,
              progress: Math.round((fileNumber / totalFiles) * 100),
              totalFiles: totalFiles,
              processedFiles: processedCount
            })
            
            toast.error(`Erro no arquivo ${fileNumber}/${totalFiles}`, {
              description: `${fileName}: ${fileResult.error}`,
              duration: 5000
            })
          }
        } catch (fileError) {
          const errorMsg = fileError instanceof Error ? fileError.message : "Erro desconhecido"
          errors.push({ file: fileName, error: errorMsg })
          
          // Update progress even on exception
          setProcessingStatus({
            status: "processing",
            message: `✗ Erro em ${fileName}`,
            progress: Math.round((fileNumber / totalFiles) * 100),
            totalFiles: totalFiles,
            processedFiles: processedCount
          })
          
          toast.error(`Erro no arquivo ${fileNumber}/${totalFiles}`, {
            description: `${fileName}: ${errorMsg}`,
            duration: 5000
          })
        }
      }
      
      // Final status
      const success = errors.length === 0
      
      // Save the list of successfully processed files (those without errors)
      const successfullyProcessed = actualFilesToProcess.filter(
        (f: string) => !errors.some(e => e.file === f)
      )
      setLastProcessedFiles(successfullyProcessed)
      
      setProcessingStatus({
        status: success ? "completed" : "error",
        message: success 
          ? `Processamento concluído! ${totalChunks} segmentos criados em ${processedCount} arquivo(s).`
          : `Concluído com ${errors.length} erro(s). ${totalChunks} segmentos criados.`,
        progress: 100,
        totalFiles: actualFilesToProcess.length,
        processedFiles: processedCount
      })
      
      if (success) {
        toast.success("Processamento concluído!", {
          description: `${processedCount} arquivos processados, ${totalChunks} segmentos criados`,
          duration: 6000
        })
      }
      
      // Refresh file list to show imported status
      await loadVolumeFiles()
      
      // Update table info with total chunks created
      setExistingRecords(totalChunks)
      
    } catch (error) {
      console.error("Processing error:", error)
      setProcessingStatus({
        status: "error",
        message: error instanceof Error ? error.message : "Erro no processamento",
        progress: 0,
        totalFiles: filesToProcess.length,
        processedFiles: 0
      })
      
      toast.error("Erro no processamento", {
        description: error instanceof Error ? error.message : "Erro desconhecido",
        duration: 6000
      })
    }
  }

  // Load existing chunk previews from database (filtered by last processed files)
  async function loadExistingChunkPreviews() {
    setIsLoadingExistingPreview(true)
    try {
      const response = await fetch("/api/chunks/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          limit: 100,
          fileNames: lastProcessedFiles.length > 0 ? lastProcessedFiles : undefined
        })
      })
      
      if (!response.ok) {
        throw new Error("Failed to load previews")
      }
      
      const data = await response.json()
      setExistingChunkPreviews(data.chunks || [])
      setShowExistingPreview(true)
      setExistingPreviewPage(1)
      setExistingDocIndex(0)
      setExistingChunkIndex(0)
      
    } catch (error) {
      console.error("Error loading previews:", error)
      toast.error("Erro ao carregar preview", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    } finally {
      setIsLoadingExistingPreview(false)
    }
  }

  // Get unique documents from existing previews (database chunks)
  const uniqueExistingDocuments = [...new Set(existingChunkPreviews.map(c => c.documentName))]
  const currentExistingDocChunks = existingChunkPreviews.filter(c => c.documentName === uniqueExistingDocuments[existingDocIndex])
  const totalExistingChunks = currentExistingDocChunks.length
  const currentExistingChunk = currentExistingDocChunks[existingChunkIndex]

  return (
    <>
      <Toaster position="top-right" richColors closeButton />
      
      {/* Chunking Preview Modal */}
      {showChunkingPreview && chunkPreviewData.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-[var(--color-text)]">
                  {t("prepare.preview.title")}
                </h3>
                <p className="text-sm text-gray-600">
                  Ajuste a estratégia e visualize os resultados antes de processar
                </p>
              </div>
              <button
                onClick={() => setShowChunkingPreview(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XCircle className="h-6 w-6" />
              </button>
            </div>

            {/* Strategy controls */}
            <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Estratégia:</span>
                  <select
                    value={selectedStrategy}
                    onChange={(e) => setSelectedStrategy(e.target.value)}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                  >
                    {CHUNKING_STRATEGIES.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                
                {selectedStrategy !== "by_page" && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">Tamanho:</span>
                      <input
                        type="number"
                        value={chunkingParams.chunkSize}
                        onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkSize: parseInt(e.target.value) || 500 }))}
                        min={100}
                        max={4000}
                        step={100}
                        className="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">Sobreposição:</span>
                      <input
                        type="number"
                        value={chunkingParams.chunkOverlap}
                        onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkOverlap: parseInt(e.target.value) || 0 }))}
                        min={0}
                        max={500}
                        step={50}
                        className="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                      />
                    </div>
                  </>
                )}
                
                <button
                  onClick={() => {
                    setPreviewDocIndex(0)
                    setPreviewChunkIndex(0)
                    loadChunkingPreview()
                  }}
                  disabled={isLoadingChunkPreview}
                  className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoadingChunkPreview ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Atualizar Prévia
                </button>
              </div>
            </div>

            {/* Document selector */}
            <div className="px-6 py-3 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-700">Documento:</span>
                <div className="flex gap-1">
                  {chunkPreviewData.map((doc, idx) => (
                    <button
                      key={doc.id}
                      onClick={() => {
                        setPreviewDocIndex(idx)
                        setPreviewChunkIndex(0)
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                        previewDocIndex === idx
                          ? "bg-[var(--color-primary)] text-white"
                          : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-100"
                      }`}
                    >
                      Doc {idx + 1}
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500 ml-2 truncate max-w-sm">
                  {chunkPreviewData[previewDocIndex]?.fileName}
                </span>
              </div>
            </div>

            {/* Chunk navigation */}
            {chunkPreviewData[previewDocIndex] && (
              <div className="px-6 py-3 border-b border-gray-200 flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  Segmento {previewChunkIndex + 1} de {chunkPreviewData[previewDocIndex].totalChunks}
                  {chunkPreviewData[previewDocIndex].totalChunks > 10 && (
                    <span className="text-xs text-gray-400 ml-1">(mostrando até 10)</span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPreviewChunkIndex(Math.max(0, previewChunkIndex - 1))}
                    disabled={previewChunkIndex === 0}
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => setPreviewChunkIndex(Math.min(
                      chunkPreviewData[previewDocIndex].chunks.length - 1,
                      previewChunkIndex + 1
                    ))}
                    disabled={previewChunkIndex >= chunkPreviewData[previewDocIndex].chunks.length - 1}
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              </div>
            )}

            {/* Chunk content - larger and scrollable */}
            <div className="flex-1 overflow-y-auto p-6">
              {chunkPreviewData[previewDocIndex] && (
                <div className="bg-gray-50 rounded-lg border border-gray-200 h-full flex flex-col">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <span className="text-sm font-medium text-[var(--color-primary)]">
                      Segmento #{previewChunkIndex + 1}
                    </span>
                    <span className="text-sm text-gray-500">
                      {chunkPreviewData[previewDocIndex].chunks[previewChunkIndex]?.length || 0} caracteres
                    </span>
                  </div>
                  <pre className="flex-1 whitespace-pre-wrap text-sm text-gray-700 font-mono p-4 overflow-y-auto min-h-[300px] max-h-[50vh]">
                    {chunkPreviewData[previewDocIndex].chunks[previewChunkIndex]?.content || ""}
                  </pre>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
              <span className="text-sm text-gray-500">
                Total: {chunkPreviewData.reduce((sum, doc) => sum + doc.totalChunks, 0)} segmentos em {chunkPreviewData.length} documento(s)
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowChunkingPreview(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  {t("common.close")}
                </button>
                <button
                  onClick={() => {
                    setShowChunkingPreview(false)
                    setShowProcessConfirmModal(true)
                  }}
                  disabled={processingStatus.status === "processing"}
                  className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  <Play className="h-4 w-4" />
                  {t("prepare.step3.confirmProcess")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing Chunk Preview Modal (from database) */}
      {showExistingPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-[var(--color-text)]">
                  {t("prepare.preview.generatedTitle")}
                </h3>
                <p className="text-sm text-gray-600">
                  {uniqueExistingDocuments.length} documento(s), {existingChunkPreviews.length} segmentos no total
                </p>
              </div>
              <button
                onClick={() => setShowExistingPreview(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XCircle className="h-6 w-6" />
              </button>
            </div>

            {/* Document selector */}
            <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium text-gray-700">Documento:</span>
                <div className="flex gap-1 flex-wrap">
                  {uniqueExistingDocuments.map((docName, idx) => (
                    <button
                      key={docName}
                      onClick={() => {
                        setExistingDocIndex(idx)
                        setExistingChunkIndex(0)
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                        existingDocIndex === idx
                          ? "bg-[var(--color-primary)] text-white"
                          : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-100"
                      }`}
                      title={docName}
                    >
                      Doc {idx + 1}
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500 truncate max-w-md">
                  {uniqueExistingDocuments[existingDocIndex]}
                </span>
              </div>
            </div>

            {/* Chunk navigation */}
            {currentExistingChunk && (
              <div className="px-6 py-3 border-b border-gray-200 flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  Segmento {existingChunkIndex + 1} de {totalExistingChunks}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExistingChunkIndex(Math.max(0, existingChunkIndex - 1))}
                    disabled={existingChunkIndex === 0}
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => setExistingChunkIndex(Math.min(totalExistingChunks - 1, existingChunkIndex + 1))}
                    disabled={existingChunkIndex >= totalExistingChunks - 1}
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              </div>
            )}

            {/* Chunk content */}
            <div className="flex-1 overflow-y-auto p-6">
              {currentExistingChunk ? (
                <div className="bg-gray-50 rounded-lg border border-gray-200 h-full flex flex-col">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <span className="text-sm font-medium text-[var(--color-primary)]">
                      Segmento #{existingChunkIndex + 1}
                    </span>
                    <span className="text-sm text-gray-500">
                      {currentExistingChunk.content?.length || 0} caracteres
                    </span>
                  </div>
                  <pre className="flex-1 whitespace-pre-wrap text-sm text-gray-700 font-mono p-4 overflow-y-auto min-h-[300px] max-h-[50vh]">
                    {currentExistingChunk.content || ""}
                  </pre>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  Nenhum segmento disponível para visualização
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
              <span className="text-sm text-gray-500">
                Documento {existingDocIndex + 1} de {uniqueExistingDocuments.length} • 
                {" "}{currentExistingDocChunks.length} segmentos neste documento
              </span>
              <button
                onClick={() => setShowExistingPreview(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-text)]">{t("prepare.title")}</h1>
          <p className="mt-2 text-base text-gray-600">
            {t("prepare.subtitle")}
          </p>
        </div>

        {/* Step 1: Table Configuration */}
        <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
          activeStep === 1 ? 'border-[var(--color-primary)]' : 'border-gray-200'
        }`}>
          <button
            onClick={() => setActiveStep(activeStep === 1 ? null : 1)}
            className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              {completedSteps.has(1) ? (
                <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
              ) : (
                <Database className="h-5 w-5 text-[var(--color-primary)]" />
              )}
              <h2 className="text-lg font-semibold text-[var(--color-text)]">{t("prepare.step1.title")}</h2>
            </div>
            <div className="flex items-center gap-2">
              {completedSteps.has(1) && (
                <span className="text-sm text-[var(--color-success)]">{t("prepare.step2.completed")}</span>
              )}
              <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${activeStep === 1 ? 'rotate-90' : ''}`} />
            </div>
          </button>
          
          {activeStep === 1 && (
            <div className="p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("common.catalog")}
                  </label>
                  <input
                    type="text"
                    value={tableConfig.catalog}
                    onChange={(e) => {
                      setTableConfig(prev => ({ ...prev, catalog: e.target.value }))
                      setIsConfigSaved(false)
                      setCompletedSteps(prev => { const newSet = new Set(prev); newSet.delete(1); return newSet })
                    }}
                    placeholder="ex: fabio_goncalves"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("common.schema")}
                  </label>
                  <input
                    type="text"
                    value={tableConfig.schema}
                    onChange={(e) => {
                      setTableConfig(prev => ({ ...prev, schema: e.target.value }))
                      setIsConfigSaved(false)
                      setCompletedSteps(prev => { const newSet = new Set(prev); newSet.delete(1); return newSet })
                    }}
                    placeholder="ex: customer_cielo"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("common.tableName")}
                  </label>
                  <input
                    type="text"
                    value={tableConfig.tableName}
                    onChange={(e) => {
                      setTableConfig(prev => ({ ...prev, tableName: e.target.value }))
                      setIsConfigSaved(false)
                      setCompletedSteps(prev => { const newSet = new Set(prev); newSet.delete(1); return newSet })
                    }}
                    placeholder="ex: contracts"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                  />
                </div>
              </div>

              {/* Preview das tabelas que serão criadas/usadas */}
              {tableConfig.tableName && (
                <div className="mt-3 p-3 bg-[var(--color-accent-light)] border border-[var(--color-accent-lighter)] rounded-lg">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium text-[var(--color-accent)] mb-1">Tabela que será criada:</p>
                      <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                        {tableConfig.catalog || "catalogo"}.{tableConfig.schema || "schema"}.{tableConfig.tableName}_chunks
                      </code>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--color-accent)] mb-1">Tabela que será utilizada:</p>
                      <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                        {initialTableConfig.catalog || "catalogo"}.{initialTableConfig.schema || "schema"}.{initialTableConfig.tableName}_raw
                      </code>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isConfigSaved && (
                    <span className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                      <CheckCircle2 className="h-4 w-4" />
                      {t("prepare.step1.configValid")}
                    </span>
                  )}
                </div>
                
                <div className="flex items-center gap-3">
                  {!isConfigSaved ? (
                    <>
                      <button
                        onClick={() => {
                          setTableConfig(initialTableConfig)
                        }}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2"
                      >
                        <X className="h-4 w-4" />
                        {t("common.cancel")}
                      </button>
                      <button
                        onClick={async () => {
                          await checkTableExists()
                        }}
                        disabled={processingStatus.status === "checking" || !tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName}
                        className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {processingStatus.status === "checking" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        {t("common.verifySave")}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setCompletedSteps(prev => new Set([...prev, 1]))
                        setActiveStep(2)
                      }}
                      className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm flex items-center gap-2"
                    >
                      {t("common.next")}
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Step 2: Select Documents from _raw table */}
        <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
          activeStep === 2 ? 'border-[var(--color-primary)]' : 'border-gray-200'
        }`}>
          <button
            onClick={() => setActiveStep(activeStep === 2 ? null : 2)}
            disabled={!completedSteps.has(1) && !isConfigSaved}
            className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              {completedSteps.has(2) ? (
                <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
              ) : (
                <FileText className="h-5 w-5 text-[var(--color-primary)]" />
              )}
              <h2 className="text-lg font-semibold text-[var(--color-text)]">{t("prepare.step2.title")}</h2>
            </div>
            <div className="flex items-center gap-3">
              {selectedDocuments.size > 0 && (
                <span className="text-sm text-[var(--color-primary)] font-medium">
                  {selectedDocuments.size} selecionado(s)
                </span>
              )}
              {completedSteps.has(2) && (
                <span className="text-sm text-[var(--color-success)] font-medium">Concluído</span>
              )}
              <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${activeStep === 2 ? 'rotate-90' : ''}`} />
            </div>
          </button>
          
          {activeStep === 2 && (
            <div className="p-4">
              {!isConfigSaved ? (
                <div className="text-center py-8">
                  <AlertCircle className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">Configure e salve a tabela primeiro</p>
                </div>
              ) : tableNotFound ? (
                <div className="text-center py-8">
                  <AlertCircle className="h-12 w-12 text-[var(--color-warning)] mx-auto mb-3" />
                  <p className="text-gray-700 font-medium">Tabela de documentos não encontrada</p>
                  <p className="text-gray-500 text-sm mt-1">
                    Importe documentos primeiro no Módulo 1 (Importar Documentos)
                  </p>
                  <button
                    onClick={() => loadRawDocuments()}
                    className="mt-3 text-sm text-[var(--color-primary)] hover:text-[var(--color-primary)]/80 font-medium"
                  >
                    Tentar novamente
                  </button>
                </div>
              ) : rawDocuments.length === 0 && !isLoadingDocuments ? (
                <div className="text-center py-8">
                  <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">Nenhum documento na tabela</p>
                  <button
                    onClick={() => loadRawDocuments()}
                    className="mt-3 text-sm text-[var(--color-primary)] hover:text-[var(--color-primary)]/80 font-medium"
                  >
                    Carregar documentos
                  </button>
                </div>
              ) : (
                <>
                  {/* Header with select all and count */}
                  <div className="flex items-center justify-between mb-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rawDocuments.length > 0 && selectedDocuments.size === rawDocuments.length}
                        onChange={selectAllDocuments}
                        className="w-4 h-4 text-[var(--color-primary)] border-gray-300 rounded focus:ring-[var(--color-primary)]"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        Selecionar todos ({rawDocuments.length})
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">
                        {selectedDocuments.size} de {documentsTotal} selecionado(s)
                      </span>
                      
                      {/* Delete selected button */}
                      {selectedDocuments.size > 0 && (
                        <button
                          onClick={() => openDeleteModal(false)}
                          className="px-3 py-1.5 text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] border border-[var(--color-primary-lighter)] rounded-lg hover:bg-[var(--color-primary-lighter)] transition-colors flex items-center gap-1"
                          title={`Remover ${selectedDocuments.size} selecionado(s)`}
                        >
                          <Trash2 className="h-4 w-4" />
                          {t("prepare.step2.removeSelected")}
                        </button>
                      )}
                      
                      {/* Delete all button */}
                      {rawDocuments.length > 0 && selectedDocuments.size === 0 && (
                        <button
                          onClick={() => openDeleteModal(true)}
                          className="px-3 py-1.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:opacity-90 transition-colors flex items-center gap-1"
                          title={t("prepare.step2.removeAll")}
                        >
                          <Trash2 className="h-4 w-4" />
                          {t("prepare.step2.removeAll")}
                        </button>
                      )}
                      
                      <button
                        onClick={() => loadRawDocuments()}
                        disabled={isLoadingDocuments}
                        className="p-1.5 text-gray-500 hover:text-gray-700 transition-colors"
                        title="Atualizar lista"
                      >
                        <RefreshCw className={`h-4 w-4 ${isLoadingDocuments ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>
                  
                  {/* Documents table */}
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* Table header */}
                    <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-gray-100 text-xs font-medium text-gray-600 uppercase tracking-wide">
                      <div className="col-span-1"></div>
                      <div className="col-span-5">Documento</div>
                      <div className="col-span-2 text-right">Caracteres</div>
                      <div className="col-span-2 text-right">Páginas</div>
                      <div className="col-span-2 text-center">Texto</div>
                    </div>
                    
                    {/* Table body */}
                    <div className="divide-y divide-gray-100">
                      {rawDocuments.map((doc) => (
                        <div
                          key={doc.id}
                          className={`grid grid-cols-12 gap-2 px-4 py-3 items-center transition-colors ${
                            selectedDocuments.has(doc.id) ? "bg-[var(--color-primary-light)]" : "hover:bg-gray-50"
                          }`}
                        >
                          <div className="col-span-1">
                            <input
                              type="checkbox"
                              checked={selectedDocuments.has(doc.id)}
                              onChange={() => toggleDocumentSelection(doc.id)}
                              className="w-4 h-4 text-[var(--color-primary)] border-gray-300 rounded focus:ring-[var(--color-primary)]"
                            />
                          </div>
                          <div className="col-span-5 flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                            <span className="text-sm font-medium text-gray-900 truncate" title={doc.fileName}>
                              {doc.fileName}
                            </span>
                          </div>
                          <div className="col-span-2 text-right">
                            <span className="text-sm text-gray-600">
                              {doc.textLength?.toLocaleString() || 0}
                            </span>
                          </div>
                          <div className="col-span-2 text-right">
                            <span className="text-sm text-gray-600">
                              {doc.pageCount || '-'}
                            </span>
                          </div>
                          <div className="col-span-2 text-center">
                            <button
                              onClick={() => loadDocumentText(doc.id)}
                              disabled={isLoadingText}
                              className={`p-1.5 rounded transition-colors ${
                                viewedDocuments.has(doc.id)
                                  ? "text-[var(--color-success)] bg-[var(--color-success-light)]"
                                  : "text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]"
                              }`}
                              title={viewedDocuments.has(doc.id) ? "Texto visualizado" : "Ver texto extraído"}
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Load more button */}
                  {hasMoreDocuments && (
                    <div className="mt-4 text-center">
                      <button
                        onClick={() => loadRawDocuments(true)}
                        disabled={isLoadingDocuments}
                        className="px-4 py-2 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary-light)] transition-colors flex items-center gap-2 mx-auto"
                      >
                        {isLoadingDocuments ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        Carregar mais ({documentsTotal - rawDocuments.length} restantes)
                      </button>
                    </div>
                  )}
                  
                  {/* Loading indicator */}
                  {isLoadingDocuments && rawDocuments.length === 0 && (
                    <div className="text-center py-8">
                      <Loader2 className="h-8 w-8 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
                      <p className="text-sm text-gray-500">Carregando documentos...</p>
                    </div>
                  )}
                  
                  {/* Next button */}
                  {rawDocuments.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
                      <span className="text-sm text-gray-500">
                        {selectedDocuments.size} de {documentsTotal} documento(s) selecionado(s)
                      </span>
                      <button
                        onClick={() => {
                          if (selectedDocuments.size === 0) {
                            toast.warning("Selecione pelo menos um documento para continuar")
                            return
                          }
                          setCompletedSteps(prev => new Set([...prev, 2]))
                          setActiveStep(3)
                        }}
                        disabled={selectedDocuments.size === 0}
                        className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        Próximo
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        
        {/* Delete Confirmation Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-[var(--color-primary-lighter)] rounded-full">
                  <Trash2 className="h-6 w-6 text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-[var(--color-text)]">
                  {t("prepare.delete.title")}
                </h3>
              </div>
              
              <p className="text-base text-gray-600 mb-4">
                {deleteAllDocuments 
                  ? `Você está prestes a remover todos os ${documentsTotal} documento(s) das tabelas.`
                  : `Você está prestes a remover ${selectedDocuments.size} documento(s) selecionado(s).`
                }
              </p>
              
              <div className="bg-[var(--color-warning-light)] border border-[var(--color-warning)] rounded-lg p-3 mb-4">
                <p className="text-sm text-[var(--color-warning)]">
                  <strong>Atenção:</strong> Esta ação irá remover os documentos da tabela <code className="bg-[var(--color-warning-light)] px-1 rounded">_raw</code> e 
                  os segmentos correspondentes.
                </p>
              </div>
              
              <label className="flex items-center gap-2 mb-6 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteFromVolume}
                  onChange={(e) => setDeleteFromVolume(e.target.checked)}
                  className="w-4 h-4 text-[var(--color-primary)] border-gray-300 rounded focus:ring-[var(--color-primary)]"
                />
                <span className="text-sm text-gray-700">
                  Também remover os arquivos PDF do volume
                </span>
              </label>
              
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowDeleteModal(false)
                    setDeleteFromVolume(false)
                    setDeleteAllDocuments(false)
                  }}
                  disabled={isDeleting}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={deleteDocuments}
                  disabled={isDeleting}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Removendo...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4" />
                      Remover {deleteAllDocuments ? "todos" : selectedDocuments.size}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Process Confirmation Modal */}
        {showProcessConfirmModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-[var(--color-warning-light)] rounded-full">
                  <AlertCircle className="h-6 w-6 text-[var(--color-warning)]" />
                </div>
                <h3 className="text-xl font-bold text-[var(--color-text)]">
                  {t("prepare.processing.title")}
                </h3>
              </div>
              
              <p className="text-base text-gray-600 mb-4">
                Você está prestes a processar <strong>{selectedDocuments.size}</strong> documento(s) 
                com a estratégia <strong>{CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)?.name}</strong>.
              </p>
              
              <div className="bg-[var(--color-warning-light)] border border-[var(--color-warning)] rounded-lg p-3 mb-6">
                <p className="text-sm text-[var(--color-warning)]">
                  <strong>Atenção:</strong> Os segmentos existentes serão 
                  <strong> apagados</strong> e novos segmentos serão gerados com a estratégia selecionada.
                </p>
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setShowProcessConfirmModal(false)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => {
                    setShowProcessConfirmModal(false)
                    setCompletedSteps(prev => new Set([...prev, 3]))
                    setActiveStep(null)
                    startProcessing()
                  }}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors flex items-center justify-center gap-2"
                >
                  <Play className="h-4 w-4" />
                  {t("common.confirm")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Text Preview Modal */}
        {showTextModal && selectedDocumentText && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-[var(--color-text)]">Texto Extraído</h3>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {selectedDocumentText.fileName}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-sm text-gray-500">
                    {selectedDocumentText.textLength.toLocaleString()} caracteres • {selectedDocumentText.pageCount} página(s)
                  </div>
                  <button
                    onClick={() => {
                      // Mark document as viewed
                      if (selectedDocumentText?.id) {
                        setViewedDocuments(prev => new Set([...prev, selectedDocumentText.id]))
                      }
                      setShowTextModal(false)
                      setSelectedDocumentText(null)
                    }}
                    className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <XCircle className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-6">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono bg-gray-50 p-4 rounded-lg">
                  {selectedDocumentText.rawText}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Chunking Strategy */}
        <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
          activeStep === 3 ? 'border-[var(--color-primary)]' : 'border-gray-200'
        }`}>
          <button
            onClick={() => setActiveStep(activeStep === 3 ? null : 3)}
            disabled={!completedSteps.has(2)}
            className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              {completedSteps.has(3) ? (
                <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
              ) : (
                <Layers className="h-5 w-5 text-[var(--color-primary)]" />
              )}
              <h2 className="text-lg font-semibold text-[var(--color-text)]">{t("prepare.step3.title")}</h2>
            </div>
            <div className="flex items-center gap-2">
              {completedSteps.has(3) && (
                <span className="text-sm text-[var(--color-success)]">{t("prepare.step2.completed")}</span>
              )}
              {selectedStrategy && !completedSteps.has(3) && (
                <span className="text-sm text-gray-500">
                  {CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)?.name}
                </span>
              )}
              <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${activeStep === 3 ? 'rotate-90' : ''}`} />
            </div>
          </button>
          
          {activeStep === 3 && (
          <div className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {CHUNKING_STRATEGIES.map((strategy) => (
                <button
                  key={strategy.id}
                  onClick={() => {
                    setSelectedStrategy(strategy.id)
                    if (strategy.params.chunkSize) {
                      setChunkingParams(prev => ({ ...prev, chunkSize: strategy.params.chunkSize! }))
                    }
                    if (strategy.params.chunkOverlap !== undefined) {
                      setChunkingParams(prev => ({ ...prev, chunkOverlap: strategy.params.chunkOverlap! }))
                    }
                  }}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    selectedStrategy === strategy.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div className="font-semibold text-[var(--color-text)] mb-1">{strategy.name}</div>
                  <div className="text-xs text-gray-600">{strategy.description}</div>
                </button>
              ))}
            </div>
            
            {/* Chunking Parameters */}
            {selectedStrategy !== "by_page" && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Parâmetros</h3>
                
                {/* Separator controls for by_separator strategy */}
                {selectedStrategy === "by_separator" && (
                  <div className="mb-4 p-3 bg-gray-50 rounded-lg">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Tipo de Separador
                    </label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                      {SEPARATOR_TYPES.map((sep) => (
                        <button
                          key={sep.id}
                          onClick={() => setChunkingParams(prev => ({ 
                            ...prev, 
                            separatorType: sep.id,
                            customSeparator: sep.id === "custom" ? prev.customSeparator : ""
                          }))}
                          className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                            chunkingParams.separatorType === sep.id
                              ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                              : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"
                          }`}
                        >
                          {sep.name}
                        </button>
                      ))}
                    </div>
                    
                    {/* Custom separator input */}
                    {chunkingParams.separatorType === "custom" && (
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">
                          Separador personalizado
                        </label>
                        <input
                          type="text"
                          value={chunkingParams.customSeparator}
                          onChange={(e) => setChunkingParams(prev => ({ ...prev, customSeparator: e.target.value }))}
                          placeholder="Ex: --- ou ### ou ;"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Dica: Use \n para linha, \n\n para parágrafo, ou qualquer texto
                        </p>
                      </div>
                    )}
                    
                    <p className="mt-2 text-xs text-gray-500">
                      ⚡ Fallback automático: se não encontrar o separador, tentará: parágrafo → linha → ponto → espaço
                    </p>
                  </div>
                )}
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Tamanho máximo do segmento (caracteres)
                    </label>
                    <input
                      type="number"
                      value={chunkingParams.chunkSize}
                      onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkSize: parseInt(e.target.value) || 1000 }))}
                      min={100}
                      max={10000}
                      step={100}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                    />
                    {selectedStrategy === "by_separator" && (
                      <p className="mt-1 text-xs text-gray-500">
                        Se um bloco ultrapassar este limite, será subdividido
                      </p>
                    )}
                  </div>
                  {selectedStrategy !== "semantic" && selectedStrategy !== "by_separator" && (
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">
                        Sobreposição (caracteres)
                      </label>
                      <input
                        type="number"
                        value={chunkingParams.chunkOverlap}
                        onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkOverlap: parseInt(e.target.value) || 0 }))}
                        min={0}
                        max={500}
                        step={50}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* Preview button */}
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={loadChunkingPreview}
                  disabled={isLoadingChunkPreview || selectedDocuments.size === 0}
                  className="px-4 py-2 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary-light)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoadingChunkPreview ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                    {t("prepare.step3.preview")}
                </button>
                <span className="text-sm text-gray-500">
                  {CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)?.name}
                  {selectedStrategy !== "by_page" && (
                    <> • {chunkingParams.chunkSize} chars, {chunkingParams.chunkOverlap} sobreposição</>
                  )}
                </span>
              </div>
              <button
                onClick={() => setShowProcessConfirmModal(true)}
                disabled={processingStatus.status === "processing" || selectedDocuments.size === 0}
                className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {processingStatus.status === "processing" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processando...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Confirmar e Processar
                  </>
                )}
              </button>
            </div>
            
          </div>
          )}
        </div>

        {/* Processing Status */}
        {processingStatus.status !== "idle" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
            {processingStatus.status === "completed" ? (
              <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
            ) : processingStatus.status === "error" ? (
              <XCircle className="h-5 w-5 text-red-600" />
            ) : (
              <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin" />
            )}
            <h2 className="text-lg font-semibold text-[var(--color-text)]">
              {processingStatus.status === "completed" ? "Processamento Concluído" :
               processingStatus.status === "error" ? "Erro no Processamento" :
               "Processando..."}
            </h2>
          </div>
          
          <div className="p-4">
            {/* Status Display */}
            <div className={`mb-4 p-4 rounded-lg ${
              processingStatus.status === "completed" ? "bg-[var(--color-success-light)] border border-[var(--color-success-lighter)]" :
              processingStatus.status === "error" ? "bg-[var(--color-primary-light)] border border-[var(--color-primary-lighter)]" :
              "bg-[var(--color-accent-light)] border border-[var(--color-accent-lighter)]"
            }`}>
              <div className="flex items-center gap-2">
                {processingStatus.status === "processing" && (
                  <Loader2 className="h-5 w-5 text-[var(--color-accent)] animate-spin" />
                )}
                {processingStatus.status === "completed" && (
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
                )}
                {processingStatus.status === "error" && (
                  <XCircle className="h-5 w-5 text-red-600" />
                )}
                <span className={`text-sm font-medium ${
                  processingStatus.status === "completed" ? "text-[var(--color-success)]" :
                  processingStatus.status === "error" ? "text-red-600" :
                  "text-[var(--color-accent)]"
                }`}>
                  {processingStatus.message}
                </span>
              </div>
            </div>
            
            {/* Timers */}
            {processingStatus.status === "processing" && (
              <div className="mb-4 flex items-center justify-center gap-6 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">Arquivo atual:</span>
                  <span className="font-mono text-[var(--color-primary)] font-medium bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                    {formatTime(currentFileTime)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">Tempo total:</span>
                  <span className="font-mono text-[var(--color-accent)] font-medium bg-[var(--color-accent-light)] px-2 py-0.5 rounded">
                    {formatTime(totalProcessingTime)}
                  </span>
                </div>
              </div>
            )}
            
            {/* Final time on completion */}
            {processingStatus.status === "completed" && totalProcessingTime > 0 && (
              <div className="mb-4 flex items-center justify-center gap-2 text-sm">
                <span className="text-gray-500">Tempo total de processamento:</span>
                <span className="font-mono text-[var(--color-success)] font-medium bg-[var(--color-success-light)] px-2 py-0.5 rounded">
                  {formatTime(totalProcessingTime)}
                </span>
              </div>
            )}
            
            {/* Progress bar */}
            {processingStatus.status === "processing" && (
              <div className="mt-4">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-[var(--color-primary)] h-2 rounded-full transition-all duration-300"
                    style={{ width: `${processingStatus.progress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-600 mt-1 text-center">
                  {processingStatus.processedFiles} de {processingStatus.totalFiles} documentos processados
                </p>
              </div>
            )}
            
            {/* Preview button after completion */}
            {processingStatus.status === "completed" && existingRecords > 0 && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={loadExistingChunkPreviews}
                  disabled={isLoadingExistingPreview}
                  className="px-4 py-2 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary-light)] transition-colors flex items-center gap-2"
                >
                  {isLoadingExistingPreview ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  Ver Chunks Gerados
                </button>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </>
  )
}
