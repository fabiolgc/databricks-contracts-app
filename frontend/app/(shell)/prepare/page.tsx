"use client"

import { useState, useEffect } from "react"
import { 
  Database, 
  Settings, 
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
  Layers
} from "lucide-react"
import { toast, Toaster } from "sonner"

// Types
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

// Chunking Strategies based on Databricks best practices
const CHUNKING_STRATEGIES: ChunkingStrategy[] = [
  {
    id: "fixed_size",
    name: "Tamanho Fixo",
    description: "Divide o texto em chunks de tamanho igual com overlap configurável. Simples e eficiente.",
    params: { chunkSize: 1000, chunkOverlap: 200 }
  },
  {
    id: "recursive",
    name: "Recursivo por Caractere",
    description: "Divide recursivamente por separadores naturais (\\n\\n, \\n, espaço). Mantém contexto semântico.",
    params: { chunkSize: 1000, chunkOverlap: 200, separator: "\\n\\n" }
  },
  {
    id: "by_page",
    name: "Por Página",
    description: "Cada página do PDF se torna um chunk. Ideal para documentos estruturados por página.",
    params: {}
  },
  {
    id: "by_sentence",
    name: "Por Sentença",
    description: "Agrupa sentenças completas até atingir o tamanho máximo. Preserva estrutura gramatical.",
    params: { chunkSize: 1000, chunkOverlap: 100 }
  },
  {
    id: "semantic",
    name: "Semântico",
    description: "Usa embeddings para identificar quebras naturais de tópico. Maior precisão, mais lento.",
    params: { chunkSize: 1500 }
  }
]

export default function PreparePage() {
  // State for table configuration
  const [tableConfig, setTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts_chunks"
  })
  const [isConfigSaved, setIsConfigSaved] = useState(false)
  
  // State for volume files
  const [volumeFiles, setVolumeFiles] = useState<VolumeFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  
  // State for chunking
  const [selectedStrategy, setSelectedStrategy] = useState<string>("recursive")
  const [chunkingParams, setChunkingParams] = useState({
    chunkSize: 1000,
    chunkOverlap: 200
  })
  
  // State for processing
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({
    status: "idle",
    message: "",
    progress: 0,
    totalFiles: 0,
    processedFiles: 0
  })
  
  // State for table existence check
  const [tableExists, setTableExists] = useState<boolean | null>(null)
  const [existingRecords, setExistingRecords] = useState<number>(0)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importMode, setImportMode] = useState<"append" | "overwrite" | "clean" | null>(null)
  
  // State for chunk preview
  const [showPreview, setShowPreview] = useState(false)
  const [chunkPreviews, setChunkPreviews] = useState<ChunkPreview[]>([])
  const [previewPage, setPreviewPage] = useState(1)
  const [previewDocIndex, setPreviewDocIndex] = useState(0)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const CHUNKS_PER_PAGE = 5

  // Load environment config on mount
  useEffect(() => {
    // Load default config from environment
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          setTableConfig(prev => ({
            ...prev,
            catalog: config.catalog || "",
            schema: config.schema || ""
          }))
        }
      } catch (error) {
        console.error("Error loading config:", error)
      }
    }
    loadConfig()
  }, [])

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
    if (selectedFiles.size === 0) {
      toast.warning("Selecione pelo menos um arquivo para processar")
      return
    }
    
    if (!isConfigSaved) {
      toast.warning("Salve a configuração da tabela primeiro")
      return
    }
    
    // Check if table exists and has data
    if (tableExists && existingRecords > 0) {
      setShowImportDialog(true)
      return
    }
    
    // If table doesn't exist or is empty, proceed directly
    await executeProcessing("append")
  }

  // Execute the actual processing - file by file
  async function executeProcessing(mode: "append" | "overwrite" | "clean") {
    setShowImportDialog(false)
    setImportMode(mode)
    
    const strategy = CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)
    const filesToProcess = Array.from(selectedFiles)
    
    setProcessingStatus({
      status: "processing",
      message: "Inicializando tabelas...",
      progress: 0,
      totalFiles: filesToProcess.length,
      processedFiles: 0
    })
    
    try {
      // Step 1: Initialize tables
      const initResponse = await fetch("/api/process/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          files: filesToProcess,
          strategy: selectedStrategy,
          params: { ...strategy?.params, ...chunkingParams },
          mode
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
              params: { ...strategy?.params, ...chunkingParams },
              mode: mode === "clean" ? "overwrite" : mode // For individual files, 'clean' acts as 'overwrite'
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
              message: `✓ ${fileName} - ${fileResult.chunksCreated} chunks criados`,
              progress: Math.round((fileNumber / totalFiles) * 100),
              totalFiles: totalFiles,
              processedFiles: processedCount
            })
            
            toast.success(`Arquivo ${fileNumber}/${totalFiles}: ${fileName}`, {
              description: `${fileResult.textLength?.toLocaleString() || 0} caracteres → ${fileResult.chunksCreated} chunks`,
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
      setProcessingStatus({
        status: success ? "completed" : "error",
        message: success 
          ? `Processamento concluído! ${totalChunks} chunks criados em ${processedCount} arquivo(s).`
          : `Concluído com ${errors.length} erro(s). ${totalChunks} chunks criados.`,
        progress: 100,
        totalFiles: actualFilesToProcess.length,
        processedFiles: processedCount
      })
      
      if (success) {
        toast.success("Processamento concluído!", {
          description: `${processedCount} arquivos processados, ${totalChunks} chunks criados`,
          duration: 6000
        })
      }
      
      // Refresh file list to show imported status
      await loadVolumeFiles()
      
      // Update table info
      setExistingRecords(prev => mode === "clean" ? totalChunks : prev + totalChunks)
      
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

  // Load chunk previews
  async function loadChunkPreviews() {
    setIsLoadingPreview(true)
    try {
      const response = await fetch("/api/chunks/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          limit: 50
        })
      })
      
      if (!response.ok) {
        throw new Error("Failed to load previews")
      }
      
      const data = await response.json()
      setChunkPreviews(data.chunks || [])
      setShowPreview(true)
      setPreviewPage(1)
      setPreviewDocIndex(0)
      
    } catch (error) {
      console.error("Error loading previews:", error)
      toast.error("Erro ao carregar preview", {
        description: error instanceof Error ? error.message : "Erro desconhecido"
      })
    } finally {
      setIsLoadingPreview(false)
    }
  }

  // Get unique documents from previews
  const uniqueDocuments = [...new Set(chunkPreviews.map(c => c.documentName))]
  const currentDocChunks = chunkPreviews.filter(c => c.documentName === uniqueDocuments[previewDocIndex])
  const totalPreviewPages = Math.ceil(currentDocChunks.length / CHUNKS_PER_PAGE)
  const paginatedChunks = currentDocChunks.slice(
    (previewPage - 1) * CHUNKS_PER_PAGE,
    previewPage * CHUNKS_PER_PAGE
  )

  return (
    <>
      <Toaster position="top-right" richColors closeButton />
      
      {/* Import Mode Dialog */}
      {showImportDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-lg w-full">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="h-6 w-6 text-[#FF3621]" />
              <h3 className="text-xl font-bold text-[#1B1B1D]">
                Tabela já contém dados
              </h3>
            </div>
            <p className="text-base text-gray-600 mb-2">
              A tabela <span className="font-mono text-sm bg-gray-100 px-2 py-0.5 rounded">{tableConfig.tableName}</span> já possui <strong>{existingRecords}</strong> registros.
            </p>
            <p className="text-base text-gray-600 mb-6">
              Como deseja proceder com a importação?
            </p>
            
            <div className="flex flex-col gap-3">
              <button
                onClick={() => executeProcessing("append")}
                className="w-full px-4 py-3 text-sm font-medium text-white bg-[#00A972] rounded-lg hover:bg-[#00A972]/90 transition-colors flex items-center gap-3"
              >
                <Plus className="h-5 w-5" />
                <div className="text-left">
                  <div className="font-semibold">Adicionar novos</div>
                  <div className="text-xs opacity-80">Mantém dados existentes, adiciona apenas arquivos novos</div>
                </div>
              </button>
              
              <button
                onClick={() => executeProcessing("overwrite")}
                className="w-full px-4 py-3 text-sm font-medium text-[#FF3621] bg-red-50 rounded-lg hover:bg-red-100 transition-colors flex items-center gap-3"
              >
                <RefreshCw className="h-5 w-5" />
                <div className="text-left">
                  <div className="font-semibold">Sobrescrever existentes</div>
                  <div className="text-xs opacity-80">Atualiza arquivos que já existem, adiciona novos</div>
                </div>
              </button>
              
              <button
                onClick={() => executeProcessing("clean")}
                className="w-full px-4 py-3 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors flex items-center gap-3"
              >
                <Trash2 className="h-5 w-5" />
                <div className="text-left">
                  <div className="font-semibold">Limpar e reimportar tudo</div>
                  <div className="text-xs opacity-80">Remove todos os dados e processa do zero</div>
                </div>
              </button>
              
              <div className="mt-2 pt-4 border-t border-gray-200">
                <button
                  onClick={() => setShowImportDialog(false)}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Chunk Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-[#1B1B1D]">
                  Preview dos Chunks
                </h3>
                <p className="text-sm text-gray-600">
                  {uniqueDocuments.length} documento(s), {chunkPreviews.length} chunks total
                </p>
              </div>
              <button
                onClick={() => setShowPreview(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <XCircle className="h-6 w-6" />
              </button>
            </div>
            
            {/* Document Navigation */}
            <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-4">
              <span className="text-sm font-medium text-gray-700">Documento:</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setPreviewDocIndex(prev => Math.max(0, prev - 1))
                    setPreviewPage(1)
                  }}
                  disabled={previewDocIndex === 0}
                  className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm bg-white px-3 py-1 rounded border border-gray-300 min-w-[200px] text-center truncate">
                  {uniqueDocuments[previewDocIndex] || "Nenhum"}
                </span>
                <button
                  onClick={() => {
                    setPreviewDocIndex(prev => Math.min(uniqueDocuments.length - 1, prev + 1))
                    setPreviewPage(1)
                  }}
                  disabled={previewDocIndex >= uniqueDocuments.length - 1}
                  className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <span className="text-xs text-gray-500">
                {previewDocIndex + 1} de {uniqueDocuments.length}
              </span>
            </div>
            
            {/* Chunks List */}
            <div className="flex-1 overflow-y-auto p-6">
              {paginatedChunks.length > 0 ? (
                <div className="space-y-4">
                  {paginatedChunks.map((chunk, idx) => (
                    <div 
                      key={`${chunk.documentName}-${chunk.chunkIndex}`}
                      className="bg-gray-50 rounded-lg p-4 border border-gray-200"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-[#FF3621]">
                          Chunk {chunk.chunkIndex + 1} de {chunk.totalChunks}
                        </span>
                        <span className="text-xs text-gray-500">
                          {chunk.content.length} caracteres
                        </span>
                      </div>
                      <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200 max-h-40 overflow-y-auto">
                        {chunk.content}
                      </pre>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  Nenhum chunk disponível para visualização
                </div>
              )}
            </div>
            
            {/* Pagination */}
            {totalPreviewPages > 1 && (
              <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
                <button
                  onClick={() => setPreviewPage(prev => Math.max(1, prev - 1))}
                  disabled={previewPage === 1}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </button>
                <span className="text-sm text-gray-600">
                  Página {previewPage} de {totalPreviewPages}
                </span>
                <button
                  onClick={() => setPreviewPage(prev => Math.min(totalPreviewPages, prev + 1))}
                  disabled={previewPage >= totalPreviewPages}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  Próximo
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-[#1B1B1D]">Preparar dados para busca</h1>
          <p className="mt-2 text-base text-gray-600">
            Configure a tabela Delta, selecione arquivos e gere chunks para indexação vetorial
          </p>
        </div>

        {/* Step 1: Table Configuration */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
            <Database className="h-5 w-5 text-[#FF3621]" />
            <h2 className="text-lg font-semibold text-[#1B1B1D]">1. Configurar Tabela Delta</h2>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Catálogo
                </label>
                <input
                  type="text"
                  value={tableConfig.catalog}
                  onChange={(e) => {
                    setTableConfig(prev => ({ ...prev, catalog: e.target.value }))
                    setIsConfigSaved(false)
                  }}
                  placeholder="ex: fabio_goncalves"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Schema
                </label>
                <input
                  type="text"
                  value={tableConfig.schema}
                  onChange={(e) => {
                    setTableConfig(prev => ({ ...prev, schema: e.target.value }))
                    setIsConfigSaved(false)
                  }}
                  placeholder="ex: customer_cielo"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nome da Tabela
                </label>
                <input
                  type="text"
                  value={tableConfig.tableName}
                  onChange={(e) => {
                    setTableConfig(prev => ({ ...prev, tableName: e.target.value }))
                    setIsConfigSaved(false)
                  }}
                  placeholder="ex: contracts_chunks"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                />
              </div>
            </div>
            
            <div className="mt-4 flex items-center gap-4">
              <button
                onClick={checkTableExists}
                disabled={processingStatus.status === "checking"}
                className="px-4 py-2 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {processingStatus.status === "checking" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Settings className="h-4 w-4" />
                )}
                Verificar / Salvar
              </button>
              
              {isConfigSaved && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-[#00A972]" />
                  <span className="text-[#00A972]">
                    Configuração salva
                    {tableExists !== null && (
                      tableExists 
                        ? ` • Tabela existe (${existingRecords} registros)`
                        : " • Tabela será criada"
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Step 2: Select Files */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#FF3621]" />
              <h2 className="text-lg font-semibold text-[#1B1B1D]">2. Selecionar Arquivos</h2>
            </div>
            <button
              onClick={loadVolumeFiles}
              disabled={isLoadingFiles}
              className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors flex items-center gap-2"
            >
              {isLoadingFiles ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Atualizar Lista
            </button>
          </div>
          
          <div className="p-4">
            {volumeFiles.length === 0 ? (
              <div className="text-center py-8">
                <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500">Nenhum arquivo carregado</p>
                <button
                  onClick={loadVolumeFiles}
                  className="mt-3 text-sm text-[#FF3621] hover:text-[#FF3621]/80 font-medium"
                >
                  Carregar arquivos do volume
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedFiles.size === volumeFiles.length}
                      onChange={selectAllFiles}
                      className="w-4 h-4 text-[#FF3621] border-gray-300 rounded focus:ring-[#FF3621]"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Selecionar todos ({volumeFiles.length})
                    </span>
                  </label>
                  <span className="text-sm text-gray-500">
                    {selectedFiles.size} arquivo(s) selecionado(s)
                  </span>
                </div>
                
                <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg">
                  {volumeFiles.map((file) => (
                    <label
                      key={file.name}
                      className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 last:border-b-0 cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedFiles.has(file.name) ? "bg-red-50" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(file.name)}
                        onChange={() => toggleFileSelection(file.name)}
                        className="w-4 h-4 text-[#FF3621] border-gray-300 rounded focus:ring-[#FF3621]"
                      />
                      <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {file.name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                          {file.isImported && (
                            <span className="ml-2 text-[#00A972]">• Já importado</span>
                          )}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Step 3: Chunking Strategy */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
            <Layers className="h-5 w-5 text-[#FF3621]" />
            <h2 className="text-lg font-semibold text-[#1B1B1D]">3. Estratégia de Chunking</h2>
          </div>
          
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
                      ? "border-[#FF3621] bg-red-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div className="font-semibold text-[#1B1B1D] mb-1">{strategy.name}</div>
                  <div className="text-xs text-gray-600">{strategy.description}</div>
                </button>
              ))}
            </div>
            
            {/* Chunking Parameters */}
            {selectedStrategy !== "by_page" && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Parâmetros</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Tamanho do Chunk (caracteres)
                    </label>
                    <input
                      type="number"
                      value={chunkingParams.chunkSize}
                      onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkSize: parseInt(e.target.value) || 1000 }))}
                      min={100}
                      max={10000}
                      step={100}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                    />
                  </div>
                  {selectedStrategy !== "semantic" && (
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">
                        Overlap (caracteres)
                      </label>
                      <input
                        type="number"
                        value={chunkingParams.chunkOverlap}
                        onChange={(e) => setChunkingParams(prev => ({ ...prev, chunkOverlap: parseInt(e.target.value) || 0 }))}
                        min={0}
                        max={500}
                        step={50}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Processing Status & Actions */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
            <Play className="h-5 w-5 text-[#FF3621]" />
            <h2 className="text-lg font-semibold text-[#1B1B1D]">4. Processar</h2>
          </div>
          
          <div className="p-4">
            {/* Status Display */}
            {processingStatus.status !== "idle" && (
              <div className={`mb-4 p-4 rounded-lg ${
                processingStatus.status === "completed" ? "bg-green-50 border border-green-200" :
                processingStatus.status === "error" ? "bg-red-50 border border-red-200" :
                "bg-blue-50 border border-blue-200"
              }`}>
                <div className="flex items-center gap-2">
                  {processingStatus.status === "processing" && (
                    <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />
                  )}
                  {processingStatus.status === "completed" && (
                    <CheckCircle2 className="h-5 w-5 text-[#00A972]" />
                  )}
                  {processingStatus.status === "error" && (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <span className={`text-sm font-medium ${
                    processingStatus.status === "completed" ? "text-[#00A972]" :
                    processingStatus.status === "error" ? "text-red-600" :
                    "text-blue-600"
                  }`}>
                    {processingStatus.message}
                  </span>
                </div>
                {processingStatus.status === "processing" && (
                  <div className="mt-2">
                    <div className="w-full bg-blue-200 rounded-full h-2">
                      <div 
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${processingStatus.progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-blue-600 mt-1">
                      {processingStatus.processedFiles} de {processingStatus.totalFiles} arquivos
                    </p>
                  </div>
                )}
              </div>
            )}
            
            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={startProcessing}
                disabled={processingStatus.status === "processing" || selectedFiles.size === 0 || !isConfigSaved}
                className="px-6 py-2.5 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {processingStatus.status === "processing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {processingStatus.status === "processing" ? "Processando..." : "Iniciar Processamento"}
              </button>
              
              {existingRecords > 0 && (
                <button
                  onClick={loadChunkPreviews}
                  disabled={isLoadingPreview}
                  className="px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors flex items-center gap-2"
                >
                  {isLoadingPreview ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  Ver Chunks Existentes
                </button>
              )}
            </div>
            
            {/* Summary */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Resumo</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• <strong>Tabela:</strong> {tableConfig.catalog}.{tableConfig.schema}.{tableConfig.tableName || "(não configurado)"}</li>
                <li>• <strong>Arquivos selecionados:</strong> {selectedFiles.size}</li>
                <li>• <strong>Estratégia:</strong> {CHUNKING_STRATEGIES.find(s => s.id === selectedStrategy)?.name}</li>
                {selectedStrategy !== "by_page" && (
                  <li>• <strong>Parâmetros:</strong> Tamanho {chunkingParams.chunkSize}, Overlap {chunkingParams.chunkOverlap}</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
