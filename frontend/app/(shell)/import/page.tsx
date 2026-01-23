"use client"

import { useState, useEffect } from "react"
import { Upload, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight, Database, Settings, Trash2, FolderOpen, RefreshCw, FileStack } from "lucide-react"
import { toast } from "sonner"

type FileStatus = "pending" | "uploading" | "extracting" | "success" | "error" | "skipped"

interface FileWithStatus {
  id: string
  file: File
  name: string
  size: number
  status: FileStatus
  progress: number
  error?: string
  textLength?: number
  pageCount?: number
  // Timing for each phase
  uploadStartTime?: number
  uploadDuration?: number      // Time spent uploading (red)
  extractStartTime?: number
  extractDuration?: number     // Time spent extracting (blue)
  totalDuration?: number       // Total time (green)
}

interface TableConfig {
  catalog: string
  schema: string
  tableName: string
}

interface VolumeFile {
  name: string
  path: string
  size: number
  lastModified: string
}

const FILES_PER_PAGE = 5

// Extend Window interface for overwrite decision callback
declare global {
  interface Window {
    __overwriteResolve?: (decision: "overwrite" | "overwrite_all" | "skip" | "cancel") => void
  }
}

export default function ImportPage() {
  const [isDragging, setIsDragging] = useState(false)
  const [files, setFiles] = useState<FileWithStatus[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  const [currentConflictFile, setCurrentConflictFile] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  
  // Table configuration for documents
  const [tableConfig, setTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts"  // Base name only - backend adds _raw suffix
  })
  const [isConfigSaved, setIsConfigSaved] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  
  // Volume management state
  const [showVolumeManager, setShowVolumeManager] = useState(false)
  const [volumeFiles, setVolumeFiles] = useState<VolumeFile[]>([])
  const [volumeFilesTotal, setVolumeFilesTotal] = useState(0)
  const [volumeFilesPage, setVolumeFilesPage] = useState(1)
  const [volumeFilesLoading, setVolumeFilesLoading] = useState(false)
  const [selectedVolumeFiles, setSelectedVolumeFiles] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteMode, setDeleteMode] = useState<"all" | "selected">("selected")
  const [isDeleting, setIsDeleting] = useState(false)
  const VOLUME_FILES_PER_PAGE = 5
  
  // Timer for processing
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null)
  const [elapsedTime, setElapsedTime] = useState<number>(0)
  
  // Track current file being processed
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0)
  const [totalFilesToProcess, setTotalFilesToProcess] = useState<number>(0)

  // Load environment config on mount and auto-save if all fields are present
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          const newConfig = {
            catalog: config.catalog || "",
            schema: config.schema || "",
            tableName: "contracts"  // Base name only - backend adds _raw suffix
          }
          setTableConfig(newConfig)
          
          // Auto-save if all fields are filled from environment
          if (newConfig.catalog && newConfig.schema && newConfig.tableName) {
            setIsConfigSaved(true)
          }
        }
      } catch (error) {
        console.error("Error loading config:", error)
      }
    }
    loadConfig()
  }, [])

  // Timer effect for processing (global and per-file)
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null
    
    if (isUploading && processingStartTime) {
      intervalId = setInterval(() => {
        // Update global elapsed time
        setElapsedTime(Math.floor((Date.now() - processingStartTime) / 1000))
        
        // Update per-file elapsed time for files being processed
        setFiles(prev => prev.map(f => {
          if (f.status === "uploading" && f.uploadStartTime) {
            return { ...f, uploadDuration: Math.floor((Date.now() - f.uploadStartTime) / 1000) }
          }
          if (f.status === "extracting" && f.extractStartTime) {
            return { ...f, extractDuration: Math.floor((Date.now() - f.extractStartTime) / 1000) }
          }
          return f
        }))
      }, 1000)
    } else if (!isUploading) {
      setElapsedTime(0)
    }
    
    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [isUploading, processingStartTime])

  // Format elapsed time as mm:ss
  function formatElapsedTime(seconds: number): string {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      file => file.type === "application/pdf"
    )
    
    if (droppedFiles.length > 0) {
      addFilesToList(droppedFiles)
    }
  }

  function addFilesToList(newFiles: File[]) {
    const existingFileNames = new Set(files.map(f => f.name))
    const duplicates: string[] = []
    const filesToAdd: File[] = []

    newFiles.forEach(file => {
      if (existingFileNames.has(file.name)) {
        duplicates.push(file.name)
      } else {
        filesToAdd.push(file)
      }
    })

    // Show notification for duplicates
    if (duplicates.length > 0) {
      if (duplicates.length === 1) {
        toast.warning(`Arquivo já está na lista: ${duplicates[0]}`, {
          duration: 7000,
        })
      } else if (duplicates.length <= 3) {
        toast.warning(
          <div>
            <p className="font-medium mb-1">Arquivos já estão na lista:</p>
            <ul className="text-sm space-y-0.5">
              {duplicates.map((name, i) => (
                <li key={i}>• {name}</li>
              ))}
            </ul>
          </div>,
          { duration: 8000 }
        )
      } else {
        toast.warning(
          `${duplicates.length} arquivos duplicados não foram adicionados`,
          {
            description: `Arquivos já existentes: ${duplicates.slice(0, 2).join(", ")}...`,
            duration: 7000,
          }
        )
      }
    }

    // Add only non-duplicate files
    if (filesToAdd.length > 0) {
      const filesWithStatus: FileWithStatus[] = filesToAdd.map(file => ({
        id: crypto.randomUUID(),
        file: file,
        name: file.name,
        size: file.size,
        status: "pending" as FileStatus,
        progress: 0,
      }))

      setFiles(prev => {
        const newFiles = [...prev, ...filesWithStatus]
        // Reset to page 1 if adding files would make current page empty
        const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
        if (currentPage > totalPages) {
          setCurrentPage(totalPages)
        }
        return newFiles
      })

      // Show success message
      if (filesToAdd.length === 1) {
        toast.success(`1 arquivo adicionado à lista`, {
          duration: 5000,
        })
      } else {
        toast.success(`${filesToAdd.length} arquivos adicionados à lista`, {
          duration: 5000,
        })
      }

      // Highlight newly added files temporarily
      if (filesWithStatus.length > 0) {
        setTimeout(() => {
          filesWithStatus.forEach(file => {
            const element = document.querySelector(`[data-file-id="${file.id}"]`)
            if (element) {
              element.classList.add('animate-pulse', 'bg-green-50')
              setTimeout(() => {
                element.classList.remove('animate-pulse', 'bg-green-50')
              }, 1500)
            }
          })
        }, 100)
      }
    } else if (duplicates.length > 0) {
      // All files were duplicates
      console.log(`⚠️ All ${duplicates.length} file(s) were duplicates`)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files
    if (selectedFiles) {
      const pdfFiles = Array.from(selectedFiles).filter(
        file => file.type === "application/pdf"
      )
      if (pdfFiles.length > 0) {
        addFilesToList(pdfFiles)
      }
    }
    // Reset input to allow selecting the same files again
    e.target.value = ""
  }

  async function uploadFile(file: FileWithStatus, shouldOverwrite: boolean = false) {
    // Update status to uploading with start time
    const uploadStartTime = Date.now()
    setFiles(prev =>
      prev.map(f =>
        f.id === file.id ? { ...f, status: "uploading", progress: 0, uploadStartTime, uploadDuration: 0 } : f
      )
    )

    try {
      const formData = new FormData()
      formData.append("file", file.file)
      formData.append("overwrite", shouldOverwrite.toString())

      console.log(`📤 Uploading: ${file.name}${shouldOverwrite ? " [OVERWRITE]" : ""}`)

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })

      const result = await response.json()

      // File exists - need confirmation
      if (response.status === 409 && result.fileExists) {
        console.log(`⚠️ File exists: ${file.name}`)
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id ? { ...f, status: "pending", progress: 0 } : f
          )
        )
        return "conflict"
      }

      if (response.ok && result.success) {
        console.log(`✅ Upload successful: ${file.name}`)
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id
              ? { ...f, status: "success", progress: 100 }
              : f
          )
        )
        return "success"
      } else {
        throw new Error(result.error || "Upload failed")
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Upload failed"
      console.error(`❌ Error uploading ${file.name}:`, errorMessage)

      setFiles(prev =>
        prev.map(f =>
          f.id === file.id
            ? { ...f, status: "error", error: errorMessage, progress: 0 }
            : f
        )
      )
      return "error"
    }
  }

  // Extract text from a single file after upload
  async function extractTextFromFile(file: FileWithStatus): Promise<boolean> {
    // Update status to extracting, record upload final time and start extract timer
    const extractStartTime = Date.now()
    setFiles(prev =>
      prev.map(f => {
        if (f.id === file.id) {
          const finalUploadDuration = f.uploadStartTime ? Math.floor((Date.now() - f.uploadStartTime) / 1000) : 0
          return { ...f, status: "extracting", uploadDuration: finalUploadDuration, extractStartTime, extractDuration: 0 }
        }
        return f
      })
    )

    try {
      console.log(`📝 Extracting text from: ${file.name}`)
      
      const response = await fetch("/api/extract-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          fileName: file.name,
          mode: "replace"  // Always replace if exists
        })
      })

      const result = await response.json()

      if (result.success) {
        console.log(`✅ Text extracted: ${file.name} (${result.textLength} chars, ${result.pageCount} pages)`)
        setFiles(prev =>
          prev.map(f => {
            if (f.id === file.id) {
              const finalExtractDuration = f.extractStartTime ? Math.floor((Date.now() - f.extractStartTime) / 1000) : 0
              const totalDuration = (f.uploadDuration || 0) + finalExtractDuration
              return { 
                ...f, 
                status: "success", 
                progress: 100,
                textLength: result.textLength,
                pageCount: result.pageCount,
                extractDuration: finalExtractDuration,
                totalDuration
              }
            }
            return f
          })
        )
        return true
      } else {
        throw new Error(result.error || "Text extraction failed")
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Text extraction failed"
      console.error(`❌ Error extracting text from ${file.name}:`, errorMessage)

      setFiles(prev =>
        prev.map(f => {
          if (f.id === file.id) {
            const finalExtractDuration = f.extractStartTime ? Math.floor((Date.now() - f.extractStartTime) / 1000) : 0
            const totalDuration = (f.uploadDuration || 0) + finalExtractDuration
            return { ...f, status: "error", error: `Extração: ${errorMessage}`, progress: 0, extractDuration: finalExtractDuration, totalDuration }
          }
          return f
        })
      )
      return false
    }
  }

  async function handleImport() {
    if (files.length === 0) return

    // Check if table is configured
    if (!isConfigSaved) {
      toast.warning("Configure a tabela de documentos primeiro", {
        description: "Clique em 'Verificar / Salvar' na seção de configuração",
        duration: 5000
      })
      setShowConfig(true)
      return
    }

    // Calculate files to process (pending, error - not success or skipped)
    const filesToProcess = files.filter(f => f.status === "pending" || f.status === "error")
    if (filesToProcess.length === 0) return
    
    setIsUploading(true)
    setProcessingStartTime(Date.now())
    setElapsedTime(0)
    setCurrentFileIndex(0)
    setTotalFilesToProcess(filesToProcess.length)
    
    let localOverwriteAll = false
    let successCount = 0
    let errorCount = 0
    let skippedCount = 0
    let processedIndex = 0

    console.log(`🚀 Starting upload of ${filesToProcess.length} file(s) (${files.length} total)`)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.status === "success" || file.status === "skipped") continue

      // Update current file index for UI
      processedIndex++
      setCurrentFileIndex(processedIndex)

      // Navigate to the page where this file is located
      const filePageNumber = Math.floor(i / FILES_PER_PAGE) + 1
      if (filePageNumber !== currentPage) {
        setCurrentPage(filePageNumber)
        // Small delay to allow page transition
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      // Step 1: Upload to volume
      const uploadResult = await uploadFile(file, localOverwriteAll)

      if (uploadResult === "conflict") {
        // Show dialog and wait for user decision
        setCurrentConflictFile(file.name)
        setShowOverwriteDialog(true)

        // Wait for user decision
        const decision = await new Promise<"overwrite" | "overwrite_all" | "skip" | "cancel">((resolve) => {
          const checkDecision = setInterval(() => {
            if (!showOverwriteDialog) {
              clearInterval(checkDecision)
            }
          }, 100)

          // Store resolve function for dialog handlers
          window.__overwriteResolve = resolve
        })

        setShowOverwriteDialog(false)
        setCurrentConflictFile(null)

        if (decision === "cancel") {
          // Cancel entire import process
          console.log("🚫 Import cancelled by user")
          setIsUploading(false)
          setProcessingStartTime(null)
          
          // Reset all pending files to their original state
          setFiles(prev =>
            prev.map(f =>
              f.status === "uploading" || f.status === "extracting" 
                ? { ...f, status: "pending", progress: 0 } 
                : f
            )
          )
          
          toast.error("Importação cancelada", {
            description: "Nenhum arquivo foi importado",
            duration: 5000
          })
          return // Exit the function early
        }

        if (decision === "overwrite" || decision === "overwrite_all") {
          if (decision === "overwrite_all") {
            localOverwriteAll = true
            console.log("🔄 Overwrite ALL enabled - will not ask again")
          }
          // Retry upload with overwrite
          const retryResult = await uploadFile(file, true)
          if (retryResult === "success") {
            // Step 2: Extract text after successful upload
            const extractResult = await extractTextFromFile(file)
            if (extractResult) {
              successCount++
              toast.success(`${file.name}`, {
                description: "Upload e extração de texto concluídos",
                duration: 3000
              })
            } else {
              errorCount++
            }
          } else if (retryResult === "error") {
            errorCount++
          }
        } else {
          // Skip this file
          console.log(`⏭️ Skipping file: ${file.name}`)
          setFiles(prev =>
            prev.map(f =>
              f.id === file.id ? { ...f, status: "skipped" } : f
            )
          )
          skippedCount++
        }
      } else if (uploadResult === "success") {
        // Step 2: Extract text after successful upload
        const extractResult = await extractTextFromFile(file)
        if (extractResult) {
        successCount++
          toast.success(`${file.name}`, {
            description: "Upload e extração de texto concluídos",
            duration: 3000
          })
        } else {
          errorCount++
        }
      } else if (uploadResult === "error") {
        errorCount++
      }
    }

    const totalTime = processingStartTime ? Math.floor((Date.now() - processingStartTime) / 1000) : 0
    setIsUploading(false)
    setProcessingStartTime(null)
    setCurrentFileIndex(0)
    setTotalFilesToProcess(0)

    // Sort files: success/error/skipped at end, pending at start
    setFiles(prev => {
      const sorted = [...prev].sort((a, b) => {
        const order = { pending: 0, uploading: 1, extracting: 2, success: 3, error: 4, skipped: 5 }
        return order[a.status] - order[b.status]
      })
      return sorted
    })

    // Show summary toast
    if (errorCount === 0 && skippedCount === 0 && successCount > 0) {
      toast.success(`${successCount} arquivo(s) importado(s) com sucesso!`, {
        description: `Textos extraídos em ${formatElapsedTime(totalTime)}`,
        duration: 6000,
      })
    } else if (successCount > 0) {
      const parts = [`${successCount} importado(s)`]
      if (skippedCount > 0) parts.push(`${skippedCount} ignorado(s)`)
      if (errorCount > 0) parts.push(`${errorCount} com erro`)
      
      toast.warning(parts.join(', '), {
          duration: 8000,
      })
    } else if (errorCount > 0 || skippedCount > 0) {
      const parts = []
      if (errorCount > 0) parts.push(`${errorCount} com erro`)
      if (skippedCount > 0) parts.push(`${skippedCount} ignorado(s)`)
      
      toast.warning(parts.join(', '), {
        duration: 7000,
      })
    }

    console.log(`📊 Import complete: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped`)
  }

  // Save table configuration
  async function saveTableConfig() {
    if (!tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName) {
      toast.warning("Preencha todos os campos de configuração")
      return
    }

    setIsConfigSaved(true)
    setShowConfig(false)
    
    toast.success("Configuração salva!", {
      description: `Tabela: ${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}`,
      duration: 4000
    })
  }

  // Volume management functions
  async function loadVolumeFiles(page: number = 1) {
    setVolumeFilesLoading(true)
    try {
      const offset = (page - 1) * VOLUME_FILES_PER_PAGE
      const response = await fetch(`/api/volume/files?offset=${offset}&limit=${VOLUME_FILES_PER_PAGE}`)
      
      if (!response.ok) {
        throw new Error("Failed to load files")
      }
      
      const data = await response.json()
      setVolumeFiles(data.files || [])
      setVolumeFilesTotal(data.total || 0)
      setVolumeFilesPage(page)
      setSelectedVolumeFiles(new Set())
    } catch (error) {
      console.error("Error loading volume files:", error)
      toast.error("Erro ao carregar arquivos do volume")
    } finally {
      setVolumeFilesLoading(false)
    }
  }

  function toggleVolumeFileSelection(fileName: string) {
    setSelectedVolumeFiles(prev => {
      const newSet = new Set(prev)
      if (newSet.has(fileName)) {
        newSet.delete(fileName)
      } else {
        newSet.add(fileName)
      }
      return newSet
    })
  }

  function toggleAllVolumeFiles() {
    if (selectedVolumeFiles.size === volumeFiles.length) {
      setSelectedVolumeFiles(new Set())
    } else {
      setSelectedVolumeFiles(new Set(volumeFiles.map(f => f.name)))
    }
  }

  async function deleteVolumeFiles() {
    setIsDeleting(true)
    try {
      const filesToDelete = deleteMode === "all" ? [] : Array.from(selectedVolumeFiles)
      
      const response = await fetch("/api/volume/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileNames: filesToDelete })
      })
      
      const result = await response.json()
      
      if (result.success) {
        toast.success(`${result.deletedCount} arquivo(s) removido(s)`, { duration: 5000 })
        await loadVolumeFiles(1)
      } else {
        toast.error("Erro ao remover alguns arquivos", {
          description: result.errors?.map((e: { fileName: string }) => e.fileName).join(", "),
          duration: 7000
        })
      }
    } catch (error) {
      console.error("Error deleting files:", error)
      toast.error("Erro ao remover arquivos")
    } finally {
      setIsDeleting(false)
      setShowDeleteConfirm(false)
      setDeleteMode("selected")
    }
  }

  function handleOverwriteDecision(decision: "overwrite" | "overwrite_all" | "skip" | "cancel") {
    if (window.__overwriteResolve) {
      window.__overwriteResolve(decision)
      delete window.__overwriteResolve
    }
    setShowOverwriteDialog(false)
  }

  return (
    <>
      {/* Overwrite Confirmation Dialog */}
      {showOverwriteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold text-[#1B1B1D] mb-2">
              Arquivo já existe
            </h3>
            <p className="text-base text-gray-600 mb-2">
              O arquivo
            </p>
            <p className="text-sm font-medium text-[#1B1B1D] bg-gray-50 p-3 rounded-lg mb-4 break-words">
              {currentConflictFile}
            </p>
            <p className="text-base text-gray-600 mb-6">
              já existe no volume. Deseja sobrescrevê-lo?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleOverwriteDecision("overwrite_all")}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors"
              >
                Sobrescrever todos
              </button>
              <button
                onClick={() => handleOverwriteDecision("overwrite")}
                className="w-full px-4 py-2.5 text-sm font-medium text-[#FF3621] bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
              >
                Sobrescrever este arquivo
              </button>
              <button
                onClick={() => handleOverwriteDecision("skip")}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Pular este arquivo
              </button>
              <div className="mt-4 pt-4 border-t border-gray-200">
                <button
                  onClick={() => handleOverwriteDecision("cancel")}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancelar importação
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-100 rounded-full">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-xl font-bold text-[#1B1B1D]">
                Confirmar Remoção
              </h3>
            </div>
            
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-amber-800 font-medium">
                ⚠️ Atenção: Esta ação não pode ser desfeita!
              </p>
              <p className="text-sm text-amber-700 mt-1">
                Os arquivos serão removidos permanentemente do volume. Não existe backup.
              </p>
            </div>
            
            <p className="text-base text-gray-600 mb-2">
              {deleteMode === "all" 
                ? `Você está prestes a remover TODOS os ${volumeFilesTotal} arquivo(s) do volume.`
                : `Você está prestes a remover ${selectedVolumeFiles.size} arquivo(s) selecionado(s).`
              }
            </p>
            
            <p className="text-sm text-gray-500 mb-6">
              Os dados extraídos ainda existirão nas tabelas Delta.
            </p>
            
            <div className="flex flex-col gap-2">
              <button
                onClick={deleteVolumeFiles}
                disabled={isDeleting}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Removendo...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    Confirmar Remoção
                  </>
                )}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#1B1B1D]">Importar Documentos</h1>
        <p className="mt-2 text-base text-gray-600">
          Faça upload dos seus contratos em PDF e extraia o texto automaticamente
        </p>
      </div>

      {/* Table Configuration Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-[#FF3621]" />
            <h2 className="text-lg font-semibold text-[#1B1B1D]">Configurar Tabela de Documentos</h2>
          </div>
          <div className="flex items-center gap-2">
            {isConfigSaved && (
              <span className="flex items-center gap-1 text-sm text-[#00A972]">
                <CheckCircle2 className="h-4 w-4" />
                Configurado
              </span>
            )}
            <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${showConfig ? 'rotate-90' : ''}`} />
          </div>
        </button>
        
        {showConfig && (
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-4">
              Configure onde os documentos extraídos serão salvos. O texto será extraído automaticamente após o upload.
            </p>
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
                  placeholder="ex: contracts_documents"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/20 focus:border-[#FF3621]"
                />
              </div>
            </div>
            
            <div className="mt-4 flex items-center gap-3">
              {!isConfigSaved ? (
                <button
                  onClick={saveTableConfig}
                  disabled={!tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName}
                  className="px-4 py-2 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Settings className="h-4 w-4" />
                  Verificar / Salvar
                </button>
              ) : (
                <span className="flex items-center gap-2 text-sm text-[#00A972]">
                  <CheckCircle2 className="h-4 w-4" />
                  Configuração salva
                </span>
              )}
              <span className="text-sm text-gray-600">
                Tabela: <code className="bg-gray-100 px-2 py-0.5 rounded text-xs">
                  {tableConfig.catalog}.{tableConfig.schema}.{tableConfig.tableName}
                </code>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Volume Management Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowVolumeManager(!showVolumeManager)}
          className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-[#FF3621]" />
            <h2 className="text-lg font-semibold text-[#1B1B1D]">Gerenciar Pasta do Databricks</h2>
          </div>
          <div className="flex items-center gap-2">
            {volumeFilesTotal > 0 && (
              <span className="text-sm text-gray-500">
                {volumeFilesTotal} arquivo(s)
              </span>
            )}
            <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${showVolumeManager ? 'rotate-90' : ''}`} />
          </div>
        </button>
        
        {showVolumeManager && (
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-4">
              Gerencie os arquivos armazenados na pasta do Databricks (Volume) gerenciado pelo Unity Catalog.
            </p>
            
            {/* Load Files Button */}
            {volumeFiles.length === 0 && !volumeFilesLoading && (
              <button
                onClick={() => loadVolumeFiles(1)}
                className="px-4 py-2 text-sm font-medium text-[#FF3621] bg-red-50 border border-[#FF3621]/30 rounded-lg hover:bg-red-100 transition-colors flex items-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Carregar arquivos existentes
              </button>
            )}
            
            {/* Loading State */}
            {volumeFilesLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 text-[#FF3621] animate-spin" />
                <span className="ml-2 text-sm text-gray-600">Carregando arquivos...</span>
              </div>
            )}
            
            {/* Files List */}
            {!volumeFilesLoading && volumeFiles.length > 0 && (
              <div className="space-y-4">
                {/* Action Buttons */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => loadVolumeFiles(volumeFilesPage)}
                      className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                      title="Recarregar"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <span className="text-sm text-gray-500">
                      {selectedVolumeFiles.size > 0 && `${selectedVolumeFiles.size} selecionado(s)`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setDeleteMode("selected")
                        setShowDeleteConfirm(true)
                      }}
                      disabled={selectedVolumeFiles.size === 0}
                      className="px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      <Trash2 className="h-4 w-4" />
                      Remover Selecionados
                    </button>
                    <button
                      onClick={() => {
                        setDeleteMode("all")
                        setShowDeleteConfirm(true)
                      }}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors flex items-center gap-1"
                    >
                      <Trash2 className="h-4 w-4" />
                      Remover Todos
                    </button>
                  </div>
                </div>
                
                {/* Files Table */}
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-2 text-left">
                          <input
                            type="checkbox"
                            checked={selectedVolumeFiles.size === volumeFiles.length && volumeFiles.length > 0}
                            onChange={toggleAllVolumeFiles}
                            className="rounded border-gray-300 text-[#FF3621] focus:ring-[#FF3621]"
                          />
                        </th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Nome do Arquivo</th>
                        <th className="px-4 py-2 text-right text-sm font-medium text-gray-700">Tamanho</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {volumeFiles.map((file) => (
                        <tr 
                          key={file.name} 
                          className={`hover:bg-gray-50 transition-colors ${selectedVolumeFiles.has(file.name) ? 'bg-red-50' : ''}`}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedVolumeFiles.has(file.name)}
                              onChange={() => toggleVolumeFileSelection(file.name)}
                              className="rounded border-gray-300 text-[#FF3621] focus:ring-[#FF3621]"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <svg className="h-4 w-4 text-[#FF3621]" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                              </svg>
                              <span className="text-sm text-[#1B1B1D] truncate max-w-md" title={file.name}>
                                {file.name}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-gray-500">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                {/* Pagination */}
                {volumeFilesTotal > VOLUME_FILES_PER_PAGE && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-sm text-gray-500">
                      Mostrando {((volumeFilesPage - 1) * VOLUME_FILES_PER_PAGE) + 1} - {Math.min(volumeFilesPage * VOLUME_FILES_PER_PAGE, volumeFilesTotal)} de {volumeFilesTotal}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => loadVolumeFiles(volumeFilesPage - 1)}
                        disabled={volumeFilesPage === 1}
                        className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-sm text-gray-600 font-medium">
                        Página {volumeFilesPage} de {Math.ceil(volumeFilesTotal / VOLUME_FILES_PER_PAGE)}
                      </span>
                      <button
                        onClick={() => loadVolumeFiles(volumeFilesPage + 1)}
                        disabled={volumeFilesPage >= Math.ceil(volumeFilesTotal / VOLUME_FILES_PER_PAGE)}
                        className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* Empty State */}
            {!volumeFilesLoading && volumeFiles.length === 0 && volumeFilesTotal === 0 && volumeFilesPage > 0 && (
              <div className="text-center py-8 text-gray-500">
                <FolderOpen className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                <p className="text-sm">Nenhum arquivo encontrado no volume</p>
              </div>
            )}
          </div>
        )}
      </div>

      {files.length === 0 && (
        <label
          htmlFor="file-upload"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            border-2 border-dashed rounded-xl p-12 text-center
            transition-all duration-200 cursor-pointer block
            ${isDragging 
              ? "border-[#FF3621] bg-red-50 shadow-sm" 
              : "border-gray-300 hover:border-[#FF3621]/50 hover:bg-gray-50"
            }
          `}
        >
          <Upload className="mx-auto h-12 w-12 text-gray-400" />
          <div className="mt-4">
            <span className="text-base text-[#FF3621] hover:text-[#FF3621]/80 font-medium">
              Clique para selecionar
            </span>
            <span className="text-base text-gray-600"> ou arraste os arquivos aqui</span>
          </div>
          <p className="mt-2 text-sm text-gray-500">
            Apenas arquivos PDF (máximo 10MB por arquivo)
          </p>
          <input
            id="file-upload"
            type="file"
            multiple
            accept=".pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
        </label>
      )}

      {files.length > 0 && (() => {
        // Pagination calculations
        const totalPages = Math.ceil(files.length / FILES_PER_PAGE)
        const startIndex = (currentPage - 1) * FILES_PER_PAGE
        const endIndex = startIndex + FILES_PER_PAGE
        const currentFiles = files.slice(startIndex, endIndex)
        
        return (
          <div className="space-y-4">
            {/* Add More Files Button */}
            {!isUploading && (
              <div className="flex justify-center">
                <label htmlFor="file-upload-more" className="cursor-pointer">
                  <div className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#FF3621] bg-red-50 border border-[#FF3621]/30 rounded-lg hover:bg-red-100 transition-colors">
                    <Upload className="h-4 w-4" />
                    Adicionar mais arquivos
                  </div>
                  <input
                    id="file-upload-more"
                    type="file"
                    multiple
                    accept=".pdf"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileStack className="h-5 w-5 text-[#FF3621]" />
                <h3 className="text-lg font-semibold text-[#1B1B1D]">
                  Arquivos Selecionados ({files.length})
                </h3>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-gray-600 font-medium min-w-[80px] text-center">
                    Página {currentPage} de {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Próxima página"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            <ul className="divide-y divide-gray-200 bg-gray-50/50">
              {currentFiles.map((file) => (
              <li 
                key={file.id} 
                data-file-id={file.id}
                className="px-4 py-4 transition-colors duration-300"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {/* Status Icon */}
                    <div className="flex-shrink-0">
                      {file.status === "pending" && (
                        <svg className="h-5 w-5 text-[#FF3621]" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                      )}
                      {file.status === "uploading" && (
                        <Loader2 className="h-5 w-5 text-[#FF3621] animate-spin" />
                      )}
                      {file.status === "extracting" && (
                        <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                      )}
                      {file.status === "success" && (
                        <CheckCircle2 className="h-5 w-5 text-[#00A972]" />
                      )}
                      {file.status === "error" && (
                        <XCircle className="h-5 w-5 text-red-600" />
                      )}
                      {file.status === "skipped" && (
                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                      )}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1B1B1D] truncate">
                        {file.name}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm text-gray-500">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                        {file.status === "uploading" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[#FF3621]">Enviando...</span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-red-100 text-red-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "extracting" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-blue-500">Extraindo texto...</span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-red-100 text-red-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-blue-100 text-blue-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.extractDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "success" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[#00A972]">
                              ✓ {file.textLength?.toLocaleString() || 0} chars • {file.pageCount || 0} pág
                            </span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-red-100 text-red-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-blue-100 text-blue-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.extractDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-green-100 text-green-600 px-1 py-0.5 rounded">
                                {formatElapsedTime(file.totalDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "error" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-red-600">✕ {file.error || "Erro"}</span>
                            {(file.uploadDuration || file.extractDuration) && (
                              <span className="font-mono text-[10px] flex items-center gap-0.5">
                                {file.uploadDuration !== undefined && (
                                  <span className="bg-red-100 text-red-600 px-1 py-0.5 rounded">
                                    {formatElapsedTime(file.uploadDuration)}
                                  </span>
                                )}
                                {file.extractDuration !== undefined && (
                                  <>
                                    <span className="text-gray-400">|</span>
                                    <span className="bg-blue-100 text-blue-600 px-1 py-0.5 rounded">
                                      {formatElapsedTime(file.extractDuration)}
                                    </span>
                                  </>
                                )}
                              </span>
                            )}
                          </span>
                        )}
                        {file.status === "skipped" && (
                          <span className="text-xs text-gray-400">
                            Ignorado
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Button */}
                  {(file.status === "pending" || file.status === "error" || file.status === "skipped") && !isUploading && isConfigSaved && (
                    <button
                      onClick={() => {
                        setFiles(prev => {
                          const newFiles = prev.filter(f => f.id !== file.id)
                          // Adjust page if needed
                          const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
                          if (currentPage > totalPages && totalPages > 0) {
                            setCurrentPage(totalPages)
                          }
                          return newFiles
                        })
                      }}
                      className="text-[#FF3621] hover:text-[#FF3621]/80 text-sm font-medium transition-colors ml-4"
                    >
                      Remover
                    </button>
                  )}
                </div>
              </li>
              ))}
            </ul>
            {/* Total timing summary - shows accumulated times */}
            {files.some(f => f.status === "success" || f.status === "extracting" || f.status === "uploading") && (() => {
              // Calculate total times across all files
              const totalUpload = files.reduce((sum, f) => sum + (f.uploadDuration || 0), 0)
              const totalExtract = files.reduce((sum, f) => sum + (f.extractDuration || 0), 0)
              const totalTime = files.reduce((sum, f) => sum + (f.totalDuration || 0), 0)
              
              return (
                <div className="px-4 py-2 bg-gray-100 border-t border-gray-200 flex items-center justify-end gap-4 text-[10px] font-mono">
                  <span className="text-gray-500 text-xs">Tempo total:</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-semibold">
                      {formatElapsedTime(totalUpload)}
                    </span>
                    <span className="text-gray-500">Upload</span>
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-semibold">
                      {formatElapsedTime(totalExtract)}
                    </span>
                    <span className="text-gray-500">Extração</span>
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-green-100 text-green-600 px-1.5 py-0.5 rounded font-semibold">
                      {formatElapsedTime(totalTime)}
                    </span>
                    <span className="text-gray-500">Total</span>
                  </span>
                </div>
              )
            })()}
            <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
              {files.every(f => f.status === "success" || f.status === "error" || f.status === "skipped") && files.length > 0 ? (
                <button
                  onClick={() => {
                    setFiles([])
                    setCurrentPage(1)
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-[#00A972] rounded-lg hover:bg-[#00A972]/90 transition-colors shadow-sm flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Concluir
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setFiles([])
                      setCurrentPage(1)
                    }}
                    disabled={isUploading}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancelar
                  </button>
                  {(() => {
                    const pendingCount = files.filter(f => f.status === "pending" || f.status === "error").length
                    const hasNoPending = pendingCount === 0
                    
                    return (
                      <button
                        onClick={handleImport}
                        disabled={isUploading || hasNoPending}
                        className="px-4 py-2 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
                        {isUploading
                          ? `Importando ${currentFileIndex}/${totalFilesToProcess} ${formatElapsedTime(elapsedTime)}`
                          : pendingCount === files.length
                            ? `Importar ${files.length} ${files.length === 1 ? "arquivo" : "arquivos"}`
                            : `Importar ${pendingCount} de ${files.length}`
                        }
                      </button>
                    )
                  })()}
                </>
              )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
    </>
  )
}
