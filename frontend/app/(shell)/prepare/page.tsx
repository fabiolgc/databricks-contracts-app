"use client"

import { useState, useEffect, useRef } from "react"
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

interface AutoProcessStatus {
  step: "idle" | "generating_questions" | "chunking_a" | "chunking_b" | "evaluating" | "selecting" | "creating_index" | "completed" | "error"
  message: string
  progress: number
  evaluationA?: { strategy: string; avg_score: number; precision: number; chunks_count: number }
  evaluationB?: { strategy: string; avg_score: number; precision: number; chunks_count: number }
  bestStrategy?: string
  finalChunks?: number
}

interface FileProcessingResult {
  fileName: string
  status: "pending" | "processing" | "success" | "error"
  chunks?: number
  time?: number
  error?: string
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
  },
  {
    id: "hybrid_ai",
    name: "Híbrido + IA",
    description: "Combina chunking recursivo com extração de metadados por IA. Ideal para RAG com contratos e documentos jurídicos.",
    params: { chunkSize: 1200, chunkOverlap: 150 }
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
    tableName: "contracts"  // Base name only - backend adds _parsed/_chunks
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
  
  // State for parsed documents (from _parsed table)
  const [parsedDocuments, setParsedDocuments] = useState<RawDocument[]>([])
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
    parsedText: string
    textLength: number
    pageCount: number
  } | null>(null)
  const [isLoadingText, setIsLoadingText] = useState(false)
  const [viewedDocuments, setViewedDocuments] = useState<Set<string>>(new Set())
  
  // Legacy state for volume files (kept for compatibility)
  const [volumeFiles, setVolumeFiles] = useState<VolumeFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  
  // State for auto processing (replaces manual chunking strategy selection)
  const [autoProcessStatus, setAutoProcessStatus] = useState<AutoProcessStatus>({
    step: "idle",
    message: "",
    progress: 0
  })
  
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
  
  // State for file processing results (unified log)
  const [fileProcessingResults, setFileProcessingResults] = useState<FileProcessingResult[]>([])
  
  // Ref for auto-scrolling file list
  const fileListRef = useRef<HTMLDivElement>(null)
  
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
  
  // State for Vector Search endpoint (loaded from environment)
  const [vsEndpointName, setVsEndpointName] = useState("")
  
  // State for Vector Index configuration
  const [embeddingModel, setEmbeddingModel] = useState("databricks-gte-large-en")
  const [indexSyncType, setIndexSyncType] = useState<"TRIGGERED" | "CONTINUOUS">("TRIGGERED")
  const [recreateIndex, setRecreateIndex] = useState(false) // If true, delete and recreate index
  
  // State for vectorization progress with step times
  const [vectorizationStatus, setVectorizationStatus] = useState<{
    step: "idle" | "checking_endpoint" | "creating_endpoint" | "waiting_endpoint" | "processing_chunks" | "creating_index" | "completed" | "error"
    message: string
    progress: number
    stepTimes: {
      endpoint?: number
      chunks?: number
      index?: number
    }
  }>({ step: "idle", message: "", progress: 0, stepTimes: {} })
  
  // Track step start times
  const [stepStartTimes, setStepStartTimes] = useState<{
    endpoint?: number
    chunks?: number
    index?: number
  }>({})

  // Load environment config on mount - use base table name (without _parsed or _chunks suffix)
  useEffect(() => {
    const loadConfig = async () => {
      try {
        // Load environment config
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          console.log("Loaded config:", config)
          
          // Use base table name - backend will add _parsed or _chunks suffix as needed
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
          
          // Load Vector Search endpoint from environment config
          if (config.vectorSearchEndpoint) {
            console.log("Setting Vector Search endpoint:", config.vectorSearchEndpoint)
            setVsEndpointName(config.vectorSearchEndpoint)
          }
        }
        
        // Load app config (embedding_model, index_sync_type)
        const appConfigResponse = await fetch("/api/app-config")
        if (appConfigResponse.ok) {
          const appConfigData = await appConfigResponse.json()
          if (appConfigData.success && appConfigData.config) {
            // Load embedding model and sync type
            if (appConfigData.config.embedding_model) {
              setEmbeddingModel(appConfigData.config.embedding_model)
            }
            if (appConfigData.config.index_sync_type) {
              setIndexSyncType(appConfigData.config.index_sync_type as "TRIGGERED" | "CONTINUOUS")
            }
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
    if (activeStep === 2 && isConfigSaved && parsedDocuments.length === 0 && !isLoadingDocuments) {
      loadParsedDocuments()
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

  // Auto-scroll file list to current processing file
  useEffect(() => {
    if (fileListRef.current) {
      const processingIndex = fileProcessingResults.findIndex(f => f.status === "processing")
      if (processingIndex >= 0) {
        const container = fileListRef.current
        const items = container.children
        if (items[processingIndex]) {
          const item = items[processingIndex] as HTMLElement
          item.scrollIntoView({ behavior: "smooth", block: "nearest" })
        }
      }
    }
  }, [fileProcessingResults])

  // Load Vector Search endpoints
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

  // Load documents from _parsed table
  async function loadParsedDocuments(loadMore = false) {
    if (!isConfigSaved) {
      toast.warning("Configure e salve a tabela primeiro")
      return
    }
    
    setIsLoadingDocuments(true)
    const newOffset = loadMore ? documentsOffset + DOCUMENTS_PER_PAGE : 0
    
    try {
      const response = await fetch("/api/parsed-documents", {
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
        setParsedDocuments(prev => [...prev, ...data.documents])
      } else {
        // Replace documents
        setParsedDocuments(data.documents)
      }
      
      if (data.total === 0) {
        toast.info("Nenhum documento encontrado", {
          description: "Importe documentos primeiro no Módulo 1",
          duration: 5000
        })
      }
    } catch (error) {
      console.error("Error loading parsed documents:", error)
      toast.error("Erro ao carregar documentos", {
        description: error instanceof Error ? error.message : "Erro desconhecido",
        duration: 5000
      })
    } finally {
      setIsLoadingDocuments(false)
    }
  }

  // Load document parsed text
  async function loadDocumentText(documentId: string) {
    setIsLoadingText(true)
    
    try {
      const response = await fetch("/api/parsed-documents/text", {
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
          parsedText: data.document.parsedText,
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
    if (selectedDocuments.size === parsedDocuments.length) {
      setSelectedDocuments(new Set())
    } else {
      setSelectedDocuments(new Set(parsedDocuments.map(d => d.id)))
    }
  }

  // Delete documents
  async function deleteDocuments() {
    setIsDeleting(true)
    
    try {
      const documentIds = deleteAllDocuments ? [] : Array.from(selectedDocuments)
      
      const response = await fetch("/api/parsed-documents/delete", {
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
        await loadParsedDocuments()
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

  // Start auto processing with evaluation
  async function startAutoProcessing() {
    if (selectedDocuments.size === 0) {
      toast.warning("Selecione pelo menos um documento para processar")
      return
    }
    
    if (!isConfigSaved) {
      toast.warning("Salve a configuração da tabela primeiro")
      return
    }
    
    if (!vsEndpointName) {
      toast.warning("Configure o endpoint do Vector Search primeiro")
      return
    }
    
    // Get file names from selected document IDs
    const selectedDocs = parsedDocuments.filter(d => selectedDocuments.has(d.id))
    const filesToProcess = selectedDocs.map(d => d.fileName)
    
    // Initialize timers
    const startTime = Date.now()
    setProcessingStartTime(startTime)
    setTotalProcessingTime(0)
    
    // Reset status
    setAutoProcessStatus({
      step: "generating_questions",
      message: "Gerando perguntas de avaliação...",
      progress: 5
    })
    
    setProcessingStatus({
      status: "processing",
      message: "Iniciando processamento automático...",
      progress: 0,
      totalFiles: filesToProcess.length,
      processedFiles: 0
    })
    
    try {
      // Call the auto process endpoint
      setAutoProcessStatus(prev => ({
        ...prev,
        step: "chunking_a",
        message: "Processando com Método A (Recursivo)...",
        progress: 15
      }))
      
      // Simulate progress updates (the actual processing happens server-side)
      const progressInterval = setInterval(() => {
        setAutoProcessStatus(prev => {
          if (prev.step === "chunking_a" && prev.progress < 35) {
            return { ...prev, progress: prev.progress + 2 }
          }
          if (prev.step === "chunking_b" && prev.progress < 55) {
            return { ...prev, progress: prev.progress + 2 }
          }
          if (prev.step === "evaluating" && prev.progress < 80) {
            return { ...prev, progress: prev.progress + 1 }
          }
          return prev
        })
      }, 1000)
      
      const response = await fetch("/api/process/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          files: filesToProcess
        })
      })
      
      clearInterval(progressInterval)
      
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || "Falha no processamento automático")
      }
      
      const result = await response.json()
      
      if (result.success) {
        // Update with evaluation results
        setAutoProcessStatus({
          step: "selecting",
          message: `Melhor estratégia: ${result.bestStrategy === "recursive" ? "Recursivo" : "Tamanho Fixo"}`,
          progress: 85,
          evaluationA: result.evaluations?.recursive,
          evaluationB: result.evaluations?.fixed_size,
          bestStrategy: result.bestStrategy,
          finalChunks: result.finalChunks
        })
        
        // Now create Vector Index
        await createVectorIndexAfterProcessing(result.finalChunks)
        
      } else {
        throw new Error(result.error || "Processamento falhou")
      }
      
    } catch (error) {
      console.error("Auto processing error:", error)
      setAutoProcessStatus({
        step: "error",
        message: error instanceof Error ? error.message : "Erro desconhecido",
        progress: 0
      })
      setProcessingStatus({
        status: "error",
        message: error instanceof Error ? error.message : "Erro desconhecido",
        progress: 0,
        totalFiles: filesToProcess.length,
        processedFiles: 0
      })
      toast.error("Erro no processamento", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    }
  }
  
  // Create Vector Index after auto processing
  async function createVectorIndexAfterProcessing(chunksCount: number) {
    const indexName = `${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}_vs`
    
    setAutoProcessStatus(prev => ({
      ...prev,
      step: "creating_index",
      message: "Criando Vector Index...",
      progress: 90
    }))
    
    try {
      // Check if index exists and should be recreated
      if (recreateIndex) {
        const deleteResponse = await fetch("/api/vector-search/index/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpointName: vsEndpointName,
            indexName
          })
        })
        if (deleteResponse.ok) {
          console.log("Existing index deleted for recreation")
        }
      }
      
      // Create the index
      const createResponse = await fetch("/api/vector-search/index/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpointName: vsEndpointName,
          indexName,
          sourceTable: `${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}_chunks`,
          embeddingModel,
          syncType: indexSyncType
        })
      })
      
      const createResult = await createResponse.json()
      
      const endTime = Date.now()
      const totalTime = Math.floor((endTime - (processingStartTime || endTime)) / 1000)
      setTotalProcessingTime(totalTime)
      
      if (createResult.success || createResult.alreadyExists) {
        setAutoProcessStatus(prev => ({
          ...prev,
          step: "completed",
          message: createResult.alreadyExists 
            ? `Index já existe. ${chunksCount} segmentos processados.`
            : `Concluído! ${chunksCount} segmentos indexados.`,
          progress: 100
        }))
        
        setProcessingStatus({
          status: "completed",
          message: `Processamento concluído com sucesso!`,
          progress: 100,
          totalFiles: selectedDocuments.size,
          processedFiles: selectedDocuments.size
        })
        
        toast.success("Processamento concluído!", {
          description: `${chunksCount} segmentos criados e indexados.`,
          duration: 6000
        })
      } else {
        throw new Error(createResult.error || "Falha ao criar index")
      }
      
    } catch (error) {
      console.error("Vector index creation error:", error)
      // Still mark as completed if chunking worked but index failed
      setAutoProcessStatus(prev => ({
        ...prev,
        step: "completed",
        message: `Chunks criados. Index: ${error instanceof Error ? error.message : "erro"}`,
        progress: 95
      }))
      
      setProcessingStatus({
        status: "completed",
        message: "Chunks criados. Vector Index com erro.",
        progress: 100,
        totalFiles: selectedDocuments.size,
        processedFiles: selectedDocuments.size
      })
    }
  }

  // Execute the actual processing - file by file
  // Always deletes existing chunks for selected documents and creates new ones
  async function executeProcessing() {
    
    const strategy = CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)
    // Get file names from selected document IDs
    const selectedDocs = parsedDocuments.filter(d => selectedDocuments.has(d.id))
    const filesToProcess = selectedDocs.map(d => d.fileName)
    
    // Initialize timers
    const startTime = Date.now()
    setProcessingStartTime(startTime)
    setCurrentFileStartTime(startTime)
    setCurrentFileTime(0)
    setTotalProcessingTime(0)
    
    // Reset vectorization status and step times
    setVectorizationStatus({ step: "idle", message: "", progress: 0, stepTimes: {} })
    setStepStartTimes({})
    
    setProcessingStatus({
      status: "processing",
      message: "Verificando Vector Search endpoint...",
      progress: 0,
      totalFiles: filesToProcess.length,
      processedFiles: 0
    })
    
    // Track if we can use Vector Search
    let canUseVectorSearch = vsEndpointName ? true : false
    let vectorSearchError = vsEndpointName ? "" : "Endpoint não configurado"
    
    // Track step times locally
    const stepTimesLocal: { endpoint?: number; chunks?: number; index?: number } = {}
    let chunksStartTime = Date.now()
    
    try {
      // =========================================================================
      // Vector Search: Skip endpoint check, assume it exists (configured in app.yaml)
      // =========================================================================
      if (vsEndpointName) {
        // Endpoint is pre-configured, mark as instant
        stepTimesLocal.endpoint = 0
        chunksStartTime = Date.now()
        setStepStartTimes({ endpoint: startTime, chunks: chunksStartTime })
        setVectorizationStatus({
          step: "processing_chunks",
          message: `Usando endpoint: ${vsEndpointName}`,
          progress: 10,
          stepTimes: { endpoint: 0 }
        })
      }
      
      // =========================================================================
      // STEP 1: Initialize tables (always overwrite mode - delete existing chunks and create new)
      // =========================================================================
      setProcessingStatus({
        status: "processing",
        message: "Inicializando tabelas...",
        progress: 0,
        totalFiles: filesToProcess.length,
        processedFiles: 0
      })
      
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
      
      // Initialize file processing results
      const initialResults: FileProcessingResult[] = actualFilesToProcess.map((f: string) => ({
        fileName: f,
        status: "pending" as const
      }))
      setFileProcessingResults(initialResults)
      
      for (let i = 0; i < totalFiles; i++) {
        const fileName = actualFilesToProcess[i]
        const fileNumber = i + 1
        
        // Reset file timer for each new file
        const fileStartTime = Date.now()
        setCurrentFileStartTime(fileStartTime)
        setCurrentFileTime(0)
        
        // Update file status to processing
        setFileProcessingResults(prev => prev.map((r, idx) => 
          idx === i ? { ...r, status: "processing" as const } : r
        ))
        
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
          const fileTime = Math.floor((Date.now() - fileStartTime) / 1000)
          
          if (fileResult.success) {
            processedCount++
            totalChunks += fileResult.chunksCreated || 0
            
            // Update file result with success
            setFileProcessingResults(prev => prev.map((r, idx) => 
              idx === i ? { 
                ...r, 
                status: "success" as const, 
                chunks: fileResult.chunksCreated || 0,
                time: fileTime
              } : r
            ))
            
            // Update progress AFTER processing - show completion
            setProcessingStatus({
              status: "processing",
              message: `✓ ${fileName} - ${fileResult.chunksCreated} segmentos criados`,
              progress: Math.round((fileNumber / totalFiles) * 100),
              totalFiles: totalFiles,
              processedFiles: processedCount
            })
          } else {
            errors.push({ file: fileName, error: fileResult.error || "Erro desconhecido" })
            
            // Update file result with error
            setFileProcessingResults(prev => prev.map((r, idx) => 
              idx === i ? { 
                ...r, 
                status: "error" as const, 
                error: fileResult.error || "Erro desconhecido",
                time: fileTime
              } : r
            ))
            
            // Update progress even on error
            setProcessingStatus({
              status: "processing",
              message: `✗ Erro em ${fileName}`,
              progress: Math.round((fileNumber / totalFiles) * 100),
              totalFiles: totalFiles,
              processedFiles: processedCount
            })
          }
        } catch (fileError) {
          const errorMsg = fileError instanceof Error ? fileError.message : "Erro desconhecido"
          errors.push({ file: fileName, error: errorMsg })
          const fileTime = Math.floor((Date.now() - fileStartTime) / 1000)
          
          // Update file result with error
          setFileProcessingResults(prev => prev.map((r, idx) => 
            idx === i ? { 
              ...r, 
              status: "error" as const, 
              error: errorMsg,
              time: fileTime
            } : r
          ))
          
          // Update progress even on exception
          setProcessingStatus({
            status: "processing",
            message: `✗ Erro em ${fileName}`,
            progress: Math.round((fileNumber / totalFiles) * 100),
            totalFiles: totalFiles,
            processedFiles: processedCount
          })
        }
      }
      
      // Chunking status
      const chunkingSuccess = errors.length === 0
      
      // Save the list of successfully processed files (those without errors)
      const successfullyProcessed = actualFilesToProcess.filter(
        (f: string) => !errors.some(e => e.file === f)
      )
      setLastProcessedFiles(successfullyProcessed)
      
      if (!chunkingSuccess) {
        setProcessingStatus({
          status: "error",
          message: `Concluído com ${errors.length} erro(s). ${totalChunks} segmentos criados.`,
          progress: 100,
          totalFiles: actualFilesToProcess.length,
          processedFiles: processedCount
        })
        setVectorizationStatus(prev => ({
          step: "error",
          message: "Erros no processamento dos chunks. Vector Index não será criado.",
          progress: 0,
          stepTimes: prev.stepTimes
        }))
        return
      }
      
      // =========================================================================
      // STEP 3: Create Vector Index (only if Vector Search is available)
      // =========================================================================
      let indexCreated = false
      const indexName = `${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}_vs`
      
      // Calculate chunks processing time
      const chunksEndTime = Date.now()
      stepTimesLocal.chunks = Math.floor((chunksEndTime - chunksStartTime) / 1000)
      const indexStartTime = Date.now()
      
      if (canUseVectorSearch && vsEndpointName) {
        setStepStartTimes(prev => ({ ...prev, index: indexStartTime }))
        setVectorizationStatus(prev => ({
          step: "creating_index",
          message: "Criando Vector Index...",
          progress: 80,
          stepTimes: { ...prev.stepTimes, endpoint: stepTimesLocal.endpoint, chunks: stepTimesLocal.chunks }
        }))
        
        setProcessingStatus({
          status: "processing",
          message: `Segmentos criados! Criando Vector Index...`,
          progress: 95,
          totalFiles: actualFilesToProcess.length,
          processedFiles: processedCount
        })
        
        try {
          // Helper function to wait for index sync
          const waitForIndexSync = async (maxWaitSeconds: number = 300): Promise<{ success: boolean; message: string }> => {
            const pollInterval = 5000 // 5 seconds
            const maxAttempts = Math.ceil((maxWaitSeconds * 1000) / pollInterval)
            let attempts = 0
            
            while (attempts < maxAttempts) {
              attempts++
              
              const statusResponse = await fetch("/api/vector-search/index/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  tableConfig,
                  endpoint_name: vsEndpointName,
                  embedding_model: embeddingModel,
                  sync_type: indexSyncType
                })
              })
              
              const statusResult = await statusResponse.json()
              
              if (statusResult.success) {
                const indexStatus = statusResult.index_status || ""
                
                // Update UI with current status
                setVectorizationStatus(prev => ({
                  ...prev,
                  message: `Sincronizando index... (${indexStatus})`,
                }))
                
                // Check if sync is complete
                if (statusResult.ready || indexStatus === "ONLINE") {
                  return { success: true, message: "Sync completed" }
                }
                
                // Check for error states
                if (indexStatus === "FAILED" || indexStatus === "ERROR") {
                  return { success: false, message: `Sync failed: ${statusResult.message || indexStatus}` }
                }
              }
              
              // Wait before next poll
              await new Promise(resolve => setTimeout(resolve, pollInterval))
            }
            
            return { success: false, message: "Sync timeout - index may still be syncing in background" }
          }
          
          // First check if index already exists
          const indexCheckResponse = await fetch("/api/vector-search/index/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tableConfig,
              endpoint_name: vsEndpointName,
              embedding_model: embeddingModel,
              sync_type: indexSyncType
            })
          })
          
          const indexCheckResult = await indexCheckResponse.json()
          
          if (indexCheckResult.exists && !recreateIndex) {
            // Index already exists and user wants to sync only
            setVectorizationStatus(prev => ({
              ...prev,
              message: `Index "${indexName}" já existe. Sincronizando...`,
            }))
            
            // Trigger sync
            const syncResponse = await fetch("/api/vector-search/index/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tableConfig,
                endpoint_name: vsEndpointName,
                embedding_model: embeddingModel,
                sync_type: indexSyncType
              })
            })
            
            const syncResult = await syncResponse.json()
            
            if (syncResult.success) {
              // Wait for sync to complete
              const syncWaitResult = await waitForIndexSync(180) // 3 min max for existing index
              
              const indexEndTime = Date.now()
              stepTimesLocal.index = Math.floor((indexEndTime - indexStartTime) / 1000)
              
              if (syncWaitResult.success) {
                setVectorizationStatus(prev => ({
                  step: "completed",
                  message: `✓ Vector Index "${indexName}" sincronizado!`,
                  progress: 100,
                  stepTimes: { ...prev.stepTimes, index: stepTimesLocal.index }
                }))
                toast.success(`Vector Index "${indexName}" sincronizado!`, {
                  duration: 6000
                })
              } else {
                setVectorizationStatus(prev => ({
                  step: "completed",
                  message: `✓ Vector Index "${indexName}" - sync em andamento`,
                  progress: 100,
                  stepTimes: { ...prev.stepTimes, index: stepTimesLocal.index }
                }))
                toast.info(`Sync do index iniciado. Pode continuar em background.`, {
                  duration: 6000
                })
              }
              indexCreated = true
            } else {
              // Sync trigger failed, but index exists
              const indexEndTime = Date.now()
              stepTimesLocal.index = Math.floor((indexEndTime - indexStartTime) / 1000)
              setVectorizationStatus(prev => ({
                step: "completed",
                message: `✓ Vector Index "${indexName}" já existe (sync automático)`,
                progress: 100,
                stepTimes: { ...prev.stepTimes, index: stepTimesLocal.index }
              }))
              toast.info(`Vector Index "${indexName}" já existe. Sync será automático.`)
              indexCreated = true
            }
          } else {
            // Delete existing index if recreateIndex is enabled
            if (indexCheckResult.exists && recreateIndex) {
              setVectorizationStatus(prev => ({
                ...prev,
                message: `Deletando index existente "${indexName}"...`,
              }))
              
              const deleteResponse = await fetch("/api/vector-search/index/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  tableConfig,
                  endpoint_name: vsEndpointName,
                  embedding_model: embeddingModel,
                  sync_type: indexSyncType
                })
              })
              
              const deleteResult = await deleteResponse.json()
              
              if (!deleteResult.success) {
                toast.warning(`Erro ao deletar index: ${deleteResult.error}`)
              } else {
                toast.info(`Index "${indexName}" deletado. Recriando...`)
                // Wait a bit for deletion to propagate
                await new Promise(resolve => setTimeout(resolve, 3000))
              }
            }
            
            // Create new index
            const indexCreateResponse = await fetch("/api/vector-search/index/create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tableConfig,
                endpoint_name: vsEndpointName,
                embedding_model: embeddingModel,
                sync_type: indexSyncType
              })
            })
            
            const indexCreateResult = await indexCreateResponse.json()
            
            if (indexCreateResult.success) {
              // Wait for sync to complete
              setVectorizationStatus(prev => ({
                ...prev,
                message: `Index criado! Aguardando sync...`,
              }))
              
              const syncWaitResult = await waitForIndexSync(300) // 5 min max for new index
              
              const indexEndTime = Date.now()
              stepTimesLocal.index = Math.floor((indexEndTime - indexStartTime) / 1000)
              
              if (syncWaitResult.success) {
                setVectorizationStatus(prev => ({
                  step: "completed",
                  message: `✓ Vector Index "${indexName}" criado e sincronizado!`,
                  progress: 100,
                  stepTimes: { ...prev.stepTimes, index: stepTimesLocal.index }
                }))
                toast.success(`Vector Index "${indexName}" pronto!`, {
                  description: `Modelo: ${embeddingModel}, Sync: ${indexSyncType}`,
                  duration: 6000
                })
              } else {
                setVectorizationStatus(prev => ({
                  step: "completed",
                  message: `✓ Vector Index "${indexName}" criado - sync em andamento`,
                  progress: 100,
                  stepTimes: { ...prev.stepTimes, index: stepTimesLocal.index }
                }))
                toast.info(`Index criado! Sync pode continuar em background.`, {
                  description: syncWaitResult.message,
                  duration: 8000
                })
              }
              indexCreated = true
            } else {
              setVectorizationStatus(prev => ({
                step: "error",
                message: `Erro ao criar Vector Index: ${indexCreateResult.error}`,
                progress: 0,
                stepTimes: prev.stepTimes
              }))
              toast.warning("Erro ao criar Vector Index", {
                description: indexCreateResult.error,
                duration: 8000
              })
            }
          }
        } catch (indexError) {
          setVectorizationStatus(prev => ({
            step: "error",
            message: `Erro ao criar Vector Index: ${indexError instanceof Error ? indexError.message : "Erro desconhecido"}`,
            progress: 0,
            stepTimes: prev.stepTimes
          }))
          toast.warning("Erro ao criar Vector Index", {
            description: "Os chunks foram criados com sucesso.",
            duration: 6000
          })
        }
      } else {
        // Vector Search not available - chunks only
        setVectorizationStatus(prev => ({
          step: "completed",
          message: vectorSearchError || "Vector Search não configurado. Apenas chunks foram criados.",
          progress: 100,
          stepTimes: { ...prev.stepTimes, chunks: stepTimesLocal.chunks }
        }))
      }
      
      // Final status
      const finalSuccess = canUseVectorSearch ? indexCreated : true // Success if chunks created (even without index)
      setProcessingStatus({
        status: finalSuccess ? "completed" : "error",
        message: canUseVectorSearch 
          ? (indexCreated 
            ? `Processamento concluído! ${totalChunks} segmentos criados e Vector Index pronto.`
            : `Segmentos criados mas erro no Vector Index.`)
          : `Processamento concluído! ${totalChunks} segmentos criados. (Vector Index não disponível)`,
        progress: 100,
        totalFiles: actualFilesToProcess.length,
        processedFiles: processedCount
      })
      
      if (finalSuccess) {
        toast.success("Processamento concluído!", {
          description: canUseVectorSearch && indexCreated
            ? `${processedCount} arquivos → ${totalChunks} segmentos → Vector Index pronto`
            : `${processedCount} arquivos → ${totalChunks} segmentos criados`,
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
      
      setVectorizationStatus(prev => ({
        step: "error",
        message: error instanceof Error ? error.message : "Erro no processamento",
        progress: 0,
        stepTimes: prev.stepTimes
      }))
      
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
              
              {/* Vector Search Configuration */}
              <div className="mt-4 grid grid-cols-2 gap-4">
                {/* Embedding Model */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("prepare.step1.embeddingModel")}
                  </label>
                  <select
                    value={embeddingModel}
                    onChange={(e) => {
                      setEmbeddingModel(e.target.value)
                      setIsConfigSaved(false)
                      setCompletedSteps(prev => { const newSet = new Set(prev); newSet.delete(1); return newSet })
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] bg-white"
                  >
                    <option value="databricks-gte-large-en">databricks-gte-large-en</option>
                    <option value="databricks-bge-large-en">databricks-bge-large-en</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">{t("prepare.step1.embeddingModelHint")}</p>
                </div>
                
                {/* Sync Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("prepare.step1.indexSyncType")}
                  </label>
                  <select
                    value={indexSyncType}
                    onChange={(e) => {
                      setIndexSyncType(e.target.value as "TRIGGERED" | "CONTINUOUS")
                      setIsConfigSaved(false)
                      setCompletedSteps(prev => { const newSet = new Set(prev); newSet.delete(1); return newSet })
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] bg-white"
                  >
                    <option value="TRIGGERED">{t("prepare.step1.syncTriggered")}</option>
                    <option value="CONTINUOUS">{t("prepare.step1.syncContinuous")}</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">{t("prepare.step1.indexSyncTypeHint")}</p>
                </div>
              </div>
              
              {/* Recreate Index Option */}
              <div className="mt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={recreateIndex}
                    onChange={(e) => setRecreateIndex(e.target.checked)}
                    className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                  />
                  <span className="text-sm text-gray-700">{t("prepare.step1.recreateIndex")}</span>
                </label>
                <p className="mt-1 text-xs text-gray-500 ml-6">{t("prepare.step1.recreateIndexHint")}</p>
              </div>

              {/* Preview das tabelas que serão criadas/usadas */}
              {tableConfig.tableName && (
                <div className="mt-3 p-3 bg-[var(--color-accent-light)] border border-[var(--color-accent-lighter)] rounded-lg">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs font-medium text-[var(--color-accent)] mb-1">{t("prepare.step1.tableCreated")}</p>
                      <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                        {tableConfig.catalog || "catalogo"}.{tableConfig.schema || "schema"}.{tableConfig.tableName}_chunks
                      </code>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--color-accent)] mb-1">{t("prepare.step1.tableUsed")}</p>
                      <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                        {initialTableConfig.catalog || "catalogo"}.{initialTableConfig.schema || "schema"}.{initialTableConfig.tableName}_parsed
                      </code>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--color-accent)] mb-1">{t("prepare.step1.indexCreated")}</p>
                      <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                        {tableConfig.catalog || "catalogo"}.{tableConfig.schema || "schema"}.{tableConfig.tableName}_vs
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

        {/* Step 2: Select Documents from _parsed table */}
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
                    onClick={() => loadParsedDocuments()}
                    className="mt-3 text-sm text-[var(--color-primary)] hover:text-[var(--color-primary)]/80 font-medium"
                  >
                    Tentar novamente
                  </button>
                </div>
              ) : parsedDocuments.length === 0 && !isLoadingDocuments ? (
                <div className="text-center py-8">
                  <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">Nenhum documento na tabela</p>
                  <button
                    onClick={() => loadParsedDocuments()}
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
                        checked={parsedDocuments.length > 0 && selectedDocuments.size === parsedDocuments.length}
                        onChange={selectAllDocuments}
                        className="w-4 h-4 text-[var(--color-primary)] border-gray-300 rounded focus:ring-[var(--color-primary)]"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        Selecionar todos ({parsedDocuments.length})
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
                      {parsedDocuments.length > 0 && selectedDocuments.size === 0 && (
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
                        onClick={() => loadParsedDocuments()}
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
                      {parsedDocuments.map((doc) => (
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
                        onClick={() => loadParsedDocuments(true)}
                        disabled={isLoadingDocuments}
                        className="px-4 py-2 text-sm font-medium text-[var(--color-primary)] border border-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary-light)] transition-colors flex items-center gap-2 mx-auto"
                      >
                        {isLoadingDocuments ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        Carregar mais ({documentsTotal - parsedDocuments.length} restantes)
                      </button>
                    </div>
                  )}
                  
                  {/* Loading indicator */}
                  {isLoadingDocuments && parsedDocuments.length === 0 && (
                    <div className="text-center py-8">
                      <Loader2 className="h-8 w-8 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
                      <p className="text-sm text-gray-500">Carregando documentos...</p>
                    </div>
                  )}
                  
                  {/* Process button */}
                  {parsedDocuments.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
                      <span className="text-sm text-gray-500">
                        {selectedDocuments.size} de {documentsTotal} documento(s) selecionado(s)
                      </span>
                      <button
                        onClick={() => {
                          if (selectedDocuments.size === 0) {
                            toast.warning("Selecione pelo menos um documento para processar")
                            return
                          }
                          setCompletedSteps(prev => new Set([...prev, 2]))
                          setActiveStep(null)
                          startAutoProcessing()
                        }}
                        disabled={selectedDocuments.size === 0 || processingStatus.status === "processing"}
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
                            Processar Documentos
                          </>
                        )}
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
                  <strong>Atenção:</strong> Esta ação irá remover os documentos da tabela <code className="bg-[var(--color-warning-light)] px-1 rounded">_parsed</code> e 
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
                  {selectedDocumentText.parsedText}
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
                  {" "} • {chunkingParams.chunkSize} chars, {chunkingParams.chunkOverlap} sobreposição
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
            {/* File Processing Results - Card Arquivos */}
            {fileProcessingResults.length > 0 && (
              <div className="mb-4 p-4 rounded-lg bg-white border border-gray-200">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="h-4 w-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-700">Arquivos</span>
                  <span className="text-sm text-gray-500">
                    {fileProcessingResults.filter(f => f.status === "success").length} de {fileProcessingResults.length}
                  </span>
                </div>
                <div ref={fileListRef} className="space-y-2 max-h-48 overflow-y-auto">
                  {fileProcessingResults.map((file, idx) => (
                    <div key={idx} className="flex items-center gap-3 text-sm py-1.5">
                      {/* Time first (like in image) */}
                      {file.status === "processing" && (
                        <span className="font-mono text-[var(--color-primary)] font-medium min-w-[45px]">
                          {formatTime(currentFileTime)}
                        </span>
                      )}
                      {file.status === "success" && file.time !== undefined && (
                        <span className="font-mono text-[var(--color-success)] font-medium min-w-[45px]">
                          {formatTime(file.time)}
                        </span>
                      )}
                      {file.status === "error" && file.time !== undefined && (
                        <span className="font-mono text-red-500 font-medium min-w-[45px]">
                          {formatTime(file.time)}
                        </span>
                      )}
                      {file.status === "pending" && (
                        <span className="min-w-[45px]" />
                      )}
                      
                      {/* Status icon */}
                      {file.status === "pending" && (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                      )}
                      {file.status === "processing" && (
                        <Loader2 className="h-4 w-4 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                      )}
                      {file.status === "success" && (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)] flex-shrink-0" />
                      )}
                      {file.status === "error" && (
                        <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                      )}
                      
                      {/* File name */}
                      <span className={`truncate ${
                        file.status === "processing" ? "text-[var(--color-primary)] font-medium" :
                        file.status === "success" ? "text-[var(--color-success)]" :
                        file.status === "error" ? "text-red-600" : "text-gray-500"
                      }`}>
                        {file.fileName}
                      </span>
                      
                      {/* Chunks count (success only) */}
                      {file.status === "success" && file.chunks !== undefined && (
                        <span className="text-xs text-gray-500 ml-auto">{file.chunks} segmentos</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Vectorization Progress - Card Vector Search */}
            {vectorizationStatus.step !== "idle" && (
              <div className="p-4 rounded-lg bg-white border border-gray-200">
                <div className="flex items-center gap-2 mb-3">
                  <Database className="h-4 w-4 text-[var(--color-accent)]" />
                  <span className="text-sm font-medium text-gray-700">Vector Search</span>
                </div>
                
                {/* Vectorization Steps */}
                <div className="space-y-3">
                  {/* Step 1: Endpoint */}
                  <div className="flex items-center gap-2 text-sm">
                    {vectorizationStatus.step === "checking_endpoint" ? (
                      <Loader2 className="h-4 w-4 text-[var(--color-accent)] animate-spin" />
                    ) : vectorizationStatus.step === "creating_endpoint" || vectorizationStatus.step === "waiting_endpoint" ? (
                      <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />
                    ) : ["processing_chunks", "creating_index", "completed"].includes(vectorizationStatus.step) ? (
                      <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                    ) : vectorizationStatus.step === "error" ? (
                      <XCircle className="h-4 w-4 text-red-500" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-gray-300" />
                    )}
                    <span className={
                      ["checking_endpoint", "creating_endpoint", "waiting_endpoint"].includes(vectorizationStatus.step)
                        ? "text-[var(--color-accent)] font-medium"
                        : ["processing_chunks", "creating_index", "completed"].includes(vectorizationStatus.step)
                        ? "text-[var(--color-success)]"
                        : "text-gray-500"
                    }>
                      Endpoint: {vsEndpointName}
                    </span>
                  </div>
                  
                  {/* Step 2: Chunks - with time and progress bar */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      {vectorizationStatus.step === "processing_chunks" ? (
                        <Loader2 className="h-4 w-4 text-[var(--color-accent)] animate-spin" />
                      ) : ["creating_index", "completed"].includes(vectorizationStatus.step) ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                      ) : vectorizationStatus.step === "error" && vectorizationStatus.message.includes("chunks") ? (
                        <XCircle className="h-4 w-4 text-red-500" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300" />
                      )}
                      <span className={
                        vectorizationStatus.step === "processing_chunks"
                          ? "text-[var(--color-accent)] font-medium"
                          : ["creating_index", "completed"].includes(vectorizationStatus.step)
                          ? "text-[var(--color-success)]"
                          : "text-gray-500"
                      }>
                        Processamento de Segmentos
                      </span>
                      {/* Time badge - show live time when processing, final time when completed */}
                      {vectorizationStatus.step === "processing_chunks" && (
                        <span className="font-mono text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                          {formatTime(totalProcessingTime)}
                        </span>
                      )}
                      {["creating_index", "completed"].includes(vectorizationStatus.step) && vectorizationStatus.stepTimes.chunks !== undefined && (
                        <span className="font-mono text-xs bg-[var(--color-success-light)] text-[var(--color-success)] px-2 py-0.5 rounded">
                          {formatTime(vectorizationStatus.stepTimes.chunks)}
                        </span>
                      )}
                    </div>
                    {/* Progress bar for chunks processing */}
                    {vectorizationStatus.step === "processing_chunks" && processingStatus.totalFiles > 0 && (
                      <div className="ml-6 flex items-center gap-2">
                        <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                          <div 
                            className="bg-[var(--color-accent)] h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${processingStatus.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Step 3: Vector Index */}
                  <div className="flex items-center gap-2 text-sm">
                    {vectorizationStatus.step === "creating_index" ? (
                      <Loader2 className="h-4 w-4 text-[var(--color-accent)] animate-spin" />
                    ) : vectorizationStatus.step === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                    ) : vectorizationStatus.step === "error" && vectorizationStatus.message.includes("Index") ? (
                      <XCircle className="h-4 w-4 text-red-500" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-gray-300" />
                    )}
                    <span className={
                      vectorizationStatus.step === "creating_index"
                        ? "text-[var(--color-accent)] font-medium"
                        : vectorizationStatus.step === "completed"
                        ? "text-[var(--color-success)]"
                        : "text-gray-500"
                    }>
                      Vector Index: {tableConfig.catalog}.{tableConfig.schema}.{tableConfig.tableName}_vs
                    </span>
                    {/* Time badge for index creation */}
                    {vectorizationStatus.step === "completed" && vectorizationStatus.stepTimes.index !== undefined && (
                      <span className="font-mono text-xs bg-[var(--color-success-light)] text-[var(--color-success)] px-2 py-0.5 rounded">
                        {formatTime(vectorizationStatus.stepTimes.index)}
                      </span>
                    )}
                  </div>
                </div>
                
                {/* Status message and total time in footer */}
                <div className="mt-3 flex items-center justify-between">
                  {vectorizationStatus.message && (
                    <div className={`text-xs px-2 py-1 rounded ${
                      vectorizationStatus.step === "error" 
                        ? "bg-red-50 text-red-600"
                        : vectorizationStatus.step === "completed"
                        ? "bg-[var(--color-success-light)] text-[var(--color-success)]"
                        : "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
                    }`}>
                      {vectorizationStatus.message}
                    </div>
                  )}
                  {/* Total time in bottom right - show during processing and after completion */}
                  {(processingStatus.status === "processing" || processingStatus.status === "completed") && totalProcessingTime > 0 && (
                    <div className="flex items-center gap-2 ml-auto">
                      <span className="text-xs text-gray-500">Tempo total:</span>
                      <span className={`font-mono text-xs px-2 py-0.5 rounded ${
                        processingStatus.status === "completed"
                          ? "bg-[var(--color-success-light)] text-[var(--color-success)]"
                          : "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
                      }`}>
                        {formatTime(totalProcessingTime)}
                      </span>
                    </div>
                  )}
                </div>
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
