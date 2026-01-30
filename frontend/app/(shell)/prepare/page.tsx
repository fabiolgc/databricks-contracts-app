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
  // Ensure non-negative values
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(safeSeconds / 60)
  const secs = safeSeconds % 60
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

interface SampleChunk {
  file_name: string
  chunk_index: number
  total_chunks: number
  content: string
  char_count: number
}

interface StrategyEvaluation {
  strategy: string
  label?: string
  avg_score: number
  precision: number
  chunks_count: number
  sample_chunks?: SampleChunk[]
}

interface AutoProcessStatus {
  step: "idle" | "generating_questions" | "chunking_parallel" | "chunking_a" | "chunking_b" | "chunking_c" | "evaluating" | "selecting" | "applying" | "creating_index" | "completed" | "error"
  message: string
  progress: number
  evaluationA?: StrategyEvaluation
  evaluationB?: StrategyEvaluation
  evaluationC?: StrategyEvaluation
  bestStrategy?: string
  finalChunks?: number
  sampleFiles?: number
  strategyProgress?: { A: number; B: number; C: number }
  strategyStatus?: { A: string; B: string; C: string }
  evalProgress?: { A: string; B: string; C: string }
  indexAction?: "checking" | "creating" | "waiting_creation" | "syncing" | "waiting_sync" | "created" | "synced"
  // Step timing
  stepTimes?: {
    questions?: number
    chunking_a?: number
    chunking_b?: number
    chunking_c?: number
    evaluating?: number
    applying?: number
    index?: number
  }
  // Current file being processed
  currentFile?: string
  currentFileIndex?: number
  totalFiles?: number
  // Additional info
  questions?: string[]
  tables?: {
    chunks: string
    tempRecursive: string
    tempFixedSize: string
    tempStructural: string
  }
  indexName?: string
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

// Auto-processing uses 3 strategies optimized for legal contracts:
// A: Recursivo - standard recursive text splitting
// B: Tamanho Fixo - fixed-size with sentence boundaries
// C: Estrutural - clause-aware (BEST for contracts)
// The system evaluates all 3 and picks the best

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
  const [showQuestions, setShowQuestions] = useState(false)
  const [showStrategies, setShowStrategies] = useState(false)
  const [showEvaluationResults, setShowEvaluationResults] = useState(false)
  const [viewingChunksStrategy, setViewingChunksStrategy] = useState<"A" | "B" | "C" | null>(null)
  
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
  
  // Step timing
  const [stepStartTimes, setStepStartTimes] = useState<{[key: string]: number}>({})
  const [stepEndTimes, setStepEndTimes] = useState<{[key: string]: number}>({})
  const [currentStepTime, setCurrentStepTime] = useState(0)
  const currentStepRef = useRef<string | null>(null) // Ref for sync tracking
  
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
        
        // Load app config (embedding_model, index_sync_type, vs_endpoint)
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
            // Override vsEndpoint from app-config if available
            if (appConfigData.config.vs_endpoint) {
              setVsEndpointName(appConfigData.config.vs_endpoint)
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
        // Update current step time based on active step
        const currentStep = autoProcessStatus.step
        if (currentStep && stepStartTimes[currentStep] && !stepEndTimes[currentStep]) {
          setCurrentStepTime(Math.floor((now - stepStartTimes[currentStep]) / 1000))
        }
      }, 1000)
    }
    
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [processingStatus.status, processingStartTime, currentFileStartTime, autoProcessStatus.step, stepStartTimes, stepEndTimes])

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
    setCurrentStepTime(0)
    setStepStartTimes({ generating_questions: startTime })
    setStepEndTimes({})
    currentStepRef.current = "generating_questions" // Initialize ref
    
    // Reset status
    setAutoProcessStatus({
      step: "generating_questions",
      message: t("prepare.autoProcess.generatingQuestions"),
      progress: 5,
      totalFiles: filesToProcess.length,
      currentFileIndex: 0
    })
    
    setProcessingStatus({
      status: "processing",
      message: "Iniciando processamento automático...",
      progress: 0,
      totalFiles: filesToProcess.length,
      processedFiles: 0
    })
    
    try {
      console.log("[AutoProcess] Starting background job via /api/process/auto/start")
      console.log("[AutoProcess] Request payload:", { tableConfig, files: filesToProcess })
      
      // Start background job
      const startResponse = await fetch("/api/process/auto/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          files: filesToProcess
        })
      })
      
      if (!startResponse.ok) {
        const errorText = await startResponse.text()
        throw new Error(`Falha ao iniciar processamento: HTTP ${startResponse.status}`)
      }
      
      const { jobId } = await startResponse.json()
      console.log("[AutoProcess] Job started with ID:", jobId)
      
      // Poll for job status
      let result: {
        success: boolean
        bestStrategy?: string
        evaluations?: Record<string, StrategyEvaluation>
        finalChunks?: number
        sampleFilesUsed?: number
        questions?: string[]
        tables?: { chunks: string; tempRecursive: string; tempFixedSize: string; tempStructural: string }
        indexName?: string
        error?: string
      } | null = null
      let pollCount = 0
      const maxPolls = 300 // 5 minutes max (1 poll per second)
      
      while (pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, 1000)) // Poll every 1 second
        pollCount++
        
        try {
          const statusResponse = await fetch(`/api/process/auto/status/${jobId}`)
          if (!statusResponse.ok) {
            console.warn(`[AutoProcess] Status poll failed: ${statusResponse.status}`)
            continue
          }
          
          const jobStatus = await statusResponse.json()
          console.log(`[AutoProcess] Poll ${pollCount}: ${jobStatus.status} - ${jobStatus.step}`)
          
          // Update UI based on backend status
          if (jobStatus.step && jobStatus.message) {
            // Map backend step to frontend step
            const stepMap: Record<string, string> = {
              generating_questions: "generating_questions",
              chunking_parallel: "chunking_parallel",
              chunking_a: "chunking_a",
              chunking_b: "chunking_b",
              chunking_c: "chunking_c",
              evaluating: "evaluating",
              applying: "applying"
            }
            const frontendStep = stepMap[jobStatus.step] || jobStatus.step
            
            // Update step times using ref for sync comparison
            const prevStep = currentStepRef.current
            if (frontendStep !== prevStep) {
              const now = Date.now()
              if (prevStep) {
                setStepEndTimes(prev => ({ ...prev, [prevStep]: now }))
              }
              setStepStartTimes(prev => {
                // Only set if not already set
                if (!prev[frontendStep]) {
                  return { ...prev, [frontendStep]: now }
                }
                return prev
              })
              currentStepRef.current = frontendStep
            }
            
            setAutoProcessStatus(prev => ({
              ...prev,
              step: frontendStep,
              message: jobStatus.message,
              progress: jobStatus.progress || prev.progress,
              currentFile: jobStatus.currentFile,
              currentFileIndex: jobStatus.currentFileIndex,
              sampleFiles: jobStatus.sampleFiles,
              totalFiles: jobStatus.totalFiles,
              questions: jobStatus.questions || prev.questions,
              // Update evaluation results and tables in real-time
              evaluationA: jobStatus.evaluationA || prev.evaluationA,
              evaluationB: jobStatus.evaluationB || prev.evaluationB,
              evaluationC: jobStatus.evaluationC || prev.evaluationC,
              bestStrategy: jobStatus.bestStrategy || prev.bestStrategy,
              tables: jobStatus.tables || prev.tables,
              // Parallel chunking progress
              strategyProgress: jobStatus.strategyProgress || prev.strategyProgress,
              strategyStatus: jobStatus.strategyStatus || prev.strategyStatus
            }))
          }
          
          if (jobStatus.status === "completed" && jobStatus.result) {
            result = jobStatus.result
            break
          }
          
          if (jobStatus.status === "failed") {
            throw new Error(jobStatus.error || "Processamento falhou")
          }
        } catch (pollError) {
          if (pollError instanceof Error && pollError.message.includes("Processamento falhou")) {
            throw pollError
          }
          console.warn(`[AutoProcess] Poll error (continuing):`, pollError)
        }
      }
      
      if (!result) {
        throw new Error("Timeout aguardando processamento")
      }
      
      console.log("[AutoProcess] Final result:", result)
      
      if (result.success) {
        // Mark all processing steps as complete (backend already did chunking + evaluation + applying)
        const now = Date.now()
        setStepEndTimes(prev => ({
          ...prev,
          chunking_parallel: prev.chunking_parallel || now - 6000,
          chunking_a: prev.chunking_a || now - 6000,
          chunking_b: prev.chunking_b || now - 5000,
          chunking_c: prev.chunking_c || now - 4000,
          evaluating: prev.evaluating || now - 2000,
          applying: now
        }))
        setStepStartTimes(prev => ({
          ...prev,
          chunking_c: prev.chunking_c || now - 5000,
          applying: prev.applying || now - 2000
        }))
        
        // Strategy labels
        const strategyLabels: Record<string, string> = {
          recursive: t("prepare.autoProcess.steps.recursive"),
          fixed_size: t("prepare.autoProcess.steps.fixedSize"),
          structural: t("prepare.autoProcess.steps.structural")
        }
        
        const bestStrategyKey = result.bestStrategy || "recursive"
        const bestStrategyLabel = strategyLabels[bestStrategyKey] || bestStrategyKey
        
        // Update with evaluation results - backend already applied best strategy
        setAutoProcessStatus({
          step: "applying",
          message: `Estratégia ${bestStrategyLabel} aplicada: ${result.finalChunks} chunks`,
          progress: 85,
          evaluationA: result.evaluations?.recursive,
          evaluationB: result.evaluations?.fixed_size,
          evaluationC: result.evaluations?.structural,
          bestStrategy: result.bestStrategy,
          finalChunks: result.finalChunks,
          sampleFiles: result.sampleFilesUsed,
          questions: result.questions,
          tables: result.tables,
          indexName: result.indexName
        })
        
        // Now create Vector Index
        await createVectorIndexAfterProcessing(result.finalChunks || 0)
        
      } else {
        throw new Error(result.error || "Processamento falhou")
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Erro desconhecido"
      const errorStack = error instanceof Error ? error.stack : undefined
      
      console.error("=".repeat(60))
      console.error("[AutoProcess] ERROR CAUGHT")
      console.error("[AutoProcess] Error message:", errorMessage)
      console.error("[AutoProcess] Error stack:", errorStack)
      console.error("[AutoProcess] Error object:", error)
      console.error("=".repeat(60))
      
      setAutoProcessStatus({
        step: "error",
        message: errorMessage,
        progress: 0
      })
      setProcessingStatus({
        status: "error",
        message: errorMessage,
        progress: 0,
        totalFiles: filesToProcess.length,
        processedFiles: 0
      })
      toast.error("Erro no processamento", {
        description: errorMessage,
        duration: 10000
      })
    }
  }
  
  // Monitor Vector Index status until ready
  // operationType: "create" | "sync" - to show appropriate final message
  async function monitorIndexStatus(chunksCount: number, operationType: "create" | "sync" = "create"): Promise<void> {
    const maxAttempts = 60 // Max 5 minutes (5s intervals)
    let attempts = 0
    
    while (attempts < maxAttempts) {
      try {
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
          const { ready, detailed_state, indexed_row_count, index_status } = statusResult
          
          // Update message based on current state
          const stateMessage = index_status === "CREATED" 
            ? "Aguardando inicialização..." 
            : detailed_state 
              ? `${operationType === "sync" ? "Sincronizando" : "Criando"}: ${detailed_state}...`
              : `${operationType === "sync" ? "Sincronizando" : "Criando"}...`
          
          setAutoProcessStatus(prev => ({
            ...prev,
            message: ready 
              ? `Index pronto! ${indexed_row_count || chunksCount} segmentos indexados.`
              : stateMessage,
            indexAction: ready 
              ? (operationType === "sync" ? "synced" : "created")
              : (index_status === "CREATED" ? "waiting_creation" : (operationType === "sync" ? "waiting_sync" : "waiting_creation"))
          }))
          
          if (ready) {
            // Index is ready!
            const endTime = Date.now()
            const totalTime = Math.floor((endTime - (processingStartTime || endTime)) / 1000)
            setTotalProcessingTime(totalTime)
            setStepEndTimes(prev => ({ ...prev, creating_index: endTime }))
            
            const finalMessage = operationType === "sync" 
              ? `Vector Index sincronizado! ${indexed_row_count || chunksCount} segmentos.`
              : `Vector Index criado! ${indexed_row_count || chunksCount} segmentos.`
            
            setAutoProcessStatus(prev => ({
              ...prev,
              step: "completed",
              message: finalMessage,
              progress: 100,
              indexAction: operationType === "sync" ? "synced" : "created"
            }))
            
            setProcessingStatus({
              status: "completed",
              message: `Processamento concluído com sucesso!`,
              progress: 100,
              totalFiles: selectedDocuments.size,
              processedFiles: selectedDocuments.size
            })
            
            toast.success(operationType === "sync" ? "Index sincronizado!" : "Index criado!", {
              description: `${indexed_row_count || chunksCount} segmentos indexados.`,
              duration: 6000
            })
            return
          }
        } else {
          console.log("Index status check failed:", statusResult.error)
        }
        
        // Wait 5 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 5000))
        attempts++
        
      } catch (error) {
        console.error("Error checking index status:", error)
        attempts++
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
    
    // Timeout - mark as completed with warning
    const endTime = Date.now()
    const totalTime = Math.floor((endTime - (processingStartTime || endTime)) / 1000)
    setTotalProcessingTime(totalTime)
    setStepEndTimes(prev => ({ ...prev, creating_index: endTime }))
    
    setAutoProcessStatus(prev => ({
      ...prev,
      step: "completed",
      message: `Chunks criados. ${operationType === "sync" ? "Sync" : "Criação"} em andamento (timeout).`,
      progress: 100
    }))
    
    toast.warning(`${operationType === "sync" ? "Sync" : "Criação"} ainda em andamento`, {
      description: "O índice está sendo processado em background.",
      duration: 8000
    })
  }

  // Create Vector Index after auto processing
  // Logic: if index exists with same endpoint -> sync, different endpoint -> delete & recreate, not exists -> create
  async function createVectorIndexAfterProcessing(chunksCount: number) {
    const indexName = `${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}_vs`
    const configuredEndpoint = vsEndpointName // From app.yaml VECTOR_SEARCH_ENDPOINT
    
    // Mark index creation start time
    setStepStartTimes(prev => ({ ...prev, creating_index: Date.now() }))
    
    setAutoProcessStatus(prev => ({
      ...prev,
      step: "creating_index",
      message: "Verificando Vector Index...",
      progress: 90,
      indexAction: "checking"
    }))
    
    try {
      // Step 1: Check if index already exists
      const checkResponse = await fetch("/api/vector-search/index/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          endpoint_name: configuredEndpoint,
          embedding_model: embeddingModel,
          sync_type: indexSyncType
        })
      })
      
      const checkResult = await checkResponse.json()
      
      if (checkResult.exists) {
        const existingEndpoint = checkResult.endpoint_name || ""
        console.log(`Index exists with endpoint: ${existingEndpoint}, configured: ${configuredEndpoint}`)
        
        if (existingEndpoint === configuredEndpoint) {
          // Same endpoint -> just sync
          setAutoProcessStatus(prev => ({
            ...prev,
            message: "Sincronizando Vector Index...",
            indexAction: "syncing"
          }))
          
          const syncResponse = await fetch("/api/vector-search/index/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tableConfig,
              endpoint_name: configuredEndpoint,
              embedding_model: embeddingModel,
              sync_type: indexSyncType
            })
          })
          
          const syncResult = await syncResponse.json()
          
          if (!syncResult.success) {
            // Sync trigger failed - show error
            const endTime = Date.now()
            const totalTime = Math.floor((endTime - (processingStartTime || endTime)) / 1000)
            setTotalProcessingTime(totalTime)
            setStepEndTimes(prev => ({ ...prev, creating_index: endTime }))
            
            setAutoProcessStatus(prev => ({
              ...prev,
              step: "error",
              message: `Erro no sync: ${syncResult.error || "Falha desconhecida"}`,
              progress: 95
            }))
            
            toast.error("Erro ao sincronizar índice", {
              description: syncResult.error,
              duration: 8000
            })
            return
          }
          
          // Check if initializing (CREATED state)
          if (syncResult.status === "INITIALIZING") {
            setAutoProcessStatus(prev => ({
              ...prev,
              message: "Aguardando inicialização do índice...",
              indexAction: "waiting_creation"
            }))
          } else {
            setAutoProcessStatus(prev => ({
              ...prev,
              message: "Aguardando sincronização...",
              indexAction: "waiting_sync"
            }))
          }
          
          // Monitor sync status until ready
          await monitorIndexStatus(chunksCount, "sync")
          return
        } else {
          // Different endpoint -> delete and recreate
          setAutoProcessStatus(prev => ({
            ...prev,
            message: `Endpoint diferente. Recriando índice...`,
            indexAction: "creating"
          }))
          
          toast.info(`Index usa endpoint diferente. Recriando com ${configuredEndpoint}...`)
          
          const deleteResponse = await fetch("/api/vector-search/index/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tableConfig,
              endpoint_name: configuredEndpoint,
              embedding_model: embeddingModel,
              sync_type: indexSyncType
            })
          })
          
          if (deleteResponse.ok) {
            console.log("Index deleted, waiting before recreation...")
            await new Promise(resolve => setTimeout(resolve, 3000))
          }
        }
      }
      
      // Step 2: Create new index (either doesn't exist or was deleted)
      setAutoProcessStatus(prev => ({
        ...prev,
        message: "Criando Vector Index...",
        indexAction: "creating"
      }))
      
      // Use AbortController for timeout handling
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 55000) // 55s to avoid gateway timeout
      
      try {
        const createResponse = await fetch("/api/vector-search/index/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tableConfig,
            endpoint_name: configuredEndpoint,
            embedding_model: embeddingModel,
            sync_type: indexSyncType
          }),
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
        const createResult = await createResponse.json()
        
        if (createResult.success || createResult.timeout) {
          // Index creation initiated (or timed out but may still be creating)
          setAutoProcessStatus(prev => ({
            ...prev,
            message: "Aguardando criação do índice...",
            indexAction: "waiting_creation"
          }))
          
          // Wait a bit before polling
          await new Promise(resolve => setTimeout(resolve, 3000))
          await monitorIndexStatus(chunksCount, "create")
        } else {
          throw new Error(createResult.error || "Falha ao criar index")
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        
        // If aborted due to timeout, still try to monitor (index may be creating)
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          console.log("Create request timed out, will poll status anyway...")
          setAutoProcessStatus(prev => ({
            ...prev,
            message: "Aguardando criação do índice...",
            indexAction: "waiting_creation"
          }))
          
          // Wait a bit then check if index was created
          await new Promise(resolve => setTimeout(resolve, 5000))
          await monitorIndexStatus(chunksCount, "create")
          return
        }
        
        throw fetchError
      }
      
    } catch (error) {
      console.error("Vector index creation error:", error)
      setStepEndTimes(prev => ({ ...prev, creating_index: Date.now() }))
      
      const errorMsg = error instanceof Error ? error.message : "erro desconhecido"
      
      setAutoProcessStatus(prev => ({
        ...prev,
        step: "error",
        message: `Erro no índice: ${errorMsg}`,
        progress: 95
      }))
      
      setProcessingStatus({
        status: "error",
        message: `Chunks criados. Vector Index com erro: ${errorMsg}`,
        progress: 100,
        totalFiles: selectedDocuments.size,
        processedFiles: selectedDocuments.size
      })
      
      toast.error("Erro na criação do Vector Index", {
        description: errorMsg,
        duration: 8000
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

        {/* Step 1: Select Documents from _parsed table */}
        <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
          activeStep === 2 ? 'border-[var(--color-primary)]' : 'border-gray-200'
        }`}>
          <button
            onClick={() => setActiveStep(activeStep === 2 ? null : 2)}
            disabled={!isConfigSaved}
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

        {/* Strategy Chunks Preview Modal */}
        {viewingChunksStrategy && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
                <div>
                  <h3 className="text-lg font-semibold text-[var(--color-text)]">
                    Prévia dos Chunks - Estratégia {viewingChunksStrategy}: {
                      viewingChunksStrategy === "A" ? t("prepare.autoProcess.steps.recursive") :
                      viewingChunksStrategy === "B" ? t("prepare.autoProcess.steps.fixedSize") :
                      t("prepare.autoProcess.steps.structural")
                    }
                  </h3>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {viewingChunksStrategy === "A" && autoProcessStatus.evaluationA && (
                      <>{autoProcessStatus.evaluationA.chunks_count} chunks totais • Score: {autoProcessStatus.evaluationA.avg_score.toFixed(1)}/10</>
                    )}
                    {viewingChunksStrategy === "B" && autoProcessStatus.evaluationB && (
                      <>{autoProcessStatus.evaluationB.chunks_count} chunks totais • Score: {autoProcessStatus.evaluationB.avg_score.toFixed(1)}/10</>
                    )}
                    {viewingChunksStrategy === "C" && autoProcessStatus.evaluationC && (
                      <>{autoProcessStatus.evaluationC.chunks_count} chunks totais • Score: {autoProcessStatus.evaluationC.avg_score.toFixed(1)}/10</>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setViewingChunksStrategy(null)}
                  className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <div className="space-y-3">
                  {(() => {
                    const chunks = viewingChunksStrategy === "A" ? autoProcessStatus.evaluationA?.sample_chunks :
                                   viewingChunksStrategy === "B" ? autoProcessStatus.evaluationB?.sample_chunks :
                                   autoProcessStatus.evaluationC?.sample_chunks
                    
                    if (!chunks || chunks.length === 0) {
                      return <p className="text-gray-500 text-sm">Nenhum chunk disponível para visualização</p>
                    }
                    
                    // Group by file
                    const byFile = chunks.reduce((acc, chunk) => {
                      if (!acc[chunk.file_name]) acc[chunk.file_name] = []
                      acc[chunk.file_name].push(chunk)
                      return acc
                    }, {} as Record<string, SampleChunk[]>)
                    
                    return Object.entries(byFile).map(([fileName, fileChunks]) => (
                      <div key={fileName} className="border border-gray-200 rounded-lg overflow-hidden">
                        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                          <span className="text-sm font-medium text-gray-700">{fileName}</span>
                          <span className="text-xs text-gray-500 ml-2">({fileChunks[0]?.total_chunks} chunks)</span>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {fileChunks.map((chunk, idx) => (
                            <div key={idx} className="p-3">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
                                  #{chunk.chunk_index + 1}
                                </span>
                                <span className="text-xs text-gray-400">{chunk.char_count} caracteres</span>
                              </div>
                              <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono bg-gray-50 p-2 rounded">
                                {chunk.content}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  })()}
                </div>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex justify-end">
                <button
                  onClick={() => setViewingChunksStrategy(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Auto Processing Status */}
        {autoProcessStatus.step !== "idle" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
            {autoProcessStatus.step === "completed" ? (
              <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
            ) : autoProcessStatus.step === "error" ? (
              <XCircle className="h-5 w-5 text-red-600" />
            ) : (
              <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin" />
            )}
            <h2 className="text-lg font-semibold text-[var(--color-text)]">
              {autoProcessStatus.step === "completed" ? "Processamento Concluído" :
               autoProcessStatus.step === "error" ? "Erro no Processamento" :
               "Processamento Automático"}
            </h2>
            {totalProcessingTime > 0 && (
              <span className={`ml-auto font-mono text-sm px-2 py-0.5 rounded ${
                autoProcessStatus.step === "completed"
                  ? "bg-[var(--color-success-light)] text-[var(--color-success)]"
                  : "bg-gray-100 text-gray-600"
              }`}>
                {formatTime(totalProcessingTime)}
              </span>
            )}
          </div>
          
          <div className="p-4">
            {/* Progress Steps */}
            <div className="space-y-3">
              {/* Step 1: Generating Questions */}
              <div>
                <div className="flex items-center gap-3">
                  {autoProcessStatus.step === "generating_questions" ? (
                    <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                  ) : ["chunking_parallel", "chunking_a", "chunking_b", "chunking_c", "evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? (
                    <CheckCircle2 className="h-5 w-5 text-[var(--color-success)] flex-shrink-0" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                  )}
                  <span className={`text-sm flex-1 ${
                    autoProcessStatus.step === "generating_questions" ? "text-[var(--color-primary)] font-medium" :
                    ["chunking_parallel", "chunking_a", "chunking_b", "chunking_c", "evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? "text-[var(--color-success)]" :
                    "text-gray-500"
                  }`}>
                    {["chunking_parallel", "chunking_a", "chunking_b", "chunking_c", "evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) 
                      ? "Perguntas de teste geradas" 
                      : "Gerando perguntas de teste"}
                  </span>
                  {autoProcessStatus.questions && autoProcessStatus.questions.length > 0 && (
                    <button 
                      onClick={() => setShowQuestions(!showQuestions)}
                      className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${showQuestions ? "rotate-90" : ""}`} />
                    </button>
                  )}
                  {autoProcessStatus.step === "generating_questions" && stepStartTimes.generating_questions && !stepEndTimes.generating_questions && (
                    <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                      {formatTime(currentStepTime)}
                    </span>
                  )}
                  {stepEndTimes.generating_questions && stepStartTimes.generating_questions && autoProcessStatus.step !== "generating_questions" && (
                    <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      {formatTime(Math.floor((stepEndTimes.generating_questions - stepStartTimes.generating_questions) / 1000))}
                    </span>
                  )}
                </div>
                {/* Expandable questions list */}
                {showQuestions && autoProcessStatus.questions && autoProcessStatus.questions.length > 0 && (
                  <div className="ml-8 mt-2 p-2 bg-gray-50 rounded-lg text-xs text-gray-600 space-y-1">
                    {autoProcessStatus.questions.map((q, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-gray-400">{i + 1}.</span>
                        <span>{q}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Step 2-4: Parallel Chunking Strategies - Collapsible */}
              <div>
                <div className="flex items-center gap-3">
                  {autoProcessStatus.step === "chunking_parallel" ? (
                    <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                  ) : ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? (
                    <CheckCircle2 className="h-5 w-5 text-[var(--color-success)] flex-shrink-0" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                  )}
                  <span className={`text-sm flex-1 ${
                    autoProcessStatus.step === "chunking_parallel" ? "text-[var(--color-primary)] font-medium" :
                    ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? "text-[var(--color-success)]" :
                    "text-gray-500"
                  }`}>
                    {["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step)
                      ? "Estratégias A / B / C aplicadas"
                      : "Aplicando estratégias A / B / C"}
                  </span>
                  {(autoProcessStatus.strategyStatus || autoProcessStatus.evaluationA) && (
                    <button 
                      onClick={() => setShowStrategies(!showStrategies)}
                      className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${showStrategies ? "rotate-90" : ""}`} />
                    </button>
                  )}
                  {autoProcessStatus.step === "chunking_parallel" && stepStartTimes.chunking_parallel && !stepEndTimes.chunking_parallel && (
                    <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                      {formatTime(currentStepTime)}
                    </span>
                  )}
                  {stepEndTimes.chunking_parallel && stepStartTimes.chunking_parallel && autoProcessStatus.step !== "chunking_parallel" && (
                    <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      {formatTime(Math.floor((stepEndTimes.chunking_parallel - stepStartTimes.chunking_parallel) / 1000))}
                    </span>
                  )}
                </div>
                
                {/* Expandable strategies list */}
                {showStrategies && (
                  <div className="ml-8 mt-2 p-3 bg-gray-50 rounded-lg space-y-2">
                    {/* Strategy A: Recursivo */}
                    <div className="flex items-center gap-3">
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.A === "processing" ? (
                        <Loader2 className="h-4 w-4 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                      ) : ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.A === "completed" ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)] flex-shrink-0" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                      )}
                      <div className={`text-xs flex-1 ${
                        autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.A === "processing" ? "text-[var(--color-primary)] font-medium" :
                        ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.A === "completed" ? "text-[var(--color-success)]" :
                        "text-gray-500"
                      }`}>
                        <span>A: {t("prepare.autoProcess.steps.recursive")}</span>
                        {autoProcessStatus.tables?.tempRecursive && (
                          <span className="ml-2 font-mono text-gray-400">({autoProcessStatus.tables.tempRecursive})</span>
                        )}
                      </div>
                      {autoProcessStatus.evaluationA && (
                        <span className="text-xs text-gray-500">{autoProcessStatus.evaluationA.chunks_count} chunks</span>
                      )}
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyProgress?.A !== undefined && autoProcessStatus.strategyProgress.A < 100 && (
                        <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-1.5 py-0.5 rounded">
                          {autoProcessStatus.strategyProgress.A}%
                        </span>
                      )}
                    </div>

                    {/* Strategy B: Tamanho Fixo */}
                    <div className="flex items-center gap-3">
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.B === "processing" ? (
                        <Loader2 className="h-4 w-4 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                      ) : ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.B === "completed" ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)] flex-shrink-0" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                      )}
                      <div className={`text-xs flex-1 ${
                        autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.B === "processing" ? "text-[var(--color-primary)] font-medium" :
                        ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.B === "completed" ? "text-[var(--color-success)]" :
                        "text-gray-500"
                      }`}>
                        <span>B: {t("prepare.autoProcess.steps.fixedSize")}</span>
                        {autoProcessStatus.tables?.tempFixedSize && (
                          <span className="ml-2 font-mono text-gray-400">({autoProcessStatus.tables.tempFixedSize})</span>
                        )}
                      </div>
                      {autoProcessStatus.evaluationB && (
                        <span className="text-xs text-gray-500">{autoProcessStatus.evaluationB.chunks_count} chunks</span>
                      )}
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyProgress?.B !== undefined && autoProcessStatus.strategyProgress.B < 100 && (
                        <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-1.5 py-0.5 rounded">
                          {autoProcessStatus.strategyProgress.B}%
                        </span>
                      )}
                    </div>

                    {/* Strategy C: Estrutural */}
                    <div className="flex items-center gap-3">
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.C === "processing" ? (
                        <Loader2 className="h-4 w-4 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                      ) : ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.C === "completed" ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)] flex-shrink-0" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                      )}
                      <div className={`text-xs flex-1 ${
                        autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyStatus?.C === "processing" ? "text-[var(--color-primary)] font-medium" :
                        ["evaluating", "selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) || autoProcessStatus.strategyStatus?.C === "completed" ? "text-[var(--color-success)]" :
                        "text-gray-500"
                      }`}>
                        <span>C: {t("prepare.autoProcess.steps.structural")}</span>
                        {autoProcessStatus.tables?.tempStructural && (
                          <span className="ml-2 font-mono text-gray-400">({autoProcessStatus.tables.tempStructural})</span>
                        )}
                      </div>
                      {autoProcessStatus.evaluationC && (
                        <span className="text-xs text-gray-500">{autoProcessStatus.evaluationC.chunks_count} chunks</span>
                      )}
                      {autoProcessStatus.step === "chunking_parallel" && autoProcessStatus.strategyProgress?.C !== undefined && autoProcessStatus.strategyProgress.C < 100 && (
                        <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-1.5 py-0.5 rounded">
                          {autoProcessStatus.strategyProgress.C}%
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              
              {/* Step 5: Evaluation (Parallel) */}
              <div>
                <div className="flex items-center gap-3">
                  {autoProcessStatus.step === "evaluating" ? (
                    <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                  ) : ["selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? (
                    <CheckCircle2 className="h-5 w-5 text-[var(--color-success)] flex-shrink-0" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                  )}
                  <div className={`text-sm flex-1 ${
                    autoProcessStatus.step === "evaluating" ? "text-[var(--color-primary)] font-medium" :
                    ["selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step) ? "text-[var(--color-success)]" :
                    "text-gray-500"
                  }`}>
                    <span>
                      {["selecting", "applying", "creating_index", "completed"].includes(autoProcessStatus.step)
                        ? "Estratégias A / B / C avaliadas"
                        : "Avaliando estratégias A / B / C"}
                    </span>
                    {/* Show parallel evaluation progress */}
                    {autoProcessStatus.step === "evaluating" && autoProcessStatus.evalProgress && (
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        ({["A", "B", "C"].filter(k => autoProcessStatus.evalProgress?.[k as "A" | "B" | "C"] === "completed").join(", ") || "iniciando"} 
                        {["A", "B", "C"].filter(k => autoProcessStatus.evalProgress?.[k as "A" | "B" | "C"] === "completed").length > 0 ? " ✓" : "..."})
                      </span>
                    )}
                  </div>
                  {(autoProcessStatus.evaluationA || autoProcessStatus.evaluationB || autoProcessStatus.evaluationC) && (
                    <button 
                      onClick={() => setShowEvaluationResults(!showEvaluationResults)}
                      className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${showEvaluationResults ? "rotate-90" : ""}`} />
                    </button>
                  )}
                  {autoProcessStatus.step === "evaluating" && stepStartTimes.evaluating && !stepEndTimes.evaluating && (
                    <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                      {formatTime(currentStepTime)}
                    </span>
                  )}
                  {stepEndTimes.evaluating && stepStartTimes.evaluating && autoProcessStatus.step !== "evaluating" && (
                    <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      {formatTime(Math.floor((stepEndTimes.evaluating - stepStartTimes.evaluating) / 1000))}
                    </span>
                  )}
                </div>
                
                {/* Evaluation Results - Expandable */}
                {showEvaluationResults && (autoProcessStatus.evaluationA || autoProcessStatus.evaluationB || autoProcessStatus.evaluationC) && (
                  <div className="ml-8 mt-2 p-3 bg-gray-50 rounded-lg">
                    <div className="grid grid-cols-3 gap-2 text-sm">
                        {autoProcessStatus.evaluationA && (
                          <div className={`p-2 rounded ${autoProcessStatus.bestStrategy === "recursive" ? "bg-[var(--color-success-light)] border border-[var(--color-success)]" : "bg-white border border-gray-200"}`}>
                            <div className="flex items-center justify-between">
                              <div className="font-medium text-gray-700 text-xs">A: {t("prepare.autoProcess.steps.recursive")}</div>
                              {autoProcessStatus.evaluationA.sample_chunks && autoProcessStatus.evaluationA.sample_chunks.length > 0 && (
                                <button
                                  onClick={() => setViewingChunksStrategy("A")}
                                  className="text-[10px] text-gray-400 hover:text-[var(--color-primary)] p-0.5"
                                  title="Ver chunks"
                                >
                                  <Eye className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {autoProcessStatus.evaluationA.avg_score.toFixed(1)}/10
                            </div>
                            {autoProcessStatus.bestStrategy === "recursive" && (
                              <div className="text-xs text-[var(--color-success)] font-medium">✓ {t("prepare.autoProcess.results.best")}</div>
                            )}
                          </div>
                        )}
                        {autoProcessStatus.evaluationB && (
                          <div className={`p-2 rounded ${autoProcessStatus.bestStrategy === "fixed_size" ? "bg-[var(--color-success-light)] border border-[var(--color-success)]" : "bg-white border border-gray-200"}`}>
                            <div className="flex items-center justify-between">
                              <div className="font-medium text-gray-700 text-xs">B: {t("prepare.autoProcess.steps.fixedSize")}</div>
                              {autoProcessStatus.evaluationB.sample_chunks && autoProcessStatus.evaluationB.sample_chunks.length > 0 && (
                                <button
                                  onClick={() => setViewingChunksStrategy("B")}
                                  className="text-[10px] text-gray-400 hover:text-[var(--color-primary)] p-0.5"
                                  title="Ver chunks"
                                >
                                  <Eye className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {autoProcessStatus.evaluationB.avg_score.toFixed(1)}/10
                            </div>
                            {autoProcessStatus.bestStrategy === "fixed_size" && (
                              <div className="text-xs text-[var(--color-success)] font-medium">✓ {t("prepare.autoProcess.results.best")}</div>
                            )}
                          </div>
                        )}
                        {autoProcessStatus.evaluationC && (
                          <div className={`p-2 rounded ${autoProcessStatus.bestStrategy === "structural" ? "bg-[var(--color-success-light)] border border-[var(--color-success)]" : "bg-white border border-gray-200"}`}>
                            <div className="flex items-center justify-between">
                              <div className="font-medium text-gray-700 text-xs">C: {t("prepare.autoProcess.steps.structural")}</div>
                              {autoProcessStatus.evaluationC.sample_chunks && autoProcessStatus.evaluationC.sample_chunks.length > 0 && (
                                <button
                                  onClick={() => setViewingChunksStrategy("C")}
                                  className="text-[10px] text-gray-400 hover:text-[var(--color-primary)] p-0.5"
                                  title="Ver chunks"
                                >
                                  <Eye className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {autoProcessStatus.evaluationC.avg_score.toFixed(1)}/10
                            </div>
                            {autoProcessStatus.bestStrategy === "structural" && (
                              <div className="text-xs text-[var(--color-success)] font-medium">✓ {t("prepare.autoProcess.results.best")}</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              
              {/* Step 6: Applying best strategy to all files */}
              <div className="flex items-center gap-3">
                {autoProcessStatus.step === "applying" || autoProcessStatus.step === "selecting" ? (
                  <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                ) : ["creating_index", "completed"].includes(autoProcessStatus.step) ? (
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-success)] flex-shrink-0" />
                ) : (
                  <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                )}
                <div className={`text-sm flex-1 ${
                  autoProcessStatus.step === "applying" || autoProcessStatus.step === "selecting" ? "text-[var(--color-primary)] font-medium" :
                  ["creating_index", "completed"].includes(autoProcessStatus.step) ? "text-[var(--color-success)]" :
                  "text-gray-500"
                }`}>
                  <span>
                    {["creating_index", "completed"].includes(autoProcessStatus.step) ? "Estratégia aplicada" : t("prepare.autoProcess.steps.applying")}
                    {autoProcessStatus.bestStrategy && ["applying", "creating_index", "completed"].includes(autoProcessStatus.step) && (
                      <span className="font-semibold ml-1">
                        ({autoProcessStatus.bestStrategy === "recursive" ? t("prepare.autoProcess.steps.recursive") :
                          autoProcessStatus.bestStrategy === "fixed_size" ? t("prepare.autoProcess.steps.fixedSize") :
                          autoProcessStatus.bestStrategy === "structural" ? t("prepare.autoProcess.steps.structural") :
                          autoProcessStatus.bestStrategy})
                      </span>
                    )}
                  </span>
                  {autoProcessStatus.tables?.chunks && (
                    <span className="ml-2 text-xs font-mono text-gray-400">→ {autoProcessStatus.tables.chunks}</span>
                  )}
                </div>
                {autoProcessStatus.finalChunks && ["creating_index", "completed"].includes(autoProcessStatus.step) && (
                  <span className="text-xs text-gray-500">{autoProcessStatus.finalChunks} chunks</span>
                )}
                {(autoProcessStatus.step === "applying" || autoProcessStatus.step === "selecting") && stepStartTimes.applying && !stepEndTimes.applying && (
                  <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                    {formatTime(currentStepTime)}
                  </span>
                )}
                {stepEndTimes.applying && stepStartTimes.applying && !["applying", "selecting"].includes(autoProcessStatus.step) && (
                  <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                    {formatTime(Math.floor((stepEndTimes.applying - stepStartTimes.applying) / 1000))}
                  </span>
                )}
              </div>
              
              {/* Step 7: Vector Index */}
              <div className="flex items-center gap-3">
                {autoProcessStatus.step === "creating_index" ? (
                  <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin flex-shrink-0" />
                ) : autoProcessStatus.step === "completed" ? (
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-success)] flex-shrink-0" />
                ) : autoProcessStatus.step === "error" ? (
                  <XCircle className="h-5 w-5 text-[var(--color-error)] flex-shrink-0" />
                ) : (
                  <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                )}
                <div className={`text-sm flex-1 ${
                  autoProcessStatus.step === "creating_index" ? "text-[var(--color-primary)] font-medium" :
                  autoProcessStatus.step === "completed" ? "text-[var(--color-success)]" :
                  autoProcessStatus.step === "error" ? "text-[var(--color-error)] font-medium" :
                  "text-gray-500"
                }`}>
                  <span>
                    {autoProcessStatus.step === "completed" 
                      ? (autoProcessStatus.indexAction === "synced" ? "Vector Index sincronizado" : "Vector Index criado")
                      : autoProcessStatus.step === "error"
                        ? "Erro no Vector Index"
                        : autoProcessStatus.step === "creating_index"
                          ? (autoProcessStatus.indexAction === "checking" ? "Verificando Vector Index..."
                            : autoProcessStatus.indexAction === "creating" ? "Criando Vector Index..."
                            : autoProcessStatus.indexAction === "syncing" ? "Sincronizando Vector Index..."
                            : autoProcessStatus.indexAction === "waiting_creation" ? "Aguardando criação..."
                            : autoProcessStatus.indexAction === "waiting_sync" ? "Aguardando sincronização..."
                            : "Processando Vector Index...")
                          : "Vector Index"}
                  </span>
                  {autoProcessStatus.indexName && (
                    <span className="ml-2 text-xs font-mono text-gray-400">({autoProcessStatus.indexName})</span>
                  )}
                </div>
                {autoProcessStatus.finalChunks && autoProcessStatus.step === "completed" && (
                  <span className="text-xs text-[var(--color-success)]">{autoProcessStatus.finalChunks} {t("prepare.autoProcess.chunksIndexed")}</span>
                )}
                {autoProcessStatus.step === "creating_index" && stepStartTimes.creating_index && !stepEndTimes.creating_index && (
                  <span className="text-xs font-mono text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded">
                    {formatTime(currentStepTime)}
                  </span>
                )}
                {stepEndTimes.creating_index && stepStartTimes.creating_index && autoProcessStatus.step !== "creating_index" && (
                  <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                    {formatTime(Math.floor((stepEndTimes.creating_index - stepStartTimes.creating_index) / 1000))}
                  </span>
                )}
              </div>
            </div>
            
            {/* Progress Bar - Blue=processing, Green=success, Red=error */}
            <div className="mt-4">
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full transition-all duration-300 ${
                    autoProcessStatus.step === "error" ? "bg-[var(--color-error)]" :
                    autoProcessStatus.step === "completed" ? "bg-[var(--color-success)]" :
                    "bg-[var(--color-accent)]"
                  }`}
                  style={{ width: `${autoProcessStatus.progress}%` }}
                />
              </div>
            </div>
            
            {/* Status Message - Blue=processing, Green=success, Red=error */}
            {autoProcessStatus.message && (
              <div className={`mt-3 px-3 py-2 rounded-lg ${
                autoProcessStatus.step === "error" ? "bg-[var(--color-error-light)] text-[var(--color-error)]" :
                autoProcessStatus.step === "completed" ? "bg-[var(--color-success-light)] text-[var(--color-success)]" :
                "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{autoProcessStatus.message}</span>
                  {autoProcessStatus.currentFileIndex && autoProcessStatus.totalFiles && 
                   !["completed", "error", "evaluating", "selecting", "creating_index"].includes(autoProcessStatus.step) && (
                    <span className="text-xs font-mono bg-white/50 px-2 py-0.5 rounded">
                      {autoProcessStatus.currentFileIndex}/{autoProcessStatus.totalFiles}
                    </span>
                  )}
                </div>
                {autoProcessStatus.currentFile && 
                 !["completed", "error", "evaluating", "selecting", "creating_index"].includes(autoProcessStatus.step) && (
                  <div className="text-xs mt-1 opacity-80 truncate">
                    📄 {autoProcessStatus.currentFile}
                  </div>
                )}
              </div>
            )}
            
            {/* Completed Button */}
            {(autoProcessStatus.step === "completed" || autoProcessStatus.step === "error") && (
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => {
                    setAutoProcessStatus({ step: "idle", message: "", progress: 0 })
                    setProcessingStatus({ status: "idle", message: "", progress: 0, totalFiles: 0, processedFiles: 0 })
                    setStepStartTimes({})
                    setStepEndTimes({})
                    setShowQuestions(false)
                    setShowEvaluationResults(false)
                    setSelectedFiles(new Set())
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-success)] rounded-lg hover:bg-[var(--color-success)]/90 transition-colors shadow-sm flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("import.fileList.completed")}
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
