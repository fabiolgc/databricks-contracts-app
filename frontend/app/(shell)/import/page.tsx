"use client"

import { useState, useEffect } from "react"
import { Upload, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight, Database, Trash2, FolderOpen, RefreshCw, FileStack, X, Check } from "lucide-react"
import { toast } from "sonner"
import { useTranslation } from "@/lib/i18n"

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
  uploadStartTime?: number
  uploadDuration?: number
  extractStartTime?: number
  extractDuration?: number
  totalDuration?: number
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

declare global {
  interface Window {
    __overwriteResolve?: (decision: "overwrite" | "overwrite_all" | "skip" | "cancel") => void
  }
}

export default function ImportPage() {
  const { t } = useTranslation()
  const [isDragging, setIsDragging] = useState(false)
  const [files, setFiles] = useState<FileWithStatus[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  const [currentConflictFile, setCurrentConflictFile] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  
  const [tableConfig, setTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts"
  })
  const [initialTableConfig, setInitialTableConfig] = useState<TableConfig>({
    catalog: "",
    schema: "",
    tableName: "contracts"
  })
  const [isConfigSaved, setIsConfigSaved] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  
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
  
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null)
  const [elapsedTime, setElapsedTime] = useState<number>(0)
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0)
  const [totalFilesToProcess, setTotalFilesToProcess] = useState<number>(0)

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          const newConfig = {
            catalog: config.catalog || "",
            schema: config.schema || "",
            tableName: "contracts"
          }
          setTableConfig(newConfig)
          setInitialTableConfig(newConfig)
          
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

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null
    
    if (isUploading && processingStartTime) {
      intervalId = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - processingStartTime) / 1000))
        
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

    if (duplicates.length > 0) {
      if (duplicates.length === 1) {
        toast.warning(`${t("import.toast.fileExists")}: ${duplicates[0]}`, {
          duration: 7000,
        })
      } else if (duplicates.length <= 3) {
        toast.warning(
          <div>
            <p className="font-medium mb-1">{t("import.toast.fileExists")}:</p>
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
          `${duplicates.length} ${t("common.files")} ${t("import.toast.fileExists").toLowerCase()}`,
          {
            duration: 7000,
          }
        )
      }
    }

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
        const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
        if (currentPage > totalPages) {
          setCurrentPage(totalPages)
        }
        return newFiles
      })

      toast.success(
        `${filesToAdd.length} ${t("common.files")} ${t("common.success").toLowerCase()}`,
        { duration: 5000 }
      )

      if (filesWithStatus.length > 0) {
        setTimeout(() => {
          filesWithStatus.forEach(file => {
            const element = document.querySelector(`[data-file-id="${file.id}"]`)
            if (element) {
              element.classList.add('animate-pulse', 'bg-[var(--color-success-light)]')
              setTimeout(() => {
                element.classList.remove('animate-pulse', 'bg-[var(--color-success-light)]')
              }, 1500)
            }
          })
        }, 100)
      }
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
    e.target.value = ""
  }

  async function uploadFile(file: FileWithStatus, shouldOverwrite: boolean = false) {
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

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })

      const result = await response.json()

      if (response.status === 409 && result.fileExists) {
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id ? { ...f, status: "pending", progress: 0 } : f
          )
        )
        return "conflict"
      }

      if (response.ok && result.success) {
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id
              ? { ...f, status: "success", progress: 100 }
              : f
          )
        )
        return "success"
      } else {
        throw new Error(result.error || t("import.toast.uploadError"))
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t("import.toast.uploadError")

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

  async function extractTextFromFile(file: FileWithStatus): Promise<boolean> {
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
      const response = await fetch("/api/extract-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableConfig,
          fileName: file.name,
          mode: "replace"
        })
      })

      const result = await response.json()

      if (result.success) {
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
        throw new Error(result.error || t("import.toast.uploadError"))
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("import.toast.uploadError")

      setFiles(prev =>
        prev.map(f => {
          if (f.id === file.id) {
            const finalExtractDuration = f.extractStartTime ? Math.floor((Date.now() - f.extractStartTime) / 1000) : 0
            const totalDuration = (f.uploadDuration || 0) + finalExtractDuration
            return { ...f, status: "error", error: errorMessage, progress: 0, extractDuration: finalExtractDuration, totalDuration }
          }
          return f
        })
      )
      return false
    }
  }

  async function handleImport() {
    if (files.length === 0) return

    if (!isConfigSaved) {
      toast.warning(t("prepare.toast.configFirst"), {
        duration: 5000
      })
      setShowConfig(true)
      return
    }

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

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.status === "success" || file.status === "skipped") continue

      processedIndex++
      setCurrentFileIndex(processedIndex)

      const filePageNumber = Math.floor(i / FILES_PER_PAGE) + 1
      if (filePageNumber !== currentPage) {
        setCurrentPage(filePageNumber)
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      const uploadResult = await uploadFile(file, localOverwriteAll)

      if (uploadResult === "conflict") {
        setCurrentConflictFile(file.name)
        setShowOverwriteDialog(true)

        const decision = await new Promise<"overwrite" | "overwrite_all" | "skip" | "cancel">((resolve) => {
          const checkDecision = setInterval(() => {
            if (!showOverwriteDialog) {
              clearInterval(checkDecision)
            }
          }, 100)

          window.__overwriteResolve = resolve
        })

        setShowOverwriteDialog(false)
        setCurrentConflictFile(null)

        if (decision === "cancel") {
          setIsUploading(false)
          setProcessingStartTime(null)
          
          setFiles(prev =>
            prev.map(f =>
              f.status === "uploading" || f.status === "extracting" 
                ? { ...f, status: "pending", progress: 0 } 
                : f
            )
          )
          
          toast.error(t("common.cancel"), {
            duration: 5000
          })
          return
        }

        if (decision === "overwrite" || decision === "overwrite_all") {
          if (decision === "overwrite_all") {
            localOverwriteAll = true
          }
          const retryResult = await uploadFile(file, true)
          if (retryResult === "success") {
            const extractResult = await extractTextFromFile(file)
            if (extractResult) {
              successCount++
              toast.success(`${file.name}`, {
                description: t("common.success"),
                duration: 3000
              })
            } else {
              errorCount++
            }
          } else if (retryResult === "error") {
            errorCount++
          }
        } else {
          setFiles(prev =>
            prev.map(f =>
              f.id === file.id ? { ...f, status: "skipped" } : f
            )
          )
          skippedCount++
        }
      } else if (uploadResult === "success") {
        const extractResult = await extractTextFromFile(file)
        if (extractResult) {
          successCount++
          toast.success(`${file.name}`, {
            description: t("common.success"),
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

    setFiles(prev => {
      const sorted = [...prev].sort((a, b) => {
        const order = { pending: 0, uploading: 1, extracting: 2, success: 3, error: 4, skipped: 5 }
        return order[a.status] - order[b.status]
      })
      return sorted
    })

    if (errorCount === 0 && skippedCount === 0 && successCount > 0) {
      toast.success(t("import.toast.uploadSuccess", { count: successCount }), {
        description: `${formatElapsedTime(totalTime)}`,
        duration: 6000,
      })
    } else if (successCount > 0) {
      const parts = [`${successCount} ${t("common.success").toLowerCase()}`]
      if (skippedCount > 0) parts.push(`${skippedCount} ${t("import.fileList.skipped").toLowerCase()}`)
      if (errorCount > 0) parts.push(`${errorCount} ${t("common.error").toLowerCase()}`)
      
      toast.warning(parts.join(', '), {
          duration: 8000,
      })
    }
  }

  async function saveTableConfig() {
    if (!tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName) {
      toast.warning(t("import.validation.fillAllFields"))
      return
    }

    setIsConfigSaved(true)
    setShowConfig(false)
    
    toast.success(t("import.toast.configSaved"), {
      description: t("import.toast.configSavedDesc", { table: `${tableConfig.catalog}.${tableConfig.schema}.${tableConfig.tableName}` }),
      duration: 4000
    })
  }

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
      toast.error(t("common.error"))
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
        toast.success(t("prepare.delete.success", { count: result.deletedCount }), { duration: 5000 })
        await loadVolumeFiles(1)
      } else {
        toast.error(t("prepare.delete.error"), {
          description: result.errors?.map((e: { fileName: string }) => e.fileName).join(", "),
          duration: 7000
        })
      }
    } catch (error) {
      console.error("Error deleting files:", error)
      toast.error(t("prepare.delete.error"))
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
            <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">
              {t("import.overwrite.title")}
            </h3>
            <p className="text-base text-gray-600 mb-2">
              {t("import.overwrite.message", { fileName: "" }).split('"{fileName}"')[0]}
            </p>
            <p className="text-sm font-medium text-[var(--color-text)] bg-gray-50 p-3 rounded-lg mb-4 break-words">
              {currentConflictFile}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleOverwriteDecision("overwrite_all")}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors"
              >
                {t("import.overwrite.overwriteAll")}
              </button>
              <button
                onClick={() => handleOverwriteDecision("overwrite")}
                className="w-full px-4 py-2.5 text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] rounded-lg hover:bg-[var(--color-primary-lighter)] transition-colors"
              >
                {t("import.overwrite.overwriteThis")}
              </button>
              <button
                onClick={() => handleOverwriteDecision("skip")}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                {t("import.overwrite.skipThis")}
              </button>
              <div className="mt-4 pt-4 border-t border-gray-200">
                <button
                  onClick={() => handleOverwriteDecision("cancel")}
                  className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {t("common.cancel")}
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
              <div className="p-2 bg-[var(--color-primary-lighter)] rounded-full">
                <Trash2 className="h-6 w-6 text-[var(--color-primary)]" />
              </div>
              <h3 className="text-xl font-bold text-[var(--color-text)]">
                {t("prepare.delete.title")}
              </h3>
            </div>
            
            <div className="bg-[var(--color-warning-light)] border border-[var(--color-warning)] rounded-lg p-3 mb-4">
              <p className="text-sm text-[var(--color-warning)] font-medium">
                ⚠️ {t("common.warning")}
              </p>
            </div>
            
            <p className="text-base text-gray-600 mb-2">
              {t("prepare.delete.message", { count: deleteMode === "all" ? volumeFilesTotal : selectedVolumeFiles.size })}
            </p>
            
            <div className="flex flex-col gap-2">
              <button
                onClick={deleteVolumeFiles}
                disabled={isDeleting}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("common.processing")}
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    {t("common.confirm")}
                  </>
                )}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[var(--color-text)]">{t("import.title")}</h1>
        <p className="mt-2 text-base text-gray-600">
          {t("import.subtitle")}
        </p>
      </div>

      {/* Table Configuration Section */}
      <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
        showConfig ? 'border-[var(--color-primary)]' : 'border-gray-200'
      }`}>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            {isConfigSaved ? (
              <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
            ) : (
              <Database className="h-5 w-5 text-[var(--color-primary)]" />
            )}
            <h2 className="text-lg font-semibold text-[var(--color-text)]">{t("import.whereToSave")}</h2>
          </div>
          <div className="flex items-center gap-2">
            {isConfigSaved && (
              <span className="text-sm text-[var(--color-success)]">
                {t("import.configured")}
              </span>
            )}
            <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${showConfig ? 'rotate-90' : ''}`} />
          </div>
        </button>
        
        {showConfig && (
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-4">
              {t("import.whereToSaveDesc")}
            </p>
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
                  }}
                  placeholder={t("import.placeholder.catalog")}
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
                  }}
                  placeholder={t("import.placeholder.schema")}
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
                  }}
                  placeholder={t("import.placeholder.tableName")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                />
              </div>
            </div>

            {/* Preview das tabelas que serão criadas */}
            {tableConfig.tableName && (
              <div className="mt-3 p-3 bg-[var(--color-accent-light)] border border-[var(--color-accent-lighter)] rounded-lg">
                <p className="text-xs font-medium text-[var(--color-accent)] mb-2">{t("import.tableToCreate")}</p>
                <div className="flex flex-wrap gap-2">
                  <code className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-2 py-1 rounded text-xs font-mono">
                    {tableConfig.catalog || "catalog"}.{tableConfig.schema || "schema"}.{tableConfig.tableName}_raw
                  </code>
                </div>
              </div>
            )}
            
            <div className="mt-4 flex items-center justify-end gap-3">
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
                    onClick={saveTableConfig}
                    disabled={!tableConfig.catalog || !tableConfig.schema || !tableConfig.tableName}
                    className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    <Check className="h-4 w-4" />
                    {t("common.verifySave")}
                  </button>
                </>
              ) : (
                <span className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("import.configSaved")}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Volume Management Section */}
      <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
        showVolumeManager ? 'border-[var(--color-primary)]' : 'border-gray-200'
      }`}>
        <button
          onClick={() => setShowVolumeManager(!showVolumeManager)}
          className="w-full px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-[var(--color-primary)]" />
            <h2 className="text-lg font-semibold text-[var(--color-text)]">{t("import.manageDatabricksFolder")}</h2>
          </div>
          <div className="flex items-center gap-2">
            {volumeFilesTotal > 0 && (
              <span className="text-sm text-gray-500">
                {volumeFilesTotal} {t("common.files")}
              </span>
            )}
            <ChevronRight className={`h-5 w-5 text-gray-400 transition-transform ${showVolumeManager ? 'rotate-90' : ''}`} />
          </div>
        </button>
        
        {showVolumeManager && (
          <div className="p-4">
            <p className="text-sm text-gray-600 mb-4">
              {t("import.manageDatabricksFolderDesc")}
            </p>
            
            {/* Load Files Button */}
            {volumeFiles.length === 0 && !volumeFilesLoading && (
              <button
                onClick={() => loadVolumeFiles(1)}
                className="px-4 py-2 text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] border border-[var(--color-primary)]/30 rounded-lg hover:bg-[var(--color-primary-lighter)] transition-colors flex items-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                {t("import.loadExistingFiles")}
              </button>
            )}
            
            {/* Loading State */}
            {volumeFilesLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 text-[var(--color-primary)] animate-spin" />
                <span className="ml-2 text-sm text-gray-600">{t("common.loading")}</span>
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
                      title="Reload"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <span className="text-sm text-gray-500">
                      {selectedVolumeFiles.size > 0 && `${selectedVolumeFiles.size} ${t("common.selected")}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setDeleteMode("selected")
                        setShowDeleteConfirm(true)
                      }}
                      disabled={selectedVolumeFiles.size === 0}
                      className="px-3 py-1.5 text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] border border-[var(--color-primary-lighter)] rounded-lg hover:bg-[var(--color-primary-lighter)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("prepare.step2.removeSelected")}
                    </button>
                    <button
                      onClick={() => {
                        setDeleteMode("all")
                        setShowDeleteConfirm(true)
                      }}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:opacity-90 transition-colors flex items-center gap-1"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("prepare.step2.removeAll")}
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
                            className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                          />
                        </th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">{t("common.files")}</th>
                        <th className="px-4 py-2 text-right text-sm font-medium text-gray-700">Size</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {volumeFiles.map((file) => (
                        <tr 
                          key={file.name} 
                          className={`hover:bg-gray-50 transition-colors ${selectedVolumeFiles.has(file.name) ? 'bg-[var(--color-primary-light)]' : ''}`}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedVolumeFiles.has(file.name)}
                              onChange={() => toggleVolumeFileSelection(file.name)}
                              className="rounded border-gray-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <svg className="h-4 w-4 text-[var(--color-primary)]" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                              </svg>
                              <span className="text-sm text-[var(--color-text)] truncate max-w-md" title={file.name}>
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
                      {((volumeFilesPage - 1) * VOLUME_FILES_PER_PAGE) + 1} - {Math.min(volumeFilesPage * VOLUME_FILES_PER_PAGE, volumeFilesTotal)} {t("common.of")} {volumeFilesTotal}
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
                        {t("common.page")} {volumeFilesPage} {t("common.of")} {Math.ceil(volumeFilesTotal / VOLUME_FILES_PER_PAGE)}
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
                <p className="text-sm">{t("import.noFilesInVolume")}</p>
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
              ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] shadow-sm" 
              : "border-gray-300 hover:border-[var(--color-primary)]/50 hover:bg-gray-50"
            }
          `}
        >
          <Upload className="mx-auto h-12 w-12 text-gray-400" />
          <div className="mt-4">
            <span className="text-base text-[var(--color-primary)] hover:text-[var(--color-primary)]/80 font-medium">
              {t("import.uploadArea.subtitle")}
            </span>
            <span className="text-base text-gray-600"> {t("import.uploadArea.title").toLowerCase()}</span>
          </div>
          <p className="mt-2 text-sm text-gray-500">
            {t("import.uploadArea.allowedTypes")}
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
                  <div className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] border border-[var(--color-primary)]/30 rounded-lg hover:bg-[var(--color-primary-lighter)] transition-colors">
                    <Upload className="h-4 w-4" />
                    {t("import.uploadArea.subtitle")}
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
                <FileStack className="h-5 w-5 text-[var(--color-primary)]" />
                <h3 className="text-lg font-semibold text-[var(--color-text)]">
                  {t("import.fileList.title")} ({files.length})
                </h3>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label={t("common.previous")}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-gray-600 font-medium min-w-[80px] text-center">
                    {t("common.page")} {currentPage} {t("common.of")} {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label={t("common.next")}
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
                        <svg className="h-5 w-5 text-[var(--color-primary)]" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                      )}
                      {file.status === "uploading" && (
                        <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin" />
                      )}
                      {file.status === "extracting" && (
                        <Loader2 className="h-5 w-5 text-[var(--color-accent)] animate-spin" />
                      )}
                      {file.status === "success" && (
                        <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
                      )}
                      {file.status === "error" && (
                        <XCircle className="h-5 w-5 text-[var(--color-primary)]" />
                      )}
                      {file.status === "skipped" && (
                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                      )}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text)] truncate">
                        {file.name}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm text-gray-500">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                        {file.status === "uploading" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[var(--color-primary)]">{t("import.fileList.importing")}...</span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-[var(--color-primary-lighter)] text-[var(--color-primary)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "extracting" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[var(--color-accent)]">{t("common.processing")}...</span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-[var(--color-primary-lighter)] text-[var(--color-primary)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.extractDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "success" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[var(--color-success)]">
                              ✓ {file.textLength?.toLocaleString() || 0} chars • {file.pageCount || 0} pgs
                            </span>
                            <span className="font-mono text-[10px] flex items-center gap-0.5">
                              <span className="bg-[var(--color-primary-lighter)] text-[var(--color-primary)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.uploadDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.extractDuration || 0)}
                              </span>
                              <span className="text-gray-400">|</span>
                              <span className="bg-[var(--color-success-lighter)] text-[var(--color-success)] px-1 py-0.5 rounded">
                                {formatElapsedTime(file.totalDuration || 0)}
                              </span>
                            </span>
                          </span>
                        )}
                        {file.status === "error" && (
                          <span className="text-xs flex items-center gap-1.5">
                            <span className="text-[var(--color-primary)]">✕ {file.error || t("common.error")}</span>
                            {(file.uploadDuration || file.extractDuration) && (
                              <span className="font-mono text-[10px] flex items-center gap-0.5">
                                {file.uploadDuration !== undefined && (
                                  <span className="bg-[var(--color-primary-lighter)] text-[var(--color-primary)] px-1 py-0.5 rounded">
                                    {formatElapsedTime(file.uploadDuration)}
                                  </span>
                                )}
                                {file.extractDuration !== undefined && (
                                  <>
                                    <span className="text-gray-400">|</span>
                                    <span className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-1 py-0.5 rounded">
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
                            {t("import.fileList.skipped")}
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
                          const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
                          if (currentPage > totalPages && totalPages > 0) {
                            setCurrentPage(totalPages)
                          }
                          return newFiles
                        })
                      }}
                      className="text-[var(--color-primary)] hover:text-[var(--color-primary)]/80 text-sm font-medium transition-colors ml-4"
                    >
                      {t("common.remove")}
                    </button>
                  )}
                </div>
              </li>
              ))}
            </ul>
            {/* Total timing summary */}
            {files.some(f => f.status === "success" || f.status === "extracting" || f.status === "uploading") && (() => {
              const totalUpload = files.reduce((sum, f) => sum + (f.uploadDuration || 0), 0)
              const totalExtract = files.reduce((sum, f) => sum + (f.extractDuration || 0), 0)
              const totalTime = files.reduce((sum, f) => sum + (f.totalDuration || 0), 0)
              
              return (
                <div className="px-4 py-2 bg-gray-100 border-t border-gray-200 flex items-center justify-end gap-4 text-[10px] font-mono">
                  <span className="text-gray-500 text-xs">Total:</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-[var(--color-primary-lighter)] text-[var(--color-primary)] px-1.5 py-0.5 rounded font-semibold">
                      {formatElapsedTime(totalUpload)}
                    </span>
                    <span className="text-gray-500">Upload</span>
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-[var(--color-accent-lighter)] text-[var(--color-accent)] px-1.5 py-0.5 rounded font-semibold">
                      {formatElapsedTime(totalExtract)}
                    </span>
                    <span className="text-gray-500">Extract</span>
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-[var(--color-success-lighter)] text-[var(--color-success)] px-1.5 py-0.5 rounded font-semibold">
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
                  className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-success)] rounded-lg hover:bg-[var(--color-success)]/90 transition-colors shadow-sm flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("import.fileList.completed")}
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
                    {t("common.cancel")}
                  </button>
                  {(() => {
                    const pendingCount = files.filter(f => f.status === "pending" || f.status === "error").length
                    const hasNoPending = pendingCount === 0
                    
                    return (
                      <button
                        onClick={handleImport}
                        disabled={isUploading || hasNoPending}
                        className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
                        {isUploading
                          ? `${t("import.fileList.importing")} ${currentFileIndex}/${totalFilesToProcess} ${formatElapsedTime(elapsedTime)}`
                          : pendingCount === files.length
                            ? `${t("import.fileList.import")} ${files.length} ${t("common.files")}`
                            : `${t("import.fileList.import")} ${pendingCount} ${t("common.of")} ${files.length}`
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
